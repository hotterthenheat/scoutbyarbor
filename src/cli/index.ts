import { env } from '../config/env.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../config/loader.js';
import { openDatabase } from '../db/index.js';
import { createPipeline } from '../pipeline/index.js';
import { createTwitterAdapter } from '../ingest/adapters/twitter.js';
import { createRssAdapter } from '../ingest/adapters/rss.js';
import { createEdgarAdapter } from '../ingest/adapters/edgar.js';
import { parseXPostUrl } from '../ingest/adapters/manual.js';
import { createDiscordClient, CHANNEL_ENV_VARS } from '../discord/client.js';
import { createStatsCollector, formatSourceReport, formatPipelineReport } from '../health/stats.js';
import { renderAlert } from '../render/alert.js';
import { createSproutClient } from '../sprout/client.js';
import {
  replayFailedDeliveries,
  formatReplayReport,
  parseSince,
  type ReplayOptions,
} from './replayDeliveries.js';
import { createLogger, setLogLevel } from '../util/logger.js';
import { isoNow } from '../util/time.js';
import { deterministicId } from '../util/id.js';
import type { RawPost, SourceVerification } from '../core/types.js';

/**
 * Operator CLI. Everything here is something you want to do without restarting
 * the bot: sync the watchlist, verify handles, inspect source quality, replay
 * stored traffic through a changed classifier.
 */

const log = createLogger('cli');

const COMMANDS = `
scout — Arbor Capital

  db:migrate              apply the schema
  sources:sync            load config/sources.yaml into the database (§36)
  sources:verify          confirm every handle and feed URL resolves (§29)
  sources:report [days]   per-source accept/reject/duplicate stats (§28)
  pipeline:report [days]  alerts, duplicate rate, latency percentiles (§22/§34)
  discord:setup           create any missing channels and print their ids (§26)
  ingest:url <url>        push one X post URL through the pipeline
  replay [limit]          re-run stored raw posts through the current classifier
  classify "<text>"       dry-run the pipeline over a literal string

  deliveries:replay       re-drive failed Sprout deliveries
      --failed              only FAILED deliveries (the default)
      --skipped             re-check deliveries held by the freshness gate
      --since 30m           only those recorded within the window (s/m/h/d)
      --id x:123456         a single event id or provider post id
      --limit 100           cap the number replayed
      --dry-run             report what would happen, send nothing
`;

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const cfg = env();
  setLogLevel(cfg.logLevel);

  switch (command) {
    case 'db:migrate':
      return dbMigrate(cfg.databasePath);
    case 'sources:sync':
      return sourcesSync(cfg.databasePath);
    case 'sources:verify':
      return sourcesVerify(cfg.databasePath);
    case 'sources:report':
      return sourcesReport(cfg.databasePath, Number(args[0] ?? 7));
    case 'pipeline:report':
      return pipelineReport(cfg.databasePath, Number(args[0] ?? 7));
    case 'discord:setup':
      return discordSetup();
    case 'ingest:url':
      return ingestUrl(args[0] ?? '');
    case 'replay':
      return replay(Number(args[0] ?? 200));
    case 'classify':
      return classifyText(args.join(' '));
    case 'deliveries:replay':
      return deliveriesReplay(args);
    default:
      process.stdout.write(COMMANDS);
      if (command) process.exitCode = 1;
  }
}

function dbMigrate(path: string): void {
  const db = openDatabase(path);
  db.migrate();
  db.close();
  process.stdout.write(`migrated ${path}\n`);
}

function sourcesSync(path: string): void {
  const db = openDatabase(path);
  db.migrate();
  const file = loadSourcesFile();
  const now = isoNow();
  db.sources.upsertMany(file.sources.map((s) => toSource(s, now)));
  db.securities.upsertMany(loadSecurityMaster());

  const enabled = db.sources.enabled();
  process.stdout.write(
    `synced ${file.sources.length} sources (${enabled.length} enabled)\n` +
      enabled
        .slice()
        .sort((a, b) => b.priority - a.priority)
        .map(
          (s) =>
            `  ${String(s.priority).padStart(3)}  ${s.sourceType.padEnd(6)}  ${s.id.padEnd(28)}  q${s.qualityScore}/n${s.noiseScore}${s.filterProfile === 'strict' ? '  [strict]' : ''}`,
        )
        .join('\n') +
      '\n',
  );
  db.close();
}

/**
 * §29 — do not trust a handle just because a list claims it exists. This checks
 * X handles against the API and RSS/EDGAR URLs with a real request, then marks
 * the row verified or leaves it unverified with the reason printed.
 */
async function sourcesVerify(path: string): Promise<void> {
  const cfg = env();
  const db = openDatabase(path);
  db.migrate();

  const adapters = [
    createTwitterAdapter({
      bearerToken: cfg.x.bearerToken,
      requestBudgetPerWindow: cfg.x.requestBudgetPerWindow,
      logger: log.child('x'),
    }),
    createRssAdapter({ userAgent: cfg.sec.userAgent, timeoutMs: 20_000, logger: log.child('rss') }),
    createEdgarAdapter({ userAgent: cfg.sec.userAgent, timeoutMs: 20_000, logger: log.child('edgar') }),
  ];

  const results: SourceVerification[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // An absent X credential is a normal configuration, not a failure. Verifying
  // what cannot be verified would report every X source as broken and make the
  // command look like a deployment blocker, which it is not.
  const xConfigured = Boolean(cfg.x.bearerToken);

  for (const source of db.sources.all()) {
    if (source.sourceType === 'manual') {
      // Nothing remote to check: a relay source is fed by Discord, not polled.
      skipped.push({ id: source.id, reason: 'relay source, fed by Discord' });
      continue;
    }
    if (source.sourceType === 'x' && !xConfigured) {
      skipped.push({ id: source.id, reason: 'X_BEARER_TOKEN not configured' });
      continue;
    }
    const adapter = adapters.find((a) => a.type === source.sourceType);
    if (!adapter?.verify) {
      results.push({
        sourceId: source.id,
        ok: false,
        detail: `no verifier for source type ${source.sourceType}`,
      });
      continue;
    }
    try {
      const v = await adapter.verify(source);
      results.push(v);
      db.sources.setVerified(source.id, v.ok);
    } catch (err) {
      results.push({ sourceId: source.id, ok: false, detail: (err as Error).message });
      db.sources.setVerified(source.id, false);
    }
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  // Ingestion posture first: which paths are actually live.
  const relayChannels =
    cfg.discord.newsSourceChannelIds.length +
    cfg.discord.truthSocialChannelIds.length +
    cfg.discord.adminInputChannelIds.length;

  process.stdout.write(
    `\nX API verification: ${xConfigured ? 'ENABLED' : 'SKIPPED'}\n` +
      (xConfigured ? '' : 'Reason: X_BEARER_TOKEN not configured\n') +
      `\nDiscord relay verification: ${relayChannels > 0 ? 'ENABLED' : 'NOT CONFIGURED'}\n` +
      (relayChannels > 0
        ? `  ${relayChannels} input channel(s) configured\n` +
          `  ${cfg.discord.token ? 'bot token present' : 'DISCORD_BOT_TOKEN is NOT set — the listener cannot start'}\n`
        : '  Set NEWS_SOURCE_CHANNEL_IDS to enable URL ingestion\n'),
  );

  process.stdout.write(`\nVERIFIED  ${ok.length}\n`);
  for (const r of ok) process.stdout.write(`  ok    ${r.sourceId}  ${r.resolvedName ?? ''}\n`);

  if (skipped.length) {
    process.stdout.write(`\nSKIPPED  ${skipped.length}\n`);
    for (const sk of skipped) process.stdout.write(`  --    ${sk.id}  (${sk.reason})\n`);
  }

  process.stdout.write(`\nUNVERIFIED  ${bad.length}\n`);
  for (const r of bad) process.stdout.write(`  FAIL  ${r.sourceId}  ${r.detail}\n`);

  if (bad.length) {
    process.stdout.write(
      `\nUnverified sources stay in the config but should not be trusted until they resolve.\n` +
        `Set enabled: false in config/sources.yaml for anything that cannot be confirmed.\n`,
    );
  }

  // Deliberately does NOT set a non-zero exit code. A source that could not be
  // reached is information for an operator, never a reason to fail a deploy.
  db.close();
}

function sourcesReport(path: string, days: number): void {
  const db = openDatabase(path);
  db.migrate();
  const stats = createStatsCollector({ db });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  process.stdout.write(formatSourceReport(stats.sourceReport(since)) + '\n');
  db.close();
}

function pipelineReport(path: string, days: number): void {
  const db = openDatabase(path);
  db.migrate();
  const stats = createStatsCollector({ db });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  process.stdout.write(formatPipelineReport(stats.pipelineReport(since)) + '\n');
  db.close();
}

async function discordSetup(): Promise<void> {
  const cfg = env();
  if (!cfg.discord.token || !cfg.discord.guildId) {
    process.stdout.write('DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are required.\n');
    process.exitCode = 1;
    return;
  }
  const discord = createDiscordClient({
    token: cfg.discord.token,
    guildId: cfg.discord.guildId,
    channels: cfg.discord.channels,
    dryRun: false,
    logger: log.child('discord'),
  });
  await discord.start();
  const map = await discord.ensureChannels();
  process.stdout.write('\nPaste these into .env:\n\n');
  for (const [key, id] of Object.entries(map)) {
    const envVar = CHANNEL_ENV_VARS[key as keyof typeof CHANNEL_ENV_VARS];
    if (!envVar) continue;
    process.stdout.write(`${envVar}=${id}\n`);
  }
  process.stdout.write(
    '\nThe three primary channels are NEWS, TRADING_FLOOR and SPX. The rest are the\n' +
      'optional per-category fan-out — set CATEGORY_CHANNELS_ENABLED=true to use them.\n',
  );
  await discord.stop();
}

async function ingestUrl(url: string): Promise<void> {
  const parsed = parseXPostUrl(url);
  if (!parsed) {
    process.stdout.write(`not a recognisable X post URL: ${url}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `parsed handle=${parsed.handle} postId=${parsed.postId}\n` +
      `Fetching a single post requires X_BEARER_TOKEN; without it, use:\n` +
      `  npm run scout classify "<the post text>"\n`,
  );
}

/**
 * Re-runs stored raw posts through the current classifier. This is how a filter
 * change gets evaluated against real traffic before it ships (§28).
 */
async function replay(limit: number): Promise<void> {
  const cfg = env();
  const db = openDatabase(cfg.databasePath);
  db.migrate();

  const pipeline = createPipeline({
    db,
    taxonomy: loadTaxonomy(),
    securities: loadSecurityMaster(),
    config: cfg.pipeline,
    logger: log.child('replay'),
  });

  const posts = db.rawPosts.recent(limit);
  let accepted = 0;
  const reasons = new Map<string, number>();

  for (const raw of posts) {
    const outcome = await pipeline.process(raw);
    if (outcome.accepted) {
      accepted++;
      process.stdout.write(
        `\n--- ${outcome.newsEvent.category} ${Math.round(outcome.newsEvent.importance)} ---\n` +
          (outcome.alert ? renderAlert(outcome.alert) : '') +
          '\n',
      );
    } else if (outcome.rejection) {
      reasons.set(outcome.rejection, (reasons.get(outcome.rejection) ?? 0) + 1);
    }
  }

  process.stdout.write(
    `\nreplayed ${posts.length} posts → ${accepted} alerts (${((accepted / Math.max(posts.length, 1)) * 100).toFixed(1)}%)\n`,
  );
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${String(count).padStart(5)}  ${reason}\n`);
  }
  db.close();
}

/** Dry-run one literal string through the whole pipeline. */
async function classifyText(text: string): Promise<void> {
  if (!text.trim()) {
    process.stdout.write('usage: npm run scout classify "SOME HEADLINE TEXT"\n');
    process.exitCode = 1;
    return;
  }
  const cfg = env();
  const db = openDatabase(cfg.databasePath);
  db.migrate();

  const now = isoNow();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, now)));
  db.securities.upsertMany(loadSecurityMaster());

  // Attribute the test post to the highest-quality enabled source so the score
  // reflects a realistic wire rather than an unknown account.
  const source =
    db.sources.enabled().sort((a, b) => b.qualityScore - a.qualityScore)[0] ?? db.sources.all()[0];
  if (!source) {
    process.stdout.write('no sources configured — run `npm run sources:sync` first\n');
    return;
  }

  const raw: RawPost = {
    sourceId: source.id,
    sourcePostId: `cli-${deterministicId(text).slice(0, 12)}`,
    originalUrl: null,
    author: null,
    text,
    eventTime: now,
    ingestionTime: now,
    meta: {},
  };

  const pipeline = createPipeline({
    db,
    taxonomy: loadTaxonomy(),
    securities: loadSecurityMaster(),
    config: cfg.pipeline,
    logger: log.child('classify'),
  });

  const outcome = await pipeline.process(raw);

  process.stdout.write(
    `\nsource        ${source.id} (q${source.qualityScore}, ${source.filterProfile})\n` +
      `decision      ${outcome.accepted ? 'ACCEPTED' : `REJECTED — ${outcome.rejection}`}\n` +
      `category      ${outcome.newsEvent.category ?? '—'} / ${outcome.newsEvent.subcategory ?? '—'}\n` +
      `tickers       ${outcome.newsEvent.entities.tickers.map((t) => `${t.ticker}(${t.evidence})`).join(', ') || '—'}\n` +
      `countries     ${outcome.newsEvent.countries.join(', ') || '—'}\n` +
      `score         ${outcome.newsEvent.score ? `${Math.round(outcome.newsEvent.score.total)} ${outcome.newsEvent.score.band}` : '—'}\n` +
      `channels      ${outcome.route?.channels.join(', ') ?? '—'}\n`,
  );

  if (outcome.newsEvent.score) {
    const s = outcome.newsEvent.score;
    process.stdout.write(
      `\ncomponents    quality ${Math.round(s.sourceQuality)}  relevance ${Math.round(s.marketRelevance)}  ` +
        `novelty ${Math.round(s.novelty)}  magnitude ${Math.round(s.magnitude)}  ` +
        `exposure ${Math.round(s.assetExposure)}  credibility ${Math.round(s.credibility)}\n`,
    );
  }

  if (outcome.alert) {
    process.stdout.write('\n─── as rendered ───\n\n' + renderAlert(outcome.alert) + '\n');
  }
  db.close();
}

/**
 * Re-drives failed Sprout deliveries. Touches Sprout and the delivery log only
 * — it never loads the publisher, so it cannot emit a second Discord alert.
 */
async function deliveriesReplay(args: string[]): Promise<void> {
  const cfg = env();
  const options: ReplayOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      // npm consumes the first `--` in `npm run x -- --flag`, but a direct
      // invocation passes it through. Ignoring it makes both forms work.
      case '--':
        break;
      case '--failed':
        options.status = 'FAILED';
        break;
      case '--skipped':
        options.status = 'SKIPPED';
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--since': {
        if (!next) return usage('--since needs a value, e.g. --since 30m');
        const since = parseSince(next);
        if (!since) return usage(`could not parse --since "${next}"`);
        options.sinceIso = since;
        i++;
        break;
      }
      case '--id':
        if (!next) return usage('--id needs a value, e.g. --id x:123456');
        options.id = next;
        i++;
        break;
      case '--limit':
        if (!next || !/^\d+$/.test(next)) return usage('--limit needs a number');
        options.limit = Number(next);
        i++;
        break;
      default:
        if (arg?.startsWith('--')) return usage(`unknown option ${arg}`);
    }
  }

  if (!cfg.sprout.url && !options.dryRun) {
    process.stdout.write(
      'SPROUT_URL is not configured, so there is nothing to replay to.\n' +
        'Use --dry-run to see which deliveries would be re-driven.\n',
    );
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(cfg.databasePath);
  db.migrate();

  try {
    const report = await replayFailedDeliveries(
      {
        db,
        sprout: createSproutClient({
          url: cfg.sprout.url,
          token: cfg.sprout.token,
          timeoutMs: cfg.sprout.timeoutMs,
          logger: log.child('sprout'),
        }),
        taxonomy: loadTaxonomy(),
        securities: loadSecurityMaster(),
        maxAgeMinutes: cfg.sprout.maxAgeMinutes,
        logger: log.child('replay'),
      },
      options,
    );

    process.stdout.write(formatReplayReport(report) + '\n');
    // A delivery that is still failing is worth a non-zero exit so a cron or
    // CI step notices; a skip is a correct outcome, not an error.
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function usage(message: string): void {
  process.stdout.write(`${message}\n${COMMANDS}`);
  process.exitCode = 1;
}

run().catch((err) => {
  log.error('cli failure', { err: err as Error });
  process.exit(1);
});
