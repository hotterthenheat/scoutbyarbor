import {
  Client,
  GatewayIntentBits,
  ChannelType,
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

export interface SentMessage {
  channelId: string;
  messageId: string;
}

export interface ScoutDiscord {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelKey: ChannelKey, content: string): Promise<SentMessage | null>;
  edit(channelId: string, messageId: string, content: string): Promise<boolean>;
  ensureChannels(): Promise<Record<string, string>>;
  isReady(): boolean;
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
      const onReady = (): void => {
        ready = true;
        logger.info('connected', { user: client?.user?.tag });
        resolve();
      };
      client?.once('clientReady', onReady);
      // discord.js v14 emits 'ready'; keep both so a minor bump does not hang.
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

  async function send(channelKey: ChannelKey, content: string): Promise<SentMessage | null> {
    if (dryRun) {
      dryRunCounter += 1;
      logger.info('dry-run send', { channelKey, preview: content.slice(0, 120) });
      return { channelId: `dry-${channelKey}`, messageId: `dry-${dryRunCounter}` };
    }

    const channelId = channelIdFor(channelKey);
    if (!channelId) {
      logger.warn('no channel id configured', { channelKey });
      return null;
    }
    const channel = await resolveChannel(channelId);
    if (!channel) return null;

    const chunks = splitForDiscord(content);
    let first: SentMessage | null = null;

    for (const chunk of chunks) {
      const sent = await withRetry(() => channel.send({ content: chunk }), logger, 'send');
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

  return { start, stop, send, edit, ensureChannels, isReady: () => ready };
}

/** Split on paragraph boundaries so an alert is never cut mid-line. */
export function splitForDiscord(content: string): string[] {
  if (content.length <= MESSAGE_LIMIT) return [content];

  const chunks: string[] = [];
  let current = '';
  for (const block of content.split('\n\n')) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > MESSAGE_LIMIT) {
      if (current) chunks.push(current);
      current = block.length > MESSAGE_LIMIT ? block.slice(0, MESSAGE_LIMIT) : block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
