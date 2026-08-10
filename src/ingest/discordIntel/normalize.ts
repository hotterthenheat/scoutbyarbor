import type { RawPost } from '../../core/types.js';
import type {
  DiscordAuthorConfig,
  DiscordChannelConfig,
  DiscordMessageEnvelope,
} from './types.js';

/**
 * Discord message → RawPost.
 *
 * The output goes into the same pipeline every other source uses, so this file
 * does normalization ONLY: no classification, no scoring, no routing decisions.
 * Whether a message becomes an alert is decided downstream by exactly the same
 * code that decides it for an X post.
 */

/** Canonical id, and the dedupe key: `discord:<messageId>`. */
export function canonicalDiscordId(messageId: string): string {
  return `discord:${messageId.trim()}`;
}

/** The permalink. Real, useful for audit, never rendered into an alert. */
export function discordMessageUrl(envelope: DiscordMessageEnvelope): string {
  const guild = envelope.guildId ?? '@me';
  return `https://discord.com/channels/${guild}/${envelope.channelId}/${envelope.messageId}`;
}

/**
 * Publication time, or null.
 *
 * Precedence, most authoritative first:
 *
 *   1. An embed's own timestamp. A relay bot posting a market alert usually
 *      stamps the embed with the UPSTREAM event time, which is closer to when
 *      the information actually existed than when the bot posted it.
 *   2. The message timestamp — when it was published to the channel.
 *
 * Both are times a source genuinely stated. `receivedAt` is NOT in this list
 * and must never enter it: it is when Scout heard about the message, and using
 * it would make every message look seconds old regardless of age, which is
 * precisely the failure the freshness gate exists to catch.
 *
 * Returns null when the bridge supplied no timestamp at all. Null is a correct
 * answer; a fabricated one is not.
 */
export function publicationTimeOf(envelope: DiscordMessageEnvelope): string | null {
  for (const embed of envelope.embeds) {
    const stamped = asIso(embed.timestamp);
    if (stamped) return stamped;
  }
  return asIso(envelope.timestamp);
}

function asIso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Flattens a message into the text the pipeline reads.
 *
 * Bot feeds put almost everything in embeds, so ignoring them would hand the
 * classifier an empty string and reject every alert as contentless. Order is
 * reading order — content, then each embed's title, description and fields —
 * because the normalizer downstream treats the first line as the headline.
 */
export function flattenMessage(envelope: DiscordMessageEnvelope): string {
  const parts: string[] = [];

  const content = envelope.content.trim();
  if (content) parts.push(content);

  for (const embed of envelope.embeds) {
    const title = embed.title?.trim();
    const description = embed.description?.trim();
    if (title) parts.push(title);
    if (description) parts.push(description);

    for (const field of embed.fields) {
      const name = field.name?.trim();
      const value = field.value?.trim();
      if (!name && !value) continue;
      // "STRIKE: 450C" reads as one statement to the classifier; two orphaned
      // fragments do not.
      parts.push(name && value ? `${name}: ${value}` : (name || value) ?? '');
    }
  }

  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
}

export interface NormalizeInput {
  envelope: DiscordMessageEnvelope;
  channel: DiscordChannelConfig;
  /** The matched author entry, when the channel configures an allowlist. */
  author: DiscordAuthorConfig | null;
}

/**
 * Builds the RawPost. Everything Discord-specific lives in `meta`, which is
 * retained verbatim in `raw_posts` for audit and surfaced in `#scout-raw`.
 */
export function toRawPost(input: NormalizeInput): RawPost {
  const { envelope, channel, author } = input;

  const publishedAt = publicationTimeOf(envelope);
  const text = flattenMessage(envelope);

  return {
    sourceId: channel.sourceId,
    sourcePostId: canonicalDiscordId(envelope.messageId),
    originalUrl: discordMessageUrl(envelope),
    author: envelope.authorName,
    text,
    // Orders the pipeline, so it must always be a real timestamp. Falls back to
    // receipt time by design — which is exactly why publishedAt below does not.
    eventTime: publishedAt ?? envelope.receivedAt,
    ingestionTime: envelope.receivedAt,
    meta: {
      // Read with no fallback by the freshness gate. Null when genuinely
      // unknown, and the receipt time is never promoted into it.
      publishedAt,
      publishedAtKnown: publishedAt !== null,

      provenance: 'discord',
      platform: 'discord',
      retrievalSource: 'discord-intel',

      messageId: envelope.messageId,
      channelId: envelope.channelId,
      channelName: envelope.channelName,
      guildId: envelope.guildId,
      authorId: envelope.authorId,
      authorName: envelope.authorName,
      isBot: envelope.isBot,
      editedTimestamp: envelope.editedTimestamp,
      messageTimestamp: envelope.timestamp,
      discordReceivedAt: envelope.receivedAt,

      configuredSource: channel.sourceId,
      configuredAuthor: author?.name ?? null,

      // Retained verbatim for audit. Never rendered into an alert — the
      // renderer takes a four-field RenderableAlert and structurally cannot
      // carry any of it.
      embeds: envelope.embeds,
      attachments: envelope.attachments,
      rawContent: envelope.content,
    },
  };
}
