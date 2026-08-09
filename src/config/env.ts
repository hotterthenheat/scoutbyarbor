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
  NEWS_SOURCE_CHANNEL_IDS: list(),
  TRUTH_SOCIAL_CHANNEL_IDS: list(),
  ADMIN_INPUT_CHANNEL_IDS: list(),

  X_BEARER_TOKEN: z.string().default(''),
  X_POLL_INTERVAL_MS: numeric(90_000),
  X_REQUEST_BUDGET_PER_WINDOW: numeric(180),

  SEC_USER_AGENT: z.string().default('ArborCapital Scout (ops@example.com)'),
  SEC_POLL_INTERVAL_MS: numeric(60_000),

  RSS_POLL_INTERVAL_MS: numeric(45_000),

  DATABASE_PATH: z.string().default('./data/scout.db'),

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
      // Falls back to the webhook secret so a deployment needs only one token.
      adminToken: parsed.SCOUT_ADMIN_TOKEN || parsed.SCOUT_WEBHOOK_TOKEN,
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
    sec: {
      userAgent: parsed.SEC_USER_AGENT,
      pollIntervalMs: parsed.SEC_POLL_INTERVAL_MS,
    },
    rss: { pollIntervalMs: parsed.RSS_POLL_INTERVAL_MS },
    databasePath: parsed.DATABASE_PATH,
    pipeline: {
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
