import type { ChannelKey, PipelineOutcome, RawChannelPayload } from '../core/types.js';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import type { ScoutDiscord } from './client.js';
import { renderAlert, renderAlertEmbed, assertNoLeakedMetadata } from '../render/alert.js';
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
  /** Signed at the bottom of every alert, after the outlet. */
  brandFooter?: string;
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

    // The story's own address, and the outlet that reported it. Both are facts
    // about the source rather than judgements Scout invented, which is why they
    // belong on the embed while the description stays exactly as guarded.
    const embed = renderAlertEmbed({
      alert: outcome.alert!,
      url: outcome.newsEvent.originalUrl,
      sourceLabel: sourceLabelFor(outcome),
      brandFooter: deps.brandFooter,
      // provenance.firstReportedAt, not newsEvent.timestamp: the latter falls
      // back to receipt time, and showing a receipt time as a publication time
      // is the substitution this project refuses to make everywhere else. It is
      // null when no contributor stated a time, and null is then what Discord
      // gets — no timestamp at all beats a wrong one.
      publishedAt: outcome.raw.provenance.firstReportedAt,
    });

    for (const channelKey of channels) {
      const sent = await discord.send(channelKey, content, embed);

      if (!sent) {
        // A send that failed used to be skipped in silence, so an event counted
        // as PUBLISHED while Discord received nothing — the wire looked healthy
        // and the channels stayed empty. The usual causes are a channel id the
        // bot cannot see and a missing Send Messages permission, and neither is
        // discoverable from a metric that says everything published.
        logger.error('DISCORD SEND FAILED — the alert did not reach the channel', {
          channelKey,
          newsEventId: outcome.newsEvent.id,
          hint:
            'is the bot in that server, can it see the channel, and does it have ' +
            'Send Messages there?',
        });
        db.deliveries.record({
          eventId: eventId ?? outcome.newsEvent.id,
          destination: channelKey,
          status: 'FAILED',
          discordMessageId: null,
          sentAt: null,
          error: 'discord send failed — channel unreachable or no permission',
          createdAt: isoNow(),
        });
        continue;
      }

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

      // Recorded for the same reason the failure above is: "published" has to
      // mean a channel actually received it.
      db.deliveries.record({
        eventId: eventId ?? outcome.newsEvent.id,
        destination: channelKey,
        status: 'SENT',
        discordMessageId: sent.messageId,
        sentAt: isoNow(),
        error: null,
        createdAt: isoNow(),
      });
    }
    return sentChannels;
  }

  /**
   * Who reported it, for the embed footer.
   *
   * The outlet's own name — CNBC, @DeItaone — never Scout's source id and never
   * an aggregator that merely carried it. Same rule as provenance: name the
   * reporter, not the pipe.
   */
  function sourceLabelFor(outcome: PipelineOutcome): string | null {
    // The provenance label already names the reporter rather than the pipe —
    // the outlet behind an aggregator, the account behind a relay — and reads
    // "CNBC + Reuters" when two of them reported the same story.
    const label = outcome.raw.provenance.label?.trim();
    if (!label || label === 'UNKNOWN') return null;

    const unwanted = [
      "Sent via Icarus | Arbor Capital — For information and data display only. Trade at your own risk.",
      "Sent via Icarus | Arbor Capital — For information and data display only.",
      "Scout by Arbor Capital",
      "signal, not noise",
      "OpenBB Bot",
      "Owls Clanker",
      "clanker",
      "Unusual Whales Crier",
      "OwlsKeyLevelsBot",
      "APP —",
      "itszmj"
    ];

    const lowerLabel = label.toLowerCase();
    for (const text of unwanted) {
      if (lowerLabel.includes(text.toLowerCase())) return null;
    }

    return label;
  }

  function recordLatency(outcome: PipelineOutcome): void {
    const discordTime = isoNow();
    const from = outcome.newsEvent.processedAt ?? outcome.newsEvent.latency.ingestionTime;
    db.metrics.recordLatency({
      newsEventId: outcome.newsEvent.id,
      sourceId: outcome.newsEvent.source,
      sourceToScoutMs: outcome.newsEvent.latency.sourceToScoutMs,
      // Always measurable: this is the part Scout is responsible for.
      scoutToDiscordMs: Math.max(0, msBetween(from, discordTime)),
      // End to end only means something when publication time was known. A null
      // sourceToScoutMs is exactly that signal, and newsEvent.timestamp falls
      // back to receipt time — so measuring from it would report Scout's own
      // few hundred milliseconds as the reader's total wait.
      totalMs:
        outcome.newsEvent.latency.sourceToScoutMs === null
          ? null
          : Math.max(0, msBetween(outcome.newsEvent.timestamp, discordTime)),
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
