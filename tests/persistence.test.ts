import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { pruneOldRows, DEFAULT_RETENTION } from '../src/db/retention.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { createPipeline } from '../src/pipeline/index.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import type { RawPost } from '../src/core/types.js';

/** Storage behaviour that only shows up over a long-running deployment. */

setLogLevel('silent');

let dir: string;
let db: ScoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-persist-'));
  db = openDatabase(join(dir, 'p.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe('metrics', () => {
  it('breaks totals down by category', () => {
    db.metrics.record('alerts_sent', 1, { sourceId: 'x:deltaone', category: 'FED' });
    db.metrics.record('alerts_sent', 1, { sourceId: 'x:deltaone', category: 'FED' });
    db.metrics.record('alerts_sent', 1, { sourceId: 'x:reuters', category: 'GEOPOLITICAL' });

    const summary = db.metrics.summary(iso(1));
    expect(summary.alerts_sent).toBe(3);
    // Without the per-category keys the pipeline report renders an empty
    // distribution while claiming to show one.
    expect(summary['alerts_sent:FED']).toBe(2);
    expect(summary['alerts_sent:GEOPOLITICAL']).toBe(1);
  });

  it('computes latency percentiles', () => {
    for (const ms of [100, 200, 300, 400, 5000]) {
      db.metrics.recordLatency({
        newsEventId: `ne-${ms}`,
        sourceId: 'x:deltaone',
        sourceToScoutMs: ms,
        scoutToDiscordMs: 10,
        totalMs: ms,
        recordedAt: new Date().toISOString(),
      });
    }
    const stats = db.metrics.latencyStats(iso(1));
    expect(stats.count).toBe(5);
    expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.avg / 2);
  });
});

describe('re-processing the same post', () => {
  it('is idempotent — replay does not duplicate rows or inflate counters', async () => {
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
      logger: createLogger('test'),
    });

    const post: RawPost = {
      sourceId: 'x:deltaone',
      sourcePostId: 'replay-1',
      originalUrl: null,
      author: '@DeItaone',
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
      eventTime: new Date().toISOString(),
      ingestionTime: new Date().toISOString(),
      meta: {},
    };

    const first = await pipeline.process(post);
    expect(first.accepted).toBe(true);

    // Same post again — the second pass must not throw on a constraint or
    // create a second row.
    const second = await pipeline.process(post);
    expect(second.newsEvent.id).toBe(first.newsEvent.id);

    const rows = db.raw
      .prepare('SELECT COUNT(*) AS n FROM news_events WHERE source_post_id = ?')
      .get('replay-1') as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('retention', () => {
  it('prunes aged rows and keeps recent ones', () => {
    const insertLatency = (recordedAt: string, id: string): void => {
      db.metrics.recordLatency({
        newsEventId: id,
        sourceId: 'x:deltaone',
        sourceToScoutMs: 10,
        scoutToDiscordMs: 10,
        totalMs: 20,
        recordedAt,
      });
    };
    insertLatency(iso(60), 'old');
    insertLatency(iso(1), 'recent');

    db.raw
      .prepare(
        `INSERT INTO processing_jobs (job_id, post_id, url, source_channel, source_kind,
           status, attempts, last_error, next_attempt_at, created_at, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('j-old', 'x:old', 'u', null, 'news', 'DONE', 1, null, null, iso(60), iso(60));

    const before = db.raw.prepare('SELECT COUNT(*) AS n FROM latency_samples').get() as { n: number };
    expect(before.n).toBe(2);

    const result = pruneOldRows(db, DEFAULT_RETENTION);

    const after = db.raw.prepare('SELECT COUNT(*) AS n FROM latency_samples').get() as { n: number };
    expect(after.n).toBe(1);
    expect(result.jobs).toBe(1);
  });

  it('never prunes the posts table, which is the durable repost guard', () => {
    db.posts.upsert({
      postId: 'x:1',
      author: 'a',
      authorHandle: '@a',
      text: 'old but processed',
      publishedAt: iso(400),
      canonicalUrl: 'https://x.com/a/status/1',
      media: [],
      retrievalSource: 'stub',
      discordReceivedAt: iso(400),
      createdAt: iso(400),
    });

    pruneOldRows(db, DEFAULT_RETENTION);

    // Losing this row would make Scout repost a year-old item as if new.
    expect(db.posts.exists('x:1')).toBe(true);
  });

  it('is safe to run repeatedly on an empty database', () => {
    expect(() => {
      pruneOldRows(db, DEFAULT_RETENTION);
      pruneOldRows(db, DEFAULT_RETENTION);
    }).not.toThrow();
  });
});

describe('deliveries', () => {
  it('records one row per destination and upserts on retry', () => {
    const entry = {
      eventId: 'ev-1',
      destination: 'tradingFloor',
      status: 'FAILED' as const,
      discordMessageId: null,
      sentAt: null,
      error: 'discord 500',
      createdAt: new Date().toISOString(),
    };
    db.deliveries.record(entry);
    db.deliveries.record({ ...entry, status: 'SENT', discordMessageId: 'm1', error: null });

    const rows = db.deliveries.forEvent('ev-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.discordMessageId).toBe('m1');
  });
});
