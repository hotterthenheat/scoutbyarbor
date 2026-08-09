import type { RejectionReason } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import { formatLatencyReport, summarizeLatency } from './latency.js';

/**
 * SOURCE AND PIPELINE STATISTICS (§28, §34).
 *
 * §28 is deliberate that Scout collects statistics for human review rather than
 * adjusting itself. So this module reports and recommends; it never mutates a
 * source's enabled flag or scores. A bot that quietly changes what it considers
 * important is a bot you cannot reason about.
 */

export interface SourceReportRow {
  sourceId: string;
  name: string;
  received: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  usefulRatio: number;
  avgLatencyMs: number;
  qualityScore: number;
  noiseScore: number;
  suggestion: 'KEEP' | 'REVIEW' | 'REMOVE';
}

export interface PipelineReport {
  alertsSent: number;
  duplicateRate: number;
  rejectionRate: number;
  byCategory: Record<string, number>;
  latency: { avg: number; p95: number; p99: number };
  sources: SourceReportRow[];
}

export interface StatsCollector {
  recordReceived(sourceId: string): void;
  recordAccepted(sourceId: string, importance: number): void;
  recordRejected(sourceId: string, reason: RejectionReason): void;
  recordDuplicate(sourceId: string): void;
  sourceReport(sinceIso: string): SourceReportRow[];
  pipelineReport(sinceIso: string): PipelineReport;
}

export function createStatsCollector(deps: { db: ScoutDb; now?: () => Date }): StatsCollector {
  const { db } = deps;

  return {
    // The pipeline already bumps the per-source counters as it runs; these
    // record the category/reason breakdowns used by the reports.
    recordReceived(sourceId: string): void {
      db.metrics.record('posts_received', 1, { sourceId });
    },
    recordAccepted(sourceId: string, importance: number): void {
      db.metrics.record('posts_accepted', 1, { sourceId });
      db.metrics.record('importance', importance, { sourceId });
    },
    recordRejected(sourceId: string, reason: RejectionReason): void {
      db.metrics.record('posts_rejected', 1, { sourceId });
      db.metrics.record(`rejected:${reason}`, 1, { sourceId });
    },
    recordDuplicate(sourceId: string): void {
      db.metrics.record('duplicates', 1, { sourceId });
    },

    sourceReport(_sinceIso: string): SourceReportRow[] {
      const rows: SourceReportRow[] = [];

      for (const source of db.sources.all()) {
        const stats = db.sources.getStats(source.id);
        const received = stats?.postsReceived ?? 0;
        const accepted = stats?.postsAccepted ?? 0;
        const ratio = received > 0 ? accepted / received : 0;

        rows.push({
          sourceId: source.id,
          name: source.name,
          received,
          accepted,
          rejected: stats?.postsRejected ?? 0,
          duplicates: stats?.duplicates ?? 0,
          usefulRatio: ratio,
          avgLatencyMs: stats?.avgSourceLatencyMs ?? 0,
          qualityScore: source.qualityScore,
          noiseScore: source.noiseScore,
          suggestion: suggestionFor(source.qualityScore, ratio, received),
        });
      }

      return rows.sort((a, b) => b.usefulRatio - a.usefulRatio || b.accepted - a.accepted);
    },

    pipelineReport(sinceIso: string): PipelineReport {
      const summary = db.metrics.summary(sinceIso);
      const statuses = db.newsEvents.countsByStatus(sinceIso);
      const latency = db.metrics.latencyStats(sinceIso);

      const total = Object.values(statuses).reduce((a, b) => a + b, 0) || 1;
      const duplicates = statuses.DUPLICATE ?? 0;
      const rejected = (statuses.FILTERED ?? 0) + (statuses.BELOW_THRESHOLD ?? 0);

      const byCategory: Record<string, number> = {};
      for (const [key, value] of Object.entries(summary)) {
        if (key.startsWith('alerts_sent:')) byCategory[key.slice('alerts_sent:'.length)] = value;
      }

      return {
        alertsSent: summary.alerts_sent ?? statuses.PUBLISHED ?? 0,
        duplicateRate: duplicates / total,
        rejectionRate: rejected / total,
        byCategory,
        latency: { avg: latency.avg, p95: latency.p95, p99: latency.p99 },
        sources: this.sourceReport(sinceIso),
      };
    },
  };
}

/**
 * §5's tiering, applied as advice only. A source with too little traffic to
 * judge is left alone rather than condemned on a small sample.
 */
function suggestionFor(quality: number, ratio: number, received: number): SourceReportRow['suggestion'] {
  if (received < 25) return 'KEEP';
  if (quality < 70 || ratio < 0.05) return 'REMOVE';
  if (quality < 85 || ratio < 0.15) return 'REVIEW';
  return 'KEEP';
}

export function formatSourceReport(rows: SourceReportRow[]): string {
  const lines = [
    'SOURCE PERFORMANCE',
    '',
    'source                        recv   acc   dup   useful   q/n      action',
    '───────────────────────────────────────────────────────────────────────────',
  ];

  for (const r of rows) {
    lines.push(
      [
        r.sourceId.padEnd(28).slice(0, 28),
        String(r.received).padStart(5),
        String(r.accepted).padStart(5),
        String(r.duplicates).padStart(5),
        `${(r.usefulRatio * 100).toFixed(1)}%`.padStart(8),
        `${r.qualityScore}/${r.noiseScore}`.padStart(7),
        `  ${r.suggestion}`,
      ].join(' '),
    );
  }

  lines.push('', 'Advisory only — Scout does not adjust its own thresholds (§28).');
  return '```\n' + lines.join('\n') + '\n```';
}

export function formatPipelineReport(report: PipelineReport): string {
  const lines = [
    'PIPELINE',
    '',
    `alerts sent      ${report.alertsSent}`,
    `duplicate rate   ${(report.duplicateRate * 100).toFixed(1)}%`,
    `rejection rate   ${(report.rejectionRate * 100).toFixed(1)}%`,
    '',
    `AVG LATENCY      ${Math.round(report.latency.avg)} ms`,
    `P95 LATENCY      ${Math.round(report.latency.p95)} ms`,
    `P99 LATENCY      ${Math.round(report.latency.p99)} ms`,
  ];

  const categories = Object.entries(report.byCategory).sort((a, b) => b[1] - a[1]);
  if (categories.length) {
    lines.push('', 'BY CATEGORY');
    for (const [category, count] of categories) {
      lines.push(`  ${category.padEnd(16)} ${count}`);
    }
  }

  return '```\n' + lines.join('\n') + '\n```\n' + formatSourceReport(report.sources);
}

export { formatLatencyReport, summarizeLatency };
