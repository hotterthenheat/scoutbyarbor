import type { SqliteDatabase } from './index.js';

/**
 * Additive schema migration.
 *
 * `schema.sql` is written entirely as `CREATE TABLE IF NOT EXISTS`, which is
 * idempotent but only creates tables that are ABSENT. Adding a column to a
 * table that already exists does nothing — the CREATE is skipped wholesale —
 * and the failure is not even quiet: an index in the same file that references
 * the new column throws `no such column` and Scout dies on boot.
 *
 * That is the difference between a database that persists (which is the whole
 * point of the disk) and one that can never be upgraded.
 *
 * So before the schema is applied, every column it declares is compared against
 * what the live database actually has, and anything missing is added with
 * `ALTER TABLE ... ADD COLUMN`. The expected columns are parsed from
 * `schema.sql` itself rather than kept in a hand-written list, because a
 * hand-written list is one someone eventually forgets to update.
 */

export interface ColumnDef {
  name: string;
  /** Everything after the column name, e.g. `TEXT NOT NULL DEFAULT 'x'`. */
  definition: string;
}

export interface TableDef {
  table: string;
  columns: ColumnDef[];
}

export interface MigrationResult {
  added: Array<{ table: string; column: string }>;
  /** Columns SQLite cannot add to an existing table. */
  skipped: Array<{ table: string; column: string; reason: string }>;
  /** True when the sources table had to be rebuilt to drop a stale CHECK. */
  rebuilt?: boolean;
}

/** SQLite rejects ADD COLUMN for these, whatever the rest of the definition says. */
const UNADDABLE = [
  { pattern: /\bPRIMARY\s+KEY\b/i, reason: 'SQLite cannot add a PRIMARY KEY column' },
  { pattern: /\bUNIQUE\b/i, reason: 'SQLite cannot add a UNIQUE column' },
];

/** Table-level constraints, which are not columns. */
const CONSTRAINT_START = /^(?:UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i;

/**
 * Strips `--` line comments while leaving anything inside a string literal
 * alone, so a CHECK constraint listing quoted values survives intact.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      // Discard through end of line, keeping the newline as a separator.
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Splits on top-level commas only — nested parens and strings are opaque. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';

  for (const ch of body) {
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Reads the table/column shape `schema.sql` declares. */
export function parseSchema(sql: string): TableDef[] {
  const clean = stripSqlComments(sql);
  const tables: TableDef[] = [];

  const header = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = header.exec(clean)) !== null) {
    const table = match[1];
    if (!table) continue;

    // Walk to the parenthesis that closes the definition.
    let depth = 1;
    let inString = false;
    let i = header.lastIndex;
    for (; i < clean.length && depth > 0; i++) {
      const ch = clean[i];
      if (inString) {
        if (ch === "'") inString = false;
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue; // Unbalanced; leave it to SQLite to complain.

    const body = clean.slice(header.lastIndex, i - 1);
    const columns: ColumnDef[] = [];

    for (const part of splitTopLevel(body)) {
      const trimmed = part.trim().replace(/\s+/g, ' ');
      if (!trimmed || CONSTRAINT_START.test(trimmed)) continue;

      const space = trimmed.indexOf(' ');
      const name = space === -1 ? trimmed : trimmed.slice(0, space);
      const definition = space === -1 ? '' : trimmed.slice(space + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) columns.push({ name, definition });
    }

    if (columns.length > 0) tables.push({ table, columns });
    header.lastIndex = i;
  }

  return tables;
}

function existingTables(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function existingColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Adds any column `schema.sql` declares that the live database is missing.
 *
 * Must run BEFORE the schema is executed: an index in `schema.sql` may
 * reference a column added here, and `CREATE INDEX` on a missing column throws
 * rather than being skipped.
 *
 * Tables that do not exist yet are left alone — `CREATE TABLE IF NOT EXISTS`
 * will make them, complete and correct, moments later.
 */
export function applyAdditiveMigrations(db: SqliteDatabase, schemaSql: string): MigrationResult {
  const result: MigrationResult = { added: [], skipped: [] };
  const present = existingTables(db);

  for (const { table, columns } of parseSchema(schemaSql)) {
    if (!present.has(table)) continue;

    const have = existingColumns(db, table);
    for (const column of columns) {
      if (have.has(column.name)) continue;

      const blocked = UNADDABLE.find((rule) => rule.pattern.test(column.definition));
      if (blocked) {
        result.skipped.push({ table, column: column.name, reason: blocked.reason });
        continue;
      }
      // NOT NULL needs a default, or SQLite refuses on a table with rows.
      if (/\bNOT\s+NULL\b/i.test(column.definition) && !/\bDEFAULT\b/i.test(column.definition)) {
        result.skipped.push({
          table,
          column: column.name,
          reason: 'NOT NULL without a DEFAULT cannot be added to an existing table',
        });
        continue;
      }

      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`.trim());
      result.added.push({ table, column: column.name });
    }
  }

  result.rebuilt = relaxSourceTypeCheck(db);
  return result;
}

/**
 * Drops the hard-coded `source_type IN (…)` list from an existing database.
 *
 * The list was duplicated in SQL, and SQLite has no ALTER for a CHECK — so
 * adding an ingestion adapter made every deployed database reject the new type
 * with `CHECK constraint failed`, on a table that cannot be altered in place.
 * The valid set belongs in one place (SOURCE_TYPES) enforced by the config
 * loader before a row is ever written, so the constraint is removed rather than
 * extended. Extending it would only defer the same problem to the next adapter.
 *
 * A table rebuild is the only way. It runs once: afterwards the CHECK is gone
 * and the detection below no longer matches.
 */
export function relaxSourceTypeCheck(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'")
    .get() as { sql?: string } | undefined;

  const sql = row?.sql ?? '';
  if (!/CHECK\s*\(\s*source_type\s+IN/i.test(sql)) return false;

  // Column list from the LIVE table, so the copy works whatever migrations have
  // already run. Reading it from schema.sql could name a column this database
  // does not have yet.
  const columns = (db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>)
    .map((c) => `"${c.name}"`)
    .join(', ');

  const rebuilt = sql
    .replace(/CHECK\s*\(\s*source_type\s+IN\s*\([^)]*\)\s*\)/i, '')
    // The comma the removed constraint left behind, e.g. `TEXT NOT NULL ,`.
    .replace(/\s+,/g, ',')
    .replace(/CREATE TABLE (IF NOT EXISTS )?"?sources"?/i, 'CREATE TABLE sources_migrated');

  // Foreign keys must be off for the drop-and-rename, and PRAGMA cannot change
  // inside a transaction — hence the ordering here.
  const hadForeignKeys = db.pragma('foreign_keys', { simple: true }) === 1;
  if (hadForeignKeys) db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(rebuilt);
    db.exec(`INSERT INTO sources_migrated (${columns}) SELECT ${columns} FROM sources`);
    db.exec('DROP TABLE sources');
    db.exec('ALTER TABLE sources_migrated RENAME TO sources');
    // Dropped with the old table; schema.sql recreates them right after this.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sources_enabled  ON sources(enabled, source_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sources_priority ON sources(priority DESC)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    if (hadForeignKeys) db.pragma('foreign_keys = ON');
  }

  return true;
}
