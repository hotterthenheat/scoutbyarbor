import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createJobQueue } from '../src/ingest/queue.js';
import { createDiscordIntelWorker } from '../src/ingest/discordIntel/worker.js';
import { createDiscordFilter } from '../src/ingest/discordIntel/filter.js';
import {
  toRawPost,
  flattenMessage,
  publicationTimeOf,
  canonicalDiscordId,
} from '../src/ingest/discordIntel/normalize.js';
import type {
  DiscordMessageEnvelope,
  DiscordSourcesFile,
} from '../src/ingest/discordIntel/types.js';
import { validateDiscordPayload } from '../src/server/discordWebhook.js';
import { loadDiscordSources, toDiscordSource } from '../src/config/loader.js';
import {
  provenanceOf,
  provenanceFromSourceIds,
  originOf,
  attributionFrom,
  mergeAttribution,
} from '../src/core/provenance.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { isFreshForTrading, UNKNOWN_PUBLICATION_TIME } from '../src/ingest/urlWorker.js';
import type { ChannelKey, RawPost } from '../src/core/types.js';

/**
 * Discord as a second intelligence source.
 *
 * The property under test throughout: a Discord message is treated as a news
 * item on exactly the same terms as an X post. Same dedupe, same classifier,
 * same scorer, same market-impact test, same routing. Being on Discord earns an
 * event nothing and costs it nothing.
 */

setLogLevel('silent');
const log = createLogger('discord-intel-test');

const CHANNEL_ID = '1234567890123456789';

const CONFIG: DiscordSourcesFile = {
  version: 1,
  channels: [
    {
      id: CHANNEL_ID,
      sourceId: 'discord:flow-alerts',
      name: 'Flow Alerts',
      enabled: true,
      qualityScore: 85,
      noiseScore: 20,
      filterProfile: 'standard',
      authors: [
        { name: 'unusual_whales_crier', qualityScore: 90 },
        { name: 'OwlsKeyLevelsBot', qualityScore: null },
      ],
    },
  ],
};

function envelope(over: Partial<DiscordMessageEnvelope> = {}): DiscordMessageEnvelope {
  return {
    messageId: '9990001',
    channelId: CHANNEL_ID,
    channelName: 'flow-alerts',
    guildId: '555',
    authorId: 'a1',
    authorName: 'unusual_whales_crier',
    isBot: true,
    content: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
    embeds: [],
    attachments: [],
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    editedTimestamp: null,
    receivedAt: new Date().toISOString(),
    ...over,
  };
}

let dir: string;
let db: ScoutDb;
let sent: Array<{ channel: ChannelKey; content: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-discord-intel-'));
  db = openDatabase(join(dir, 'd.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.sources.upsertMany(CONFIG.channels.map((c) => toDiscordSource(c, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());
  sent = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The runtime's wiring, minus the network. */
function buildScout() {
  const pipeline = createPipeline({
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

  const publisher = createPublisher({
    db,
    logger: log,
    rawChannelEnabled: false,
    discord: {
      async start() {},
      async stop() {},
      isReady: () => true,
      async send(channel: ChannelKey, content: string) {
        sent.push({ channel, content });
        return `msg-${sent.length}`;
      },
      async edit() {},
      channelId: () => 'chan',
    } as never,
  });

  const processed: RawPost[] = [];
  const worker = createDiscordIntelWorker({
    config: CONFIG,
    logger: log,
    onPost: async (post) => {
      processed.push(post);
      const outcome = await pipeline.process(post);
      if (outcome.accepted) await publisher.publish(outcome);
    },
  });

  const queue = createJobQueue({
    db,
    logger: log,
    concurrency: 2,
    maxAttempts: 3,
    pollIntervalMs: 5,
    backoffMs: [0, 5, 5, 5],
    handler: async (job) => worker.handle(job),
  });

  /** What the HTTP accepter does, minus HTTP. */
  const accept = (env: DiscordMessageEnvelope) => {
    const admission = worker.admit(env);
    if (!admission.admitted) return { accepted: false, rejected: true, reason: admission.reason };
    const job = queue.enqueue({
      postId: admission.postId,
      url: admission.url,
      sourceChannel: env.channelId,
      sourceKind: 'discord',
      relayPayload: admission.payload,
    });
    return { accepted: job !== null, rejected: false, reason: job === null ? 'duplicate' : 'queued' };
  };

  return { queue, worker, accept, processed, pipeline, publisher };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the allowlist', () => {
  const filter = createDiscordFilter(CONFIG);

  it('accepts a configured channel and author', () => {
    expect(filter.accept(envelope()).accepted).toBe(true);
  });

  it('rejects a channel nobody configured', () => {
    const decision = filter.accept(envelope({ channelId: '999' }));
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/not in config/);
  });

  it('rejects an author not on the channel allowlist', () => {
    const decision = filter.accept(envelope({ authorName: 'random_person' }));
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/not on the allowlist/);
  });

  it('matches authors case-insensitively and ignores a discriminator', () => {
    expect(filter.accept(envelope({ authorName: 'OWLSKEYLEVELSBOT#1234' })).accepted).toBe(true);
  });

  it('accepts every author when the channel configures none', () => {
    const open = createDiscordFilter({
      version: 1,
      channels: [{ ...CONFIG.channels[0]!, authors: [] }],
    });
    expect(open.accept(envelope({ authorName: 'anybody' })).accepted).toBe(true);
  });

  it('ignores a disabled channel entirely', () => {
    const off = createDiscordFilter({
      version: 1,
      channels: [{ ...CONFIG.channels[0]!, enabled: false }],
    });
    expect(off.accept(envelope()).accepted).toBe(false);
    expect(off.channelIds()).toEqual([]);
  });
});

describe('normalization', () => {
  it('reads text out of embeds, which is where bot feeds put it', () => {
    const text = flattenMessage(
      envelope({
        content: '',
        embeds: [
          {
            title: 'FED CUTS RATES BY 50 BPS',
            description: 'Emergency meeting, effective immediately.',
            url: null,
            timestamp: null,
            author: null,
            footer: null,
            fields: [{ name: 'IMPACT', value: 'CRITICAL' }],
          },
        ],
      }),
    );

    expect(text).toContain('FED CUTS RATES BY 50 BPS');
    expect(text).toContain('Emergency meeting');
    expect(text).toContain('IMPACT: CRITICAL');
  });

  it('keeps the message id as the dedupe key', () => {
    expect(canonicalDiscordId('9990001')).toBe('discord:9990001');
  });

  it('retains the raw message, embeds and attachments for audit', () => {
    const env = envelope({
      attachments: [
        { id: 'a', filename: 'chart.png', url: 'https://cdn/x.png', contentType: 'image/png', size: 10 },
      ],
    });
    const post = toRawPost({ envelope: env, channel: CONFIG.channels[0]!, author: null });

    expect(post.meta.rawContent).toBe(env.content);
    expect(post.meta.attachments).toHaveLength(1);
    expect(post.meta.messageId).toBe('9990001');
    expect(post.meta.channelId).toBe(CHANNEL_ID);
    expect(post.meta.authorName).toBe('unusual_whales_crier');
    // The permalink is kept internally and never rendered into an alert.
    expect(post.originalUrl).toContain('discord.com/channels/555/');
  });
});

/**
 * The rule the freshness gate rests on. A Discord message carries a genuine
 * publication time; the moment Scout received it is a different thing and must
 * never stand in for it.
 */
describe('publication time', () => {
  it('uses the message timestamp when that is all there is', () => {
    const at = '2026-08-10T12:00:00.000Z';
    expect(publicationTimeOf(envelope({ timestamp: at }))).toBe(at);
  });

  it('prefers an embed timestamp, which is closer to the upstream event', () => {
    const upstream = '2026-08-10T11:55:00.000Z';
    const posted = '2026-08-10T12:00:00.000Z';
    const at = publicationTimeOf(
      envelope({
        timestamp: posted,
        embeds: [
          {
            title: 'CPI',
            description: null,
            url: null,
            timestamp: upstream,
            author: null,
            footer: null,
            fields: [],
          },
        ],
      }),
    );
    expect(at).toBe(upstream);
  });

  it('is null when the bridge supplied no timestamp — never the receipt time', () => {
    const env = envelope({ timestamp: null });
    expect(publicationTimeOf(env)).toBeNull();

    const post = toRawPost({ envelope: env, channel: CONFIG.channels[0]!, author: null });
    // eventTime still has to be real; it orders the pipeline.
    expect(typeof post.eventTime).toBe('string');
    // But publishedAt says "unknown", and the gate holds the event back.
    expect(post.meta.publishedAt).toBeNull();
    expect(isFreshForTrading(null, 30).reason).toBe(UNKNOWN_PUBLICATION_TIME);
  });

  it('keeps the receipt time in its own field', () => {
    const env = envelope();
    const post = toRawPost({ envelope: env, channel: CONFIG.channels[0]!, author: null });

    expect(post.ingestionTime).toBe(env.receivedAt);
    expect(post.meta.publishedAt).toBe(env.timestamp);
    expect(post.meta.publishedAt).not.toBe(post.ingestionTime);
  });
});

describe('the webhook contract', () => {
  const NOW = new Date().toISOString();

  it('accepts a well-formed message', () => {
    const result = validateDiscordPayload(
      {
        v: 1,
        message_id: '1',
        channel_id: CHANNEL_ID,
        author_name: 'unusual_whales_crier',
        content: 'FED CUTS RATES',
        timestamp: NOW,
      },
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a message with no content and no embed text', () => {
    const result = validateDiscordPayload(
      { v: 1, message_id: '1', channel_id: CHANNEL_ID, author_name: 'bot', content: '   ' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no content and no embed text/);
  });

  it('rejects a malformed timestamp rather than guessing', () => {
    const result = validateDiscordPayload(
      {
        v: 1,
        message_id: '1',
        channel_id: CHANNEL_ID,
        author_name: 'bot',
        content: 'text',
        timestamp: 'yesterday afternoon',
      },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timestamp/);
  });

  it('treats an absent timestamp as unknown, not as an error', () => {
    const result = validateDiscordPayload(
      { v: 1, message_id: '1', channel_id: CHANNEL_ID, author_name: 'bot', content: 'text' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.timestamp).toBeNull();
  });

  it('rejects an unsupported schema version', () => {
    const result = validateDiscordPayload(
      { v: 99, message_id: '1', channel_id: CHANNEL_ID, author_name: 'b', content: 'x' },
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});

describe('one pipeline, not two', () => {
  it('routes a market-moving Discord message to both trading channels', async () => {
    const scout = buildScout();
    scout.accept(envelope());
    await scout.queue.drain();

    // A Fed emergency cut is macro: the index channel, not the single-name one.
    expect(sent.map((s) => s.channel).sort()).toEqual(['news', 'spx']);
  });

  /**
   * The discrimination that matters. This message DOES publish — it is real
   * corporate news — but it is not market-moving, so it must reach #scout-news
   * and stop there. A test using a message that gets rejected outright would
   * pass without proving anything about routing.
   */
  it('publishes an ordinary Discord message to #scout-news ONLY', async () => {
    const scout = buildScout();
    scout.accept(
      envelope({
        messageId: '9990002',
        content: 'ETSY ANNOUNCES $50 MILLION SHARE REPURCHASE PROGRAM',
      }),
    );
    await scout.queue.drain();

    // It published — otherwise the assertions below would be vacuous.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((s) => s.channel)).toEqual(['news']);
  });

  it('rejects market chatter arriving on Discord, exactly as from X', async () => {
    const scout = buildScout();
    scout.accept(envelope({ messageId: '9990003', content: 'NVDA is looking strong today 🚀' }));
    await scout.queue.drain();

    expect(sent).toHaveLength(0);
    // Rejected, not merely unpublished — the decision is recorded either way.
    expect(scout.processed).toHaveLength(1);
  });
});

describe('deduplication across sources', () => {
  it('collapses the same story arriving on X and on Discord into one event', async () => {
    const scout = buildScout();
    const story = 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING';

    // The X path first, through the same pipeline the relay uses.
    const xPost: RawPost = {
      sourceId: 'x:deltaone',
      sourcePostId: 'x:777',
      originalUrl: 'https://x.com/DeItaone/status/777',
      author: '@DeItaone',
      text: story,
      eventTime: new Date(Date.now() - 120_000).toISOString(),
      ingestionTime: new Date().toISOString(),
      meta: { publishedAt: new Date(Date.now() - 120_000).toISOString() },
    };
    const first = await scout.pipeline.process(xPost);
    expect(first.accepted).toBe(true);
    await scout.publisher.publish(first);
    const afterX = sent.length;

    // Then the same story on Discord.
    scout.accept(envelope({ messageId: '9990004', content: story }));
    await scout.queue.drain();

    // No second alert — it is one event, corroborated, not two.
    expect(sent).toHaveLength(afterX);
  });

  it('records the Discord source as corroboration on the existing cluster', async () => {
    const scout = buildScout();
    const story = 'ECB HOLDS RATES STEADY AT 2.00% AS GROWTH SLOWS';

    const first = await scout.pipeline.process({
      sourceId: 'x:deltaone',
      sourcePostId: 'x:888',
      originalUrl: null,
      author: '@DeItaone',
      text: story,
      eventTime: new Date(Date.now() - 120_000).toISOString(),
      ingestionTime: new Date().toISOString(),
      meta: { publishedAt: new Date(Date.now() - 120_000).toISOString() },
    });
    const clusterId = first.cluster?.id;
    expect(clusterId).toBeTruthy();

    scout.accept(envelope({ messageId: '9990005', content: story }));
    await scout.queue.drain();

    const cluster = db.events.byId(clusterId!);
    expect(cluster?.sourceIds).toContain('x:deltaone');
    expect(cluster?.sourceIds).toContain('discord:flow-alerts');
  });

  it('produces one event when the same Discord message is delivered twice', async () => {
    const scout = buildScout();
    const first = scout.accept(envelope({ messageId: '9990006' }));
    const second = scout.accept(envelope({ messageId: '9990006' }));
    await scout.queue.drain();

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    // A Fed emergency cut is macro: the index channel, not the single-name one.
    expect(sent.map((s) => s.channel).sort()).toEqual(['news', 'spx']);
  });
});

describe('provenance', () => {
  it('names the origin of a source id', () => {
    expect(originOf('discord:flow-alerts')).toBe('discord');
    expect(originOf('x:deltaone')).toBe('x');
    // The URL relay is transport, not origin — those are still X posts.
    expect(originOf('relay:discord-urls')).toBe('x');
    expect(originOf('rss:fed-press-all')).toBe('rss');
  });

  /**
   * "DISCORD" is not a useful answer to "where did this come from".
   * "OwlsKeyLevelsBot" is — it names the feed an operator actually judges.
   */
  it('names the bot that posted it, not the platform', () => {
    const attribution = attributionFrom({
      sourceId: 'discord:flow-alerts',
      sourceName: 'Flow Alerts',
      author: 'OwlsKeyLevelsBot',
      publishedAt: '2026-08-10T14:47:00.000Z',
      meta: {
        authorName: 'OwlsKeyLevelsBot',
        channelName: 'market-news',
        guildId: '555',
      },
    });

    expect(attribution.kind).toBe('discord');
    expect(attribution.label).toBe('OwlsKeyLevelsBot');
    expect(attribution.author).toBe('OwlsKeyLevelsBot');
    expect(attribution.channel).toBe('market-news');
    expect(attribution.server).toBe('555');
    expect(attribution.firstSeenAt).toBe('2026-08-10T14:47:00.000Z');
  });

  it('names the account for an X post', () => {
    const attribution = attributionFrom({
      sourceId: 'x:deltaone',
      sourceName: 'Walter Bloomberg',
      author: '@DeItaone',
      publishedAt: '2026-08-10T14:49:00.000Z',
    });

    expect(attribution.kind).toBe('x');
    expect(attribution.label).toBe('@DeItaone');
    expect(attribution.account).toBe('@DeItaone');
  });

  it('reports both feeds, when each first said it, and how many confirmed', () => {
    const p = provenanceOf([
      attributionFrom({
        sourceId: 'discord:flow-alerts',
        author: 'OwlsKeyLevelsBot',
        publishedAt: '2026-08-10T14:47:00.000Z',
        meta: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
      }),
      attributionFrom({
        sourceId: 'x:deltaone',
        author: '@DeItaone',
        publishedAt: '2026-08-10T14:49:00.000Z',
      }),
    ]);

    expect(p.label).toBe('OwlsKeyLevelsBot + @DeItaone');
    expect(p.confirmedBy).toBe(2);
    expect(p.corroborated).toBe(true);
    // The EARLIEST report, not whichever arrived at Scout first.
    expect(p.firstReportedAt).toBe('2026-08-10T14:47:00.000Z');
    expect(p.origins).toEqual(['x', 'discord']);
  });

  it('does not claim corroboration from a single source', () => {
    const p = provenanceOf([
      attributionFrom({ sourceId: 'discord:flow-alerts', author: 'OwlsKeyLevelsBot' }),
    ]);
    expect(p.confirmedBy).toBe(1);
    expect(p.corroborated).toBe(false);
  });

  it('does not count a source repeating itself as a second confirmation', () => {
    const first = attributionFrom({
      sourceId: 'discord:flow-alerts',
      author: 'OwlsKeyLevelsBot',
      publishedAt: '2026-08-10T14:47:00.000Z',
      meta: { authorName: 'OwlsKeyLevelsBot' },
    });
    const again = attributionFrom({
      sourceId: 'discord:flow-alerts',
      author: 'OwlsKeyLevelsBot',
      publishedAt: '2026-08-10T14:52:00.000Z',
      meta: { authorName: 'OwlsKeyLevelsBot' },
    });

    const merged = mergeAttribution([first], again);
    expect(merged).toHaveLength(1);
    // ...but an EARLIER report from the same source does refine the record.
    const earlier = mergeAttribution(merged, {
      ...first,
      firstSeenAt: '2026-08-10T14:40:00.000Z',
    });
    expect(earlier[0]?.firstSeenAt).toBe('2026-08-10T14:40:00.000Z');
  });

  it('still reports something useful for clusters recorded before this existed', () => {
    // Old rows have source ids and no contributor detail.
    const p = provenanceFromSourceIds(['x:deltaone', 'discord:flow-alerts']);
    expect(p.label).toBe('X + DISCORD');
    expect(p.confirmedBy).toBe(2);
  });

  it('records both feeds on the cluster when a story arrives on each', async () => {
    const scout = buildScout();
    const story = 'OPEC+ AGREES TO EXTEND PRODUCTION CUTS THROUGH Q2';

    const first = await scout.pipeline.process({
      sourceId: 'x:deltaone',
      sourcePostId: 'x:999',
      originalUrl: null,
      author: '@DeItaone',
      text: story,
      eventTime: new Date(Date.now() - 120_000).toISOString(),
      ingestionTime: new Date().toISOString(),
      meta: { publishedAt: new Date(Date.now() - 120_000).toISOString() },
    });
    const clusterId = first.cluster?.id;

    scout.accept(envelope({ messageId: '9991010', content: story }));
    await scout.queue.drain();

    const cluster = db.events.byId(clusterId!);
    const p = provenanceOf(cluster?.contributors ?? []);

    expect(p.confirmedBy).toBe(2);
    expect(p.label).toContain('@DeItaone');
    expect(p.label).toContain('unusual_whales_crier');
    // Survives the round trip through SQLite, not just in memory.
    expect(cluster?.contributors.find((c) => c.kind === 'discord')?.channel).toBe('flow-alerts');
  });
});

describe('durability', () => {
  it('survives a restart between accepting and processing', async () => {
    // Accept on one worker generation, process on another — nothing in memory
    // carries over, exactly as a redeploy behaves.
    const first = buildScout();
    first.accept(envelope({ messageId: '9990007' }));
    first.queue.stop();
    expect(sent).toHaveLength(0);

    const second = buildScout();
    await second.queue.drain();

    // A Fed emergency cut is macro: the index channel, not the single-name one.
    expect(sent.map((s) => s.channel).sort()).toEqual(['news', 'spx']);
  });

  it('fails visibly rather than inventing content when the payload is gone', async () => {
    const scout = buildScout();
    scout.accept(envelope({ messageId: '9990008' }));
    db.raw
      .prepare('UPDATE processing_jobs SET relay_payload = NULL WHERE post_id = ?')
      .run('discord:9990008');

    await scout.queue.drain();

    expect(sent).toHaveLength(0);
    expect(db.jobs.byPostId('discord:9990008')?.status).toBe('FAILED_RETRIEVAL');
  });

  it('refuses a queued message whose channel was removed from config', async () => {
    const scout = buildScout();
    scout.accept(envelope({ messageId: '9990009' }));
    scout.queue.stop();

    // The allowlist in force at processing time is the one that counts.
    const narrowed = createDiscordIntelWorker({
      config: { version: 1, channels: [] },
      logger: log,
      onPost: async () => {
        throw new Error('must not process a message from an unconfigured channel');
      },
    });
    const queue = createJobQueue({
      db,
      logger: log,
      concurrency: 1,
      maxAttempts: 2,
      pollIntervalMs: 5,
      backoffMs: [0, 5],
      handler: async (job) => narrowed.handle(job),
    });
    await queue.drain();

    expect(sent).toHaveLength(0);
    expect(db.jobs.byPostId('discord:9990009')?.status).toBe('FAILED_RETRIEVAL');
  });
});

describe('the config file', () => {
  /**
   * Pins the deployed configuration. These ids are what the forwarding bot
   * reads from and what Arbor reads — a silent edit to either is a silent
   * change to where trading intelligence goes.
   */
  it('allowlists exactly the configured source channels', () => {
    const { channels } = loadDiscordSources();
    const byId = new Map(channels.map((c) => [c.id, c]));

    // Two, and only these two. The allowlist is the security boundary: a
    // channel that appears here without being intended is an intelligence
    // source nobody configured, feeding the trading channels.
    expect(channels).toHaveLength(2);

    // The direct source, read once Scout's bot is invited to that server. The
    // webhook bridge remains available for the same channel.
    expect(byId.get('1081082844807434292')?.sourceId).toBe('discord:arbor-intel');
    expect(byId.get('1081082844807434292')?.enabled).toBe(true);
    expect(byId.get('1081082844807434292')?.intake).toBe(true);

    // The drop channel inside Arbor that a forwarding bot posts into — the
    // route that works when Scout cannot be invited to the source server.
    expect(byId.get('1512892264752349305')?.sourceId).toBe('discord:arbor-relay');
    expect(byId.get('1512892264752349305')?.enabled).toBe(true);
    expect(byId.get('1512892264752349305')?.intake).toBe(true);
  });

  it('declares all three destinations', () => {
    const { destinations } = loadDiscordSources();
    expect(destinations.general).toBe('1513342006342979635');
    expect(destinations.spxMacro).toBe('1510553508351311922');
    expect(destinations.tickers).toBe('1510553837897781259');
  });

  /**
   * The invariant behind the layout, not just the ids: nothing Scout publishes
   * into may be anything Scout reads from. A channel that is both would have
   * Scout re-ingesting its own alerts, which from the outside looks like an
   * extremely busy news day rather than a bug.
   */
  it('never points a destination at a source channel', () => {
    const { destinations, channels } = loadDiscordSources();
    const sources = new Set(channels.map((c) => c.id));
    for (const destination of Object.values(destinations)) {
      expect(sources.has(destination), `${destination} is both a source and a destination`).toBe(
        false,
      );
    }
  });

  it('treats a missing file as "not in use" rather than an error', () => {
    expect(loadDiscordSources(join(dir, 'nope.yaml')).channels).toEqual([]);
  });

  it('refuses a sourceId that would make provenance ambiguous', () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      'version: 1\nchannels:\n  - id: "1"\n    sourceId: flow-alerts\n',
      'utf8',
    );
    expect(() => loadDiscordSources(path)).toThrow(/must start with "discord:"/);
  });

  it('refuses duplicate channel ids', () => {
    const path = join(dir, 'dupe.yaml');
    writeFileSync(
      path,
      'version: 1\nchannels:\n  - id: "1"\n    sourceId: discord:a\n  - id: "1"\n    sourceId: discord:b\n',
      'utf8',
    );
    expect(() => loadDiscordSources(path)).toThrow(/duplicate Discord channel id/);
  });

  it('registers a channel as a source the scorer already understands', () => {
    const source = toDiscordSource(CONFIG.channels[0]!, new Date().toISOString());
    expect(source.id).toBe('discord:flow-alerts');
    expect(source.qualityScore).toBe(85);
    // Pushed, not polled — Scout never fetches these.
    expect(source.sourceType).toBe('manual');
  });
});
