import { describe, it, expect, beforeAll } from 'vitest';
import { routeAlert, routeCalendarReminder } from '../src/discord/router.js';
import { assessMarketImpact } from '../src/pipeline/marketImpact.js';
import { loadSecurityMaster } from '../src/config/loader.js';
import type { Category, ExtractedEntities, ImportanceBand, Security } from '../src/core/types.js';

/**
 * The routing rule: a major market-moving event must never reach #scout-news
 * while the trading channels miss it, and the two trading channels always move
 * together.
 */

let securities: Security[];
beforeAll(() => {
  securities = loadSecurityMaster();
});

function entities(over: Partial<ExtractedEntities> = {}): ExtractedEntities {
  return {
    tickers: [],
    countries: [],
    organizations: [],
    people: [],
    commodities: [],
    figures: [],
    ...over,
  };
}

function route(opts: {
  category: Category;
  subcategory?: string | null;
  band: ImportanceBand;
  score?: number;
  text?: string;
  entities?: ExtractedEntities;
  secondary?: Category[];
  categoryChannels?: boolean;
}) {
  const impact = assessMarketImpact({
    category: opts.category,
    subcategory: opts.subcategory ?? null,
    band: opts.band,
    score: opts.score ?? 80,
    entities: opts.entities ?? entities(),
    text: opts.text ?? '',
    securities,
  });
  return routeAlert({
    category: opts.category,
    secondary: opts.secondary ?? [],
    band: opts.band,
    score: opts.score ?? 80,
    minBreakingScore: 90,
    subcategory: opts.subcategory ?? null,
    tickers: [],
    impact,
    categoryChannelsEnabled: opts.categoryChannels ?? false,
  });
}

const bothTradingChannels = (channels: string[]): boolean =>
  channels.includes('tradingFloor') && channels.includes('spx');

/** The invariant: a market-moving event never stops at #scout-news. */
const anyTradingChannel = (channels: string[]): boolean =>
  channels.includes('tradingFloor') || channels.includes('spx');

describe('the core rule', () => {
  it('sends every accepted event to #scout-news', () => {
    for (const band of ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'] as ImportanceBand[]) {
      expect(route({ category: 'EQUITY', band }).channels).toContain('news');
    }
  });

  /**
   * The trading channels are addressed by content, so they no longer move in
   * lockstep. What has NOT changed is that a market-moving event must reach at
   * least one of them — being market-moving and landing only in #scout-news is
   * the failure this rule exists to prevent.
   */
  it('never leaves a market-moving event in #scout-news alone', () => {
    const cases: Array<Parameters<typeof route>[0]> = [
      { category: 'FED', subcategory: 'FOMC_DECISION', band: 'CRITICAL' },
      { category: 'ECONOMIC', subcategory: 'CPI_RELEASE', band: 'HIGH' },
      { category: 'GEOPOLITICAL', subcategory: 'CONFLICT', band: 'CRITICAL' },
      { category: 'EQUITY', band: 'CRITICAL' },
      { category: 'OPTIONS', band: 'CRITICAL' },
      { category: 'COMMODITY', band: 'CRITICAL' },
    ];
    for (const c of cases) {
      const { channels, reasons } = route(c);
      expect(
        anyTradingChannel(channels),
        `${c.category} ${c.band} was market-moving but reached no trading channel: ${reasons.join('; ')}`,
      ).toBe(true);
    }
  });

  it('never routes an accepted event nowhere', () => {
    expect(route({ category: 'CRYPTO', band: 'LOW' }).channels.length).toBeGreaterThan(0);
  });
});

describe('the worked examples', () => {
  it('CPI release → news + #spx-trading (macro, not single-name)', () => {
    const { channels } = route({
      category: 'ECONOMIC',
      subcategory: 'CPI_RELEASE',
      band: 'CRITICAL',
      text: 'US CPI RISES 0.3% M/M VS 0.2% EXPECTED',
    });
    expect(channels).toContain('news');
    expect(channels).toContain('spx');
  });

  it('FOMC decision → news + #spx-trading', () => {
    const { channels } = route({
      category: 'FED',
      subcategory: 'FOMC_DECISION',
      band: 'CRITICAL',
      text: 'FED CUTS RATES BY 25 BPS',
    });
    expect(channels).toContain('spx');
  });

  it('a market-moving Powell remark → news + #spx-trading', () => {
    const { channels } = route({
      category: 'FED',
      subcategory: 'POWELL_REMARKS',
      band: 'HIGH',
      text: 'POWELL: FURTHER RATE CUTS WILL DEPEND ON INFLATION PROGRESS',
    });
    expect(channels).toContain('spx');
  });

  it('a major tariff announcement → news + #spx-trading', () => {
    const { channels } = route({
      category: 'GEOPOLITICAL',
      subcategory: 'TRADE',
      band: 'HIGH',
      text: 'TRUMP ANNOUNCES 25% TARIFF ON ALL IMPORTED VEHICLES',
      entities: entities({ countries: ['US'], people: ['TRUMP'] }),
    });
    expect(channels).toContain('spx');
  });

  it('a major Iran/Israel escalation → news + #spx-trading', () => {
    const { channels } = route({
      category: 'GEOPOLITICAL',
      subcategory: 'CONFLICT',
      band: 'HIGH',
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR FACILITIES',
      entities: entities({ countries: ['IL', 'IR'] }),
    });
    expect(channels).toContain('spx');
  });
});

describe('what must NOT flood the trading channels', () => {
  it('holds an ordinary non-market post to #scout-news', () => {
    const { channels } = route({
      category: 'EQUITY',
      band: 'LOW',
      text: 'Trump says happy birthday to a longtime supporter',
    });
    expect(channels).toEqual(['news']);
  });

  it('holds a minor single-name announcement to #scout-news', () => {
    const { channels } = route({
      category: 'EQUITY',
      band: 'MODERATE',
      text: 'ETSY NAMES NEW CHIEF MARKETING OFFICER',
      entities: entities({
        tickers: [{ ticker: 'ETSY', evidence: 'NAME', confidence: 0.95, matchedText: 'ETSY' }],
      }),
    });
    expect(bothTradingChannels(channels)).toBe(false);
    expect(channels).toContain('news');
  });

  it('holds a moderate crypto item to #scout-news', () => {
    const { channels } = route({ category: 'CRYPTO', band: 'MODERATE', text: 'exchange listing' });
    expect(anyTradingChannel(channels)).toBe(false);
  });

  /**
   * The example that motivated the split. Real corporate news, no market
   * implication — general intelligence, and nothing more.
   */
  it('holds a consumer product launch to #scout-news', () => {
    const { channels } = route({
      category: 'EQUITY',
      band: 'MODERATE',
      text: 'Ciarra expands into home comfort with new electric heater series',
    });
    expect(channels).toEqual(['news']);
  });
});

describe('severity drives routing', () => {
  it('CRITICAL always reaches a trading channel, whatever the category', () => {
    for (const category of ['EQUITY', 'CRYPTO', 'OPTIONS', 'COMMODITY'] as Category[]) {
      const { channels } = route({ category, band: 'CRITICAL' });
      expect(anyTradingChannel(channels), `${category} CRITICAL was held back`).toBe(true);
    }
  });

  it('LOW never reaches them', () => {
    for (const category of ['FED', 'ECONOMIC', 'GEOPOLITICAL'] as Category[]) {
      const { channels } = route({ category, band: 'LOW' });
      expect(anyTradingChannel(channels), `${category} LOW leaked`).toBe(false);
    }
  });

  it('MODERATE reaches them only on broad relevance', () => {
    const macro = route({ category: 'FED', subcategory: 'FOMC_DECISION', band: 'MODERATE' });
    const singleName = route({
      category: 'EQUITY',
      band: 'MODERATE',
      entities: entities({
        tickers: [{ ticker: 'ETSY', evidence: 'NAME', confidence: 0.95, matchedText: 'ETSY' }],
      }),
    });
    expect(macro.channels).toContain('spx');
    expect(anyTradingChannel(singleName.channels)).toBe(false);
  });
});

describe('index-moving company news is a market event', () => {
  it('treats an NVDA event as broad', () => {
    const impact = assessMarketImpact({
      category: 'EARNINGS',
      subcategory: 'EARNINGS_RESULT',
      band: 'HIGH',
      score: 85,
      entities: entities({
        tickers: [{ ticker: 'NVDA', evidence: 'NAME', confidence: 0.95, matchedText: 'NVIDIA' }],
      }),
      text: 'NVIDIA REPORTS Q3 REVENUE ABOVE ESTIMATES',
      securities,
    });
    expect(impact.relevance).toBe('broad');
    expect(impact.marketMoving).toBe(true);
  });

  it('does not treat a small cap the same way', () => {
    const impact = assessMarketImpact({
      category: 'EARNINGS',
      subcategory: 'EARNINGS_RESULT',
      band: 'HIGH',
      score: 80,
      entities: entities({
        tickers: [{ ticker: 'ETSY', evidence: 'NAME', confidence: 0.95, matchedText: 'Etsy' }],
      }),
      text: 'ETSY REPORTS QUARTERLY RESULTS',
      securities,
    });
    expect(impact.relevance).toBe('single_name');
  });
});

describe('the source never decides the route', () => {
  it('routes two posts from the same relay differently', () => {
    const trivial = route({
      category: 'EQUITY',
      band: 'LOW',
      text: 'Trump says happy birthday to someone',
    });
    const material = route({
      category: 'GEOPOLITICAL',
      subcategory: 'TRADE',
      band: 'HIGH',
      text: 'TRUMP ANNOUNCES 25% TARIFF ON STEEL IMPORTS',
      entities: entities({ countries: ['US'] }),
    });
    expect(anyTradingChannel(trivial.channels)).toBe(false);
    // A tariff announcement is macro, so it reaches the index channel.
    expect(material.channels).toContain('spx');
  });
});

describe('calendar reminders', () => {
  it('go to news and both trading channels', () => {
    const { channels } = routeCalendarReminder();
    expect(channels).toContain('news');
    expect(bothTradingChannels(channels)).toBe(true);
  });
});

describe('category fan-out is opt-in', () => {
  it('stays off by default', () => {
    const { channels } = route({ category: 'FED', subcategory: 'FOMC_DECISION', band: 'CRITICAL' });
    expect(channels).not.toContain('fed');
  });

  it('adds the category channels when enabled', () => {
    const { channels } = route({
      category: 'FED',
      subcategory: 'FOMC_DECISION',
      band: 'CRITICAL',
      categoryChannels: true,
    });
    // An FOMC decision is macro: index channel, not the single-name one.
    expect(channels).toEqual(expect.arrayContaining(['news', 'spx', 'fed', 'macro']));
  });
});

describe('an event whose route grows must reach the new channels', () => {
  // The critical failure the routing rule exists to prevent: a story that was
  // #scout-news only becomes market-moving on a later development. Editing the
  // existing messages alone would leave the trading channels with nothing.
  it('routes more channels once the event becomes market-moving', () => {
    const early = route({
      category: 'GEOPOLITICAL',
      band: 'MODERATE',
      score: 62,
      text: 'REPORTS OF UNREST NEAR A REGIONAL BORDER',
      entities: entities({ countries: ['TR'] }),
    });
    const later = route({
      category: 'GEOPOLITICAL',
      subcategory: 'CONFLICT',
      band: 'HIGH',
      score: 84,
      text: 'US CONFIRMS MILITARY ACTION AFTER BORDER ESCALATION',
      entities: entities({ countries: ['US', 'TR'] }),
    });

    expect(anyTradingChannel(early.channels)).toBe(false);
    expect(anyTradingChannel(later.channels)).toBe(true);

    // The publisher must post to what the second route added, not merely edit
    // the first message. A geopolitical escalation is macro, so the channel it
    // gains is the index one.
    const added = later.channels.filter((c) => !early.channels.includes(c));
    expect(added).toContain('spx');
  });
});

/**
 * The three-destination split, end to end through the market-impact classifier.
 * These are the worked examples the destinations were specified against.
 */
describe('the three destinations', () => {
  const dest = (channels: string[]) => ({
    general: channels.includes('news'),
    spxMacro: channels.includes('spx'),
    tickers: channels.includes('tradingFloor'),
  });

  it('macro goes to general + SPX/macro, not the ticker channel', () => {
    const { channels } = route({
      category: 'FED',
      subcategory: 'FOMC_DECISION',
      band: 'CRITICAL',
      text: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
    });
    expect(dest(channels)).toEqual({ general: true, spxMacro: true, tickers: false });
  });

  it('a material corporate action goes to general + tickers, not SPX/macro', () => {
    const { channels } = route({
      category: 'EQUITY',
      band: 'MODERATE',
      text: 'PFIZER TO ACQUIRE SEAGEN FOR $43 BILLION IN ALL-CASH DEAL',
      entities: entities({
        tickers: [{ ticker: 'PFE', evidence: 'NAME', confidence: 0.95, matchedText: 'PFIZER' }],
      }),
    });
    expect(dest(channels)).toEqual({ general: true, spxMacro: false, tickers: true });
  });

  it('an index heavyweight reaches BOTH trading channels', () => {
    // AAPL moves the index and is a single name, so it is genuinely both.
    const { channels } = route({
      category: 'EQUITY',
      band: 'HIGH',
      text: 'APPLE COMPONENT COSTS EXPECTED TO RISE 38% ON SUPPLY CHAIN CONSTRAINTS',
      entities: entities({
        tickers: [{ ticker: 'AAPL', evidence: 'NAME', confidence: 0.95, matchedText: 'APPLE' }],
      }),
    });
    expect(dest(channels)).toEqual({ general: true, spxMacro: true, tickers: true });
  });

  it('ordinary company news stays in general only', () => {
    const { channels } = route({
      category: 'EQUITY',
      band: 'MODERATE',
      text: 'ETSY ANNOUNCES $50 MILLION SHARE REPURCHASE PROGRAM',
      entities: entities({
        tickers: [{ ticker: 'ETSY', evidence: 'NAME', confidence: 0.95, matchedText: 'ETSY' }],
      }),
    });
    expect(dest(channels)).toEqual({ general: true, spxMacro: false, tickers: false });
  });
});
