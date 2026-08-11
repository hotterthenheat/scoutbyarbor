import { describe, it, expect } from 'vitest';
import { withEnvIntakeChannels, loadDiscordSources } from '../src/config/loader.js';
import { publicationTimeOf, flattenMessage } from '../src/ingest/discordIntel/normalize.js';
import { parseRelay, describeRelay } from '../src/ingest/discordIntel/relay.js';
import type { DiscordMessageEnvelope } from '../src/ingest/discordIntel/types.js';
import type { DiscordSourcesFile } from '../src/config/types.js';

/**
 * Reading a forwarding bot's output.
 *
 * The intended shape: a bot you run forwards headlines into a private channel
 * in your own server, Scout's own bot reads that channel with ordinary
 * permissions, and the result comes back out in Scout's format. No user token,
 * no self-bot, no server Scout was not invited to.
 *
 * Adding such a channel used to require editing discord-sources.yaml and
 * shipping a commit, while the channels Scout WRITES to were settable from the
 * environment — an asymmetry with no justification when the common case is
 * "I made a channel, point the bot at it".
 */

const EMPTY: DiscordSourcesFile = {
  version: 1,
  channels: [],
  destinations: { general: '111', spxMacro: '222', tickers: '333' },
};

describe('declaring an intake channel from the environment', () => {
  it('adds one that config never mentioned', () => {
    const merged = withEnvIntakeChannels(EMPTY, ['999888777']);

    expect(merged.channels).toHaveLength(1);
    expect(merged.channels[0]?.id).toBe('999888777');
    expect(merged.channels[0]?.intake, 'the channel is not actually read').toBe(true);
    expect(merged.channels[0]?.enabled).toBe(true);
  });

  it('gives each channel its own source id, so two do not corroborate as one', () => {
    const merged = withEnvIntakeChannels(EMPTY, ['999888777', '444555666']);
    const ids = merged.channels.map((c) => c.sourceId);

    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id.startsWith('discord:')).toBe(true);
  });

  it('leaves config alone when both describe the same channel', () => {
    // Config carries scores, a filter profile and an author list. The
    // environment carries an id and nothing else, so it must not overwrite the
    // richer description.
    const configured: DiscordSourcesFile = {
      ...EMPTY,
      channels: [
        {
          id: '999888777',
          sourceId: 'discord:arbor-intel',
          name: 'Arbor Intelligence Source',
          enabled: true,
          intake: true,
          qualityScore: 95,
          noiseScore: 5,
          filterProfile: 'strict',
          authors: [],
        },
      ],
    };
    const merged = withEnvIntakeChannels(configured, ['999888777']);

    expect(merged.channels).toHaveLength(1);
    expect(merged.channels[0]?.sourceId).toBe('discord:arbor-intel');
    expect(merged.channels[0]?.qualityScore).toBe(95);
    expect(merged.channels[0]?.filterProfile).toBe('strict');
  });

  it('does nothing when the variable is unset', () => {
    expect(withEnvIntakeChannels(EMPTY, [])).toBe(EMPTY);
  });

  /**
   * The feedback loop. Scout would publish an alert into the channel, read its
   * own alert back as intelligence and publish again — which from the outside
   * looks like a very busy news day.
   */
  it.each([
    ['the news channel', '111'],
    ['the SPX/macro channel', '222'],
    ['the tickers channel', '333'],
  ])('refuses to read %s, which it publishes into', (_label, id) => {
    expect(() => withEnvIntakeChannels(EMPTY, [id])).toThrow(/publish an alert there/i);
  });

  it('keeps the shipped intake channel working', () => {
    const merged = withEnvIntakeChannels(loadDiscordSources(), []);
    expect(merged.channels.some((c) => c.intake && c.enabled)).toBe(true);
  });
});

function envelope(over: Partial<DiscordMessageEnvelope> = {}): DiscordMessageEnvelope {
  return {
    messageId: 'm1',
    channelId: '999888777',
    guildId: 'g1',
    author: { id: 'bot1', name: 'MyForwarder', bot: true },
    content: '',
    embeds: [],
    attachments: [],
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    ...over,
  } as DiscordMessageEnvelope;
}

/**
 * What time the event is judged against.
 *
 * This decides whether forwarded news survives the two-minute freshness window,
 * and the ordering is deliberate: a headline forwarded an hour late was still
 * published an hour ago. `receivedAt` must never enter it, or every message
 * looks seconds old regardless of its real age.
 */
describe('when a forwarded message counts as published', () => {
  it('prefers the timestamp the forwarder stamped on the embed', () => {
    const stated = new Date(Date.now() - 45 * 60_000).toISOString();
    const at = publicationTimeOf(
      envelope({ embeds: [{ title: 'HEADLINE', description: '', fields: [], timestamp: stated }] as never }),
    );
    expect(at).toBe(stated);
  });

  it('falls back to the message time when nothing else states one', () => {
    const posted = new Date(Date.now() - 30_000).toISOString();
    expect(publicationTimeOf(envelope({ timestamp: posted }))).toBe(posted);
  });

  it('never uses the moment Scout happened to read it', () => {
    const posted = new Date(Date.now() - 20 * 60_000).toISOString();
    const read = new Date().toISOString();
    const at = publicationTimeOf(envelope({ timestamp: posted, receivedAt: read }));

    expect(at, 'receipt time was passed off as publication time').not.toBe(read);
    expect(at).toBe(posted);
  });
});

/**
 * The carrier is never the byline. A forwarding bot is transport; whoever
 * originally said the thing is the source, and when the hop loses that, Scout
 * records the loss rather than crediting the bot.
 */
describe('who gets the credit', () => {
  const carrier = { id: 'b1', name: 'MyForwarder', bot: true };

  function relayOf(over: Record<string, unknown> = {}) {
    return parseRelay({
      content: '',
      embeds: [],
      attachments: [],
      carrier,
      relayedAt: new Date().toISOString(),
      ...over,
    } as never);
  }

  it('reads the original author when the forwarder states one', () => {
    // The shape a well-behaved relay bot posts: the upstream account in the
    // embed's author line.
    const { attribution } = relayOf({
      embeds: [
        {
          author: '@DeItaone',
          title: 'FED HOLDS RATES STEADY',
          description: null,
          url: null,
          timestamp: null,
          footer: null,
          fields: [],
        },
      ],
    });

    expect(attribution.origin.author).toBe('@DeItaone');
    expect(attribution.method).toBe('embed_author');
    expect(describeRelay(attribution)).toContain('@DeItaone');
  });

  /**
   * Discord's native forward carries the original content and timestamp but
   * deliberately NOT the original author. Scout says so rather than filling the
   * gap with the only name it has, which is the forwarder's.
   */
  it('says "unattributed" when the hop dropped the author', () => {
    const { attribution } = relayOf({
      forward: {
        content: 'FED HOLDS RATES STEADY',
        embeds: [],
        attachments: [],
        timestamp: new Date().toISOString(),
        editedTimestamp: null,
        channelId: 'c9',
        guildId: 'g9',
        messageId: 'm9',
      },
    });

    expect(attribution.method).toBe('forward_snapshot');
    expect(attribution.authorPreserved).toBe(false);
    expect(describeRelay(attribution)).toMatch(/unattributed/i);
    expect(describeRelay(attribution)).not.toBe('MyForwarder');
  });
});

describe('reading the message body', () => {
  it('reads embed text, which is where bot feeds put everything', () => {
    const text = flattenMessage(
      envelope({
        embeds: [
          { title: 'FED HOLDS RATES STEADY', description: 'Powell cites inflation progress', fields: [] },
        ] as never,
      }),
    );

    expect(text).toContain('FED HOLDS RATES STEADY');
    expect(text).toContain('Powell cites inflation progress');
  });

  it('reads plain content too', () => {
    expect(flattenMessage(envelope({ content: 'US CPI RISES 3.1% Y/Y' }))).toContain('US CPI RISES');
  });
});
