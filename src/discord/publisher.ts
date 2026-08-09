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

    // Nothing backend-only may appear in a user-facing alert.
    assertNoLeakedMetadata(content, [
      outcome.newsEvent.author ?? '',
      outcome.newsEvent.originalUrl ?? '',
      outcome.raw.sourceName ?? '',
      outcome.raw.handle ?? '',
    ]);

    const cluster = outcome.cluster;

    // A superseding development edits what is already on screen.
    if (outcome.supersedes && cluster) {
      const existing = db.discordMessages.forEvent(cluster.id);
      if (existing.length > 0) {
        let edited = 0;
        for (const record of existing) {
          if (await discord.edit(record.channelId, record.messageId, content)) edited++;
        }
        if (edited > 0) {
          logger.info('superseded in place', { eventId: cluster.id, edited });
          recordLatency(outcome);
          return { channels: existing.map((e) => e.channelKey), messageIds };
        }
      }
    }

    // A non-superseding development in an existing cluster is not worth a
    // second alert — it is already represented by the message on screen.
    if (!outcome.isNewCluster && !outcome.supersedes && cluster) {
      const existing = db.discordMessages.forEvent(cluster.id);
      if (existing.length > 0) {
        logger.debug('development folded into existing cluster', { eventId: cluster.id });
        return { channels: [], messageIds };
      }
    }

    const sentChannels: string[] = [];
    for (const channelKey of outcome.route.channels as ChannelKey[]) {
      const sent = await discord.send(channelKey, content);
      if (!sent) continue;

      sentChannels.push(channelKey);
      messageIds[channelKey] = sent.messageId;

      db.discordMessages.insert({
        id: newId(),
        eventId: cluster?.id ?? null,
        newsEventId: outcome.newsEvent.id,
        channelKey,
        channelId: sent.channelId,
        messageId: sent.messageId,
        threadId: null,
        sentAt: isoNow(),
      });
    }

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
