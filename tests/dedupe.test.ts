import { describe, it, expect } from 'vitest';
import { detectDuplicate, canonicalizeUrl } from '../src/pipeline/dedupe.js';
import { normalizePost } from '../src/pipeline/normalize.js';
import type { RawPost } from '../src/core/types.js';

/**
 * §17. The same event arriving through DeltaOne, FirstSquawk, Reuters,
 * Bloomberg, FinancialJuice and AP must become ONE event, not six alerts.
 */

const NOW = '2026-05-24T21:14:00.000Z';

function post(text: string, opts: Partial<RawPost> = {}) {
  return normalizePost({
    sourceId: opts.sourceId ?? 'x:deltaone',
    sourcePostId: opts.sourcePostId ?? 'p1',
    originalUrl: opts.originalUrl ?? null,
    author: null,
    text,
    eventTime: opts.eventTime ?? NOW,
    ingestionTime: opts.ingestionTime ?? NOW,
    meta: opts.meta ?? {},
  });
}

function candidate(text: string, over: Partial<Record<string, unknown>> = {}) {
  const p = post(text);
  return {
    id: (over.id as string) ?? 'ne-1',
    headline: p.headline,
    fingerprint: p.fingerprint,
    simhash: p.simhash,
    tickers: (over.tickers as string[]) ?? [],
    countries: (over.countries as string[]) ?? [],
    category: (over.category as never) ?? 'GEOPOLITICAL',
    eventId: (over.eventId as string | null) ?? 'ev-1',
    timestamp: (over.timestamp as string) ?? NOW,
    importance: (over.importance as number) ?? 80,
    ...over,
  };
}

const run = (p: ReturnType<typeof post>, candidates: ReturnType<typeof candidate>[]) =>
  detectDuplicate({
    post: p,
    candidates: candidates as never,
    similarityThreshold: 0.82,
    windowMinutes: 90,
    now: NOW,
  });

describe('the US/IRAN worked example (§17)', () => {
  const A = 'US AND IRAN REACH DEAL';
  const B = 'U.S. AND IRAN HAVE REACHED AGREEMENT';
  const C = 'AXIOS: US, IRAN REACH AGREEMENT';

  it('collapses B into A', () => {
    const r = run(post(B, { sourceId: 'x:firstsquawk' }), [
      candidate(A, { countries: ['US', 'IR'] }),
    ]);
    expect(r.isDuplicate).toBe(true);
    expect(r.matchedEventId).toBe('ev-1');
  });

  it('collapses C into A despite the wire-service prefix', () => {
    const r = run(post(C, { sourceId: 'rss:reuters' }), [
      candidate(A, { countries: ['US', 'IR'] }),
    ]);
    expect(r.isDuplicate).toBe(true);
  });

  it('produces one event, not three', () => {
    const seen = [candidate(A, { countries: ['US', 'IR'] })];
    const dupB = run(post(B), seen);
    const dupC = run(post(C), seen);
    expect([dupB.isDuplicate, dupC.isDuplicate]).toEqual([true, true]);
  });
});

describe('genuinely different stories are not collapsed', () => {
  it('keeps an unrelated headline', () => {
    const r = run(post('APPLE REPORTS Q3 EPS ABOVE EXPECTATIONS', { sourceId: 'x:tier10k' }), [
      candidate('US AND IRAN REACH DEAL', { countries: ['US', 'IR'] }),
    ]);
    expect(r.isDuplicate).toBe(false);
  });

  it('keeps a genuine development that reverses the story', () => {
    const r = run(post('US AND IRAN TALKS COLLAPSE, NO DEAL REACHED'), [
      candidate('US AND IRAN REACH DEAL', { countries: ['US', 'IR'] }),
    ]);
    expect(r.isDuplicate).toBe(false);
  });

  it('keeps the same headline outside the dedupe window', () => {
    const old = new Date(Date.parse(NOW) - 200 * 60_000).toISOString();
    const r = run(post('US AND IRAN REACH DEAL'), [
      candidate('US AND IRAN REACH DEAL', { countries: ['US', 'IR'], timestamp: old }),
    ]);
    expect(r.isDuplicate).toBe(false);
  });
});

describe('exact-identity layers', () => {
  it('catches an identical fingerprint', () => {
    const text = 'ECB HOLDS RATES STEADY AT 2.00%';
    const r = run(post(text, { sourceId: 'x:livesquawk' }), [candidate(text)]);
    expect(r.isDuplicate).toBe(true);
  });

  it('catches the same URL across sources', () => {
    const url = 'https://www.reuters.com/markets/story-123';
    const r = detectDuplicate({
      post: post('Different words entirely about something else', { originalUrl: url }),
      candidates: [{ ...candidate('Whatever'), originalUrl: `${url}?utm_source=twitter` }] as never,
      similarityThreshold: 0.82,
      windowMinutes: 90,
      now: NOW,
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.reason).toBe('DUPLICATE_URL');
  });
});

describe('canonicalizeUrl', () => {
  it('strips tracking parameters and normalises the host', () => {
    const a = canonicalizeUrl('https://www.reuters.com/markets/x?utm_source=t&utm_medium=s');
    const b = canonicalizeUrl('http://reuters.com/markets/x/');
    expect(a).toBe(b);
  });

  it('does not merge genuinely different paths', () => {
    expect(canonicalizeUrl('https://reuters.com/a')).not.toBe(canonicalizeUrl('https://reuters.com/b'));
  });
});
