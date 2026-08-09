import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import type { Logger } from '../util/logger.js';
import { detectPostUrls, type DetectedUrl } from './urls.js';
import type { SourceKind } from './queue.js';

/**
 * Watches configured Discord channels for X post URLs and hands them straight
 * to the queue — event-driven, not polled, and with no history scraping.
 *
 * This listener needs MessageContent, unlike the publishing client which does
 * not, so the two connections are deliberately separate: the publisher keeps
 * the narrowest possible intents, and only this component asks for the
 * privileged one.
 */

export interface RelayedMessage {
  url: DetectedUrl;
  sourceChannelId: string;
  sourceKind: SourceKind;
  /** When Scout saw it. NOT the post's publication time. */
  receivedAt: string;
  /**
   * Text that accompanied the link in the relaying message, if any. Some relays
   * post the headline alongside the URL, which the resolver can use without any
   * retrieval at all.
   */
  relayedText: string | null;
}

export interface DiscordListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  /** Channel ids currently being watched. */
  watching(): string[];
}

export interface DiscordListenerDeps {
  token: string;
  newsChannelIds: string[];
  truthSocialChannelIds: string[];
  adminChannelIds: string[];
  logger: Logger;
  onUrl: (message: RelayedMessage) => void;
}

export function createDiscordListener(deps: DiscordListenerDeps): DiscordListener {
  const { logger } = deps;
  let client: Client | null = null;
  let ready = false;

  const kindByChannel = new Map<string, SourceKind>();
  for (const id of deps.newsChannelIds) kindByChannel.set(id, 'news');
  for (const id of deps.truthSocialChannelIds) kindByChannel.set(id, 'truth_social');
  for (const id of deps.adminChannelIds) kindByChannel.set(id, 'admin');

  function handleMessage(message: Message): void {
    const kind = kindByChannel.get(message.channelId);
    if (!kind) return;
    if (message.author?.bot && message.author.id === client?.user?.id) return; // our own posts

    // The message body, plus anything Discord expanded into an embed — some
    // relays put the headline in the embed rather than the message text.
    const embedText = message.embeds
      .map((e) => [e.title, e.description].filter(Boolean).join(' — '))
      .filter(Boolean)
      .join('\n');
    const haystack = [message.content, embedText, ...message.embeds.map((e) => e.url ?? '')]
      .filter(Boolean)
      .join('\n');

    const urls = detectPostUrls(haystack);
    if (urls.length === 0) return;

    const receivedAt = new Date(message.createdTimestamp).toISOString();

    for (const url of urls) {
      deps.onUrl({
        url,
        sourceChannelId: message.channelId,
        sourceKind: kind,
        receivedAt,
        relayedText: relayedTextFor(message.content, embedText, url),
      });
    }

    logger.debug('detected post urls', {
      channelId: message.channelId,
      kind,
      count: urls.length,
    });
  }

  return {
    async start(): Promise<void> {
      if (kindByChannel.size === 0) {
        logger.info('no input channels configured; URL ingestion is idle');
        return;
      }
      if (!deps.token) {
        logger.warn('DISCORD_BOT_TOKEN is not set; URL ingestion cannot start');
        return;
      }

      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          // Privileged: must be enabled for the bot in the Discord developer
          // portal, or message.content arrives empty and only embedded links
          // are visible.
          GatewayIntentBits.MessageContent,
        ],
      });

      client.on(Events.MessageCreate, (message) => {
        try {
          handleMessage(message);
        } catch (err) {
          logger.error('listener failed on a message', { err: err as Error });
        }
      });

      client.on(Events.Error, (err) => logger.error('listener gateway error', { err }));

      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => {
          ready = true;
          logger.info('listening for post URLs', { channels: [...kindByChannel.keys()] });
          resolve();
        };
        client?.once('clientReady', onReady);
        client?.once('ready', onReady);
        client?.login(deps.token).catch(reject);
      });
    },

    async stop(): Promise<void> {
      ready = false;
      await client?.destroy();
      client = null;
    },

    isReady: () => ready,
    watching: () => [...kindByChannel.keys()],
  };
}

/**
 * The relaying message's own words, with the URL removed. Returns null when
 * nothing but the link was posted, so the caller knows there is no relayed
 * content to fall back on.
 */
function relayedTextFor(content: string, embedText: string, url: DetectedUrl): string | null {
  const stripped = (content ?? '')
    .replace(url.rawUrl, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const combined = [stripped, embedText].filter((s) => s && s.length > 0).join(' — ').trim();
  return combined.length >= 8 ? combined : null;
}
