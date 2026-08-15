import type { Category, ChannelKey, ImportanceBand, RouteDecision } from '../core/types.js';
import type { MarketImpactVerdict } from '../pipeline/marketImpact.js';

/**
 * CHANNEL ROUTING.
 *
 * The channel hierarchy:
 *
 *   #scout-news      the complete qualified Scout feed — every accepted event
 *   #spx-trading     index-level and macro: SPX/SPY/QQQ, Fed, CPI/PPI/NFP/GDP,
 *                    rates, major geopolitical, commodities, market-wide risk
 *   #trading-floor   single-name: tickers, earnings, guidance, M&A, analyst
 *                    actions, product/regulatory developments, options catalysts
 *
 * THE INVARIANT, which has not changed: a market-moving event never stops at
 * #scout-news. If `marketMoving` is true it reaches at least one trading
 * channel, and an event that qualifies as both macro and single-name reaches
 * both. Should the two tests somehow both fail on a market-moving event, it
 * goes to both rather than neither — losing a real event is the failure that
 * matters, and a duplicate is merely noise.
 *
 * WHAT DID CHANGE: the trading channels no longer move in lockstep. They used
 * to receive every market-moving event together. They are now addressed by what
 * the event is about, because a desk watching single-name flow does not need
 * every CPI print and a desk trading the index does not need every earnings
 * beat. The split is by CONTENT, decided by the market-impact classifier —
 * never by which source the event arrived from.
 *
 * Routing is decided by the event, never by the source. The same account, and
 * the same ingestion path, can produce a #scout-news-only post and an
 * all-channels post minutes apart.
 *
 * The per-category channels from the original spec are still supported and are
 * emitted as an additional fan-out when enabled.
 */

const CATEGORY_HOME: Record<Category, ChannelKey[]> = {
  MACRO: ['macro'],
  FED: ['fed'],
  ECONOMIC: ['macro'],
  GEOPOLITICAL: ['geopolitics'],
  MARKET: ['markets'],
  EQUITY: ['equities'],
  EARNINGS: ['earnings'],
  OPTIONS: ['options'],
  COMMODITY: ['commodities'],
  CRYPTO: ['crypto'],
  POLITICS: ['macro'],
  ORDER_FLOW: ['markets'],
};

/** Categories that are about a company rather than the market as a whole. */
const SINGLE_NAME_CATEGORIES = new Set<Category>(['EQUITY', 'EARNINGS', 'OPTIONS', 'ORDER_FLOW']);

const RATE_MOVING = new Set([
  'CPI_RELEASE',
  'PCE_RELEASE',
  'NFP_RELEASE',
  'PPI_RELEASE',
  'GDP_RELEASE',
  'FOMC_DECISION',
]);

export interface RouteInput {
  category: Category;
  secondary: Category[];
  band: ImportanceBand;
  score: number;
  minBreakingScore: number;
  subcategory: string | null;
  tickers: string[];
  impact: MarketImpactVerdict;
  /** Emit the per-category channels alongside the three primary ones. */
  categoryChannelsEnabled?: boolean;
}

export function routeAlert(input: RouteInput): RouteDecision {
  const channels = new Set<ChannelKey>();
  const reasons: string[] = [];

  // 1. Every accepted event goes to the canonical feed.
  channels.add('news');
  reasons.push('news: the complete qualified Scout feed');

  // 2. Trading channels, addressed by what the event is about.
  if (input.impact.marketMoving) {
    const macroSide = input.impact.macro || input.impact.relevance === 'broad';
    const singleNameSide =
      input.tickers.length > 0 ||
      SINGLE_NAME_CATEGORIES.has(input.category) ||
      input.impact.relevance === 'single_name' ||
      input.impact.relevance === 'sector';

    if (macroSide) {
      channels.add('spx');
      reasons.push(`spx-trading: ${input.impact.reasons[0] ?? 'index-level or macro event'}`);
    }
    if (singleNameSide) {
      channels.add('tradingFloor');
      reasons.push(
        `trading-floor: ${
          input.tickers.length > 0
            ? `affects ${input.tickers.slice(0, 4).join(', ')}`
            : `${input.category} single-name event`
        }`,
      );
    }

    // A market-moving event must never end up in #scout-news alone. If neither
    // test fired, the classifier disagrees with itself — send both rather than
    // silently dropping a real event out of the trading channels.
    if (!macroSide && !singleNameSide) {
      channels.add('spx');
      channels.add('tradingFloor');
      reasons.push(
        'trading-floor + spx-trading: market-moving but neither macro nor single-name — routed to both rather than held back',
      );
    }

    for (const reason of input.impact.reasons.slice(1, 3)) reasons.push(`  · ${reason}`);
  } else {
    reasons.push(
      `held out of the trading channels: ${input.impact.reasons.at(-1) ?? 'below the market-impact bar'}`,
    );
  }

  // 3. Optional per-category fan-out.
  if (input.categoryChannelsEnabled) {
    for (const channel of CATEGORY_HOME[input.category] ?? []) {
      channels.add(channel);
      reasons.push(`${channel}: home channel for ${input.category}`);
    }
    if (input.category === 'FED') channels.add('macro');
    if (input.category === 'EARNINGS') channels.add('equities');
    if (input.category === 'ECONOMIC' && input.subcategory && RATE_MOVING.has(input.subcategory)) {
      channels.add('markets');
    }
    for (const secondary of input.secondary) {
      for (const channel of CATEGORY_HOME[secondary] ?? []) channels.add(channel);
    }
    if (input.score >= input.minBreakingScore || input.band === 'CRITICAL') {
      channels.add('breaking');
      reasons.push('breaking: CRITICAL band or above the breaking threshold');
    }
  }

  // The admin channels are never a routing target.
  channels.delete('raw');
  channels.delete('system');

  return { channels: [...channels], reasons };
}

/**
 * A scheduled calendar reminder goes straight to the trading channels — the
 * point of "CPI IN 15 MINUTES" is that a desk sees it where it is trading.
 */
export function routeCalendarReminder(): RouteDecision {
  // A scheduled release is macro by definition — CPI, NFP, FOMC — so it belongs
  // in the index channel. It goes to the single-name channel too: "CPI IN 15
  // MINUTES" is a reason to stop trading anything, not only the index.
  return {
    channels: ['news', 'tradingFloor', 'spx'],
    reasons: ['scheduled macro release: news + both trading channels'],
  };
}
