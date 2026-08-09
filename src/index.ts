import { env } from './config/env.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from './config/loader.js';
import { openDatabase } from './db/index.js';
import { createPipeline } from './pipeline/index.js';
import { createIngestManager } from './ingest/manager.js';
import { createRssAdapter } from './ingest/adapters/rss.js';
import { createEdgarAdapter } from './ingest/adapters/edgar.js';
import { createTwitterAdapter } from './ingest/adapters/twitter.js';
import { createManualAdapter } from './ingest/adapters/manual.js';
import { createDiscordListener } from './ingest/discordListener.js';
import { createJobQueue } from './ingest/queue.js';
import { createUrlWorker, createRelayStore, isFreshForTrading } from './ingest/urlWorker.js';
import { createXApiResolver, createRelayResolver, createChainResolver } from './ingest/resolver.js';
import { createDiscordClient } from './discord/client.js';
import { createPublisher } from './discord/publisher.js';
import { createHealthMonitor } from './health/monitor.js';
import { createStatsCollector } from './health/stats.js';
import { createScoutServer } from './server/http.js';
import { createRetentionJob } from './db/retention.js';
import { createSproutClient, toSproutEvent } from './sprout/client.js';
import { loadCalendar, createCalendarScheduler } from './calendar/scheduler.js';
import { routeCalendarReminder } from './discord/router.js';
import { createLogger, setLogLevel } from './util/logger.js';
import { isoNow } from './util/time.js';
import type { RawPost } from './core/types.js';

/**
 * Scout runtime wiring.
 *
 * Everything above this file is a pure-ish module with injected dependencies;
 * this is the one place that knows about the real database, the real network
 * and the real gateway.
 *
 * Scout is an always-on wire. There is no market-hours gate anywhere in here —
 * geopolitical, policy and overnight-session news breaks at every hour, so the
 * pipeline runs identically at 3am on a Sunday as it does at the open.
 */

const log = createLogger('scout');

/** Source id that relayed X posts are attributed to. */
const RELAY_SOURCE_ID = 'relay:discord-urls';

export async function main(): Promise<void> {
  const cfg = env();
  setLogLevel(cfg.logLevel);
  const startedAt = new Date();

  log.info('starting', { dryRun: cfg.dryRun, db: cfg.databasePath });

  // ── Storage ────────────────────────────────────────────────────────────────
  const db = openDatabase(cfg.databasePath);
  db.migrate();

  // ── Config → DB (the source list is data, not code) ───────────────────────
  const sourcesFile = loadSourcesFile();
  const now = isoNow();
  db.sources.upsertMany(sourcesFile.sources.map((s) => toSource(s, now)));

  const taxonomy = loadTaxonomy();
  const securities = loadSecurityMaster();
  db.securities.upsertMany(securities);

  log.info('config loaded', {
    sources: sourcesFile.sources.length,
    enabled: db.sources.enabled().length,
    securities: securities.length,
  });

  // ── Discord (publishing) ───────────────────────────────────────────────────
  const discord = createDiscordClient({
    token: cfg.discord.token,
    guildId: cfg.discord.guildId,
    channels: cfg.discord.channels,
    dryRun: cfg.dryRun,
    logger: log.child('discord'),
  });
  await discord.start();

  const publisher = createPublisher({
    discord,
    db,
    logger: log.child('publisher'),
    rawChannelEnabled: cfg.discord.rawChannelEnabled,
  });

  // ── Health & stats ─────────────────────────────────────────────────────────
  const health = createHealthMonitor({
    db,
    logger: log.child('health'),
    // Feed warnings go to the admin channel, never to the trading channels.
    onWarning: async (msg) => {
      await publisher.publishSystem(msg);
    },
  });
  const stats = createStatsCollector({ db });

  // Scout is the information layer; Sprout consumes normalized events. With no
  // SPROUT_URL this is inert, which is the normal MVP state.
  const sprout = createSproutClient({
    url: cfg.sprout.url,
    token: cfg.sprout.token,
    timeoutMs: cfg.sprout.timeoutMs,
    logger: log.child('sprout'),
  });

  // ── Pipeline ───────────────────────────────────────────────────────────────
  const pipeline = createPipeline({
    db,
    taxonomy,
    securities,
    config: { ...cfg.pipeline, categoryChannelsEnabled: cfg.discord.categoryChannelsEnabled },
    logger: log.child('pipeline'),
  });

  async function processPost(raw: RawPost): Promise<void> {
    try {
      const outcome = await pipeline.process(raw);

      stats.recordReceived(raw.sourceId);
      if (outcome.accepted) {
        stats.recordAccepted(raw.sourceId, outcome.newsEvent.importance);
        const result = await publisher.publish(outcome);

        // Freshness is judged on publication time alone. An old headline may
        // still appear in #scout-news, but it is not a fresh trading event.
        const publishedAt =
          typeof raw.meta.publishedAt === 'string' ? raw.meta.publishedAt : raw.eventTime;
        const freshness = isFreshForTrading(publishedAt, cfg.sprout.maxAgeMinutes);

        for (const channel of result.channels) {
          db.deliveries.record({
            eventId: outcome.cluster?.id ?? outcome.newsEvent.id,
            destination: channel,
            status: 'SENT',
            discordMessageId: result.messageIds[channel] ?? null,
            sentAt: isoNow(),
            error: null,
            createdAt: isoNow(),
          });
        }

        await deliverToSprout(outcome, publishedAt, freshness);
      } else if (outcome.rejection?.startsWith('DUPLICATE')) {
        stats.recordDuplicate(raw.sourceId);
      } else if (outcome.rejection) {
        stats.recordRejected(raw.sourceId, outcome.rejection);
      }

      await publisher.publishRaw(outcome.raw);
    } catch (err) {
      // One malformed post must never stop the wire.
      log.error('pipeline failure', {
        sourceId: raw.sourceId,
        sourcePostId: raw.sourcePostId,
        err: err as Error,
      });
    }
  }

  /**
   * Hands a normalized event to Sprout, but only when it passes the freshness
   * gate. Sprout being down must never stop the Discord wire, so every outcome
   * is recorded and nothing here throws.
   */
  async function deliverToSprout(
    outcome: Awaited<ReturnType<typeof pipeline.process>>,
    publishedAt: string | null,
    freshness: { fresh: boolean; reason: string },
  ): Promise<void> {
    const eventId = outcome.cluster?.id ?? outcome.newsEvent.id;

    const record = (
      status: 'SENT' | 'FAILED' | 'SKIPPED',
      error: string | null,
      sentAt: string | null,
    ): void => {
      db.deliveries.record({
        eventId,
        destination: 'sprout',
        status,
        discordMessageId: null,
        sentAt,
        error,
        createdAt: isoNow(),
      });
    };

    if (!sprout.enabled) {
      record('SKIPPED', 'SPROUT_URL not configured', null);
      return;
    }
    if (!freshness.fresh) {
      // Still in #scout-news, deliberately not a trading event.
      record('SKIPPED', freshness.reason, null);
      return;
    }

    try {
      const result = await sprout.send(
        toSproutEvent({
          newsEvent: outcome.newsEvent,
          cluster: outcome.cluster,
          impact: outcome.impact,
          publishedAt,
        }),
      );
      if (result.ok) {
        record('SENT', null, isoNow());
      } else {
        record(result.skipped ? 'SKIPPED' : 'FAILED', result.error ?? result.reason, null);
        log.warn('sprout delivery failed', { eventId, reason: result.reason, error: result.error });
      }
    } catch (err) {
      record('FAILED', (err as Error).message, null);
      log.error('sprout delivery threw', { eventId, err: err as Error });
    }
  }

  // ── 24/7 URL ingestion ─────────────────────────────────────────────────────
  // One bounded store shared by the worker and the relay resolver, so a payload
  // is written once, read once, and evicted — rather than accumulating in two
  // maps for the life of the process.
  const relayStore = createRelayStore(500);

  // Relay content FIRST. When the permitted relay already carries the text,
  // that is both faster than an upstream request and needs no credential — it
  // is the primary path, not a fallback. The API resolver is tried only when
  // the relay carried nothing usable, and only when it is configured at all.
  const resolver = createChainResolver(
    [
      createRelayResolver((url) => {
        const relay = relayStore.get(url.canonicalId);
        return relay ? { rawMessage: relay.rawMessage } : null;
      }),
      createXApiResolver({
        bearerToken: cfg.x.bearerToken,
        timeoutMs: cfg.ingestion.resolveTimeoutMs,
        logger: log.child('resolver'),
      }),
    ],
    log.child('resolver'),
  );

  // An absent X credential is a normal configuration, not a fault.
  log.info(
    cfg.x.bearerToken
      ? 'X API: CONFIGURED (fallback resolver) — URL/RELAY INGESTION: ENABLED'
      : 'X API: NOT CONFIGURED — URL/RELAY INGESTION: ENABLED',
  );

  let urlWorkerRef: ReturnType<typeof createUrlWorker> | null = null;

  const queue = createJobQueue({
    db,
    logger: log.child('queue'),
    concurrency: cfg.ingestion.concurrency,
    maxAttempts: cfg.ingestion.maxAttempts,
    handler: async (job) => {
      if (!urlWorkerRef) throw new Error('url worker not initialised');
      try {
        await urlWorkerRef.handle(job);
      } catch (err) {
        // A retrieval that failed is a feed problem, and the health monitor is
        // how "this relay stopped working" becomes visible rather than looking
        // like a quiet news period. Successes are recorded in onPost.
        health.recordPoll({
          sourceId: RELAY_SOURCE_ID,
          ok: false,
          itemCount: 0,
          error: (err as Error).message,
          latencyMs: 0,
        });
        throw err;
      }
    },
  });

  const urlWorker = createUrlWorker({
    db,
    queue,
    resolver,
    logger: log.child('url-worker'),
    allowedAccounts: cfg.ingestion.allowedXAccounts,
    relayStore,
    relaySourceId: RELAY_SOURCE_ID,
    onPost: async (post) => {
      // Feed the health monitor so a relay that goes quiet is distinguishable
      // from one that is broken, exactly as for the polled sources.
      health.recordPoll({ sourceId: RELAY_SOURCE_ID, ok: true, itemCount: 1, latencyMs: 0 });
      await processPost(post);
    },
  });
  urlWorkerRef = urlWorker;

  const listener = createDiscordListener({
    token: cfg.discord.token,
    newsChannelIds: cfg.discord.newsSourceChannelIds,
    truthSocialChannelIds: cfg.discord.truthSocialChannelIds,
    adminChannelIds: cfg.discord.adminInputChannelIds,
    logger: log.child('listener'),
    onUrl: (message) => {
      urlWorker.submit(message);
    },
  });

  // A separate gateway connection from the publisher, deliberately: the
  // listener needs the privileged MessageContent intent, and if that is not
  // enabled for the bot, login is REJECTED outright. Sharing one client would
  // mean a missing portal setting takes down publishing too. Here it degrades
  // to "no URL ingestion" and the RSS/EDGAR/X layers carry on.
  let listenerStarted = false;
  try {
    await listener.start();
    listenerStarted = true;
  } catch (err) {
    log.error(
      'URL ingestion could not start; Scout will run without it. If this is an intent error, ' +
        'enable MESSAGE CONTENT for the bot in the Discord developer portal.',
      { err: err as Error },
    );
  }
  queue.start();

  // ── Polling ingestion (RSS / EDGAR / X timelines) ─────────────────────────
  const manual = createManualAdapter();
  const ingest = createIngestManager({
    db,
    adapters: [
      createRssAdapter({ userAgent: cfg.sec.userAgent, timeoutMs: 15_000, logger: log.child('rss') }),
      createEdgarAdapter({ userAgent: cfg.sec.userAgent, timeoutMs: 15_000, logger: log.child('edgar') }),
      createTwitterAdapter({
        bearerToken: cfg.x.bearerToken,
        requestBudgetPerWindow: cfg.x.requestBudgetPerWindow,
        logger: log.child('x'),
      }),
      manual,
    ],
    logger: log.child('ingest'),
    intervals: {
      rss: cfg.rss.pollIntervalMs,
      edgar: cfg.sec.pollIntervalMs,
      x: cfg.x.pollIntervalMs,
      manual: 5_000,
    },
    onPosts: async (posts) => {
      for (const post of posts) await processPost(post);
    },
    onOutcome: (outcome) => health.recordPoll(outcome),
  });

  ingest.start();
  health.start(60_000);

  // ── Scheduled calendar reminders ──────────────────────────────────────────
  const calendar = loadCalendar();
  const scheduler = createCalendarScheduler({
    events: calendar.events,
    timeZone: calendar.timeZone,
    logger: log.child('calendar'),
    hasFired: (key) =>
      Boolean(db.raw.prepare('SELECT 1 FROM calendar_fired WHERE key = ?').get(key)),
    markFired: (key) =>
      void db.raw
        .prepare('INSERT OR IGNORE INTO calendar_fired (key, fired_at) VALUES (?, ?)')
        .run(key, isoNow()),
    publish: async (rendered) => {
      for (const channel of routeCalendarReminder().channels) {
        await discord.send(channel, rendered);
      }
    },
  });
  scheduler.start(60_000);
  log.info('calendar loaded', { events: calendar.events.length });

  // ── Retention ─────────────────────────────────────────────────────────────
  // Every table Scout appends to needs a ceiling, or a process that runs for
  // months slowly fills its disk and its percentile queries get slower.
  const retention = createRetentionJob({ db, logger: log.child('retention') });
  retention.start(6 * 3600_000);

  // ── Operational endpoints ──────────────────────────────────────────────────
  const server = createScoutServer({
    db,
    logger: log.child('http'),
    port: cfg.port,
    startedAt,
    readiness: () => [
      { name: 'database', ok: databaseReachable(), detail: cfg.databasePath },
      {
        name: 'discord-publisher',
        ok: cfg.dryRun || discord.isReady(),
        detail: cfg.dryRun ? 'dry run' : undefined,
      },
      {
        // Only a hard requirement when input channels are configured; a
        // deployment running purely on RSS/EDGAR is legitimately ready. But if
        // channels ARE configured and the listener is down, ingestion is dead
        // and /ready must say so rather than reporting a healthy service that
        // silently receives nothing.
        name: 'url-listener',
        ok: listener.watching().length === 0 || (listenerStarted && listener.isReady()),
        detail:
          listener.watching().length === 0
            ? 'no input channels configured'
            : `${listener.watching().length} channels watched, ready=${listener.isReady()}`,
      },
    ],
  });

  function databaseReachable(): boolean {
    try {
      db.raw.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  await server.start();

  log.info('scout is live', {
    watching: listener.watching().length,
    sprout: sprout.enabled ? 'configured' : 'not configured',
    tradingChannelsConfigured: Boolean(cfg.discord.channels.tradingFloor && cfg.discord.channels.spx),
  });

  // ── Shutdown ───────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    ingest.stop();
    queue.stop();
    scheduler.stop();
    retention.stop();
    health.stop();
    await listener.stop();
    await discord.stop();
    await server.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { err: reason as Error });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[\\/])index\.(?:ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    log.error('fatal', { err: err as Error });
    process.exit(1);
  });
}
