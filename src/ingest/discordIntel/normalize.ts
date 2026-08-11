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
 *   2. The ORIGINAL message's timestamp, when the message was forwarded into an
 *      intake channel. Forwarding is a hop, not a publication: a headline
 *      forwarded an hour late was still published an hour ago, and treating the
 *      forward time as publication would hand the freshness gate a fresh event
 *      every time someone catches up on their reading.
 *   3. The message timestamp — when it was published to the channel.
 *
 * All three are times a source genuinely stated. `receivedAt` is NOT in this list
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
  const original = asIso(envelope.relay?.origin.timestamp ?? null);
  if (original) return original;
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

  const joined = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');

  return cleanText(joined);
}

const UNWANTED_TEXT = [
  "Sent via Icarus | Arbor Capital — For information and data display only. Trade at your own risk.",
  "Sent via Icarus | Arbor Capital — For information and data display only.",
  "scout by arbor capital",
  "scout by slayer terminal",
  "signal, not noise",
  "cut through the noise",
  "OpenBB Bot",
  "Owls Clanker",
  "clanker",
  "Unusual Whales Crier",
  "OwlsKeyLevelsBot",
  "APP —",
  "itszmj",
  "GEOPOLITICAL ALERT",
  "ECONOMIC ALERT",
  "MACRO ALERT"
];

function cleanText(text: string): string {
  let cleaned = text;

  // 1. Remove exact unwanted strings
  for (const unwanted of UNWANTED_TEXT) {
    const regex = new RegExp(unwanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    cleaned = cleaned.replace(regex, '');
  }

  // 2. Remove Discord timestamp tags and time prefixes, e.g. <T:1786435278:T> - or 11:01 AM -
  cleaned = cleaned.replace(/<t:\d+(?::[a-zA-Z])?>\s*[-—–:]?\s*/gi, '');
  cleaned = cleaned.replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)?\s*[-—–:]\s*/gi, '');

  // 3. Remove leading/trailing asterisks, hyphens, and whitespace
  cleaned = cleaned.replace(/^[\s*:-]+|[\s*:-]+$/g, '');

  return cleaned.trim();
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
  const relay = envelope.relay;

  // Who to credit.
  //
  // The account that carried a message into the intake channel is not its
  // source, so it is never promoted into the byline. When the original author
  // survived the hop, that is the byline; when it did not, the byline says so
  // and names the carrier as a carrier. "via X" is honest in a way that bare
  // "X" is not, and it reads correctly everywhere an author is displayed.
  const relayed = relay !== undefined && relay.method !== 'direct';
  const originalAuthor = relay?.authorPreserved ? relay.origin.author : null;
  const byline = relayed
    ? (originalAuthor ?? `unattributed via ${envelope.authorName}`)
    : envelope.authorName;

  return {
    sourceId: channel.sourceId,
    sourcePostId: canonicalDiscordId(envelope.messageId),
    originalUrl: relay?.origin.url ?? discordMessageUrl(envelope),
    author: cleanText(byline),
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

      // ── Relay provenance ────────────────────────────────────────────────
      //
      // Read by the provenance layer in preference to the fields above, so an
      // event names the feed that originally said it rather than the intake
      // channel it happened to arrive through. Every one of these is null when
      // the corresponding fact did not survive the hop; none is ever guessed.
      relayed,
      relayMethod: relay?.method ?? null,
      attributionPreserved: relay ? relay.authorPreserved : true,
      originPreserved: relay ? relay.originPreserved : true,
      relayNotes: relay?.notes ?? [],
      relayedAt: relay?.relayedAt ?? null,
      // The account that put it in the intake channel. A carrier, not a source.
      carrierName: relayed ? envelope.authorName : null,
      carrierId: relayed ? envelope.authorId : null,
      carrierIsBot: relayed ? envelope.isBot : null,

      originAuthor: originalAuthor,
      originAuthorId: relay?.origin.authorId ?? null,
      originChannel: relay?.origin.channelName ?? relay?.origin.channelId ?? null,
      originChannelId: relay?.origin.channelId ?? null,
      originServer: relay?.origin.guildName ?? relay?.origin.guildId ?? null,
      originGuildId: relay?.origin.guildId ?? null,
      originMessageId: relay?.origin.messageId ?? null,
      originMessageUrl: relay?.origin.url ?? null,
      originTimestamp: relay?.origin.timestamp ?? null,

      // Scout's own mailbox, kept separate from the origin above so the two are
      // never confused in an audit.
      intakeChannelId: relayed ? envelope.channelId : null,

      // Retained verbatim for audit. Never rendered into an alert — the
      // renderer takes a four-field RenderableAlert and structurally cannot
      // carry any of it.
      embeds: envelope.embeds,
      attachments: envelope.attachments,
      rawContent: envelope.content,
    },
  };
}
