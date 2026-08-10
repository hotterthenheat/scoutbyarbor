import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { provenanceOf, attributionFrom } from '../src/core/provenance.js';
import type { ChannelKey, RawPost } from '../src/core/types.js';

/**
 * Official sources raise CREDIBILITY, not alert count.
 *
 * Two things have to hold at once. An agency publishing a release is the most
 * trustworthy report of it there is — and an agency publishing the same release
 * on its RSS feed and its X account is ONE body reporting once. Counting that
 * as two independent confirmations would inflate the credibility component of
 * the score on every single economic print.
 */

setLogLevel('silent');
const log = createLogger('official-test');

let dir: string;
let db: ScoutDb;
let sent: Array<{ channel: ChannelKey }>;
let pipeline: ReturnType<typeof createPipeline>;
let publisher: ReturnType<typeof createPublisher>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-official-'));
  db = openDatabase(join(dir, 'o.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  db.securities.upsertMany(loadSecurityMaster());
  sent = [];

  pipeline = createPipeline({
    db,
    taxonomy: loadTaxonomy(),
    securities: loadSecurityMaster(),
    config: {
      minPublishScore: 60,
      minBreakingScore: 90,
      dedupeWindowMinutes: 90,
      clusterWindowMinutes: 240,
      dedupeSimilarity: 0.82,
    },
    logger: log,
  });

  publisher = createPublisher({
    db,
    logger: log,
    rawChannelEnabled: false,
    discord: {
      async start() {},
      async stop() {},
      isReady: () => true,
      async send(channel: ChannelKey) {
        sent.push({ channel });
        return `m${sent.length}`;
      },
      async edit() {},
      channelId: () => 'c',
    } as never,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

async function report(sourceId: string, text: string, author: string, minutesAgo = 2) {
  const publishedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const post: RawPost = {
    sourceId,
    sourcePostId: `${sourceId}:${++seq}`,
    originalUrl: null,
    author,
    text,
    eventTime: publishedAt,
    ingestionTime: new Date().toISOString(),
    meta: { publishedAt },
  };
  const outcome = await pipeline.process(post);
  if (outcome.accepted) await publisher.publish(outcome);
  return outcome;
}

const alerts = () => sent.filter((s) => s.channel === 'news').length;

describe('the configured source list', () => {
  it('gives every official X account an org shared with its RSS feed', () => {
    const byId = new Map(loadSourcesFile().sources.map((s) => [s.id, s]));

    // Each pair is one body on two channels.
    for (const [x, rss] of [
      ['x:fed', 'rss:fed-press-all'],
      ['x:bls', 'rss:bls-latest'],
      ['x:bea', 'rss:bea-news'],
      ['x:treasury', 'rss:treasury-press'],
      ['x:sec', 'rss:sec-press'],
      ['x:ecb', 'rss:ecb-press'],
      ['x:boe', 'rss:boe-news'],
      ['x:boj', 'rss:boj-news'],
      ['x:boc', 'rss:boc-press'],
    ] as Array<[string, string]>) {
      const a = byId.get(x);
      const b = byId.get(rss);
      expect(a, `${x} missing`).toBeTruthy();
      expect(b, `${rss} missing`).toBeTruthy();
      expect(a?.org, `${x} has no org`).toBeTruthy();
      expect(a?.org, `${x} and ${rss} must share an org`).toBe(b?.org);
    }
  });

  it('tiers official accounts by how directly they carry market data', () => {
    const byId = new Map(loadSourcesFile().sources.map((s) => [s.id, s]));

    // Tier 1 outranks tier 2 outranks tier 3.
    expect(byId.get('x:bls')!.priority).toBeGreaterThan(byId.get('x:census')!.priority);
    expect(byId.get('x:census')!.priority).toBeGreaterThan(byId.get('x:fincen')!.priority);
    // A high-volume routine feed carries a higher noise seed than a release feed.
    expect(byId.get('x:statedept')!.noiseScore).toBeGreaterThan(byId.get('x:bls')!.noiseScore);
  });
});

describe('an agency reporting through two of its own channels', () => {
  it('is ONE confirmation, not two', () => {
    const p = provenanceOf([
      attributionFrom({ sourceId: 'rss:bls-latest', sourceName: 'BLS', org: 'bls' }),
      attributionFrom({ sourceId: 'x:bls', sourceName: 'BLS', author: '@BLS_gov', org: 'bls' }),
    ]);

    expect(p.confirmedBy).toBe(1);
    expect(p.corroborated).toBe(false);
  });

  it('counts a genuinely independent wire as a second confirmation', () => {
    const p = provenanceOf([
      attributionFrom({ sourceId: 'x:bls', author: '@BLS_gov', org: 'bls' }),
      attributionFrom({ sourceId: 'x:deltaone', author: '@DeItaone', org: null }),
    ]);

    expect(p.confirmedBy).toBe(2);
    expect(p.corroborated).toBe(true);
  });
});

/**
 * The worked example: the agency and two fast wires reporting one CPI print.
 */
describe('CPI from the agency and two newswires', () => {
  it('becomes ONE alert with all three contributors', async () => {
    const first = await report('x:bls', 'US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED', '@BLS_gov', 6);
    const second = await report('x:deltaone', 'US CPI rises 3.1% year over year', '@DeItaone', 5);
    const third = await report('x:firstsquawk', 'US CPI +3.1% Y/Y', '@FirstSquawk', 4);

    expect(first.accepted).toBe(true);
    expect(second.accepted, 'a newswire repeat produced a second alert').toBe(false);
    expect(third.accepted, 'a newswire repeat produced a third alert').toBe(false);
    expect(alerts()).toBe(1);

    const p = provenanceOf(db.events.byId(first.cluster!.id)!.contributors);
    expect(p.confirmedBy).toBe(3);
    expect(p.label).toContain('@BLS_gov');
    expect(p.label).toContain('@DeItaone');
    expect(p.label).toContain('@FirstSquawk');
    // The agency published first, and that is what "first reported" means.
    expect(Date.parse(p.firstReportedAt!)).toBeLessThan(Date.now() - 5 * 60_000);
  });
});

/**
 * Being official is credibility, not a bypass. An agency's routine
 * administrative output must not become a trading alert.
 */
describe('official status does not bypass the filters', () => {
  it('holds routine agency housekeeping out of the trading channels', async () => {
    const outcome = await report(
      'x:bls',
      'BLS will host a webinar on the redesign of the consumer expenditure survey',
      '@BLS_gov',
    );

    const trading = sent.filter((s) => s.channel === 'spx' || s.channel === 'tradingFloor');
    expect(trading, 'agency housekeeping reached a trading channel').toHaveLength(0);
    // Either rejected outright or held to the general feed — never traded on.
    if (outcome.accepted) expect(outcome.route?.channels).toEqual(['news']);
  });

  it('still routes a real release from the same account to the index channel', async () => {
    const outcome = await report('x:bls', 'US CPI RISES 3.1% Y/Y VS 3.0% EXPECTED', '@BLS_gov');

    expect(outcome.accepted).toBe(true);
    expect(outcome.route?.channels).toContain('spx');
  });
});
