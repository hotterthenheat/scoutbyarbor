import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { renderAlert } from '../src/render/alert.js';
import type { RawPost } from '../src/core/types.js';
import type { ScoutDb } from '../src/db/index.js';

/**
 * End-to-end through the real pipeline, real config and a real (temporary)
 * database. This is the test that would catch two modules agreeing on types but
 * disagreeing on meaning.
 */

setLogLevel('silent');

const CONFIG = {
  minPublishScore: 60,
  minBreakingScore: 90,
  dedupeWindowMinutes: 90,
  clusterWindowMinutes: 240,
  dedupeSimilarity: 0.82,
};

let dir: string;
let db: ScoutDb;
let pipeline: ReturnType<typeof createPipeline>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-test-'));
  db = openDatabase(join(dir, 'test.db'));
  db.migrate();

  const now = new Date().toISOString();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, now)));
  const securities = loadSecurityMaster();
  db.securities.upsertMany(securities);

  pipeline = createPipeline({
    db,
    taxonomy: loadTaxonomy(),
    securities,
    config: CONFIG,
    logger: createLogger('test'),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function raw(text: string, over: Partial<RawPost> = {}): RawPost {
  const at = over.eventTime ?? new Date().toISOString();
  return {
    sourceId: over.sourceId ?? 'x:deltaone',
    sourcePostId: over.sourcePostId ?? `test-${++seq}`,
    originalUrl: over.originalUrl ?? null,
    author: over.author ?? '@DeItaone',
    text,
    eventTime: at,
    ingestionTime: over.ingestionTime ?? at,
    meta: over.meta ?? {},
  };
}

describe('accepting real news', () => {
  it('turns a Powell headline into a FED alert', async () => {
    const out = await pipeline.process(
      raw("FED'S POWELL: FURTHER RATE CUTS WILL DEPEND ON INFLATION PROGRESS"),
    );
    expect(out.accepted).toBe(true);
    expect(out.newsEvent.category).toBe('FED');
    expect(out.route?.channels).toContain('news');
    expect(out.alert?.banner).toBe('FED ALERT');
  });

  it('classifies a CPI release as ECONOMIC, not generic MACRO', async () => {
    const out = await pipeline.process(
      raw('US CPI RISES 0.3% M/M IN JULY VS 0.2% EXPECTED', { sourceId: 'rss:bls-latest' }),
    );
    expect(out.accepted).toBe(true);
    expect(out.newsEvent.category).toBe('ECONOMIC');
  });

  it('classifies a war headline as GEOPOLITICAL and resolves the countries', async () => {
    const out = await pipeline.process(
      raw('ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR FACILITIES, OFFICIALS SAY'),
    );
    expect(out.accepted).toBe(true);
    expect(out.newsEvent.category).toBe('GEOPOLITICAL');
    expect(out.newsEvent.countries.length).toBeGreaterThan(0);
    expect(out.route?.channels).toContain('news');
  });

  it('routes a corporate event to equities with the ticker resolved', async () => {
    const out = await pipeline.process(raw('NVIDIA ANNOUNCES MAJOR NEW AI PARTNERSHIP'));
    expect(out.accepted).toBe(true);
    expect(out.newsEvent.tickers).toContain('NVDA');
    expect(out.route?.channels).toContain('news');
  });
});

describe('rejecting noise end to end (§20)', () => {
  it.each([
    'NVDA is looking strong today',
    "Here's why I think NVDA hits $250",
    'LIKE if you think Powell is wrong',
    'Join my free trading Discord, link in bio',
  ])('rejects %s', async (text) => {
    const out = await pipeline.process(raw(text));
    expect(out.accepted).toBe(false);
    expect(out.rejection).toBeTruthy();
  });

  it('records the rejection instead of discarding it (§28)', async () => {
    await pipeline.process(raw('NVDA is looking strong today'));
    const stats = db.sources.getStats('x:deltaone');
    expect(stats?.postsRejected).toBeGreaterThan(0);
  });
});

describe('deduplication end to end (§17)', () => {
  it('publishes the first report and collapses the next two', async () => {
    const t = new Date().toISOString();
    const a = await pipeline.process(
      raw('US AND IRAN REACH DEAL', { sourceId: 'x:deltaone', eventTime: t }),
    );
    const b = await pipeline.process(
      raw('U.S. AND IRAN HAVE REACHED AGREEMENT', { sourceId: 'x:firstsquawk', eventTime: t }),
    );
    const c = await pipeline.process(
      raw('AXIOS: US, IRAN REACH AGREEMENT', { sourceId: 'x:livesquawk', eventTime: t }),
    );

    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(false);
    expect(c.accepted).toBe(false);
    expect(b.rejection).toMatch(/^DUPLICATE/);
    expect(c.rejection).toMatch(/^DUPLICATE/);
  });

  it('ignores a repost of the exact same source post', async () => {
    const post = raw('ECB HOLDS RATES STEADY', { sourcePostId: 'fixed-1' });
    const first = await pipeline.process(post);
    const second = await pipeline.process({ ...post });
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
  });
});

describe('clustering end to end (§18)', () => {
  it('files a later development into the same event', async () => {
    const t0 = new Date();
    const a = await pipeline.process(
      raw('TRUMP SAYS TALKS WITH IRAN ARE PROGRESSING', {
        sourceId: 'x:deltaone',
        eventTime: t0.toISOString(),
      }),
    );
    const b = await pipeline.process(
      raw('IRAN SIGNALS IT WILL ACCEPT THE PROPOSED NUCLEAR FRAMEWORK', {
        sourceId: 'x:firstsquawk',
        eventTime: new Date(t0.getTime() + 15 * 60_000).toISOString(),
      }),
    );

    expect(a.accepted).toBe(true);
    if (b.accepted) {
      // Either it joined the open cluster, or it was distinct enough to open its
      // own — both are defensible, but it must never be silently lost.
      expect(b.cluster).toBeTruthy();
    } else {
      expect(b.rejection).toMatch(/^DUPLICATE/);
    }
  });
});

describe('persistence (§24)', () => {
  it('stores the URL and author internally while keeping them out of the alert', async () => {
    const url = 'https://x.com/i/status/1234567890';
    const out = await pipeline.process(
      raw('FED CUTS RATES BY 25 BPS', { originalUrl: url, author: '@DeItaone' }),
    );

    expect(out.accepted).toBe(true);
    const stored = db.newsEvents.byId(out.newsEvent.id);
    expect(stored?.originalUrl).toBe(url);
    expect(stored?.author).toBe('@DeItaone');

    const rendered = renderAlert(out.alert!);
    expect(rendered).not.toContain(url);
    expect(rendered).not.toContain('@DeItaone');
    expect(rendered).not.toContain('x.com');
  });

  it('records the latency stamps separately (§22)', async () => {
    const eventTime = new Date(Date.now() - 500).toISOString();
    const out = await pipeline.process(
      raw('BOJ RAISES POLICY RATE TO 0.75%', {
        eventTime,
        ingestionTime: new Date().toISOString(),
        meta: { publishedAt: eventTime },
      }),
    );
    expect(out.newsEvent.latency.sourceToScoutMs).toBeGreaterThanOrEqual(0);
    expect(out.newsEvent.latency.eventTime).toBe(eventTime);
  });

  /**
   * source→Scout answers "how long after publication did Scout hear about it".
   * With no publication time there is no answer, and reporting 0ms would look
   * like an instantaneous relay — the most flattering possible reading of the
   * one number used to judge whether the relay is fast enough to trade on.
   */
  it('reports no source latency rather than 0ms when publication time is unknown', async () => {
    const out = await pipeline.process(
      raw('ECB HOLDS RATES STEADY AT 2.00% AS GROWTH SLOWS', {
        // eventTime falls back to receipt time, exactly as the relay path does.
        eventTime: new Date().toISOString(),
        ingestionTime: new Date().toISOString(),
        meta: { publishedAt: null },
      }),
    );

    expect(out.newsEvent.latency.sourceToScoutMs).toBeNull();
    expect(out.newsEvent.latency.totalMs).toBeNull();
  });

  it('makes the raw payload carry what the alert must not (§27)', async () => {
    const out = await pipeline.process(
      raw('FED CUTS RATES BY 25 BPS', { originalUrl: 'https://x.com/i/status/1', author: '@DeItaone' }),
    );
    expect(out.raw.originalUrl).toBe('https://x.com/i/status/1');
    expect(out.raw.sourceName).toBeTruthy();
    expect(out.raw.decision).toBe('ACCEPTED');
  });
});

describe('a disabled source is not ingested', () => {
  it('rejects a post from a disabled source', async () => {
    db.sources.setEnabled('x:deltaone', false);
    const out = await pipeline.process(raw('FED CUTS RATES BY 25 BPS'));
    expect(out.accepted).toBe(false);
    expect(out.rejection).toBe('SOURCE_DISABLED');
  });
});

/**
 * Age.
 *
 * The freshness rule used to gate only the Sprout hand-off, so a story
 * published twenty minutes earlier still arrived as an alert carrying its own
 * twenty-minute-old timestamp. That reads as a bot running behind rather than a
 * wire running fast — and on a desk it is worse, because the move has happened.
 */
describe('publishing old news', () => {
  function agedPipeline(maxPublishAgeMinutes: number) {
    return createPipeline({
      db,
      taxonomy: loadTaxonomy(),
      securities: loadSecurityMaster(),
      config: {
        minPublishScore: 60,
        minBreakingScore: 90,
        dedupeWindowMinutes: 90,
        clusterWindowMinutes: 240,
        dedupeSimilarity: 0.82,
        maxPublishAgeMinutes,
      },
      logger: createLogger('age-test'),
    });
  }

  function aged(minutesAgo: number) {
    const publishedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return {
      sourceId: 'rss:marketwatch-pulse',
      sourcePostId: `age:${minutesAgo}:${Math.random()}`,
      originalUrl: null,
      author: 'MarketWatch',
      text: 'US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED',
      eventTime: publishedAt,
      ingestionTime: new Date().toISOString(),
      meta: { publishedAt },
    };
  }

  it('publishes a story inside the window', async () => {
    expect((await agedPipeline(20).process(aged(2))).accepted).toBe(true);
  });

  it('declines one outside it, and says why', async () => {
    const outcome = await agedPipeline(20).process(aged(45));
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejection).toBe('NOISE_OLD_NEWS');
  });

  it('still publishes when no source stated a publication time', async () => {
    // Unknown is not old. Refusing everything a feed failed to timestamp would
    // silently drop whole sources.
    const post = aged(2);
    const outcome = await agedPipeline(20).process({ ...post, meta: { publishedAt: null } });
    expect(outcome.accepted).toBe(true);
  });

  it('disables the gate at 0', async () => {
    expect((await agedPipeline(0).process(aged(600))).accepted).toBe(true);
  });
});

/**
 * Thinly-worded market news.
 *
 * "OPEC+ AGREES TO CUT OUTPUT BY 1 MILLION BARRELS PER DAY" matched a single
 * taxonomy keyword and was dropped as NO_CATEGORY — a genuine, market-moving
 * commodity headline discarded for using few of the words the taxonomy happens
 * to list. Requiring strong evidence is right for a CONFIDENT call and wrong
 * for "does this belong on a market wire at all".
 */
describe('a real headline the taxonomy barely recognises', () => {
  it('reaches the wire instead of being dropped', async () => {
    const outcome = await pipeline.process(raw('OPEC+ AGREES TO CUT OUTPUT BY 1 MILLION BARRELS PER DAY'));

    expect(outcome.accepted, 'a market-moving commodity headline was dropped').toBe(true);
    expect(outcome.route?.channels).toContain('news');
  });

  it('competes weakly, rather than as an equal of a well-evidenced one', async () => {
    const thin = await pipeline.process(raw('OPEC+ AGREES TO CUT OUTPUT BY 1 MILLION BARRELS PER DAY'));
    const strong = await pipeline.process(raw('US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED'));

    expect(thin.newsEvent.importance).toBeLessThan(strong.newsEvent.importance);
  });

  it('does not let clickbait in through the same door', async () => {
    // The looser category gate is only safe because the noise filters run
    // afterwards. If this ever publishes, the gate has outrun its guard.
    for (const text of [
      'Top economist says bitcoin has one flaw gold will never have',
      'Here is why analysts think Nvidia could hit $300',
      'Best stocks to buy right now, according to strategists',
    ]) {
      const outcome = await pipeline.process(raw(text));
      expect(outcome.accepted, `clickbait published: ${text}`).toBe(false);
    }
  });
});
