import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPostUrls, parsePostUrl, isAllowedAccount } from '../src/ingest/urls.js';
import { createJobQueue, BACKOFF_MS } from '../src/ingest/queue.js';
import { createUrlWorker, isFreshForTrading } from '../src/ingest/urlWorker.js';
import { createChainResolver, RetrievalError, type PostResolver } from '../src/ingest/resolver.js';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import type { RelayedMessage } from '../src/ingest/discordListener.js';
import type { RawPost } from '../src/core/types.js';

/** The 24/7 URL-ingestion layer and its named failure modes. */

setLogLevel('silent');
const log = createLogger('test');

// ─────────────────────────────────────────────────────────────────────────────
describe('URL detection', () => {
  it('normalises x.com and twitter.com to one id', () => {
    const a = parsePostUrl('https://x.com/DeItaone/status/2058552301120360937');
    const b = parsePostUrl('https://twitter.com/DeItaone/status/2058552301120360937');
    expect(a?.canonicalId).toBe('x:2058552301120360937');
    expect(b?.canonicalId).toBe(a?.canonicalId);
  });

  it('extracts platform, username and post id', () => {
    const parsed = parsePostUrl('https://x.com/DeItaone/status/2058552301120360937');
    expect(parsed).toMatchObject({
      platform: 'x',
      username: 'DeItaone',
      postId: '2058552301120360937',
      canonicalUrl: 'https://x.com/DeItaone/status/2058552301120360937',
    });
  });

  it('survives tracking parameters and media suffixes', () => {
    const ids = [
      'https://x.com/a/status/123456789?s=20&t=abc',
      'https://twitter.com/a/status/123456789/photo/1',
      'https://mobile.twitter.com/a/status/123456789',
      'https://www.x.com/a/status/123456789',
    ].map((u) => parsePostUrl(u)?.canonicalId);
    expect(new Set(ids)).toEqual(new Set(['x:123456789']));
  });

  it('finds several URLs in one message and dedupes within it', () => {
    const found = detectPostUrls(
      'see https://x.com/a/status/111 and https://x.com/b/status/222 and https://x.com/a/status/111',
    );
    expect(found.map((f) => f.canonicalId)).toEqual(['x:111', 'x:222']);
  });

  it('ignores malformed and unsupported URLs', () => {
    for (const url of [
      'https://x.com/DeItaone',
      'https://example.com/a/status/123',
      'https://x.com/a/status/abc',
      'not a url at all',
      '',
    ]) {
      expect(parsePostUrl(url), url).toBeNull();
    }
  });
});

describe('the account allowlist', () => {
  it('permits everything when unset', () => {
    expect(isAllowedAccount('anyone', [])).toBe(true);
  });

  it('restricts to the configured accounts, case-insensitively', () => {
    expect(isAllowedAccount('DeItaone', ['deltaone', 'deitaone'])).toBe(true);
    expect(isAllowedAccount('randomuser', ['deitaone'])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('freshness gate', () => {
  const now = '2026-08-09T18:00:00.000Z';

  it('accepts a recent post', () => {
    expect(isFreshForTrading('2026-08-09T17:50:00.000Z', 30, now).fresh).toBe(true);
  });

  it('rejects a stale post', () => {
    const result = isFreshForTrading('2026-08-09T10:00:00.000Z', 30, now);
    expect(result.fresh).toBe(false);
    expect(result.reason).toMatch(/limit 30m/);
  });

  it('rejects an unknown publication time rather than assuming it is now', () => {
    const result = isFreshForTrading(null, 30, now);
    expect(result.fresh).toBe(false);
    expect(result.reason).toBe('publication time unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the job queue', () => {
  let dir: string;
  let db: ScoutDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-queue-'));
    db = openDatabase(join(dir, 'q.db'));
    db.migrate();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeQueue = (handler: (job: { postId: string }) => Promise<void>, concurrency = 2) =>
    createJobQueue({
      db,
      logger: log,
      concurrency,
      maxAttempts: 4,
      handler: handler as never,
      pollIntervalMs: 5,
      backoffMs: [0, 5, 5, 5],
    });

  it('processes a queued job', async () => {
    const seen: string[] = [];
    const queue = makeQueue(async (job) => {
      seen.push(job.postId);
    });
    queue.enqueue({ postId: 'x:1', url: 'https://x.com/a/status/1', sourceChannel: 'c', sourceKind: 'news' });
    await queue.drain();
    expect(seen).toEqual(['x:1']);
  });

  it('accepts the same post id only once, however it arrives', () => {
    const queue = makeQueue(async () => {});
    const first = queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'a', sourceKind: 'news' });
    const sameChannel = queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'a', sourceKind: 'news' });
    const otherChannel = queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'b', sourceKind: 'news' });
    expect(first).toBeTruthy();
    expect(sameChannel).toBeNull();
    expect(otherChannel).toBeNull();
  });

  it('handles a burst without exceeding the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const queue = makeQueue(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    }, 3);

    for (let i = 0; i < 100; i++) {
      queue.enqueue({ postId: `x:${i}`, url: `u${i}`, sourceChannel: 'c', sourceKind: 'news' });
    }
    await queue.drain();

    expect(peak).toBeLessThanOrEqual(3);
    expect(db.jobs.countsByStatus().DONE).toBe(100);
  });

  it('retries a retriable failure and then gives up', async () => {
    let attempts = 0;
    const queue = makeQueue(async () => {
      attempts++;
      throw Object.assign(new Error('upstream hiccup'), { retriable: true });
    });
    queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'c', sourceKind: 'news' });
    await queue.drain();

    expect(attempts).toBe(4); // maxAttempts
    expect(db.jobs.byPostId('x:1')?.status).toBe('FAILED');
  });

  it('does not retry a non-retriable failure', async () => {
    let attempts = 0;
    const queue = makeQueue(async () => {
      attempts++;
      throw Object.assign(new Error('post deleted'), { retriable: false });
    });
    queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'c', sourceKind: 'news' });
    await queue.drain();

    expect(attempts).toBe(1);
    expect(db.jobs.byPostId('x:1')?.status).toBe('FAILED_RETRIEVAL');
  });

  it('uses the specified backoff schedule', () => {
    expect(BACKOFF_MS).toEqual([0, 1_000, 3_000, 10_000]);
  });

  it('recovers jobs a crashed process left RUNNING', async () => {
    const first = makeQueue(async () => {
      await new Promise(() => {}); // never resolves — simulates a hung worker
    });
    first.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'c', sourceKind: 'news' });
    first.start();
    await new Promise((r) => setTimeout(r, 30));
    first.stop();
    expect(db.jobs.byPostId('x:1')?.status).toBe('RUNNING');

    // A new process starts and takes ownership of the orphan.
    const seen: string[] = [];
    const second = makeQueue(async (job) => {
      seen.push(job.postId);
    });
    await second.drain();
    expect(seen).toEqual(['x:1']);
  });

  it('does not reprocess a post after a restart', async () => {
    const seen: string[] = [];
    const handler = async (job: { postId: string }): Promise<void> => {
      seen.push(job.postId);
    };

    const first = makeQueue(handler);
    first.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'c', sourceKind: 'news' });
    await first.drain();

    // Restart: same database, fresh queue object.
    const second = makeQueue(handler);
    expect(second.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'c', sourceKind: 'news' })).toBeNull();
    await second.drain();

    expect(seen).toEqual(['x:1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the resolver chain', () => {
  const url = parsePostUrl('https://x.com/DeItaone/status/123')!;

  const stub = (name: string, impl: () => Promise<never> | Promise<unknown>, available = true): PostResolver =>
    ({ name, available: () => available, resolve: impl } as PostResolver);

  it('falls through to the next provider', async () => {
    const chain = createChainResolver(
      [
        stub('first', async () => {
          throw new RetrievalError('nope', false);
        }),
        stub('second', async () => ({
          postId: url.canonicalId,
          author: null,
          authorHandle: '@DeItaone',
          text: 'resolved',
          publishedAt: null,
          canonicalUrl: url.canonicalUrl,
          media: [],
          retrievalSource: 'second',
        })),
      ],
      log,
    );
    await expect(chain.resolve(url)).resolves.toMatchObject({ text: 'resolved' });
  });

  it('skips an unavailable provider without counting it as a failure', async () => {
    const chain = createChainResolver(
      [
        stub('unconfigured', async () => {
          throw new Error('should not be called');
        }, false),
        stub('working', async () => ({
          postId: url.canonicalId,
          author: null,
          authorHandle: '@DeItaone',
          text: 'ok',
          publishedAt: null,
          canonicalUrl: url.canonicalUrl,
          media: [],
          retrievalSource: 'working',
        })),
      ],
      log,
    );
    await expect(chain.resolve(url)).resolves.toMatchObject({ text: 'ok' });
  });

  it('reports retriability when every provider fails', async () => {
    const chain = createChainResolver(
      [
        stub('a', async () => {
          throw new RetrievalError('rate limited', true);
        }),
      ],
      log,
    );
    await expect(chain.resolve(url)).rejects.toMatchObject({ retriable: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the URL worker', () => {
  let dir: string;
  let db: ScoutDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-worker-'));
    db = openDatabase(join(dir, 'w.db'));
    db.migrate();
    db.sources.upsertMany([
      {
        id: 'relay:discord-urls',
        name: 'Relayed X Posts',
        handle: null,
        url: null,
        sourceType: 'manual',
        category: 'MIXED',
        priority: 90,
        enabled: true,
        verified: false,
        qualityScore: 90,
        noiseScore: 10,
        macroScore: 85,
        microScore: 85,
        geopoliticalScore: 90,
        filterProfile: 'standard',
        official: false,
        notes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function build(resolved: Partial<{ text: string; publishedAt: string | null }> = {}) {
    const posts: RawPost[] = [];
    const resolver: PostResolver = {
      name: 'stub',
      available: () => true,
      resolve: async (u) => ({
        postId: u.canonicalId,
        author: 'Walter Bloomberg',
        authorHandle: '@DeItaone',
        text: resolved.text ?? 'FED CUTS RATES BY 25 BPS',
        publishedAt: resolved.publishedAt === undefined ? '2026-08-09T18:00:00.000Z' : resolved.publishedAt,
        canonicalUrl: u.canonicalUrl,
        media: [],
        retrievalSource: 'stub',
      }),
    };

    const queue = createJobQueue({
      db,
      logger: log,
      concurrency: 2,
      maxAttempts: 4,
      pollIntervalMs: 5,
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
        posts.push(post);
      },
    });

    return { queue, worker, posts };
  }

  const relayed = (channel = 'chan-1'): RelayedMessage => ({
    url: parsePostUrl('https://x.com/DeItaone/status/999')!,
    sourceChannelId: channel,
    sourceKind: 'news',
    receivedAt: '2026-08-09T18:05:00.000Z',
    rawMessage: 'FED CUTS RATES BY 25 BPS https://x.com/DeItaone/status/999',
  });

  it('resolves a URL into a pipeline post', async () => {
    const { queue, worker, posts } = build();
    worker.submit(relayed());
    await queue.drain();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      sourceId: 'relay:discord-urls',
      sourcePostId: 'x:999',
      text: 'FED CUTS RATES BY 25 BPS',
    });
    expect(db.posts.byId('x:999')?.publishedAt).toBe('2026-08-09T18:00:00.000Z');
  });

  it('produces one event when the same post arrives through several channels', async () => {
    const { queue, worker, posts } = build();
    worker.submit(relayed('chan-1'));
    worker.submit(relayed('chan-2'));
    worker.submit(relayed('chan-3'));
    await queue.drain();
    expect(posts).toHaveLength(1);
  });

  it('never substitutes the Discord receive time for an unknown publication time', async () => {
    const { queue, worker, posts } = build({ publishedAt: null });
    worker.submit(relayed());
    await queue.drain();

    expect(db.posts.byId('x:999')?.publishedAt).toBeNull();
    expect(posts[0]?.meta.publishedAtKnown).toBe(false);
    expect(posts[0]?.meta.publishedAt).toBeNull();
    // The receive time is still recorded — just not as the publication time.
    expect(db.posts.byId('x:999')?.discordReceivedAt).toBe('2026-08-09T18:05:00.000Z');
  });

  it('ignores an account that is not on the allowlist', async () => {
    const posts: RawPost[] = [];
    const queue = createJobQueue({
      db,
      logger: log,
      concurrency: 1,
      maxAttempts: 2,
      pollIntervalMs: 5,
      handler: async () => {},
    });
    const worker = createUrlWorker({
      db,
      queue,
      resolver: { name: 'x', available: () => true, resolve: async () => { throw new Error('unused'); } },
      logger: log,
      allowedAccounts: ['someoneelse'],
      relaySourceId: 'relay:discord-urls',
      onPost: async (p) => {
        posts.push(p);
      },
    });

    worker.submit(relayed());
    await queue.drain();
    expect(posts).toHaveLength(0);
    expect(db.jobs.byPostId('x:999')).toBeNull();
  });

  it('marks a permanently unresolvable post FAILED_RETRIEVAL rather than retrying forever', async () => {
    const queue = createJobQueue({
      db,
      logger: log,
      concurrency: 1,
      maxAttempts: 4,
      pollIntervalMs: 5,
      handler: async (job) => worker.handle(job),
    });
    const worker = createUrlWorker({
      db,
      queue,
      resolver: {
        name: 'stub',
        available: () => true,
        resolve: async () => {
          throw new RetrievalError('post not found or deleted', false);
        },
      },
      logger: log,
      allowedAccounts: [],
      relaySourceId: 'relay:discord-urls',
      onPost: async () => {},
    });

    worker.submit(relayed());
    await queue.drain();
    expect(db.jobs.byPostId('x:999')?.status).toBe('FAILED_RETRIEVAL');
  });
});

describe('a terminally failed post is not poisoned forever', () => {
  let dir2: string;
  let db2: ScoutDb;

  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'scout-retry-'));
    db2 = openDatabase(join(dir2, 'r.db'));
    db2.migrate();
  });

  afterEach(() => {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it('accepts the same post again after a terminal failure', async () => {
    let shouldFail = true;
    const seen: string[] = [];

    const queue = createJobQueue({
      db: db2,
      logger: log,
      concurrency: 1,
      maxAttempts: 2,
      pollIntervalMs: 5,
      backoffMs: [0, 5],
      handler: async (job) => {
        if (shouldFail) throw Object.assign(new Error('upstream down'), { retriable: false });
        seen.push(job.postId);
      },
    });

    expect(queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'a', sourceKind: 'news' })).toBeTruthy();
    await queue.drain();
    expect(db2.jobs.byPostId('x:1')?.status).toBe('FAILED_RETRIEVAL');

    // A brief upstream outage must not permanently blacklist the post — the
    // same URL relayed later deserves a fresh attempt.
    shouldFail = false;
    expect(queue.enqueue({ postId: 'x:1', url: 'u', sourceChannel: 'b', sourceKind: 'news' })).toBeTruthy();
    await queue.drain();

    expect(seen).toEqual(['x:1']);
    expect(db2.jobs.byPostId('x:1')?.status).toBe('DONE');
  });

  it('still refuses a post that already succeeded', async () => {
    const seen: string[] = [];
    const queue = createJobQueue({
      db: db2,
      logger: log,
      concurrency: 1,
      maxAttempts: 2,
      pollIntervalMs: 5,
      handler: async (job) => {
        seen.push(job.postId);
      },
    });

    queue.enqueue({ postId: 'x:2', url: 'u', sourceChannel: 'a', sourceKind: 'news' });
    await queue.drain();
    // The dedupe guarantee: a successfully processed post never runs twice.
    expect(queue.enqueue({ postId: 'x:2', url: 'u', sourceChannel: 'b', sourceKind: 'news' })).toBeNull();
    await queue.drain();
    expect(seen).toEqual(['x:2']);
  });
});
