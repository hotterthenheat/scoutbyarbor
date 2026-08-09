import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import {
  parseSchema,
  stripSqlComments,
  applyAdditiveMigrations,
} from '../src/db/migrations.js';
import { setLogLevel } from '../src/util/logger.js';

/**
 * Upgrading a database that already exists.
 *
 * The persistent disk means the database outlives the code, so every schema
 * change lands on a file with rows already in it. `CREATE TABLE IF NOT EXISTS`
 * cannot do that — it skips the table wholesale — and an index in the same
 * file that references a new column throws `no such column`, killing Scout on
 * boot. These tests cover the in-place upgrade.
 */

setLogLevel('silent');

let dir: string;
let path: string;
let db: ScoutDb | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-migrate-'));
  path = join(dir, 'scout.db');
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* closed by the test */
  }
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

/** `deliveries` exactly as it was before the replay-claim columns existed. */
function seedPreClaimDatabase(): void {
  const old = new Database(path);
  old.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           TEXT NOT NULL,
    destination        TEXT NOT NULL,
    status             TEXT NOT NULL,
    discord_message_id TEXT,
    sent_at            TEXT,
    error              TEXT,
    created_at         TEXT NOT NULL,
    UNIQUE (event_id, destination)
  );`);
  old
    .prepare(
      `INSERT INTO deliveries (event_id, destination, status, created_at)
       VALUES ('evt-1', 'sprout', 'FAILED', '2026-08-09T10:00:00.000Z')`,
    )
    .run();
  old.close();
}

describe('upgrading a database that predates a schema change', () => {
  it('boots instead of throwing "no such column"', () => {
    seedPreClaimDatabase();

    db = openDatabase(path);
    expect(() => db?.migrate()).not.toThrow();
  });

  it('adds the missing columns to the existing table', () => {
    seedPreClaimDatabase();

    db = openDatabase(path);
    db.migrate();

    const columns = (db.raw.prepare('PRAGMA table_info(deliveries)').all() as Array<{
      name: string;
    }>).map((c) => c.name);

    expect(columns).toContain('claimed_at');
    expect(columns).toContain('claimed_by');
  });

  it('keeps the rows that were already there', () => {
    seedPreClaimDatabase();

    db = openDatabase(path);
    db.migrate();

    // The whole reason for the disk: existing delivery history survives.
    const claimed = db.deliveries.claimForReplay(
      { destination: 'sprout', status: 'FAILED', limit: 10 },
      'test-run',
      '2026-08-09T09:00:00.000Z',
      '2026-08-09T11:00:00.000Z',
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.eventId).toBe('evt-1');
  });

  it('is idempotent — a second migrate changes nothing', () => {
    seedPreClaimDatabase();

    db = openDatabase(path);
    db.migrate();
    const before = db.raw.prepare('PRAGMA table_info(deliveries)').all().length;

    db.migrate();
    db.migrate();

    expect(db.raw.prepare('PRAGMA table_info(deliveries)').all()).toHaveLength(before);
  });

  it('leaves a database that is already current untouched', () => {
    db = openDatabase(path);
    db.migrate();

    const result = applyAdditiveMigrations(db.raw, '');
    expect(result.added).toEqual([]);
  });
});

describe('migration planning', () => {
  it('does not touch a table that does not exist yet', () => {
    db = openDatabase(path);

    // Nothing has been created, so CREATE TABLE IF NOT EXISTS will do it all.
    const result = applyAdditiveMigrations(
      db.raw,
      'CREATE TABLE IF NOT EXISTS brand_new (id TEXT PRIMARY KEY, extra TEXT);',
    );

    expect(result.added).toEqual([]);
  });

  it('refuses columns SQLite cannot add to an existing table', () => {
    db = openDatabase(path);
    db.raw.exec('CREATE TABLE t (id TEXT);');

    const result = applyAdditiveMigrations(
      db.raw,
      `CREATE TABLE IF NOT EXISTS t (
         id      TEXT,
         uniq    TEXT UNIQUE,
         needed  TEXT NOT NULL,
         fine    TEXT NOT NULL DEFAULT 'x'
       );`,
    );

    expect(result.added.map((a) => a.column)).toEqual(['fine']);
    const skipped = Object.fromEntries(result.skipped.map((s) => [s.column, s.reason]));
    expect(skipped.uniq).toMatch(/UNIQUE/);
    // NOT NULL with no default cannot be added to a table that has rows.
    expect(skipped.needed).toMatch(/NOT NULL/);
  });

  it('adds a column carrying a default, preserving existing rows', () => {
    db = openDatabase(path);
    db.raw.exec('CREATE TABLE t (id TEXT);');
    db.raw.prepare("INSERT INTO t (id) VALUES ('a')").run();

    applyAdditiveMigrations(
      db.raw,
      `CREATE TABLE IF NOT EXISTS t (id TEXT, tier INTEGER NOT NULL DEFAULT 7);`,
    );

    const row = db.raw.prepare('SELECT id, tier FROM t').get() as { id: string; tier: number };
    expect(row).toEqual({ id: 'a', tier: 7 });
  });
});

describe('schema parsing', () => {
  it('reads the real schema.sql without losing tables', () => {
    db = openDatabase(path);
    db.migrate();

    // Every table the live database has must be one the parser recognises,
    // or a future column added to it would be silently skipped.
    const live = (
      db.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(live.length).toBeGreaterThan(10);
  });

  it('separates column definitions from table constraints', () => {
    const [table] = parseSchema(`CREATE TABLE IF NOT EXISTS x (
      a TEXT NOT NULL,
      b INTEGER DEFAULT 0,
      UNIQUE (a, b),
      FOREIGN KEY (a) REFERENCES y(id)
    );`);

    expect(table?.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('is not confused by a comma inside a CHECK constraint', () => {
    const [table] = parseSchema(`CREATE TABLE IF NOT EXISTS x (
      kind TEXT NOT NULL CHECK (kind IN ('a','b','c')),
      note TEXT
    );`);

    expect(table?.columns.map((c) => c.name)).toEqual(['kind', 'note']);
  });

  it('strips comments without eating quoted text', () => {
    const stripped = stripSqlComments(`SELECT 'a -- not a comment' -- but this is\nFROM t`);

    expect(stripped).toContain("'a -- not a comment'");
    expect(stripped).not.toContain('but this is');
  });

  it('ignores a comment that sits between column definitions', () => {
    const [table] = parseSchema(`CREATE TABLE IF NOT EXISTS x (
      a TEXT,
      -- explaining why b exists, mentioning c TEXT along the way
      b TEXT
    );`);

    expect(table?.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });
});
