import { MessageFlags, type Message } from 'discord.js';
import {
  parseRelay,
  type CrosspostOrigin,
  type ForwardSnapshot,
  type RelayCarrier,
} from './relay.js';
import type { DiscordAttachment, DiscordEmbed, DiscordMessageEnvelope } from './types.js';

/**
 * The intake channel.
 *
 * Scout's own bot sits in a channel the operator controls and treats what lands
 * there as intelligence. It needs nothing beyond ordinary permissions — View
 * Channel, Read Message History, Read Message Content, Send Messages — and the
 * MessageContent intent enabled in the developer portal.
 *
 * This is the whole of Scout's direct Discord reading. There is no user token,
 * no session cookie, no browser automation and no self-bot: Scout reads a
 * channel it was invited to, the way a bot is supposed to. Servers Scout is not
 * in stay unread, and the way to feed one in is to forward from it — which is
 * why the relay parser exists and why it is careful about attribution.
 *
 * Everything below is a mapping from Discord's message shape into Scout's
 * envelope. It makes no admission decision: the same allowlist, the same worker
 * and the same pipeline handle an intake message and a webhook-delivered one.
 */

/** Discord's forward reference type. 0 is a reply, 1 is a forward. */
const REFERENCE_TYPE_FORWARD = 1;

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toEmbeds(embeds: Message['embeds']): DiscordEmbed[] {
  return embeds.map((embed) => ({
    title: text(embed.title),
    description: text(embed.description),
    url: text(embed.url),
    timestamp: text(embed.timestamp),
    // The byline a relay bot stamps on. Read by the relay parser and, when it
    // names someone other than the poster, treated as the original author.
    author: text(embed.author?.name),
    footer: text(embed.footer?.text),
    fields: embed.fields.map((field) => ({ name: field.name, value: field.value })),
  }));
}

function toAttachments(attachments: Iterable<{
  id: string;
  name: string | null;
  url: string;
  contentType: string | null;
  size: number;
}>): DiscordAttachment[] {
  return [...attachments].map((a) => ({
    id: a.id,
    filename: text(a.name),
    url: a.url,
    contentType: text(a.contentType),
    size: a.size,
  }));
}

/**
 * A followed-announcement crosspost, when the message is one.
 *
 * This is the path worth configuring: the source server publishes to an
 * announcement channel, the operator follows it into a channel Scout can read,
 * and messages arrive automatically with their original author and a reference
 * back to the source. No forwarding by hand, no bot on the source server, and
 * no automation of anyone's personal account.
 */
function toCrosspost(message: Message): CrosspostOrigin | null {
  if (!message.flags?.has(MessageFlags.IsCrosspost)) return null;
  const reference = message.reference;
  return {
    channelId: reference?.channelId ?? null,
    guildId: reference?.guildId ?? null,
    messageId: reference?.messageId ?? null,
  };
}

/**
 * Discord's native forward, when the message is one.
 *
 * The snapshot carries content, embeds, attachments and the ORIGINAL timestamp
 * — and deliberately not the original author, which is the single most
 * important fact about this path. The reference supplies where it came from.
 */
function toForward(message: Message): ForwardSnapshot | null {
  const snapshot = message.messageSnapshots?.first();
  if (!snapshot) return null;

  const reference = message.reference;
  // A reply also carries a reference; only a forward carries a snapshot, so the
  // snapshot is what decides. The type check is belt and braces.
  if (reference && reference.type !== undefined && reference.type !== REFERENCE_TYPE_FORWARD) {
    return null;
  }

  return {
    content: snapshot.content ?? '',
    embeds: toEmbeds(snapshot.embeds ?? []),
    attachments: toAttachments(snapshot.attachments?.values() ?? []),
    timestamp: snapshot.createdTimestamp
      ? new Date(snapshot.createdTimestamp).toISOString()
      : null,
    editedTimestamp: snapshot.editedTimestamp
      ? new Date(snapshot.editedTimestamp).toISOString()
      : null,
    channelId: reference?.channelId ?? null,
    guildId: reference?.guildId ?? null,
    messageId: reference?.messageId ?? null,
  };
}

/**
 * A Discord message in an intake channel → Scout's envelope.
 *
 * `authorName` is always the account that POSTED IN THE INTAKE CHANNEL, because
 * that is what an author allowlist on an intake channel is asking about: who is
 * permitted to feed Scout. Who originally said the thing lives in `relay`, and
 * is null when the hop did not preserve it.
 */
export function envelopeFromMessage(
  message: Message,
  options: { receivedAt: string },
): DiscordMessageEnvelope {
  const carrier: RelayCarrier = {
    id: message.author?.id ?? null,
    name: message.author?.username ?? message.author?.displayName ?? 'unknown',
    isBot: Boolean(message.author?.bot),
    isWebhook: Boolean(message.webhookId),
  };

  const relayedAt = new Date(message.createdTimestamp).toISOString();

  const parsed = parseRelay({
    content: message.content ?? '',
    embeds: toEmbeds(message.embeds),
    attachments: toAttachments(message.attachments.values()),
    carrier,
    relayedAt,
    crosspost: toCrosspost(message),
    forward: toForward(message),
  });

  return {
    messageId: message.id,
    channelId: message.channelId,
    channelName: channelNameOf(message),
    guildId: message.guildId ?? null,
    authorId: carrier.id,
    authorName: carrier.name,
    isBot: carrier.isBot,
    content: parsed.content,
    embeds: parsed.embeds,
    attachments: parsed.attachments,
    // When the message was posted in the intake channel. The ORIGINAL
    // publication time, when a forward preserved it, is in `relay.origin` and is
    // what the freshness gate ends up reading.
    timestamp: relayedAt,
    editedTimestamp: message.editedTimestamp
      ? new Date(message.editedTimestamp).toISOString()
      : null,
    receivedAt: options.receivedAt,
    relay: parsed.attribution,
  };
}

function channelNameOf(message: Message): string | null {
  const channel = message.channel as { name?: string } | null;
  return text(channel?.name ?? null);
}
