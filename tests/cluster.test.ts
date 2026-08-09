import { describe, it, expect } from 'vitest';
import { findCluster, createCluster, applyUpdate, computeNovelty } from '../src/pipeline/cluster.js';
import { normalizePost } from '../src/pipeline/normalize.js';
import type { EventCluster, ExtractedEntities, RawPost } from '../src/core/types.js';

/**
 * §18. The US/Iran negotiation timeline from the spec: four posts over an hour
 * are developments in ONE event, and the latest supersedes rather than floods.
 */

const T0 = '2026-05-24T14:02:00.000Z';

function post(text: string, at = T0) {
  const raw: RawPost = {
    sourceId: 'x:deltaone',
    sourcePostId: `p-${at}`,
    originalUrl: null,
    author: null,
    text,
    eventTime: at,
    ingestionTime: at,
    meta: {},
  };
  return normalizePost(raw);
}

function entities(countries: string[] = [], people: string[] = []): ExtractedEntities {
  return { tickers: [], countries, organizations: [], people, commodities: [], figures: [] };
}

function seed(): EventCluster {
  return createCluster({
    id: 'ev-1',
    headline: 'TRUMP SAYS TALKS WITH IRAN ARE PROGRESSING',
    category: 'GEOPOLITICAL',
    subcategory: null,
    tickers: [],
    countries: ['US', 'IR'],
    entities: ['TRUMP'],
    importance: 72,
    band: 'MODERATE',
    sourceId: 'x:deltaone',
    occurredAt: T0,
    now: T0,
  } as Parameters<typeof createCluster>[0]);
}

const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

describe('the US/Iran timeline (§18)', () => {
  it('joins later developments to the same cluster', () => {
    const cluster = seed();
    const developments = [
      ['IRANIAN OFFICIALS SIGNAL AGREEMENT', 15],
      ['AXIOS REPORTS US-IRAN AGREEMENT REACHED', 39],
    ] as const;

    for (const [text, minutes] of developments) {
      const match = findCluster({
        post: post(text, at(minutes)),
        category: 'GEOPOLITICAL',
        entities: entities(['US', 'IR']),
        openClusters: [cluster],
        windowMinutes: 240,
        similarityThreshold: 0.82,
        now: at(minutes),
      });
      expect(match.cluster?.id, `"${text}" did not join the cluster`).toBe('ev-1');
    }
  });

  it('does not join an unrelated event', () => {
    const match = findCluster({
      post: post('APPLE REPORTS Q3 EPS ABOVE EXPECTATIONS', at(20)),
      category: 'EARNINGS',
      entities: entities([]),
      openClusters: [seed()],
      windowMinutes: 240,
      similarityThreshold: 0.82,
      now: at(20),
    });
    expect(match.cluster).toBeNull();
  });

  it('does not let a geopolitical update join an earnings cluster', () => {
    const earnings = { ...seed(), id: 'ev-2', category: 'EARNINGS' as const };
    const match = findCluster({
      post: post('IRANIAN OFFICIALS SIGNAL AGREEMENT', at(15)),
      category: 'GEOPOLITICAL',
      entities: entities(['US', 'IR']),
      openClusters: [earnings],
      windowMinutes: 240,
      similarityThreshold: 0.82,
      now: at(15),
    });
    expect(match.cluster).toBeNull();
  });

  it('drops out of the window eventually', () => {
    const match = findCluster({
      post: post('IRANIAN OFFICIALS SIGNAL AGREEMENT', at(600)),
      category: 'GEOPOLITICAL',
      entities: entities(['US', 'IR']),
      openClusters: [seed()],
      windowMinutes: 240,
      similarityThreshold: 0.82,
      now: at(600),
    });
    expect(match.cluster).toBeNull();
  });
});

describe('superseding rather than flooding (§18)', () => {
  it('supersedes when a bigger development lands', () => {
    const { cluster, supersedes } = applyUpdate(seed(), {
      headline: 'US AND IRAN REACH AGREEMENT',
      importance: 91,
      band: 'CRITICAL',
      sourceId: 'x:firstsquawk',
      occurredAt: at(39),
      tickers: [],
      countries: ['US', 'IR'],
    });
    expect(supersedes).toBe(true);
    expect(cluster.headline).toBe('US AND IRAN REACH AGREEMENT');
    expect(cluster.importance).toBeGreaterThanOrEqual(91);
  });

  it('does not supersede on a minor restatement', () => {
    const { supersedes } = applyUpdate(seed(), {
      headline: 'TRUMP SAYS TALKS WITH IRAN ARE PROGRESSING WELL',
      importance: 73,
      band: 'MODERATE',
      sourceId: 'x:livesquawk',
      occurredAt: at(5),
      tickers: [],
      countries: ['US', 'IR'],
    });
    expect(supersedes).toBe(false);
  });

  it('counts a new source once and keeps postCount monotonic', () => {
    let c = seed();
    c = applyUpdate(c, {
      headline: 'IRANIAN OFFICIALS SIGNAL AGREEMENT',
      importance: 75,
      band: 'HIGH',
      sourceId: 'x:firstsquawk',
      occurredAt: at(15),
      tickers: [],
      countries: ['US', 'IR'],
    }).cluster;
    const afterNewSource = c.sourceCount;

    c = applyUpdate(c, {
      headline: 'IRANIAN OFFICIALS SIGNAL AGREEMENT AGAIN',
      importance: 74,
      band: 'HIGH',
      sourceId: 'x:firstsquawk',
      occurredAt: at(18),
      tickers: [],
      countries: ['US', 'IR'],
    }).cluster;

    expect(c.sourceCount).toBe(afterNewSource);
    expect(c.postCount).toBeGreaterThanOrEqual(3);
  });

  it('never lowers the cluster’s peak importance', () => {
    let c = seed();
    c = applyUpdate(c, {
      headline: 'US AND IRAN REACH AGREEMENT',
      importance: 91,
      band: 'CRITICAL',
      sourceId: 'x:firstsquawk',
      occurredAt: at(39),
      tickers: [],
      countries: ['US', 'IR'],
    }).cluster;
    c = applyUpdate(c, {
      headline: 'TRUMP APPROVAL STILL PENDING',
      importance: 60,
      band: 'MODERATE',
      sourceId: 'x:ap',
      occurredAt: at(61),
      tickers: [],
      countries: ['US'],
    }).cluster;
    expect(c.importance).toBeGreaterThanOrEqual(91);
  });
});

describe('novelty (§19)', () => {
  it('is maximal for a brand-new event', () => {
    expect(
      computeNovelty({ matchedCluster: null, similarity: 0, minutesSinceFirstSeen: 0, sourceCount: 0 }),
    ).toBe(100);
  });

  it('decays as more wires carry the same story', () => {
    const c = seed();
    const second = computeNovelty({ matchedCluster: c, similarity: 0.9, minutesSinceFirstSeen: 5, sourceCount: 1 });
    const fifth = computeNovelty({ matchedCluster: c, similarity: 0.9, minutesSinceFirstSeen: 40, sourceCount: 5 });
    expect(second).toBeGreaterThan(fifth);
    expect(fifth).toBeLessThan(30);
  });

  it('stays within 0-100', () => {
    const c = seed();
    for (const n of [0, 1, 5, 20]) {
      const v = computeNovelty({ matchedCluster: c, similarity: 1, minutesSinceFirstSeen: 500, sourceCount: n });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
