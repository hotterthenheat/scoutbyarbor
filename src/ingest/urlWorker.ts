import type { RawPost } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import { isoNow, minutesBetween } from '../util/time.js';
import { isAllowedAccount, parsePostUrl } from './urls.js';
import { RetrievalError, type PostResolver } from './resolver.js';
import {
  serializeRelayPayload,
  parseRelayPayload,
  type Job,
  type JobQueue,
  type SourceKind,
} from './queue.js';
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
 * Relay content is durable, not cached.
 *
 * It used to live in a bounded in-memory map. That map was the ONLY copy of a
 * relayed post's text: the Discord listener subscribes to new messages and does
 * no history scraping, so a message Scout has seen once is gone. A restart
 * therefore left a persisted job row that could never be completed — the
 * resolver chain would find nothing, fail non-retriably, and an accepted news
 * item would vanish with a single log line.
 *
 * The payload now goes into the job row itself, in the same INSERT, so a queued
 * job is recoverable entirely from SQLite. There is no cache to diverge from
 * it and no eviction policy to reason about.
 */

export interface UrlWorkerDeps {
  db: ScoutDb;
  queue: JobQueue;
  resolver: PostResolver;
  logger: Logger;
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

  function submit(message: RelayedMessage): void {
    const { url } = message;

    // Already resolved in a previous run — the durable dedupe layer.
    if (db.posts.exists(url.canonicalId)) {
      logger.debug('url already processed', { postId: url.canonicalId });
      return;
    }

    // The content goes down with the job, in one statement. The post is not
    // "accepted" until both are on disk — there is no window in which a row
    // exists whose payload lives only in this process.
    const job = deps.queue.enqueue({
      postId: url.canonicalId,
      url: url.canonicalUrl,
      sourceChannel: message.sourceChannelId,
      sourceKind: message.sourceKind,
      relayPayload: serializeRelayPayload({
        v: 1,
        rawMessage: message.rawMessage,
        receivedAt: message.receivedAt,
        canonicalUrl: url.canonicalUrl,
      }),
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

    // Read off the job row, which came from SQLite. A job recovered after a
    // restart is therefore indistinguishable from one processed immediately.
    const payload = parseRelayPayload(job.relayPayload);

    let resolved;
    try {
      // The id the job was queued under is passed through. For a webhook event
      // that id came from the relay's own payload and is what the content was
      // stored against; deriving one from the URL instead would miss it and
      // send an event Scout already holds to an external resolver.
      resolved = await deps.resolver.resolve(url, { postId: job.postId });
    } catch (err) {
      const error = err as RetrievalError;
      // The payload deliberately stays on the row. A failed job is exactly the
      // one that may still be retried or reopened by a later relay of the same
      // post, and it is the queue that releases the payload, on success only.
      throw Object.assign(new Error(error.message), { retriable: error.retriable ?? true });
    }

    // A resolver that returned nothing usable is a failed retrieval, not an
    // empty news item.
    if (!resolved.text.trim()) {
      throw Object.assign(new Error('resolved post had no text'), { retriable: false });
    }

    // When Scout saw it — never the publication time. Preserved across a
    // restart because it travels with the payload rather than in memory.
    const discordReceivedAt = payload?.receivedAt || null;
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
    // The payload is released by the queue when it marks the job DONE — after
    // this returns, and only on success.
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
/**
 * The reason string used when publication time was never known. Exported so
 * the metrics layer can tell that case apart from a genuinely stale event —
 * "the upstream source stopped sending timestamps" and "Sprout was down long
 * enough for news to age out" are different problems with different fixes.
 */
export const UNKNOWN_PUBLICATION_TIME = 'publication time unknown';

export function isFreshForTrading(
  publishedAt: string | null,
  maxAgeMinutes: number,
  now: string = isoNow(),
): { fresh: boolean; reason: string } {
  if (!publishedAt) {
    return { fresh: false, reason: UNKNOWN_PUBLICATION_TIME };
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
