import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import {
  toSource,
  loadSourcesFile,
  loadTaxonomy,
  loadSecurityMaster,
} from '../src/config/loader.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import type { Source } from '../src/core/types.js';

setLogLevel('silent');

/**
 * Config is the source of truth in BOTH directions.
 *
 * `upsertMany` only writes rows that ARE in config, so deleting a source from
 * `sources.yaml` left it in the database — still enabled, still polled, still
 * failing. A Truth Social account removed from config went on to fail 147
 * consecutive polls against an endpoint nobody had configured for days, filling
 * the broken-feeds table with a fault that could not be fixed by editing
 * config, because editing config was what caused it.
 */

let dir: string;
let db: ScoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-retire-'));
  db = openDatabase(join(dir, 'test.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function source(id: string, enabled = true): Source {
  return toSource(
    {
      id,
      name: id,
      handle: `@${id}`,
      url: 'https://truthsocial.com',
      sourceType: 'truthsocial',
      category: 'GEOPOLITICAL',
      priority: 50,
      enabled,
      qualityScore: 70,
      noiseScore: 50,
    },
    new Date().toISOString(),
  );
}

describe('retiring sources dropped from config', () => {
  beforeEach(() => {
    db.sources.upsertMany([source('truth:trump'), source('truth:whitehouse')]);
  });

  it('disables one that is no longer configured', () => {
    const retired = db.sources.retireMissing(['truth:trump']);

    expect(retired).toEqual(['truth:whitehouse']);
    expect(db.sources.byId('truth:whitehouse')?.enabled).toBe(false);
  });

  it('stops it being polled, which is the entire point', () => {
    db.sources.retireMissing(['truth:trump']);

    const polled = db.sources.enabled().map((s) => s.id);
    expect(polled).toContain('truth:trump');
    expect(polled, 'a source deleted from config was still being polled').not.toContain(
      'truth:whitehouse',
    );
  });

  it('leaves the configured ones alone', () => {
    db.sources.retireMissing(['truth:trump']);
    expect(db.sources.byId('truth:trump')?.enabled).toBe(true);
  });

  it('reports nothing when config and database already agree', () => {
    expect(db.sources.retireMissing(['truth:trump', 'truth:whitehouse'])).toEqual([]);
  });

  /**
   * Disabled, never deleted: events reference their source, and the goal is to
   * stop polling rather than to erase what the source published.
   */
  it('keeps the row, so its history still resolves', () => {
    db.sources.retireMissing(['truth:trump']);
    expect(db.sources.byId('truth:whitehouse')).not.toBeNull();
  });

  it('re-enables it when config brings it back', () => {
    db.sources.retireMissing(['truth:trump']);
    expect(db.sources.byId('truth:whitehouse')?.enabled).toBe(false);

    // The next boot upserts config over the top, exactly as index.ts does.
    db.sources.upsertMany([source('truth:whitehouse')]);
    expect(db.sources.byId('truth:whitehouse')?.enabled).toBe(true);
  });

  it('does not resurrect a source config itself marked disabled', () => {
    db.sources.upsertMany([source('truth:foxnews', false)]);
    db.sources.retireMissing(['truth:trump', 'truth:foxnews']);

    expect(db.sources.byId('truth:foxnews')?.enabled).toBe(false);
  });
});

/**
 * Counting WHY events were dropped. With a two-minute freshness window the wire
 * is quiet on purpose, and without the reasons that is indistinguishable from
 * ingestion having broken.
 */
describe('counting rejections', () => {
  /** Drives the real pipeline, so the counts reflect what actually happens. */
  function pipelineOver(maxPublishAgeMinutes: number) {
    const securities = loadSecurityMaster();
    db.securities.upsertMany(securities);
    db.sources.upsertMany(
      loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())),
    );
    return createPipeline({
      db,
      taxonomy: loadTaxonomy(),
      securities,
      config: {
        minPublishScore: 60,
        minBreakingScore: 90,
        dedupeWindowMinutes: 90,
        clusterWindowMinutes: 240,
        dedupeSimilarity: 0.82,
        maxPublishAgeMinutes,
      },
      logger: createLogger('reject-test'),
    });
  }

  function post(text: string, minutesAgo: number) {
    const publishedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return {
      sourceId: 'rss:marketwatch-pulse',
      sourcePostId: `r:${text}:${minutesAgo}:${Math.random()}`,
      originalUrl: null,
      author: 'MarketWatch',
      text,
      eventTime: publishedAt,
      ingestionTime: new Date().toISOString(),
      meta: { publishedAt },
    };
  }

  const since = () => new Date(Date.now() - 3600_000).toISOString();

  it('counts a story declined by the freshness window', async () => {
    const pipeline = pipelineOver(2);
    await pipeline.process(post('US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED', 30));

    expect(db.newsEvents.countsByRejection(since()).NOISE_OLD_NEWS).toBe(1);
  });

  it('counts one declined for naming no company', async () => {
    const pipeline = pipelineOver(2);
    await pipeline.process(post('38-unit franchisee declares bankruptcy', 0));

    expect(db.newsEvents.countsByRejection(since()).NO_IDENTIFIED_SUBJECT).toBe(1);
  });

  it('separates the two, since they call for different fixes', async () => {
    const pipeline = pipelineOver(2);
    await pipeline.process(post('US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED', 30));
    await pipeline.process(post('38-unit franchisee declares bankruptcy', 0));

    const counts = db.newsEvents.countsByRejection(since());
    expect(counts.NOISE_OLD_NEWS).toBe(1);
    expect(counts.NO_IDENTIFIED_SUBJECT).toBe(1);
  });

  it('does not count what it published', async () => {
    const pipeline = pipelineOver(2);
    const outcome = await pipeline.process(post('US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED', 0));

    expect(outcome.accepted).toBe(true);
    expect(db.newsEvents.countsByRejection(since()).NOISE_OLD_NEWS).toBeUndefined();
  });
});
