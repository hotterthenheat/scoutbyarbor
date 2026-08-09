/**
 * Scout core contracts.
 *
 * Every stage of the pipeline consumes and produces the shapes in this file.
 * The pipeline is a straight line (§2):
 *
 *   INGEST → NORMALIZE → DEDUPE → CLASSIFY → FILTER → CLUSTER → RANK → FORMAT → DISCORD
 *
 * Nothing downstream of FORMAT may see author/handle/URL/engagement — those are
 * backend-only fields (§3, §33). The renderer takes a `RenderableAlert`, which
 * structurally cannot carry them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Categories & enums
// ─────────────────────────────────────────────────────────────────────────────

/** Alert categories (§4). Rendered verbatim as `<CATEGORY> ALERT`. */
export const CATEGORIES = [
  'MACRO',
  'FED',
  'ECONOMIC',
  'GEOPOLITICAL',
  'MARKET',
  'EQUITY',
  'EARNINGS',
  'OPTIONS',
  'COMMODITY',
  'CRYPTO',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Human-facing alert banner text, e.g. `OPTIONS` → `OPTIONS / FLOW ALERT`. */
export const CATEGORY_BANNER: Record<Category, string> = {
  MACRO: 'MACRO ALERT',
  FED: 'FED ALERT',
  ECONOMIC: 'ECONOMIC ALERT',
  GEOPOLITICAL: 'GEOPOLITICAL ALERT',
  MARKET: 'MARKET ALERT',
  EQUITY: 'EQUITY ALERT',
  EARNINGS: 'EARNINGS ALERT',
  OPTIONS: 'OPTIONS / FLOW ALERT',
  COMMODITY: 'COMMODITY ALERT',
  CRYPTO: 'CRYPTO ALERT',
};

/**
 * Finer-grained tag used for routing and analytics, never rendered.
 * e.g. `FOMC_DECISION`, `CPI_RELEASE`, `MNA`, `FILING_8K`.
 */
export type Subcategory = string;

/** Importance bands (§19). */
export const IMPORTANCE_BANDS = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'IGNORE'] as const;
export type ImportanceBand = (typeof IMPORTANCE_BANDS)[number];

/** SEC filing materiality (§16). */
export const MATERIALITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'IGNORE'] as const;
export type Materiality = (typeof MATERIALITY_LEVELS)[number];

/** Source liveness (§23). A stale feed must never read as "no news". */
export const SOURCE_HEALTH_STATES = [
  'ACTIVE',
  'DELAYED',
  'STALE',
  'DISCONNECTED',
  'ERROR',
] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

/** Where a source's content comes from. Drives which adapter polls it. */
export const SOURCE_TYPES = ['x', 'rss', 'edgar', 'manual'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Source tiers (§5). Derived from quality_score, stored for reporting. */
export type SourceTier = 'TIER_1' | 'TIER_2' | 'TIER_3' | 'REMOVE';

/** Lifecycle of a processed post (`news_events.status`). */
export const EVENT_STATUSES = [
  'PENDING', // ingested, not yet processed
  'PUBLISHED', // rendered to at least one user-facing channel
  'SUPERSEDED', // a later development in the same cluster replaced it (§18)
  'DUPLICATE', // collapsed into an existing event (§17)
  'FILTERED', // rejected by the noise filter (§20)
  'BELOW_THRESHOLD', // scored, but under MIN_PUBLISH_SCORE (§19)
  'ERROR',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Why the pipeline dropped an item. Surfaced in #scout-raw only (§27). */
export type RejectionReason =
  | 'DUPLICATE_POST_ID'
  | 'DUPLICATE_URL'
  | 'DUPLICATE_TEXT'
  | 'DUPLICATE_EVENT'
  | 'NOISE_OPINION'
  | 'NOISE_PREDICTION'
  | 'NOISE_ENGAGEMENT_BAIT'
  | 'NOISE_MEME'
  | 'NOISE_PROMOTIONAL'
  | 'NOISE_PERSONAL'
  | 'NOISE_POLITICAL_COMMENTARY'
  | 'NOISE_COMMENTARY'
  | 'NOISE_RETWEET_NO_CONTENT'
  | 'NOISE_OLD_NEWS'
  | 'NOISE_MARKET_CHATTER'
  | 'NO_CATEGORY'
  | 'BELOW_THRESHOLD'
  | 'FILING_IMMATERIAL'
  | 'SOURCE_DISABLED'
  | 'EMPTY_TEXT';

// ─────────────────────────────────────────────────────────────────────────────
// Sources (§21, §36)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A configured source. Loaded from `config/sources.yaml` into the `sources`
 * table so accounts can be added/removed without touching application code
 * (§36). Scores are seeded from config and updated from observed behaviour.
 */
export interface Source {
  id: string; // stable slug, e.g. "x:deltaone"
  name: string; // "Walter Bloomberg"
  handle: string | null; // "@DeItaone" — X handle, or null for RSS/EDGAR
  url: string | null; // feed URL for rss/edgar adapters
  sourceType: SourceType;
  category: Category | 'MIXED'; // primary beat; the classifier still decides per-post
  priority: number; // 0-100, higher polls sooner and wins dedupe ties
  enabled: boolean;
  /** Handle/URL confirmed to resolve against the live provider (§29). */
  verified: boolean;
  qualityScore: number; // 0-100 (§5)
  noiseScore: number; // 0-100, inverse-ish of quality (§21)
  macroScore: number;
  microScore: number;
  geopoliticalScore: number;
  /**
   * Some sources (ZeroHedge, KobeissiLetter) mix reporting with commentary and
   * need the factuality gate applied hard (§8). `strict` runs every noise rule
   * and requires a factual-news verdict; `standard` is the default.
   */
  filterProfile: 'standard' | 'strict';
  /** Official government / central-bank / exchange feed — high credibility (§9). */
  official: boolean;
  /**
   * How long a silence is normal for this feed before health flags it (§23).
   * A quarterly filing feed and a breaking-news account have very different
   * idea of "quiet", so this is per source rather than per type.
   */
  expectedIntervalMs: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Rolling behavioural stats per source (§21, §28). */
export interface SourceStats {
  sourceId: string;
  postsReceived: number;
  postsAccepted: number;
  postsRejected: number;
  duplicates: number;
  falsePositives: number;
  latePosts: number;
  materialEvents: number;
  averageDailyPosts: number;
  usefulPostRatio: number; // accepted / received
  historicalAccuracy: number; // 0-1, manually adjusted from review
  avgSourceLatencyMs: number;
  windowStart: string;
  updatedAt: string;
}

/** Liveness record per source (§23). */
export interface SourceHealth {
  sourceId: string;
  state: SourceHealthState;
  lastSuccessAt: string | null;
  lastItemAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Expected quiet period before we call it DELAYED, then STALE. */
  expectedIntervalMs: number;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

/** Verbatim item from a provider, before any Scout processing. */
export interface RawPost {
  sourceId: string;
  sourcePostId: string; // provider-native id, unique within source
  originalUrl: string | null; // retained internally, never rendered (§3)
  author: string | null; // handle/byline, backend-only
  text: string;
  /** When the source published it. */
  eventTime: string; // ISO-8601
  /** When Scout received it. */
  ingestionTime: string; // ISO-8601
  /** Provider-specific extras: filing form type, tickers, retweet flags, etc. */
  meta: Record<string, unknown>;
}

/** An ingestion adapter polls one provider and yields RawPosts. */
export interface IngestAdapter {
  readonly type: SourceType;
  /** Adapters own their own pacing; the manager just calls this on a timer. */
  poll(sources: Source[]): Promise<IngestResult>;
  /** Optional one-shot fetch used by the `replay` CLI and URL ingestion. */
  fetchOne?(source: Source, id: string): Promise<RawPost | null>;
  /** Confirm handles/URLs resolve (§29). */
  verify?(source: Source): Promise<SourceVerification>;
}

export interface IngestResult {
  posts: RawPost[];
  /** Per-source outcome so the health monitor can distinguish quiet from broken. */
  outcomes: Array<{
    sourceId: string;
    ok: boolean;
    itemCount: number;
    error?: string;
    latencyMs: number;
  }>;
}

export interface SourceVerification {
  sourceId: string;
  ok: boolean;
  resolvedName?: string;
  resolvedId?: string;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizedPost extends RawPost {
  /** Cleaned body: URLs/handles/boilerplate stripped, entities preserved. */
  cleanText: string;
  /** Headline in Scout's wire style — uppercase, trailing punctuation removed. */
  headline: string;
  /** Remaining prose after the headline, used for the alert body. */
  body: string;
  /** Lowercased alnum tokens used by dedupe + classifiers. */
  tokens: string[];
  /** Order-insensitive hash of significant tokens, for near-duplicate lookup. */
  fingerprint: string;
  /** 64-bit simhash as hex, for Hamming-distance similarity. */
  simhash: string;
  /** True when the post is a bare retweet/quote with no added information. */
  isEcho: boolean;
  /** Language guess; non-English posts are held unless the source is official. */
  language: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction (§25)
// ─────────────────────────────────────────────────────────────────────────────

/** A security-master entry. The ticker dictionary is the anti-false-positive. */
export interface Security {
  ticker: string;
  name: string;
  /** Alternate names: "Nvidia Corp.", "NVIDIA Corporation", "Alphabet". */
  aliases: string[];
  exchange: string;
  /**
   * How dangerous a bare uppercase match is:
   *  - `safe`      NVDA/AAPL/AVGO — not a word, bare match allowed
   *  - `ambiguous` META/ALL/KEY/CAT — needs a cashtag or a name hit
   *  - `blocked`   F/T/X/GO/ON/IT — never bare-matches, cashtag or name only
   */
  ambiguity: 'safe' | 'ambiguous' | 'blocked';
  /** Index membership drives asset-exposure scoring (§19). */
  indices: string[];
  sector: string | null;
  priority: number; // 0-100, mirrors §12 "can materially move SPX/NDX"
}

/** How a ticker was found — kept for the raw channel's audit trail. */
export type TickerEvidence = 'CASHTAG' | 'NAME' | 'ALIAS' | 'BARE_SYMBOL' | 'PROVIDER_METADATA';

export interface TickerMatch {
  ticker: string;
  evidence: TickerEvidence;
  confidence: number; // 0-1
  /** Exact substring that produced the match, for debugging false positives. */
  matchedText: string;
}

export interface ExtractedEntities {
  tickers: TickerMatch[];
  /** ISO-3166 alpha-2 where resolvable, else the surface form. */
  countries: string[];
  /** Institutions: FED, ECB, OPEC, NATO, BLS, SEC… */
  organizations: string[];
  /** Named people: POWELL, TRUMP, LAGARDE… */
  people: string[];
  /** Commodities: WTI, BRENT, GOLD, NATGAS… */
  commodities: string[];
  /** Numeric facts pulled out of the text: percentages, basis points, $ figures. */
  figures: ExtractedFigure[];
}

export interface ExtractedFigure {
  kind: 'PERCENT' | 'BPS' | 'CURRENCY' | 'COUNT' | 'MULTIPLE';
  raw: string;
  value: number;
  unit: string | null;
  /** Nearby label, e.g. "EPS", "revenue", "CPI". */
  label: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification (§4, §8, §20)
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryVerdict {
  category: Category;
  subcategory: Subcategory | null;
  confidence: number; // 0-1
  /** Keyword/rule ids that fired, for the raw channel. */
  signals: string[];
  /** Runner-up categories, used for multi-channel routing (§26). */
  secondary: Category[];
}

export interface NoiseVerdict {
  isNoise: boolean;
  reason: RejectionReason | null;
  confidence: number;
  signals: string[];
}

/** §8: factual news vs commentary/opinion. Only the former normally passes. */
export interface FactualityVerdict {
  verdict: 'FACTUAL_NEWS' | 'COMMENTARY';
  confidence: number;
  signals: string[];
}

/** §15 earnings extraction. */
export interface EarningsData {
  ticker: string | null;
  company: string | null;
  period: string | null; // "Q3 2026"
  eps: FinancialFigure | null;
  epsConsensus: FinancialFigure | null;
  revenue: FinancialFigure | null;
  revenueConsensus: FinancialFigure | null;
  guidance: string | null;
  grossMargin: FinancialFigure | null;
  operatingMargin: FinancialFigure | null;
  capex: FinancialFigure | null;
  buybacks: FinancialFigure | null;
  dividend: FinancialFigure | null;
  bookings: FinancialFigure | null;
  backlog: FinancialFigure | null;
  freeCashFlow: FinancialFigure | null;
  /** BEAT / MISS / INLINE against consensus where both sides are present. */
  epsSurprise: 'BEAT' | 'MISS' | 'INLINE' | null;
  revenueSurprise: 'BEAT' | 'MISS' | 'INLINE' | null;
}

export interface FinancialFigure {
  value: number;
  unit: 'USD' | 'PERCENT' | 'SHARES' | 'RATIO' | 'NONE';
  scale: 'UNIT' | 'THOUSAND' | 'MILLION' | 'BILLION';
  raw: string;
}

/** §16 filings. */
export interface FilingData {
  form: string; // "8-K", "13D", "S-1"
  cik: string;
  company: string;
  ticker: string | null;
  filedAt: string;
  /** 8-K item numbers, e.g. ["5.02", "2.02"]. */
  items: string[];
  materiality: Materiality;
  materialitySignals: string[];
  accessionNumber: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring (§19)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weights sum to 100 and mirror §19 exactly. Each component is scored 0-100 and
 * contributed at its weight.
 */
export const SCORE_WEIGHTS = {
  sourceQuality: 0.2,
  marketRelevance: 0.25,
  novelty: 0.15,
  magnitude: 0.2,
  assetExposure: 0.1,
  credibility: 0.1,
} as const;

export interface ScoreBreakdown {
  sourceQuality: number;
  marketRelevance: number;
  novelty: number;
  magnitude: number;
  assetExposure: number;
  credibility: number;
  /** Weighted total, 0-100. */
  total: number;
  band: ImportanceBand;
  /** Explanations per component, shown only in #scout-raw. */
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustering (§17, §18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A real-world event. Many posts from many sources collapse into one of these,
 * and Discord shows the cluster — not each post (§17).
 */
export interface EventCluster {
  id: string;
  /** Human-readable event key, e.g. `iran-us-deal-2026-05-28`. */
  slug: string;
  /** Current best headline; updated when a higher-scoring development lands. */
  headline: string;
  category: Category;
  subcategory: Subcategory | null;
  tickers: string[];
  countries: string[];
  entities: string[];
  /** Peak importance seen across the cluster. */
  importance: number;
  band: ImportanceBand;
  /** How many distinct sources reported it — drives corroboration (§19). */
  sourceCount: number;
  /** The source ids behind that count, so a repost cannot inflate it. */
  sourceIds: string[];
  postCount: number;
  firstSeenAt: string;
  lastUpdatedAt: string;
  status: 'OPEN' | 'CLOSED';
  /** Discord message ids keyed by channel, so updates can edit in place (§18). */
  discordMessages: Record<string, string>;
  createdAt: string;
}

/** A development within an existing cluster (§18). */
export interface EventUpdate {
  id: string;
  eventId: string;
  newsEventId: string;
  headline: string;
  body: string;
  occurredAt: string;
  importance: number;
  /** True when this update replaces the cluster's headline in Discord. */
  supersedes: boolean;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The processed record (§24 `news_events`)
// ─────────────────────────────────────────────────────────────────────────────

export interface NewsEvent {
  id: string;
  source: string; // source id
  sourcePostId: string;
  originalUrl: string | null; // retained, never displayed (§3)
  author: string | null; // retained, never displayed (§3)
  timestamp: string; // event time
  rawText: string;
  cleanText: string;
  headline: string;
  body: string;
  category: Category | null;
  subcategory: Subcategory | null;
  entities: ExtractedEntities;
  tickers: string[];
  countries: string[];
  eventId: string | null; // cluster membership
  importance: number;
  novelty: number;
  marketRelevance: number;
  confidence: number;
  score: ScoreBreakdown | null;
  status: EventStatus;
  rejectionReason: RejectionReason | null;
  earnings: EarningsData | null;
  filing: FilingData | null;
  createdAt: string;
  processedAt: string | null;
  discordMessageId: string | null;
  latency: LatencyRecord;
}

/** §22 timing, tracked end to end. */
export interface LatencyRecord {
  eventTime: string;
  ingestionTime: string;
  processingTime: string | null;
  discordTime: string | null;
  sourceToScoutMs: number | null;
  scoutToDiscordMs: number | null;
  totalMs: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering (§3, §33)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY shape the user-facing renderer accepts.
 *
 * There is deliberately no author, handle, url, source name, engagement,
 * sentiment, confidence, or AI-summary field. If a future change wants one of
 * those in an alert, it has to change this type first — which is the point.
 */
export interface RenderableAlert {
  banner: string; // "MACRO ALERT"
  headline: string; // "NO NUCLEAR IRAN"
  timestamp: string; // "5:14 PM · May 24, 2026"
  body: string; // trimmed prose, may end in an ellipsis
}

/** Everything the admin/debug channel may show (§27). */
export interface RawChannelPayload {
  sourceName: string;
  handle: string | null;
  originalUrl: string | null;
  rawText: string;
  eventTime: string;
  ingestionTime: string;
  category: Category | null;
  subcategory: Subcategory | null;
  decision: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE' | 'CLUSTERED';
  rejectionReason: RejectionReason | null;
  score: ScoreBreakdown | null;
  tickers: TickerMatch[];
  signals: string[];
  latencyMs: number | null;
  eventId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing (§26)
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelKey =
  // The three primary channels. `news` is the canonical complete feed;
  // `tradingFloor` and `spx` always move together and only carry events that
  // clear the market-impact bar.
  | 'news'
  | 'tradingFloor'
  | 'spx'
  | 'breaking'
  | 'macro'
  | 'fed'
  | 'geopolitics'
  | 'markets'
  | 'equities'
  | 'earnings'
  | 'commodities'
  | 'options'
  | 'crypto'
  | 'raw'
  | 'system';

export interface RouteDecision {
  channels: ChannelKey[];
  /** Why each channel was chosen; raw-channel only. */
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** What the pipeline returns for a single post. */
export interface PipelineOutcome {
  newsEvent: NewsEvent;
  accepted: boolean;
  rejection: RejectionReason | null;
  cluster: EventCluster | null;
  isNewCluster: boolean;
  supersedes: boolean;
  route: RouteDecision | null;
  alert: RenderableAlert | null;
  /** Why this did or did not reach the trading channels. */
  impact: import('../pipeline/marketImpact.js').MarketImpactVerdict | null;
  raw: RawChannelPayload;
  signals: string[];
}

export interface PipelineDeps {
  now: () => Date;
  newId: () => string;
}
