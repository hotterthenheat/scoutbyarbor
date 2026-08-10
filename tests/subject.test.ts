import { describe, it, expect } from 'vitest';
import { identifySubject } from '../src/pipeline/classify/subject.js';
import type { Category, ExtractedEntities, ExtractedFigure } from '../src/core/types.js';

/**
 * The gate that asks "which company?".
 *
 * This exists because the wire published `38-UNIT MOE'S FRANCHISEE DECLARES
 * BANKRUPTCY` as an EQUITY ALERT. Nothing upstream was broken: "bankruptcy" is
 * a real materiality term and the impact assessor correctly reported no market
 * relevance. The event cleared the score bar by under a point because no stage
 * was responsible for noticing that the alert named no issuer at all.
 */

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

function usd(value: number): ExtractedFigure {
  return { kind: 'CURRENCY', raw: `$${value}`, value, unit: 'USD', label: null };
}

describe('single-name categories need a name', () => {
  const SINGLE_NAME: Category[] = ['EQUITY', 'EARNINGS', 'OPTIONS'];

  it.each(SINGLE_NAME)('rejects a %s event that identifies nobody', (category) => {
    const verdict = identifySubject({ category, entities: entities() });

    expect(verdict.identified).toBe(false);
    expect(verdict.reason).toMatch(/subject:none/);
  });

  it('accepts one carrying a resolved ticker', () => {
    const verdict = identifySubject({
      category: 'EQUITY',
      entities: entities({
        tickers: [{ ticker: 'AAPL', evidence: 'NAME', confidence: 0.95, matchedText: 'Apple' }],
      }),
    });

    expect(verdict.identified).toBe(true);
    expect(verdict.reason).toContain('AAPL');
  });

  it('accepts one naming an institution the taxonomy knows', () => {
    const verdict = identifySubject({
      category: 'EQUITY',
      entities: entities({ organizations: ['BOEING'] }),
    });

    expect(verdict.identified).toBe(true);
    expect(verdict.reason).toContain('BOEING');
  });
});

/**
 * A hard "resolvable issuer or nothing" rule would drop the private-company
 * failures that actually move credit — those companies are absent from every
 * security master by definition. Size is what separates them from a local
 * franchisee, and the size is normally stated in the headline.
 */
describe('the scale escape hatch', () => {
  it('lets an unnamed subject through when the text sizes it', () => {
    const verdict = identifySubject({
      category: 'EQUITY',
      entities: entities({ figures: [usd(10_000_000_000)] }),
    });

    expect(verdict.identified).toBe(true);
    expect(verdict.reason).toMatch(/unnamed but sized \$10B/);
  });

  it('does not open on a figure below the materiality floor', () => {
    const verdict = identifySubject({
      category: 'EQUITY',
      entities: entities({ figures: [usd(4_000_000)] }),
    });

    expect(verdict.identified).toBe(false);
  });

  it('ignores non-currency figures, which size nothing', () => {
    // "38-unit" is a count, and a count is exactly what the Moe's headline had.
    const verdict = identifySubject({
      category: 'EQUITY',
      entities: entities({
        figures: [{ kind: 'COUNT', raw: '38', value: 38, unit: null, label: null }],
      }),
    });

    expect(verdict.identified).toBe(false);
  });
});

/**
 * The gate must not touch categories that describe conditions rather than
 * companies. "US STRIKES HOUTHI TARGETS" names no issuer and never will.
 */
describe('categories the gate leaves alone', () => {
  const BROAD: Category[] = ['MACRO', 'FED', 'ECONOMIC', 'GEOPOLITICAL', 'MARKET', 'COMMODITY', 'CRYPTO'];

  it.each(BROAD)('passes a %s event with no entities at all', (category) => {
    expect(identifySubject({ category, entities: entities() }).identified).toBe(true);
  });
});
