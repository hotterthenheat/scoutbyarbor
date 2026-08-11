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

  let joined = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');

  // Strip Arbor Capital relay footers
  const footerRegex = /(?:_\*\s*)?(?:⚡\s*)?SENT VIA ICARUS[\s\S]*?Trade at your own risk\.?(?:\*_)?/gi;
  joined = joined.replace(footerRegex, '').trim();

  return joined;
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
  let text = flattenMessage(envelope);
  let relay = envelope.relay;

  // Custom fallback: extract python bot author from the text body, if present,
  // since the embed approach may not have been used or captured correctly.
  // Using /im to match even if preceded by other lines (e.g., "GEOPOLITICAL ALERT\n")
  const headerMatch = /^\s*\*{0,2}([a-zA-Z0-9_\s]{1,60})\s*(?::\s*\*{0,2}\s*(?:(?:<t:\d+:[a-zA-Z]>|\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-—–:]\s*)?|\s*\*{0,2}\s*(?:<t:\d+:[a-zA-Z]>|\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-—–:]\s*)/im.exec(text);
  if (headerMatch && headerMatch[1]) {
    const extractedAuthor = headerMatch[1].trim();
    // Remove ONLY the matched header prefix part from the text, preserving any preceding lines
    text = text.slice(0, headerMatch.index) + '\n' + text.slice(headerMatch.index + headerMatch[0].length);
    text = text.trim();
    if (!relay || relay.method === 'direct') {
      relay = {
        method: 'text_prefix',
        origin: {
          author: extractedAuthor,
          authorId: null,
          guildId: null,
          guildName: null,
          channelId: null,
          channelName: null,
          messageId: null,
          url: null,
          timestamp: null
        },
        originPreserved: false,
        authorPreserved: true,
        carrier: {
          id: envelope.authorId,
          name: envelope.authorName,
          isBot: envelope.isBot,
          isWebhook: false, // fallback
        },
        relayedAt: envelope.timestamp ?? envelope.receivedAt,
        notes: [],
      };
    } else if (relay.origin && relay.origin.author === null) {
      relay.origin.author = extractedAuthor;
      relay.authorPreserved = true;
    }
  }

  // Who to credit.
  // User explicitly requested to remove 'itszmj' and 'OpenBB Bot' from the final output, 
  // so we will intentionally suppress the byline for relayed discord messages.
  const relayed = relay !== undefined && relay.method !== 'direct';
  const originalAuthor = relay?.authorPreserved ? relay.origin.author : null;
  const byline = null;

  // User requested: "messages that are being sent from the foward channel will never have links so it does not have to be blue"
  // So if it's a relayed message without an explicit origin URL, do not fallback to the discordMessageUrl.
  const originalUrl = relay?.origin.url ?? (relayed ? null : discordMessageUrl(envelope));

  const unwantedText = [
    "Sent via Icarus | Arbor Capital — For information and data display only. Trade at your own risk.",
    "Sent via Icarus | Arbor Capital — For information and data display only.",
    "Scout by Arbor Capital",
    "signal, not noise",
    "OpenBB Bot",
    "Owls Clanker",
    "clanker",
    "Unusual Whales Crier",
    "OwlsKeyLevelsBot",
    "APP —"
  ];

  for (const unwanted of unwantedText) {
    const regex = new RegExp(unwanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(regex, '');
  }
  text = text.trim();

  return {
    sourceId: channel.sourceId,
    sourcePostId: canonicalDiscordId(envelope.messageId),
    originalUrl,
    author: byline,
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
