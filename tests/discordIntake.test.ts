import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRelay, describeRelay, type RelayCandidate } from '../src/ingest/discordIntel/relay.js';
import { toRawPost, publicationTimeOf } from '../src/ingest/discordIntel/normalize.js';
import { createDiscordIntelWorker } from '../src/ingest/discordIntel/worker.js';
import { envelopeFromMessage } from '../src/ingest/discordIntel/intake.js';
import { createDiscordListener, isOwnMessage } from '../src/ingest/discordListener.js';
import type {
  DiscordEmbed,
  DiscordMessageEnvelope,
  DiscordSourcesFile,
} from '../src/ingest/discordIntel/types.js';
import {
  loadDiscordSources,
  loadSecurityMaster,
  loadSourcesFile,
  loadTaxonomy,
  toDiscordSource,
  toSource,
} from '../src/config/loader.js';
import { attributionFrom, mergeAttribution, provenanceOf } from '../src/core/provenance.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { isFreshForTrading } from '../src/ingest/urlWorker.js';
import type { ChannelKey, RawPost } from '../src/core/types.js';

/**
 * The intake channel.
 *
 * Scout's own bot reads a channel in a server the operator controls. What lands
 * there has usually been forwarded from somewhere else, and the property under
 * test throughout is a single one:
 *
 *   THE ACCOUNT THAT CARRIED A MESSAGE IS NEVER RECORDED AS ITS SOURCE.
 *
 * When the original author survives the hop, that is the byline. When it does
 * not, the byline says "unattributed" and names the carrier as a carrier. Scout
 * never guesses the missing half, and never quietly promotes the forwarder.
 */

setLogLevel('silent');
const log = createLogger('intake-test');

const INTAKE_CHANNEL = '1513342006342979635';

const CONFIG: DiscordSourcesFile = {
  version: 1,
  channels: [
    {
      id: INTAKE_CHANNEL,
      sourceId: 'discord:scout-intake',
      name: 'Scout Intake',
      enabled: true,
      intake: true,
      qualityScore: 70,
      noiseScore: 30,
      filterProfile: 'standard',
      authors: [],
    },
  ],
  destinations: {},
};

const CARRIER = { id: '900', name: 'arbor_relay', isBot: true, isWebhook: false };

function embed(overrides: Partial<DiscordEmbed> = {}): DiscordEmbed {
  return {
    title: null,
    description: null,
    url: null,
    timestamp: null,
    author: null,
    footer: null,
    fields: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<RelayCandidate> = {}): RelayCandidate {
  return {
    content: '',
    embeds: [],
    attachments: [],
    carrier: CARRIER,
    relayedAt: '2026-08-10T14:00:00.000Z',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What survives a hop
// ─────────────────────────────────────────────────────────────────────────────

describe("Discord's native forward", () => {
  /**
   * The important one, and the awkward one. Discord sends a message snapshot
   * with content, embeds and the ORIGINAL timestamp — and deliberately without
   * the original author. So this path preserves where and when, but not who.
   */
  const forwarded = () =>
    candidate({
      content: '',
      forward: {
        content: 'FED HOLDS RATES STEADY AT 4.25-4.50%',
        embeds: [],
        attachments: [],
        timestamp: '2026-08-10T13:02:00.000Z',
        editedTimestamp: null,
        channelId: '555',
        guildId: '444',
        messageId: '666',
      },
    });

  it('keeps the content, the origin and the original time', () => {
    const parsed = parseRelay(forwarded());

    expect(parsed.content).toBe('FED HOLDS RATES STEADY AT 4.25-4.50%');
    expect(parsed.attribution.method).toBe('forward_snapshot');
    expect(parsed.attribution.originPreserved).toBe(true);
    expect(parsed.attribution.origin.channelId).toBe('555');
    expect(parsed.attribution.origin.guildId).toBe('444');
    expect(parsed.attribution.origin.messageId).toBe('666');
    expect(parsed.attribution.origin.timestamp).toBe('2026-08-10T13:02:00.000Z');
    expect(parsed.attribution.origin.url).toBe('https://discord.com/channels/444/555/666');
  });

  it('records the author as unrecoverable instead of crediting the forwarder', () => {
    const parsed = parseRelay(forwarded());

    expect(parsed.attribution.authorPreserved).toBe(false);
    expect(parsed.attribution.origin.author).toBeNull();
    // The forwarder is recorded — as the carrier, which is what it is.
    expect(parsed.attribution.carrier.name).toBe('arbor_relay');
    expect(parsed.attribution.notes.join(' ')).toMatch(/do not carry the original author/i);
    expect(describeRelay(parsed.attribution)).toBe('unattributed (channel 555) via arbor_relay');
  });

  it('still recovers the author when the forwarded payload carried a byline', () => {
    const c = forwarded();
    c.forward!.embeds = [
      embed({ author: '@DeItaone', description: 'FED HOLDS', footer: '#breaking • Squawk HQ' }),
    ];

    const parsed = parseRelay(c);
    expect(parsed.attribution.authorPreserved).toBe(true);
    expect(parsed.attribution.origin.author).toBe('@DeItaone');
    expect(parsed.attribution.origin.channelName).toBe('breaking');
    expect(parsed.attribution.origin.guildName).toBe('Squawk HQ');
  });

  it("puts the forwarder's own note after the forwarded text, never before it", () => {
    const c = forwarded();
    c.content = 'worth watching';

    // The normalizer reads the first line as the headline. A note in front of
    // the story would BECOME the story.
    const parsed = parseRelay(c);
    expect(parsed.content).toBe('FED HOLDS RATES STEADY AT 4.25-4.50%\n\nworth watching');
    expect(parsed.content.split('\n')[0]).toBe('FED HOLDS RATES STEADY AT 4.25-4.50%');
  });
});

describe("Discord's channel-following", () => {
  /**
   * The best path there is, and the one that needs no manual forwarding at all:
   * the operator follows an announcement channel, and messages arrive by
   * themselves wearing their original author's identity.
   */
  it('preserves the author and the origin, and does not read as relayed', () => {
    const parsed = parseRelay(
      candidate({
        content: 'ECB CUTS DEPOSIT RATE BY 25BPS',
        carrier: { id: '77', name: 'ECB', isBot: true, isWebhook: true },
        crosspost: { channelId: '555', guildId: '444', messageId: '666' },
      }),
    );

    expect(parsed.attribution.method).toBe('crosspost');
    expect(parsed.attribution.authorPreserved).toBe(true);
    expect(parsed.attribution.originPreserved).toBe(true);
    expect(parsed.attribution.origin.author).toBe('ECB');
    expect(parsed.attribution.origin.url).toBe('https://discord.com/channels/444/555/666');
    // The carrier IS the author here; "ECB via ECB" would be noise.
    expect(describeRelay(parsed.attribution)).toBe('ECB (channel 555)');
  });
});

describe('a relay bot that stamps the byline on the embed', () => {
  it('reads the author, channel and server off the embed', () => {
    const parsed = parseRelay(
      candidate({
        embeds: [
          embed({
            author: 'Walter Bloomberg',
            description: 'US CPI RISES 3.1% Y/Y',
            footer: 'Squawk HQ • #breaking-news',
            timestamp: '2026-08-10T13:30:00.000Z',
          }),
        ],
      }),
    );

    expect(parsed.attribution.method).toBe('embed_author');
    expect(parsed.attribution.authorPreserved).toBe(true);
    expect(parsed.attribution.origin.author).toBe('Walter Bloomberg');
    expect(parsed.attribution.origin.channelName).toBe('breaking-news');
    expect(parsed.attribution.origin.guildName).toBe('Squawk HQ');
    expect(parsed.attribution.origin.timestamp).toBe('2026-08-10T13:30:00.000Z');
  });

  it("does not invent a hop when the embed's byline IS the poster", () => {
    // A feed bot posting its own alert has not relayed anything. Treating it as
    // relayed would manufacture a middleman that never existed.
    const parsed = parseRelay(
      candidate({
        content: 'FLOW ALERT: SPY 450C SWEEP',
        embeds: [embed({ author: 'arbor_relay', description: 'SPY 450C' })],
      }),
    );

    expect(parsed.attribution.method).toBe('direct');
    expect(parsed.attribution.origin.author).toBe('arbor_relay');
  });
});

describe('a textual attribution header', () => {
  const cases: Array<[string, string, string | null, string]> = [
    [
      'Forwarded from Walter Bloomberg in #breaking: US CPI RISES 3.1% Y/Y',
      'Walter Bloomberg',
      'breaking',
      'US CPI RISES 3.1% Y/Y',
    ],
    [
      '**Walter Bloomberg** in #breaking-news: US CPI RISES 3.1% Y/Y',
      'Walter Bloomberg',
      'breaking-news',
      'US CPI RISES 3.1% Y/Y',
    ],
    [
      '[#breaking] Walter Bloomberg: US CPI RISES 3.1% Y/Y',
      'Walter Bloomberg',
      'breaking',
      'US CPI RISES 3.1% Y/Y',
    ],
    ['@DeItaone: US CPI RISES 3.1% Y/Y', '@DeItaone', null, 'US CPI RISES 3.1% Y/Y'],
    // What a simple forwarding bot emits: f"**{author.display_name}**: {text}"
    [
      '**Walter Bloomberg**: US CPI RISES 3.1% Y/Y',
      'Walter Bloomberg',
      null,
      'US CPI RISES 3.1% Y/Y',
    ],
  ];

  for (const [content, author, channel, rest] of cases) {
    it(`reads "${content.slice(0, 34)}…"`, () => {
      const parsed = parseRelay(candidate({ content }));
      expect(parsed.attribution.method).toBe('text_prefix');
      expect(parsed.attribution.origin.author).toBe(author);
      expect(parsed.attribution.origin.channelName).toBe(channel);
      // The header is not part of the story — left in, it becomes the headline.
      expect(parsed.content).toBe(rest);
    });
  }

  it('leaves a header-only message alone rather than emptying it', () => {
    const parsed = parseRelay(candidate({ content: '@DeItaone: ' }));
    expect(parsed.attribution.method).toBe('direct');
    expect(parsed.content).toBe('@DeItaone: ');
  });

  /**
   * The dangerous false positive. `**BREAKING**:` is how a wire opens a
   * headline, and reading it as a byline would invent an author called
   * BREAKING and delete the word from the story at the same time.
   */
  for (const marker of ['BREAKING', 'ALERT', 'JUST IN', 'Developing', 'URGENT']) {
    it(`does not read "**${marker}**:" as a byline`, () => {
      const content = `**${marker}**: US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED`;
      const parsed = parseRelay(candidate({ content }));

      expect(parsed.attribution.method).toBe('direct');
      expect(parsed.attribution.origin.author).not.toBe(marker);
      // And the word is still in the headline.
      expect(parsed.content).toBe(content);
    });
  }

  it('does not mistake a mid-sentence handle for a byline', () => {
    const parsed = parseRelay(
      candidate({ content: 'Powell responded to @SenatorX during the hearing' }),
    );
    expect(parsed.attribution.method).toBe('direct');
    expect(parsed.content).toBe('Powell responded to @SenatorX during the hearing');
  });
});

describe('a bare permalink', () => {
  it('gives where, and refuses to guess who', () => {
    const parsed = parseRelay(
      candidate({
        content:
          'https://discord.com/channels/1081082844807434291/1081082844807434292/1513342006342979636 look at this',
      }),
    );

    expect(parsed.attribution.method).toBe('message_link');
    expect(parsed.attribution.originPreserved).toBe(true);
    expect(parsed.attribution.authorPreserved).toBe(false);
    expect(parsed.attribution.origin.guildId).toBe('1081082844807434291');
    expect(parsed.attribution.origin.channelId).toBe('1081082844807434292');
    expect(parsed.attribution.origin.messageId).toBe('1513342006342979636');
    expect(parsed.attribution.origin.author).toBeNull();
  });

  it('is not fooled by a link to a channel index rather than a message', () => {
    const parsed = parseRelay(
      candidate({ content: 'see https://discord.com/channels/1081082844807434291 for context' }),
    );
    expect(parsed.attribution.method).toBe('direct');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What the pipeline is told
// ─────────────────────────────────────────────────────────────────────────────

function envelopeOf(relayed: RelayCandidate, overrides: Partial<DiscordMessageEnvelope> = {}) {
  const parsed = parseRelay(relayed);
  return {
    messageId: 'm1',
    channelId: INTAKE_CHANNEL,
    channelName: 'scout-intake',
    guildId: '111',
    authorId: relayed.carrier.id,
    authorName: relayed.carrier.name,
    isBot: relayed.carrier.isBot,
    content: parsed.content,
    embeds: parsed.embeds,
    attachments: parsed.attachments,
    timestamp: relayed.relayedAt,
    editedTimestamp: null,
    receivedAt: '2026-08-10T14:00:01.000Z',
    relay: parsed.attribution,
    ...overrides,
  } satisfies DiscordMessageEnvelope;
}

const channelConfig = CONFIG.channels[0]!;

describe('the RawPost handed to the pipeline', () => {
  it('credits the original author when the hop preserved it', () => {
    const envelope = envelopeOf(
      candidate({
        embeds: [embed({ author: 'Walter Bloomberg', description: 'US CPI RISES 3.1% Y/Y' })],
      }),
    );

    const post = toRawPost({ envelope, channel: channelConfig, author: null });
    expect(post.author).toBe('Walter Bloomberg');
    expect(post.meta.attributionPreserved).toBe(true);
    expect(post.meta.carrierName).toBe('arbor_relay');
  });

  it('says "unattributed" rather than crediting the forwarder', () => {
    const envelope = envelopeOf(
      candidate({
        forward: {
          content: 'FED HOLDS RATES STEADY',
          embeds: [],
          attachments: [],
          timestamp: '2026-08-10T13:02:00.000Z',
          editedTimestamp: null,
          channelId: '555',
          guildId: '444',
          messageId: '666',
        },
      }),
    );

    const post = toRawPost({ envelope, channel: channelConfig, author: null });
    expect(post.author).toBe('unattributed via arbor_relay');
    expect(post.author).not.toBe('arbor_relay');
    expect(post.meta.attributionPreserved).toBe(false);
    expect(post.meta.originAuthor).toBeNull();
    // Where it came from IS known, and is recorded.
    expect(post.meta.originPreserved).toBe(true);
    expect(post.meta.originChannelId).toBe('555');
  });

  it('dates a forwarded headline from when it was PUBLISHED, not when it was forwarded', () => {
    // The freshness gate reads this. If forwarding reset the clock, catching up
    // on yesterday's reading would produce a wire full of fresh trading events.
    const envelope = envelopeOf(
      candidate({
        relayedAt: '2026-08-10T14:00:00.000Z',
        forward: {
          content: 'FED HOLDS RATES STEADY',
          embeds: [],
          attachments: [],
          timestamp: '2026-08-10T09:00:00.000Z',
          editedTimestamp: null,
          channelId: '555',
          guildId: '444',
          messageId: '666',
        },
      }),
    );

    expect(publicationTimeOf(envelope)).toBe('2026-08-10T09:00:00.000Z');
    const post = toRawPost({ envelope, channel: channelConfig, author: null });
    expect(post.meta.publishedAt).toBe('2026-08-10T09:00:00.000Z');
    expect(post.meta.publishedAtKnown).toBe(true);
  });

  it('leaves publication time unknown when nothing stated one', () => {
    const envelope = envelopeOf(candidate({ content: 'FED HOLDS RATES STEADY' }), {
      timestamp: null,
    });

    const post = toRawPost({ envelope, channel: channelConfig, author: null });
    expect(post.meta.publishedAt).toBeNull();
    expect(post.meta.publishedAtKnown).toBe(false);
  });
});

describe('provenance for a relayed event', () => {
  it('names the original feed, not the intake channel it arrived through', () => {
    const envelope = envelopeOf(
      candidate({
        embeds: [
          embed({
            author: 'Walter Bloomberg',
            description: 'US CPI RISES 3.1% Y/Y',
            footer: 'Squawk HQ • #breaking-news',
          }),
        ],
      }),
    );
    const post = toRawPost({ envelope, channel: channelConfig, author: null });

    const attribution = attributionFrom({
      sourceId: post.sourceId,
      sourceName: 'Scout Intake',
      author: post.author,
      meta: post.meta,
    });

    expect(attribution.label).toBe('Walter Bloomberg');
    expect(attribution.author).toBe('Walter Bloomberg');
    expect(attribution.channel).toBe('breaking-news');
    expect(attribution.server).toBe('Squawk HQ');
    expect(attribution.relayedBy).toBe('arbor_relay');
  });

  it('labels an unrecoverable author honestly and keeps the carrier out of the byline', () => {
    const envelope = envelopeOf(
      candidate({
        forward: {
          content: 'FED HOLDS RATES STEADY',
          embeds: [],
          attachments: [],
          timestamp: '2026-08-10T13:02:00.000Z',
          editedTimestamp: null,
          channelId: '555',
          guildId: '444',
          messageId: '666',
        },
      }),
    );
    const post = toRawPost({ envelope, channel: channelConfig, author: null });

    const attribution = attributionFrom({
      sourceId: post.sourceId,
      sourceName: 'Scout Intake',
      author: post.author,
      meta: post.meta,
    });

    expect(attribution.label).toBe('unattributed via arbor_relay');
    expect(attribution.author).toBeUndefined();
    expect(attribution.attributionPreserved).toBe(false);
    expect(attribution.relayedBy).toBe('arbor_relay');

    const p = provenanceOf([attribution]);
    expect(p.label).toBe('unattributed via arbor_relay');
    expect(p.label).not.toBe('arbor_relay');
  });

  it('upgrades an unattributed record when the story arrives again WITH its author', () => {
    const blank = attributionFrom({
      sourceId: 'discord:scout-intake',
      meta: { attributionPreserved: false, carrierName: 'arbor_relay' },
    });
    const named = attributionFrom({
      sourceId: 'discord:scout-intake',
      meta: { attributionPreserved: true, originAuthor: 'Walter Bloomberg' },
    });

    expect(provenanceOf([blank]).label).toBe('unattributed via arbor_relay');

    // Learning who said it is new information, not a second confirmation.
    const upgraded = provenanceOf(mergeAttribution([blank], named));
    expect(upgraded.confirmedBy).toBe(1);
    expect(upgraded.label).toBe('Walter Bloomberg');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The pipeline treats intake exactly like every other Discord source
// ─────────────────────────────────────────────────────────────────────────────

describe('an intake message on the queue', () => {
  it('is admitted, queued durably, and recovered from the payload alone', async () => {
    const posts: RawPost[] = [];
    const worker = createDiscordIntelWorker({
      config: CONFIG,
      logger: log,
      onPost: async (post) => {
        posts.push(post);
      },
    });

    const envelope = envelopeOf(
      candidate({
        embeds: [embed({ author: 'Walter Bloomberg', description: 'US CPI RISES 3.1% Y/Y' })],
      }),
    );

    const admission = worker.admit(envelope);
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    // Nothing but the stored payload — the gateway will not redeliver it.
    await worker.handle({
      id: 1,
      postId: admission.postId,
      url: admission.url,
      sourceChannel: INTAKE_CHANNEL,
      sourceKind: 'discord',
      relayPayload: admission.payload,
      attempts: 0,
      status: 'PENDING',
      createdAt: envelope.receivedAt,
      updatedAt: envelope.receivedAt,
    } as never);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.sourceId).toBe('discord:scout-intake');
    expect(posts[0]?.author).toBe('Walter Bloomberg');
    // The relay record survived serialization, which is what makes the honesty
    // guarantee hold after a restart rather than only at intake.
    expect(posts[0]?.meta.relayMethod).toBe('embed_author');
  });

  it('rejects a message from a channel nobody configured', () => {
    const worker = createDiscordIntelWorker({ config: CONFIG, logger: log, onPost: async () => {} });
    const envelope = envelopeOf(candidate({ content: 'US CPI RISES 3.1% Y/Y' }), {
      channelId: '999999999999999999',
    });

    expect(worker.admit(envelope).admitted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end, through the real pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('a forwarded macro print, end to end', () => {
  let dir: string;
  let db: ScoutDb;
  let sent: Array<{ channel: ChannelKey }>;
  let pipeline: ReturnType<typeof createPipeline>;
  let publisher: ReturnType<typeof createPublisher>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-intake-e2e-'));
    db = openDatabase(join(dir, 'i.db'));
    db.migrate();
    const now = new Date().toISOString();
    db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, now)));
    db.sources.upsertMany(CONFIG.channels.map((c) => toDiscordSource(c, now)));
    db.securities.upsertMany(loadSecurityMaster());
    sent = [];

    pipeline = createPipeline({
      db,
      taxonomy: loadTaxonomy(),
      securities: loadSecurityMaster(),
      config: {
        minPublishScore: 60,
        minBreakingScore: 90,
        dedupeWindowMinutes: 90,
        clusterWindowMinutes: 240,
        dedupeSimilarity: 0.82,
      },
      logger: log,
    });

    publisher = createPublisher({
      db,
      logger: log,
      rawChannelEnabled: false,
      discord: {
        async start() {},
        async stop() {},
        isReady: () => true,
        async send(channel: ChannelKey) {
          sent.push({ channel });
          return `m${sent.length}`;
        },
        async edit() {},
        channelId: () => 'c',
      } as never,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Builds the post exactly as the intake path would, then runs it. */
  async function forwardIntoIntake(text: string, minutesAgo: number) {
    const publishedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const envelope = envelopeOf(
      candidate({
        relayedAt: new Date().toISOString(),
        forward: {
          content: text,
          embeds: [],
          attachments: [],
          timestamp: publishedAt,
          editedTimestamp: null,
          channelId: '555',
          guildId: '444',
          messageId: `orig-${text.length}`,
        },
      }),
      { messageId: `m-${text.length}` },
    );

    const post = toRawPost({ envelope, channel: channelConfig, author: null });
    const outcome = await pipeline.process(post);
    if (outcome.accepted) await publisher.publish(outcome);
    return { outcome, post };
  }

  it('publishes, routes to the index channel, and names nobody it cannot name', async () => {
    const { outcome } = await forwardIntoIntake('US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED', 4);

    expect(outcome.accepted, 'a forwarded CPI print was not published').toBe(true);
    // Losing the byline must not cost the event its routing — the market-impact
    // test reads the content, not the credit line.
    expect(outcome.route?.channels).toContain('news');
    expect(outcome.route?.channels).toContain('spx');

    const contributors = db.events.byId(outcome.cluster!.id)!.contributors;
    const p = provenanceOf(contributors);
    expect(p.label).toBe('unattributed via arbor_relay');
    expect(p.label).not.toContain('scout-intake');
    expect(contributors[0]?.author).toBeUndefined();
    expect(contributors[0]?.relayedBy).toBe('arbor_relay');
  });

  it('is stale-gated on the ORIGINAL time, not the time it was forwarded', async () => {
    // Forwarded now, published four hours ago. The freshness gate must see four
    // hours: otherwise catching up on yesterday's reading manufactures a wire
    // full of "fresh" trading events.
    const { post } = await forwardIntoIntake('US RETAIL SALES FALL 0.4% M/M IN JULY', 240);

    // What the freshness gate actually reads.
    const publishedAt = post.meta.publishedAt as string | null;
    expect(publishedAt).toBeTruthy();
    expect(Date.now() - Date.parse(publishedAt!)).toBeGreaterThan(3 * 3600_000);
    expect(isFreshForTrading(publishedAt, 30).fresh).toBe(false);

    // And the counterexample that makes the assertion above mean something:
    // the time it was FORWARDED is seconds old and would sail through the gate.
    const relayedAt = post.meta.relayedAt as string;
    expect(isFreshForTrading(relayedAt, 30).fresh).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The loop that must not be configurable
// ─────────────────────────────────────────────────────────────────────────────

describe('a channel used as both a source and a destination', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-intake-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Scout publishes alerts into its destinations. Reading one back in would
   * re-classify and re-publish it, and the loop would look from the outside
   * like an extremely busy news day. The listener's self-message guard stops
   * the same-bot case; this stops the configuration that needs the guard.
   */
  it('fails at boot rather than in production', () => {
    const path = join(dir, 'loop.yaml');
    writeFileSync(
      path,
      [
        'version: 1',
        'destinations:',
        '  general: "1513342006342979635"',
        'channels:',
        '  - id: "1513342006342979635"',
        '    sourceId: discord:scout-intake',
        '    intake: true',
        '',
      ].join('\n'),
      'utf8',
    );

    expect(() => loadDiscordSources(path)).toThrow(/both as a source .* and as destinations\.general/);
  });

  it('accepts the same ids once they are distinct', () => {
    const path = join(dir, 'fine.yaml');
    writeFileSync(
      path,
      [
        'version: 1',
        'destinations:',
        '  general: "2222222222222222222"',
        'channels:',
        '  - id: "1513342006342979635"',
        '    sourceId: discord:scout-intake',
        '    intake: true',
        '',
      ].join('\n'),
      'utf8',
    );

    const loaded = loadDiscordSources(path);
    expect(loaded.channels[0]?.intake).toBe(true);
    expect(loaded.destinations.general).toBe('2222222222222222222');
  });

  it('holds for the shipped configuration too', () => {
    const { channels, destinations } = loadDiscordSources();
    const sources = new Set(channels.map((c) => c.id));
    for (const destination of Object.values(destinations)) {
      expect(sources.has(destination)).toBe(false);
    }
  });
});

describe("the listener's own-message guard", () => {
  it("ignores Scout's own posts", () => {
    expect(isOwnMessage('bot-1', 'bot-1')).toBe(true);
  });

  it('does not ignore anyone else', () => {
    expect(isOwnMessage('someone-else', 'bot-1')).toBe(false);
  });

  it('does not treat "we do not know who we are" as a match', () => {
    // Both-null comparing equal would silently drop every message in the
    // channel before the gateway finished identifying the bot.
    expect(isOwnMessage(null, null)).toBe(false);
    expect(isOwnMessage(undefined, undefined)).toBe(false);
    expect(isOwnMessage('bot-1', null)).toBe(false);
    expect(isOwnMessage(null, 'bot-1')).toBe(false);
  });
});

describe('a channel configured for both URL relay and intake', () => {
  it('is read once, as intake, and says so', () => {
    const warnings: string[] = [];
    const listener = createDiscordListener({
      token: '',
      newsChannelIds: [INTAKE_CHANNEL, '2222222222222222222'],
      truthSocialChannelIds: [],
      adminChannelIds: [],
      intakeChannelIds: [INTAKE_CHANNEL],
      logger: { ...log, warn: (msg: string) => warnings.push(msg) } as never,
      onUrl: () => {},
      onIntake: () => {},
    });

    const watched = listener.watching();
    expect(watched.filter((id) => id === INTAKE_CHANNEL)).toHaveLength(1);
    expect(watched).toContain('2222222222222222222');
    expect(warnings.join(' ')).toMatch(/both URL relay and intelligence intake/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gateway boundary
// ─────────────────────────────────────────────────────────────────────────────

/** A structural stand-in for discord.js's Message — only the fields read. */
function gatewayMessage(overrides: Record<string, unknown> = {}): never {
  return {
    id: 'm-1',
    channelId: INTAKE_CHANNEL,
    guildId: '111',
    channel: { name: 'scout-intake' },
    author: { id: '900', username: 'arbor_relay', displayName: 'Arbor Relay', bot: true },
    webhookId: null,
    content: '',
    embeds: [],
    attachments: new Map(),
    createdTimestamp: Date.parse('2026-08-10T14:00:00.000Z'),
    editedTimestamp: null,
    flags: { has: () => false },
    reference: null,
    messageSnapshots: null,
    ...overrides,
  } as never;
}

describe('mapping a gateway message into an envelope', () => {
  it('names the poster as the carrier, and the intake channel as the channel', () => {
    const envelope = envelopeFromMessage(gatewayMessage({ content: 'FED HOLDS RATES STEADY' }), {
      receivedAt: '2026-08-10T14:00:01.000Z',
    });

    expect(envelope.channelId).toBe(INTAKE_CHANNEL);
    expect(envelope.channelName).toBe('scout-intake');
    expect(envelope.authorName).toBe('arbor_relay');
    expect(envelope.timestamp).toBe('2026-08-10T14:00:00.000Z');
    expect(envelope.receivedAt).toBe('2026-08-10T14:00:01.000Z');
    expect(envelope.relay?.method).toBe('direct');
  });

  it('reads a native forward out of the message snapshot', () => {
    const envelope = envelopeFromMessage(
      gatewayMessage({
        reference: { channelId: '555', guildId: '444', messageId: '666', type: 1 },
        messageSnapshots: {
          first: () => ({
            content: 'FED HOLDS RATES STEADY',
            embeds: [],
            attachments: new Map(),
            createdTimestamp: Date.parse('2026-08-10T09:00:00.000Z'),
            editedTimestamp: null,
          }),
        },
      }),
      { receivedAt: '2026-08-10T14:00:01.000Z' },
    );

    expect(envelope.content).toBe('FED HOLDS RATES STEADY');
    expect(envelope.relay?.method).toBe('forward_snapshot');
    expect(envelope.relay?.authorPreserved).toBe(false);
    expect(envelope.relay?.origin.timestamp).toBe('2026-08-10T09:00:00.000Z');
    // The publication time is the original's, not the forward's.
    expect(publicationTimeOf(envelope)).toBe('2026-08-10T09:00:00.000Z');
  });

  it('reads a followed-announcement crosspost', () => {
    const envelope = envelopeFromMessage(
      gatewayMessage({
        content: 'ECB CUTS DEPOSIT RATE BY 25BPS',
        author: { id: '77', username: 'ECB', displayName: 'ECB', bot: true },
        webhookId: 'wh-1',
        flags: { has: (flag: number) => flag === 2 },
        reference: { channelId: '555', guildId: '444', messageId: '666', type: 0 },
      }),
      { receivedAt: '2026-08-10T14:00:01.000Z' },
    );

    expect(envelope.relay?.method).toBe('crosspost');
    expect(envelope.relay?.authorPreserved).toBe(true);
    expect(envelope.relay?.origin.author).toBe('ECB');
  });

  it('does not mistake a reply for a forward', () => {
    // A reply carries a reference too. Only a snapshot means a forward.
    const envelope = envelopeFromMessage(
      gatewayMessage({
        content: 'agreed',
        reference: { channelId: INTAKE_CHANNEL, guildId: '111', messageId: 'm-0', type: 0 },
      }),
      { receivedAt: '2026-08-10T14:00:01.000Z' },
    );

    expect(envelope.relay?.method).toBe('direct');
  });
});
