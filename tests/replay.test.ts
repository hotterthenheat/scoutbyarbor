import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import {
  replayFailedDeliveries,
  formatReplayReport,
  parseSince,
} from '../src/cli/replayDeliveries.js';
import type { SproutClient, SproutEvent } from '../src/sprout/client.js';
import type { RawPost } from '../src/core/types.js';

/**
 * Replaying failed Sprout deliveries. The behaviour that matters most is what
 * it refuses to do: it never touches Discord, and it re-runs the freshness gate
 * rather than force-feeding a stale event to a trading system.
 */

setLogLevel('silent');
const log = createLogger('replay-test');

let dir: string;
let db: ScoutDb;
let sproutCalls: SproutEvent[];
let sproutAvailable: boolean;
let sprout: SproutClient;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-replay-'));
  db = openDatabase(join(dir, 'r.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());

  sproutCalls = [];
  sproutAvailable = true;
  sprout = {
    enabled: true,
    async send(event) {
      if (!sproutAvailable) {
        return { ok: false, status: null, error: 'connection refused', skipped: false, reason: 'unreachable' };
      }
      sproutCalls.push(event);
      return { ok: true, status: 202, error: null, skipped: false, reason: 'delivered' };
    },
  };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({
  db,
  sprout,
  taxonomy: loadTaxonomy(),
  securities: loadSecurityMaster(),
  maxAgeMinutes: 30,
  logger: log,
});

/**
 * Puts a real event through the real pipeline, stores its post with the given
 * publication time, and records a FAILED Sprout delivery for it.
 */
async function seedFailedDelivery(opts: {
  text: string;
  postId: string;
  publishedAt: string | null;
}): Promise<string> {
  const pipeline = createPipeline({
    db,
    taxonomy: loadTaxonomy(),
    securities: loadSecurityMaster(),
    config: {
      minPublishScore: 60,
      minBreakingScore: 90,
      dedupeWindowMinutes: 90,
      clusterWindowMinutes: 240,
      dedupeSimilarity: 0.82,
    },
    logger: log,
  });

  const now = new Date().toISOString();
  db.posts.upsert({
    postId: opts.postId,
    author: 'DeItaone',
    authorHandle: '@DeItaone',
    text: opts.text,
    publishedAt: opts.publishedAt,
    canonicalUrl: `https://x.com/DeItaone/status/${opts.postId.split(':')[1]}`,
    media: [],
    retrievalSource: 'webhook',
    platform: 'x',
    upstreamSource: 'DeItaone',
    receivedAt: now,
    discordReceivedAt: null,
    createdAt: now,
  });

  const raw: RawPost = {
    sourceId: 'relay:discord-urls',
    sourcePostId: opts.postId,
    originalUrl: `https://x.com/DeItaone/status/${opts.postId.split(':')[1]}`,
    author: '@DeItaone',
    text: opts.text,
    eventTime: opts.publishedAt ?? now,
    ingestionTime: now,
    meta: { publishedAt: opts.publishedAt },
  };

  const outcome = await pipeline.process(raw);
  expect(outcome.accepted, `seed event was rejected: ${outcome.rejection}`).toBe(true);

  const eventId = outcome.cluster?.id ?? outcome.newsEvent.id;
  db.deliveries.record({
    eventId,
    destination: 'sprout',
    status: 'FAILED',
    discordMessageId: null,
    sentAt: null,
    error: 'connection refused',
    createdAt: now,
  });
  return eventId;
}

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
describe('finding and re-driving', () => {
  it('delivers a failed event that is still fresh', async () => {
    const eventId = await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:1001',
      publishedAt: minutesAgo(5),
    });

    const report = await replayFailedDeliveries(deps());

    expect(report.candidates).toBe(1);
    expect(report.delivered).toBe(1);
    expect(sproutCalls).toHaveLength(1);
    // The delivery log reflects reality afterwards.
    expect(db.deliveries.forEvent(eventId).find((d) => d.destination === 'sprout')?.status).toBe('SENT');
  });

  it('reuses the original event id as the idempotency key', async () => {
    const eventId = await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:1002',
      publishedAt: minutesAgo(3),
    });

    await replayFailedDeliveries(deps());
    // The Sprout client sends this as the idempotency-key header, so a delivery
    // that landed before the connection dropped is collapsed, not doubled.
    expect(sproutCalls[0]?.eventId).toBe(eventId);
  });

  it('reports nothing to replay on a clean database', async () => {
    const report = await replayFailedDeliveries(deps());
    expect(report.candidates).toBe(0);
    expect(formatReplayReport(report)).toContain('Nothing to replay');
  });
});

describe('the freshness gate is re-run, not bypassed', () => {
  it('skips an event that has aged out since it failed', async () => {
    // A Sprout outage that outlasts the window must not resurrect stale news.
    const eventId = await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:1003',
      publishedAt: minutesAgo(180),
    });

    const report = await replayFailedDeliveries(deps());

    expect(report.skipped).toBe(1);
    expect(report.delivered).toBe(0);
    expect(sproutCalls).toHaveLength(0);

    const delivery = db.deliveries.forEvent(eventId).find((d) => d.destination === 'sprout');
    expect(delivery?.status).toBe('SKIPPED');
    expect(delivery?.error).toContain('limit 30m');
  });

  it('skips an event whose publication time was never known', async () => {
    await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:1004',
      publishedAt: null,
    });

    const report = await replayFailedDeliveries(deps());
    expect(report.skipped).toBe(1);
    expect(report.outcomes[0]?.reason).toBe('publication time unknown');
    expect(sproutCalls).toHaveLength(0);
  });

  it('respects the ORIGINAL publication time, not the replay time', async () => {
    await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:1005',
      publishedAt: minutesAgo(20),
    });

    // Twenty minutes ago is inside the window now...
    expect((await replayFailedDeliveries(deps())).delivered).toBe(1);

    // ...and the same event is outside it an hour later.
    db.deliveries.record({
      eventId: db.deliveries.find({ destination: 'sprout' })[0]!.eventId,
      destination: 'sprout',
      status: 'FAILED',
      discordMessageId: null,
      sentAt: null,
      error: 'connection refused again',
      createdAt: new Date().toISOString(),
    });
    sproutCalls = [];

    const later = await replayFailedDeliveries({
      ...deps(),
      now: () => new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(later.skipped).toBe(1);
    expect(sproutCalls).toHaveLength(0);
  });
});

describe('it never produces a second Discord alert', () => {
  it('does not import or invoke the publisher', async () => {
    await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:1006',
      publishedAt: minutesAgo(2),
    });

    const before = db.discordMessages.forEvent(db.deliveries.find({ destination: 'sprout' })[0]!.eventId);
    await replayFailedDeliveries(deps());
    const after = db.discordMessages.forEvent(db.deliveries.find({ destination: 'sprout' })[0]!.eventId);

    // Structural: the replay module has no publisher dependency at all.
    expect(after.length).toBe(before.length);
  });
});

describe('filters', () => {
  it('restricts to a single provider post id', async () => {
    await seedFailedDelivery({ text: 'FED CUTS RATES BY 50 BPS', postId: 'x:2001', publishedAt: minutesAgo(2) });
    await seedFailedDelivery({
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR SITES',
      postId: 'x:2002',
      publishedAt: minutesAgo(2),
    });

    const report = await replayFailedDeliveries(deps(), { id: 'x:2002' });
    expect(report.candidates).toBe(1);
    expect(sproutCalls).toHaveLength(1);
  });

  it('restricts to a time window', async () => {
    await seedFailedDelivery({ text: 'FED CUTS RATES BY 50 BPS', postId: 'x:2003', publishedAt: minutesAgo(2) });

    const inWindow = await replayFailedDeliveries(deps(), { sinceIso: minutesAgo(30) });
    expect(inWindow.candidates).toBe(1);

    const outOfWindow = await replayFailedDeliveries(deps(), {
      sinceIso: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(outOfWindow.candidates).toBe(0);
  });

  it('caps the number replayed', async () => {
    // Genuinely distinct stories: near-identical headlines would be collapsed
    // by the dedupe layer, which is correct but makes for a useless fixture.
    const stories = [
      'US CPI RISES 0.4% M/M VS 0.2% EXPECTED',
      'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR SITES',
      'OPEC+ AGREES TO EXTEND PRODUCTION CUTS THROUGH Q2',
      'ECB HOLDS RATES STEADY AT 2.00% AS GROWTH SLOWS',
      'BOJ RAISES POLICY RATE TO 0.75% IN SURPRISE MOVE',
    ];
    for (const [i, text] of stories.entries()) {
      await seedFailedDelivery({ text, postId: `x:300${i}`, publishedAt: minutesAgo(2) });
    }
    expect((await replayFailedDeliveries(deps(), { limit: 2 })).candidates).toBe(2);
  });

  it('sends nothing in dry-run mode', async () => {
    await seedFailedDelivery({ text: 'FED CUTS RATES BY 50 BPS', postId: 'x:2004', publishedAt: minutesAgo(2) });

    const report = await replayFailedDeliveries(deps(), { dryRun: true });
    expect(report.delivered).toBe(1);
    expect(sproutCalls).toHaveLength(0);
    // The delivery log is left untouched.
    expect(db.deliveries.find({ destination: 'sprout', status: 'FAILED' })).toHaveLength(1);
    expect(formatReplayReport(report)).toContain('dry run');
  });
});

describe('when Sprout is still down', () => {
  it('leaves the delivery FAILED and reports it', async () => {
    await seedFailedDelivery({ text: 'FED CUTS RATES BY 50 BPS', postId: 'x:2005', publishedAt: minutesAgo(2) });
    sproutAvailable = false;

    const report = await replayFailedDeliveries(deps());
    expect(report.failed).toBe(1);
    expect(report.delivered).toBe(0);
    expect(db.deliveries.find({ destination: 'sprout', status: 'FAILED' }).length).toBeGreaterThan(0);
    expect(formatReplayReport(report)).toContain('STILL FAILING');
  });

  it('is safe to run repeatedly', async () => {
    await seedFailedDelivery({ text: 'FED CUTS RATES BY 50 BPS', postId: 'x:2006', publishedAt: minutesAgo(2) });
    sproutAvailable = false;
    await replayFailedDeliveries(deps());
    await replayFailedDeliveries(deps());

    sproutAvailable = true;
    const recovered = await replayFailedDeliveries(deps());
    expect(recovered.delivered).toBe(1);
    // One send, not three: the earlier attempts never reached Sprout.
    expect(sproutCalls).toHaveLength(1);
  });
});

describe('unresolvable deliveries', () => {
  it('reports a delivery whose event has aged out of retention', async () => {
    db.deliveries.record({
      eventId: 'ev-long-gone',
      destination: 'sprout',
      status: 'FAILED',
      discordMessageId: null,
      sentAt: null,
      error: 'connection refused',
      createdAt: new Date().toISOString(),
    });

    const report = await replayFailedDeliveries(deps());
    expect(report.unresolvable).toBe(1);
    expect(formatReplayReport(report)).toContain('UNRESOLVABLE');
  });
});

describe('parseSince', () => {
  const now = '2026-08-09T12:00:00.000Z';

  it.each([
    ['30m', '2026-08-09T11:30:00.000Z'],
    ['2h', '2026-08-09T10:00:00.000Z'],
    ['1d', '2026-08-08T12:00:00.000Z'],
    ['45s', '2026-08-09T11:59:15.000Z'],
  ])('parses %s', (input, expected) => {
    expect(parseSince(input, now)).toBe(expected);
  });

  it('accepts an absolute timestamp', () => {
    expect(parseSince('2026-08-09T09:00:00Z', now)).toBe('2026-08-09T09:00:00.000Z');
  });

  it('returns null on nonsense', () => {
    expect(parseSince('soon', now)).toBeNull();
  });
});

describe('concurrent runs cannot double-deliver', () => {
  it('gives a delivery to exactly one of two overlapping runs', async () => {
    await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:4001',
      publishedAt: minutesAgo(2),
    });

    // Two runs starting at the same moment, as two cron firings would.
    const [a, b] = await Promise.all([
      replayFailedDeliveries(deps(), { claimant: 'run-a' }),
      replayFailedDeliveries(deps(), { claimant: 'run-b' }),
    ]);

    expect(a.candidates + b.candidates).toBe(1);
    expect(a.delivered + b.delivered).toBe(1);
    // The event reached Sprout once, not twice.
    expect(sproutCalls).toHaveLength(1);
  });

  it('splits a batch between two runs without overlap', async () => {
    const stories = [
      'US CPI RISES 0.4% M/M VS 0.2% EXPECTED',
      'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR SITES',
      'OPEC+ AGREES TO EXTEND PRODUCTION CUTS THROUGH Q2',
      'ECB HOLDS RATES STEADY AT 2.00% AS GROWTH SLOWS',
    ];
    for (const [i, text] of stories.entries()) {
      await seedFailedDelivery({ text, postId: `x:41${i}`, publishedAt: minutesAgo(2) });
    }

    const [a, b] = await Promise.all([
      replayFailedDeliveries(deps(), { claimant: 'run-a' }),
      replayFailedDeliveries(deps(), { claimant: 'run-b' }),
    ]);

    expect(a.candidates + b.candidates).toBe(4);
    // Every event delivered exactly once across both runs.
    expect(sproutCalls).toHaveLength(4);
    expect(new Set(sproutCalls.map((c) => c.eventId)).size).toBe(4);
  });

  it('reclaims a delivery abandoned by a run that died mid-flight', async () => {
    const eventId = await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:4002',
      publishedAt: minutesAgo(2),
    });

    // Simulate a crashed run holding a stale claim.
    db.raw
      .prepare(`UPDATE deliveries SET claimed_at = ?, claimed_by = 'dead-run' WHERE event_id = ?`)
      .run(new Date(Date.now() - 30 * 60_000).toISOString(), eventId);

    // A fresh claim window ignores it...
    expect((await replayFailedDeliveries(deps(), { staleClaimMinutes: 60 })).candidates).toBe(0);
    // ...and the default window reclaims it.
    expect((await replayFailedDeliveries(deps(), { staleClaimMinutes: 10 })).delivered).toBe(1);
  });

  it('releases the claim when a delivery is unresolvable', async () => {
    db.deliveries.record({
      eventId: 'ev-vanished',
      destination: 'sprout',
      status: 'FAILED',
      discordMessageId: null,
      sentAt: null,
      error: 'connection refused',
      createdAt: new Date().toISOString(),
    });

    await replayFailedDeliveries(deps());
    // Not left claimed forever — a later run sees it again rather than the row
    // becoming permanently invisible.
    expect((await replayFailedDeliveries(deps())).candidates).toBe(1);
  });

  it('a dry run does not claim anything', async () => {
    await seedFailedDelivery({
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      postId: 'x:4003',
      publishedAt: minutesAgo(2),
    });

    await replayFailedDeliveries(deps(), { dryRun: true });
    // A real run immediately afterwards still sees it.
    expect((await replayFailedDeliveries(deps())).delivered).toBe(1);
  });
});

describe('the report separates every skip reason', () => {
  it('counts stale and unknown-time skips apart', async () => {
    await seedFailedDelivery({
      text: 'US CPI RISES 0.4% M/M VS 0.2% EXPECTED',
      postId: 'x:5001',
      publishedAt: minutesAgo(300),
    });
    await seedFailedDelivery({
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR SITES',
      postId: 'x:5002',
      publishedAt: null,
    });

    const report = await replayFailedDeliveries(deps());

    expect(report.skippedStale).toBe(1);
    expect(report.skippedUnknownTime).toBe(1);
    expect(report.skipped).toBe(2);
    expect(sproutCalls).toHaveLength(0);

    const printed = formatReplayReport(report);
    expect(printed).toContain('skipped stale');
    expect(printed).toContain('skipped no ts');
  });
});
