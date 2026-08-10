import type { SourceHealth, SourceHealthState } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';

/**
 * SOURCE HEALTH (§23).
 *
 * The rule this module exists for: Scout must never let a broken feed read as a
 * quiet news environment. Anything downstream — a trading integration, a human
 * watching the channel — has to be able to tell "no news" from "no feed".
 *
 * So every source carries a state derived from its own expected cadence, and
 * any transition into a bad state raises a warning in #scout-system.
 */

export interface PollOutcome {
  sourceId: string;
  ok: boolean;
  itemCount: number;
  error?: string;
  latencyMs: number;
}

export interface HealthMonitor {
  recordPoll(outcome: PollOutcome): void;
  evaluate(): SourceHealth[];
  start(intervalMs: number): void;
  stop(): void;
}

export interface HealthMonitorDeps {
  db: ScoutDb;
  logger: Logger;
  /**
   * Where a health transition is announced. Optional: a caller that only wants
   * the state machine — the CLI, a test — should not have to supply a channel.
   */
  onWarning?: (message: string) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_EXPECTED_INTERVAL_MS = 900_000;
const DISCONNECT_AFTER_FAILURES = 3;
/** Don't re-warn about the same state more often than this. */
const WARNING_DEBOUNCE_MS = 30 * 60_000;

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const state = new Map<string, SourceHealth>();
  const lastWarnedAt = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  function currentFor(sourceId: string): SourceHealth {
    const cached = state.get(sourceId);
    if (cached) return cached;

    const stored = db.health.byId(sourceId);
    if (stored) {
      state.set(sourceId, stored);
      return stored;
    }

    const source = db.sources.byId(sourceId);
    const fresh: SourceHealth = {
      sourceId,
      state: 'ACTIVE',
      lastSuccessAt: null,
      lastItemAt: null,
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
      // Per source, from config — a quarterly filing feed and a breaking-news
      // account have very different ideas of what "quiet" means.
      expectedIntervalMs: source?.expectedIntervalMs || DEFAULT_EXPECTED_INTERVAL_MS,
      updatedAt: now().toISOString(),
    };
    state.set(sourceId, fresh);
    return fresh;
  }

  function recordPoll(outcome: PollOutcome): void {
    const iso = now().toISOString();
    const current = currentFor(outcome.sourceId);

    const next: SourceHealth = {
      ...current,
      updatedAt: iso,
      lastSuccessAt: outcome.ok ? iso : current.lastSuccessAt,
      lastItemAt: outcome.itemCount > 0 ? iso : current.lastItemAt,
      // Cleared on success. A retained error outlives the problem: a feed that
      // recovered still reported its last failure forever, so it read as broken
      // while polling perfectly well — and the fix that healed it looked like it
      // had done nothing.
      lastErrorAt: outcome.ok ? null : iso,
      lastError: outcome.ok ? null : (outcome.error ?? 'unknown error'),
      consecutiveFailures: outcome.ok ? 0 : current.consecutiveFailures + 1,
    };

    state.set(outcome.sourceId, next);
  }

  /** Recompute every source's state and emit transitions. */
  function evaluate(): SourceHealth[] {
    const iso = now().toISOString();
    const nowMs = now().getTime();
    const out: SourceHealth[] = [];

    for (const source of db.sources.enabled()) {
      const current = currentFor(source.id);
      const previous = current.state;

      // Re-read from the source each tick so `npm run sources:sync` changes the
      // threshold without a restart.
      const expected =
        source.expectedIntervalMs || current.expectedIntervalMs || DEFAULT_EXPECTED_INTERVAL_MS;
      current.expectedIntervalMs = expected;
      const sinceItem = current.lastItemAt ? nowMs - Date.parse(current.lastItemAt) : Infinity;
      const everPolled = current.lastSuccessAt !== null || current.consecutiveFailures > 0;

      let next: SourceHealthState;
      if (current.consecutiveFailures >= DISCONNECT_AFTER_FAILURES) {
        next = 'DISCONNECTED';
      } else if (current.consecutiveFailures > 0) {
        next = 'ERROR';
      } else if (!everPolled) {
        // Not yet polled: neither healthy nor broken. Say nothing.
        next = current.state;
      } else if (sinceItem > expected * 3) {
        next = 'STALE';
      } else if (sinceItem > expected) {
        next = 'DELAYED';
      } else {
        next = 'ACTIVE';
      }

      const updated: SourceHealth = { ...current, state: next, updatedAt: iso };
      state.set(source.id, updated);
      db.health.upsert(updated);
      out.push(updated);

      if (next !== previous) {
        void announce(source.id, source.name, previous, next, updated.lastError, nowMs);
      }
    }

    return out;
  }

  async function announce(
    sourceId: string,
    name: string,
    from: SourceHealthState,
    to: SourceHealthState,
    error: string | null,
    nowMs: number,
  ): Promise<void> {
    const bad = to === 'STALE' || to === 'DISCONNECTED' || to === 'ERROR';
    const recovered = to === 'ACTIVE' && (from === 'STALE' || from === 'DISCONNECTED' || from === 'ERROR');
    if (!bad && !recovered) return;

    // A flapping source must not spam the channel.
    const last = lastWarnedAt.get(`${sourceId}:${to}`) ?? 0;
    if (nowMs - last < WARNING_DEBOUNCE_MS) return;
    lastWarnedAt.set(`${sourceId}:${to}`, nowMs);

    const message = bad
      ? [
          '```',
          'SOURCE HEALTH WARNING',
          '',
          `${name}  (${sourceId})`,
          `${from} → ${to}`,
          error ? `error: ${error}` : 'no items within the expected interval',
          '',
          'A stale feed is not a quiet news environment. Anything consuming',
          'Scout should treat this source as unavailable until it recovers.',
          '```',
        ].join('\n')
      : ['```', 'SOURCE RECOVERED', '', `${name}  (${sourceId})`, `${from} → ${to}`, '```'].join('\n');

    logger[bad ? 'warn' : 'info']('source health transition', { sourceId, from, to });
    // Guarded, because it is optional. Called unconditionally it threw an
    // unhandled rejection out of a timer — invisible in production only because
    // the one caller there happens to pass it.
    await deps.onWarning?.(message)?.catch((err) => {
      logger.warn('could not deliver health warning', { err: err as Error });
    });
  }

  function start(intervalMs: number): void {
    stop();
    timer = setInterval(() => {
      try {
        evaluate();
      } catch (err) {
        logger.error('health evaluation failed', { err: err as Error });
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { recordPoll, evaluate, start, stop };
}

