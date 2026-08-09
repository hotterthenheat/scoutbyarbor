import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createScoutServer, type ScoutServer } from '../src/server/http.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { createJobQueue, type JobQueue } from '../src/ingest/queue.js';
import { createUrlWorker, isFreshForTrading } from '../src/ingest/urlWorker.js';
import { createStoredPostResolver, createChainResolver } from '../src/ingest/resolver.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { toSproutEvent, type SproutClient } from '../src/sprout/client.js';
import { canonicalIdFromWebhook, secretsMatch } from '../src/server/webhook.js';
import type { ChannelKey } from '../src/core/types.js';
import type { ScoutDiscord, SentMessage } from '../src/discord/client.js';

/**
 * Webhook ingestion, driven through a real HTTP server against the real
 * processor. The point of every test here is that a pushed event is handled by
 * exactly the same classifier, router, renderer and Sprout path as a relayed
 * one — there is no webhook-specific behaviour to verify because there is none.
 */

setLogLevel('silent');
const log = createLogger('webhook-test');

const TOKEN = 'test-webhook-secret';

const X_EVENT = {
  v: 1,
  id: 'x-2058552301120360937',
  platform: 'x',
  source: 'DeItaone',
  handle: '@DeItaone',
  text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING\n\nThe Committee cited deteriorating labour market conditions.',
  published_at: null as string | null,
  url: 'https://x.com/DeItaone/status/2058552301120360937',
};

const TRUTH_EVENT = {
  v: 1,
  id: 'truth-123456789',
  platform: 'truth_social',
  source: 'Trump',
  handle: '@realDonaldTrump',
  text: 'WE WILL IMPOSE MAJOR NEW SANCTIONS ON RUSSIA EFFECTIVE IMMEDIATELY',
  published_at: null as string | null,
  url: 'https://truthsocial.com/@realDonaldTrump/posts/123456789',
};

interface Sent {
  channel: ChannelKey;
  content: string;
}

function fakeDiscord(sent: Sent[]): ScoutDiscord {
  let n = 0;
  return {
    async start() {},
    async stop() {},
    async send(channel: ChannelKey, content: string): Promise<SentMessage> {
      sent.push({ channel, content });
      return { channelId: `chan-${channel}`, messageId: `msg-${++n}` };
    },
    async edit() {
      return true;
    },
    async ensureChannels() {
      return {};
    },
    isReady: () => true,
  };
}

let dir: string;
let db: ScoutDb;
let server: ScoutServer;
let baseUrl: string;
let sent: Sent[];
let queue: JobQueue;
let sproutCalls: ReturnType<typeof toSproutEvent>[];
let sproutAvailable: boolean;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scout-webhook-'));
  db = openDatabase(join(dir, 'w.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());

  sent = [];
  sproutCalls = [];
  sproutAvailable = true;

  const sprout: SproutClient = {
    enabled: true,
    async send(event) {
      if (!sproutAvailable) {
        return { ok: false, status: null, error: 'connection refused', skipped: false, reason: 'unreachable' };
      }
      sproutCalls.push(event);
      return { ok: true, status: 202, error: null, skipped: false, reason: 'delivered' };
    },
  };

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

  const publisher = createPublisher({
    discord: fakeDiscord(sent),
    db,
    logger: log,
    rawChannelEnabled: false,
  });

  // The SAME resolver/queue/worker the runtime uses.
  const resolver = createChainResolver(
    [
      createStoredPostResolver((canonicalId) => {
        const stored = db.posts.byId(canonicalId);
        if (!stored || stored.retrievalSource !== 'webhook') return null;
        return {
          author: stored.author,
          authorHandle: stored.authorHandle,
          text: stored.text,
          publishedAt: stored.publishedAt,
          canonicalUrl: stored.canonicalUrl,
          retrievalSource: stored.retrievalSource,
        };
      }),
    ],
    log,
  );

  queue = createJobQueue({
    db,
    logger: log,
    concurrency: 4,
    maxAttempts: 2,
    pollIntervalMs: 5,
    backoffMs: [0, 5],
    handler: async (job) => worker.handle(job),
  });

  const worker = createUrlWorker({
    db,
    queue,
    resolver,
    logger: log,
    allowedAccounts: [],
    relaySourceId: 'relay:discord-urls',
    onPost: async (post) => {
      const outcome = await pipeline.process(post);
      if (!outcome.accepted) return;
      await publisher.publish(outcome);

      const publishedAt = typeof post.meta.publishedAt === 'string' ? post.meta.publishedAt : null;
      const freshness = isFreshForTrading(publishedAt, 30);
      const eventId = outcome.cluster?.id ?? outcome.newsEvent.id;

      if (!freshness.fresh) {
        db.deliveries.record({
          eventId,
          destination: 'sprout',
          status: 'SKIPPED',
          discordMessageId: null,
          sentAt: null,
          error: freshness.reason,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      const result = await sprout.send(
        toSproutEvent({
          newsEvent: outcome.newsEvent,
          cluster: outcome.cluster,
          impact: outcome.impact,
          publishedAt,
        }),
      );
      db.deliveries.record({
        eventId,
        destination: 'sprout',
        status: result.ok ? 'SENT' : 'FAILED',
        discordMessageId: null,
        sentAt: result.ok ? new Date().toISOString() : null,
        error: result.error,
        createdAt: new Date().toISOString(),
      });
    },
  });

  server = createScoutServer({
    db,
    logger: log,
    port: 0,
    readiness: () => [{ name: 'database', ok: true }],
    webhook: {
      token: TOKEN,
      accept: (event, key) => {
        const now = new Date().toISOString();
        db.posts.upsert({
          postId: event.canonicalId,
          author: event.upstreamSource,
          authorHandle: event.handle,
          text: event.text,
          publishedAt: event.publishedAt,
          canonicalUrl: event.url,
          media: [],
          retrievalSource: 'webhook',
          platform: event.platform,
          upstreamSource: event.upstreamSource,
          receivedAt: event.receivedAt,
          discordReceivedAt: null,
          createdAt: now,
        });
        const job = queue.enqueue({
          postId: event.canonicalId,
          url: event.url,
          sourceChannel: `webhook:${key}`,
          sourceKind: 'webhook',
        });
        return { accepted: job !== null, duplicate: job === null, eventId: event.canonicalId };
      },
    },
  });

  await server.start();
  baseUrl = `http://127.0.0.1:${server.port()}`;
});

afterEach(async () => {
  queue.stop();
  await server.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(
  body: unknown,
  opts: { token?: string | null; idempotencyKey?: string; raw?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;

  const response = await fetch(`${baseUrl}/webhook/news`, {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('authentication', () => {
  it('rejects a missing token with 401', async () => {
    expect((await post(X_EVENT, { token: null })).status).toBe(401);
  });

  it('rejects an invalid token with 401', async () => {
    expect((await post(X_EVENT, { token: 'wrong-secret' })).status).toBe(401);
  });

  it('rejects a token of the right length but wrong value', async () => {
    expect((await post(X_EVENT, { token: 'test-webhook-secreT' })).status).toBe(401);
  });

  it('compares secrets in constant time and refuses an empty expectation', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });

  it('never echoes the token back', async () => {
    const res = await post(X_EVENT, { token: 'wrong-secret' });
    expect(JSON.stringify(res.json)).not.toContain('wrong-secret');
    expect(JSON.stringify(res.json)).not.toContain(TOKEN);
  });
});

describe('validation', () => {
  it('accepts a valid X event with 202', async () => {
    const res = await post(X_EVENT);
    expect(res.status).toBe(202);
    expect(res.json.status).toBe('accepted');
  });

  it('rejects a missing text with 400', async () => {
    const { text: _omitted, ...withoutText } = X_EVENT;
    expect((await post(withoutText)).status).toBe(400);
  });

  it('rejects an empty text with 400', async () => {
    expect((await post({ ...X_EVENT, text: '   ' })).status).toBe(400);
  });

  it.each([
    ['unsupported schema version', { ...X_EVENT, v: 99 }],
    ['unknown platform', { ...X_EVENT, platform: 'mastodon' }],
    ['missing url', { ...X_EVENT, url: '' }],
    ['relative url', { ...X_EVENT, url: '/status/1' }],
    ['unparseable published_at', { ...X_EVENT, published_at: 'yesterday' }],
    ['missing id', { ...X_EVENT, id: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('rejects a future published_at', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await post({ ...X_EVENT, published_at: future })).status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    expect((await post(null, { raw: '{not json' })).status).toBe(400);
  });

  it('rejects a non-POST with 405', async () => {
    const res = await fetch(`${baseUrl}/webhook/news`, { method: 'GET' });
    expect(res.status).toBe(405);
  });
});

describe('the id becomes the shared dedupe key', () => {
  it.each([
    ['x-123', 'x' as const, 'x:123'],
    ['x:123', 'x' as const, 'x:123'],
    ['123', 'x' as const, 'x:123'],
    ['truth-987', 'truthsocial' as const, 'truth:987'],
    ['truth_social-987', 'truthsocial' as const, 'truth:987'],
  ])('normalises %s to %s', (raw, platform, expected) => {
    expect(canonicalIdFromWebhook(raw, platform)).toBe(expected);
  });
});

describe('processing', () => {
  it('runs the same pipeline and posts the normal Scout alert', async () => {
    await post(X_EVENT);
    await queue.drain();

    const stored = db.posts.byId('x:2058552301120360937');
    expect(stored?.retrievalSource).toBe('webhook');
    // Upstream service and original account are stored separately.
    expect(stored?.upstreamSource).toBe('DeItaone');
    expect(stored?.authorHandle).toBe('@DeItaone');
    expect(stored?.platform).toBe('x');

    const alert = sent.find((s) => s.channel === 'news')?.content ?? '';
    expect(alert).toContain('FED CUTS RATES BY 50 BPS');
    // The presentation layer is unchanged: no webhook, no ids, no metadata.
    expect(alert.toLowerCase()).not.toContain('webhook');
    expect(alert).not.toContain('x:2058552301120360937');
    expect(alert).not.toContain('@DeItaone');
    expect(alert).not.toContain('http');
    expect(alert.toLowerCase()).not.toContain('score');
  });

  it('routes a major event to both trading channels', async () => {
    await post(X_EVENT);
    await queue.drain();

    const channels = sent.map((s) => s.channel);
    expect(channels).toContain('news');
    expect(channels).toContain('tradingFloor');
    expect(channels).toContain('spx');
  });

  it('processes a Truth Social event through the identical path', async () => {
    const res = await post(TRUTH_EVENT);
    expect(res.status).toBe(202);
    await queue.drain();

    const stored = db.posts.byId('truth:123456789');
    expect(stored?.platform).toBe('truthsocial');
    expect(stored?.upstreamSource).toBe('Trump');
    expect(stored?.authorHandle).toBe('@realDonaldTrump');

    const channels = sent.map((s) => s.channel);
    expect(channels).toContain('news');
    expect(channels).toContain('tradingFloor');
  });

  it('keeps a non-market event out of the trading channels', async () => {
    await post({
      ...X_EVENT,
      id: 'x-555',
      url: 'https://x.com/DeItaone/status/555',
      text: 'Trump says happy birthday to a longtime supporter at a rally in Ohio.',
    });
    await queue.drain();

    expect(sent.map((s) => s.channel)).not.toContain('tradingFloor');
    expect(sent.map((s) => s.channel)).not.toContain('spx');
  });
});

describe('timestamps', () => {
  it('stores a supplied published_at exactly', async () => {
    const publishedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await post({ ...X_EVENT, published_at: publishedAt });
    await queue.drain();

    expect(db.posts.byId('x:2058552301120360937')?.publishedAt).toBe(publishedAt);
  });

  it('never substitutes the receipt time for a missing published_at', async () => {
    await post({ ...X_EVENT, published_at: null });
    await queue.drain();

    const stored = db.posts.byId('x:2058552301120360937');
    expect(stored?.publishedAt).toBeNull();
    // Receipt time is recorded, just in its own column.
    expect(stored?.receivedAt).toBeTruthy();
  });
});

describe('Sprout', () => {
  it('delivers a fresh event', async () => {
    await post({ ...X_EVENT, published_at: new Date(Date.now() - 60_000).toISOString() });
    await queue.drain();

    expect(sproutCalls).toHaveLength(1);
    expect(sproutCalls[0]?.marketMoving).toBe(true);
  });

  it('holds an event with no publication time, with that exact reason', async () => {
    await post({ ...X_EVENT, published_at: null });
    await queue.drain();

    expect(sproutCalls).toHaveLength(0);
    const skipped = db.deliveries
      .forEvent(db.newsEvents.dedupeCandidates('1970-01-01T00:00:00.000Z')[0]?.eventId ?? '')
      .find((d) => d.destination === 'sprout');
    expect(skipped?.status).toBe('SKIPPED');
    expect(skipped?.error).toBe('publication time unknown');
  });

  it('holds a stale event behind the freshness gate', async () => {
    const old = new Date(Date.now() - 6 * 3600_000).toISOString();
    await post({ ...X_EVENT, published_at: old });
    await queue.drain();

    // Still published to Discord — Scout may show old news.
    expect(sent.map((s) => s.channel)).toContain('news');
    expect(sproutCalls).toHaveLength(0);
  });

  it('keeps Discord working when Sprout is unavailable', async () => {
    sproutAvailable = false;
    await post({ ...X_EVENT, published_at: new Date(Date.now() - 60_000).toISOString() });
    await queue.drain();

    expect(sent.map((s) => s.channel)).toContain('news');
    const failed = db.deliveries.failed(10).find((d) => d.destination === 'sprout');
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain('connection refused');
  });
});

describe('idempotency and deduplication', () => {
  it('returns success without a second alert on a retry', async () => {
    const first = await post(X_EVENT);
    await queue.drain();
    const second = await post(X_EVENT);
    await queue.drain();

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.json.status).toBe('duplicate');
    expect(sent.filter((s) => s.channel === 'news')).toHaveLength(1);
  });

  it('collapses the same post arriving from different upstream sources', async () => {
    await post(X_EVENT);
    await post({ ...X_EVENT, source: 'AnotherRelay' });
    await post({ ...X_EVENT, id: 'x:2058552301120360937' });
    await queue.drain();

    expect(sent.filter((s) => s.channel === 'news')).toHaveLength(1);
  });

  it('honours an explicit idempotency key', async () => {
    await post(X_EVENT, { idempotencyKey: 'upstream-42' });
    await queue.drain();
    const retry = await post(X_EVENT, { idempotencyKey: 'upstream-42' });
    expect(retry.status).toBe(200);
    expect(sent.filter((s) => s.channel === 'news')).toHaveLength(1);
  });
});

describe('burst', () => {
  it('absorbs 100 events without flooding Discord or dropping any', async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      ...X_EVENT,
      id: `x-90000000000000${String(i).padStart(3, '0')}`,
      url: `https://x.com/DeItaone/status/90000000000000${String(i).padStart(3, '0')}`,
      text: `FED OFFICIAL ${i} SAYS POLICY REMAINS RESTRICTIVE AS INFLATION COOLS`,
    }));

    const started = Date.now();
    const responses = await Promise.all(events.map((e) => post(e)));
    const elapsed = Date.now() - started;

    // The endpoint acknowledges without waiting for any processing.
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(elapsed).toBeLessThan(10_000);

    await queue.drain();

    const done = db.jobs.countsByStatus();
    expect((done.DONE ?? 0) + (done.FAILED ?? 0) + (done.FAILED_RETRIEVAL ?? 0)).toBe(100);
    expect(db.jobs.queueDepth()).toBe(0);
  });

  it('deduplicates within a burst of the same event', async () => {
    await Promise.all(Array.from({ length: 20 }, () => post(X_EVENT)));
    await queue.drain();
    expect(sent.filter((s) => s.channel === 'news')).toHaveLength(1);
  });
});

describe('metrics and health', () => {
  it('counts requests, rejections, accepts and duplicates', async () => {
    await post(X_EVENT);
    await post(X_EVENT);
    await post(X_EVENT, { token: 'wrong' });
    await post({ ...X_EVENT, text: '' });
    await queue.drain();

    const res = await fetch(`${baseUrl}/metrics`);
    const body = (await res.json()) as { webhook: Record<string, number | string> };

    expect(body.webhook.requestsTotal).toBe(4);
    expect(body.webhook.eventsAcceptedTotal).toBe(1);
    expect(body.webhook.duplicatesTotal).toBe(1);
    expect(body.webhook.rejectedTotal).toBe(2);
  });

  it('reports HEALTHY after an event and NO_RECENT_EVENTS before one', async () => {
    const before = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
      webhook: { state: string };
    };
    // Silence is not an outage for a push endpoint.
    expect(before.webhook.state).toBe('NO_RECENT_EVENTS');

    await post(X_EVENT);
    await queue.drain();

    const after = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
      webhook: { state: string; lastReceivedAt: string };
    };
    expect(after.webhook.state).toBe('HEALTHY');
    expect(after.webhook.lastReceivedAt).toBeTruthy();
  });

  it('does not make /ready fail when no webhook events have arrived', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
  });
});
