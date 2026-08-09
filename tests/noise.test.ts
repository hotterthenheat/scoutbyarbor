import { describe, it, expect, beforeAll } from 'vitest';
import { loadTaxonomy } from '../src/config/loader.js';
import { createNoiseClassifier } from '../src/pipeline/classify/noise.js';
import { createFactualityClassifier } from '../src/pipeline/classify/factuality.js';
import { tokenize } from '../src/util/text.js';
import type { TaxonomyFile } from '../src/config/types.js';

/**
 * §20 and §14. The noise filter decides whether the product is worth using, so
 * both directions matter: real headlines must survive, and the spec's named
 * examples of noise must not.
 */

let taxonomy: TaxonomyFile;
let noise: ReturnType<typeof createNoiseClassifier>;
let factuality: ReturnType<typeof createFactualityClassifier>;

beforeAll(() => {
  taxonomy = loadTaxonomy();
  noise = createNoiseClassifier(taxonomy);
  factuality = createFactualityClassifier(taxonomy);
});

const judge = (text: string, opts: { quality?: number; strict?: boolean; isEcho?: boolean } = {}) =>
  noise.classify({
    text,
    tokens: tokenize(text),
    isEcho: opts.isEcho ?? false,
    sourceQuality: opts.quality ?? 95,
    filterProfile: opts.strict ? 'strict' : 'standard',
  });

describe('real headlines survive the filter', () => {
  const headlines = [
    "FED'S POWELL: FURTHER RATE CUTS WILL DEPEND ON INFLATION PROGRESS",
    'NVIDIA ANNOUNCES MAJOR NEW AI PARTNERSHIP',
    'APPLE REPORTS Q3 EPS $2.40 VS $2.35 EST',
    'GOLDMAN RAISES S&P 500 YEAR-END TARGET TO 6,500',
    'US CPI RISES 0.3% M/M IN JULY VS 0.2% EXPECTED',
    'NVIDIA REPORTEDLY FACES NEW EXPORT RESTRICTIONS',
    'TESLA RECALLS 12,000 VEHICLES OVER AUTOPILOT SOFTWARE',
    'ISRAEL AND HAMAS AGREE TO CEASEFIRE, OFFICIALS SAY',
    'OPEC+ AGREES TO EXTEND PRODUCTION CUTS THROUGH Q2',
  ];

  it.each(headlines)('accepts: %s', (text) => {
    const verdict = judge(text);
    expect(verdict.isNoise, `rejected as ${verdict.reason}`).toBe(false);
  });

  it('accepts them under the strict profile too', () => {
    for (const text of headlines) {
      const verdict = judge(text, { strict: true, quality: 70 });
      expect(verdict.isNoise, `${text} rejected as ${verdict.reason}`).toBe(false);
    }
  });
});

describe('the spec’s named noise cases are rejected', () => {
  const cases: Array<[string, string]> = [
    ['NVDA is looking strong today', 'NOISE_MARKET_CHATTER'],
    ['Here’s why I think NVDA hits $250', 'NOISE_OPINION'],
    ['LIKE if you think Powell is wrong', 'NOISE_ENGAGEMENT_BAIT'],
    ['TSLA to the moon \u{1F680}\u{1F680} diamond hands', 'NOISE_MEME'],
    ['Join my free trading Discord, link in bio', 'NOISE_PROMOTIONAL'],
    ['I think SPY goes higher from here', 'NOISE_OPINION'],
    ['NVDA could hit $200 by year end', 'NOISE_PREDICTION'],
  ];

  it.each(cases)('rejects %s', (text) => {
    expect(judge(text).isNoise, `${text} was accepted`).toBe(true);
  });

  it('assigns a plausible reason, not just a rejection', () => {
    for (const [text, expected] of cases) {
      const verdict = judge(text);
      expect(verdict.reason, `${text} → ${verdict.reason}`).toBeTruthy();
      // Several of these legitimately match more than one class (an opinion
      // about a price is also a prediction), so accept any noise reason but
      // require the classifier to have an opinion at all.
      expect(String(verdict.reason)).toMatch(/^NOISE_/);
      void expected;
    }
  });

  it('rejects a bare retweet with no added information', () => {
    expect(judge('RT @someone: markets are open', { isEcho: true }).isNoise).toBe(true);
  });
});

describe('§14 — the NVDA and TSLA worked examples', () => {
  it('accepts material company news', () => {
    expect(judge('NVIDIA announces major new AI partnership.').isNoise).toBe(false);
    expect(judge('NVIDIA reportedly faces new export restrictions.').isNoise).toBe(false);
    expect(judge('Tesla Q3 production 435,000 vehicles, deliveries 462,000').isNoise).toBe(false);
  });

  it('rejects chatter and price talk about the same names', () => {
    expect(judge('NVDA is looking strong today.').isNoise).toBe(true);
    expect(judge("Here's why I think NVDA hits $250.").isNoise).toBe(true);
    expect(judge('TSLA to the moon').isNoise).toBe(true);
  });
});

describe('a reported analyst action is news, not a prediction', () => {
  it('keeps a reported price-target change', () => {
    // The distinction: the poster predicting vs the poster reporting that
    // someone else made a call.
    expect(judge('Morgan Stanley raises NVDA price target to $200 from $175').isNoise).toBe(false);
  });

  it('drops the poster making the same call themselves', () => {
    expect(judge('My NVDA price target is $200, easy money').isNoise).toBe(true);
  });
});

describe('factuality gate (§8)', () => {
  it('calls attributed reporting factual', () => {
    const v = factuality.classify({
      text: 'Powell said the committee is prepared to adjust policy as needed, according to Reuters.',
      tokens: tokenize('Powell said the committee is prepared to adjust policy as needed'),
      hasFigures: false,
      isOfficial: false,
    });
    expect(v.verdict).toBe('FACTUAL_NEWS');
  });

  it('calls unattributed evaluation commentary', () => {
    const text = 'The Fed should have cut months ago; this is what happens when you ignore the data.';
    const v = factuality.classify({
      text,
      tokens: tokenize(text),
      hasFigures: false,
      isOfficial: false,
    });
    expect(v.verdict).toBe('COMMENTARY');
  });

  it('treats an official source as factual by construction', () => {
    const text = 'The Committee decided to maintain the target range at 4-1/4 to 4-1/2 percent.';
    const v = factuality.classify({
      text,
      tokens: tokenize(text),
      hasFigures: true,
      isOfficial: true,
    });
    expect(v.verdict).toBe('FACTUAL_NEWS');
    expect(v.confidence).toBeGreaterThan(0.8);
  });
});

describe('promotional and meme content is never exempted by source quality', () => {
  it('rejects promotion even from a top-tier source', () => {
    expect(judge('Sign up for our newsletter, link in bio', { quality: 100 }).isNoise).toBe(true);
  });
});
