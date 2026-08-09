import type { IngestAdapter, IngestResult, RawPost, Source, SourceVerification } from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import { isoNow } from '../../util/time.js';

/**
 * X (Twitter) API v2 adapter.
 *
 * Two things this must never do:
 *   - Burn through the rate limit. Requests are budgeted against a rolling
 *     15-minute window and the adapter stops rather than getting itself banned.
 *   - Look quiet when it is actually broken. With no bearer token, every X
 *     source reports a failed poll with a clear message, so the health monitor
 *     marks them DISCONNECTED instead of Scout silently going dark (§23).
 */

const API = 'https://api.x.com/2';
const WINDOW_MS = 15 * 60_000;
const MAX_RESULTS = 25;
/** Cold-start window, matching the other adapters. */
const FIRST_POLL_MAX_AGE_MS = 15 * 60_000;

export interface TwitterAdapterDeps {
  bearerToken: string;
  requestBudgetPerWindow: number;
  logger: Logger;
  timeoutMs?: number;
}

interface TweetPayload {
  id: string;
  text: string;
  created_at?: string;
  note_tweet?: { text?: string };
  entities?: {
    cashtags?: Array<{ tag: string }>;
    hashtags?: Array<{ tag: string }>;
    urls?: Array<{ expanded_url?: string; url?: string }>;
  };
  referenced_tweets?: Array<{ type: 'retweeted' | 'quoted' | 'replied_to'; id: string }>;
}

export function createTwitterAdapter(deps: TwitterAdapterDeps): IngestAdapter {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const userIds = new Map<string, { id: string; name: string }>();
  const sinceIds = new Map<string, string>();
  const requestTimes: number[] = [];
  let rateLimitResetAt = 0;
  let rotation = 0;

  function budgetRemaining(): number {
    const cutoff = Date.now() - WINDOW_MS;
    while (requestTimes.length > 0 && (requestTimes[0] ?? 0) < cutoff) requestTimes.shift();
    return deps.requestBudgetPerWindow - requestTimes.length;
  }

  async function call<T>(path: string): Promise<T> {
    if (Date.now() < rateLimitResetAt) {
      throw new Error(`rate limited; resets at ${new Date(rateLimitResetAt).toISOString()}`);
    }
    if (budgetRemaining() <= 0) {
      throw new Error('request budget for this 15-minute window is exhausted');
    }

    requestTimes.push(Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API}${path}`, {
        headers: { authorization: `Bearer ${deps.bearerToken}`, accept: 'application/json' },
        signal: controller.signal,
      });

      const remaining = Number(response.headers.get('x-rate-limit-remaining') ?? NaN);
      const reset = Number(response.headers.get('x-rate-limit-reset') ?? NaN);
      if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(reset)) {
        rateLimitResetAt = reset * 1000;
        deps.logger.warn('X rate limit nearly exhausted; backing off', {
          resetAt: new Date(rateLimitResetAt).toISOString(),
        });
      }

      if (response.status === 429) {
        if (Number.isFinite(reset)) rateLimitResetAt = reset * 1000;
        throw new Error('HTTP 429 rate limited');
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  function handleOf(source: Source): string {
    return (source.handle ?? '').replace(/^@/, '').trim();
  }

  async function resolveUser(source: Source): Promise<{ id: string; name: string }> {
    const handle = handleOf(source);
    const cached = userIds.get(handle.toLowerCase());
    if (cached) return cached;

    const body = await call<{ data?: { id: string; name: string; username: string } }>(
      `/users/by/username/${encodeURIComponent(handle)}?user.fields=name,username`,
    );
    if (!body.data?.id) throw new Error(`handle @${handle} did not resolve`);

    const resolved = { id: body.data.id, name: body.data.name };
    userIds.set(handle.toLowerCase(), resolved);
    return resolved;
  }

  async function pollOne(source: Source): Promise<{ posts: RawPost[]; itemCount: number }> {
    const user = await resolveUser(source);
    const since = sinceIds.get(source.id);

    const params = new URLSearchParams({
      max_results: String(MAX_RESULTS),
      'tweet.fields': 'created_at,entities,referenced_tweets,note_tweet',
      exclude: 'replies',
    });
    if (since) params.set('since_id', since);

    const body = await call<{ data?: TweetPayload[]; meta?: { newest_id?: string } }>(
      `/users/${user.id}/tweets?${params.toString()}`,
    );

    const tweets = body.data ?? [];
    if (body.meta?.newest_id) sinceIds.set(source.id, body.meta.newest_id);

    const ingestionTime = isoNow();
    const isFirstPoll = !since;

    const posts = tweets.map((tweet) => {
      const referenced = tweet.referenced_tweets ?? [];
      const isRetweet = referenced.some((r) => r.type === 'retweeted');
      const isQuote = referenced.some((r) => r.type === 'quoted');

      return {
        sourceId: source.id,
        sourcePostId: tweet.id,
        originalUrl: `https://x.com/${handleOf(source)}/status/${tweet.id}`,
        author: source.handle,
        // note_tweet carries the untruncated body of a long post.
        text: tweet.note_tweet?.text || tweet.text,
        eventTime: tweet.created_at ?? ingestionTime,
        ingestionTime,
        meta: {
          publishedAt: tweet.created_at ?? null,
          isRetweet,
          isQuote,
          cashtags: (tweet.entities?.cashtags ?? []).map((c) => c.tag),
          hashtags: (tweet.entities?.hashtags ?? []).map((h) => h.tag),
          urls: (tweet.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url).filter(Boolean),
        },
      } satisfies RawPost;
    });

    posts.sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime));

    // The first poll seeds since_id. It emits only genuinely fresh posts, so a
    // cold start does not replay a timeline but a restart mid-event still
    // catches what landed in the gap.
    return {
      posts: isFirstPoll
        ? posts.filter((p) => Date.now() - Date.parse(p.eventTime) <= FIRST_POLL_MAX_AGE_MS)
        : posts,
      itemCount: tweets.length,
    };
  }

  return {
    type: 'x',

    async poll(sources: Source[]): Promise<IngestResult> {
      const result: IngestResult = { posts: [], outcomes: [] };
      if (sources.length === 0) return result;

      if (!deps.bearerToken) {
        // Explicitly a failure, not silence — see §23.
        for (const source of sources) {
          result.outcomes.push({
            sourceId: source.id,
            ok: false,
            itemCount: 0,
            error: 'X_BEARER_TOKEN is not configured; this source is disconnected, not quiet',
            latencyMs: 0,
          });
        }
        return result;
      }

      // Spend the budget on the highest-priority accounts first, but rotate the
      // starting point so lower-priority accounts are not starved forever when
      // the budget cannot cover every source on a single tick.
      const byPriority = [...sources].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
      const offset = byPriority.length > 0 ? rotation % byPriority.length : 0;
      const ordered = [...byPriority.slice(offset), ...byPriority.slice(0, offset)];
      rotation = (rotation + 1) % Math.max(1, byPriority.length);

      const skipped: string[] = [];

      for (const source of ordered) {
        const started = Date.now();

        if (budgetRemaining() <= 1) {
          // Deliberately NOT reported as a failed poll. Skipping to stay inside
          // the rate limit is a decision Scout made, not a feed that broke, and
          // recording it as a failure would drive healthy sources to
          // DISCONNECTED and flood the system channel with false alarms.
          skipped.push(source.id);
          continue;
        }

        try {
          const { posts, itemCount } = await pollOne(source);
          result.posts.push(...posts);
          result.outcomes.push({
            sourceId: source.id,
            ok: true,
            itemCount,
            latencyMs: Date.now() - started,
          });
        } catch (err) {
          deps.logger.warn('x poll failed', { sourceId: source.id, err: err as Error });
          result.outcomes.push({
            sourceId: source.id,
            ok: false,
            itemCount: 0,
            error: (err as Error).message,
            latencyMs: Date.now() - started,
          });
        }
      }

      if (skipped.length > 0) {
        deps.logger.debug('skipped sources to stay inside the X rate limit', {
          skipped: skipped.length,
          budgetRemaining: budgetRemaining(),
        });
      }
      return result;
    },

    /** §29 — confirm the handle actually resolves before trusting it. */
    async verify(source: Source): Promise<SourceVerification> {
      const handle = handleOf(source);
      if (!handle) return { sourceId: source.id, ok: false, detail: 'no handle configured' };
      if (!deps.bearerToken) {
        return {
          sourceId: source.id,
          ok: false,
          detail: 'cannot verify: X_BEARER_TOKEN is not configured',
        };
      }
      try {
        const user = await resolveUser(source);
        return {
          sourceId: source.id,
          ok: true,
          resolvedId: user.id,
          resolvedName: user.name,
          detail: `@${handle} → ${user.name} (${user.id})`,
        };
      } catch (err) {
        return { sourceId: source.id, ok: false, detail: (err as Error).message };
      }
    },
  };
}
