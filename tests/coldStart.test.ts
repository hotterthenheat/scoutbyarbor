import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPrimer } from '../src/ingest/priming.js';
import { createIngestManager } from '../src/ingest/manager.js';
import { storageStatus, recordBoot } from '../src/db/storage.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import type { IngestAdapter, RawPost } from '../src/core/types.js';

/**
 * The first boot.
 *
 * A feed reader knows what is new by remembering what it has seen. On the very
 * first poll it has seen nothing, so every item in every feed reads as new —
 * and Scout would classify, score, route and publish all of them at once.
 * Twenty feeds of twenty items is four hundred alerts, and whichever of them
 * read as market-moving go to the trading channels.
 *
 * That is not a hypothetical. It is what happens on the first successful
 * deploy of a correctly configured service, and again on every deploy if the
 * database is not on a disk.
 */

setLogLevel('silent');
const log = createLogger('cold-start-test');

let dir: string;
let db: ScoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-cold-'));
  db = openDatabase(join(dir, 'c.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function post(sourceId: string): RawPost {
  const at = new Date().toISOString();
  return {
    sourceId,
    sourcePostId: `${sourceId}:${++seq}`,
    originalUrl: null,
    author: null,
    text: 'US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED',
    eventTime: at,
    ingestionTime: at,
    meta: { publishedAt: at },
  };
}

describe('priming a source', () => {
  it('withholds the whole first batch and publishes the second', () => {
    const primer = createPrimer(db, () => new Date().toISOString());

    const first = primer.partition([post('rss:fed'), post('rss:fed'), post('rss:bls')]);
    expect(first.publish, 'a first poll published its backlog').toHaveLength(0);
    expect(first.withheld).toHaveLength(3);

    const second = primer.partition([post('rss:fed'), post('rss:bls')]);
    expect(second.publish, 'a primed source stopped publishing').toHaveLength(2);
    expect(second.withheld).toHaveLength(0);
  });

  it('primes each source separately', () => {
    const primer = createPrimer(db, () => new Date().toISOString());
    primer.partition([post('rss:fed')]);

    // A source added to the config next month must be primed on ITS first
    // poll, not treated as primed because its neighbours are.
    const mixed = primer.partition([post('rss:fed'), post('rss:newly-added')]);
    expect(mixed.publish.map((p) => p.sourceId)).toEqual(['rss:fed']);
    expect(mixed.withheld.map((p) => p.sourceId)).toEqual(['rss:newly-added']);
  });

  it('does not re-prime across a restart', () => {
    const path = join(dir, 'restart.db');
    const first = openDatabase(path);
    first.migrate();
    createPrimer(first, () => new Date().toISOString()).partition([post('rss:fed')]);
    first.close();

    // The flag lives in the database, so a redeploy must not discard a real
    // backlog by priming a source that has been running for weeks.
    const second = openDatabase(path);
    const primer = createPrimer(second, () => new Date().toISOString());
    expect(primer.isPrimed('rss:fed')).toBe(true);
    expect(primer.partition([post('rss:fed')]).publish).toHaveLength(1);
    second.close();
  });

  it('decides the whole batch by the state at its start', () => {
    // Deciding item by item would let the first post mark the source primed and
    // the second post then publish — the exact bug this ordering prevents.
    const primer = createPrimer(db, () => new Date().toISOString());
    const batch = primer.partition([post('rss:fed'), post('rss:fed'), post('rss:fed')]);
    expect(batch.publish).toHaveLength(0);
  });
});

describe('the ingest manager on a cold database', () => {
  function adapterYielding(posts: RawPost[]): IngestAdapter {
    return {
      type: 'rss',
      async poll() {
        return { posts, outcomes: [] };
      },
      async verify() {
        return [];
      },
    } as unknown as IngestAdapter;
  }

  it('records the backlog but publishes none of it', async () => {
    db.sources.upsertMany([
      {
        id: 'rss:fed',
        name: 'Fed',
        handle: null,
        url: 'https://example.invalid/feed',
        sourceType: 'rss',
        category: 'MACRO',
        priority: 90,
        enabled: true,
        verified: true,
        qualityScore: 90,
        noiseScore: 10,
        macroScore: 90,
        microScore: 20,
        geopoliticalScore: 20,
        filterProfile: 'standard',
        official: true,
        org: 'fed',
        expectedIntervalMs: 900_000,
        notes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const published: RawPost[] = [];
    const backlog = [post('rss:fed'), post('rss:fed'), post('rss:fed')];

    const manager = createIngestManager({
      db,
      adapters: [adapterYielding(backlog)],
      logger: log,
      intervals: { rss: 3_600_000 },
      onPosts: async (posts) => {
        published.push(...posts);
      },
    });

    await manager.pollOnce();
    expect(published, 'the first poll published its backlog').toHaveLength(0);

    // Recorded all the same, so the same items never publish later either.
    const stored = db.raw.prepare('SELECT COUNT(*) c FROM raw_posts').get() as { c: number };
    expect(stored.c).toBe(3);

    // Second poll: genuinely new item, genuinely published.
    const fresh = post('rss:fed');
    const manager2 = createIngestManager({
      db,
      adapters: [adapterYielding([fresh])],
      logger: log,
      intervals: { rss: 3_600_000 },
      onPosts: async (posts) => {
        published.push(...posts);
      },
    });
    await manager2.pollOnce();
    expect(published.map((p) => p.sourcePostId)).toEqual([fresh.sourcePostId]);
  });
});

/**
 * Render will not attach a disk until a service has deployed successfully,
 * which makes the disk guard a genuine chicken-and-egg on a first deploy. The
 * override exists for that, and is designed to be impossible to leave in place
 * quietly.
 */
describe('the ephemeral-storage override', () => {
  const missing = () => join(dir, 'no-such-mount', 'scout.db');

  it('refuses to boot on Render when the disk is absent', () => {
    expect(() => openDatabase(missing(), { env: { RENDER: 'true' } })).toThrow(
      /disk is not attached/,
    );
  });

  it('names the way out, so the error is actionable rather than a wall', () => {
    expect(() => openDatabase(missing(), { env: { RENDER: 'true' } })).toThrow(
      /ALLOW_EPHEMERAL_DATABASE=true/,
    );
  });

  it('boots when the override is set explicitly', () => {
    const path = missing();
    const opened = openDatabase(path, {
      env: { RENDER: 'true', ALLOW_EPHEMERAL_DATABASE: 'true' },
    });
    opened.migrate();
    expect(existsSync(path)).toBe(true);
    opened.close();
  });

  it('complains on EVERY boot while the override is in place', () => {
    const path = missing();
    const env = { RENDER: 'true', ALLOW_EPHEMERAL_DATABASE: 'true' };
    const opened = openDatabase(path, { env });
    opened.migrate();

    for (const boot of [1, 2, 3]) {
      const report = recordBoot(opened, {
        databasePath: path,
        existedAtBoot: boot > 1,
        nowIso: new Date().toISOString(),
        env,
      });
      expect(
        report.warnings.join(' '),
        `boot ${boot} did not warn about ephemeral storage`,
      ).toMatch(/ALLOW_EPHEMERAL_DATABASE is set/);
    }

    opened.close();
  });

  it('says nothing once the override is removed', () => {
    const path = join(dir, 'real.db');
    const env = { RENDER: 'true' };
    const opened = openDatabase(path, { env });
    opened.migrate();

    const report = recordBoot(opened, {
      databasePath: path,
      existedAtBoot: true,
      nowIso: new Date().toISOString(),
      env,
    });
    expect(report.warnings.join(' ')).not.toMatch(/ALLOW_EPHEMERAL_DATABASE/);

    // And /metrics reports the durability an operator checks after a redeploy.
    expect(storageStatus(opened, path).durability).toBe('UNPROVEN');
    opened.close();
  });
});
