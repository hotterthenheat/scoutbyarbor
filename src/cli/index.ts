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
  const skipped: string[] = [];
  for (const source of db.sources.all()) {
    if (source.sourceType === 'manual') {
      // Nothing remote to check: a relay source is fed by Discord, not polled.
      skipped.push(source.id);
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
  process.stdout.write(`\nVERIFIED  ${ok.length}\n`);
  for (const r of ok) process.stdout.write(`  ok    ${r.sourceId}  ${r.resolvedName ?? ''}\n`);
  process.stdout.write(`\nUNVERIFIED  ${bad.length}\n`);
  for (const r of bad) process.stdout.write(`  FAIL  ${r.sourceId}  ${r.detail}\n`);
  if (skipped.length) {
    process.stdout.write(`\nSKIPPED  ${skipped.length} (nothing remote to verify)\n`);
    for (const id of skipped) process.stdout.write(`  --    ${id}\n`);
  }
  if (bad.length) {
    process.stdout.write(
      `\nUnverified sources stay in the config but should not be trusted until they resolve.\n` +
        `Set enabled: false in config/sources.yaml for anything that cannot be confirmed.\n`,
    );
  }
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

run().catch((err) => {
  log.error('cli failure', { err: err as Error });
  process.exit(1);
});
