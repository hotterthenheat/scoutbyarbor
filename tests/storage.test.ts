import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import {
  databaseExistsAt,
  recordBoot,
  storageStatus,
  formatStorageLine,
} from '../src/db/storage.js';
import { setLogLevel, sanitize } from '../src/util/logger.js';

/**
 * The persistent-disk check.
 *
 * Scout keeps every piece of durable state in one SQLite file. On Render that
 * file has to live on a mounted disk; if it does not, each deploy silently
 * resets dedupe history, the delivery log and the calendar-fired keys, and
 * Scout reposts old headlines into the trading channels as breaking news while
 * looking perfectly healthy.
 *
 * Configuration cannot prove the disk is attached — only surviving a restart
 * can. These tests cover that proof.
 */

setLogLevel('silent');

let dir: string;
let path: string;
let db: ScoutDb;

const NOW = '2026-08-09T14:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-storage-'));
  path = join(dir, 'scout.db');
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed by the test */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Stands in for a process restart against the same file. */
function boot(env: NodeJS.ProcessEnv = {}, nowIso = NOW) {
  const existedAtBoot = databaseExistsAt(path);
  db = openDatabase(path);
  db.migrate();
  return recordBoot(db, { databasePath: path, existedAtBoot, nowIso, env });
}

describe('boot counter', () => {
  it('reports UNPROVEN on a brand new database', () => {
    const report = boot();

    expect(report.boots).toBe(1);
    expect(report.existedAtBoot).toBe(false);
    // Nothing has been proven either way yet — one boot is not evidence.
    expect(report.durability).toBe('UNPROVEN');
  });

  it('proves persistence once the file outlives a process', () => {
    const first = boot();
    db.close();

    const second = boot({}, '2026-08-09T15:00:00.000Z');

    expect(first.durability).toBe('UNPROVEN');
    expect(second.boots).toBe(2);
    expect(second.existedAtBoot).toBe(true);
    expect(second.durability).toBe('PERSISTENT');
    // The first boot's timestamp survives, which is what makes it evidence.
    expect(second.firstBootAt).toBe(NOW);
    expect(second.lastBootAt).toBe(NOW);
  });

  it('keeps counting across many restarts', () => {
    for (let i = 0; i < 5; i++) {
      const report = boot({}, `2026-08-09T1${i}:00:00.000Z`);
      expect(report.boots).toBe(i + 1);
      db.close();
    }

    db = openDatabase(path);
    expect(storageStatus(db, path).boots).toBe(5);
  });

  it('resets to 1 when the file is lost — the ephemeral-disk signature', () => {
    boot();
    db.close();

    // Exactly what a deploy onto ephemeral storage does.
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });

    const afterWipe = boot({ RENDER: 'true' });

    expect(afterWipe.boots).toBe(1);
    expect(afterWipe.durability).toBe('UNPROVEN');
    expect(afterWipe.warnings.join(' ')).toMatch(/persistent disk is NOT attached/i);
  });
});

describe('path warnings', () => {
  it('says nothing about a relative path outside Render', () => {
    const existed = databaseExistsAt(path);
    db = openDatabase(path);
    db.migrate();

    // Local development legitimately uses ./data/scout.db.
    const report = recordBoot(db, {
      databasePath: './data/scout.db',
      existedAtBoot: existed,
      nowIso: NOW,
      env: {},
    });

    expect(report.warnings).toEqual([]);
  });

  it('flags a relative path on Render', () => {
    db = openDatabase(path);
    db.migrate();

    const report = recordBoot(db, {
      databasePath: './data/scout.db',
      existedAtBoot: false,
      nowIso: NOW,
      env: { RENDER: 'true' },
    });

    expect(report.warnings.join(' ')).toMatch(/relative/i);
    expect(report.warnings.join(' ')).toMatch(/\/var\/data\/scout\.db/);
  });

  it('flags the deploy directory, which Render replaces every deploy', () => {
    db = openDatabase(path);
    db.migrate();

    const report = recordBoot(db, {
      databasePath: '/opt/render/project/src/data/scout.db',
      existedAtBoot: false,
      nowIso: NOW,
      env: { RENDER: 'true' },
    });

    expect(report.warnings.join(' ')).toMatch(/deploy directory/i);
  });

  it('flags temporary storage', () => {
    db = openDatabase(path);
    db.migrate();

    const report = recordBoot(db, {
      databasePath: '/tmp/scout.db',
      existedAtBoot: false,
      nowIso: NOW,
      env: { RENDER: 'true' },
    });

    expect(report.warnings.join(' ')).toMatch(/temporary storage/i);
  });

  it('accepts a path under the disk mount without complaint', () => {
    db = openDatabase(path);
    db.migrate();
    // A first boot always prompts the operator to confirm the disk, so this
    // has to be the second — the steady state a healthy deployment sits in.
    recordBoot(db, {
      databasePath: '/var/data/scout.db',
      existedAtBoot: false,
      nowIso: NOW,
      env: { RENDER: 'true' },
    });

    const report = recordBoot(db, {
      databasePath: '/var/data/scout.db',
      existedAtBoot: true,
      nowIso: '2026-08-09T18:00:00.000Z',
      env: { RENDER: 'true' },
    });

    expect(report.durability).toBe('PERSISTENT');
    expect(report.warnings).toEqual([]);
  });

  it('flags an in-memory database as retaining nothing', () => {
    db = openDatabase(':memory:');
    db.migrate();

    const report = recordBoot(db, {
      databasePath: ':memory:',
      existedAtBoot: false,
      nowIso: NOW,
      env: { RENDER: 'true' },
    });

    expect(report.warnings.join(' ')).toMatch(/in memory/i);
  });
});

describe('retained state', () => {
  it('counts exactly the state whose loss would change behaviour', () => {
    boot();

    db.posts.upsert({
      postId: 'x:1',
      author: 'Relay',
      authorHandle: '@DeItaone',
      text: 'headline',
      publishedAt: NOW,
      canonicalUrl: 'https://x.com/i/status/1',
      media: [],
      retrievalSource: 'webhook',
      platform: 'x',
      upstreamSource: 'relay',
      receivedAt: NOW,
      discordReceivedAt: null,
      createdAt: NOW,
    });
    db.deliveries.record({
      eventId: 'evt-1',
      destination: 'sprout',
      status: 'FAILED',
      discordMessageId: null,
      sentAt: null,
      error: 'connection reset',
      createdAt: NOW,
    });
    db.raw
      .prepare('INSERT INTO calendar_fired (key, fired_at) VALUES (?,?)')
      .run('cpi:60', NOW);

    const status = storageStatus(db, path);

    expect(status.retained.posts).toBe(1);
    expect(status.retained.deliveries).toBe(1);
    expect(status.retained.calendarFired).toBe(1);
  });

  it('survives a reopen — the whole point', () => {
    boot();
    db.deliveries.record({
      eventId: 'evt-1',
      destination: 'sprout',
      status: 'FAILED',
      discordMessageId: null,
      sentAt: null,
      error: 'connection reset',
      createdAt: NOW,
    });
    db.close();

    const second = boot({}, '2026-08-09T16:00:00.000Z');

    expect(second.durability).toBe('PERSISTENT');
    expect(second.retained.deliveries).toBe(1);
  });
});

describe('storageStatus', () => {
  it('reads without incrementing, so /metrics cannot inflate the count', () => {
    boot();

    storageStatus(db, path);
    storageStatus(db, path);
    const third = storageStatus(db, path);

    expect(third.boots).toBe(1);
  });
});

describe('databaseExistsAt', () => {
  it('is false before the file is created and true after', () => {
    expect(databaseExistsAt(path)).toBe(false);

    db = openDatabase(path);
    db.migrate();

    expect(existsSync(path)).toBe(true);
    expect(databaseExistsAt(path)).toBe(true);
  });

  it('treats an in-memory database as non-existent rather than throwing', () => {
    expect(databaseExistsAt(':memory:')).toBe(false);
  });
});

describe('formatStorageLine', () => {
  it('tells an operator exactly what to do when nothing is proven yet', () => {
    const line = formatStorageLine(boot());
    expect(line).toMatch(/UNPROVEN/);
    expect(line).toMatch(/redeploy once/i);
  });

  it('states the proof once it exists', () => {
    boot();
    db.close();
    const line = formatStorageLine(boot({}, '2026-08-09T17:00:00.000Z'));

    expect(line).toMatch(/PERSISTENT \(boot #2/);
  });
});

/**
 * The spec is explicit: never log the webhook token, upstream credentials,
 * cookies or authentication headers. A top-level-only check is not enough,
 * because a secret reaches a log line by riding inside a config object.
 */
describe('log redaction', () => {
  it('redacts a secret nested inside another object', () => {
    const out = sanitize({ admin: { token: 'super-secret', replay: 'enabled' } }) as {
      admin: { token: string; replay: string };
    };

    expect(out.admin.token).toBe('[redacted]');
    expect(out.admin.replay).toBe('enabled');
  });

  it('redacts every secret-shaped key name', () => {
    const out = sanitize({
      bearerToken: 'a',
      apiKey: 'b',
      api_key: 'c',
      authorization: 'd',
      password: 'e',
      cookie: 'f',
      credential: 'g',
    }) as Record<string, string>;

    for (const value of Object.values(out)) expect(value).toBe('[redacted]');
  });

  it('redacts inside arrays', () => {
    const out = sanitize([{ token: 'x' }, { safe: 'y' }]) as Array<Record<string, string>>;

    expect(out[0]?.token).toBe('[redacted]');
    expect(out[1]?.safe).toBe('y');
  });

  it('leaves ordinary fields alone', () => {
    const out = sanitize({ sourceId: 'x:deltaone', importance: 91, fresh: true });

    expect(out).toEqual({ sourceId: 'x:deltaone', importance: 91, fresh: true });
  });

  it('does not hang on a circular object', () => {
    const cyclic: Record<string, unknown> = { name: 'scout' };
    cyclic.self = cyclic;

    expect(sanitize(cyclic)).toEqual({ name: 'scout', self: '[circular]' });
  });

  it('flattens values JSON.stringify would reject', () => {
    const out = sanitize({ big: 10n, fn: () => 1 }) as Record<string, string>;

    expect(out.big).toBe('10');
    expect(out.fn).toBe('[fn]');
  });

  it('reduces an Error to name and message, never a stack with paths', () => {
    expect(sanitize(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });
});
