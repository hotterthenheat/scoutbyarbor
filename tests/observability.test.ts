import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createScoutServer } from '../src/server/http.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';

/**
 * The ten signals worth watching in the first week of live use.
 *
 * The distinction this file exists to enforce is between a metric being
 * RECORDED and a metric being READABLE. `latency_samples` carried per-stage
 * columns for a long time while `/metrics` reported only the blended total, and
 * the two freshness-gate outcomes both collapsed into `deliveries.SKIPPED` —
 * so the numbers existed and the operator still could not see them.
 */

setLogLevel('silent');
const log = createLogger('metrics-test');

let dir: string;
let db: ScoutDb;
let server: ReturnType<typeof createScoutServer>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scout-metrics-'));
  db = openDatabase(join(dir, 'm.db'));
  db.migrate();

  server = createScoutServer({
    db,
    logger: log,
    port: 0,
    databasePath: join(dir, 'm.db'),
    readiness: () => [{ name: 'database', ok: true }],
  });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function metrics(): Promise<Record<string, any>> {
  const res = await fetch(`http://127.0.0.1:${server.port()}/metrics`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

const NOW = new Date().toISOString();

describe('latency, by stage', () => {
  it('separates source delay from Scout delay instead of blending them', async () => {
    // A slow source and a fast Scout must not look the same as the reverse.
    db.metrics.recordLatency({
      newsEventId: 'ev-1',
      sourceId: 'x:deltaone',
      sourceToScoutMs: 8_000,
      scoutToDiscordMs: 400,
      totalMs: 8_400,
      recordedAt: NOW,
    });

    const stages = (await metrics()).latencyMs.byStage;

    expect(stages.sourceToScout.avg).toBe(8_000);
    expect(stages.scoutToDiscord.avg).toBe(400);
    expect(stages.total.avg).toBe(8_400);
  });

  it('reports percentiles per stage, not one blended figure', async () => {
    for (let i = 1; i <= 100; i++) {
      db.metrics.recordLatency({
        newsEventId: `ev-${i}`,
        sourceId: 'x:deltaone',
        sourceToScoutMs: i * 10,
        scoutToDiscordMs: i,
        totalMs: i * 11,
        recordedAt: NOW,
      });
    }

    const stages = (await metrics()).latencyMs.byStage;

    expect(stages.sourceToScout.count).toBe(100);
    expect(stages.sourceToScout.p95).toBeGreaterThan(stages.sourceToScout.avg);
    // The stages are genuinely independent, not scaled copies of one number.
    expect(stages.scoutToDiscord.p95).toBeLessThan(stages.sourceToScout.p95);
  });

  it('reports a stage with no samples as zero rather than borrowing another', async () => {
    db.metrics.recordLatency({
      newsEventId: 'ev-1',
      sourceId: 'x:deltaone',
      sourceToScoutMs: 5_000,
      scoutToDiscordMs: null,
      totalMs: null,
      recordedAt: NOW,
    });

    const stages = (await metrics()).latencyMs.byStage;

    expect(stages.sourceToScout.count).toBe(1);
    expect(stages.scoutToDiscord.count).toBe(0);
    expect(stages.scoutToDiscord.avg).toBe(0);
  });
});

describe('the two freshness-gate outcomes stay apart', () => {
  it('counts stale events and unknown timestamps separately', async () => {
    // "The relay stopped sending timestamps" and "Sprout was down long enough
    // for news to age out" need different fixes, so they need different counts.
    db.metrics.record('events_stale_total', 1);
    db.metrics.record('events_stale_total', 1);
    db.metrics.record('events_unknown_time_total', 1);

    const events = (await metrics()).events;

    expect(events.staleTotal).toBe(2);
    expect(events.unknownPublicationTimeTotal).toBe(1);
  });
});

describe('Sprout', () => {
  it('reports delivery outcomes and timing', async () => {
    db.metrics.record('sprout_delivered_total', 1);
    db.metrics.record('sprout_failed_total', 1);
    db.metrics.record('sprout_delivery_ms', 120);
    db.metrics.record('sprout_delivery_ms', 80);

    const sprout = (await metrics()).sprout;

    expect(sprout.deliveredTotal).toBe(1);
    expect(sprout.failedTotal).toBe(1);
    expect(sprout.latencyMsAvg).toBe(100);
    expect(sprout.samples).toBe(2);
  });

  it('separates Sprout failures from Discord failures', async () => {
    db.deliveries.record({
      eventId: 'ev-1',
      destination: 'sprout',
      status: 'FAILED',
      discordMessageId: null,
      sentAt: null,
      error: 'connection refused',
      createdAt: NOW,
    });
    db.deliveries.record({
      eventId: 'ev-1',
      destination: 'news',
      status: 'SENT',
      discordMessageId: '123',
      sentAt: NOW,
      error: null,
      createdAt: NOW,
    });

    const body = await metrics();

    // The merged view still says "one failure somewhere"...
    expect(body.deliveries.FAILED).toBe(1);
    // ...and the split view says which leg, which is the actionable part.
    expect(body.deliveriesByDestination.sprout.FAILED).toBe(1);
    expect(body.deliveriesByDestination.news.SENT).toBe(1);
  });
});

describe('replay recoveries', () => {
  it('reports what the automatic recovery actually recovered', async () => {
    db.metrics.record('replay_runs_total', 1);
    db.metrics.record('replay_recovered_total', 3);
    db.metrics.record('replay_still_failing_total', 1);
    db.metrics.record('replay_deferred_total', 2);

    const replay = (await metrics()).replay;

    expect(replay.runsTotal).toBe(1);
    expect(replay.recoveredTotal).toBe(3);
    expect(replay.stillFailingTotal).toBe(1);
    // A capped pass must be visible, or a silent cap reads as "nothing to do".
    expect(replay.deferredTotal).toBe(2);
  });

  it('starts at zero rather than absent, so a dashboard has something to plot', async () => {
    const body = await metrics();

    expect(body.replay.recoveredTotal).toBe(0);
    expect(body.sprout.failedTotal).toBe(0);
    expect(body.events.staleTotal).toBe(0);
  });
});

describe('duplicates and rejections', () => {
  it('reports pipeline duplicates and rejections, not only webhook ones', async () => {
    db.metrics.record('duplicates', 1, { sourceId: 'x:deltaone' });
    db.metrics.record('duplicates', 1, { sourceId: 'x:firstsquawk' });
    db.metrics.record('posts_rejected', 5, { sourceId: 'x:deltaone' });
    db.metrics.record('webhook_duplicates_total', 1);

    const body = await metrics();

    expect(body.events.duplicatesTotal).toBe(2);
    expect(body.events.rejectedTotal).toBe(5);
    // The webhook-level count stays its own thing — a rejected push and a
    // deduplicated story are different events.
    expect(body.webhook.duplicatesTotal).toBe(1);
  });
});

/**
 * `/metrics` is unauthenticated on a public Render hostname, which is a
 * deliberate choice — the operator needs it to verify the disk and watch
 * latency. That choice is only safe while the endpoint carries operational
 * numbers and nothing else, so this is the guard on it.
 */
describe('/metrics carries operational data and nothing else', () => {
  /** Collects every key at every depth. */
  function allKeys(value: unknown, into: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const item of value) allKeys(item, into);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        into.push(k);
        allKeys(v, into);
      }
    }
    return into;
  }

  it('exposes no field that could name a credential', async () => {
    const body = await metrics();

    const secretish =
      /token|secret|password|bearer|authorization|api[_-]?key|credential|cookie|header|env/i;
    const offenders = allKeys(body).filter((k) => secretish.test(k));

    expect(offenders).toEqual([]);
  });

  it('does not echo raw news text, handles or channel ids', async () => {
    // Everything a post carries goes into the database; none of it belongs in
    // an operational endpoint.
    db.posts.upsert({
      postId: 'x:1',
      author: 'Walter Bloomberg',
      authorHandle: '@DeItaone',
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      publishedAt: NOW,
      canonicalUrl: 'https://x.com/DeItaone/status/1',
      media: [],
      retrievalSource: 'webhook',
      platform: 'x',
      upstreamSource: 'relay',
      receivedAt: NOW,
      discordReceivedAt: null,
      createdAt: NOW,
    });
    db.deliveries.record({
      eventId: 'ev-1',
      destination: 'news',
      status: 'SENT',
      discordMessageId: '111222333444555666',
      sentAt: NOW,
      error: null,
      createdAt: NOW,
    });

    const res = await fetch(`http://127.0.0.1:${server.port()}/metrics`);
    const raw = await res.text();

    expect(raw).not.toContain('FED CUTS RATES');
    expect(raw).not.toContain('DeItaone');
    expect(raw).not.toContain('Walter Bloomberg');
    // Discord message and channel ids are snowflakes; none should appear.
    expect(raw).not.toContain('111222333444555666');
    // The destination KEY is a channel name, which is fine and is the point.
    expect(raw).toContain('news');
  });

  it('reports only the shape the operator was promised', async () => {
    const body = await metrics();

    expect(Object.keys(body).sort()).toEqual([
      'deliveries',
      'deliveriesByDestination',
      'discord',
      'events',
      'latencyMs',
      'queue',
      'replay',
      'sources',
      'sprout',
      'storage',
      'time',
      'webhook',
      'window',
    ]);
  });
});

describe('every signal worth watching is readable from one request', () => {
  it('exposes all ten', async () => {
    const body = await metrics();

    const readable = [
      body.latencyMs.byStage.sourceToScout, // source → Scout
      body.latencyMs.byStage.scoutToDiscord, // Scout processing → Discord
      body.latencyMs.byStage.total, // end to end
      body.sprout.latencyMsAvg, // Scout → Sprout
      body.webhook.rejectedTotal, // rejected webhooks
      body.events.duplicatesTotal, // duplicates
      body.events.staleTotal, // stale events
      body.sprout.failedTotal, // Sprout failures
      body.replay.recoveredTotal, // replay recoveries
      body.events.unknownPublicationTimeTotal, // missing timestamps
    ];

    for (const value of readable) expect(value).toBeDefined();
    // And the disk verdict, which is the one that invalidates everything else.
    expect(body.storage.durability).toBeDefined();
  });
});
