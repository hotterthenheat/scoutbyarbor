import { env } from './config/env.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from './config/loader.js';
import { openDatabase } from './db/index.js';
import { createPipeline } from './pipeline/index.js';
import { createIngestManager } from './ingest/manager.js';
import { createRssAdapter } from './ingest/adapters/rss.js';
import { createEdgarAdapter } from './ingest/adapters/edgar.js';
import { createTwitterAdapter } from './ingest/adapters/twitter.js';
import { createManualAdapter } from './ingest/adapters/manual.js';
import { createDiscordClient } from './discord/client.js';
import { createPublisher } from './discord/publisher.js';
import { createHealthMonitor } from './health/monitor.js';
import { createStatsCollector } from './health/stats.js';
import { createLogger, setLogLevel } from './util/logger.js';
import { isoNow } from './util/time.js';
import type { RawPost } from './core/types.js';

/**
 * Scout runtime wiring.
 *
 * Everything above this file is a pure-ish module with injected dependencies;
 * this is the one place that knows about the real database, the real network
 * and the real gateway.
 */

const log = createLogger('scout');

export async function main(): Promise<void> {
  const cfg = env();
  setLogLevel(cfg.logLevel);

  log.info('starting', { dryRun: cfg.dryRun, db: cfg.databasePath });

  // ── Storage ────────────────────────────────────────────────────────────────
  const db = openDatabase(cfg.databasePath);
  db.migrate();

  // ── Config → DB (§36: the source list is data, not code) ──────────────────
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
    taxonomyVersion: taxonomy.version,
  });

  // ── Discord ────────────────────────────────────────────────────────────────
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

  // ── Health & stats (§22, §23, §28) ────────────────────────────────────────
  const health = createHealthMonitor({
    db,
    logger: log.child('health'),
    onWarning: async (msg) => {
      // A broken feed is an operational event, not a quiet news day.
      await publisher.publishSystem(msg);
    },
  });
  const stats = createStatsCollector({ db });

  // ── Pipeline ───────────────────────────────────────────────────────────────
  const pipeline = createPipeline({
    db,
    taxonomy,
    securities,
    config: cfg.pipeline,
    logger: log.child('pipeline'),
  });

  async function onPosts(posts: RawPost[]): Promise<void> {
    for (const raw of posts) {
      try {
        const outcome = await pipeline.process(raw);

        stats.recordReceived(raw.sourceId);
        if (outcome.accepted) {
          stats.recordAccepted(raw.sourceId, outcome.newsEvent.importance);
          await publisher.publish(outcome);
        } else if (outcome.rejection?.startsWith('DUPLICATE')) {
          stats.recordDuplicate(raw.sourceId);
        } else if (outcome.rejection) {
          stats.recordRejected(raw.sourceId, outcome.rejection);
        }

        // Every decision — accepted or not — is visible in the admin channel.
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
  }

  // ── Ingestion ──────────────────────────────────────────────────────────────
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
    onPosts,
  });

  ingest.start();
  health.start(60_000);

  log.info('scout is live');

  // ── Shutdown ───────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    ingest.stop();
    health.stop();
    await discord.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { err: reason as Error });
  });
}

// Only auto-start when executed directly, so the CLI can import this module.
const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[\\/])index\.(?:ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    log.error('fatal', { err: err as Error });
    process.exit(1);
  });
}
