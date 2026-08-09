import { describe, it, expect, beforeAll } from 'vitest';
import { scoreEvent, bandFor } from '../src/pipeline/score.js';
import { loadTaxonomy, loadSecurityMaster } from '../src/config/loader.js';
import { SCORE_WEIGHTS } from '../src/core/types.js';
import { tokenize } from '../src/util/text.js';
import type { ExtractedEntities, Security, Source } from '../src/core/types.js';
import type { TaxonomyFile } from '../src/config/types.js';

/** §19. The score is an internal routing mechanism, never shown to users. */

let taxonomy: TaxonomyFile;
let securities: Security[];

beforeAll(() => {
  taxonomy = loadTaxonomy();
  securities = loadSecurityMaster();
});

function source(over: Partial<Source> = {}): Source {
  return {
    id: 'x:deltaone',
    name: 'Walter Bloomberg',
    handle: '@DeItaone',
    url: null,
    sourceType: 'x',
    category: 'MIXED',
    priority: 100,
    enabled: true,
    verified: true,
    qualityScore: 98,
    noiseScore: 2,
    macroScore: 95,
    microScore: 90,
    geopoliticalScore: 85,
    filterProfile: 'standard',
    official: false,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

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

const score = (text: string, over: Parameters<typeof scoreEvent>[0] extends infer T ? Partial<T> : never) =>
  scoreEvent({
    source: source(),
    category: 'MACRO',
    subcategory: null,
    entities: entities(),
    text,
    tokens: tokenize(text),
    factuality: { verdict: 'FACTUAL_NEWS', confidence: 0.9, signals: [] },
    noise: { isNoise: false, reason: null, confidence: 0.1, signals: [] },
    magnitudeTerms: taxonomy.magnitude,
    novelty: 100,
    corroboratingSources: 0,
    securities,
    ...(over as object),
  } as Parameters<typeof scoreEvent>[0]);

describe('bands (§19)', () => {
  it('maps totals to the specified bands', () => {
    expect(bandFor(95)).toBe('CRITICAL');
    expect(bandFor(90)).toBe('CRITICAL');
    expect(bandFor(89)).toBe('HIGH');
    expect(bandFor(75)).toBe('HIGH');
    expect(bandFor(74)).toBe('MODERATE');
    expect(bandFor(60)).toBe('MODERATE');
    expect(bandFor(59)).toBe('LOW');
    expect(bandFor(40)).toBe('LOW');
    expect(bandFor(39)).toBe('IGNORE');
  });
});

describe('weights (§19)', () => {
  it('uses exactly the specified weighting', () => {
    expect(SCORE_WEIGHTS).toEqual({
      sourceQuality: 0.2,
      marketRelevance: 0.25,
      novelty: 0.15,
      magnitude: 0.2,
      assetExposure: 0.1,
      credibility: 0.1,
    });
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('computes the total as the weighted sum of its components', () => {
    const s = score('FOMC HOLDS RATES STEADY', { category: 'FED', subcategory: 'FOMC_DECISION' });
    const expected =
      s.sourceQuality * SCORE_WEIGHTS.sourceQuality +
      s.marketRelevance * SCORE_WEIGHTS.marketRelevance +
      s.novelty * SCORE_WEIGHTS.novelty +
      s.magnitude * SCORE_WEIGHTS.magnitude +
      s.assetExposure * SCORE_WEIGHTS.assetExposure +
      s.credibility * SCORE_WEIGHTS.credibility;
    expect(s.total).toBeCloseTo(expected, 6);
  });

  it('clamps every component to 0-100', () => {
    const s = score('FOMC CUTS RATES BY 50BPS IN EMERGENCY MEETING', {
      category: 'FED',
      subcategory: 'FOMC_DECISION',
    });
    for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof typeof SCORE_WEIGHTS>) {
      expect(s[key]).toBeGreaterThanOrEqual(0);
      expect(s[key]).toBeLessThanOrEqual(100);
    }
    expect(s.total).toBeLessThanOrEqual(100);
  });
});

describe('relative ordering is what actually matters', () => {
  it('scores an emergency Fed cut above a routine regional PMI', () => {
    const fed = score('FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING', {
      category: 'FED',
      subcategory: 'FOMC_DECISION',
      source: source({ official: true, qualityScore: 100, noiseScore: 0 }),
    });
    const pmi = score('DALLAS FED MANUFACTURING INDEX -2.1 VS -1.8 PRIOR', {
      category: 'ECONOMIC',
      subcategory: 'PMI_RELEASE',
    });
    expect(fed.total).toBeGreaterThan(pmi.total);
  });

  it('scores a mega-cap event above an unknown small cap', () => {
    const nvda = score('NVIDIA ANNOUNCES MAJOR NEW AI PARTNERSHIP', {
      category: 'EQUITY',
      entities: entities({
        tickers: [{ ticker: 'NVDA', evidence: 'NAME', confidence: 0.95, matchedText: 'NVIDIA' }],
      }),
    });
    const generic = score('A SMALL COMPANY ANNOUNCES A PARTNERSHIP', { category: 'EQUITY' });
    expect(nvda.assetExposure).toBeGreaterThan(generic.assetExposure);
    expect(nvda.total).toBeGreaterThan(generic.total);
  });

  it('penalises a low-quality noisy source', () => {
    const good = score('IRAN AND US REACH AGREEMENT', { category: 'GEOPOLITICAL' });
    const poor = score('IRAN AND US REACH AGREEMENT', {
      category: 'GEOPOLITICAL',
      source: source({ id: 'x:influencer', qualityScore: 62, noiseScore: 38 }),
    });
    expect(good.sourceQuality).toBeGreaterThan(poor.sourceQuality);
    expect(good.total).toBeGreaterThan(poor.total);
  });

  it('discounts a story that five wires have already carried', () => {
    const first = score('US AND IRAN REACH DEAL', { category: 'GEOPOLITICAL', novelty: 100 });
    const fifth = score('US AND IRAN REACH DEAL', {
      category: 'GEOPOLITICAL',
      novelty: 5,
      corroboratingSources: 5,
    });
    expect(first.total).toBeGreaterThan(fifth.total);
  });

  it('raises credibility with corroboration even as novelty falls', () => {
    const alone = score('US AND IRAN REACH DEAL', { category: 'GEOPOLITICAL', corroboratingSources: 0 });
    const backed = score('US AND IRAN REACH DEAL', { category: 'GEOPOLITICAL', corroboratingSources: 4 });
    expect(backed.credibility).toBeGreaterThan(alone.credibility);
  });

  it('rates an official source as more credible than an aggregator', () => {
    const official = score('THE COMMITTEE DECIDED TO MAINTAIN THE TARGET RANGE', {
      category: 'FED',
      source: source({ id: 'rss:fed-monetary', official: true, qualityScore: 100, noiseScore: 0 }),
    });
    const relay = score('THE COMMITTEE DECIDED TO MAINTAIN THE TARGET RANGE', { category: 'FED' });
    expect(official.credibility).toBeGreaterThanOrEqual(relay.credibility);
  });
});

describe('the breakdown explains itself', () => {
  it('attaches notes for the raw channel', () => {
    const s = score('FED CUTS RATES BY 50 BPS', { category: 'FED', subcategory: 'FOMC_DECISION' });
    expect(s.notes.length).toBeGreaterThan(0);
  });
});
