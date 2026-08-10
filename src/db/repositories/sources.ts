import type { Source, SourceStats, SourceType } from '../../core/types.js';
import type { Category } from '../../core/types.js';
import {
  placeholdersFor,
  createStatementCache,
  fromSqliteBool,
  nowIso,
  toNumber,
  toSqliteBool,
  toText,
  toNullableText,
  type Bind,
  type SqliteDatabase,
} from '../index.js';

/**
 * The configured watchlist (§21, §36) plus its rolling behavioural stats (§28).
 * Config is the source of truth for identity and seed scores; everything Scout
 * learns at runtime (verified, stats) survives a re-sync.
 */
export interface SourceRepo {
  upsertMany(sources: Source[]): void;
  all(): Source[];
  enabled(): Source[];
  /** Every source of this type, enabled or not — filter on `.enabled` to poll. */
  byType(type: SourceType): Source[];
  byId(id: string): Source | null;
  setVerified(id: string, verified: boolean): void;
  setEnabled(id: string, enabled: boolean): void;
  getStats(id: string): SourceStats | null;
  upsertStats(stats: SourceStats): void;
  /** Increment one counter, creating the stats row if this is its first post. */
  bumpStat(sourceId: string, field: string, by?: number): void;
}

interface SourceRow {
  id: string;
  name: string;
  handle: string | null;
  url: string | null;
  source_type: string;
  category: string;
  priority: number;
  enabled: number;
  verified: number;
  quality_score: number;
  noise_score: number;
  macro_score: number;
  micro_score: number;
  geopolitical_score: number;
  filter_profile: string;
  official: number;
  org: string | null;
  expected_interval_ms: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceStatsRow {
  source_id: string;
  posts_received: number;
  posts_accepted: number;
  posts_rejected: number;
  duplicates: number;
  false_positives: number;
  late_posts: number;
  material_events: number;
  average_daily_posts: number;
  useful_post_ratio: number;
  historical_accuracy: number;
  avg_source_latency_ms: number;
  window_start: string;
  updated_at: string;
}

const SOURCE_COLUMNS = `
  id, name, handle, url, source_type, category, priority, enabled, verified,
  quality_score, noise_score, macro_score, micro_score, geopolitical_score,
  filter_profile, official, org, expected_interval_ms, notes, created_at, updated_at`;

/**
 * Counters `bumpStat` may touch, mapped to their column. An allowlist because
 * the field name is interpolated into SQL.
 */
const BUMPABLE: Record<string, string> = {
  postsReceived: 'posts_received',
  postsAccepted: 'posts_accepted',
  postsRejected: 'posts_rejected',
  duplicates: 'duplicates',
  falsePositives: 'false_positives',
  latePosts: 'late_posts',
  materialEvents: 'material_events',
  averageDailyPosts: 'average_daily_posts',
  posts_received: 'posts_received',
  posts_accepted: 'posts_accepted',
  posts_rejected: 'posts_rejected',
  false_positives: 'false_positives',
  late_posts: 'late_posts',
  material_events: 'material_events',
  average_daily_posts: 'average_daily_posts',
};

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    url: row.url,
    sourceType: row.source_type as SourceType,
    category: row.category as Category | 'MIXED',
    priority: toNumber(row.priority, 50),
    enabled: fromSqliteBool(row.enabled),
    verified: fromSqliteBool(row.verified),
    qualityScore: toNumber(row.quality_score, 70),
    noiseScore: toNumber(row.noise_score, 30),
    macroScore: toNumber(row.macro_score, 50),
    microScore: toNumber(row.micro_score, 50),
    geopoliticalScore: toNumber(row.geopolitical_score, 50),
    filterProfile: row.filter_profile === 'strict' ? 'strict' : 'standard',
    official: fromSqliteBool(row.official),
    org: toNullableText(row.org),
    expectedIntervalMs: toNumber(row.expected_interval_ms, 900_000),
    notes: toNullableText(row.notes),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function toStats(row: SourceStatsRow): SourceStats {
  return {
    sourceId: row.source_id,
    postsReceived: toNumber(row.posts_received),
    postsAccepted: toNumber(row.posts_accepted),
    postsRejected: toNumber(row.posts_rejected),
    duplicates: toNumber(row.duplicates),
    falsePositives: toNumber(row.false_positives),
    latePosts: toNumber(row.late_posts),
    materialEvents: toNumber(row.material_events),
    averageDailyPosts: toNumber(row.average_daily_posts),
    usefulPostRatio: toNumber(row.useful_post_ratio),
    historicalAccuracy: toNumber(row.historical_accuracy, 1),
    avgSourceLatencyMs: toNumber(row.avg_source_latency_ms),
    windowStart: toText(row.window_start),
    updatedAt: toText(row.updated_at),
  };
}

export function createSourceRepo(db: SqliteDatabase): SourceRepo {
  const stmts = createStatementCache(db);

  const upsertOne = (s: Source): void => {
    stmts.get(`
      INSERT INTO sources (${SOURCE_COLUMNS})
      VALUES (${placeholdersFor(SOURCE_COLUMNS)})
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        handle = excluded.handle,
        url = excluded.url,
        source_type = excluded.source_type,
        category = excluded.category,
        priority = excluded.priority,
        enabled = excluded.enabled,
        quality_score = excluded.quality_score,
        noise_score = excluded.noise_score,
        macro_score = excluded.macro_score,
        micro_score = excluded.micro_score,
        geopolitical_score = excluded.geopolitical_score,
        filter_profile = excluded.filter_profile,
        official = excluded.official,
        org = excluded.org,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      s.id,
      s.name,
      s.handle,
      s.url,
      s.sourceType,
      s.category,
      s.priority,
      toSqliteBool(s.enabled),
      toSqliteBool(s.verified),
      s.qualityScore,
      s.noiseScore,
      s.macroScore,
      s.microScore,
      s.geopoliticalScore,
      s.filterProfile,
      toSqliteBool(s.official),
      s.org,
      s.expectedIntervalMs ?? 900_000,
      s.notes,
      s.createdAt,
      s.updatedAt,
    );
    // `verified` and `created_at` are deliberately absent from the DO UPDATE
    // list: config never knows whether a handle resolved (§29), and a re-sync
    // must not reset the first-seen timestamp.
  };

  const upsertManyTx = db.transaction((sources: Source[]) => {
    for (const s of sources) upsertOne(s);
  });

  const bumpTx = db.transaction((sourceId: string, column: string, by: number, at: string) => {
    stmts.get(`
      INSERT INTO source_stats (source_id, ${column}, window_start, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        ${column} = ${column} + excluded.${column},
        updated_at = excluded.updated_at
    `).run(sourceId, by, at, at);
    stmts.get(`
      UPDATE source_stats
         SET useful_post_ratio = CAST(posts_accepted AS REAL) / MAX(posts_received, 1)
       WHERE source_id = ?
    `).run(sourceId);
  });

  return {
    upsertMany(sources: Source[]): void {
      if (sources.length === 0) return;
      upsertManyTx(sources);
    },

    all(): Source[] {
      return stmts
        .get<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources ORDER BY priority DESC, id ASC`)
        .all()
        .map(toSource);
    },

    enabled(): Source[] {
      return stmts
        .get<SourceRow>(
          `SELECT ${SOURCE_COLUMNS} FROM sources WHERE enabled = 1 ORDER BY priority DESC, id ASC`,
        )
        .all()
        .map(toSource);
    },

    byType(type: SourceType): Source[] {
      return stmts
        .get<SourceRow>(
          `SELECT ${SOURCE_COLUMNS} FROM sources WHERE source_type = ? ORDER BY priority DESC, id ASC`,
        )
        .all(type)
        .map(toSource);
    },

    byId(id: string): Source | null {
      const row = stmts.get<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(id);
      return row ? toSource(row) : null;
    },

    setVerified(id: string, verified: boolean): void {
      stmts
        .get('UPDATE sources SET verified = ?, updated_at = ? WHERE id = ?')
        .run(toSqliteBool(verified), nowIso(), id);
    },

    setEnabled(id: string, enabled: boolean): void {
      stmts
        .get('UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(toSqliteBool(enabled), nowIso(), id);
    },

    getStats(id: string): SourceStats | null {
      const row = stmts.get<SourceStatsRow>('SELECT * FROM source_stats WHERE source_id = ?').get(id);
      return row ? toStats(row) : null;
    },

    upsertStats(stats: SourceStats): void {
      // useful_post_ratio is derived, never taken from the caller, so the
      // invariant holds no matter who writes.
      const ratio = stats.postsAccepted / Math.max(stats.postsReceived, 1);
      const params: Bind[] = [
        stats.sourceId,
        stats.postsReceived,
        stats.postsAccepted,
        stats.postsRejected,
        stats.duplicates,
        stats.falsePositives,
        stats.latePosts,
        stats.materialEvents,
        stats.averageDailyPosts,
        ratio,
        stats.historicalAccuracy,
        stats.avgSourceLatencyMs,
        stats.windowStart,
        stats.updatedAt,
      ];
      stmts.get(`
        INSERT INTO source_stats (
          source_id, posts_received, posts_accepted, posts_rejected, duplicates,
          false_positives, late_posts, material_events, average_daily_posts,
          useful_post_ratio, historical_accuracy, avg_source_latency_ms,
          window_start, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id) DO UPDATE SET
          posts_received = excluded.posts_received,
          posts_accepted = excluded.posts_accepted,
          posts_rejected = excluded.posts_rejected,
          duplicates = excluded.duplicates,
          false_positives = excluded.false_positives,
          late_posts = excluded.late_posts,
          material_events = excluded.material_events,
          average_daily_posts = excluded.average_daily_posts,
          useful_post_ratio = excluded.useful_post_ratio,
          historical_accuracy = excluded.historical_accuracy,
          avg_source_latency_ms = excluded.avg_source_latency_ms,
          window_start = excluded.window_start,
          updated_at = excluded.updated_at
      `).run(...params);
    },

    bumpStat(sourceId: string, field: string, by = 1): void {
      const column = BUMPABLE[field];
      if (!column) throw new Error(`unknown source_stats field: ${field}`);
      bumpTx(sourceId, column, by, nowIso());
    },
  };
}
