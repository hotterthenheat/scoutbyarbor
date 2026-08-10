import type { RawPost } from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import type { Job } from '../queue.js';
import { createDiscordFilter, type DiscordFilter } from './filter.js';
import { toRawPost, canonicalDiscordId, discordMessageUrl } from './normalize.js';
import type { DiscordMessageEnvelope, DiscordSourcesFile } from './types.js';

/**
 * The Discord intelligence worker.
 *
 * Mirrors the URL worker's contract exactly — `accept()` durably queues, and
 * `handle()` is the queue's callback — so both sources share one queue, one
 * retry policy, one restart-recovery path and one processor. The only thing
 * that differs is the shape of what arrives.
 *
 * The message envelope is persisted as the job's `relay_payload`, in the same
 * INSERT that creates the job. A Discord message, like a relayed one, is seen
 * exactly once: whatever bridge delivered it will not deliver it again. So the
 * copy on disk is the only one that can exist by the time a recovered job runs.
 */

export const DISCORD_PAYLOAD_VERSION = 1;

interface StoredDiscordPayload {
  v: number;
  envelope: DiscordMessageEnvelope;
}

export function serializeDiscordPayload(envelope: DiscordMessageEnvelope): string {
  return JSON.stringify({ v: DISCORD_PAYLOAD_VERSION, envelope } satisfies StoredDiscordPayload);
}

/** Tolerant: an unparseable payload must fail the job, never crash the worker. */
export function parseDiscordPayload(raw: string | null): DiscordMessageEnvelope | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as Partial<StoredDiscordPayload>;
    const envelope = candidate.envelope;
    if (!envelope || typeof envelope.messageId !== 'string' || !envelope.channelId) return null;
    return envelope;
  } catch {
    return null;
  }
}

export interface DiscordIntelDeps {
  config: DiscordSourcesFile;
  logger: Logger;
  /** The same callback the URL worker uses. One processor, not two. */
  onPost: (post: RawPost) => Promise<void>;
}

export interface DiscordAcceptResult {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  reason: string;
}

export interface DiscordIntelWorker {
  filter: DiscordFilter;
  /**
   * Decides whether a message may be processed and, if so, returns everything
   * needed to queue it durably. Does NOT touch the pipeline — the transport
   * must be able to acknowledge without waiting for classification.
   */
  admit(envelope: DiscordMessageEnvelope):
    | { admitted: true; postId: string; url: string; payload: string }
    | { admitted: false; reason: string };
  /** The queue callback. */
  handle(job: Job): Promise<void>;
}

export function createDiscordIntelWorker(deps: DiscordIntelDeps): DiscordIntelWorker {
  const filter = createDiscordFilter(deps.config);

  return {
    filter,

    admit(envelope) {
      const decision = filter.accept(envelope);
      if (!decision.accepted) {
        deps.logger.debug('discord message rejected before queueing', {
          messageId: envelope.messageId,
          channelId: envelope.channelId,
          reason: decision.reason,
        });
        return { admitted: false, reason: decision.reason };
      }

      return {
        admitted: true,
        postId: canonicalDiscordId(envelope.messageId),
        url: discordMessageUrl(envelope),
        payload: serializeDiscordPayload(envelope),
      };
    },

    async handle(job: Job): Promise<void> {
      const envelope = parseDiscordPayload(job.relayPayload);
      if (!envelope) {
        // Nothing will make this resolvable: the message is not re-fetchable.
        // Fail it visibly rather than inventing content.
        throw Object.assign(
          new Error('discord job has no usable stored message payload'),
          { retriable: false },
        );
      }

      // Re-checked at processing time, not only at intake. Config can change
      // between a message being queued and being processed, and the allowlist
      // that matters is the one in force when it reaches the pipeline.
      const decision = filter.accept(envelope);
      if (!decision.accepted) {
        throw Object.assign(new Error(`no longer permitted: ${decision.reason}`), {
          retriable: false,
        });
      }

      const post = toRawPost({
        envelope,
        channel: decision.channel,
        author: decision.author,
      });

      if (!post.text.trim()) {
        throw Object.assign(new Error('discord message carried no usable text'), {
          retriable: false,
        });
      }

      await deps.onPost(post);
    },
  };
}
