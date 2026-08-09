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
  PORT: numeric(10000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  RAW_CHANNEL_ENABLED: bool(true),
  DRY_RUN: bool(false),
});

let cached: ScoutEnv | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ScoutEnv {
  const parsed = schema.parse(source);
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
    sprout: {
      maxAgeMinutes: parsed.SPROUT_MAX_AGE_MINUTES,
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
