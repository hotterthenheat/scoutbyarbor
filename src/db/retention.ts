import type { ScoutDb } from './index.js';
import type { Logger } from '../util/logger.js';

/**
 * Retention.
 *
 * Scout is a long-lived process writing on every ingested item, so every table
 * it appends to needs a ceiling. Without this, `latency_samples` alone grows by
 * a row per published alert forever, and the P95/P99 query slows down with it.
 *
 * What is kept and why:
 *   raw_posts       long, because replay against real traffic is how a filter
 *                   change gets evaluated before it ships
 *   news_events     same window as raw_posts; it is the decision record
 *   latency_samples short, they are only used for rolling percentiles
 *   processing_jobs short once terminal — but the `posts` table, not this one,
 *                   is the durable "already processed" guard, so pruning a
 *                   completed job can never cause a repost
 *   calendar_fired  pruned well after the event, so a restart cannot refire
 */

export interface RetentionPolicy {
  rawPostDays: number;
  newsEventDays: number;
  latencySampleDays: number;
  completedJobDays: number;
  calendarFiredDays: number;
  /** Hard ceiling on latency samples regardless of age. */
  maxLatencySamples: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  rawPostDays: 45,
  newsEventDays: 45,
  latencySampleDays: 14,
  completedJobDays: 30,
  calendarFiredDays: 90,
  maxLatencySamples: 250_000,
};

export interface RetentionResult {
  rawPosts: number;
  newsEvents: number;
  latencySamples: number;
  jobs: number;
  calendarFired: number;
  events: number;
}

export function pruneOldRows(
  db: ScoutDb,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: Date = new Date(),
): RetentionResult {
  const cutoff = (days: number): string =>
    new Date(now.getTime() - days * 86_400_000).toISOString();

  const run = (sql: string, ...params: Array<string | number>): number => {
    try {
      return db.raw.prepare(sql).run(...params).changes;
    } catch {
      // Retention must never be able to take the wire down.
      return 0;
    }
  };

  const result: RetentionResult = {
    // news_events first: it references events, and raw_posts is what a replay
    // reads, so deleting in dependency order avoids orphaned rows.
    newsEvents: run(`DELETE FROM news_events WHERE timestamp < ?`, cutoff(policy.newsEventDays)),
    rawPosts: run(`DELETE FROM raw_posts WHERE event_time < ?`, cutoff(policy.rawPostDays)),
    latencySamples: run(
      `DELETE FROM latency_samples WHERE recorded_at < ?`,
      cutoff(policy.latencySampleDays),
    ),
    jobs: run(
      `DELETE FROM processing_jobs
        WHERE status IN ('DONE','FAILED','FAILED_RETRIEVAL','SKIPPED')
          AND completed_at IS NOT NULL
          AND completed_at < ?`,
      cutoff(policy.completedJobDays),
    ),
    calendarFired: run(`DELETE FROM calendar_fired WHERE fired_at < ?`, cutoff(policy.calendarFiredDays)),
    // A cluster with no surviving posts is no longer referenced by anything.
    events: run(
      `DELETE FROM events
        WHERE last_updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM news_events WHERE news_events.event_id = events.id)`,
      cutoff(policy.newsEventDays),
    ),
  };

  // Age-based pruning can still leave too many samples after a very busy
  // window, so enforce the hard ceiling as well.
  result.latencySamples += run(
    `DELETE FROM latency_samples
      WHERE id NOT IN (SELECT id FROM latency_samples ORDER BY recorded_at DESC LIMIT ?)`,
    policy.maxLatencySamples,
  );

  return result;
}

export interface RetentionJob {
  start(intervalMs?: number): void;
  stop(): void;
  runOnce(): RetentionResult;
}

export function createRetentionJob(deps: {
  db: ScoutDb;
  logger: Logger;
  policy?: RetentionPolicy;
}): RetentionJob {
  const policy = deps.policy ?? DEFAULT_RETENTION;
  let timer: NodeJS.Timeout | null = null;

  function runOnce(): RetentionResult {
    const result = pruneOldRows(deps.db, policy);
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    if (total > 0) deps.logger.info('retention pruned rows', { ...result });
    return result;
  }

  return {
    start(intervalMs = 6 * 3600_000): void {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        try {
          runOnce();
        } catch (err) {
          deps.logger.warn('retention failed', { err: err as Error });
        }
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
