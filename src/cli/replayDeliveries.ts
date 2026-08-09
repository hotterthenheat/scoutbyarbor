import type { ScoutDb } from '../db/index.js';
import type { Security } from '../core/types.js';
import type { TaxonomyFile } from '../config/types.js';
import type { SproutClient } from '../sprout/client.js';
import { toSproutEvent } from '../sprout/client.js';
import { assessMarketImpact } from '../pipeline/marketImpact.js';
import { isFreshForTrading } from '../ingest/urlWorker.js';
import { isoNow, minutesBetween } from '../util/time.js';
import type { Logger } from '../util/logger.js';

/**
 * Replays failed Sprout deliveries.
 *
 * A Sprout outage longer than the retry schedule leaves deliveries stuck at
 * FAILED with nothing to re-drive them. This does that, and deliberately does
 * only that:
 *
 *   - It touches Sprout and the delivery log. It never imports the publisher,
 *     so it structurally cannot produce a second Discord alert.
 *   - It re-runs the freshness gate against the ORIGINAL publication time. An
 *     event that has since aged out is skipped, not force-fed to a trading
 *     system — replaying a stale headline is exactly the failure the gate
 *     exists to prevent.
 *   - It reuses the original event id as the idempotency key, so a delivery
 *     that actually landed before the connection dropped is collapsed by
 *     Sprout rather than double-counted.
 *
 * Market impact is recomputed from the stored event with the same
 * `assessMarketImpact` the pipeline uses — no second implementation.
 */

export interface ReplayOptions {
  /** Only replay deliveries in this state. Defaults to FAILED. */
  status?: 'FAILED' | 'SKIPPED';
  /** Only deliveries recorded at or after this time. */
  sinceIso?: string;
  /** Restrict to a single event id or provider post id (e.g. `x:123`). */
  id?: string;
  limit?: number;
  /** Report what would happen without sending anything. */
  dryRun?: boolean;
  /**
   * Identifies this run in the claim. Two concurrent runs claim disjoint sets,
   * so the same delivery is never processed twice at once.
   */
  claimant?: string;
  /** A claim older than this is treated as abandoned. Defaults to 10 minutes. */
  staleClaimMinutes?: number;
  /**
   * Stop starting new deliveries once a pass has run this long, handing back
   * everything it has not reached.
   *
   * Without this, a pass is unbounded: with Sprout down, 100 rows each burning
   * a 10s timeout takes over 16 minutes, which is longer than the stale-claim
   * window — so the NEXT run would reclaim rows this one is still working on
   * and send them a second time. Defaults to 80% of the stale-claim window, so
   * a pass always finishes before its own claims can be taken from it.
   */
  maxRunMs?: number;
}

export interface ReplayOutcome {
  eventId: string;
  headline: string;
  publishedAt: string | null;
  result: 'DELIVERED' | 'SKIPPED' | 'FAILED' | 'UNRESOLVABLE';
  reason: string;
}

export interface ReplayReport {
  candidates: number;
  delivered: number;
  /** Held back because the event has aged past the freshness window. */
  skippedStale: number;
  /** Held back because publication time was never known. */
  skippedUnknownTime: number;
  /** Total of the two skip reasons, for convenience. */
  skipped: number;
  failed: number;
  unresolvable: number;
  /**
   * Claimed but not reached before the run budget expired, and handed straight
   * back. Never silently dropped — the next pass picks them up.
   */
  deferred: number;
  dryRun: boolean;
  outcomes: ReplayOutcome[];
}

export interface ReplayDeps {
  db: ScoutDb;
  sprout: SproutClient;
  taxonomy: TaxonomyFile;
  securities: Security[];
  maxAgeMinutes: number;
  logger: Logger;
  now?: () => string;
}

export async function replayFailedDeliveries(
  deps: ReplayDeps,
  options: ReplayOptions = {},
): Promise<ReplayReport> {
  const { db } = deps;
  const now = deps.now ?? isoNow;

  const startedAt = now();
  const eventIds = options.id ? resolveEventIds(db, options.id) : undefined;

  const query = {
    destination: 'sprout',
    status: options.status ?? ('FAILED' as const),
    ...(options.sinceIso ? { sinceIso: options.sinceIso } : {}),
    ...(eventIds ? { eventIds } : {}),
    limit: options.limit ?? 500,
  };

  const staleClaimMs = (options.staleClaimMinutes ?? 10) * 60_000;
  const staleClaimBefore = new Date(Date.parse(startedAt) - staleClaimMs).toISOString();

  // A pass must finish before its own claims become reclaimable, or the next
  // run starts re-sending rows this one is still working through.
  const deadline = Date.parse(startedAt) + (options.maxRunMs ?? Math.floor(staleClaimMs * 0.8));

  // A dry run must not disturb another run's work, so it only reads.
  const candidates = options.dryRun
    ? db.deliveries.find(query)
    : db.deliveries.claimForReplay(
        query,
        options.claimant ?? `replay-${process.pid}`,
        staleClaimBefore,
        startedAt,
      );

  const report: ReplayReport = {
    candidates: candidates.length,
    delivered: 0,
    skippedStale: 0,
    skippedUnknownTime: 0,
    skipped: 0,
    failed: 0,
    unresolvable: 0,
    deferred: 0,
    dryRun: Boolean(options.dryRun),
    outcomes: [],
  };

  for (const [index, delivery] of candidates.entries()) {
    // Out of budget. Hand back everything untouched so the next pass can take
    // it cleanly, rather than letting the claims rot until they age out.
    if (Date.parse(now()) >= deadline) {
      const remaining = candidates.slice(index);
      if (!options.dryRun) {
        for (const row of remaining) db.deliveries.releaseClaim(row.eventId, 'sprout');
      }
      report.deferred = remaining.length;
      deps.logger.warn('sprout replay hit its run budget; deferring the rest', {
        deferred: remaining.length,
        processed: index,
      });
      break;
    }

    let outcome: ReplayOutcome;
    try {
      outcome = await replayOne(deps, delivery.eventId, options, now());
    } catch (err) {
      // An unexpected failure must not leave the row claimed forever.
      if (!options.dryRun) db.deliveries.releaseClaim(delivery.eventId, 'sprout');
      outcome = {
        eventId: delivery.eventId,
        headline: '',
        publishedAt: null,
        result: 'FAILED',
        reason: (err as Error).message,
      };
    }

    report.outcomes.push(outcome);

    if (outcome.result === 'DELIVERED') report.delivered++;
    else if (outcome.result === 'SKIPPED') {
      report.skipped++;
      if (outcome.reason === UNKNOWN_TIME_REASON) report.skippedUnknownTime++;
      else report.skippedStale++;
    } else if (outcome.result === 'FAILED') report.failed++;
    else {
      report.unresolvable++;
      // Nothing will ever resolve this; do not hold the claim.
      if (!options.dryRun) db.deliveries.releaseClaim(delivery.eventId, 'sprout');
    }
  }

  // The six counts the operator actually needs, on one line.
  deps.logger.info('sprout replay complete', {
    found: report.candidates,
    delivered: report.delivered,
    skippedStale: report.skippedStale,
    skippedUnknownTime: report.skippedUnknownTime,
    stillFailing: report.failed,
    unresolvable: report.unresolvable,
    // Reported even at zero: a run that quietly capped its own work would read
    // as a run that had nothing left to do.
    deferred: report.deferred,
    dryRun: report.dryRun,
    windowMs: Math.max(0, Date.parse(now()) - Date.parse(startedAt)),
  });

  return report;
}

/** Matches the freshness gate's wording for a missing publication time. */
const UNKNOWN_TIME_REASON = 'publication time unknown';

async function replayOne(
  deps: ReplayDeps,
  eventId: string,
  options: ReplayOptions,
  nowIso: string,
): Promise<ReplayOutcome> {
  const { db } = deps;

  // The cluster's highest-importance post is the one that represented it.
  const members = db.newsEvents.byEventId(eventId);
  const newsEvent =
    members.sort((a, b) => b.importance - a.importance)[0] ?? db.newsEvents.byId(eventId);

  if (!newsEvent) {
    return {
      eventId,
      headline: '',
      publishedAt: null,
      result: 'UNRESOLVABLE',
      reason: 'no stored event — it may have aged out of retention',
    };
  }

  const cluster = newsEvent.eventId ? db.events.byId(newsEvent.eventId) : null;

  // The ORIGINAL publication time, from the post record. news_events.timestamp
  // is the ordering timestamp and may be the receipt time when publication was
  // unknown, so it must not be used here.
  const post = db.posts.byId(newsEvent.sourcePostId);
  const publishedAt = post?.publishedAt ?? null;

  const freshness = isFreshForTrading(publishedAt, deps.maxAgeMinutes, nowIso);
  if (!freshness.fresh) {
    if (!options.dryRun) {
      db.deliveries.record({
        eventId,
        destination: 'sprout',
        status: 'SKIPPED',
        discordMessageId: null,
        sentAt: null,
        error: freshness.reason,
        createdAt: nowIso,
      });
    }
    return {
      eventId,
      headline: newsEvent.headline,
      publishedAt,
      result: 'SKIPPED',
      reason: freshness.reason,
    };
  }

  // Recomputed with the pipeline's own classifier rather than a second one.
  const impact = newsEvent.category
    ? assessMarketImpact({
        category: newsEvent.category,
        subcategory: newsEvent.subcategory,
        band: newsEvent.score?.band ?? 'LOW',
        score: newsEvent.importance,
        entities: newsEvent.entities,
        text: newsEvent.cleanText,
        securities: deps.securities,
      })
    : null;

  if (options.dryRun) {
    return {
      eventId,
      headline: newsEvent.headline,
      publishedAt,
      result: 'DELIVERED',
      reason: `would send (${freshness.reason})`,
    };
  }

  // toSproutEvent keys the payload on the cluster id, which the client sends as
  // the idempotency key — so a delivery that landed before the connection
  // dropped is collapsed by Sprout rather than counted twice.
  const result = await deps.sprout.send(
    toSproutEvent({ newsEvent, cluster, impact, publishedAt }),
  );

  db.deliveries.record({
    eventId,
    destination: 'sprout',
    status: result.ok ? 'SENT' : result.skipped ? 'SKIPPED' : 'FAILED',
    discordMessageId: null,
    sentAt: result.ok ? nowIso : null,
    error: result.error,
    createdAt: nowIso,
  });

  return {
    eventId,
    headline: newsEvent.headline,
    publishedAt,
    result: result.ok ? 'DELIVERED' : result.skipped ? 'SKIPPED' : 'FAILED',
    reason: result.ok ? freshness.reason : (result.error ?? result.reason),
  };
}

/** Accepts either a cluster id or a provider post id such as `x:123`. */
function resolveEventIds(db: ScoutDb, id: string): string[] {
  const ids = new Set<string>([id]);

  const byPost = db.newsEvents.bySourcePostId(id);
  if (byPost) {
    ids.add(byPost.eventId ?? byPost.id);
    ids.add(byPost.id);
  }
  return [...ids];
}

/** `30m`, `2h`, `7d`, `45s` → an ISO timestamp that far in the past. */
export function parseSince(value: string, nowIso: string = isoNow()): string | null {
  const match = /^(\d+)\s*([smhd])$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    // An absolute timestamp is also acceptable.
    const absolute = Date.parse(value);
    return Number.isFinite(absolute) ? new Date(absolute).toISOString() : null;
  }

  const amount = Number(match[1]);
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2].toLowerCase() as 's' | 'm' | 'h' | 'd'
  ];
  return new Date(Date.parse(nowIso) - amount * unitMs).toISOString();
}

export function formatReplayReport(report: ReplayReport, nowIso: string = isoNow()): string {
  const lines = [
    'SPROUT DELIVERY REPLAY' + (report.dryRun ? '  (dry run — nothing was sent)' : ''),
    '',
    `  candidates     ${String(report.candidates).padStart(4)}`,
    `  delivered      ${String(report.delivered).padStart(4)}`,
    `  skipped stale  ${String(report.skippedStale).padStart(4)}   (aged past the freshness window)`,
    `  skipped no ts  ${String(report.skippedUnknownTime).padStart(4)}   (publication time unknown)`,
    `  still failing  ${String(report.failed).padStart(4)}`,
  ];
  if (report.unresolvable > 0) {
    lines.push(`  unresolvable   ${String(report.unresolvable).padStart(4)}   (no stored event)`);
  }
  if (report.deferred > 0) {
    lines.push(
      `  deferred       ${String(report.deferred).padStart(4)}   (ran out of time; next pass takes them)`,
    );
  }

  const group = (label: string, result: ReplayOutcome['result']): void => {
    const rows = report.outcomes.filter((o) => o.result === result);
    if (rows.length === 0) return;
    lines.push('', label);
    for (const row of rows) {
      const age = row.publishedAt
        ? `${Math.round(minutesBetween(row.publishedAt, nowIso))}m old`
        : 'no publication time';
      lines.push(
        `  ${row.eventId.slice(0, 12).padEnd(12)}  ${row.headline.slice(0, 46).padEnd(46)}  ${age}`,
      );
      lines.push(`    ${row.reason}`);
    }
  };

  group('DELIVERED', 'DELIVERED');
  group('SKIPPED', 'SKIPPED');
  group('STILL FAILING', 'FAILED');
  group('UNRESOLVABLE', 'UNRESOLVABLE');

  if (report.candidates === 0) {
    lines.push('', 'Nothing to replay.');
  }
  return lines.join('\n');
}
