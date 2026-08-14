import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import type { Logger } from '../util/logger.js';
import { detectPostUrls, type DetectedUrl } from './urls.js';
import type { SourceKind } from './queue.js';
import { envelopeFromMessage } from './discordIntel/intake.js';
import type { DiscordMessageEnvelope } from './discordIntel/types.js';
import { renderAlertEmbed } from '../render/alert.js';
import { flattenMessage, cleanText } from './discordIntel/normalize.js';

/**
 * Watches configured Discord channels — for X post URLs to resolve, and for
 * intelligence in an intake channel. Event-driven, not polled, and with no
 * history scraping.
 *
 * This listener needs MessageContent, unlike the publishing client which does
 * not, so the two connections are deliberately separate: the publisher keeps
 * the narrowest possible intents, and only this component asks for the
 * privileged one. Both roles share this one connection rather than opening a
 * third: they need identical intents and see the same event stream.
 *
 * Scout reads only channels it has been invited to, with ordinary bot
 * permissions. There is no user token and no self-bot anywhere in this path.
 */

export interface RelayedMessage {
  url: DetectedUrl;
  sourceChannelId: string;
  sourceKind: SourceKind;
  /** When Scout saw it. NOT the post's publication time. */
  receivedAt: string;
  /**
   * The relaying message verbatim — its own text plus anything Discord expanded
   * into an embed. The relay parser reads attribution, headline and body out of
   * this, which is how Scout builds an event with no upstream request and no
   * credential.
   */
  rawMessage: string;
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
  adminChannelIds: string[];
  /**
   * Channels Scout reads as an intelligence source: the whole message, not just
   * the links in it. Config decides which channels these are, and config also
   * guarantees none of them is a destination.
   */
  intakeChannelIds?: string[];
  logger: Logger;
  onUrl: (message: RelayedMessage) => void;
  onIntake?: (envelope: DiscordMessageEnvelope) => void;
  onJoke?: (joke: string) => void;
}

/**
 * Whether a message is one Scout itself posted.
 *
 * Extracted so the rule can be tested without a gateway connection. Both ids
 * must be present and equal: an absent self id means Scout does not yet know
 * who it is, and guessing in either direction there is worse than the
 * configuration guard that already keeps sources and destinations disjoint.
 */
export function isOwnMessage(
  authorId: string | null | undefined,
  selfId: string | null | undefined,
): boolean {
  return Boolean(authorId && selfId && authorId === selfId);
}

export function createDiscordListener(deps: DiscordListenerDeps): DiscordListener {
  const { logger } = deps;
  let client: Client | null = null;
  let ready = false;

  const kindByChannel = new Map<string, SourceKind>();
  for (const id of deps.newsChannelIds) kindByChannel.set(id, 'news');
  for (const id of deps.adminChannelIds) kindByChannel.set(id, 'admin');

  const intakeChannels = new Set((deps.intakeChannelIds ?? []).map((id) => id.trim()).filter(Boolean));

  // A channel configured as both a URL-relay channel and an intake channel would
  // otherwise be read twice — once for the links in it and once as a whole
  // message. Intake is the more complete reading, so it wins, and the overlap is
  // reported rather than silently resolved.
  for (const id of intakeChannels) {
    if (kindByChannel.delete(id)) {
      logger.warn(
        'channel is configured for both URL relay and intelligence intake; reading it as intake only',
        { channelId: id },
      );
    }
  }

  function handleMessage(message: Message): void {
    // Scout's own posts, always, before anything else looks at them.
    //
    // Scout publishes alerts into Discord. If one of those ever came back in as
    // an input it would be re-classified, re-published and re-read, and the
    // resulting loop would look from the outside like an extremely busy news
    // day. Config keeps sources and destinations disjoint; this is the guard
    // that holds even if a channel id is one day pasted into the wrong field.
    if (isOwnMessage(message.author?.id, client?.user?.id)) return;

    if (message.content.trim().startsWith('/joke')) {
      const jokeText = message.content.trim().slice(5).trim();
      if (jokeText && deps.onJoke) {
        deps.onJoke(jokeText);
      }
      return;
    }

    if (message.channelId === '1512892264752349305') {
      (async () => {
        try {
          const destChannel = await client?.channels.fetch('1513342006342979635');
          if (destChannel && destChannel.isTextBased() && 'send' in destChannel) {
            const envelope = envelopeFromMessage(message, { receivedAt: new Date().toISOString() });
            const rawText = flattenMessage(envelope);
            const clean = cleanText(rawText);
            if (!clean) return;

            const lines = clean.split('\n');
            let headlineText = lines[0] || '';
            let bodyText = lines.slice(1).join('\n').trim();

            let banner = 'BREAKING NEWS';
            if (headlineText.startsWith('>>> **') && headlineText.includes('**', 6)) {
              const endIdx = headlineText.indexOf('**', 6);
              banner = headlineText.substring(6, endIdx).trim();
              headlineText = headlineText.substring(endIdx + 2).trim();
              if (!headlineText && lines.length > 1) {
                headlineText = lines[1];
                bodyText = lines.slice(2).join('\n').trim();
              }
            }
            
            // Extract image URL if present
            let imageUrl: string | undefined = undefined;
            const urlMatch = bodyText.match(/https:\/\/\S+\.(?:png|jpg|jpeg|webp|gif)(?:\?\S*)?/i) || bodyText.match(/https:\/\/\S+/i);
            if (urlMatch && banner.includes('CHART ALERTS')) {
              imageUrl = urlMatch[0];
              bodyText = bodyText.replace(imageUrl, '').trim();
            }

            const headline = headlineText.substring(0, 500);
            const body = bodyText.substring(0, 1000);

            const embed = renderAlertEmbed({
              alert: {
                banner,
                headline,
                body,
                timestamp: new Date().toISOString(),
                imageUrl
              },
              brandFooter: 'Scout by Arbor Capital',
            });

            await destChannel.send({ embeds: [embed as any] });
          }
        } catch (err) {
          logger.warn('Failed to instantly forward message', { err });
        }
      })();
    }

    message.content = (message.content || '').replace(/<t:\d+:[a-zA-Z]>/gi, '').trim();

    if (intakeChannels.has(message.channelId)) {
      if (!deps.onIntake) return;
      deps.onIntake(envelopeFromMessage(message, { receivedAt: new Date().toISOString() }));
      return;
    }

    const kind = kindByChannel.get(message.channelId);
    if (!kind) return;

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
        rawMessage: haystack,
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
      if (kindByChannel.size === 0 && intakeChannels.size === 0) {
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

      // Without these, `ready` stayed true after a gateway close — a revoked
      // token or a disabled intent left /ready reporting a healthy service
      // while URL ingestion was completely dead.
      client.on(Events.ShardDisconnect, (event, shardId) => {
        ready = false;
        logger.warn('listener disconnected', { shardId, code: event?.code });
      });
      client.on(Events.Invalidated, () => {
        ready = false;
        logger.error('listener session invalidated; URL ingestion is down');
      });
      client.on(Events.ShardResume, () => {
        ready = true;
        logger.info('listener resumed');
      });
      client.on(Events.ShardReady, () => {
        ready = true;
      });

      await new Promise<void>((resolve, reject) => {
        // See the note in discord/client.ts: 14.27 emits `ready` AND
        // `clientReady`, so both are registered and the handler runs once.
        let settled = false;
        const onReady = (): void => {
          if (settled) return;
          settled = true;
          ready = true;
          logger.info('listening', {
            urlChannels: [...kindByChannel.keys()],
            intakeChannels: [...intakeChannels],
          });
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
    watching: () => [...kindByChannel.keys(), ...intakeChannels],
  };
}


