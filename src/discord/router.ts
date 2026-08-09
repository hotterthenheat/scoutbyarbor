import type { Category, ChannelKey, ImportanceBand, RouteDecision } from '../core/types.js';
import type { MarketImpactVerdict } from '../pipeline/marketImpact.js';

/**
 * CHANNEL ROUTING.
 *
 * The channel hierarchy:
 *
 *   #scout-news      the complete qualified Scout feed — every accepted event
 *   #trading-floor   every major market-moving event
 *   #spx-trading     the same major events, for anything that can move SPX
 *
 * The core rule is that the trading channels move together: there must be no
 * situation where a critical macro/geopolitical/Fed/government event lands in
 * #scout-news while the trading channels miss it. `marketMoving` is decided by
 * the market-impact classifier, and if it is true both trading channels get the
 * event — never one without the other.
 *
 * Routing is decided by the event, never by the source. The same account can
 * produce a #scout-news-only post and an all-channels post minutes apart.
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
};

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

  // 2. The trading channels move together, or not at all.
  if (input.impact.marketMoving) {
    channels.add('tradingFloor');
    channels.add('spx');
    reasons.push(`trading-floor + spx-trading: ${input.impact.reasons[0] ?? 'major market event'}`);
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
  return {
    channels: ['news', 'tradingFloor', 'spx'],
    reasons: ['scheduled calendar event: news + both trading channels'],
  };
}
