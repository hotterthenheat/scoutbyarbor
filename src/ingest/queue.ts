import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import { isoNow } from '../util/time.js';

/**
 * The URL-processing work queue.
 *
 * Three properties the 24/7 requirement depends on:
 *
 *   - Persisted. The set of processed post ids never lives only in RAM, so a
 *     Render restart resumes rather than reposting the last few hundred items.
 *   - Bounded. A hundred URLs arriving at once run `concurrency` at a time; one
 *     slow retrieval cannot block the rest of the wire.
 *   - Finite. Retries follow a fixed backoff and then stop. A permanently
 *     unresolvable post becomes FAILED_RETRIEVAL, not an infinite loop.
 */

export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'FAILED_RETRIEVAL' | 'SKIPPED';
export type SourceKind = 'news' | 'truth_social' | 'admin' | 'webhook';

export interface Job {
  jobId: string;
  postId: string;
  url: string;
  sourceChannel: string | null;
  sourceKind: SourceKind;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Attempt 1 immediate, then 1s, 3s, 10s. Then the job is done trying. */
export const BACKOFF_MS = [0, 1_000, 3_000, 10_000];

/** A job RUNNING for longer than this with no owner is presumed dead. */
const STUCK_JOB_MS = 10 * 60_000;
/** How often to look for them. */
const STUCK_CHECK_MS = 60_000;

export interface JobQueue {
  /** Enqueue, or return null when this post id is already known. */
  enqueue(input: {
    postId: string;
    url: string;
    sourceChannel: string | null;
    sourceKind: SourceKind;
  }): Job | null;
  start(): void;
  stop(): void;
  /** Drain the queue once and resolve when it is empty — used by tests. */
  drain(): Promise<void>;
  depth(): number;
  inFlight(): number;
}

export interface JobQueueDeps {
  db: ScoutDb;
  logger: Logger;
  concurrency: number;
  maxAttempts: number;
  /**
   * Processes one job. Throwing with `retriable === false` (or exceeding
   * maxAttempts) moves the job to a terminal failure state.
   */
  handler: (job: Job) => Promise<void>;
  pollIntervalMs?: number;
  /** Override the retry schedule. Tests use a fast one. */
  backoffMs?: number[];
  now?: () => Date;
}

export function createJobQueue(deps: JobQueueDeps): JobQueue {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const backoff = deps.backoffMs ?? BACKOFF_MS;

  const running = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const jobs = db.jobs;

  // A process that died mid-job leaves RUNNING rows behind; on boot they are
  // ours to retry, not to abandon.
  function recoverOrphans(): void {
    const recovered = jobs.requeueRunning(isoNow());
    if (recovered > 0) {
      logger.warn('requeued jobs left RUNNING by a previous process', { count: recovered });
    }
  }

  function enqueue(input: {
    postId: string;
    url: string;
    sourceChannel: string | null;
    sourceKind: SourceKind;
  }): Job | null {
    const iso = now().toISOString();
    const job: Job = {
      jobId: `job-${input.postId}`,
      postId: input.postId,
      url: input.url,
      sourceChannel: input.sourceChannel,
      sourceKind: input.sourceKind,
      status: 'QUEUED',
      attempts: 0,
      lastError: null,
      nextAttemptAt: iso,
      createdAt: iso,
      completedAt: null,
    };
    // UNIQUE(post_id) makes this the durable dedupe layer: the same post from
    // five channels, or after a restart, inserts once.
    if (jobs.insertIfAbsent(job)) return job;

    // A job that failed terminally must not poison the post id forever. A
    // fourteen-second upstream outage is enough to exhaust the retries, and the
    // same URL relayed an hour later deserves a fresh attempt. A job that
    // already SUCCEEDED stays blocked — that is the dedupe guarantee.
    const existing = jobs.byPostId(input.postId);
    if (existing && (existing.status === 'FAILED' || existing.status === 'FAILED_RETRIEVAL')) {
      jobs.reopen(input.postId, iso);
      logger.info('retrying a previously failed post', {
        postId: input.postId,
        previousError: existing.lastError,
      });
      return { ...job, attempts: 0 };
    }
    return null;
  }

  async function runOne(job: Job): Promise<void> {
    running.add(job.jobId);
    jobs.markRunning(job.jobId, now().toISOString());

    try {
      await deps.handler(job);
      jobs.markComplete(job.jobId, 'DONE', now().toISOString());
      logger.debug('job done', { postId: job.postId, attempts: job.attempts + 1 });
    } catch (err) {
      const error = err as Error & { retriable?: boolean };
      const attempts = job.attempts + 1;
      const retriable = error.retriable !== false;
      const exhausted = attempts >= deps.maxAttempts;

      if (!retriable || exhausted) {
        const status: JobStatus = retriable ? 'FAILED' : 'FAILED_RETRIEVAL';
        jobs.markComplete(job.jobId, status, now().toISOString(), error.message, attempts);
        logger.warn('job failed terminally', {
          postId: job.postId,
          attempts,
          status,
          error: error.message,
        });
      } else {
        const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 10_000;
        const nextAt = new Date(now().getTime() + delay).toISOString();
        jobs.scheduleRetry(job.jobId, attempts, error.message, nextAt);
        logger.debug('job retrying', { postId: job.postId, attempts, delayMs: delay });
      }
    } finally {
      running.delete(job.jobId);
    }
  }

  /** A RUNNING row this process is not actually working on is an orphan. */
  function reclaimStuck(): void {
    const stuck = jobs.stuckRunning(
      new Date(now().getTime() - STUCK_JOB_MS).toISOString(),
      [...running].map((id) => id),
    );
    if (stuck > 0) logger.warn('reclaimed stuck jobs', { count: stuck });
  }

  let sinceLastReclaim = 0;

  function pump(): void {
    if (stopped) return;

    // Cheap, and only every so often: a handler that never settles would
    // otherwise hold its slot until the process restarts.
    if (++sinceLastReclaim * pollIntervalMs >= STUCK_CHECK_MS) {
      sinceLastReclaim = 0;
      reclaimStuck();
    }

    const capacity = deps.concurrency - running.size;
    if (capacity <= 0) return;

    const claimable = jobs.claimable(now().toISOString(), capacity);
    for (const job of claimable) {
      if (running.has(job.jobId)) continue;
      void runOne(job);
    }
  }

  return {
    enqueue,

    start(): void {
      stopped = false;
      recoverOrphans();
      if (timer) clearInterval(timer);
      timer = setInterval(pump, pollIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      pump();
    },

    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },

    async drain(): Promise<void> {
      recoverOrphans();
      // Bounded so a permanently failing handler cannot spin forever.
      // Queue depth, not claimability: a job waiting out its backoff is still
      // pending work, and returning early would make a retry test pass
      // spuriously.
      for (let guard = 0; guard < 20_000; guard++) {
        pump();
        if (running.size === 0 && jobs.queueDepth() === 0) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },

    depth: () => jobs.queueDepth(),
    inFlight: () => running.size,
  };
}
