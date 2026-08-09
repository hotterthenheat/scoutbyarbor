import { createStatementCache, toNullableText, toNumber, toText, type SqliteDatabase } from '../index.js';
import type { Job, JobStatus, SourceKind } from '../../ingest/queue.js';

/**
 * The durable side of the work queue. `UNIQUE(post_id)` is doing the heavy
 * lifting: it is simultaneously the queue's identity, the cross-channel dedupe
 * layer, and the restart guard.
 */

export interface JobRepo {
  /** Returns false when this post id is already queued or processed. */
  insertIfAbsent(job: Job): boolean;
  /** Jobs whose backoff has elapsed, oldest first, marked RUNNING by the caller. */
  claimable(nowIso: string, limit: number): Job[];
  markRunning(jobId: string, at: string): void;
  markComplete(jobId: string, status: JobStatus, at: string, error?: string, attempts?: number): void;
  scheduleRetry(jobId: string, attempts: number, error: string, nextAttemptAt: string): void;
  /** Recover jobs a crashed process left RUNNING. Returns how many. */
  requeueRunning(nowIso: string): number;
  /** Requeue a terminally failed post so a later relay can retry it. */
  reopen(postId: string, nowIso: string): void;
  /**
   * Requeue rows stuck RUNNING since before `before` that no live worker owns.
   * `owned` is the set of job ids this process is actually working on.
   */
  stuckRunning(before: string, owned: string[]): number;
  byPostId(postId: string): Job | null;
  queueDepth(): number;
  countsByStatus(): Record<string, number>;
}

interface JobRow {
  job_id: string;
  post_id: string;
  url: string;
  source_channel: string | null;
  source_kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  completed_at: string | null;
}

const COLUMNS = `job_id, post_id, url, source_channel, source_kind, status, attempts,
                 last_error, next_attempt_at, created_at, completed_at`;

function toJob(row: JobRow): Job {
  return {
    jobId: row.job_id,
    postId: row.post_id,
    url: toText(row.url),
    sourceChannel: toNullableText(row.source_channel),
    sourceKind: (toText(row.source_kind, 'news') as SourceKind) ?? 'news',
    status: toText(row.status, 'QUEUED') as JobStatus,
    attempts: toNumber(row.attempts),
    lastError: toNullableText(row.last_error),
    nextAttemptAt: toNullableText(row.next_attempt_at),
    createdAt: toText(row.created_at),
    completedAt: toNullableText(row.completed_at),
  };
}

export function createJobRepo(db: SqliteDatabase): JobRepo {
  const stmts = createStatementCache(db);

  return {
    insertIfAbsent(job: Job): boolean {
      const result = stmts
        .get(
          `INSERT OR IGNORE INTO processing_jobs (${COLUMNS})
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          job.jobId,
          job.postId,
          job.url,
          job.sourceChannel,
          job.sourceKind,
          job.status,
          job.attempts,
          job.lastError,
          job.nextAttemptAt,
          job.createdAt,
          job.completedAt,
        );
      return result.changes > 0;
    },

    claimable(nowIso: string, limit: number): Job[] {
      // Claim atomically so two workers cannot take the same job.
      const claim = db.transaction((n: string, l: number): Job[] => {
        const rows = stmts
          .get<JobRow>(
            `SELECT ${COLUMNS} FROM processing_jobs
              WHERE status = 'QUEUED'
                AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              ORDER BY created_at ASC
              LIMIT ?`,
          )
          .all(n, l);

        for (const row of rows) {
          stmts
            .get(`UPDATE processing_jobs SET status = 'RUNNING' WHERE job_id = ? AND status = 'QUEUED'`)
            .run(row.job_id);
        }
        return rows.map(toJob);
      });
      return claim(nowIso, limit);
    },

    markRunning(jobId: string, _at: string): void {
      stmts.get(`UPDATE processing_jobs SET status = 'RUNNING' WHERE job_id = ?`).run(jobId);
    },

    markComplete(jobId, status, at, error, attempts): void {
      stmts
        .get(
          `UPDATE processing_jobs
              SET status = ?, completed_at = ?, last_error = ?,
                  attempts = COALESCE(?, attempts)
            WHERE job_id = ?`,
        )
        .run(status, at, error ?? null, attempts ?? null, jobId);
    },

    scheduleRetry(jobId, attempts, error, nextAttemptAt): void {
      stmts
        .get(
          `UPDATE processing_jobs
              SET status = 'QUEUED', attempts = ?, last_error = ?, next_attempt_at = ?
            WHERE job_id = ?`,
        )
        .run(attempts, error, nextAttemptAt, jobId);
    },

    requeueRunning(nowIso: string): number {
      const result = stmts
        .get(
          `UPDATE processing_jobs
              SET status = 'QUEUED', next_attempt_at = ?
            WHERE status = 'RUNNING'`,
        )
        .run(nowIso);
      return result.changes;
    },

    reopen(postId: string, nowIso: string): void {
      stmts
        .get(
          `UPDATE processing_jobs
              SET status = 'QUEUED', attempts = 0, last_error = NULL,
                  next_attempt_at = ?, completed_at = NULL
            WHERE post_id = ? AND status IN ('FAILED','FAILED_RETRIEVAL')`,
        )
        .run(nowIso, postId);
    },

    stuckRunning(before: string, owned: string[]): number {
      // created_at is the only timestamp a RUNNING row carries, so it bounds
      // how long the job could possibly have been in flight.
      const placeholders = owned.length > 0 ? owned.map(() => '?').join(',') : "''";
      const result = stmts
        .get(
          `UPDATE processing_jobs
              SET status = 'QUEUED', next_attempt_at = ?
            WHERE status = 'RUNNING'
              AND created_at < ?
              AND job_id NOT IN (${placeholders})`,
        )
        .run(before, before, ...owned);
      return result.changes;
    },

    byPostId(postId: string): Job | null {
      const row = stmts
        .get<JobRow>(`SELECT ${COLUMNS} FROM processing_jobs WHERE post_id = ?`)
        .get(postId);
      return row ? toJob(row) : null;
    },

    queueDepth(): number {
      const row = stmts
        .get<{ n: number }>(`SELECT COUNT(*) AS n FROM processing_jobs WHERE status IN ('QUEUED','RUNNING')`)
        .get();
      return toNumber(row?.n);
    },

    countsByStatus(): Record<string, number> {
      const rows = stmts
        .get<{ status: string; n: number }>(
          `SELECT status, COUNT(*) AS n FROM processing_jobs GROUP BY status`,
        )
        .all();
      const out: Record<string, number> = {};
      for (const row of rows) out[row.status] = toNumber(row.n);
      return out;
    },
  };
}
