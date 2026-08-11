import type {
  Category,
  EarningsData,
  ExtractedEntities,
  FactualityVerdict,
  FilingData,
  ImportanceBand,
  NoiseVerdict,
  ScoreBreakdown,
  Security,
  Source,
} from '../core/types.js';
import { SCORE_WEIGHTS } from '../core/types.js';

/**
 * IMPORTANCE SCORE (§19).
 *
 * Six weighted components, exactly as specified. The absolute number is not
 * meaningful on its own and is never shown to a user — it is a routing
 * mechanism. What matters is that an emergency Fed cut outranks a regional PMI
 * print, and that the fifth wire to carry a story ranks below the first.
 */

export interface ScoreInput {
  source: Source;
  category: Category;
  subcategory: string | null;
  entities: ExtractedEntities;
  text: string;
  tokens: string[];
  factuality: FactualityVerdict;
  noise: NoiseVerdict;
  magnitudeTerms: { high: string[]; medium: string[] };
  novelty: number;
  corroboratingSources: number;
  securities: Security[];
  filing?: FilingData | null;
  earnings?: EarningsData | null;
}

/** How much a category inherently matters to a trading desk. */
const CATEGORY_RELEVANCE: Record<Category, number> = {
  FED: 92,
  ECONOMIC: 88,
  MACRO: 80,
  GEOPOLITICAL: 78,
  MARKET: 82,
  EARNINGS: 76,
  EQUITY: 70,
  COMMODITY: 68,
  OPTIONS: 58,
  CRYPTO: 52,
};

/** The releases and decisions that move everything at once. */
const SUBCATEGORY_RELEVANCE: Record<string, number> = {
  FOMC_DECISION: 100,
  CPI_RELEASE: 98,
  NFP_RELEASE: 96,
  PCE_RELEASE: 92,
  POWELL_REMARKS: 90,
  GDP_RELEASE: 86,
  PPI_RELEASE: 84,
  GUIDANCE: 84,
  EMERGENCY: 100,
  BALANCE_SHEET: 82,
  MINUTES: 80,
  CONFLICT: 88,
  SANCTIONS: 82,
  HALT: 94,
  LIQUIDITY: 92,
  CREDIT: 88,
  MNA: 82,
  RESTRUCTURING: 80,
  EARNINGS_RESULT: 78,
  CLAIMS_RELEASE: 70,
  PMI_RELEASE: 68,
  HOUSING_RELEASE: 62,
  SENTIMENT_RELEASE: 58,
};

export function scoreEvent(input: ScoreInput): ScoreBreakdown {
  const notes: string[] = [];
  const lower = input.text.toLowerCase();

  const sourceQuality = scoreSourceQuality(input, notes);
  const marketRelevance = scoreMarketRelevance(input, notes);
  const novelty = clamp(input.novelty, 0, 100);
  const magnitude = scoreMagnitude(input, lower, notes);
  const assetExposure = scoreAssetExposure(input, notes);
  const credibility = scoreCredibility(input, notes);

  let total = clamp(
    sourceQuality * SCORE_WEIGHTS.sourceQuality +
      marketRelevance * SCORE_WEIGHTS.marketRelevance +
      novelty * SCORE_WEIGHTS.novelty +
      magnitude * SCORE_WEIGHTS.magnitude +
      assetExposure * SCORE_WEIGHTS.assetExposure +
      credibility * SCORE_WEIGHTS.credibility,
    0,
    100,
  );

  // A curated/manual source gets an automatic bump to ensure it clears the threshold,
  // since a human operator explicitly chose to relay it.
  if (input.source.sourceType === 'manual') {
    total = Math.max(total, 70);
    notes.push('curated-source bump');
  }

  notes.push(`novelty ${Math.round(novelty)}`);

  return {
    sourceQuality,
    marketRelevance,
    novelty,
    magnitude,
    assetExposure,
    credibility,
    total,
    band: bandFor(total),
    notes,
  };
}

export function bandFor(total: number): ImportanceBand {
  if (total >= 90) return 'CRITICAL';
  if (total >= 75) return 'HIGH';
  if (total >= 60) return 'MODERATE';
  if (total >= 40) return 'LOW';
  return 'IGNORE';
}

// ─────────────────────────────────────────────────────────────────────────────

function scoreSourceQuality(input: ScoreInput, notes: string[]): number {
  const value = clamp(input.source.qualityScore - input.source.noiseScore * 0.5, 0, 100);
  notes.push(`source ${input.source.id} q${input.source.qualityScore}/n${input.source.noiseScore} → ${Math.round(value)}`);
  return value;
}

function scoreMarketRelevance(input: ScoreInput, notes: string[]): number {
  let value = CATEGORY_RELEVANCE[input.category] ?? 60;
  const sub = input.subcategory ? SUBCATEGORY_RELEVANCE[input.subcategory] : undefined;
  if (sub !== undefined) {
    // The subcategory is the more specific claim, so it dominates.
    value = value * 0.35 + sub * 0.65;
    notes.push(`relevance ${input.category}/${input.subcategory} → ${Math.round(value)}`);
  } else {
    notes.push(`relevance ${input.category} → ${Math.round(value)}`);
  }

  // Naming a tradable asset makes almost anything more actionable.
  const namesAsset =
    input.entities.tickers.length > 0 ||
    input.entities.commodities.length > 0 ||
    /(?<![a-z])(?:treasury|yields?|dollar|bonds?|rates?)(?![a-z])/i.test(input.text);
  if (namesAsset) value += 4;

  return clamp(value, 0, 100);
}

function scoreMagnitude(input: ScoreInput, lower: string, notes: string[]): number {
  let value = 30;

  const highHits = input.magnitudeTerms.high.filter((t) => hasTerm(lower, t));
  const mediumHits = input.magnitudeTerms.medium.filter((t) => hasTerm(lower, t));
  value += Math.min(40, highHits.length * 20);
  value += Math.min(15, mediumHits.length * 7);
  if (highHits.length) notes.push(`magnitude:high ${highHits.slice(0, 3).join(', ')}`);
  if (mediumHits.length) notes.push(`magnitude:medium ${mediumHits.slice(0, 3).join(', ')}`);

  // Size of the numbers involved. A 50bp move is not a 5bp move.
  for (const figure of input.entities.figures) {
    if (figure.kind === 'BPS' && Math.abs(figure.value) >= 25) {
      value += Math.abs(figure.value) >= 50 ? 15 : 8;
      notes.push(`magnitude:bps ${figure.value}`);
    }
    if (figure.kind === 'PERCENT' && Math.abs(figure.value) >= 5) {
      value += 10;
      notes.push(`magnitude:pct ${figure.value}`);
    }
    if (figure.kind === 'CURRENCY' && Math.abs(figure.value) >= 1e9) {
      value += Math.abs(figure.value) >= 1e10 ? 12 : 7;
      notes.push(`magnitude:usd ${figure.raw}`);
    }
  }

  if (input.filing) {
    const bump =
      input.filing.materiality === 'CRITICAL' ? 25 : input.filing.materiality === 'HIGH' ? 15 : 0;
    if (bump) {
      value += bump;
      notes.push(`magnitude:filing ${input.filing.materiality}`);
    }
  }

  if (input.earnings?.epsSurprise && input.earnings.epsSurprise !== 'INLINE') {
    value += 12;
    notes.push(`magnitude:earnings ${input.earnings.epsSurprise}`);
  }

  return clamp(value, 0, 100);
}

function scoreAssetExposure(input: ScoreInput, notes: string[]): number {
  const byTicker = new Map(input.securities.map((s) => [s.ticker, s]));

  let value = 20;
  let best = 0;

  for (const match of input.entities.tickers) {
    const sec = byTicker.get(match.ticker);
    if (!sec) continue;
    // Index membership is what makes a single name matter to the whole book.
    const indexWeight = sec.indices.includes('SPX') || sec.indices.includes('NDX') ? 25 : 0;
    const candidate = sec.priority * 0.7 + indexWeight;
    if (candidate > best) {
      best = candidate;
      notes.push(`exposure ${sec.ticker} p${sec.priority}${indexWeight ? ' index' : ''}`);
    }
  }
  value = Math.max(value, best);

  // Rates, FX and commodities are exposure even without a ticker.
  if (input.entities.commodities.length > 0) {
    value = Math.max(value, 62);
    notes.push(`exposure commodity ${input.entities.commodities[0]}`);
  }
  if (input.category === 'FED' || input.category === 'ECONOMIC' || input.category === 'MACRO') {
    // Macro touches every book by construction.
    value = Math.max(value, 80);
    notes.push('exposure macro-wide');
  }
  if (input.category === 'GEOPOLITICAL' && input.entities.countries.length > 0) {
    value = Math.max(value, 60);
  }

  return clamp(value, 0, 100);
}

function scoreCredibility(input: ScoreInput, notes: string[]): number {
  let value = input.source.official ? 95 : 60 + input.source.qualityScore * 0.25;

  if (input.factuality.verdict === 'FACTUAL_NEWS') {
    value += input.factuality.confidence * 12;
  } else {
    value -= 25;
    notes.push('credibility: classified as commentary');
  }

  // Independent corroboration is the strongest signal a story is real.
  const corroboration = Math.min(15, input.corroboratingSources * 5);
  if (corroboration > 0) {
    value += corroboration;
    notes.push(`credibility:corroborated x${input.corroboratingSources}`);
  }

  if (input.source.official) notes.push('credibility: official source');

  // Residual noise suspicion, even when it cleared the filter.
  value -= input.noise.confidence * 5;

  return clamp(value, 0, 100);
}

function hasTerm(lower: string, term: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(term.toLowerCase())}(?![a-z0-9])`, 'i').test(lower);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
