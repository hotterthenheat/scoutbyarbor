import { describe, it, expect } from 'vitest';
import { extractEarnings, isEarningsPost, buildEarningsHeadline } from '../src/pipeline/classify/earnings.js';
import { classifyFiling, parseEdgarTitle, extract8kItems } from '../src/pipeline/classify/filings.js';

/**
 * §15 and §16. The spec is explicit that Scout must not settle for
 * "Apple reports earnings" when the actual numbers are in the post.
 */

const noCtx = { tickers: [], figures: [] };

describe('earnings detection', () => {
  it('recognises an earnings post', () => {
    expect(isEarningsPost('APPLE Q3 EPS $2.40 VS $2.35 EST')).toBe(true);
    expect(isEarningsPost('TESLA REPORTS THIRD QUARTER RESULTS')).toBe(true);
  });

  it('does not treat unrelated news as earnings', () => {
    expect(isEarningsPost('FED HOLDS RATES STEADY')).toBe(false);
    expect(isEarningsPost('IRAN AND US REACH AGREEMENT')).toBe(false);
  });
});

describe('parsing the real wire formats (§15)', () => {
  it('parses EPS actual vs consensus', () => {
    const d = extractEarnings({ text: 'APPLE Q3 EPS $2.40 VS $2.35 EST', ...noCtx });
    expect(d?.eps?.value).toBeCloseTo(2.4, 5);
    expect(d?.epsConsensus?.value).toBeCloseTo(2.35, 5);
    expect(d?.epsSurprise).toBe('BEAT');
  });

  it('parses revenue with a scale suffix', () => {
    const d = extractEarnings({ text: 'NVIDIA REVENUE $30.04B VS $28.7B EST', ...noCtx });
    expect(d?.revenue?.value).toBeCloseTo(30.04, 5);
    expect(d?.revenue?.scale).toBe('BILLION');
    expect(d?.revenueSurprise).toBe('BEAT');
  });

  it('parses the BLN wire spelling', () => {
    const d = extractEarnings({ text: 'REVENUE $18.12 BLN VS EST $17.80 BLN', ...noCtx });
    expect(d?.revenue?.value).toBeCloseTo(18.12, 5);
    expect(d?.revenueSurprise).toBe('BEAT');
  });

  it('detects a miss', () => {
    const d = extractEarnings({ text: 'TESLA Q3 EPS $0.62 VS $0.74 EST', ...noCtx });
    expect(d?.epsSurprise).toBe('MISS');
  });

  it('treats a match within half a percent as inline', () => {
    const d = extractEarnings({ text: 'EPS $2.00 VS $2.00 EST', ...noCtx });
    expect(d?.epsSurprise).toBe('INLINE');
  });

  it('reads a parenthesised loss as negative', () => {
    const d = extractEarnings({ text: 'Q3 EPS $(0.15) vs $(0.10) est', ...noCtx });
    expect(d?.eps?.value).toBeCloseTo(-0.15, 5);
  });

  it('never guesses a surprise without a consensus', () => {
    const d = extractEarnings({ text: 'APPLE REPORTS Q3 EPS OF $2.40', ...noCtx });
    expect(d?.eps?.value).toBeCloseTo(2.4, 5);
    expect(d?.epsSurprise).toBeNull();
  });

  it('captures forward guidance', () => {
    const d = extractEarnings({
      text: 'NVIDIA SEES Q4 REVENUE $32B-$34B VS $31.5B EST',
      ...noCtx,
    });
    expect(d?.guidance).toBeTruthy();
  });
});

describe('the earnings headline (§15)', () => {
  it('states the actual result rather than "reports earnings"', () => {
    const d = extractEarnings({ text: 'APPLE Q3 EPS $2.40 VS $2.35 EST', ...noCtx });
    const headline = buildEarningsHeadline(
      { ...(d as NonNullable<typeof d>), company: 'APPLE', ticker: 'AAPL' },
      'APPLE REPORTS EARNINGS',
    );
    expect(headline).not.toBe('APPLE REPORTS EARNINGS');
    expect(headline.toUpperCase()).toBe(headline);
    expect(headline).toMatch(/ABOVE|BEAT|EPS/);
  });

  it('falls back when there is nothing parseable', () => {
    const fallback = 'SOME COMPANY REPORTS RESULTS';
    const empty = extractEarnings({ text: 'A company will report results next week', ...noCtx });
    expect(buildEarningsHeadline(empty ?? ({} as never), fallback)).toBe(fallback);
  });
});

describe('filing materiality (§16)', () => {
  const base = {
    title: '',
    company: 'ACME CORP',
    ticker: null,
    cik: '0001234567',
    filedAt: '2026-08-09T18:31:00.000Z',
    accessionNumber: '0001234567-26-000123',
  };

  it('rates a bankruptcy filing CRITICAL', () => {
    expect(classifyFiling({ ...base, form: '8-K', items: ['1.03'] }).materiality).toBe('CRITICAL');
  });

  it('rates a restatement CRITICAL', () => {
    expect(classifyFiling({ ...base, form: '8-K', items: ['4.02'] }).materiality).toBe('CRITICAL');
  });

  it('rates an activist 13D CRITICAL', () => {
    expect(classifyFiling({ ...base, form: 'SC 13D', items: [] }).materiality).toBe('CRITICAL');
  });

  it('rates results of operations HIGH', () => {
    expect(classifyFiling({ ...base, form: '8-K', items: ['2.02'] }).materiality).toBe('HIGH');
  });

  it('rates a routine 10-Q MEDIUM so it does not alert', () => {
    const m = classifyFiling({ ...base, form: '10-Q', items: [] }).materiality;
    expect(['MEDIUM', 'LOW']).toContain(m);
  });

  it('rates a passive 13G below the alert bar', () => {
    const m = classifyFiling({ ...base, form: 'SC 13G', items: [] }).materiality;
    expect(['LOW', 'MEDIUM', 'IGNORE']).toContain(m);
  });

  it('ignores administrative forms', () => {
    for (const form of ['CORRESP', 'UPLOAD', 'NT 10-K', 'EFFECT']) {
      expect(classifyFiling({ ...base, form, items: [] }).materiality).toBe('IGNORE');
    }
  });

  it('explains the decision', () => {
    expect(
      classifyFiling({ ...base, form: '8-K', items: ['1.03'] }).materialitySignals.length,
    ).toBeGreaterThan(0);
  });
});

describe('EDGAR parsing', () => {
  it('parses an atom title', () => {
    const p = parseEdgarTitle('8-K - NVIDIA CORP (0001045810) (Filer)');
    expect(p?.form).toBe('8-K');
    expect(p?.company).toContain('NVIDIA');
    expect(p?.cik).toBe('0001045810');
  });

  it('extracts 8-K item numbers from filing text', () => {
    const items = extract8kItems('Item 5.02 Departure of Directors; Item 9.01 Financial Statements');
    expect(items).toContain('5.02');
    expect(items).toContain('9.01');
  });
});
