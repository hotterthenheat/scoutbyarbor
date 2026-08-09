import type { Logger } from '../util/logger.js';
import type { DetectedUrl } from './urls.js';
import { parseRelayContent, hasUsableContent } from './relayParser.js';

/**
 * PostResolver — the retrieval abstraction.
 *
 * The rest of Scout does not care how a post's content was obtained, and no
 * module outside this file mentions an API credential. That is what lets the
 * provider change without touching the pipeline.
 *
 * Provider order is deliberate: the relay's own content comes FIRST. When a
 * permitted relay already carries the text, using it is faster than a second
 * upstream request and needs no credential at all — which is why Scout runs
 * fully on the relay path and treats an API resolver as an optional fallback
 * rather than a prerequisite.
 *
 * On access: any API provider here uses only the platform's documented
 * interface with credentials the operator supplies. There is deliberately
 * nothing that works around authentication, CAPTCHAs, rate limits, robots rules
 * or paid-tier restrictions — when the configured method cannot retrieve a
 * post, the job ends as FAILED_RETRIEVAL and the event is preserved for retry
 * and diagnostics. Retrieval stays subject to whatever terms govern the method
 * actually in use.
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
      // The timer must stay armed until the BODY has been read. Clearing it
      // after fetch() resolves leaves the read unbounded, and a server that
      // stalls mid-body hangs this worker until the process restarts.
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

      try {
        return await resolveWithin(controller, url, params, deps);
      } catch (err) {
        if (err instanceof RetrievalError) throw err;
        const aborted = (err as Error).name === 'AbortError';
        throw new RetrievalError(
          aborted ? `timed out after ${deps.timeoutMs}ms` : (err as Error).message,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function resolveWithin(
  controller: AbortController,
  url: DetectedUrl,
  params: URLSearchParams,
  deps: XApiResolverDeps,
): Promise<ResolvedPost> {
  const response = await fetch(`https://api.x.com/2/tweets/${url.postId}?${params.toString()}`, {
      headers: { authorization: `Bearer ${deps.bearerToken}`, accept: 'application/json' },
      signal: controller.signal,
  });

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
  /** The relaying message exactly as it arrived, headers and all. */
  rawMessage: string;
}

/**
 * The primary resolver. Reads the content the permitted relay already posted
 * alongside the link, so no upstream request happens at all.
 */
export function createRelayResolver(lookup: (url: DetectedUrl) => RelayPayload | null): PostResolver {
  return {
    name: 'discord-relay',
    available: () => true,

    async resolve(url: DetectedUrl): Promise<ResolvedPost> {
      const payload = lookup(url);
      if (!payload?.rawMessage?.trim()) {
        // Not retriable: a message that carried only a bare link will never
        // carry more. The next provider in the chain gets its turn.
        throw new RetrievalError('the relay message carried only a link', false);
      }

      const parsed = parseRelayContent(payload.rawMessage, url);
      if (!hasUsableContent(parsed)) {
        throw new RetrievalError('the relay message carried no usable text', false);
      }

      return {
        postId: url.canonicalId,
        author: parsed.author,
        authorHandle: parsed.authorHandle,
        text: parsed.text,
        // Null unless the relay genuinely stated a publication time. The relay's
        // own message time is when Scout heard about the post, not when it was
        // published.
        publishedAt: parsed.publishedAt,
        canonicalUrl: url.canonicalUrl,
        media: [],
        retrievalSource: 'discord-relay',
      };
    },
  };
}

/**
 * Reads content already persisted by an earlier stage. The webhook path stores
 * the event before queueing it, so this resolver returns it without any
 * retrieval at all — which is what lets a pushed event and a relayed one run
 * through one identical processor rather than two.
 */
export function createStoredPostResolver(
  lookup: (canonicalId: string) => StoredContent | null,
): PostResolver {
  return {
    name: 'stored',
    available: () => true,

    async resolve(url: DetectedUrl): Promise<ResolvedPost> {
      const stored = lookup(url.canonicalId);
      if (!stored?.text?.trim()) {
        throw new RetrievalError('no stored content for this post', false);
      }
      return {
        postId: url.canonicalId,
        author: stored.author,
        authorHandle: stored.authorHandle,
        text: stored.text,
        // Passed through untouched, including null.
        publishedAt: stored.publishedAt,
        canonicalUrl: stored.canonicalUrl || url.canonicalUrl,
        media: [],
        retrievalSource: stored.retrievalSource,
      };
    },
  };
}

export interface StoredContent {
  author: string | null;
  authorHandle: string | null;
  text: string;
  publishedAt: string | null;
  canonicalUrl: string;
  retrievalSource: string;
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
