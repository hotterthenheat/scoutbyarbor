import { describe, it, expect, beforeAll } from 'vitest';
import { loadSecurityMaster } from '../src/config/loader.js';
import { createTickerExtractor } from '../src/pipeline/extract/tickers.js';
import type { Security } from '../src/core/types.js';

/**
 * §25. The previous system turned ordinary words into tickers; these tests exist
 * so that cannot happen again. Every case here is either named in the spec or is
 * the same class of mistake.
 */

let securities: Security[];
let extract: (text: string, meta?: Record<string, unknown>) => ReturnType<
  ReturnType<typeof createTickerExtractor>['extract']
>;

beforeAll(() => {
  securities = loadSecurityMaster();
  const ex = createTickerExtractor({ securities });
  extract = (text, meta) => ex.extract(text, meta);
});

const tickersIn = (text: string, meta?: Record<string, unknown>): string[] =>
  extract(text, meta).map((t) => t.ticker);

describe('security master', () => {
  it('covers the priority universe from §12', () => {
    const required = [
      'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD',
      'NFLX', 'ORCL', 'MU', 'PLTR', 'CRM', 'INTC', 'JPM', 'BAC', 'GS', 'MS',
      'WMT', 'COST', 'XOM', 'CVX',
    ];
    const have = new Set(securities.map((s) => s.ticker));
    expect(required.filter((t) => !have.has(t))).toEqual([]);
  });

  it('classifies word-colliding symbols as ambiguous or blocked', () => {
    const byTicker = new Map(securities.map((s) => [s.ticker, s]));
    for (const t of ['META', 'ALL', 'CAT', 'KEY']) {
      const sec = byTicker.get(t);
      if (sec) expect(sec.ambiguity, `${t} must not be 'safe'`).not.toBe('safe');
    }
    for (const t of ['F', 'T', 'X', 'C', 'A']) {
      const sec = byTicker.get(t);
      if (sec) expect(sec.ambiguity, `${t} must be blocked`).toBe('blocked');
    }
  });
});

describe('the META-ANALYSIS guard (§25)', () => {
  it('does not extract META from META-ANALYSIS', () => {
    expect(tickersIn('A new META-ANALYSIS of inflation expectations')).not.toContain('META');
  });

  it('does not extract META from a lowercase meta-analysis', () => {
    expect(tickersIn('Researchers published a meta-analysis of the data')).not.toContain('META');
  });

  it('does extract META from a cashtag', () => {
    expect(tickersIn('$META announces new datacenter buildout')).toContain('META');
  });

  it('does extract META from the company name', () => {
    expect(tickersIn('Meta Platforms announces a new datacenter buildout')).toContain('META');
  });
});

describe('all-caps newswire text (§25)', () => {
  it('does not turn every capitalised token into a ticker', () => {
    const found = tickersIn('BREAKING: ALL EYES ON THE FED AS KEY DATA LANDS AT THE OPEN');
    // ALL, KEY, OPEN and ON are all real tickers; none of them is the subject here.
    expect(found).not.toContain('ALL');
    expect(found).not.toContain('KEY');
    expect(found).not.toContain('OPEN');
    expect(found).not.toContain('ON');
  });

  it('still extracts an unambiguous symbol from an all-caps headline', () => {
    expect(tickersIn('NVDA REPORTS Q3 REVENUE ABOVE ESTIMATES')).toContain('NVDA');
  });

  it('extracts a company name from an all-caps headline', () => {
    expect(tickersIn('NVIDIA ANNOUNCES MAJOR NEW AI PARTNERSHIP')).toContain('NVDA');
  });
});

describe('single and double letter tickers never bare-match', () => {
  it('ignores F in ordinary prose', () => {
    expect(tickersIn('The report was graded F by analysts')).not.toContain('F');
  });

  it('ignores common two-letter acronyms', () => {
    const found = tickersIn('THE US AND EU AGREE ON AI RULES');
    expect(found).not.toContain('US');
    expect(found).not.toContain('EU');
    expect(found).not.toContain('AI');
  });

  it('accepts a blocked ticker via cashtag', () => {
    expect(tickersIn('$F cuts EV production targets')).toContain('F');
  });

  it('accepts a blocked ticker via company name', () => {
    expect(tickersIn('Ford Motor cuts EV production targets')).toContain('F');
  });
});

describe('economic acronyms are never tickers', () => {
  it.each(['CPI', 'PPI', 'PCE', 'GDP', 'NFP', 'FOMC', 'ISM', 'PMI', 'ADP', 'CEO', 'ETF', 'SEC'])(
    'does not treat %s as a ticker',
    (acronym) => {
      expect(tickersIn(`${acronym} data came in above expectations`)).not.toContain(acronym);
    },
  );
});

describe('name resolution (§25)', () => {
  it('resolves the corporate-suffix variants to one ticker', () => {
    for (const form of ['NVIDIA', 'Nvidia Corp.', 'NVIDIA Corporation', '$NVDA', 'NVDA']) {
      expect(tickersIn(`${form} announced a partnership`), form).toContain('NVDA');
    }
  });

  it('resolves Alphabet and Google to GOOGL', () => {
    expect(tickersIn('Alphabet Inc. reported quarterly results')).toContain('GOOGL');
  });

  it('reports the evidence that produced each match', () => {
    const matches = extract('$AAPL and Microsoft Corporation announced a deal');
    const aapl = matches.find((m) => m.ticker === 'AAPL');
    const msft = matches.find((m) => m.ticker === 'MSFT');
    expect(aapl?.evidence).toBe('CASHTAG');
    expect(msft?.evidence === 'NAME' || msft?.evidence === 'ALIAS').toBe(true);
  });

  it('does not match a possessive or plural of an ambiguous symbol', () => {
    expect(tickersIn('The METAS of the industry disagree')).not.toContain('META');
  });
});

describe('provider metadata', () => {
  it('trusts adapter-supplied cashtags', () => {
    expect(tickersIn('Quarterly results are out', { cashtags: ['AAPL'] })).toContain('AAPL');
  });
});
