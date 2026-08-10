import type {
  IngestAdapter,
  IngestResult,
  RawPost,
  SourceType,
  SourceVerification,
} from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import { createPrimer, type Primer } from './priming.js';

/**
 * Ingestion scheduling.
 *
 * Each adapter runs on its own timer at its own cadence, and the source list is
 * re-read every tick so `npm run sources:sync` takes effect without a restart
 * (§36). One adapter throwing must never stop the others, and every per-source
 * outcome is forwarded to the health monitor so a broken feed is visible rather
 * than silent (§23).
 */

export interface IngestManager {
  start(): void;
  stop(): void;
  pollOnce(): Promise<IngestResult>;
  verifyAll(): Promise<SourceVerification[]>;
}

export interface IngestManagerDeps {
  db: ScoutDb;
  adapters: IngestAdapter[];
  logger: Logger;
  intervals: Record<string, number>;
  onPosts: (posts: RawPost[]) => Promise<void>;
  onOutcome?: (outcome: IngestResult['outcomes'][number]) => void;
  /** Test seam. Defaults to one backed by `runtime_state`. */
  primer?: Primer;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createIngestManager(deps: IngestManagerDeps): IngestManager {
  const { db, adapters, logger } = deps;
  const primer = deps.primer ?? createPrimer(db, () => new Date().toISOString());
  // One live timer per adapter, replaced on each tick rather than appended to a
  // list that grows for the life of the process.
  const timers = new Map<SourceType, NodeJS.Timeout>();
  const running = new Set<SourceType>();
  let stopped = false;

  function sourcesFor(type: SourceType) {
    return db.sources.enabled().filter((s) => s.sourceType === type);
  }

  async function runAdapter(adapter: IngestAdapter): Promise<IngestResult> {
    // Overlapping polls would double-count against the rate-limit budget.
    if (running.has(adapter.type)) {
      return { posts: [], outcomes: [] };
    }
    running.add(adapter.type);

    try {
      const sources = sourcesFor(adapter.type);
      if (sources.length === 0) return { posts: [], outcomes: [] };

      const result = await adapter.poll(sources);

      for (const outcome of result.outcomes) {
        deps.onOutcome?.(outcome);
        if (!outcome.ok) {
          logger.warn('source poll failed', {
            sourceId: outcome.sourceId,
            error: outcome.error,
          });
        }
      }

      // raw_posts is the landing table and the exact-post-id dedupe layer: an
      // insert that returns null means we have seen this item before.
      const fresh: RawPost[] = [];
      for (const post of result.posts) {
        try {
          if (db.rawPosts.insert(post) !== null) fresh.push(post);
        } catch (err) {
          logger.error('could not store raw post', {
            sourceId: post.sourceId,
            sourcePostId: post.sourcePostId,
            err: err as Error,
          });
        }
      }

      // A source's FIRST poll is its whole backlog, not its news. Those items
      // are recorded above — so they dedupe correctly forever after — and are
      // not published. Without this, the first boot against an empty database
      // publishes every item of every feed at once, and the ones that read as
      // market-moving go straight to the trading channels.
      //
      // The manual adapter is exempt, and must be. It holds nothing but items
      // someone explicitly submitted — from the dashboard or the CLI — so it
      // has no backlog to withhold. Priming it would silently swallow the first
      // event an operator ever sent, which is precisely the one they are
      // watching for to confirm the thing works.
      const { publish, withheld } =
        adapter.type === 'manual'
          ? { publish: fresh, withheld: [] as RawPost[] }
          : primer.partition(fresh);

      if (withheld.length > 0) {
        const sources = [...new Set(withheld.map((p) => p.sourceId))];
        logger.info('primed source(s) on first poll; backlog recorded, not published', {
          adapter: adapter.type,
          sources,
          withheld: withheld.length,
        });
      }

      if (publish.length > 0) {
        logger.debug('ingested', { adapter: adapter.type, fresh: publish.length });
        await deps.onPosts(publish);
      }

      return { posts: publish, outcomes: result.outcomes };
    } catch (err) {
      logger.error('adapter poll threw', { adapter: adapter.type, err: err as Error });
      return { posts: [], outcomes: [] };
    } finally {
      running.delete(adapter.type);
    }
  }

  return {
    start(): void {
      stopped = false;
      for (const adapter of adapters) {
        const base = deps.intervals[adapter.type] ?? DEFAULT_INTERVAL_MS;
        // Jitter keeps every adapter off the same tick.
        const jitter = Math.max(1, Math.floor(base * 0.1));
        const schedule = (): void => {
          // stop() may have run while a poll was in flight; without this the
          // loop reschedules itself forever after shutdown.
          if (stopped) return;
          const timer = setTimeout(() => {
            void runAdapter(adapter).finally(schedule);
          }, base + Math.floor(Math.random() * jitter));
          if (typeof timer.unref === 'function') timer.unref();
          timers.set(adapter.type, timer);
        };
        schedule();
      }
      logger.info('ingestion started', {
        adapters: adapters.map((a) => a.type),
        intervals: deps.intervals,
      });
    },

    stop(): void {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },

    async pollOnce(): Promise<IngestResult> {
      const combined: IngestResult = { posts: [], outcomes: [] };
      for (const adapter of adapters) {
        const result = await runAdapter(adapter);
        combined.posts.push(...result.posts);
        combined.outcomes.push(...result.outcomes);
      }
      return combined;
    },

    async verifyAll(): Promise<SourceVerification[]> {
      const out: SourceVerification[] = [];
      for (const adapter of adapters) {
        if (!adapter.verify) continue;
        for (const source of sourcesFor(adapter.type)) {
          try {
            out.push(await adapter.verify(source));
          } catch (err) {
            out.push({ sourceId: source.id, ok: false, detail: (err as Error).message });
          }
        }
      }
      return out;
    },
  };
}
