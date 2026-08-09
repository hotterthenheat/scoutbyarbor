import {
  createStatementCache,
  hourBucket,
  nowIso,
  toNumber,
  type SqliteDatabase,
} from '../index.js';

/** Pipeline telemetry (§22, §28, §34). */
export interface MetricsRepo {
  record(metric: string, value: number, opts?: MetricOptions): void;
  recordLatency(sample: LatencySample): void;
  latencyStats(sinceIso: string): LatencyStats;
  /** The same window, split by stage. */
  latencyBreakdown(sinceIso: string): LatencyBreakdown;
  /** Per-metric sum, count and mean since `sinceIso`, flattened for reporting. */
  summary(sinceIso: string): Record<string, number>;
}

export interface MetricOptions {
  sourceId?: string;
  category?: string;
  /** Timestamp the sample belongs to; defaults to now. */
  at?: string;
}

export interface LatencySample {
  newsEventId: string;
  sourceId: string;
  sourceToScoutMs: number | null;
  scoutToDiscordMs: number | null;
  totalMs: number | null;
  recordedAt: string;
}

export interface LatencyStats {
  count: number;
  avg: number;
  p95: number;
  p99: number;
}

/**
 * Latency broken out by stage, because "Scout is slow" and "the source is slow"
 * are different problems with different fixes — and a single blended number
 * cannot tell them apart. Each stage is measured independently, so a stage with
 * no samples reports zeroes rather than borrowing another stage's figures.
 */
export interface LatencyBreakdown {
  /** Publication → Scout receiving it. Upstream + relay delay, not Scout's. */
  sourceToScout: LatencyStats;
  /** Scout receiving it → the alert being in Discord. Scout's own cost. */
  scoutToDiscord: LatencyStats;
  /** Publication → Discord. What a reader actually experiences. */
  total: LatencyStats;
}

/**
 * SQLite treats NULLs as distinct in a UNIQUE index, so a nullable dimension
 * would defeat UNIQUE(bucket, metric, source_id, category) and the counter
 * would never aggregate. Absent dimensions are stored as ''.
 */
const NO_DIMENSION = '';

/** Nearest-rank percentile over an ascending array (§22 P95/P99). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

/** Column names are from a fixed literal set below, never from user input. */
type LatencyColumn = 'source_to_scout_ms' | 'scout_to_discord_ms' | 'total_ms';

export function createMetricsRepo(db: SqliteDatabase): MetricsRepo {
  const stmts = createStatementCache(db);

  /**
   * Percentiles are computed in JS: the sample set is one retention window
   * wide, and SQLite has no native percentile function. NULLs are excluded
   * rather than counted as zero, so a stage that was never measured reads as
   * "no samples" instead of "instant".
   */
  function statsForColumn(sinceIso: string, column: LatencyColumn): LatencyStats {
    const rows = stmts
      .get<Record<string, number>>(
        `SELECT ${column} AS value FROM latency_samples
          WHERE recorded_at >= ? AND ${column} IS NOT NULL
          ORDER BY ${column} ASC`,
      )
      .all(sinceIso);

    const values = rows.map((r) => toNumber(r.value));
    if (values.length === 0) return { count: 0, avg: 0, p95: 0, p99: 0 };

    const sum = values.reduce((acc, v) => acc + v, 0);
    return {
      count: values.length,
      avg: sum / values.length,
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
    };
  }

  return {
    record(metric: string, value: number, opts: MetricOptions = {}): void {
      const at = opts.at ?? nowIso();
      stmts.get(`
        INSERT INTO pipeline_metrics (bucket, metric, source_id, category, "count", "sum", "min", "max")
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(bucket, metric, source_id, category) DO UPDATE SET
          "count" = "count" + 1,
          "sum"   = "sum" + excluded."sum",
          "min"   = CASE WHEN "min" IS NULL OR excluded."min" < "min" THEN excluded."min" ELSE "min" END,
          "max"   = CASE WHEN "max" IS NULL OR excluded."max" > "max" THEN excluded."max" ELSE "max" END
      `).run(
        hourBucket(at),
        metric,
        opts.sourceId ?? NO_DIMENSION,
        opts.category ?? NO_DIMENSION,
        value,
        value,
        value,
      );
    },

    recordLatency(sample: LatencySample): void {
      stmts.get(`
        INSERT INTO latency_samples
          (news_event_id, source_id, source_to_scout_ms, scout_to_discord_ms, total_ms, recorded_at)
        VALUES (?,?,?,?,?,?)
      `).run(
        sample.newsEventId,
        sample.sourceId,
        sample.sourceToScoutMs,
        sample.scoutToDiscordMs,
        sample.totalMs,
        sample.recordedAt || nowIso(),
      );
    },

    latencyStats(sinceIso: string): LatencyStats {
      return statsForColumn(sinceIso, 'total_ms');
    },

    latencyBreakdown(sinceIso: string): LatencyBreakdown {
      return {
        sourceToScout: statsForColumn(sinceIso, 'source_to_scout_ms'),
        scoutToDiscord: statsForColumn(sinceIso, 'scout_to_discord_ms'),
        total: statsForColumn(sinceIso, 'total_ms'),
      };
    },

    summary(sinceIso: string): Record<string, number> {
      // Compare against the bucket containing `sinceIso` so a partially elapsed
      // hour is included rather than silently dropped.
      const rows = stmts
        .get<{ metric: string; n: number; total: number }>(`
          SELECT metric, SUM("count") AS n, SUM("sum") AS total
            FROM pipeline_metrics
           WHERE bucket >= ?
           GROUP BY metric
        `)
        .all(hourBucket(sinceIso));

      const out: Record<string, number> = {};
      for (const row of rows) {
        const count = toNumber(row.n);
        const total = toNumber(row.total);
        out[row.metric] = total;
        out[`${row.metric}.count`] = count;
        out[`${row.metric}.avg`] = count > 0 ? total / count : 0;
      }

      // Per-category breakdown as `metric:CATEGORY`. Without this the pipeline
      // report's category distribution silently renders empty, because it has
      // nothing keyed by category to read.
      const byCategory = stmts
        .get<{ metric: string; category: string | null; total: number }>(`
          SELECT metric, category, SUM("sum") AS total
            FROM pipeline_metrics
           WHERE bucket >= ? AND category IS NOT NULL AND category <> ''
           GROUP BY metric, category
        `)
        .all(hourBucket(sinceIso));

      for (const row of byCategory) {
        if (!row.category) continue;
        out[`${row.metric}:${row.category}`] = toNumber(row.total);
      }

      return out;
    },
  };
}
