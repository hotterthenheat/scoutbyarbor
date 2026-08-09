import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ScoutDb } from './index.js';

/**
 * Storage durability check.
 *
 * Scout keeps ALL of its state in one SQLite file: the processed-post set that
 * makes dedupe work, the delivery log the replay reads, the calendar keys that
 * stop a reminder firing twice, and the job queue. On Render that file has to
 * live on a mounted persistent disk. If it does not, every deploy resets it —
 * and the failure is invisible, because a Scout with amnesia boots cleanly,
 * passes its health check, and then reposts a morning's worth of old headlines
 * into the trading channels as breaking news.
 *
 * Configuration alone cannot prove the disk is attached, so this does not try
 * to. It records a boot counter IN the database. A counter that survives is
 * proof the file survived; a counter still reading 1 after a redeploy is proof
 * it did not. The path heuristics below are only an early warning on top of
 * that — they can flag an obviously ephemeral path at first boot, before the
 * evidence exists.
 */

export type Durability =
  /** The database outlived at least one previous process. Proven. */
  | 'PERSISTENT'
  /** First boot on this file — nothing has been proven yet, either way. */
  | 'UNPROVEN'
  /** Booted before, yet the file is new. State was lost. */
  | 'EPHEMERAL';

export interface StorageReport {
  path: string;
  absolutePath: string;
  /** The file existed before this process opened it. */
  existedAtBoot: boolean;
  fileBytes: number;
  boots: number;
  firstBootAt: string | null;
  lastBootAt: string | null;
  durability: Durability;
  /** Human-readable problems an operator should act on. */
  warnings: string[];
  /** Row counts for the state that must survive a restart. */
  retained: Record<string, number>;
}

const BOOTS_KEY = 'boots';
const FIRST_BOOT_KEY = 'first_boot_at';
const LAST_BOOT_KEY = 'last_boot_at';

/**
 * Whether the file exists must be sampled BEFORE `openDatabase`, because
 * opening creates it. Call this first, then pass the result to `recordBoot`.
 */
export function databaseExistsAt(path: string): boolean {
  if (path === ':memory:' || path.startsWith('file::memory:')) return false;
  return existsSync(resolve(path));
}

/**
 * Increments the boot counter and reports what that implies. Must run after
 * `migrate()`, since it writes to `runtime_state`.
 */
export function recordBoot(
  db: ScoutDb,
  options: { databasePath: string; existedAtBoot: boolean; nowIso: string; env?: NodeJS.ProcessEnv },
): StorageReport {
  const env = options.env ?? process.env;
  const inMemory =
    options.databasePath === ':memory:' || options.databasePath.startsWith('file::memory:');
  const absolutePath = inMemory ? options.databasePath : resolve(options.databasePath);

  const previousBoots = readNumber(db, BOOTS_KEY);
  const boots = previousBoots + 1;
  const firstBootAt = readText(db, FIRST_BOOT_KEY) ?? options.nowIso;
  const lastBootAt = readText(db, LAST_BOOT_KEY);

  write(db, BOOTS_KEY, String(boots), options.nowIso);
  write(db, FIRST_BOOT_KEY, firstBootAt, options.nowIso);
  write(db, LAST_BOOT_KEY, options.nowIso, options.nowIso);

  const durability: Durability = inMemory
    ? 'UNPROVEN'
    : previousBoots > 0
      ? 'PERSISTENT'
      : 'UNPROVEN';

  const report: StorageReport = {
    path: options.databasePath,
    absolutePath,
    existedAtBoot: options.existedAtBoot,
    fileBytes: fileBytes(absolutePath, inMemory),
    boots,
    firstBootAt,
    lastBootAt,
    durability,
    warnings: pathWarnings(options.databasePath, absolutePath, env, inMemory),
    retained: retainedCounts(db),
  };

  // A boot counter that reset is the definitive signal, and it outranks every
  // heuristic above: the process has run before and the file did not survive.
  if (!inMemory && previousBoots === 0 && env.RENDER) {
    report.warnings.push(
      'first boot recorded on this database file — if this service has deployed before, ' +
        'the persistent disk is NOT attached and all prior state was lost',
    );
  }

  return report;
}

/**
 * Re-reads durability without writing, for `/metrics`. `boots > 1` means the
 * file outlived a process, which is the whole proof.
 */
export function storageStatus(
  db: ScoutDb,
  databasePath: string,
): Pick<StorageReport, 'path' | 'boots' | 'firstBootAt' | 'lastBootAt' | 'durability' | 'retained'> {
  const boots = readNumber(db, BOOTS_KEY);
  return {
    path: databasePath,
    boots,
    firstBootAt: readText(db, FIRST_BOOT_KEY),
    lastBootAt: readText(db, LAST_BOOT_KEY),
    durability: boots > 1 ? 'PERSISTENT' : 'UNPROVEN',
    retained: retainedCounts(db),
  };
}

/**
 * Early warning for a path that cannot possibly be a mounted disk. These fire
 * at first boot, before the boot counter has had a chance to prove anything.
 */
function pathWarnings(
  path: string,
  absolutePath: string,
  env: NodeJS.ProcessEnv,
  inMemory: boolean,
): string[] {
  const warnings: string[] = [];
  if (inMemory) {
    warnings.push('database is in memory — nothing is retained across a restart');
    return warnings;
  }

  // RENDER is set inside every Render service. Outside one, a relative path is
  // an ordinary local development setup and not worth a warning.
  if (!env.RENDER) return warnings;

  if (!isAbsolute(path)) {
    warnings.push(
      `DATABASE_PATH="${path}" is relative, so it resolves inside the deploy directory ` +
        `(${absolutePath}). A Render disk mounts at an absolute path — set DATABASE_PATH ` +
        'to something under the mount, e.g. /var/data/scout.db.',
    );
  } else if (/^\/opt\/render\//.test(absolutePath)) {
    warnings.push(
      `DATABASE_PATH="${absolutePath}" is inside the deploy directory, which Render replaces ` +
        'on every deploy. Point it at the disk mount, e.g. /var/data/scout.db.',
    );
  } else if (/^\/(?:tmp|var\/tmp|dev\/shm)\//.test(absolutePath)) {
    warnings.push(
      `DATABASE_PATH="${absolutePath}" is temporary storage and does not survive a restart.`,
    );
  }

  return warnings;
}

/** Only the state whose loss would actually change Scout's behaviour. */
function retainedCounts(db: ScoutDb): Record<string, number> {
  const count = (table: string): number => {
    try {
      const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
        | { n: number }
        | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  };

  return {
    // Dedupe history. Losing this is what makes Scout repost old news.
    posts: count('posts'),
    newsEvents: count('news_events'),
    // Delivery log. Losing this loses everything the replay would recover.
    deliveries: count('deliveries'),
    // Reminders already sent. Losing this refires them.
    calendarFired: count('calendar_fired'),
    jobs: count('processing_jobs'),
  };
}

function fileBytes(absolutePath: string, inMemory: boolean): number {
  if (inMemory) return 0;
  try {
    return statSync(absolutePath).size;
  } catch {
    return 0;
  }
}

function readText(db: ScoutDb, key: string): string | null {
  try {
    const row = db.raw.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function readNumber(db: ScoutDb, key: string): number {
  const raw = readText(db, key);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function write(db: ScoutDb, key: string, value: string, nowIso: string): void {
  db.raw
    .prepare(
      `INSERT INTO runtime_state (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso);
}

/** One line an operator can read at a glance in the Render log stream. */
export function formatStorageLine(report: StorageReport): string {
  const proof =
    report.durability === 'PERSISTENT'
      ? `PERSISTENT (boot #${report.boots}, first seen ${report.firstBootAt})`
      : `UNPROVEN (boot #${report.boots} — redeploy once and confirm this reads boot #2)`;
  return `storage: ${report.absolutePath} — ${proof}`;
}
