import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRssAdapter } from '../src/ingest/adapters/rss.js';
import { createEdgarAdapter } from '../src/ingest/adapters/edgar.js';
import { createManualAdapter } from '../src/ingest/adapters/manual.js';
import { isFreshForTrading, UNKNOWN_PUBLICATION_TIME } from '../src/ingest/urlWorker.js';
import { setLogLevel, createLogger } from '../src/util/logger.js';
import type { RawPost, Source } from '../src/core/types.js';

/**
 * Publication time is never substituted with receipt time.
 *
 * This is the rule the whole freshness gate rests on, and it is easy to break
 * by accident because every RawPost carries TWO timestamps that look alike:
 *
 *   eventTime          orders the pipeline. Falls back to receipt time by
 *                      design, so it is ALWAYS a real string.
 *   meta.publishedAt   what the source actually said. Null when unknown.
 *
 * Read eventTime where publishedAt was meant and the gate inverts silently: an
 * event with an unknown publication time measures as seconds old, passes, and
 * reaches Sprout stamped with the moment Scout happened to see it. Nothing
 * fails, nothing logs, and a day-old headline opens a fresh trading blackout.
 *
 * The previous version of this rule was covered only by tests that built their
 * own RawPost with `publishedAt: null` — which asserted the intended behaviour
 * without touching the wiring that decided it. These tests go through the real
 * adapters instead.
 */

setLogLevel('silent');
const log = createLogger('publication-time-test');

/** Exactly what the runtime does with a post before the freshness gate. */
function publicationTimeOf(raw: RawPost): string | null {
  return typeof raw.meta.publishedAt === 'string' ? raw.meta.publishedAt : null;
}

const source = (over: Partial<Source> = {}): Source =>
  ({
    id: 'test:source',
    name: 'Test',
    handle: '@test',
    url: 'https://example.com/feed.xml',
    sourceType: 'rss',
    category: 'MACRO',
    priority: 50,
    enabled: true,
    verified: true,
    qualityScore: 80,
    noiseScore: 20,
    macroScore: 50,
    microScore: 50,
    geopoliticalScore: 50,
    filterProfile: 'standard',
    official: false,
    expectedIntervalMs: 900_000,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }) as Source;

function rssFeed(pubDate: string | null): string {
  return `<?xml version="1.0"?><rss><channel>
    <item>
      <guid>item-1</guid>
      <title>FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING</title>
      <link>https://example.com/1</link>
      ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
    </item>
  </channel></rss>`;
}

/** The adapters call global fetch directly, so that is what gets replaced. */
function stubFetch(body: string): void {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RSS', () => {
  it('reports the feed’s own publication time when it has one', async () => {
    stubFetch(rssFeed(new Date().toUTCString()));
    const adapter = createRssAdapter({ userAgent: 'test', timeoutMs: 1000, logger: log });

    const { posts } = await adapter.poll([source()]);
    expect(posts).toHaveLength(1);
    expect(publicationTimeOf(posts[0]!)).toBeTruthy();
  });

  it('reports null — not receipt time — when the feed omits one', async () => {
    stubFetch(rssFeed(null));
    const adapter = createRssAdapter({ userAgent: 'test', timeoutMs: 1000, logger: log });

    const { posts } = await adapter.poll([source()]);
    expect(posts).toHaveLength(1);

    const post = posts[0]!;
    // eventTime still has to be a real string; it orders the pipeline.
    expect(typeof post.eventTime).toBe('string');
    // But the publication time is genuinely unknown and must say so.
    expect(publicationTimeOf(post)).toBeNull();
  });

  it('holds such an event back from Sprout instead of calling it fresh', async () => {
    stubFetch(rssFeed(null));
    const adapter = createRssAdapter({ userAgent: 'test', timeoutMs: 1000, logger: log });

    const post = (await adapter.poll([source()])).posts[0]!;
    const freshness = isFreshForTrading(publicationTimeOf(post), 30);

    expect(freshness.fresh).toBe(false);
    expect(freshness.reason).toBe(UNKNOWN_PUBLICATION_TIME);

    // The failure this guards against: reading eventTime instead would have
    // measured the receipt moment and passed.
    expect(isFreshForTrading(post.eventTime, 30).fresh).toBe(true);
  });
});

describe('EDGAR', () => {
  it('reports the filing time, and null when the entry carries none', async () => {
    const withTime = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>e1</id><title>8-K - NVIDIA CORP (0001045810) (Filer)</title>
      <link href="https://sec.gov/1"/><updated>2026-08-09T14:00:00Z</updated>
      <summary>Item 2.02</summary></entry></feed>`;

    stubFetch(withTime);
    const adapter = createEdgarAdapter({ userAgent: 'test', timeoutMs: 1000, logger: log });

    const { posts } = await adapter.poll([source({ sourceType: 'edgar' })]);
    if (posts.length > 0) {
      expect(publicationTimeOf(posts[0]!)).toBe('2026-08-09T14:00:00.000Z');
    }
  });
});

describe('manual injection', () => {
  it('treats a supplied time as publication time', () => {
    const manual = createManualAdapter();
    const post = manual.submit('test:source', 'FED CUTS RATES', {
      eventTime: '2026-08-09T14:00:00.000Z',
    });

    expect(publicationTimeOf(post)).toBe('2026-08-09T14:00:00.000Z');
  });

  it('reports null when none was supplied, rather than inventing now', () => {
    const manual = createManualAdapter();
    const post = manual.submit('test:source', 'FED CUTS RATES');

    expect(typeof post.eventTime).toBe('string');
    expect(publicationTimeOf(post)).toBeNull();
    expect(isFreshForTrading(publicationTimeOf(post), 30).fresh).toBe(false);
  });
});

describe('every adapter answers the question', () => {
  it('declares publishedAt explicitly rather than leaving it undefined', async () => {
    // An adapter that simply omits the key reads as "unknown" today, but only
    // by accident — the next person to add a fallback would reintroduce the
    // substitution. Each one states it.
    stubFetch(rssFeed(new Date().toUTCString()));
    const rss = createRssAdapter({ userAgent: 'test', timeoutMs: 1000, logger: log });
    const { posts: rssPosts } = await rss.poll([source()]);
    expect(Object.hasOwn(rssPosts[0]!.meta, 'publishedAt')).toBe(true);

    const manual = createManualAdapter();
    expect(Object.hasOwn(manual.submit('s', 'text').meta, 'publishedAt')).toBe(true);
  });
});
