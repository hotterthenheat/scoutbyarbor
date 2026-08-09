import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { createSourceRepo, type SourceRepo } from './repositories/sources.js';
import { createRawPostRepo, type RawPostRepo } from './repositories/rawPosts.js';
import { createNewsEventRepo, type NewsEventRepo } from './repositories/newsEvents.js';
import { createEventRepo, type EventRepo } from './repositories/events.js';
import { createEventUpdateRepo, type EventUpdateRepo } from './repositories/eventUpdates.js';
import { createSourceHealthRepo, type SourceHealthRepo } from './repositories/sourceHealth.js';
import { createSecurityRepo, type SecurityRepo } from './repositories/securities.js';
import { createMetricsRepo, type MetricsRepo } from './repositories/metrics.js';
import { createDiscordMessageRepo, type DiscordMessageRepo } from './repositories/discordMessages.js';
import { createJobRepo, type JobRepo } from './repositories/jobs.js';
import { createPostRepo, type PostRepo } from './repositories/posts.js';
import { createDeliveryRepo, type DeliveryRepo } from './repositories/deliveries.js';

/**
 * Storage layer (§24). One SQLite file, WAL mode, repositories over prepared
 * statements.
 *
 * The shared row-mapping helpers below live here rather than in a separate
 * module so the whole db layer stays inside the files it owns; repositories
 * import them from `../index.js`. Nothing in this module runs work at import
 * time, so that import cycle resolves cleanly under ESM.
 */

export type SqliteDatabase = import('better-sqlite3').Database;
export type SqliteStatement<R = unknown> = import('better-sqlite3').Statement<unknown[], R>;

/** Everything SQLite will accept as a bound parameter. */
export type Bind = string | number | bigint | Buffer | null;

export type { SourceRepo } from './repositories/sources.js';
export type { RawPostRepo } from './repositories/rawPosts.js';
export type { NewsEventRepo, DedupeCandidate, NewsEventRecord } from './repositories/newsEvents.js';
export type { EventRepo } from './repositories/events.js';
export type { EventUpdateRepo } from './repositories/eventUpdates.js';
export type { SourceHealthRepo } from './repositories/sourceHealth.js';
export type { SecurityRepo } from './repositories/securities.js';
export type { MetricsRepo, LatencyStats, LatencySample } from './repositories/metrics.js';
export type { DiscordMessageRepo, DiscordMessageRow } from './repositories/discordMessages.js';
export type { JobRepo } from './repositories/jobs.js';
export type { PostRepo, StoredPost } from './repositories/posts.js';
export type { DeliveryRepo, DeliveryRecord, DeliveryStatus } from './repositories/deliveries.js';

export interface ScoutDb {
  raw: SqliteDatabase;
  sources: SourceRepo;
  rawPosts: RawPostRepo;
  newsEvents: NewsEventRepo;
  events: EventRepo;
  eventUpdates: EventUpdateRepo;
  health: SourceHealthRepo;
  securities: SecurityRepo;
  metrics: MetricsRepo;
  discordMessages: DiscordMessageRepo;
  jobs: JobRepo;
  posts: PostRepo;
  deliveries: DeliveryRepo;
  migrate(): void;
  close(): void;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Statements are prepared on first use and kept for the life of the repo.
 * Preparing on every call is the single easiest way to make a SQLite hot path
 * slow, and the dedupe candidate query runs on every ingested post.
 */
export interface StatementCache {
  get<R = unknown>(sql: string): SqliteStatement<R>;
}

export function createStatementCache(db: SqliteDatabase): StatementCache {
  const cache = new Map<string, unknown>();
  return {
    get<R = unknown>(sql: string): SqliteStatement<R> {
      const hit = cache.get(sql);
      if (hit) return hit as SqliteStatement<R>;
      const stmt = db.prepare(sql);
      cache.set(sql, stmt);
      return stmt as SqliteStatement<R>;
    },
  };
}

/**
 * Malformed JSON in a column must degrade to a default, never throw — a single
 * bad row would otherwise take down every read that touches it.
 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    return value === null || value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

/** Same, but rejects anything that did not parse to an array. */
export function parseJsonArray<T>(raw: unknown): T[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Same, but rejects anything that did not parse to a plain object. */
export function parseJsonObject<T extends object>(raw: unknown, fallback: T): T {
  const value = parseJson<unknown>(raw, fallback);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : fallback;
}

export function toJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return 'null';
  }
}

/** SQLite has no boolean type; columns hold 0/1 and the types want real bools. */
export function fromSqliteBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function toSqliteBool(value: boolean): number {
  return value ? 1 : 0;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = toNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

export function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function toNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO hour bucket used as the aggregation key in `pipeline_metrics`. */
export function hourBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return hourBucket(nowIso());
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

// ── Connection ───────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * schema.sql is data, not code, so `tsc` does not copy it into dist/. Look
 * beside the module first (tsx running from src/, or a build that did copy it)
 * and fall back to the checked-in source tree.
 */
function findSchemaFile(): string {
  const candidates = [
    resolve(HERE, 'schema.sql'),
    resolve(HERE, '../src/db/schema.sql'),
    resolve(HERE, '../../src/db/schema.sql'),
    resolve(HERE, '../../../src/db/schema.sql'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`db/schema.sql not found; looked in: ${candidates.join(', ')}`);
}

export function openDatabase(path: string): ScoutDb {
  if (path !== ':memory:' && !path.startsWith('file::memory:')) {
    const dir = dirname(resolve(path));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db: SqliteDatabase = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return {
    raw: db,
    sources: createSourceRepo(db),
    rawPosts: createRawPostRepo(db),
    newsEvents: createNewsEventRepo(db),
    events: createEventRepo(db),
    eventUpdates: createEventUpdateRepo(db),
    health: createSourceHealthRepo(db),
    securities: createSecurityRepo(db),
    metrics: createMetricsRepo(db),
    discordMessages: createDiscordMessageRepo(db),
    jobs: createJobRepo(db),
    posts: createPostRepo(db),
    deliveries: createDeliveryRepo(db),
    migrate(): void {
      // schema.sql is entirely CREATE ... IF NOT EXISTS, so this is idempotent
      // and safe to run on every boot.
      db.exec(readFileSync(findSchemaFile(), 'utf8'));
    },
    close(): void {
      db.close();
    },
  };
}
