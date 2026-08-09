import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createJobQueue, parseRelayPayload } from '../src/ingest/queue.js';
import { createUrlWorker } from '../src/ingest/urlWorker.js';
import { createRelayResolver, createChainResolver } from '../src/ingest/resolver.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { parsePostUrl } from '../src/ingest/urls.js';
import type { RelayedMessage } from '../src/ingest/discordListener.js';
import type { ChannelKey } from '../src/core/types.js';

/**
 * A restart must not lose an accepted news alert.
 *
 * A relayed post's content arrives exactly once, in a Discord message Scout
 * never sees again — the listener subscribes to new messages and does no
 * history scraping. When that content lived only in an in-memory map, a restart
 * left a persisted job row that could never be completed: the resolver chain
 * found nothing, failed non-retriably, and the news item was gone with a single
 * log line.
 *
 * These tests destroy the worker and the queue entirely between accepting a
 * post and processing it. Nothing in memory survives; only SQLite does.
 */

setLogLevel('silent');
const log = createLogger('relay-durability-test');

interface Sent {
  channel: ChannelKey;
  content: string;
}

let dir: string;
let db: ScoutDb;
let sent: Sent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-relay-durability-'));
  db = openDatabase(join(dir, 'r.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());
  sent = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One complete worker generation, wired the way src/index.ts wires it. Calling
 * this twice and discarding the first return value IS the restart: the second
 * generation shares nothing with the first except the database.
 */
function bootWorker(options: { failTimes?: number; maxAttempts?: number; backoffMs?: number[] } = {}) {
  let failuresRemaining = options.failTimes ?? 0;

  const resolver = createChainResolver(
    [
      // Reads the payload off the job row — the only copy that can exist once
      // the process that received the message is gone.
      createRelayResolver((url) => {
        if (failuresRemaining > 0) {
          failuresRemaining--;
          throw Object.assign(new Error('upstream rate limited'), { retriable: true });
        }
        const payload = parseRelayPayload(db.jobs.relayPayload(url.canonicalId));
        return payload ? { rawMessage: payload.rawMessage } : null;
      }),
    ],
    log,
  );

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
    db,
    logger: log,
    rawChannelEnabled: false,
    discord: {
      async start() {},
      async stop() {},
      isReady: () => true,
      async send(channel: ChannelKey, content: string) {
        sent.push({ channel, content });
        return `msg-${sent.length}`;
      },
      async edit() {},
      channelId: () => 'chan',
    } as never,
  });

  const queue = createJobQueue({
    db,
    logger: log,
    concurrency: 2,
    maxAttempts: options.maxAttempts ?? 4,
    pollIntervalMs: 5,
    backoffMs: options.backoffMs ?? [0, 5, 5, 5],
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
      if (outcome.accepted) await publisher.publish(outcome);
    },
  });

  return { queue, worker };
}

const relayedMessage = (): RelayedMessage => ({
  url: parsePostUrl('https://x.com/DeItaone/status/1750000000000000001')!,
  sourceChannelId: 'chan-1',
  sourceKind: 'news',
  receivedAt: new Date().toISOString(),
  rawMessage:
    'Macro Alert (@DeItaone):\n\nFED CUTS RATES BY 50 BPS IN EMERGENCY MEETING\n\n' +
    'The Federal Reserve lowered its benchmark rate by half a point at an ' +
    'unscheduled meeting, citing a sharp deterioration in credit conditions.',
});

const POST_ID = 'x:1750000000000000001';

describe('accepting a relayed post', () => {
  it('persists the payload with the job, not beside it', () => {
    const first = bootWorker();
    first.worker.submit(relayedMessage());

    const job = db.jobs.byPostId(POST_ID);
    expect(job).not.toBeNull();
    expect(job?.status).toBe('QUEUED');

    // The content is on the row the moment the job exists.
    const payload = parseRelayPayload(job?.relayPayload ?? null);
    expect(payload?.rawMessage).toContain('FED CUTS RATES BY 50 BPS');
    // And the receive time travels with it, so it is not lost to a restart.
    expect(payload?.receivedAt).toBeTruthy();
  });
});

describe('a restart between accepting and processing', () => {
  it('processes the recovered job and publishes the alert exactly once', async () => {
    // Generation 1 accepts the post and is then destroyed without draining.
    const first = bootWorker();
    first.worker.submit(relayedMessage());
    first.queue.stop();

    expect(sent).toHaveLength(0);
    expect(db.jobs.byPostId(POST_ID)?.status).toBe('QUEUED');

    // Generation 2 shares nothing with generation 1 but the database file.
    const second = bootWorker();
    await second.queue.drain();

    // The alert reached the channels a Fed emergency cut must reach.
    const channels = sent.map((s) => s.channel).sort();
    expect(channels).toEqual(['news', 'spx', 'tradingFloor']);

    // Exactly once — no duplicate from the recovery.
    expect(sent).toHaveLength(3);
    expect(new Set(channels).size).toBe(3);

    // And the content survived intact, in the austere format.
    expect(sent[0]?.content).toContain('FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING');
  });

  it('does not republish when the worker restarts again afterwards', async () => {
    const first = bootWorker();
    first.worker.submit(relayedMessage());
    first.queue.stop();

    const second = bootWorker();
    await second.queue.drain();
    const afterRecovery = sent.length;
    second.queue.stop();

    // A third generation, and the same message relayed again for good measure.
    const third = bootWorker();
    third.worker.submit(relayedMessage());
    await third.queue.drain();

    // Dedupe still holds: db.posts.exists short-circuits the resubmission and
    // the completed job is not reopened.
    expect(sent).toHaveLength(afterRecovery);
  });

  it('recovers a job the previous process died in the middle of', async () => {
    const first = bootWorker();
    first.worker.submit(relayedMessage());
    // Exactly what a crash mid-job leaves behind.
    db.jobs.markRunning(`job-${POST_ID}`, new Date().toISOString());
    first.queue.stop();

    expect(db.jobs.byPostId(POST_ID)?.status).toBe('RUNNING');

    const second = bootWorker();
    await second.queue.drain();

    expect(db.jobs.byPostId(POST_ID)?.status).toBe('DONE');
    expect(sent.map((s) => s.channel).sort()).toEqual(['news', 'spx', 'tradingFloor']);
  });
});

describe('a restart during a retryable failure', () => {
  it('keeps the payload through the failure and completes after the restart', async () => {
    // Generation 1: the resolver fails retriably, so the job goes back to
    // QUEUED with its attempts incremented. maxAttempts is set high enough
    // that it cannot reach a terminal state inside this window — the point is
    // to catch it mid-retry, which is what a deploy actually interrupts.
    const first = bootWorker({ failTimes: 99, maxAttempts: 50, backoffMs: [0, 20, 20, 20] });
    first.worker.submit(relayedMessage());
    first.queue.start();
    for (let i = 0; i < 200 && (db.jobs.byPostId(POST_ID)?.attempts ?? 0) === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    first.queue.stop();

    const midFlight = db.jobs.byPostId(POST_ID);
    expect(midFlight?.attempts ?? 0).toBeGreaterThan(0);
    expect(midFlight?.status).toBe('QUEUED');
    // The payload is retained precisely because the job may still run.
    expect(parseRelayPayload(midFlight?.relayPayload ?? null)?.rawMessage).toContain(
      'FED CUTS RATES BY 50 BPS',
    );

    // Generation 2 has a healthy resolver and finishes the job.
    const second = bootWorker();
    await second.queue.drain();

    expect(db.jobs.byPostId(POST_ID)?.status).toBe('DONE');
    expect(sent.map((s) => s.channel).sort()).toEqual(['news', 'spx', 'tradingFloor']);
  });

  it('retains the payload on a job that failed terminally', async () => {
    // maxAttempts exhausted: the job ends FAILED, and a later relay of the same
    // post reopens it — which only works if the content is still there.
    const first = bootWorker({ failTimes: 99 });
    first.worker.submit(relayedMessage());
    await first.queue.drain();
    first.queue.stop();

    const failed = db.jobs.byPostId(POST_ID);
    expect(failed?.status).toBe('FAILED');
    expect(parseRelayPayload(failed?.relayPayload ?? null)?.rawMessage).toContain(
      'FED CUTS RATES BY 50 BPS',
    );

    // Reopened by a healthy generation, it completes from the retained payload.
    const second = bootWorker();
    second.worker.submit(relayedMessage());
    await second.queue.drain();

    expect(db.jobs.byPostId(POST_ID)?.status).toBe('DONE');
    expect(sent.map((s) => s.channel).sort()).toEqual(['news', 'spx', 'tradingFloor']);
  });
});

describe('releasing the payload', () => {
  it('clears it only after the job completes successfully', async () => {
    const boot = bootWorker();
    boot.worker.submit(relayedMessage());

    // Present while queued.
    expect(db.jobs.byPostId(POST_ID)?.relayPayload).not.toBeNull();

    await boot.queue.drain();

    // Gone once the job is DONE, and not a moment before.
    const done = db.jobs.byPostId(POST_ID);
    expect(done?.status).toBe('DONE');
    expect(done?.relayPayload).toBeNull();
  });

  it('does not clear it on a failure', async () => {
    const boot = bootWorker({ failTimes: 99 });
    boot.worker.submit(relayedMessage());
    await boot.queue.drain();

    const job = db.jobs.byPostId(POST_ID);
    expect(job?.status).toBe('FAILED');
    expect(job?.relayPayload).not.toBeNull();
  });
});

describe('correctness does not depend on process memory', () => {
  it('a worker that never saw the message still completes the job', async () => {
    // Insert the job exactly as submit() does, then process it from a worker
    // generation that has never seen a RelayedMessage at all.
    const first = bootWorker();
    first.worker.submit(relayedMessage());
    first.queue.stop();

    const second = bootWorker();
    // No submit() call on this generation — only drain.
    await second.queue.drain();

    expect(db.posts.byId(POST_ID)?.text).toContain('FED CUTS RATES BY 50 BPS');
    expect(sent.length).toBeGreaterThan(0);
  });

  it('fails the job rather than inventing content when the payload is missing', async () => {
    // A job row with no payload — e.g. one written by an older build.
    const boot = bootWorker();
    boot.worker.submit(relayedMessage());
    db.raw
      .prepare('UPDATE processing_jobs SET relay_payload = NULL WHERE post_id = ?')
      .run(POST_ID);

    await boot.queue.drain();

    // No alert, no fabricated post — a visible failure instead.
    expect(sent).toHaveLength(0);
    expect(db.posts.byId(POST_ID)).toBeNull();
    expect(db.jobs.byPostId(POST_ID)?.status).toBe('FAILED_RETRIEVAL');
  });
});

describe('the publication-time rule survives all of this', () => {
  it('never substitutes the Discord receive time for publication time', async () => {
    const first = bootWorker();
    first.worker.submit(relayedMessage());
    first.queue.stop();

    const second = bootWorker();
    await second.queue.drain();

    const stored = db.posts.byId(POST_ID);
    // The relay message stated no publication time, so there is none — the
    // receive time is recorded separately and is never promoted.
    expect(stored?.publishedAt).toBeNull();
    expect(stored?.discordReceivedAt).toBeTruthy();
  });
});
