import type { Logger } from '../util/logger.js';
import type { DetectedUrl } from './urls.js';

/**
 * PostResolver — the retrieval abstraction.
 *
 * The rest of Scout does not care how a post's content was obtained, which is
 * what lets the provider be swapped later without touching the pipeline.
 *
 * On access: this only retrieves posts through the platform's own documented
 * API, using credentials the operator supplies. There is deliberately nothing
 * here that works around authentication, CAPTCHAs, rate limits, robots rules or
 * paid-tier restrictions — when the configured method cannot retrieve a post,
 * the job is marked FAILED_RETRIEVAL and that is the end of it. Retrieval stays
 * subject to whatever terms govern the method actually in use.
 */

export interface ResolvedPost {
  postId: string;
  author: string | null;
  authorHandle: string | null;
  text: string;
  /**
   * The genuine publication time, or null when it is unavailable. Callers must
   * NOT substitute the time Scout received the URL — an old headline arriving
   * now is not new news, and conflating the two is how a stale post creates a
   * fresh trading signal.
   */
  publishedAt: string | null;
  canonicalUrl: string;
  media: string[];
  retrievalSource: string;
}

export class RetrievalError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'RetrievalError';
  }
}

export interface PostResolver {
  readonly name: string;
  /** Whether this provider is usable with the current configuration. */
  available(): boolean;
  resolve(url: DetectedUrl): Promise<ResolvedPost>;
}

// ─────────────────────────────────────────────────────────────────────────────
// X API v2 provider
// ─────────────────────────────────────────────────────────────────────────────

export interface XApiResolverDeps {
  bearerToken: string;
  timeoutMs: number;
  logger: Logger;
}

export function createXApiResolver(deps: XApiResolverDeps): PostResolver {
  return {
    name: 'x-api-v2',

    available(): boolean {
      return Boolean(deps.bearerToken);
    },

    async resolve(url: DetectedUrl): Promise<ResolvedPost> {
      if (!deps.bearerToken) {
        throw new RetrievalError('X_BEARER_TOKEN is not configured', false);
      }

      const params = new URLSearchParams({
        'tweet.fields': 'created_at,entities,note_tweet,referenced_tweets,attachments',
        expansions: 'author_id',
        'user.fields': 'name,username',
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

      let response: Response;
      try {
        response = await fetch(`https://api.x.com/2/tweets/${url.postId}?${params.toString()}`, {
          headers: { authorization: `Bearer ${deps.bearerToken}`, accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = (err as Error).name === 'AbortError';
        throw new RetrievalError(
          aborted ? `timed out after ${deps.timeoutMs}ms` : (err as Error).message,
          true,
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429 || response.status >= 500) {
        throw new RetrievalError(`HTTP ${response.status} — retriable`, true);
      }
      if (response.status === 401 || response.status === 403) {
        // Not retriable and not something to work around: the credential simply
        // does not grant access to this post.
        throw new RetrievalError(`HTTP ${response.status} — not authorised for this post`, false);
      }
      if (response.status === 404) {
        throw new RetrievalError('post not found or deleted', false);
      }
      if (!response.ok) {
        throw new RetrievalError(`HTTP ${response.status} ${response.statusText}`, false);
      }

      const body = (await response.json()) as {
        data?: {
          id: string;
          text: string;
          created_at?: string;
          author_id?: string;
          note_tweet?: { text?: string };
        };
        includes?: { users?: Array<{ id: string; name: string; username: string }> };
        errors?: Array<{ detail?: string; title?: string }>;
      };

      if (!body.data) {
        const detail = body.errors?.[0]?.detail ?? body.errors?.[0]?.title ?? 'no data returned';
        throw new RetrievalError(detail, false);
      }

      const author = body.includes?.users?.find((u) => u.id === body.data?.author_id);

      return {
        postId: url.canonicalId,
        author: author?.name ?? null,
        authorHandle: author?.username ? `@${author.username}` : `@${url.username}`,
        text: body.data.note_tweet?.text || body.data.text,
        publishedAt: body.data.created_at ?? null,
        canonicalUrl: url.canonicalUrl,
        media: [],
        retrievalSource: 'x-api-v2',
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay-embed provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Some relays post the text alongside the link, and Discord itself expands the
 * link into an embed. When that content is already present in the message we
 * received, using it is free and involves no retrieval at all.
 *
 * The publication timestamp is the important caveat: unless the relay supplied
 * a genuine one, `publishedAt` stays null rather than borrowing the Discord
 * receive time.
 */
export interface RelayPayload {
  text: string;
  authorName?: string | null;
  authorHandle?: string | null;
  /** Only set when this is genuinely the original publication time. */
  publishedAt?: string | null;
}

export function createRelayResolver(lookup: (url: DetectedUrl) => RelayPayload | null): PostResolver {
  return {
    name: 'discord-relay-embed',
    available: () => true,

    async resolve(url: DetectedUrl): Promise<ResolvedPost> {
      const payload = lookup(url);
      if (!payload || !payload.text.trim()) {
        throw new RetrievalError('no relayed content accompanied the link', false);
      }
      return {
        postId: url.canonicalId,
        author: payload.authorName ?? null,
        authorHandle: payload.authorHandle ?? `@${url.username}`,
        text: payload.text,
        publishedAt: payload.publishedAt ?? null,
        canonicalUrl: url.canonicalUrl,
        media: [],
        retrievalSource: 'discord-relay-embed',
      };
    },
  };
}

/**
 * Tries each provider in order and returns the first success. Providers that
 * are unavailable (no credential) are skipped rather than counted as failures,
 * so a missing X token does not mask a working relay.
 */
export function createChainResolver(providers: PostResolver[], logger: Logger): PostResolver {
  return {
    name: 'chain',
    available: () => providers.some((p) => p.available()),

    async resolve(url: DetectedUrl): Promise<ResolvedPost> {
      const failures: string[] = [];
      let retriable = false;

      for (const provider of providers) {
        if (!provider.available()) {
          failures.push(`${provider.name}: unavailable`);
          continue;
        }
        try {
          return await provider.resolve(url);
        } catch (err) {
          const error = err as RetrievalError;
          if (error.retriable) retriable = true;
          failures.push(`${provider.name}: ${error.message}`);
          logger.debug('resolver provider failed', { provider: provider.name, err: error.message });
        }
      }

      throw new RetrievalError(`all providers failed — ${failures.join('; ')}`, retriable);
    },
  };
}
