import type { ChannelKey, PipelineOutcome, RawChannelPayload } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import type { ScoutDiscord } from './client.js';
import { renderAlert, assertNoLeakedMetadata } from '../render/alert.js';
import { renderRawEntry } from '../render/raw.js';
import { newId } from '../util/id.js';
import { isoNow, msBetween } from '../util/time.js';

/**
 * Delivery.
 *
 * Two behaviours here carry real product weight:
 *
 *   - Before anything is sent, the rendered string is checked against the
 *     post's actual handle and URL. If either appears, the send throws rather
 *     than leaking backend metadata into an alert (§3, §33).
 *   - When a development supersedes its cluster, the existing message is EDITED
 *     rather than a new one posted. That is §18's "the latest alert can
 *     supersede the previous one rather than flooding Discord".
 */

export interface Publisher {
  publish(outcome: PipelineOutcome): Promise<{ channels: string[]; messageIds: Record<string, string> }>;
  publishRaw(payload: RawChannelPayload): Promise<void>;
  publishSystem(message: string): Promise<void>;
}

export interface PublisherDeps {
  discord: ScoutDiscord;
  db: ScoutDb;
  logger: Logger;
  rawChannelEnabled: boolean;
}

export function createPublisher(deps: PublisherDeps): Publisher {
  const { discord, db, logger } = deps;

  async function publish(
    outcome: PipelineOutcome,
  ): Promise<{ channels: string[]; messageIds: Record<string, string> }> {
    const messageIds: Record<string, string> = {};
    if (!outcome.alert || !outcome.route) return { channels: [], messageIds };

    const content = renderAlert(outcome.alert);

    // Nothing Scout attached may appear in a user-facing alert. Deliberately
    // NOT the source's display name: wire services name themselves in real
    // headlines ("REUTERS: US, IRAN REACH AGREEMENT"), and treating that as a
    // leak would throw the story away instead of publishing it.
    try {
      assertNoLeakedMetadata(content, [
        outcome.newsEvent.author ?? '',
        outcome.newsEvent.originalUrl ?? '',
        outcome.raw.handle ?? '',
      ]);
    } catch (err) {
      // Refusing to publish is the correct outcome, but it must be loud: a
      // silently dropped alert is worse than a noisy one.
      logger.error('alert blocked by the metadata guard', {
        newsEventId: outcome.newsEvent.id,
        reason: (err as Error).message,
      });
      return { channels: [], messageIds };
    }

    const cluster = outcome.cluster;
    const routed = outcome.route.channels as ChannelKey[];

    // Channels this cluster already has a message in. A development only ever
    // edits those; the channels it does NOT have are still owed a first post.
    const existing = cluster ? db.discordMessages.forEvent(cluster.id) : [];
    const covered = new Set(existing.map((e) => e.channelKey));

    // This is the important part. An event's route can GROW between
    // developments — a story that was #scout-news only at importance 62 becomes
    // market-moving at 74 — and editing only what already exists would leave the
    // trading channels with nothing. That is precisely the failure the routing
    // rule exists to prevent, so anything newly routed gets a real post.
    const needsFirstPost = routed.filter((c) => !covered.has(c));

    if (outcome.supersedes && existing.length > 0) {
      const editedChannels: string[] = [];
      for (const record of existing) {
        if (await discord.edit(record.channelId, record.messageId, content)) {
          editedChannels.push(record.channelKey);
          messageIds[record.channelKey] = record.messageId;
        } else {
          // Report only what actually happened: claiming a delivery that failed
          // is worse than reporting the failure.
          logger.warn('supersede edit failed', {
            eventId: cluster?.id,
            channelKey: record.channelKey,
          });
        }
      }

      const sentNew = await sendTo(needsFirstPost, content, outcome, cluster?.id ?? null, messageIds);
      logger.info('superseded in place', {
        eventId: cluster?.id,
        edited: editedChannels.length,
        added: sentNew.length,
      });
      recordLatency(outcome);
      return { channels: [...editedChannels, ...sentNew], messageIds };
    }

    // A development that does not supersede adds nothing to the channels that
    // already carry the story — but a channel newly in scope has never seen it.
    if (!outcome.isNewCluster && !outcome.supersedes && existing.length > 0) {
      if (needsFirstPost.length === 0) {
        logger.debug('development folded into existing cluster', { eventId: cluster?.id });
        return { channels: [], messageIds };
      }
      const sentNew = await sendTo(needsFirstPost, content, outcome, cluster?.id ?? null, messageIds);
      logger.info('development reached newly routed channels', {
        eventId: cluster?.id,
        channels: sentNew,
      });
      recordLatency(outcome);
      return { channels: sentNew, messageIds };
    }

    const sentChannels = await sendTo(routed, content, outcome, cluster?.id ?? null, messageIds);

    const firstChannel = sentChannels[0];
    if (firstChannel) {
      const messageId = messageIds[firstChannel];
      if (messageId) db.newsEvents.setDiscordMessageId(outcome.newsEvent.id, messageId);
    }

    recordLatency(outcome);
    logger.info('published', {
      newsEventId: outcome.newsEvent.id,
      channels: sentChannels,
      score: Math.round(outcome.newsEvent.importance),
    });

    return { channels: sentChannels, messageIds };
  }

  /** Posts to each channel and records the delivery. Returns what actually sent. */
  async function sendTo(
    channels: ChannelKey[],
    content: string,
    outcome: PipelineOutcome,
    eventId: string | null,
    messageIds: Record<string, string>,
  ): Promise<string[]> {
    const sentChannels: string[] = [];

    for (const channelKey of channels) {
      const sent = await discord.send(channelKey, content);
      if (!sent) continue;

      sentChannels.push(channelKey);
      messageIds[channelKey] = sent.messageId;

      db.discordMessages.insert({
        id: newId(),
        eventId,
        newsEventId: outcome.newsEvent.id,
        channelKey,
        channelId: sent.channelId,
        messageId: sent.messageId,
        threadId: null,
        sentAt: isoNow(),
      });
    }
    return sentChannels;
  }

  function recordLatency(outcome: PipelineOutcome): void {
    const discordTime = isoNow();
    const from = outcome.newsEvent.processedAt ?? outcome.newsEvent.latency.ingestionTime;
    db.metrics.recordLatency({
      newsEventId: outcome.newsEvent.id,
      sourceId: outcome.newsEvent.source,
      sourceToScoutMs: outcome.newsEvent.latency.sourceToScoutMs,
      scoutToDiscordMs: Math.max(0, msBetween(from, discordTime)),
      totalMs: Math.max(0, msBetween(outcome.newsEvent.timestamp, discordTime)),
      recordedAt: discordTime,
    });
    db.metrics.record('alerts_sent', 1, {
      sourceId: outcome.newsEvent.source,
      category: outcome.newsEvent.category ?? undefined,
    });
  }

  async function publishRaw(payload: RawChannelPayload): Promise<void> {
    if (!deps.rawChannelEnabled) return;
    try {
      await discord.send('raw', renderRawEntry(payload));
    } catch (err) {
      // The debug channel must never be able to break the wire.
      logger.warn('raw channel publish failed', { err: err as Error });
    }
  }

  async function publishSystem(message: string): Promise<void> {
    try {
      await discord.send('system', message);
    } catch (err) {
      logger.warn('system channel publish failed', { err: err as Error });
    }
  }

  return { publish, publishRaw, publishSystem };
}
