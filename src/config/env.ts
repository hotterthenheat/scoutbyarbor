import 'dotenv/config';
import { z } from 'zod';
import type { ScoutEnv } from './types.js';

/**
 * Environment parsing. Discord/X credentials are optional at parse time so the
 * CLI (migrations, source verification, replay) runs without them; the runtime
 * checks for what it actually needs when it starts a given subsystem.
 */

const numeric = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      return /^(1|true|yes|on)$/i.test(v.trim());
    });

/** Comma/whitespace separated list → trimmed non-empty entries. */
const list = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    );

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().default(''),
  DISCORD_GUILD_ID: z.string().default(''),
  DISCORD_CHANNEL_NEWS: z.string().default(''),
  DISCORD_CHANNEL_TRADING_FLOOR: z.string().default(''),
  DISCORD_CHANNEL_SPX: z.string().default(''),
  DISCORD_CHANNEL_BREAKING: z.string().default(''),
  DISCORD_CHANNEL_MACRO: z.string().default(''),
  DISCORD_CHANNEL_FED: z.string().default(''),
  DISCORD_CHANNEL_GEOPOLITICS: z.string().default(''),
  DISCORD_CHANNEL_MARKETS: z.string().default(''),
  DISCORD_CHANNEL_EQUITIES: z.string().default(''),
  DISCORD_CHANNEL_EARNINGS: z.string().default(''),
  DISCORD_CHANNEL_COMMODITIES: z.string().default(''),
  DISCORD_CHANNEL_OPTIONS: z.string().default(''),
  DISCORD_CHANNEL_CRYPTO: z.string().default(''),
  DISCORD_CHANNEL_RAW: z.string().default(''),
  DISCORD_CHANNEL_SYSTEM: z.string().default(''),

  CATEGORY_CHANNELS_ENABLED: bool(false),
  // Channels Scout's own bot READS in full — a forwarding bot's destination,
  // typically a private channel in your own server. Added to whatever
  // discord-sources.yaml declares; config wins for an id described in both.
  DISCORD_INTAKE_CHANNEL_IDS: list(),
  NEWS_SOURCE_CHANNEL_IDS: list(),
  TRUTH_SOCIAL_CHANNEL_IDS: list(),
  ADMIN_INPUT_CHANNEL_IDS: list(),

  X_BEARER_TOKEN: z.string().default(''),
  FINNHUB_API_KEY: z.string().default(''),
  // Poll cadence is spent directly out of MAX_PUBLISH_AGE_MINUTES: an item is
  // already up to one interval old by the time Scout first sees it. With a two
  // minute budget, a 60s poll gives an upstream feed only 60s of slack, so the
  // sources that carry breaking statements are polled at 30s.
  //
  // X stays slower because its cadence is governed by a request budget rather
  // than by freshness, and polling it harder just exhausts the window earlier.
  // Scrape Creators. Set the key and every Truth Social source reads through
  // the vendor instead of the public endpoints, which is the only route that
  // works from a datacenter IP. Unset = the free direct transport.
  //
  // METERED, so the budget is a required part of the configuration rather than
  // a tuning knob: three accounts polled every 30s is 8,640 requests a day.
  SCRAPECREATORS_API_KEY: z.string().default(''),
  SCRAPECREATORS_BASE_URL: z.string().default('https://api.scrapecreators.com'),
  // Counted in CREDITS, which the vendor bills per post returned — not per
  // request. A page of 3 costs 3 credits every poll, seen posts included.
  SCRAPECREATORS_DAILY_BUDGET: z.coerce.number().int().positive().default(90),
  SCRAPECREATORS_PAGE_LIMIT: z.coerce.number().int().positive().default(3),

  TRUTH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  FINNHUB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  X_POLL_INTERVAL_MS: numeric(90_000),
  X_REQUEST_BUDGET_PER_WINDOW: numeric(180),

  SEC_USER_AGENT: z.string().default('ArborCapital Scout (ops@example.com)'),
  SEC_POLL_INTERVAL_MS: numeric(30_000),

  RSS_POLL_INTERVAL_MS: numeric(30_000),

  DATABASE_PATH: z.string().default('./data/scout.db'),

  SCOUT_BRAND_FOOTER: z
    .string()
    .default('Scout by Arbor Capital · signal, not noise'),
  /**
   * How stale a story may be, measured from ITS OWN publication time, and still
   * go out as an alert.
   *
   * TWO MINUTES, down from twenty. A Trump post relayed twenty minutes late is
   * not a newswire, it is a history feed — the move has already happened and
   * the alert is worse than silence, because it looks actionable.
   *
   * This is a hard budget, and Scout's own detection latency is spent from it:
   * a source polled every 30s can burn a quarter of the window before the item
   * is even seen. That is why the fast sources below poll at 30s.
   *
   * The trade is deliberate and it is not free. Aggregators that habitually
   * publish to RSS several minutes after the underlying story — Yahoo Finance
   * is the clearest case — will now rarely clear the gate, and will drift into
   * the "quiet" list on the dashboard. Losing them is the point: a wire that is
   * quiet is more useful than one that is behind.
   */
  MAX_PUBLISH_AGE_MINUTES: z.coerce.number().int().nonnegative().default(2),
  MIN_PUBLISH_SCORE: numeric(60),
  MIN_BREAKING_SCORE: numeric(90),
  DEDUPE_WINDOW_MINUTES: numeric(90),
  CLUSTER_WINDOW_MINUTES: numeric(240),
  DEDUPE_SIMILARITY: numeric(0.82),

  RESOLVE_TIMEOUT_SECONDS: numeric(10),
  RESOLVE_MAX_ATTEMPTS: numeric(4),
  INGEST_CONCURRENCY: numeric(4),
  ALLOWED_X_ACCOUNTS: list(),
  SPROUT_MAX_AGE_MINUTES: numeric(30),
  SCOUT_WEBHOOK_TOKEN: z.string().default(''),
  SPROUT_URL: z.string().default(''),
  SPROUT_TOKEN: z.string().default(''),
  SPROUT_TIMEOUT_MS: numeric(10_000),
  REPLAY_ENABLED: bool(true),
  REPLAY_INTERVAL_MINUTES: numeric(5),
  REPLAY_WINDOW_MINUTES: numeric(60),
  REPLAY_LIMIT: numeric(100),
  SCOUT_ADMIN_TOKEN: z.string().default(''),
  DISCORD_INTEL_TOKEN: z.string().default(''),
  PORT: numeric(10000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  RAW_CHANNEL_ENABLED: bool(true),
  DRY_RUN: bool(false),
});

let cached: ScoutEnv | null = null;

/**
 * Deployment-friendly aliases. The canonical names are on the left; the ones on
 * the right are what a Render blueprint or a colleague's notes are likely to
 * use. First non-empty value wins, so either spelling works and neither
 * silently overrides a value that is already set.
 */
const ALIASES: Record<string, string[]> = {
  DISCORD_BOT_TOKEN: ['DISCORD_TOKEN'],
  NEWS_SOURCE_CHANNEL_IDS: ['DISCORD_SOURCE_CHANNEL_IDS'],
  DISCORD_CHANNEL_NEWS: ['SCOUT_NEWS_CHANNEL_ID'],
  DISCORD_CHANNEL_TRADING_FLOOR: ['TRADING_FLOOR_CHANNEL_ID'],
  DISCORD_CHANNEL_SPX: ['SPX_TRADING_CHANNEL_ID'],
  DISCORD_CHANNEL_RAW: ['SCOUT_RAW_CHANNEL_ID'],
  DISCORD_CHANNEL_SYSTEM: ['SCOUT_SYSTEM_CHANNEL_ID'],
};

function applyAliases(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...source };
  for (const [canonical, alternatives] of Object.entries(ALIASES)) {
    if (merged[canonical]?.trim()) continue;
    for (const alt of alternatives) {
      if (source[alt]?.trim()) {
        merged[canonical] = source[alt];
        break;
      }
    }
  }
  return merged;
}

/**
 * DATABASE_URL is accepted for the same reason, but only when it points at a
 * SQLite file. Storage is SQLite on a persistent disk; a postgres:// URL would
 * need a different storage layer, and failing loudly here beats connecting to
 * nothing and looking healthy.
 */
export function databasePathFrom(source: NodeJS.ProcessEnv): string | null {
  const url = source.DATABASE_URL?.trim();
  if (!url) return null;

  if (/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error(
      'DATABASE_URL points at Postgres, which this build does not support. Scout stores ' +
        'state in SQLite on a persistent disk — set DATABASE_PATH (e.g. /var/data/scout.db) instead.',
    );
  }
  const withoutScheme = url.replace(/^(?:sqlite|file):\/\/?/i, '');
  return withoutScheme || null;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ScoutEnv {
  const withAliases = applyAliases(source);
  const aliasedDbPath = databasePathFrom(withAliases);
  if (aliasedDbPath && !withAliases.DATABASE_PATH?.trim()) {
    withAliases.DATABASE_PATH = aliasedDbPath;
  }
  const parsed = schema.parse(withAliases);
  return {
    discord: {
      token: parsed.DISCORD_BOT_TOKEN,
      guildId: parsed.DISCORD_GUILD_ID,
      channels: {
        news: parsed.DISCORD_CHANNEL_NEWS,
        tradingFloor: parsed.DISCORD_CHANNEL_TRADING_FLOOR,
        spx: parsed.DISCORD_CHANNEL_SPX,
        breaking: parsed.DISCORD_CHANNEL_BREAKING,
        macro: parsed.DISCORD_CHANNEL_MACRO,
        fed: parsed.DISCORD_CHANNEL_FED,
        geopolitics: parsed.DISCORD_CHANNEL_GEOPOLITICS,
        markets: parsed.DISCORD_CHANNEL_MARKETS,
        equities: parsed.DISCORD_CHANNEL_EQUITIES,
        earnings: parsed.DISCORD_CHANNEL_EARNINGS,
        commodities: parsed.DISCORD_CHANNEL_COMMODITIES,
        options: parsed.DISCORD_CHANNEL_OPTIONS,
        crypto: parsed.DISCORD_CHANNEL_CRYPTO,
        raw: parsed.DISCORD_CHANNEL_RAW,
        system: parsed.DISCORD_CHANNEL_SYSTEM,
      },
      rawChannelEnabled: parsed.RAW_CHANNEL_ENABLED,
      categoryChannelsEnabled: parsed.CATEGORY_CHANNELS_ENABLED,
      intakeChannelIds: parsed.DISCORD_INTAKE_CHANNEL_IDS,
      newsSourceChannelIds: parsed.NEWS_SOURCE_CHANNEL_IDS,
      truthSocialChannelIds: parsed.TRUTH_SOCIAL_CHANNEL_IDS,
      adminInputChannelIds: parsed.ADMIN_INPUT_CHANNEL_IDS,
    },
    ingestion: {
      resolveTimeoutMs: parsed.RESOLVE_TIMEOUT_SECONDS * 1000,
      maxAttempts: parsed.RESOLVE_MAX_ATTEMPTS,
      concurrency: parsed.INGEST_CONCURRENCY,
      allowedXAccounts: parsed.ALLOWED_X_ACCOUNTS.map((a) => a.replace(/^@/, '').toLowerCase()),
    },
    webhook: {
      token: parsed.SCOUT_WEBHOOK_TOKEN,
      // Deliberately NOT falling back to SCOUT_WEBHOOK_TOKEN. That token is
      // handed to a third-party upstream relay so it can push news in; it must
      // not also authorize an operational endpoint. Unset means POST
      // /admin/replay is disabled, which is the right default now that the
      // replay runs in-process and nothing external needs to trigger it.
      adminToken: parsed.SCOUT_ADMIN_TOKEN,
      // Its own credential. The X webhook token goes to the X relay operator
      // and the Discord token to whoever runs the Discord bridge; one secret
      // for both would mean either party could push into the other's source.
      discordIntelToken: parsed.DISCORD_INTEL_TOKEN,
    },
    replay: {
      enabled: parsed.REPLAY_ENABLED,
      intervalMinutes: parsed.REPLAY_INTERVAL_MINUTES,
      windowMinutes: parsed.REPLAY_WINDOW_MINUTES,
      limit: parsed.REPLAY_LIMIT,
    },
    sprout: {
      maxAgeMinutes: parsed.SPROUT_MAX_AGE_MINUTES,
      url: parsed.SPROUT_URL,
      token: parsed.SPROUT_TOKEN,
      timeoutMs: parsed.SPROUT_TIMEOUT_MS,
    },
    port: parsed.PORT,
    x: {
      bearerToken: parsed.X_BEARER_TOKEN,
      pollIntervalMs: parsed.X_POLL_INTERVAL_MS,
      requestBudgetPerWindow: parsed.X_REQUEST_BUDGET_PER_WINDOW,
    },
    finnhub: {
      apiKey: parsed.FINNHUB_API_KEY,
      pollIntervalMs: parsed.FINNHUB_POLL_INTERVAL_MS,
    },
    truthSocial: {
      pollIntervalMs: parsed.TRUTH_POLL_INTERVAL_MS,
      vendorApiKey: parsed.SCRAPECREATORS_API_KEY,
      vendorBaseUrl: parsed.SCRAPECREATORS_BASE_URL,
      vendorDailyBudget: parsed.SCRAPECREATORS_DAILY_BUDGET,
      vendorPageLimit: parsed.SCRAPECREATORS_PAGE_LIMIT,
    },
    sec: {
      userAgent: parsed.SEC_USER_AGENT,
      pollIntervalMs: parsed.SEC_POLL_INTERVAL_MS,
    },
    rss: { pollIntervalMs: parsed.RSS_POLL_INTERVAL_MS },
    databasePath: parsed.DATABASE_PATH,
    pipeline: {
      brandFooter: parsed.SCOUT_BRAND_FOOTER,
      maxPublishAgeMinutes: parsed.MAX_PUBLISH_AGE_MINUTES,
      minPublishScore: parsed.MIN_PUBLISH_SCORE,
      minBreakingScore: parsed.MIN_BREAKING_SCORE,
      dedupeWindowMinutes: parsed.DEDUPE_WINDOW_MINUTES,
      clusterWindowMinutes: parsed.CLUSTER_WINDOW_MINUTES,
      dedupeSimilarity: parsed.DEDUPE_SIMILARITY,
    },
    logLevel: parsed.LOG_LEVEL,
    dryRun: parsed.DRY_RUN,
  };
}

export function env(): ScoutEnv {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test seam. */
export function resetEnvCache(): void {
  cached = null;
}
