import type { Category } from '../core/types.js';

/**
 * Shapes of the on-disk configuration files. Keeping the source list, keyword
 * taxonomy and security master in config (not code) is what lets an account or
 * keyword be added without a deploy (§36).
 */

// ── config/sources.yaml ──────────────────────────────────────────────────────

export interface SourceConfigEntry {
  id: string;
  name: string;
  handle?: string | null;
  url?: string | null;
  sourceType: 'x' | 'rss' | 'edgar' | 'manual';
  category: Category | 'MIXED';
  priority: number;
  enabled: boolean;
  qualityScore: number;
  noiseScore: number;
  macroScore?: number;
  microScore?: number;
  geopoliticalScore?: number;
  filterProfile?: 'standard' | 'strict';
  official?: boolean;
  /** Poll interval override in ms; falls back to the adapter default. */
  pollIntervalMs?: number;
  /** How long a silence is normal for this feed before health flags it (§23). */
  expectedIntervalMs?: number;
  notes?: string | null;
}

export interface SourcesFile {
  version: number;
  sources: SourceConfigEntry[];
}

// ── config/taxonomy.yaml ─────────────────────────────────────────────────────

export interface TaxonomyCategory {
  /** Single tokens or multiword phrases. Matched case-insensitively on word
   *  boundaries; multiword entries match as contiguous phrases. */
  keywords: string[];
  /** Higher-weight multiword phrases — a hit here is strong evidence. */
  phrases: string[];
  /** Named subcategories → their trigger terms. First match wins. */
  subcategories: Record<string, string[]>;
  /** Tie-break multiplier when two categories score equally. */
  weight: number;
  /**
   * When present, the category only fires if at least one of these also
   * matches. Used to stop e.g. EQUITY firing on any capitalised company name
   * without a corporate-action verb.
   */
  requires?: string[];
}

export interface NoiseTaxonomy {
  opinion: string[];
  prediction: string[];
  engagementBait: string[];
  meme: string[];
  promotional: string[];
  personal: string[];
  politicalCommentary: string[];
  marketChatter: string[];
  oldNews: string[];
}

export interface FactualityTaxonomy {
  /** Markers of reporting: "said", "announced", "reported", "according to". */
  factualMarkers: string[];
  /** Markers of opinion: "I think", "in my view", "should", "deserves". */
  commentaryMarkers: string[];
  /** Attribution verbs that upgrade a sentence to reported fact. */
  attributionVerbs: string[];
}

export interface MagnitudeTaxonomy {
  /** Terms implying a large move/consequence: "emergency", "halts", "invades". */
  high: string[];
  medium: string[];
}

export interface TaxonomyFile {
  version: number;
  categories: Record<Category, TaxonomyCategory>;
  noise: NoiseTaxonomy;
  factuality: FactualityTaxonomy;
  magnitude: MagnitudeTaxonomy;
  /** Tokens that must never be treated as tickers (§25). */
  tickerStopwords: string[];
  /** Commodity surface forms → canonical name. */
  commodities: Record<string, string[]>;
  /** Country surface forms → ISO alpha-2. */
  countries: Record<string, string[]>;
  /** Organisation surface forms → canonical acronym. */
  organizations: Record<string, string[]>;
  /** Person surface forms → canonical name. */
  people: Record<string, string[]>;
}

// ── Runtime settings from env ────────────────────────────────────────────────

export interface DiscordChannelConfig {
  news: string;
  tradingFloor: string;
  spx: string;
  breaking: string;
  macro: string;
  fed: string;
  geopolitics: string;
  markets: string;
  equities: string;
  earnings: string;
  commodities: string;
  options: string;
  crypto: string;
  raw: string;
  system: string;
}

export interface ScoutEnv {
  discord: {
    token: string;
    guildId: string;
    channels: DiscordChannelConfig;
    rawChannelEnabled: boolean;
    /** Emit the per-category channels alongside the three primary ones. */
    categoryChannelsEnabled: boolean;
    /** Discord channels Scout watches for X post URLs. */
    newsSourceChannelIds: string[];
    truthSocialChannelIds: string[];
    adminInputChannelIds: string[];
  };
  x: {
    bearerToken: string;
    pollIntervalMs: number;
    requestBudgetPerWindow: number;
  };
  sec: {
    userAgent: string;
    pollIntervalMs: number;
  };
  rss: {
    pollIntervalMs: number;
  };
  /** 24/7 URL-ingestion worker settings. */
  ingestion: {
    resolveTimeoutMs: number;
    maxAttempts: number;
    concurrency: number;
    /** Only these X accounts enter the production pipeline. Empty = allow all. */
    allowedXAccounts: string[];
  };
  sprout: {
    /** A post older than this is archived, never sent as a fresh trading event. */
    maxAgeMinutes: number;
  };
  /** HTTP port for /health, /ready and /metrics. */
  port: number;
  databasePath: string;
  pipeline: {
    minPublishScore: number;
    minBreakingScore: number;
    dedupeWindowMinutes: number;
    clusterWindowMinutes: number;
    dedupeSimilarity: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  dryRun: boolean;
}
