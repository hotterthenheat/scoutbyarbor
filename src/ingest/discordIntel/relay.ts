import type { DiscordAttachment, DiscordEmbed } from './types.js';

/**
 * Recovering who ORIGINALLY said it.
 *
 * Scout's own bot watches an intake channel with ordinary permissions — View
 * Channel, Read Message History, Read Message Content, Send Messages. What lands
 * there is usually not original: it has been forwarded, quoted or re-posted by
 * something else. The thing that matters for provenance is the source at the far
 * end of that hop, not the account that carried it the last inch.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * The carrier is never labelled as the source. When the original author cannot
 * be recovered the answer is "unattributed", recorded as such, and the carrier
 * is named as a carrier. Scout does not guess a plausible author, and it does
 * not quietly promote the forwarding bot into the byline — a wrong attribution
 * on a trading alert is worse than an honest blank.
 *
 * ── WHAT SURVIVES A HOP ──────────────────────────────────────────────────────
 *
 * Discord's native forward is the awkward case and the common one. The API
 * sends a message snapshot carrying content, embeds, attachments and the
 * original timestamp — and deliberately NOT the original author. So a native
 * forward preserves WHERE and WHEN but not WHO, and this module reports exactly
 * that split rather than collapsing it into one boolean.
 *
 * Relay bots are the opposite: they usually stamp the original author onto the
 * embed and the origin into the footer, so both halves survive.
 *
 * Nothing here classifies, scores or routes. It answers one question — what do
 * we actually know about where this came from — and refuses to answer more.
 */

export type RelayMethod =
  /** Posted in the intake channel by its own author. Nothing to recover. */
  | 'direct'
  /**
   * Discord's own channel-following. The best case by a distance: automatic,
   * permitted, and it preserves the original author, server, channel and
   * message id. Nothing has to be forwarded by hand.
   */
  | 'crosspost'
  /** Discord's native forward. Origin and time preserved; author is not. */
  | 'forward_snapshot'
  /** A relay bot that stamped the original author onto the embed. */
  | 'embed_author'
  /** A textual header: `Forwarded from X in #y:`. */
  | 'text_prefix'
  /** Only a discord.com/channels/… permalink to go on: where, not who. */
  | 'message_link'
  /** Recognisably relayed, and nothing about the origin survived. */
  | 'unattributed';

/** What is known about the far end of the hop. Every field may be null. */
export interface RelayOrigin {
  author: string | null;
  authorId: string | null;
  guildId: string | null;
  guildName: string | null;
  channelId: string | null;
  channelName: string | null;
  messageId: string | null;
  /** When the ORIGINAL was posted, not when it was forwarded. */
  timestamp: string | null;
  url: string | null;
}

/** The account that placed the message into Scout's intake channel. */
export interface RelayCarrier {
  id: string | null;
  name: string;
  isBot: boolean;
  isWebhook: boolean;
}

export interface RelayAttribution {
  method: RelayMethod;
  /** True only when we know WHO said it. */
  authorPreserved: boolean;
  /** True when we know WHERE it was said, even if not by whom. */
  originPreserved: boolean;
  origin: RelayOrigin;
  carrier: RelayCarrier;
  /** When the carrier put it in the intake channel. Never a publication time. */
  relayedAt: string;
  /** Plain-language record of what was and was not recoverable. */
  notes: string[];
}

/** A Discord native forward, flattened. The author is absent because Discord omits it. */
export interface ForwardSnapshot {
  content: string;
  embeds: DiscordEmbed[];
  attachments: DiscordAttachment[];
  /** The ORIGINAL message's timestamp. */
  timestamp: string | null;
  editedTimestamp: string | null;
  /** From the message reference — the original location. */
  channelId: string | null;
  guildId: string | null;
  messageId: string | null;
}

/**
 * One intake message, described structurally rather than as a discord.js object
 * so this stays testable without a gateway connection or a mocked client.
 */
/**
 * Where a followed-announcement message came from.
 *
 * Discord's channel-following delivers the original message wearing the
 * original author's identity, with a reference back to the source. Present only
 * when the message actually carries the crosspost flag.
 */
export interface CrosspostOrigin {
  channelId: string | null;
  guildId: string | null;
  messageId: string | null;
}

export interface RelayCandidate {
  content: string;
  embeds: DiscordEmbed[];
  attachments: DiscordAttachment[];
  carrier: RelayCarrier;
  relayedAt: string;
  crosspost?: CrosspostOrigin | null;
  forward?: ForwardSnapshot | null;
}

export interface RelayParse {
  attribution: RelayAttribution;
  /** The text the pipeline reads, with any attribution header removed. */
  content: string;
  embeds: DiscordEmbed[];
  attachments: DiscordAttachment[];
}

const EMPTY_ORIGIN: RelayOrigin = {
  author: null,
  authorId: null,
  guildId: null,
  guildName: null,
  channelId: null,
  channelName: null,
  messageId: null,
  timestamp: null,
  url: null,
};

const MESSAGE_LINK =
  /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(@me|\d{5,25})\/(\d{5,25})\/(\d{5,25})/i;

/**
 * Textual attribution headers, most explicit first. Each captures an author and
 * optionally a channel, and each is anchored to the START of the message: a
 * handle appearing mid-sentence is a mention, not a byline.
 */
const TEXT_HEADERS: Array<{ re: RegExp; author: number; channel: number | null }> = [
  // Forwarded from Walter Bloomberg in #breaking-news:
  {
    re: /^\s*(?:>+\s*)?(?:forwarded|relayed|reposted|cross-?posted)\s+from[:\s]+\*{0,2}([^\n*|]{1,80}?)\*{0,2}(?:\s+in\s+#?([\w-]{1,100}))?\s*(?:[:—-]\s*|\n|$)/i,
    author: 1,
    channel: 2,
  },
  // **Walter Bloomberg** in #breaking-news:
  {
    re: /^\s*\*{2}([^\n*]{1,80})\*{2}\s+in\s+#([\w-]{1,100})\s*[:—-]?\s*/,
    author: 1,
    channel: 2,
  },
  // [#breaking-news] Walter Bloomberg:
  {
    re: /^\s*\[#([\w-]{1,100})\]\s*([^:\n]{1,80}):\s*/,
    author: 2,
    channel: 1,
  },
  // **Walter Bloomberg**: headline
  //
  // What a simple forwarding bot emits — `f"**{author.display_name}**: {text}"`
  // — and the loosest pattern here, since a bolded lead-in is also how a wire
  // writes `**BREAKING**:`. NOT_AN_AUTHOR below is what keeps the two apart.
  { re: /^\s*\*{2}([^\n*]{1,60})\*{2}\s*[:—-]\s+(?=\S)/, author: 1, channel: null },
  // @DeItaone: headline
  { re: /^\s*(@[A-Za-z0-9_.]{2,60})\s*[:—-]\s+/, author: 1, channel: null },
  // unusual_whales_crier:** headline
  { re: /^\s*([A-Za-z0-9_.-]{2,60})\s*:\*{2}\s+(?=\S)/, author: 1, channel: null },
];

/**
 * Words that lead a headline rather than name a source.
 *
 * `**BREAKING**: US CPI RISES 3.1%` is a wire convention, not a byline. Reading
 * it as one would invent an author called BREAKING *and* delete the word from
 * the headline — inventing attribution and losing content in one move.
 */
const NOT_AN_AUTHOR = new Set([
  'breaking',
  'alert',
  'urgent',
  'update',
  'updated',
  'live',
  'exclusive',
  'just in',
  'justin',
  'developing',
  'flash',
  'watch',
  'new',
  'news',
  'important',
  'reminder',
  'note',
  'headline',
  'market alert',
  'heads up',
  'psa',
  'fyi',
]);

/** `#breaking-news • Some Server` or `Some Server • #breaking-news`. */
const FOOTER_PARTS = /^\s*(.{1,120}?)\s*[•·|]\s*(.{1,120}?)\s*$/;

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function asIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Comparison key for "is this the same account", ignoring case and discriminator. */
function sameName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (v: string): string =>
    v.trim().toLowerCase().replace(/#\d{1,6}$/, '').replace(/^@/, '').trim();
  return norm(a) === norm(b);
}

function messageUrl(guildId: string | null, channelId: string | null, messageId: string | null): string | null {
  if (!channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${messageId}`;
}

/** Splits `#channel • Server` in either order. The `#` says which side is which. */
function parseFooter(footer: string | null): { channel: string | null; server: string | null } {
  const text = clean(footer);
  if (!text) return { channel: null, server: null };

  const parts = FOOTER_PARTS.exec(text);
  if (!parts) {
    return text.startsWith('#')
      ? { channel: text.slice(1).trim() || null, server: null }
      : { channel: null, server: text };
  }

  const left = clean(parts[1]);
  const right = clean(parts[2]);
  if (left?.startsWith('#')) return { channel: left.slice(1).trim() || null, server: right };
  if (right?.startsWith('#')) return { channel: right.slice(1).trim() || null, server: left };
  // No `#` anywhere: the leading fragment is conventionally the channel.
  return { channel: left, server: right };
}

/** The first permalink anywhere in the text or embeds. Gives where, never who. */
function findMessageLink(content: string, embeds: DiscordEmbed[]): RegExpExecArray | null {
  const haystacks = [content];
  for (const embed of embeds) {
    haystacks.push(embed.url ?? '', embed.description ?? '', embed.footer ?? '');
    for (const field of embed.fields) haystacks.push(field.value);
  }
  for (const haystack of haystacks) {
    const match = MESSAGE_LINK.exec(haystack);
    if (match) return match;
  }
  return null;
}

/**
 * Reads whatever attribution survived the hop.
 *
 * Never throws and never invents. A candidate with nothing recoverable comes
 * back as `unattributed` with both preservation flags false, which is a valid
 * and expected outcome rather than an error.
 */
export function parseRelay(candidate: RelayCandidate): RelayParse {
  const notes: string[] = [];
  const carrier = candidate.carrier;

  // ── Discord's channel-following ────────────────────────────────────────────
  //
  // Taken first because it is the only path that preserves everything. A
  // followed announcement arrives wearing its original author's identity, with
  // a reference back to the source message, and it arrives BY ITSELF — nobody
  // forwards anything. When a source channel supports it, this is the path to
  // use, and it needs no permission on the source server beyond being able to
  // read it and Manage Webhooks on the receiving one.
  const crosspost = candidate.crosspost ?? null;
  if (crosspost) {
    return {
      attribution: {
        method: 'crosspost',
        authorPreserved: true,
        originPreserved: Boolean(crosspost.channelId ?? crosspost.messageId),
        origin: {
          ...EMPTY_ORIGIN,
          // The crosspost carries the original author, not a forwarder wearing
          // their own name. This is the one relay where the posting identity
          // IS the source identity.
          author: carrier.name,
          authorId: carrier.id,
          guildId: clean(crosspost.guildId),
          channelId: clean(crosspost.channelId),
          messageId: clean(crosspost.messageId),
          url: messageUrl(crosspost.guildId, crosspost.channelId, crosspost.messageId),
        },
        carrier,
        relayedAt: candidate.relayedAt,
        notes: ['arrived by Discord channel-following; original attribution intact'],
      },
      content: candidate.content,
      embeds: candidate.embeds,
      attachments: candidate.attachments,
    };
  }

  // ── Discord's native forward ───────────────────────────────────────────────
  //
  // Taken first because it is authoritative about content and time in a way no
  // amount of text parsing is. It is also the case that most often loses the
  // author, so it is where honest reporting matters most.
  const forward = candidate.forward ?? null;
  if (forward) {
    const origin: RelayOrigin = {
      ...EMPTY_ORIGIN,
      guildId: clean(forward.guildId),
      channelId: clean(forward.channelId),
      messageId: clean(forward.messageId),
      timestamp: asIso(forward.timestamp),
      url: messageUrl(forward.guildId, forward.channelId, forward.messageId),
    };

    // The forwarded payload may still carry its own byline in an embed, which is
    // the one way a native forward keeps the author.
    const embedded = authorFromEmbeds(forward.embeds, carrier);
    if (embedded.author) {
      origin.author = embedded.author;
      origin.channelName ??= embedded.channel;
      origin.guildName ??= embedded.server;
      notes.push('original author recovered from the forwarded embed');
    } else {
      notes.push(
        'Discord forwards do not carry the original author; recorded as unattributed rather than credited to the forwarder',
      );
    }

    // The carrier's own words, if they added any, follow the forwarded text so
    // the headline is still the source's and not the forwarder's commentary.
    const note = clean(candidate.content);
    const content = [clean(forward.content), note].filter(Boolean).join('\n\n');
    if (note) notes.push('the forwarding message added a note; it follows the forwarded text');

    return {
      attribution: {
        method: 'forward_snapshot',
        authorPreserved: Boolean(origin.author),
        originPreserved: Boolean(origin.channelId || origin.messageId),
        origin,
        carrier,
        relayedAt: candidate.relayedAt,
        notes,
      },
      content,
      embeds: forward.embeds,
      attachments: forward.attachments,
    };
  }

  // ── A relay bot that stamped the byline onto the embed ─────────────────────
  const embedded = authorFromEmbeds(candidate.embeds, carrier);
  if (embedded.author) {
    const link = findMessageLink(candidate.content, candidate.embeds);
    const origin: RelayOrigin = {
      ...EMPTY_ORIGIN,
      author: embedded.author,
      channelName: embedded.channel,
      guildName: embedded.server,
      timestamp: embedded.timestamp,
      guildId: link ? normaliseGuild(link[1]) : null,
      channelId: link?.[2] ?? null,
      messageId: link?.[3] ?? null,
      url: link?.[0] ?? null,
    };
    notes.push('original author recovered from the embed byline');

    return {
      attribution: {
        method: 'embed_author',
        authorPreserved: true,
        originPreserved: Boolean(origin.channelId ?? origin.channelName),
        origin,
        carrier,
        relayedAt: candidate.relayedAt,
        notes,
      },
      content: candidate.content,
      embeds: candidate.embeds,
      attachments: candidate.attachments,
    };
  }

  // ── A textual header ───────────────────────────────────────────────────────
  const header = parseTextHeader(candidate.content);
  if (header) {
    const link = findMessageLink(candidate.content, candidate.embeds);
    const origin: RelayOrigin = {
      ...EMPTY_ORIGIN,
      author: header.author,
      channelName: header.channel,
      guildId: link ? normaliseGuild(link[1]) : null,
      channelId: link?.[2] ?? null,
      messageId: link?.[3] ?? null,
      url: link?.[0] ?? null,
    };
    notes.push('original author read from the relayed message header');

    return {
      attribution: {
        method: 'text_prefix',
        authorPreserved: true,
        originPreserved: Boolean(origin.channelId ?? origin.channelName),
        origin,
        carrier,
        relayedAt: candidate.relayedAt,
        notes,
      },
      // The header is not part of the story. Left in, it would become the
      // headline — the normalizer reads the first line as one.
      content: header.rest,
      embeds: candidate.embeds,
      attachments: candidate.attachments,
    };
  }

  // ── A bare permalink: where, but not who ───────────────────────────────────
  const link = findMessageLink(candidate.content, candidate.embeds);
  if (link) {
    notes.push(
      'only a message link survived the relay: the origin channel is known, the author is not',
    );
    return {
      attribution: {
        method: 'message_link',
        authorPreserved: false,
        originPreserved: true,
        origin: {
          ...EMPTY_ORIGIN,
          guildId: normaliseGuild(link[1]),
          channelId: link[2] ?? null,
          messageId: link[3] ?? null,
          url: link[0],
        },
        carrier,
        relayedAt: candidate.relayedAt,
        notes,
      },
      content: candidate.content,
      embeds: candidate.embeds,
      attachments: candidate.attachments,
    };
  }

  // ── Nothing relayed: the carrier IS the author ─────────────────────────────
  //
  // Someone typed it, or a feed bot posted its own alert. This is the one case
  // where naming the poster as the source is correct rather than a guess.
  return {
    attribution: {
      method: 'direct',
      authorPreserved: true,
      originPreserved: true,
      origin: {
        ...EMPTY_ORIGIN,
        author: carrier.name,
        authorId: carrier.id,
      },
      carrier,
      relayedAt: candidate.relayedAt,
      notes: ['posted directly in the intake channel; the poster is the source'],
    },
    content: candidate.content,
    embeds: candidate.embeds,
    attachments: candidate.attachments,
  };
}

function normaliseGuild(value: string | undefined): string | null {
  const guild = clean(value ?? null);
  return !guild || guild === '@me' ? null : guild;
}

/**
 * The byline on an embed, when it names someone other than the carrier.
 *
 * An embed whose author is the posting bot itself is that bot's own alert, not
 * a relayed one — treating it as relayed would invent a hop that never happened.
 */
function authorFromEmbeds(
  embeds: DiscordEmbed[],
  carrier: RelayCarrier,
): { author: string | null; channel: string | null; server: string | null; timestamp: string | null } {
  for (const embed of embeds) {
    const author = clean(embed.author);
    if (!author || sameName(author, carrier.name)) continue;
    const footer = parseFooter(embed.footer);
    return {
      author,
      channel: footer.channel,
      server: footer.server,
      timestamp: asIso(embed.timestamp),
    };
  }
  return { author: null, channel: null, server: null, timestamp: null };
}

function parseTextHeader(
  content: string,
): { author: string; channel: string | null; rest: string } | null {
  for (const pattern of TEXT_HEADERS) {
    const match = pattern.re.exec(content);
    if (!match) continue;

    const author = clean(match[pattern.author]);
    if (!author) continue;
    // A headline marker is not a source. Falling through leaves the text whole
    // and the event unattributed, which is the correct pair of answers.
    if (NOT_AN_AUTHOR.has(author.toLowerCase().replace(/[!.:\s]+$/, '').trim())) continue;

    const channel = pattern.channel === null ? null : clean(match[pattern.channel]);
    const rest = content.slice(match[0].length).trim();
    // A header with nothing after it is a caption, not a relayed story — the
    // whole message would vanish. Keep the text and treat it as direct.
    if (!rest) continue;

    return { author, channel, rest };
  }
  return null;
}

/**
 * The one-line honest summary, for `#scout-raw` and the logs.
 *
 * Deliberately says "via" rather than naming the carrier as the author, and
 * says "unattributed" out loud when that is the truth.
 */
export function describeRelay(attribution: RelayAttribution): string {
  const { origin, carrier } = attribution;
  if (attribution.method === 'direct') return origin.author ?? carrier.name;

  const where = origin.channelName
    ? `#${origin.channelName}`
    : origin.channelId
      ? `channel ${origin.channelId}`
      : null;

  const who = attribution.authorPreserved && origin.author ? origin.author : 'unattributed';
  const place = where ? ` (${where})` : '';

  // A crosspost's carrier IS its author — Discord delivers the original message
  // wearing the original identity. "X via X" would be noise.
  if (sameName(origin.author, carrier.name)) return `${who}${place}`;
  return `${who}${place} via ${carrier.name}`;
}
