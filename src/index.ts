import { env } from './config/env.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from './config/loader.js';
import { openDatabase } from './db/index.js';
import { databaseExistsAt, recordBoot, formatStorageLine } from './db/storage.js';
import { createPipeline } from './pipeline/index.js';
import { createIngestManager } from './ingest/manager.js';
import { createRssAdapter } from './ingest/adapters/rss.js';
import { createEdgarAdapter } from './ingest/adapters/edgar.js';
import { createTwitterAdapter } from './ingest/adapters/twitter.js';
import { createManualAdapter } from './ingest/adapters/manual.js';
import { createDiscordListener } from './ingest/discordListener.js';
import { createJobQueue } from './ingest/queue.js';
import {
  createUrlWorker,
  createRelayStore,
  isFreshForTrading,
  UNKNOWN_PUBLICATION_TIME,
} from './ingest/urlWorker.js';
import {
  createXApiResolver,
  createRelayResolver,
  createStoredPostResolver,
  createChainResolver,
} from './ingest/resolver.js';
import { createDiscordClient } from './discord/client.js';
import { createPublisher } from './discord/publisher.js';
import { createHealthMonitor } from './health/monitor.js';
import { createStatsCollector } from './health/stats.js';
import { createScoutServer } from './server/http.js';
import { createRetentionJob } from './db/retention.js';
import { createSproutClient, toSproutEvent, type SproutClient } from './sprout/client.js';
import { replayFailedDeliveries } from './cli/replayDeliveries.js';
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

/**
 * How long shutdown waits for in-flight work before closing the database.
 *
 * Long enough for a Sprout request to reach its own timeout and record an
 * outcome — a shorter budget than the request it is waiting on would abandon
 * exactly the deliveries the replay exists to recover. Render allows roughly
 * 30 seconds between SIGTERM and SIGKILL, so this stays well inside that:
 * finishing cleanly is preferable, hanging is not.
 */
function shutdownDrainMs(sproutTimeoutMs: number): number {
  return Math.min(20_000, Math.max(5_000, sproutTimeoutMs + 2_000));
}

export async function main(): Promise<void> {
  const cfg = env();
  setLogLevel(cfg.logLevel);
  const startedAt = new Date();

  log.info('starting', { dryRun: cfg.dryRun, db: cfg.databasePath });

  // ── Storage ────────────────────────────────────────────────────────────────
  //
  // Every piece of state Scout relies on lives in this one file: the
  // processed-post set that makes dedupe work, the delivery log the replay
  // reads, the calendar keys that stop a reminder firing twice. On Render it
  // has to sit on the mounted disk. If it does not, each deploy wipes it and
  // Scout reposts old headlines as breaking news — while booting cleanly and
  // reporting healthy, which is what makes it dangerous.
  //
  // Whether the file existed has to be sampled BEFORE opening, since opening
  // creates it.
  const existedAtBoot = databaseExistsAt(cfg.databasePath);
  const db = openDatabase(cfg.databasePath);
  db.migrate();

  // The boot counter lives in the database, so it can only survive if the file
  // survives. Reading "boot #1" after a redeploy is proof the disk is missing.
  const storage = recordBoot(db, {
    databasePath: cfg.databasePath,
    existedAtBoot,
    nowIso: isoNow(),
  });
  log.info(formatStorageLine(storage), {
    durability: storage.durability,
    boots: storage.boots,
    existedAtBoot: storage.existedAtBoot,
    fileBytes: storage.fileBytes,
    retained: storage.retained,
  });
  for (const warning of storage.warnings) log.warn('STORAGE WARNING', { warning });

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
  //
  // Missing configuration here has to be fatal. Publishing is the entire point
  // of the service, and the Discord client degrades quietly by design — with no
  // token it logs a warning and carries on, which would leave Scout booting,
  // answering /health with 200, and silently delivering nothing at all. A
  // deployment that fails loudly gets fixed; a mute one does not.
  if (!cfg.dryRun) {
    if (!cfg.discord.token) {
      throw new Error(
        'DISCORD_BOT_TOKEN is not set. Scout exists to publish to Discord, so it will not ' +
          'start without it — a running service that delivers nothing is the worst possible ' +
          'failure. Set DISCORD_BOT_TOKEN (DISCORD_TOKEN is also accepted), or set ' +
          'DRY_RUN=true to exercise the pipeline without publishing.',
      );
    }
    if (!cfg.discord.channels.news) {
      throw new Error(
        'DISCORD_CHANNEL_NEWS is not set. Every qualified alert routes to #scout-news, so ' +
          'without it nothing has anywhere to go. Run `npm run discord:setup` to create the ' +
          'channels and print their ids.',
      );
    }
  }

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

  // A database on ephemeral storage is the one misconfiguration that is
  // invisible from the outside, so the warning goes where an operator will see
  // it rather than only into the log stream. publishSystem never throws.
  for (const warning of storage.warnings) {
    await publisher.publishSystem(`STORAGE WARNING\n\n${warning}`);
  }

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
  const sproutTransport = createSproutClient({
    url: cfg.sprout.url,
    token: cfg.sprout.token,
    timeoutMs: cfg.sprout.timeoutMs,
    logger: log.child('sprout'),
  });

  /**
   * Times every Sprout hand-off, wherever it comes from.
   *
   * Wrapped here rather than at the call sites so the first delivery and the
   * replay are measured by the same code — two timers around the same call is
   * how the two paths quietly start disagreeing.
   */
  const sprout: SproutClient = {
    enabled: sproutTransport.enabled,
    async send(event) {
      const started = Date.now();
      try {
        const result = await sproutTransport.send(event);
        db.metrics.record('sprout_delivery_ms', Date.now() - started);
        db.metrics.record(
          result.ok
            ? 'sprout_delivered_total'
            : result.skipped
              ? 'sprout_skipped_total'
              : 'sprout_failed_total',
          1,
        );
        return result;
      } catch (err) {
        db.metrics.record('sprout_delivery_ms', Date.now() - started);
        db.metrics.record('sprout_failed_total', 1);
        throw err;
      }
    },
  };

  // ── Pipeline ───────────────────────────────────────────────────────────────
  const pipeline = createPipeline({
    db,
    taxonomy,
    securities,
    config: { ...cfg.pipeline, categoryChannelsEnabled: cfg.discord.categoryChannelsEnabled },
    logger: log.child('pipeline'),
  });

  /**
   * Pipeline work currently in flight, so shutdown can let it finish.
   *
   * By the time a post reaches Discord it has already been written to
   * `raw_posts` and `news_events`, which is what makes truncation permanent:
   * on the next boot the dedupe layer recognises the post and suppresses it, so
   * an alert cut off mid-publish is never retried and never seen. The same
   * applies to the Sprout hand-off, whose delivery row is written only after
   * the request returns — kill the process mid-request and no row exists for
   * the replay to find.
   */
  const inFlightPosts = new Set<Promise<void>>();

  function trackPost(raw: RawPost): Promise<void> {
    const work = processPost(raw).finally(() => inFlightPosts.delete(work));
    inFlightPosts.add(work);
    return work;
  }

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
      status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED',
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
      // Still in #scout-news, deliberately not a trading event. The two skip
      // reasons are counted apart: "the upstream source stopped sending
      // timestamps" and "news aged out before it could be delivered" are
      // different faults, and a merged total hides both.
      db.metrics.record(
        freshness.reason === UNKNOWN_PUBLICATION_TIME
          ? 'events_unknown_time_total'
          : 'events_stale_total',
        1,
      );
      record('SKIPPED', freshness.reason, null);
      return;
    }

    // Claim the row BEFORE the request, not after.
    //
    // The outcome is recorded when `send` settles, which with Sprout down means
    // ten seconds later. Kill the process inside that window — a deploy, an OOM,
    // a crash — and no row is ever written, so the replay, the machinery built
    // for exactly this outage, is structurally blind to the event. A PENDING row
    // that never gets overwritten is the durable evidence that a delivery
    // started and never reported back.
    record('PENDING', null, null);

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
      // Content already persisted by the webhook path. Resolves with no
      // retrieval at all, which is how a pushed event joins the identical
      // processor a relayed one uses.
      createStoredPostResolver((canonicalId) => {
        const stored = db.posts.byId(canonicalId);
        if (!stored || stored.retrievalSource !== 'webhook') return null;
        return {
          author: stored.author,
          authorHandle: stored.authorHandle,
          text: stored.text,
          publishedAt: stored.publishedAt,
          canonicalUrl: stored.canonicalUrl,
          retrievalSource: stored.retrievalSource,
        };
      }),
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
      await trackPost(post);
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
      for (const post of posts) await trackPost(post);
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

  // ── Automatic Sprout recovery ─────────────────────────────────────────────
  //
  // Runs INSIDE this service rather than as a separate Render cron job. A cron
  // job gets its own container and cannot mount this service's disk, so it
  // could not see the database at all — it would report "nothing to replay"
  // forever while deliveries piled up. POST /admin/replay exists for the same
  // job driven over HTTP if an external schedule is preferred.
  const runReplay = async (reason: string): Promise<Record<string, unknown>> => {
    const report = await replayFailedDeliveries(
      {
        db,
        sprout,
        taxonomy,
        securities,
        maxAgeMinutes: cfg.sprout.maxAgeMinutes,
        logger: log.child('replay'),
      },
      {
        status: 'FAILED',
        sinceIso: new Date(Date.now() - cfg.replay.windowMinutes * 60_000).toISOString(),
        limit: cfg.replay.limit,
        // Identifies this run's claim, so two overlapping passes take disjoint
        // sets and the same delivery is never sent twice.
        claimant: `${reason}-${process.pid}`,
        // A pass must finish well inside the interval, so a slow Sprout cannot
        // leave one run still working while the next tick starts.
        maxRunMs: Math.max(30_000, cfg.replay.intervalMinutes * 60_000 - 30_000),
      },
    );
    return {
      found: report.candidates,
      delivered: report.delivered,
      skippedStale: report.skippedStale,
      skippedUnknownTime: report.skippedUnknownTime,
      stillFailing: report.failed,
      unresolvable: report.unresolvable,
      deferred: report.deferred,
    };
  };

  let replayTimer: NodeJS.Timeout | null = null;
  /**
   * The currently running pass, or null. Tracked as a promise rather than a
   * boolean for two reasons: a second caller can join the run already in
   * progress instead of starting a redundant one, and shutdown has something
   * concrete to wait on before the database closes underneath it.
   */
  let replayInFlight: Promise<Record<string, unknown>> | null = null;

  const runReplayOnce = (reason: string): Promise<Record<string, unknown>> => {
    // Overlapping passes are safe — the database claim guarantees that — but
    // they are pointless work, so a caller arriving mid-pass joins it.
    if (replayInFlight) return replayInFlight;

    const run = runReplay(reason).finally(() => {
      replayInFlight = null;
    });
    replayInFlight = run;
    return run;
  };

  if (cfg.replay.enabled && sprout.enabled) {
    const intervalMs = Math.max(60_000, cfg.replay.intervalMinutes * 60_000);
    replayTimer = setInterval(() => {
      // Every failure mode ends here: a rejected promise, a throw inside the
      // replay, a database error. None of them may kill the timer, because a
      // scheduler that dies silently is indistinguishable from one with
      // nothing to do.
      void runReplayOnce('scheduled').catch((err: Error) =>
        log.error('scheduled replay failed; the schedule continues', { err }),
      );
    }, intervalMs);
    if (typeof replayTimer.unref === 'function') replayTimer.unref();
    log.info('sprout replay scheduled', {
      everyMinutes: cfg.replay.intervalMinutes,
      windowMinutes: cfg.replay.windowMinutes,
      limit: cfg.replay.limit,
    });
  } else if (cfg.replay.enabled && !sprout.enabled) {
    log.info('sprout replay idle: SPROUT_URL is not configured');
  }

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
    databasePath: cfg.databasePath,
    admin: cfg.webhook.adminToken
      ? { token: cfg.webhook.adminToken, replay: () => runReplayOnce('admin') }
      : undefined,
    webhook: cfg.webhook.token
      ? {
          token: cfg.webhook.token,
          // Persist, queue, return. Nothing here awaits Discord, Sprout,
          // classification or any external call — the upstream source is
          // acknowledged as soon as the event is durable.
          accept: (event, key) => {
            const now = isoNow();

            db.posts.upsert({
              postId: event.canonicalId,
              author: event.upstreamSource,
              authorHandle: event.handle,
              text: event.text,
              // Exactly as supplied, including null. The receipt time below is
              // a separate column and is never promoted into this one.
              publishedAt: event.publishedAt,
              canonicalUrl: event.url,
              media: [],
              retrievalSource: 'webhook',
              platform: event.platform,
              upstreamSource: event.upstreamSource,
              receivedAt: event.receivedAt,
              discordReceivedAt: null,
              createdAt: now,
            });

            const job = queue.enqueue({
              postId: event.canonicalId,
              url: event.url,
              sourceChannel: `webhook:${key}`,
              sourceKind: 'webhook',
            });

            return {
              accepted: job !== null,
              duplicate: job === null,
              eventId: event.canonicalId,
            };
          },
        }
      : undefined,
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
    admin: cfg.webhook.adminToken ? 'enabled at POST /admin/replay' : 'not configured',
    webhook: cfg.webhook.token ? 'enabled at POST /webhook/news' : 'not configured',
    sprout: sprout.enabled ? 'configured' : 'not configured',
    replay: replayTimer ? `every ${cfg.replay.intervalMinutes}m` : 'off',
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
    if (replayTimer) clearInterval(replayTimer);
    health.stop();
    await listener.stop();
    await discord.stop();
    await server.stop();

    // Let work that is already under way finish before the database closes.
    //
    // This is not tidiness. A post mid-publish has already been recorded in
    // raw_posts and news_events, so on the next boot dedupe suppresses it —
    // truncate it here and that alert is never sent and never retried. A Sprout
    // hand-off mid-request has no delivery row yet, so the replay would never
    // find it either. Both become permanent losses at the exact moment they are
    // most likely: a deploy.
    //
    // Bounded, though. Render sends SIGKILL soon after SIGTERM, and a shutdown
    // that hangs is worse than one delivery arriving late.
    const pending: Array<Promise<unknown>> = [...inFlightPosts];
    if (replayInFlight) pending.push(replayInFlight);
    if (pending.length > 0) {
      const budgetMs = shutdownDrainMs(cfg.sprout.timeoutMs);
      log.info('draining in-flight work', {
        posts: inFlightPosts.size,
        replay: Boolean(replayInFlight),
        budgetMs,
      });
      await Promise.race([
        // allSettled, so one rejection cannot skip the rest of the drain.
        Promise.allSettled(pending),
        new Promise<void>((done) => {
          const t = setTimeout(done, budgetMs);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    }

    // Never let a close error mask the shutdown itself.
    try {
      db.close();
    } catch (err) {
      log.warn('database close failed', { err: err as Error });
    }
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
