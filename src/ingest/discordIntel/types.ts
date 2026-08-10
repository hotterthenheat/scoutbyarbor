/**
 * Discord as an intelligence source.
 *
 * A second ingestion source alongside the X webhook path, feeding the same
 * normalization → dedupe → classify → score → route pipeline. There is
 * deliberately no second processor, no second renderer and no second router.
 *
 * ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────
 *
 * It is not a Discord reader. Scout cannot read a server it has not been
 * invited to, and the only ways to do that are a bot the server owner installs
 * or automation of a personal account. The second is a self-bot: it violates
 * Discord's terms, gets the account terminated, and Scout implements nothing of
 * the kind — no user tokens, no session replay, no browser automation, no
 * undocumented gateway use.
 *
 * This module is the RECEIVING half. An authorized bridge delivers messages to
 * it, and `DiscordIntelProvider` is the seam that bridge plugs into — so an
 * official feed can replace the webhook later without the pipeline noticing.
 */

/** An attachment as Discord describes it. Retained for audit, never rendered. */
export interface DiscordAttachment {
  id: string | null;
  filename: string | null;
  url: string | null;
  contentType: string | null;
  size: number | null;
}

/**
 * An embed as Discord describes it. Bot feeds carry most of their information
 * here rather than in message content, so this is the part that usually matters.
 */
export interface DiscordEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
  /**
   * The embed's own timestamp. For a relay bot this is often the UPSTREAM
   * event time — closer to the truth than when the bot got round to posting —
   * so it takes precedence when present. Never invented.
   */
  timestamp: string | null;
  author: string | null;
  footer: string | null;
  fields: Array<{ name: string; value: string }>;
}

/**
 * One Discord message, in Scout's vocabulary rather than Discord's.
 *
 * The two timestamps are kept apart for the same reason they are everywhere
 * else in Scout: `timestamp` is when the message was published to the channel,
 * `receivedAt` is when Scout heard about it. Substituting one for the other is
 * how a recycled headline becomes a fresh trading event.
 */
export interface DiscordMessageEnvelope {
  messageId: string;
  channelId: string;
  channelName: string | null;
  guildId: string | null;
  authorId: string | null;
  /** Display name, e.g. `unusual_whales_crier`. */
  authorName: string;
  isBot: boolean;
  content: string;
  embeds: DiscordEmbed[];
  attachments: DiscordAttachment[];
  /** When the message was posted. NULL when the bridge did not supply it. */
  timestamp: string | null;
  editedTimestamp: string | null;
  /** When Scout received it. NEVER substituted for `timestamp`. */
  receivedAt: string;
}

/**
 * A source of Discord messages.
 *
 * The webhook implementation is push-based and needs nothing from this beyond
 * the shape above. An authorized gateway or partner API feed would implement
 * the same interface and start delivering envelopes; everything downstream is
 * unchanged.
 */
export interface DiscordIntelProvider {
  readonly name: string;
  /** Whether this provider is configured and usable right now. */
  available(): boolean;
  /**
   * Begins delivery. `onMessage` must not be awaited by the caller's transport
   * — accepting a message is a durable write, not a pipeline run.
   */
  start(onMessage: (envelope: DiscordMessageEnvelope) => void): Promise<void>;
  stop(): Promise<void>;
}

/** One configured channel Scout is permitted to process. */
export interface DiscordChannelConfig {
  id: string;
  sourceId: string;
  name: string;
  enabled: boolean;
  qualityScore: number;
  noiseScore: number;
  filterProfile: 'standard' | 'strict';
  /** Empty means every author in the channel is accepted. */
  authors: DiscordAuthorConfig[];
}

export interface DiscordAuthorConfig {
  name: string;
  /** Overrides the channel's score for this author. */
  qualityScore: number | null;
}

export interface DiscordSourcesFile {
  version: number;
  channels: DiscordChannelConfig[];
}
