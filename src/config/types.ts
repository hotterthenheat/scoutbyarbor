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
  sourceType: 'x' | 'rss' | 'edgar' | 'manual' | 'finnhub' | 'truthsocial';
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
  /** Shared by every feed of one organisation, so corroboration is honest. */
  org?: string | null;
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
    /** Channels Scout's own bot reads in full. Added to discord-sources.yaml. */
    intakeChannelIds: string[];
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
  /**
   * Finnhub market news. A POLLED aggregator: Scout asks for the news on a
   * timer rather than waiting to be pushed, which is what makes it automatic.
   * Empty apiKey leaves the adapter unregistered entirely, exactly as an absent
   * X token does — no failing polls, no health noise.
   */
  finnhub: {
    apiKey: string;
    pollIntervalMs: number;
  };
  /**
   * Truth Social's public Mastodon-compatible API. No credential of any kind —
   * the account and status endpoints answer anonymous reads.
   */
  truthSocial: {
    pollIntervalMs: number;
    /** Scrape Creators. Empty = read the public endpoints directly. */
    vendorApiKey: string;
    vendorBaseUrl: string;
    /** Credits permitted per UTC day. The vendor bills per post returned. */
    vendorDailyBudget: number;
    /** Posts fetched per poll — the price of a poll, in credits. */
    vendorPageLimit: number;
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
  webhook: {
    /** Empty leaves POST /webhook/news disabled. Never logged. */
    token: string;
    /** Secret for POST /admin/replay. No fallback; unset disables it. */
    adminToken: string;
    /**
     * Secret for POST /webhook/discord. Its own credential: the X token goes to
     * the X relay operator and this one to whoever runs the Discord bridge, so
     * neither party can push into the other's source. Unset disables it.
     */
    discordIntelToken: string;
  };
  /** Automatic recovery of failed Sprout deliveries. */
  replay: {
    enabled: boolean;
    intervalMinutes: number;
    windowMinutes: number;
    limit: number;
  };
  sprout: {
    /** A post older than this is archived, never sent as a fresh trading event. */
    maxAgeMinutes: number;
    /** Empty disables the hand-off entirely, which is the normal MVP state. */
    url: string;
    token: string;
    timeoutMs: number;
  };
  /** HTTP port for /health, /ready and /metrics. */
  port: number;
  databasePath: string;
  pipeline: {
    /**
     * How old a story may be and still reach Discord, in minutes. 0 disables
     * the gate. The freshness rule used to apply only to the Sprout hand-off,
     * so a headline published twenty minutes earlier still arrived as an alert
     * — and an alert whose own timestamp is twenty minutes old reads as a bot
     * that is behind rather than a wire that is fast.
     */
    /**
     * Signed at the bottom of every alert, after the outlet that reported it.
     * Empty prints the outlet alone. Never replaces the outlet — who reported a
     * story is information; whose wire carried it is branding, and the branding
     * does not get to stand where the attribution goes.
     */
    brandFooter: string;
    maxPublishAgeMinutes: number;
    minPublishScore: number;
    minBreakingScore: number;
    dedupeWindowMinutes: number;
    clusterWindowMinutes: number;
    dedupeSimilarity: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  dryRun: boolean;
}
