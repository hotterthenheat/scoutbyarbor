import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  summariseFeed,
  probeFeeds,
  formatProbeReport,
  CANDIDATES,
} from '../src/cli/probeFeeds.js';

/**
 * Feed prospecting.
 *
 * Seven primary feeds sit disabled in config, each noting that its URL returned
 * 404 or 403 and that a replacement must be verified rather than guessed. This
 * command is how one gets verified, so the property that matters is that it is
 * HONEST about what it found: a 200 carrying an HTML error page must not read
 * as a working feed, and a feed with no item timestamps must not read as usable
 * when Scout's freshness gate is measured against exactly those timestamps.
 */

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const NOW = Date.parse('2026-08-10T18:00:00Z');

function rss(items: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

describe('reading a feed', () => {
  it('counts items and ages the newest one', () => {
    const summary = summariseFeed(
      rss(`
        <item><title>A</title><pubDate>Mon, 10 Aug 2026 17:55:00 GMT</pubDate></item>
        <item><title>B</title><pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate></item>
      `),
      parser,
      NOW,
    );

    expect(summary.itemCount).toBe(2);
    expect(summary.newestAgeMinutes).toBe(5);
    expect(summary.hasTimestamps).toBe(true);
  });

  it('reads an Atom feed too, since EDGAR and the Fed publish Atom', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>X</title><updated>2026-08-10T17:30:00Z</updated></entry></feed>`;
    const summary = summariseFeed(atom, parser, NOW);

    expect(summary.itemCount).toBe(1);
    expect(summary.newestAgeMinutes).toBe(30);
  });

  it('handles a single item, which parses as an object rather than an array', () => {
    const summary = summariseFeed(
      rss('<item><title>Only</title><pubDate>Mon, 10 Aug 2026 17:00:00 GMT</pubDate></item>'),
      parser,
      NOW,
    );
    expect(summary.itemCount).toBe(1);
  });

  /**
   * The distinction the freshness gate depends on. An authoritative publisher
   * whose feed omits dates can never clear a two-minute window, so reporting it
   * as simply "live" would be a recommendation to enable something that cannot
   * work.
   */
  it('flags a feed whose items carry no date', () => {
    const summary = summariseFeed(rss('<item><title>Undated</title></item>'), parser, NOW);

    expect(summary.itemCount).toBe(1);
    expect(summary.hasTimestamps).toBe(false);
    expect(summary.newestAgeMinutes).toBeNull();
  });

  it('finds nothing in a document that is not a feed', () => {
    expect(summariseFeed('<html><body>Not found</body></html>', parser, NOW).itemCount).toBe(0);
  });
});

function probeWith(handler: (url: string) => { status: number; body: string }) {
  return probeFeeds({
    userAgent: 'Scout test',
    timeoutMs: 1_000,
    now: () => NOW,
    fetchImpl: (async (url: string) => {
      const { status, body } = handler(String(url));
      return {
        ok: status < 400,
        status,
        text: async () => body,
      } as Response;
    }) as unknown as typeof fetch,
  });
}

describe('probing', () => {
  it('reports a live feed as usable', async () => {
    const results = await probeWith(() => ({
      status: 200,
      body: rss('<item><title>A</title><pubDate>Mon, 10 Aug 2026 17:58:00 GMT</pubDate></item>'),
    }));

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.newestAgeMinutes).toBe(2);
  });

  /**
   * The failure that looks like success. A site serving an HTML error page with
   * HTTP 200 is exactly how a dead feed passes a naive check, and it is the
   * reason the disabled sources were left visibly dead in the first place.
   */
  it('refuses to call an HTML error page a feed', async () => {
    const results = await probeWith(() => ({
      status: 200,
      body: '<!DOCTYPE html><html><body>Page not found</body></html>',
    }));

    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0]?.detail).toMatch(/HTML, not a feed/);
  });

  it('names a 403 as the publisher refusing the client', async () => {
    const results = await probeWith(() => ({ status: 403, body: '' }));
    expect(results[0]?.detail).toMatch(/refuses this client/);
  });

  it('keeps going after one candidate fails', async () => {
    let n = 0;
    const results = await probeWith(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: '' }
        : { status: 200, body: rss('<item><title>A</title><pubDate>Mon, 10 Aug 2026 17:00:00 GMT</pubDate></item>') };
    });

    expect(results[0]?.ok).toBe(false);
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
  });

  it('includes the disabled sources from config, not only the candidate list', async () => {
    const results = await probeWith(() => ({ status: 200, body: rss('') }));
    const ids = new Set(results.map((r) => r.id));

    // Every one of these is disabled in config with a dead URL.
    expect(ids.has('rss:nyfed-news')).toBe(true);
    expect(ids.has('rss:imf-news')).toBe(true);
  });
});

describe('the report', () => {
  it('separates what to enable from what is dead', async () => {
    const results = await probeWith((url) =>
      url.includes('bea')
        ? { status: 200, body: rss('<item><title>GDP</title><pubDate>Mon, 10 Aug 2026 17:59:00 GMT</pubDate></item>') }
        : { status: 404, body: '' },
    );
    const report = formatProbeReport(results);

    expect(report).toMatch(/LIVE AND USABLE \(\d+\)/);
    expect(report).toMatch(/DEAD \(\d+\)/);
    expect(report).toMatch(/Best URL per source/);
    // It recommends; it does not act.
    expect(report).toMatch(/Nothing was changed/);
  });

  it('offers alternates for the publishers whose URLs are dead', () => {
    // More than one candidate per id is the entire point: a probe run finds
    // which alternate answers rather than betting on one.
    const byId = new Map<string, number>();
    for (const c of CANDIDATES) byId.set(c.id, (byId.get(c.id) ?? 0) + 1);

    expect(byId.get('rss:bea-news')).toBeGreaterThan(1);
    expect(byId.get('rss:treasury-press')).toBeGreaterThan(1);
    expect(byId.get('rss:nyfed-news')).toBeGreaterThan(1);
  });
});
