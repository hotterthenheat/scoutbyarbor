import type { RawPost } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import { isoNow, minutesBetween } from '../util/time.js';
import { isAllowedAccount, parsePostUrl } from './urls.js';
import { RetrievalError, type PostResolver } from './resolver.js';
import type { Job, JobQueue, SourceKind } from './queue.js';
import type { RelayedMessage } from './discordListener.js';

/**
 * Turns a detected URL into a pipeline post.
 *
 *   detect → allowlist → dedupe → resolve → persist → pipeline
 *
 * The two rules that carry the most weight:
 *
 *   - A post is identified by `x:<post_id>`, so the same item relayed through
 *     five channels, twice in one channel, or again after a restart produces
 *     exactly one event.
 *   - `publishedAt` is null when the real publication time is unknown, and the
 *     Discord receive time is never substituted for it. Freshness for the
 *     trading feed is judged on publication time alone, so an old headline
 *     resurfacing cannot create a new trading event.
 */

/**
 * Holds the relaying message alongside its post id so the resolver chain can
 * fall back to content that already arrived with the link.
 *
 * Bounded: a 24/7 process cannot keep every message it has ever seen. Oldest
 * entries are evicted first, and an evicted entry simply means the relay
 * fallback is unavailable for that post — never a crash.
 */
export interface RelayStore {
  put(message: RelayedMessage): void;
  get(canonicalId: string): RelayedMessage | null;
  drop(canonicalId: string): void;
  size(): number;
}

export function createRelayStore(maxEntries = 500): RelayStore {
  const entries = new Map<string, RelayedMessage>();
  return {
    put(message: RelayedMessage): void {
      const key = message.url.canonicalId;
      // Re-inserting moves the key to the end of the iteration order, which is
      // what makes the eviction below least-recently-added.
      entries.delete(key);
      entries.set(key, message);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get: (canonicalId) => entries.get(canonicalId) ?? null,
    drop: (canonicalId) => void entries.delete(canonicalId),
    size: () => entries.size,
  };
}

export interface UrlWorkerDeps {
  db: ScoutDb;
  queue: JobQueue;
  resolver: PostResolver;
  logger: Logger;
  allowedAccounts: string[];
  /** Shared with the relay resolver so both see the same payloads. */
  relayStore: RelayStore;
  /** Source id these posts are attributed to for scoring/health purposes. */
  relaySourceId: string;
  onPost: (post: RawPost, context: UrlPostContext) => Promise<void>;
}

export interface UrlPostContext {
  postId: string;
  sourceKind: SourceKind;
  sourceChannelId: string | null;
  discordReceivedAt: string | null;
  publishedAt: string | null;
  retrievalSource: string;
}

export interface UrlWorker {
  /** Called by the Discord listener for each detected URL. */
  submit(message: RelayedMessage): void;
  /** The queue handler. Wired into createJobQueue. */
  handle(job: Job): Promise<void>;
}

export function createUrlWorker(deps: UrlWorkerDeps): UrlWorker {
  const { db, logger } = deps;

  const relayed = deps.relayStore;

  function submit(message: RelayedMessage): void {
    const { url } = message;

    // §13 — arbitrary URLs from arbitrary users must not become trading alerts.
    if (!isAllowedAccount(url.username, deps.allowedAccounts)) {
      logger.debug('url ignored, account not on the allowlist', {
        handle: url.username,
        postId: url.canonicalId,
      });
      return;
    }

    // Already resolved in a previous run — the durable dedupe layer.
    if (db.posts.exists(url.canonicalId)) {
      logger.debug('url already processed', { postId: url.canonicalId });
      return;
    }

    relayed.put(message);

    const job = deps.queue.enqueue({
      postId: url.canonicalId,
      url: url.canonicalUrl,
      sourceChannel: message.sourceChannelId,
      sourceKind: message.sourceKind,
    });

    if (!job) {
      logger.debug('url already queued', { postId: url.canonicalId });
      return;
    }
    logger.info('queued post for resolution', {
      postId: url.canonicalId,
      kind: message.sourceKind,
    });
  }

  async function handle(job: Job): Promise<void> {
    const url = parsePostUrl(job.url);
    if (!url) {
      throw Object.assign(new Error(`unparseable url: ${job.url}`), { retriable: false });
    }

    const context = relayed.get(job.postId);

    let resolved;
    try {
      resolved = await deps.resolver.resolve(url);
    } catch (err) {
      const error = err as RetrievalError;
      // A permanently failed job will never be retried, so its relay payload is
      // dead weight — drop it rather than leaking it for the life of the process.
      if (error.retriable === false) relayed.drop(job.postId);
      // Surface retriability to the queue so a rate limit backs off but a
      // deleted post does not spin.
      throw Object.assign(new Error(error.message), { retriable: error.retriable ?? true });
    }

    // A resolver that returned nothing usable is a failed retrieval, not an
    // empty news item.
    if (!resolved.text.trim()) {
      relayed.drop(job.postId);
      throw Object.assign(new Error('resolved post had no text'), { retriable: false });
    }

    const discordReceivedAt = context?.receivedAt ?? null;
    const createdAt = isoNow();

    db.posts.upsert({
      ...resolved,
      platform: url.platform,
      // A relayed post has no upstream service in front of it; the webhook path
      // is what fills this in.
      upstreamSource: null,
      receivedAt: discordReceivedAt ?? createdAt,
      discordReceivedAt,
      createdAt,
    });

    // eventTime orders the pipeline and must always be a real timestamp, but
    // publishedAt stays null when the true publication time is unknown — the
    // distinction is what the freshness gate reads.
    const eventTime = resolved.publishedAt ?? discordReceivedAt ?? createdAt;

    const post: RawPost = {
      sourceId: deps.relaySourceId,
      sourcePostId: resolved.postId,
      originalUrl: resolved.canonicalUrl,
      author: resolved.authorHandle,
      text: resolved.text,
      eventTime,
      ingestionTime: discordReceivedAt ?? createdAt,
      meta: {
        postId: resolved.postId,
        publishedAt: resolved.publishedAt,
        publishedAtKnown: resolved.publishedAt !== null,
        retrievalSource: resolved.retrievalSource,
        sourceKind: job.sourceKind,
        sourceChannelId: job.sourceChannel,
        relayHandle: url.username,
      },
    };

    await deps.onPost(post, {
      postId: resolved.postId,
      sourceKind: job.sourceKind,
      sourceChannelId: job.sourceChannel,
      discordReceivedAt,
      publishedAt: resolved.publishedAt,
      retrievalSource: resolved.retrievalSource,
    });

    relayed.drop(job.postId);
  }

  return { submit, handle };
}

/**
 * Freshness gate for the downstream trading feed (§12).
 *
 * Scout may still display an old post in #scout-news, but a headline whose
 * publication time is unknown or outside the window must never be handed on as
 * a fresh trading event — that is how a recycled headline creates a new
 * blackout.
 */
export function isFreshForTrading(
  publishedAt: string | null,
  maxAgeMinutes: number,
  now: string = isoNow(),
): { fresh: boolean; reason: string } {
  if (!publishedAt) {
    return { fresh: false, reason: 'publication time unknown' };
  }
  const ageMinutes = minutesBetween(publishedAt, now);
  if (ageMinutes > maxAgeMinutes) {
    return { fresh: false, reason: `published ${Math.round(ageMinutes)}m ago, limit ${maxAgeMinutes}m` };
  }
  if (ageMinutes < -5) {
    return { fresh: false, reason: 'publication time is in the future' };
  }
  return { fresh: true, reason: `published ${Math.round(ageMinutes)}m ago` };
}
