import type {
  DiscordAuthorConfig,
  DiscordChannelConfig,
  DiscordMessageEnvelope,
  DiscordSourcesFile,
} from './types.js';

/**
 * Which Discord messages Scout is permitted to process.
 *
 * This is an allowlist, not a ranking. A message from an unconfigured channel
 * is REJECTED — an intelligence source nobody configured must never be able to
 * reach a trading channel, and "unknown" is not a lower priority, it is a no.
 *
 * Nothing here scores, classifies or routes. A message that passes this gate
 * has earned the right to be considered by the same pipeline as an X post, and
 * nothing more.
 */

export type AcceptDecision =
  | { accepted: true; channel: DiscordChannelConfig; author: DiscordAuthorConfig | null }
  | { accepted: false; reason: string };

/** Case- and discriminator-insensitive: `Owls#1234` matches `owlskeylevelsbot`. */
function normalizeAuthorName(name: string): string {
  return name.trim().toLowerCase().replace(/#\d{1,6}$/, '').trim();
}

export function createDiscordFilter(config: DiscordSourcesFile) {
  const byChannel = new Map<string, DiscordChannelConfig>();
  for (const channel of config.channels) {
    if (channel.enabled) byChannel.set(channel.id.trim(), channel);
  }

  return {
    /** Channel ids currently accepted. Reported on boot and by /metrics. */
    channelIds: (): string[] => [...byChannel.keys()],

    configuredChannels: (): DiscordChannelConfig[] => [...byChannel.values()],

    accept(envelope: DiscordMessageEnvelope): AcceptDecision {
      const channel = byChannel.get(envelope.channelId.trim());
      if (!channel) {
        return {
          accepted: false,
          reason: `channel ${envelope.channelId} is not in config/discord-sources.yaml`,
        };
      }

      // An empty author list means the channel itself is the unit of trust.
      if (channel.authors.length === 0) {
        return { accepted: true, channel, author: null };
      }

      const wanted = normalizeAuthorName(envelope.authorName);
      const author = channel.authors.find((a) => normalizeAuthorName(a.name) === wanted);
      if (!author) {
        return {
          accepted: false,
          reason: `author "${envelope.authorName}" is not on the allowlist for ${channel.sourceId}`,
        };
      }

      return { accepted: true, channel, author };
    },
  };
}

export type DiscordFilter = ReturnType<typeof createDiscordFilter>;

/**
 * The quality seed for a message: the author's override when configured,
 * otherwise the channel's.
 *
 * This feeds the SAME sourceQuality component the X and RSS sources use. It
 * raises or lowers how a message competes; it cannot bypass classification, the
 * noise filters, or the market-impact test, and it cannot force a message into
 * a trading channel.
 */
export function qualityFor(
  channel: DiscordChannelConfig,
  author: DiscordAuthorConfig | null,
): number {
  return author?.qualityScore ?? channel.qualityScore;
}
