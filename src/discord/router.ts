import type { Category, ChannelKey, ImportanceBand, RouteDecision } from '../core/types.js';

/**
 * CHANNEL ROUTING (§26).
 *
 * Events fan out to the channels that care, rather than broadcasting
 * everywhere. The spec's two worked examples are the acceptance criteria:
 *
 *   a critical Fed event   → breaking, macro, fed
 *   an NVDA earnings event → breaking, equities, earnings
 *
 * Pure function, no I/O.
 */

const HOME: Record<Category, ChannelKey[]> = {
  MACRO: ['macro'],
  FED: ['fed'],
  // An economic release is macro news; it only reaches markets when it is the
  // kind of print that repriceses the curve.
  ECONOMIC: ['macro'],
  GEOPOLITICAL: ['geopolitics'],
  MARKET: ['markets'],
  EQUITY: ['equities'],
  EARNINGS: ['earnings'],
  OPTIONS: ['options'],
  COMMODITY: ['commodities'],
  CRYPTO: ['crypto'],
};

/** Releases that move rates and therefore belong in #scout-markets too. */
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
}

export function routeAlert(input: RouteInput): RouteDecision {
  const channels = new Set<ChannelKey>();
  const reasons: string[] = [];

  for (const channel of HOME[input.category] ?? []) {
    channels.add(channel);
    reasons.push(`${channel}: home channel for ${input.category}`);
  }

  // A Fed decision is macro news as well as Fed news.
  if (input.category === 'FED') {
    channels.add('macro');
    reasons.push('macro: Fed policy is macro');
  }

  if (input.category === 'ECONOMIC' && input.subcategory && RATE_MOVING.has(input.subcategory)) {
    channels.add('markets');
    reasons.push(`markets: ${input.subcategory} reprices the curve`);
  }

  // An earnings event is equity news too — the spec routes NVDA earnings to
  // both #scout-equities and #scout-earnings.
  if (input.category === 'EARNINGS') {
    channels.add('equities');
    reasons.push('equities: earnings is company news');
  }

  for (const secondary of input.secondary) {
    for (const channel of HOME[secondary] ?? []) {
      if (!channels.has(channel)) {
        channels.add(channel);
        reasons.push(`${channel}: secondary category ${secondary}`);
      }
    }
  }

  if (input.score >= input.minBreakingScore || input.band === 'CRITICAL') {
    channels.add('breaking');
    reasons.push(
      input.band === 'CRITICAL'
        ? 'breaking: CRITICAL band'
        : `breaking: score ${Math.round(input.score)} >= ${input.minBreakingScore}`,
    );
  }

  // The admin channels are never a routing target; the publisher handles them.
  channels.delete('raw');
  channels.delete('system');

  if (channels.size === 0) {
    const fallback = HOME[input.category]?.[0] ?? 'markets';
    channels.add(fallback);
    reasons.push(`${fallback}: fallback, an accepted alert always lands somewhere`);
  }

  return { channels: [...channels], reasons };
}
