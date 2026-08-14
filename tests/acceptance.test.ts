import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { createJobQueue, parseRelayPayload } from '../src/ingest/queue.js';
import { createUrlWorker, isFreshForTrading } from '../src/ingest/urlWorker.js';
import { createRelayResolver, createXApiResolver, createChainResolver } from '../src/ingest/resolver.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { toSproutEvent } from '../src/sprout/client.js';
import type { ChannelKey } from '../src/core/types.js';
import type { ScoutDiscord, SentMessage } from '../src/discord/client.js';
import type { RelayedMessage } from '../src/ingest/discordListener.js';

/**
 * THE ACCEPTANCE TEST.
 *
 * Deploy with X_BEARER_TOKEN absent, relay one message containing a post URL
 * and its content, and Scout must do the whole job on the relay path alone.
 */

setLogLevel('silent');
const log = createLogger('acceptance');

const RELAY_MESSAGE = `Macro Alert (@DeItaone):

NO NUCLEAR IRAN

Trump called the Obama-era Iran nuclear deal "one of the worst deals ever," saying it gave Iran a path to nuclear weapons and enriched a hostile regime.

https://x.com/DeItaone/status/2058552301120360937`;

interface Sent {
  channel: ChannelKey;
  content: string;
}

function fakeDiscord(sent: Sent[]): ScoutDiscord {
  let n = 0;
  return {
    async start() {},
    async stop() {},
    async send(channel: ChannelKey, content: string): Promise<SentMessage> {
      sent.push({ channel, content });
      n += 1;
      return { channelId: `chan-${channel}`, messageId: `msg-${n}` };
    },
    async edit() {
      return true;
    },
    async ensureChannels() {
      return {};
    },
    isReady: () => true,
  };
}

let dir: string;
let db: ScoutDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-accept-'));
  db = openDatabase(join(dir, 'a.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Wires the real components exactly as src/index.ts does, minus the network. */
function buildScout(sent: Sent[], opts: { bearerToken?: string } = {}) {
  // Relay FIRST, API second — and with no token the API provider reports itself
  // unavailable and is skipped rather than failing. The relay payload is read
  // from the job row, exactly as src/index.ts does.
  const resolver = createChainResolver(
    [
      createRelayResolver((url) => {
        const payload = parseRelayPayload(db.jobs.relayPayload(url.canonicalId));
        return payload ? { rawMessage: payload.rawMessage } : null;
      }),
      createXApiResolver({ bearerToken: opts.bearerToken ?? '', timeoutMs: 1000, logger: log }),
    ],
    log,
  );

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
    discord: fakeDiscord(sent),
    db,
    logger: log,
    rawChannelEnabled: false,
  });

  const outcomes: Awaited<ReturnType<typeof pipeline.process>>[] = [];
  const sproutPayloads: ReturnType<typeof toSproutEvent>[] = [];

  const queue = createJobQueue({
    db,
    logger: log,
    concurrency: 2,
    maxAttempts: 2,
    pollIntervalMs: 5,
    backoffMs: [0, 5],
    handler: async (job) => worker.handle(job),
  });

  const worker = createUrlWorker({
    db,
    queue,
    resolver,
    logger: log,
    relaySourceId: 'relay:discord-urls',
    onPost: async (post) => {
      const outcome = await pipeline.process(post);
      outcomes.push(outcome);
      if (!outcome.accepted) return;

      await publisher.publish(outcome);

      const publishedAt =
        typeof post.meta.publishedAt === 'string' ? post.meta.publishedAt : null;
      const freshness = isFreshForTrading(publishedAt, 30);
      if (freshness.fresh) {
        sproutPayloads.push(
          toSproutEvent({
            newsEvent: outcome.newsEvent,
            cluster: outcome.cluster,
            impact: outcome.impact,
            publishedAt,
          }),
        );
      }
      db.deliveries.record({
        eventId: outcome.cluster?.id ?? outcome.newsEvent.id,
        destination: 'sprout',
        status: freshness.fresh ? 'SENT' : 'SKIPPED',
        discordMessageId: null,
        sentAt: freshness.fresh ? new Date().toISOString() : null,
        error: freshness.fresh ? null : freshness.reason,
        createdAt: new Date().toISOString(),
      });
    },
  });

  const relay = (rawMessage: string, channel = 'chan-news'): void => {
    const urls = detect(rawMessage);
    for (const url of urls) {
      const message: RelayedMessage = {
        url,
        sourceChannelId: channel,
        sourceKind: 'news',
        receivedAt: new Date().toISOString(),
        rawMessage,
      };
      worker.submit(message);
    }
  };

  return { queue, relay, outcomes, sproutPayloads };
}

// Imported here to keep the helper above readable.
import { detectPostUrls as detect } from '../src/ingest/urls.js';

describe('MVP acceptance: no X bearer token', () => {
  it('does the whole job from a relayed message alone', async () => {
    const sent: Sent[] = [];
    const scout = buildScout(sent, { bearerToken: '' });

    scout.relay(RELAY_MESSAGE);
    await scout.queue.drain();

    // 1-2. Detected the URL and extracted the post id.
    const stored = db.posts.byId('x:2058552301120360937');
    expect(stored, 'the post was not resolved').toBeTruthy();

    // 4. Content came from the relay, with no upstream request.
    expect(stored?.retrievalSource).toBe('discord-relay');
    expect(stored?.text).toContain('NO NUCLEAR IRAN');
    expect(stored?.text).toContain('one of the worst deals ever');
    // The relay's framing is not part of the story.
    expect(stored?.text).not.toContain('Macro Alert');
    expect(stored?.authorHandle).toBe('@DeItaone');

    // 5. No publication time was stated, so none is invented.
    expect(stored?.publishedAt).toBeNull();
    expect(stored?.discordReceivedAt).toBeTruthy();

    // 6-7. Classified into exactly one canonical event.
    const accepted = scout.outcomes.filter((o) => o.accepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.newsEvent.category).toBeTruthy();

    // 8. Posted to #scout-news.
    expect(sent.map((s) => s.channel)).toContain('news');

    // The alert carries the headline and no metadata or score.
    const alert = sent.find((s) => s.channel === 'news')?.content ?? '';
    expect(alert).toContain('NO NUCLEAR IRAN');
    expect(alert).not.toContain('@DeItaone');
    expect(alert).not.toContain('x.com');
    expect(alert.toLowerCase()).not.toContain('score');

    // 11. Publication time is unknown, so this is NOT a fresh trading event.
    expect(scout.sproutPayloads).toHaveLength(0);

    // 12. Every delivery is recorded, including the deliberate Sprout skip.
    const eventId = accepted[0]?.cluster?.id ?? accepted[0]?.newsEvent.id ?? '';
    const deliveries = db.deliveries.forEvent(eventId);
    expect(deliveries.length).toBeGreaterThan(0);
    const sprout = deliveries.find((d) => d.destination === 'sprout');
    expect(sprout?.status).toBe('SKIPPED');
    expect(sprout?.error).toBe('publication time unknown');
  });

  it('routes a market-moving relayed post out of #scout-news', async () => {
    const sent: Sent[] = [];
    const scout = buildScout(sent);

    scout.relay(`Macro Alert (@DeItaone):

TRUMP ANNOUNCES 25% TARIFF ON ALL IMPORTED VEHICLES

The measure takes effect next quarter, the White House said.

https://x.com/DeItaone/status/2058552301120360938`);
    await scout.queue.drain();

    const channels = sent.map((s) => s.channel);
    expect(channels).toContain('news');
    // Macro reaches the index channel; the single-name channel is for company
    // news. The invariant is that it does not stop at #scout-news.
    expect(channels).toContain('spx');
  });

  it('keeps a non-market relayed post out of the trading channels', async () => {
    const sent: Sent[] = [];
    const scout = buildScout(sent);

    scout.relay(`(@DeItaone):

Trump says happy birthday to a longtime supporter at a rally in Ohio today.

https://x.com/DeItaone/status/2058552301120360939`);
    await scout.queue.drain();

    expect(sent.map((s) => s.channel)).not.toContain('tradingFloor');
    expect(sent.map((s) => s.channel)).not.toContain('spx');
  });

  it('sends to Sprout when the relay states a publication time', async () => {
    const sent: Sent[] = [];
    const scout = buildScout(sent);
    const justNow = new Date(Date.now() - 60_000).toISOString();

    scout.relay(`Macro Alert (@DeItaone):

FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING

The Committee cited deteriorating labour market conditions.

${justNow}

https://x.com/DeItaone/status/2058552301120360940`);
    await scout.queue.drain();

    expect(scout.sproutPayloads).toHaveLength(1);
    const payload = scout.sproutPayloads[0]!;
    expect(payload.publishedAt).toBeTruthy();
    expect(payload.marketMoving).toBe(true);
    // Severity IS shared with Sprout — a trading system is exactly who it is for.
    expect(payload.severity).toBeTruthy();
  });

  it('produces one event when the same post is relayed to several channels', async () => {
    const sent: Sent[] = [];
    const scout = buildScout(sent);

    scout.relay(RELAY_MESSAGE, 'chan-a');
    scout.relay(RELAY_MESSAGE, 'chan-b');
    scout.relay(RELAY_MESSAGE, 'chan-c');
    await scout.queue.drain();

    expect(scout.outcomes.filter((o) => o.accepted)).toHaveLength(1);
    expect(sent.filter((s) => s.channel === 'news')).toHaveLength(1);
  });



  it('records FAILED_RETRIEVAL when the relay carried only a bare link', async () => {
    const sent: Sent[] = [];
    const scout = buildScout(sent, { bearerToken: '' });

    scout.relay('https://x.com/DeItaone/status/2058552301120360941');
    await scout.queue.drain();

    // Nothing to parse and no API configured — preserved for diagnostics
    // rather than silently dropped, and definitely not published.
    expect(db.jobs.byPostId('x:2058552301120360941')?.status).toBe('FAILED_RETRIEVAL');
    expect(sent).toHaveLength(0);
  });
});
