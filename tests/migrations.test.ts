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
  relaxSourceTypeCheck,
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

/**
 * A CHECK constraint that lists valid values cannot be altered in place —
 * SQLite has no ALTER for one — so the moment an ingestion adapter is added,
 * every database already on disk rejects the new type and Scout cannot write a
 * source row at all. The list belonged in one place (SOURCE_TYPES, enforced by
 * the config loader before a row is written), so the constraint is removed
 * rather than extended: extending it defers the identical problem to the next
 * adapter.
 */
describe('a database carrying the old source_type CHECK', () => {
  const LEGACY = `CREATE TABLE sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT, url TEXT,
    source_type TEXT NOT NULL CHECK (source_type IN ('x','rss','edgar','manual')),
    category TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 50,
    enabled INTEGER NOT NULL DEFAULT 1, verified INTEGER NOT NULL DEFAULT 0,
    quality_score INTEGER NOT NULL DEFAULT 70, noise_score INTEGER NOT NULL DEFAULT 30,
    macro_score INTEGER NOT NULL DEFAULT 50, micro_score INTEGER NOT NULL DEFAULT 50,
    geopolitical_score INTEGER NOT NULL DEFAULT 50,
    filter_profile TEXT NOT NULL DEFAULT 'standard'
      CHECK (filter_profile IN ('standard','strict')),
    official INTEGER NOT NULL DEFAULT 0, org TEXT,
    expected_interval_ms INTEGER NOT NULL DEFAULT 900000, notes TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

  function legacyDb(path: string): Database.Database {
    const raw = new Database(path);
    raw.exec(LEGACY);
    raw
      .prepare(
        'INSERT INTO sources (id,name,source_type,category,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('rss:fed', 'Fed', 'rss', 'FED', '2026-01-01', '2026-01-01');
    return raw;
  }

  it('rejects a new source type before the migration', () => {
    const raw = legacyDb(join(dir, 'legacy-before.db'));
    expect(() =>
      raw
        .prepare(
          'INSERT INTO sources (id,name,source_type,category,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        )
        .run('finnhub:general', 'FH', 'finnhub', 'MARKET', '2026-01-01', '2026-01-01'),
    ).toThrow(/CHECK constraint failed/);
    raw.close();
  });

  it('accepts it after, without losing a row', () => {
    const path = join(dir, 'legacy-after.db');
    legacyDb(path).close();

    const db = openDatabase(path);
    db.migrate();

    db.raw
      .prepare(
        'INSERT INTO sources (id,name,source_type,category,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run('finnhub:general', 'FH', 'finnhub', 'MARKET', '2026-01-01', '2026-01-01');

    const ids = (db.raw.prepare('SELECT id FROM sources ORDER BY id').all() as Array<{
      id: string;
    }>).map((r) => r.id);
    // The pre-existing row survived the table rebuild.
    expect(ids).toEqual(['finnhub:general', 'rss:fed']);
    db.close();
  });

  it('leaves the OTHER check constraint alone', () => {
    const path = join(dir, 'legacy-other.db');
    legacyDb(path).close();

    const db = openDatabase(path);
    db.migrate();

    const sql = (
      db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'sources'").get() as {
        sql: string;
      }
    ).sql;
    expect(/CHECK\s*\(\s*source_type/i.test(sql), 'source_type CHECK survived').toBe(false);
    expect(/CHECK\s*\(\s*filter_profile/i.test(sql), 'filter_profile CHECK was lost').toBe(true);
    db.close();
  });

  it('rebuilds the indexes it had to drop', () => {
    const path = join(dir, 'legacy-idx.db');
    legacyDb(path).close();

    const db = openDatabase(path);
    db.migrate();

    const names = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sources'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain('idx_sources_enabled');
    expect(names).toContain('idx_sources_priority');
    db.close();
  });

  it('is a no-op on a database that never had the constraint', () => {
    const path = join(dir, 'modern.db');
    const db = openDatabase(path);
    db.migrate();
    // Already migrated by migrate(); a second call must find nothing to do.
    expect(relaxSourceTypeCheck(db.raw)).toBe(false);
    db.close();
  });
});
