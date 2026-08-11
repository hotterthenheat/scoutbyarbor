import { describe, it, expect } from 'vitest';
import { createFinnhubAdapter, categoryOf, orgFor } from '../src/ingest/adapters/finnhub.js';
import { attributionFrom, provenanceOf } from '../src/core/provenance.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { loadSourcesFile, toSource } from '../src/config/loader.js';
import type { Source } from '../src/core/types.js';

/**
 * Finnhub: polled market news.
 *
 * The property that matters most is attribution. Finnhub is a TRANSPORT — every
 * item names the outlet that actually reported it — so crediting the story to
 * "Finnhub" would name the pipe rather than the reporter, and would make CNBC
 * and Reuters reporting one story look like one source reporting twice.
 *
 * The second property is publication time. `datetime` is a real timestamp from
 * the publisher, so the freshness gate works normally; an item without one gets
 * null rather than the moment Scout happened to fetch it.
 */

setLogLevel('silent');
const log = createLogger('finnhub-test');

const SOURCE: Source = {
  ...toSource(
    {
      id: 'finnhub:general',
      name: 'Finnhub — Market News',
      sourceType: 'finnhub',
      category: 'MARKET',
      priority: 82,
      enabled: true,
      qualityScore: 78,
      noiseScore: 45,
    },
    new Date().toISOString(),
  ),
};

/** The shape the API documents. */
function item(over: Record<string, unknown> = {}) {
  return {
    category: 'top news',
    datetime: Math.floor(Date.now() / 1000) - 120,
    headline: 'Fed cuts rates by 50 basis points',
    id: 7123456,
    related: '',
    source: 'CNBC',
    summary: 'The Federal Reserve lowered its benchmark rate by half a point.',
    url: 'https://www.cnbc.com/2026/08/10/fed.html',
    ...over,
  };
}

function adapterReturning(body: unknown, status = 200) {
  const calls: string[] = [];
  const adapter = createFinnhubAdapter({
    apiKey: 'test-key',
    timeoutMs: 5_000,
    logger: log,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch,
  });
  return { adapter, calls };
}

describe('reading the feed', () => {
  it('turns an item into a post with the publisher as the author', async () => {
    const { adapter } = adapterReturning([item()]);
    const result = await adapter.poll([SOURCE]);

    expect(result.posts).toHaveLength(1);
    const post = result.posts[0]!;
    // The outlet that reported it. Never "Finnhub".
    expect(post.author).toBe('CNBC');
    expect(post.text).toContain('Fed cuts rates by 50 basis points');
    expect(post.sourcePostId).toBe('finnhub:7123456');
    expect(post.originalUrl).toBe('https://www.cnbc.com/2026/08/10/fed.html');
    expect(result.outcomes[0]?.ok).toBe(true);
  });

  it('puts the headline first, because the normalizer reads line one as one', async () => {
    const { adapter } = adapterReturning([item()]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;
    expect(post.text.split('\n')[0]).toBe('Fed cuts rates by 50 basis points');
  });

  it('reads the publisher timestamp as publication time', async () => {
    // Relative to now, not a fixed date: the adapter drops items older than its
    // cold-start window, so a hard-coded timestamp makes this pass in the
    // morning and fail in the afternoon.
    const whenMs = Date.now() - 4 * 60_000;
    const when = Math.floor(whenMs / 1000);
    const { adapter } = adapterReturning([item({ datetime: when })]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.meta.publishedAt).toBe(new Date(when * 1000).toISOString());
    expect(post.meta.publishedAtKnown).toBe(true);
  });

  it('leaves publication time null when the item has none', async () => {
    // Receipt time is never promoted. Null is a correct answer; a fabricated
    // timestamp would defeat the freshness gate silently.
    const { adapter } = adapterReturning([item({ datetime: 0 })]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    expect(post.meta.publishedAt).toBeNull();
    expect(post.meta.publishedAtKnown).toBe(false);
  });

  it('does not re-emit an item it has already seen', async () => {
    // The endpoint is a rolling window and repeats its overlap every poll.
    const { adapter } = adapterReturning([item(), item({ id: 999, headline: 'ECB holds' })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(2);
    expect((await adapter.poll([SOURCE])).posts, 'the window was re-emitted').toHaveLength(0);
  });

  it('drops items older than the cold-start window', async () => {
    const old = Math.floor((Date.now() - 6 * 3600_000) / 1000);
    const { adapter } = adapterReturning([item({ datetime: old })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(0);
  });

  it('skips an item with no headline rather than emitting an empty event', async () => {
    const { adapter } = adapterReturning([item({ headline: '   ' })]);
    expect((await adapter.poll([SOURCE])).posts).toHaveLength(0);
  });
});

describe('failures are reported, never swallowed', () => {
  it('says plainly when the key is rejected', async () => {
    const { adapter } = adapterReturning([], 401);
    const result = await adapter.poll([SOURCE]);

    expect(result.outcomes[0]?.ok).toBe(false);
    // A bad key is not a transient blip and retrying will not fix it.
    expect(result.outcomes[0]?.error).toMatch(/rejected the API key/i);
    expect(result.outcomes[0]?.error).toMatch(/FINNHUB_API_KEY/);
  });

  it('names a rate limit as a rate limit', async () => {
    const { adapter } = adapterReturning([], 429);
    expect((await adapter.poll([SOURCE])).outcomes[0]?.error).toMatch(/rate limit/i);
  });

  it('does not throw out of poll when the body is not an array', async () => {
    const { adapter } = adapterReturning({ error: 'nope' });
    const result = await adapter.poll([SOURCE]);
    expect(result.outcomes[0]?.ok).toBe(false);
    expect(result.posts).toHaveLength(0);
  });
});

describe('the category rides in the source id', () => {
  it.each([
    ['finnhub:general', 'general'],
    ['finnhub:merger', 'merger'],
    ['finnhub:forex', 'forex'],
    ['finnhub:crypto', 'crypto'],
    ['finnhub:nonsense', 'general'],
  ])('%s → %s', (id, expected) => {
    expect(categoryOf(id)).toBe(expected);
  });

  it('requests the category the source names', async () => {
    const { adapter, calls } = adapterReturning([]);
    await adapter.poll([{ ...SOURCE, id: 'finnhub:merger' }]);
    expect(calls[0]).toContain('category=merger');
  });
});

/**
 * The corroboration question. An aggregator that carries fifty outlets must
 * not collapse them into one identity, or every story it relays would count as
 * the same source repeating itself.
 */
describe('provenance names the outlet, not the aggregator', () => {
  it('labels the publisher and records the aggregator as a carrier', async () => {
    const { adapter } = adapterReturning([item({ source: 'Reuters' })]);
    const post = (await adapter.poll([SOURCE])).posts[0]!;

    const attribution = attributionFrom({
      sourceId: post.sourceId,
      sourceName: 'Finnhub — Market News',
      author: post.author,
      meta: post.meta,
    });

    expect(attribution.label).toBe('Reuters');
    expect(attribution.label).not.toMatch(/finnhub/i);
    expect(attribution.relayedBy).toBe('Finnhub — Market News');
    expect(attribution.org).toBe('reuters');
  });

  it('counts two outlets on one story as TWO confirmations', async () => {
    const { adapter } = adapterReturning([
      item({ id: 1, source: 'Reuters' }),
      item({ id: 2, source: 'CNBC', headline: 'Fed cuts rates by half a point' }),
    ]);
    const posts = (await adapter.poll([SOURCE])).posts;

    const p = provenanceOf(
      posts.map((post) =>
        attributionFrom({ sourceId: post.sourceId, author: post.author, meta: post.meta }),
      ),
    );

    expect(p.confirmedBy, 'two outlets collapsed into one identity').toBe(2);
    expect(p.corroborated).toBe(true);
  });

  it('counts the SAME outlet twice as one confirmation', async () => {
    const { adapter } = adapterReturning([
      item({ id: 3, source: 'CNBC' }),
      item({ id: 4, source: 'CNBC', headline: 'Fed lowers benchmark rate' }),
    ]);
    const posts = (await adapter.poll([SOURCE])).posts;

    const p = provenanceOf(
      posts.map((post) =>
        attributionFrom({ sourceId: post.sourceId, author: post.author, meta: post.meta }),
      ),
    );
    expect(p.confirmedBy).toBe(1);
    expect(p.corroborated).toBe(false);
  });

  it('normalises an outlet name into a stable identity', () => {
    expect(orgFor('The Wall Street Journal')).toBe('thewallstreetjournal');
    expect(orgFor('CNBC')).toBe(orgFor('cnbc'));
    expect(orgFor(null)).toBeNull();
  });
});

describe('the shipped configuration', () => {
  it('registers the Finnhub sources with a strict filter profile', () => {
    const byId = new Map(loadSourcesFile().sources.map((s) => [s.id, s]));

    const general = byId.get('finnhub:general');
    expect(general?.sourceType).toBe('finnhub');
    expect(general?.enabled).toBe(true);
    // An aggregator carries commentary alongside reporting, so the factuality
    // gate has to pass before anything reaches the wire.
    expect(general?.filterProfile).toBe('strict');

    expect(byId.get('finnhub:merger')?.enabled).toBe(true);
    // High-volume, low-signal for an equities desk: present but off.
    expect(byId.get('finnhub:crypto')?.enabled).toBe(false);
  });

  it('does not require a url, unlike an rss source', () => {
    // The loader enforces urls for rss/edgar; a finnhub source addresses its
    // endpoint by category instead, and must not be rejected for having none.
    expect(() => loadSourcesFile()).not.toThrow();
  });
});
