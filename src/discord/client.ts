import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';
import type { ChannelKey } from '../core/types.js';
import type { DiscordChannelConfig } from '../config/types.js';
import type { Logger } from '../util/logger.js';

/**
 * Discord gateway wrapper.
 *
 * Scout only ever writes, so it connects with the Guilds intent alone — it
 * never requests permission to read message content. A misconfigured optional
 * channel logs and returns null rather than throwing: a missing #scout-crypto
 * must not take the whole wire down.
 */

const MESSAGE_LIMIT = 2000;
const MAX_ATTEMPTS = 4;

export const CHANNEL_NAMES: Record<ChannelKey, string> = {
  news: 'scout-news',
  tradingFloor: 'trading-floor',
  spx: 'spx-trading',
  breaking: 'scout-breaking',
  macro: 'scout-macro',
  fed: 'scout-fed',
  geopolitics: 'scout-geopolitics',
  markets: 'scout-markets',
  equities: 'scout-equities',
  earnings: 'scout-earnings',
  commodities: 'scout-commodities',
  options: 'scout-options',
  crypto: 'scout-crypto',
  raw: 'scout-raw',
  system: 'scout-system',
};

/**
 * ChannelKey → the environment variable that carries its id. Explicit, because
 * deriving it from the key produced DISCORD_CHANNEL_TRADINGFLOOR for
 * `tradingFloor` — a name nothing reads, so the setup output quietly left the
 * trading channel unconfigured.
 */
export const CHANNEL_ENV_VARS: Record<ChannelKey, string> = {
  news: 'DISCORD_CHANNEL_NEWS',
  tradingFloor: 'DISCORD_CHANNEL_TRADING_FLOOR',
  spx: 'DISCORD_CHANNEL_SPX',
  breaking: 'DISCORD_CHANNEL_BREAKING',
  macro: 'DISCORD_CHANNEL_MACRO',
  fed: 'DISCORD_CHANNEL_FED',
  geopolitics: 'DISCORD_CHANNEL_GEOPOLITICS',
  markets: 'DISCORD_CHANNEL_MARKETS',
  equities: 'DISCORD_CHANNEL_EQUITIES',
  earnings: 'DISCORD_CHANNEL_EARNINGS',
  commodities: 'DISCORD_CHANNEL_COMMODITIES',
  options: 'DISCORD_CHANNEL_OPTIONS',
  crypto: 'DISCORD_CHANNEL_CRYPTO',
  raw: 'DISCORD_CHANNEL_RAW',
  system: 'DISCORD_CHANNEL_SYSTEM',
};

export interface SentMessage {
  channelId: string;
  messageId: string;
}

export interface ScoutDiscord {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * `embed` is what a reader sees when Discord can render one: a coloured rule,
   * a linked title, the outlet in the footer. `content` remains the payload —
   * it is the plain-text fallback and the thing the metadata guard checked, so
   * an embed that fails to render never costs the alert its content.
   */
  send(channelKey: ChannelKey, content: string, embed?: unknown): Promise<SentMessage | null>;
  sendToId(channelId: string, content: string, embed?: unknown): Promise<SentMessage | null>;
  edit(channelId: string, messageId: string, content: string): Promise<boolean>;
  ensureChannels(): Promise<Record<string, string>>;
  /**
   * Can Scout actually POST to each of these? Connecting to Discord and being
   * able to write to a particular channel are different things, and the gap
   * between them is silent: the bot reports connected, every alert routes
   * correctly, and the channels stay empty.
   */
  checkChannels(keys: ChannelKey[]): Promise<ChannelCheck[]>;
  isReady(): boolean;
}

export interface ChannelCheck {
  key: ChannelKey;
  channelId: string;
  ok: boolean;
  /** Why not, in words an operator can act on. */
  detail: string;
}

export interface DiscordDeps {
  token: string;
  guildId: string;
  channels: DiscordChannelConfig;
  dryRun: boolean;
  logger: Logger;
}

export function createDiscordClient(deps: DiscordDeps): ScoutDiscord {
  const { logger, channels, dryRun } = deps;
  // An unconfigured optional channel is a standing fact, not an event. Logged
  // once per channel instead of once per alert, which on a busy wire was
  // hundreds of identical lines a day around anything that mattered.
  const warnedMissing = new Set<ChannelKey>();
  let client: Client | null = null;
  let ready = false;
  let dryRunCounter = 0;

  async function start(): Promise<void> {
    if (dryRun) {
      logger.info('dry run — not connecting to Discord');
      ready = true;
      return;
    }
    if (!deps.token) {
      logger.warn('DISCORD_BOT_TOKEN is not set; Discord delivery is disabled');
      return;
    }

    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await new Promise<void>((resolve, reject) => {
      // Both names are registered because discord.js is mid-rename: v14 emits
      // `ready`, v15 will emit only `clientReady`, and 14.27 emits BOTH. Listening
      // for one alone risks hanging forever on a version bump; listening for both
      // without this guard ran the handler twice and logged every connection
      // twice, which is exactly the kind of noise that makes a real duplicate
      // impossible to spot later.
      let settled = false;
      const onReady = (): void => {
        if (settled) return;
        settled = true;
        ready = true;
        logger.info('connected', { user: client?.user?.tag });
        resolve();
      };
      client?.once('clientReady', onReady);
      client?.once('ready', onReady);
      client?.once('error', reject);
      client?.login(deps.token).catch(reject);
    });
  }

  async function stop(): Promise<void> {
    ready = false;
    await client?.destroy();
    client = null;
  }

  function channelIdFor(key: ChannelKey): string {
    return channels[key] ?? '';
  }

  async function resolveChannel(channelId: string): Promise<TextChannel | null> {
    if (!client || !channelId) return null;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
      return channel as TextChannel;
    } catch (err) {
      logger.warn('could not resolve channel', { channelId, err: err as Error });
      return null;
    }
  }

  async function send(
    channelKey: ChannelKey,
    content: string,
    embed?: unknown,
  ): Promise<SentMessage | null> {
    if (dryRun) {
      dryRunCounter += 1;
      // The resolved id, not just the key: a dry run is how an operator checks
      // that config/env actually point at the channels they think they do.
      logger.info('dry-run send', {
        channelKey,
        channelId: channelIdFor(channelKey) || '(unresolved)',
        preview: content.slice(0, 120),
      });
      return { channelId: `dry-${channelKey}`, messageId: `dry-${dryRunCounter}` };
    }

    const channelId = channelIdFor(channelKey);
    if (!channelId) {
      if (!warnedMissing.has(channelKey)) {
        warnedMissing.add(channelKey);
        logger.warn('no channel id configured; alerts for it are skipped', {
          channelKey,
          envVar: CHANNEL_ENV_VARS[channelKey],
        });
      }
      return null;
    }
    const channel = await resolveChannel(channelId);
    if (!channel) return null;

    // An embed carries the whole alert, so there is nothing to chunk: Discord's
    // 2000-character content limit does not apply to it, and the body is capped
    // well below the embed limits upstream.
    if (embed) {
      const sent = await withRetry(
        () => channel.send({ embeds: [embed as never] }),
        logger,
        'send',
      );
      return sent ? { channelId, messageId: sent.id } : null;
    }

    const chunks = splitForDiscord(content);
    let first: SentMessage | null = null;

    for (const chunk of chunks) {
      const sent = await withRetry(() => channel.send({ content: chunk }), logger, 'send');
      if (!sent) return first;
      if (!first) first = { channelId, messageId: sent.id };
    }
    return first;
  }

  async function sendToId(
    channelId: string,
    content: string,
    embed?: unknown,
  ): Promise<SentMessage | null> {
    if (dryRun) {
      dryRunCounter += 1;
      logger.info('dry-run sendToId', {
        channelId,
        preview: content.slice(0, 120),
      });
      return { channelId: `dry-${channelId}`, messageId: `dry-${dryRunCounter}` };
    }

    const channel = await resolveChannel(channelId);
    if (!channel) return null;

    if (embed) {
      const sent = await withRetry(
        () => channel.send({ embeds: [embed as never] }),
        logger,
        'sendToId',
      );
      return sent ? { channelId, messageId: sent.id } : null;
    }

    const chunks = splitForDiscord(content);
    let first: SentMessage | null = null;

    for (const chunk of chunks) {
      const sent = await withRetry(() => channel.send({ content: chunk }), logger, 'sendToId');
      if (!sent) return first;
      if (!first) first = { channelId, messageId: sent.id };
    }
    return first;
  }

  async function edit(channelId: string, messageId: string, content: string): Promise<boolean> {
    if (dryRun) {
      logger.info('dry-run edit', { channelId, messageId });
      return true;
    }
    const channel = await resolveChannel(channelId);
    if (!channel) return false;
    try {
      const message = await channel.messages.fetch(messageId);
      const result = await withRetry(
        () => message.edit({ content: splitForDiscord(content)[0] ?? content }),
        logger,
        'edit',
      );
      return result !== null;
    } catch (err) {
      logger.warn('edit failed', { channelId, messageId, err: err as Error });
      return false;
    }
  }

  /** Finds or creates every Scout channel and returns key → id (§26). */
  async function ensureChannels(): Promise<Record<string, string>> {
    if (!client) throw new Error('discord client is not connected');
    const guild: Guild = await client.guilds.fetch(deps.guildId);
    const existing = await guild.channels.fetch();
    const out: Record<string, string> = {};

    for (const [key, name] of Object.entries(CHANNEL_NAMES) as Array<[ChannelKey, string]>) {
      const found = existing.find((c) => c?.name === name && c.type === ChannelType.GuildText);
      if (found) {
        out[key] = found.id;
        continue;
      }
      const created = await guild.channels.create({ name, type: ChannelType.GuildText });
      logger.info('created channel', { name, id: created.id });
      out[key] = created.id;
    }
    return out;
  }

  /**
   * Probes each configured channel WITHOUT posting to it.
   *
   * Fetching the channel proves the bot can see it; reading its permissions
   * proves it can write. Both fail for the same two ordinary reasons — the bot
   * was never invited to that server, or it has no Send Messages there — and
   * neither is visible from a boot log that says "connected".
   */
  async function checkChannels(keys: ChannelKey[]): Promise<ChannelCheck[]> {
    const out: ChannelCheck[] = [];

    for (const key of keys) {
      const channelId = channelIdFor(key);
      if (!channelId) {
        out.push({ key, channelId: '', ok: false, detail: 'no channel id configured' });
        continue;
      }
      if (dryRun) {
        out.push({ key, channelId, ok: true, detail: 'dry run — not checked' });
        continue;
      }

      try {
        const channel = await client?.channels.fetch(channelId);
        if (!channel) {
          out.push({
            key,
            channelId,
            ok: false,
            detail: 'channel not found — is the bot in that server, and is the id correct?',
          });
          continue;
        }
        if (!channel.isTextBased() || channel.isDMBased()) {
          out.push({ key, channelId, ok: false, detail: 'not a text channel in a server' });
          continue;
        }

        // Fetched, not read from cache.
        //
        // discord.js caches the bot's member object at connect time, and a role
        // granted AFTER that — which is the normal order, since you invite the
        // bot and then give it access — leaves the cached copy showing the old
        // permissions. The check then reports a channel as unreachable that the
        // bot can post to perfectly well, which is a worse failure than the one
        // it exists to catch: it sends an operator to fix something already
        // fixed.
        const guild = (channel as TextChannel).guild;
        const me = guild ? await guild.members.fetchMe({ force: true }).catch(() => null) : null;
        const perms = me ? (channel as TextChannel).permissionsFor(me) : null;

        // Administrator bypasses every channel overwrite, so it is checked
        // first rather than being caught by the per-permission tests below.
        if (perms?.has(PermissionFlagsBits.Administrator)) {
          out.push({
            key,
            channelId,
            ok: true,
            detail: `#${(channel as TextChannel).name} (administrator)`,
          });
          continue;
        }
        if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
          out.push({ key, channelId, ok: false, detail: 'missing View Channel permission' });
          continue;
        }
        if (perms && !perms.has(PermissionFlagsBits.SendMessages)) {
          out.push({ key, channelId, ok: false, detail: 'missing Send Messages permission' });
          continue;
        }

        out.push({
          key,
          channelId,
          ok: true,
          detail: `#${(channel as TextChannel).name}`,
        });
      } catch (err) {
        // The common one is DiscordAPIError 10003 Unknown Channel, which means
        // the bot cannot see it — usually because it is not in that server.
        const message = (err as Error).message;
        out.push({
          key,
          channelId,
          ok: false,
          detail: /unknown channel/i.test(message)
            ? 'Unknown Channel — the bot is not in that server, or the id is wrong'
            : message,
        });
      }
    }

    return out;
  }

  return { start, stop, send, sendToId, edit, ensureChannels, checkChannels, isReady: () => ready };
}

/**
 * Split on paragraph boundaries so an alert is never cut mid-line. A single
 * paragraph longer than the limit is split on whitespace rather than truncated
 * — dropping the tail of a message is data loss, not formatting.
 */
export function splitForDiscord(content: string): string[] {
  if (content.length <= MESSAGE_LIMIT) return [content];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const block of content.split('\n\n')) {
    if (block.length > MESSAGE_LIMIT) {
      flush();
      for (const piece of hardSplit(block)) chunks.push(piece);
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > MESSAGE_LIMIT) {
      flush();
      current = block;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [content.slice(0, MESSAGE_LIMIT)];
}

/** Breaks an over-long block on whitespace, falling back to a hard cut. */
function hardSplit(block: string): string[] {
  const out: string[] = [];
  let rest = block;
  while (rest.length > MESSAGE_LIMIT) {
    const window = rest.slice(0, MESSAGE_LIMIT);
    const breakAt = window.lastIndexOf(' ');
    const cut = breakAt > MESSAGE_LIMIT * 0.5 ? breakAt : MESSAGE_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Honours Discord's retry_after on 429; backs off on 5xx. */
async function withRetry<T>(
  operation: () => Promise<T>,
  logger: Logger,
  label: string,
): Promise<T | null> {
  let delay = 500;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const retryAfter = (err as { retry_after?: number }).retry_after;
      const retriable = status === 429 || status >= 500 || status === 0;
      if (!retriable || attempt === MAX_ATTEMPTS) {
        logger.error(`${label} failed`, { attempt, status, err: err as Error });
        return null;
      }
      const wait = retryAfter ? retryAfter * 1000 : delay;
      logger.warn(`${label} retrying`, { attempt, status, waitMs: wait });
      await sleep(wait);
      delay *= 2;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
