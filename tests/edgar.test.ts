import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEdgarAdapter } from '../src/ingest/adapters/edgar.js';
import { extract8kItems, describe8kItems } from '../src/pipeline/classify/filings.js';
import { splitHeadlineAndBody } from '../src/util/text.js';
import { headlineEquivalent } from '../src/pipeline/dedupe.js';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import type { Source } from '../src/core/types.js';

/**
 * SEC EDGAR.
 *
 * 8-K filings are the highest-volume equity signal Scout has, and the source
 * had published nothing at all while reporting itself as polling perfectly.
 * Four separate faults stacked, each invisible behind the one before it, and
 * none of them reachable by a test because the adapter had no fetch seam.
 */

setLogLevel('silent');
const log = createLogger('edgar-test');

const SOURCE: Source = toSource(
  {
    id: 'edgar:8k',
    name: 'SEC EDGAR — 8-K',
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom',
    sourceType: 'edgar',
    category: 'EQUITY',
    priority: 88,
    enabled: true,
    qualityScore: 100,
    noiseScore: 0,
  },
  new Date().toISOString(),
);

/** A filing entry shaped the way SEC actually serves it. */
function atom(over: { items?: string; title?: string; updated?: string } = {}): string {
  const updated = over.updated ?? new Date(Date.now() - 60_000).toISOString();
  const title = over.title ?? '8-K - ACME CORP (0001234567) (Filer)';
  const items = over.items ?? '1.03';
  return `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
 <title>Latest Filings</title>
 <entry>
  <title>${title}</title>
  <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1234567/000123456726000123/0001234567-26-000123-index.htm"/>
  <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-08-10 &lt;b&gt;AccNo:&lt;/b&gt; 0001234567-26-000123 &lt;b&gt;Items:&lt;/b&gt; ${items}</summary>
  <updated>${updated}</updated>
  <category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
  <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000123</id>
 </entry>
</feed>`;
}

function adapterServing(xml: string) {
  return createEdgarAdapter({
    userAgent: 'ArborCapital Scout (ops@example.com)',
    timeoutMs: 5_000,
    logger: log,
    fetchImpl: (async () =>
      ({ ok: true, status: 200, statusText: 'OK', text: async () => xml }) as Response) as unknown as typeof fetch,
  });
}

/**
 * Fault 1. With `ignoreAttributes: false`, fast-xml-parser represents an
 * element carrying attributes as an object with its text under `#text`. EDGAR's
 * summary is always `<summary type="html">`, so `String()` over it produced
 * "[object Object]" — which is what every alert said, and what the item parser
 * was handed instead of the codes.
 */
describe('reading the summary', () => {
  it('reads the text of an element that carries attributes', async () => {
    const post = (await adapterServing(atom()).poll([SOURCE])).posts[0]!;
    expect(post.text).not.toContain('[object Object]');
  });

  it('recovers the item codes the summary states', async () => {
    const post = (await adapterServing(atom({ items: '1.03 2.02' })).poll([SOURCE])).posts[0]!;
    expect(post.meta.items).toEqual(['1.03', '2.02']);
  });

  it('still reads the form, company and CIK from the title', async () => {
    const post = (await adapterServing(atom()).poll([SOURCE])).posts[0]!;
    expect(post.meta.form).toBe('8-K');
    expect(post.meta.company).toBe('ACME CORP');
    expect(post.meta.cik).toBe('0001234567');
  });

  it('keeps the filing time as publication time', async () => {
    const filed = new Date(Date.now() - 120_000).toISOString();
    const post = (await adapterServing(atom({ updated: filed })).poll([SOURCE])).posts[0]!;
    expect(post.meta.publishedAt).toBe(filed);
  });
});

/**
 * Fault 2. EDGAR writes "Items: 1.03 2.02" — a colon, then SPACE-separated
 * codes. The pattern demanded whitespace straight after the word and accepted
 * only comma/semicolon/"and" between codes, so a real summary yielded nothing.
 */
describe('parsing item codes', () => {
  it('reads the colon EDGAR actually writes', () => {
    expect(extract8kItems('Items: 1.03')).toEqual(['1.03']);
  });

  it('reads space-separated codes', () => {
    expect(extract8kItems('Items: 1.03 2.02 9.01')).toEqual(['1.03', '2.02', '9.01']);
  });

  it('still reads the older comma and semicolon forms', () => {
    expect(extract8kItems('Item 5.02 Departure of Directors; Item 9.01 Financial Statements')).toEqual([
      '5.02',
      '9.01',
    ]);
    expect(extract8kItems('Items 1.01, 2.03 and 8.01')).toEqual(['1.01', '2.03', '8.01']);
  });

  it('finds nothing in a summary that states none', () => {
    expect(extract8kItems('Filed: 2026-08-10 AccNo: 0001234567-26-000123')).toEqual([]);
  });
});

/**
 * Fault 3. A filing states its event in a CODE. "Items: 1.03" is a bankruptcy,
 * and the taxonomy has no way to know that — so every filing was rejected
 * NO_CATEGORY before its materiality was ever consulted, while the parsed codes
 * sat in meta saying "bankruptcy".
 */
describe('describing a filing in words', () => {
  it('expands a code into SEC’s own description', () => {
    expect(describe8kItems(['1.03'])).toEqual(['bankruptcy or receivership']);
    expect(describe8kItems(['2.06'])).toEqual(['material impairment']);
  });

  it('ignores codes it does not recognise rather than inventing one', () => {
    expect(describe8kItems(['9.99'])).toEqual([]);
  });

  it('puts the company and the event into the post text', async () => {
    const post = (await adapterServing(atom({ items: '1.03' })).poll([SOURCE])).posts[0]!;
    expect(post.text).toBe('ACME CORP, bankruptcy or receivership');
  });
});

/**
 * Fault 4, which the fix for fault 3 introduced. Two punctuation marks that
 * read more naturally each break something upstream, and both failures are
 * silent.
 */
describe('the wording has to survive the text pipeline', () => {
  it('keeps the event in the headline for a long company name', () => {
    // An em dash would trip splitHeadlineAndBody's "<15-120 chars> — " rule,
    // leaving the company as the headline and demoting the event to the body,
    // where it classifies as nothing.
    const split = splitHeadlineAndBody('BETA INDUSTRIES, material impairment');
    expect(split.headline).toContain('MATERIAL IMPAIRMENT');
  });

  it('keeps the company, which a colon would strip as a wire tag', () => {
    // headlineEquivalent removes a short uppercase "PREFIX:" — so "ACME CORP:"
    // would read as a byline and vanish, taking the distinguishing entity.
    expect(headlineEquivalent('ACME CORP, BANKRUPTCY OR RECEIVERSHIP')).toContain('ACME CORP');
  });

  it('does not give two unrelated filings a shared vocabulary', async () => {
    // Dedupe treats shared significant tokens as entity agreement and merges
    // above a 0.4 similarity floor, so boilerplate like "files 8-K (item 1.03)"
    // on every headline collapsed all filings into whichever arrived first.
    const a = headlineEquivalent('ACME CORP, BANKRUPTCY OR RECEIVERSHIP');
    const b = headlineEquivalent('BETA INDUSTRIES, MATERIAL IMPAIRMENT');
    const tokens = (s: string) => new Set(s.split(/\s+/).filter((t) => t.length >= 3));
    const shared = [...tokens(a)].filter((t) => tokens(b).has(t));

    expect(shared, `filings share vocabulary: ${shared.join(', ')}`).toHaveLength(0);
  });
});

/**
 * The whole point: material filings reach the wire and routine ones do not.
 * §16 drops anything below CRITICAL/HIGH, and that separation is what makes
 * an 8-K feed usable rather than a firehose.
 */
describe('which filings reach the wire', () => {
  let dir: string;
  let db: ScoutDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-edgar-'));
    db = openDatabase(join(dir, 'test.db'));
    db.migrate();
    db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
    db.securities.upsertMany(loadSecurityMaster());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  async function fileIt(company: string, code: string, description: string) {
    const securities = loadSecurityMaster();
    const pipeline = createPipeline({
      db,
      taxonomy: loadTaxonomy(),
      securities,
      config: {
        minPublishScore: 60,
        minBreakingScore: 90,
        dedupeWindowMinutes: 90,
        clusterWindowMinutes: 240,
        dedupeSimilarity: 0.82,
        maxPublishAgeMinutes: 2,
      },
      logger: log,
    });
    const at = new Date(Date.now() - 20_000).toISOString();
    seq += 1;
    return pipeline.process({
      sourceId: 'edgar:8k',
      sourcePostId: `edgar-${seq}`,
      originalUrl: `https://www.sec.gov/Archives/edgar/data/${seq}/x-index.htm`,
      author: company,
      text: `${company}, ${description}`,
      eventTime: at,
      ingestionTime: new Date().toISOString(),
      meta: {
        publishedAt: at,
        form: '8-K',
        company,
        cik: `000${seq}000`,
        title: '8-K',
        items: [code],
        accessionNumber: `acc-${seq}`,
        edgar: true,
      },
    });
  }

  it.each([
    ['1.03', 'bankruptcy or receivership'],
    ['2.04', 'acceleration of a financial obligation'],
    ['2.06', 'material impairment'],
    ['4.02', 'non-reliance on previously issued financials'],
    ['5.01', 'change in control'],
    ['3.01', 'delisting or transfer of listing'],
  ])('publishes item %s (%s)', async (code, description) => {
    const outcome = await fileIt(`FILER${code.replace('.', '')} CORP`, code, description);
    expect(outcome.accepted, `a material filing was dropped: ${outcome.rejection}`).toBe(true);
  });

  it.each([
    ['5.03', 'amendment to bylaws or fiscal year'],
    ['5.07', 'submission of matters to a vote'],
    ['9.01', 'financial statements and exhibits'],
    ['7.01', 'Regulation FD disclosure'],
  ])('declines routine item %s (%s)', async (code, description) => {
    const outcome = await fileIt(`FILER${code.replace('.', '')} CORP`, code, description);
    expect(outcome.accepted, 'a routine filing reached the wire').toBe(false);
  });

  /**
   * The subject gate requires a single-name story to name a company. A filing
   * always does — EDGAR issues a CIK per registrant — but most filers are not
   * in any security master, so requiring a resolved ticker rejected every 8-K
   * for "naming no company" while holding the company's name and its CIK.
   */
  it('accepts a filer that resolves to no ticker', async () => {
    const outcome = await fileIt('PRIVATELY HELD MIDWEST HOLDINGS', '1.03', 'bankruptcy or receivership');

    expect(outcome.accepted).toBe(true);
    expect(outcome.signals.some((s) => s.includes('subject:filer CIK'))).toBe(true);
  });

  it('keeps distinct filings distinct instead of collapsing them', async () => {
    const first = await fileIt('ACME CORP', '1.03', 'bankruptcy or receivership');
    const second = await fileIt('BETA INDUSTRIES', '2.06', 'material impairment');

    expect(first.accepted).toBe(true);
    expect(second.accepted, `second filing was deduped: ${second.rejection}`).toBe(true);
  });
});
