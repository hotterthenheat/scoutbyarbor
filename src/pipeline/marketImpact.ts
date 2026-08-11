import type { Category, ExtractedEntities, ImportanceBand, Security } from '../core/types.js';

/**
 * MARKET IMPACT.
 *
 * Decides whether an event reaches the trading channels. The routing rule is
 * "MAJOR MARKET EVENT → #trading-floor + #spx-trading", so this module answers
 * one question: could this realistically move SPX / SPY / ES / NDX / QQQ, US
 * rates, the dollar, or broad risk sentiment?
 *
 * Two things it deliberately does NOT look at:
 *
 *   - the source. DeltaOne posting "Trump says happy birthday" and DeltaOne
 *     posting "TRUMP ANNOUNCES 25% TARIFF" route differently. The event
 *     decides, never the account.
 *   - whether the market is open. Geopolitical and policy news breaks
 *     overnight and at weekends; the router does not wait for the bell.
 *
 * The instruction is also explicit that this must not be unnecessarily
 * conservative — a genuinely major event reaching only #scout-news is the
 * failure mode to avoid.
 */

export type MarketRelevance = 'broad' | 'sector' | 'single_name' | 'none';

export interface MarketImpactVerdict {
  relevance: MarketRelevance;
  /** True → the event belongs in #trading-floor and #spx-trading. */
  marketMoving: boolean;
  /** True when the event is macro in nature (rates, policy, inflation, growth). */
  macro: boolean;
  reasons: string[];
}

export interface MarketImpactInput {
  category: Category;
  subcategory: string | null;
  band: ImportanceBand;
  score: number;
  entities: ExtractedEntities;
  text: string;
  securities: Security[];
}

/** Releases and decisions that reprice the whole curve on arrival. */
const BROAD_SUBCATEGORIES = new Set([
  'FOMC_DECISION',
  'POWELL_REMARKS',
  'MINUTES',
  'GUIDANCE',
  'BALANCE_SHEET',
  'EMERGENCY',
  'CPI_RELEASE',
  'PCE_RELEASE',
  'PPI_RELEASE',
  'NFP_RELEASE',
  'GDP_RELEASE',
  'CLAIMS_RELEASE',
  'RETAIL_RELEASE',
  'PMI_RELEASE',
  'LABOR_RELEASE',
  'RATES',
  'FISCAL',
  'DEBT',
  'BANKING',
  'INFLATION',
  'HALT',
  'LIQUIDITY',
  'CREDIT',
  'VOLATILITY',
  'RATES_MOVE',
  'FX',
  'CONFLICT',
  'SANCTIONS',
  'TRADE',
  'SHIPPING',
  'NUCLEAR',
  'OPEC',
  'ENERGY',
]);

/**
 * Policy and conflict vocabulary that makes an item market-moving regardless of
 * which category it landed in — this is what catches a Trump/Truth Social post
 * about tariffs that is not otherwise a Fed or economic release.
 */
const BROAD_TERMS = [
  'tariff', 'tariffs', 'sanction', 'sanctions', 'embargo', 'export controls',
  'trade war', 'trade deal', 'interest rate', 'interest rates', 'rate cut',
  'rate hike', 'federal reserve', 'fomc', 'powell', 'inflation', 'recession',
  'debt ceiling', 'government shutdown', 'default', 'downgrade', 'stimulus',
  'tax cut', 'tax hike', 'corporate tax', 'fiscal', 'treasury', 'bailout',
  'war', 'invasion', 'invades', 'military action', 'airstrike', 'air strike',
  'missile', 'ceasefire', 'nuclear', 'strait of hormuz', 'red sea',
  'oil embargo', 'production cut', 'opec', 'circuit breaker', 'trading halt',
  'banking crisis', 'bank failure', 'liquidity crisis', 'contagion',
  'capital controls', 'currency intervention', 'devaluation',
];

/** An index heavyweight moving is itself a broad-market event. */
const INDEX_MOVER_PRIORITY = 85;

/**
 * Corporate actions that reprice a single name on their own.
 *
 * These exist because the single-name trading channel needs them: a $43bn
 * acquisition is a MODERATE-band, single-name event, and the old rule — trading
 * channels only on broad relevance — was written when both trading channels
 * were index-oriented and there was nowhere for a company catalyst to go.
 *
 * Deliberately narrow. Buybacks, dividends, splits, executive hires and product
 * launches are NOT here: they are real company news and belong in the general
 * feed, not on a trading desk's alert path.
 */
const MATERIAL_CORPORATE_ACTIONS = [
  'acquire',
  'acquires',
  'acquisition',
  'to acquire',
  'merger',
  'merges with',
  'takeover',
  'buyout',
  'all-cash deal',
  'tender offer',
  'guidance',
  'cuts outlook',
  'raises outlook',
  'profit warning',
  'downgrade',
  'downgrades',
  'upgrade',
  'upgrades',
  'price target',
  'bankruptcy',
  'chapter 11',
  'halts production',
  'production halt',
  'recall',
  'fda approval',
  'fda rejects',
  'antitrust',
  'investigation',
  'delisting',
];

export function assessMarketImpact(input: MarketImpactInput): MarketImpactVerdict {
  const reasons: string[] = [];
  const lower = input.text.toLowerCase();

  const macro =
    input.category === 'FED' || input.category === 'ECONOMIC' || input.category === 'MACRO';

  const RANK: Record<MarketRelevance, number> = { none: 0, single_name: 1, sector: 2, broad: 3 };
  const state: { relevance: MarketRelevance } = { relevance: 'none' };

  const setRelevance = (next: MarketRelevance, why: string): void => {
    if (RANK[next] > RANK[state.relevance]) {
      state.relevance = next;
      reasons.push(why);
    }
  };

  // Macro, Fed and market-structure events are broad by construction.
  if (macro) setRelevance('broad', `macro category ${input.category}`);
  if (input.category === 'MARKET') setRelevance('broad', 'market-structure event');

  if (input.subcategory && BROAD_SUBCATEGORIES.has(input.subcategory)) {
    setRelevance('broad', `subcategory ${input.subcategory}`);
  }

  // Policy/conflict vocabulary, wherever it appears.
  const termHit = BROAD_TERMS.find((t) => hasTerm(lower, t));
  if (termHit) setRelevance('broad', `broad-market term "${termHit}"`);

  // Geopolitical events involving major powers move risk sentiment.
  if (input.category === 'GEOPOLITICAL') {
    const majorPowers = input.entities.countries.filter((c) =>
      ['US', 'CN', 'RU', 'IR', 'IL', 'TW', 'KP', 'SA', 'UA'].includes(c),
    );
    if (majorPowers.length > 0) {
      setRelevance('broad', `geopolitical involving ${majorPowers.join('/')}`);
    }
  }

  // Energy is the commodity that transmits into the index.
  if (input.category === 'COMMODITY') {
    const energy = input.entities.commodities.some((c) => c === 'CRUDE' || c === 'NATGAS');
    setRelevance(energy ? 'broad' : 'sector', energy ? 'energy shock' : 'commodity-specific');
  }

  // Company news: index weight is what makes a single name a market event.
  if (input.category === 'EQUITY' || input.category === 'EARNINGS' || input.category === 'OPTIONS') {
    const byTicker = new Map(input.securities.map((s) => [s.ticker, s]));
    let heavyweight: Security | undefined;

    for (const match of input.entities.tickers) {
      const sec = byTicker.get(match.ticker);
      if (!sec) continue;
      const inIndex = sec.indices.includes('SPX') || sec.indices.includes('NDX');
      if (inIndex && sec.priority >= INDEX_MOVER_PRIORITY) {
        if (!heavyweight || sec.priority > heavyweight.priority) heavyweight = sec;
      }
    }

    if (heavyweight) {
      setRelevance('broad', `index heavyweight ${heavyweight.ticker} (p${heavyweight.priority})`);
    } else if (input.entities.tickers.length > 0) {
      setRelevance('single_name', `single name ${input.entities.tickers[0]?.ticker}`);
    }
  }

  if (input.category === 'CRYPTO') setRelevance('sector', 'crypto-specific');

  // ── The routing decision itself ─────────────────────────────────────────
  //
  // CRITICAL always goes. HIGH goes when it is market-wide or SPX-relevant.
  // MODERATE only on genuine broad relevance. LOW stays in #scout-news.
  let marketMoving = false;

  const relevance = state.relevance;

  switch (input.band) {
    case 'CRITICAL':
      marketMoving = true;
      reasons.push('CRITICAL band always reaches the trading channels');
      break;
    case 'HIGH':
      marketMoving = relevance === 'broad' || relevance === 'sector';
      reasons.push(
        marketMoving
          ? `HIGH band with ${relevance} relevance`
          : `HIGH band but only ${relevance} relevance`,
      );
      break;
    case 'MODERATE': {
      // A material corporate action is a trading event for the name it names,
      // even when it moves nothing at the index level. That is what the
      // single-name channel is for.
      const materialAction =
        (relevance === 'single_name' || relevance === 'sector') &&
        MATERIAL_CORPORATE_ACTIONS.some((term) => hasTerm(lower, term));

      marketMoving = relevance === 'broad' || materialAction;
      reasons.push(
        relevance === 'broad'
          ? 'MODERATE band with broad-market relevance'
          : materialAction
            ? `MODERATE band, ${relevance} relevance, material corporate action`
            : `MODERATE band with only ${relevance} relevance — #scout-news only`,
      );
      break;
    }
    default:
      reasons.push(`${input.band} band — #scout-news only`);
      break;
  }

  return { relevance, marketMoving, macro, reasons };
}

function hasTerm(lower: string, term: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, 'i').test(lower);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
