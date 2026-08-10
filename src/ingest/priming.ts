import type { RawPost } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';

/**
 * Cold start.
 *
 * A feed reader decides what is new by remembering what it has already seen.
 * On the very first poll it has seen nothing, so EVERY item in EVERY feed is
 * new — and Scout would classify, score, route and publish all of them at once.
 * Twenty feeds carrying twenty items each is four hundred alerts, and the ones
 * that read as market-moving go to the trading channels. Publishing a
 * three-day-old CPI print into #spx-trading is worse than publishing nothing.
 *
 * So the first poll of a source PRIMES it: every item is recorded in
 * `raw_posts`, which is the dedupe layer, and none of them is published.
 * From the second poll onward the source behaves normally, and anything genuinely
 * new is genuinely new.
 *
 * ── WHY PER SOURCE, NOT PER PROCESS ──────────────────────────────────────────
 *
 * The flag is stored in the database, so it survives restarts. That matters in
 * both directions: a redeploy must not re-prime a source that has been running
 * for weeks (it would silently drop a real backlog), and a source added to
 * `sources.yaml` next month gets primed on ITS first poll rather than dumping
 * its whole feed into a live wire.
 *
 * On an ephemeral database this is what keeps every deploy from reposting the
 * news — but it is not a substitute for a disk. Priming discards the backlog;
 * a disk remembers it. Without one, an event that Scout published before the
 * deploy is simply forgotten, and if a feed reports it again it publishes again.
 */

const KEY_PREFIX = 'primed:';

export interface Primer {
  /** Whether this source has completed its first poll. */
  isPrimed(sourceId: string): boolean;
  /**
   * Splits a poll's fresh items into those to publish and those merely recorded.
   *
   * Sources are marked primed as a side effect, so a caller that stores the
   * withheld posts and then publishes the rest gets the right behaviour with no
   * further bookkeeping.
   */
  partition(posts: RawPost[]): { publish: RawPost[]; withheld: RawPost[] };
}

export function createPrimer(db: ScoutDb, now: () => string): Primer {
  const read = db.raw.prepare('SELECT value FROM runtime_state WHERE key = ?');
  const write = db.raw.prepare(
    `INSERT INTO runtime_state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  // Read-through cache. The check runs for every post of every poll, and the
  // answer only ever changes once per source, in this process.
  const primed = new Set<string>();

  function isPrimed(sourceId: string): boolean {
    if (primed.has(sourceId)) return true;
    const row = read.get(`${KEY_PREFIX}${sourceId}`) as { value?: string } | undefined;
    if (row?.value) {
      primed.add(sourceId);
      return true;
    }
    return false;
  }

  function markPrimed(sourceId: string): void {
    if (primed.has(sourceId)) return;
    write.run(`${KEY_PREFIX}${sourceId}`, now(), now());
    primed.add(sourceId);
  }

  return {
    isPrimed,

    partition(posts: RawPost[]) {
      const publish: RawPost[] = [];
      const withheld: RawPost[] = [];

      // Which sources were unprimed at the START of this batch. Deciding as we
      // go would publish the second item of a source whose first item had just
      // marked it primed.
      const coldSources = new Set<string>();
      for (const post of posts) {
        if (!isPrimed(post.sourceId)) coldSources.add(post.sourceId);
      }

      for (const post of posts) {
        if (coldSources.has(post.sourceId)) withheld.push(post);
        else publish.push(post);
      }

      for (const sourceId of coldSources) markPrimed(sourceId);

      return { publish, withheld };
    },
  };
}
