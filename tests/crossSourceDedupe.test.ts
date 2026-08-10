import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createPipeline } from '../src/pipeline/index.js';
import { createPublisher } from '../src/discord/publisher.js';
import { loadSourcesFile, loadTaxonomy, loadSecurityMaster, toSource, toDiscordSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';
import { provenanceOf } from '../src/core/provenance.js';
import type { ChannelKey, RawPost } from '../src/core/types.js';

/**
 * ONE alert per event, however many sources report it.
 *
 * The failure this file exists to prevent is a desk receiving the same headline
 * three times because three wires carried it. The opposite failure matters just
 * as much: three genuinely separate developments collapsing into one alert
 * because they share vocabulary. Both are tested here.
 *
 * Multiple sources must raise CONFIDENCE, not alert count.
 */

setLogLevel('silent');
const log = createLogger('xsrc-dedupe-test');

const DISCORD_CHANNEL = {
  id: '1081082844807434292',
  sourceId: 'discord:arbor-intel',
  name: 'Arbor Intelligence Source',
  enabled: true,
  qualityScore: 80,
  noiseScore: 30,
  filterProfile: 'standard' as const,
  authors: [],
};

let dir: string;
let db: ScoutDb;
let sent: Array<{ channel: ChannelKey; content: string }>;
let pipeline: ReturnType<typeof createPipeline>;
let publisher: ReturnType<typeof createPublisher>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-xsrc-'));
  db = openDatabase(join(dir, 'x.db'));
  db.migrate();
  const now = new Date().toISOString();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, now)));
  db.sources.upsertMany([toDiscordSource(DISCORD_CHANNEL, now)]);
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
      async send(channel: ChannelKey, content: string) {
        sent.push({ channel, content });
        return `msg-${sent.length}`;
      },
      async edit() {},
      channelId: () => 'chan',
    } as never,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

/** Publishes through the real pipeline, exactly as the runtime does. */
async function report(opts: {
  sourceId: string;
  text: string;
  author?: string;
  minutesAgo?: number;
  discord?: { authorName: string; channelName: string };
}) {
  const publishedAt = new Date(Date.now() - (opts.minutesAgo ?? 2) * 60_000).toISOString();
  const post: RawPost = {
    sourceId: opts.sourceId,
    sourcePostId: `${opts.sourceId}:${++seq}`,
    originalUrl: null,
    author: opts.author ?? opts.discord?.authorName ?? '@wire',
    text: opts.text,
    eventTime: publishedAt,
    ingestionTime: new Date().toISOString(),
    meta: {
      publishedAt,
      ...(opts.discord
        ? {
            authorName: opts.discord.authorName,
            channelName: opts.discord.channelName,
            provenance: 'discord',
          }
        : {}),
    },
  };

  const outcome = await pipeline.process(post);
  if (outcome.accepted) await publisher.publish(outcome);
  return outcome;
}

const alerts = () => sent.filter((s) => s.channel === 'news').length;

// ─────────────────────────────────────────────────────────────────────────────
describe('1. the same Discord message delivered twice', () => {
  it('produces one alert', async () => {
    const text = 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING';
    const first = await report({
      sourceId: 'discord:arbor-intel',
      text,
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });
    const second = await report({
      sourceId: 'discord:arbor-intel',
      text,
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(alerts()).toBe(1);
  });
});

describe('2. the same story posted twice in Discord with different wording', () => {
  it('produces one alert', async () => {
    await report({
      sourceId: 'discord:arbor-intel',
      text: 'IRAN: HORMUZ DEAL WITH OMAN INCLUDES FEES FOR MARITIME SERVICES',
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });
    const second = await report({
      sourceId: 'discord:arbor-intel',
      text: 'IRAN AND OMAN DISCUSS MARITIME FEES UNDER POTENTIAL HORMUZ AGREEMENT',
      discord: { authorName: 'unusual_whales_crier', channelName: 'market-news' },
    });

    expect(second.accepted).toBe(false);
    expect(alerts()).toBeLessThanOrEqual(1);
  });
});

describe('3. the same story posted by multiple X accounts', () => {
  it('produces one alert, whoever reports it', async () => {
    const first = await report({
      sourceId: 'x:deltaone',
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR FACILITIES',
      author: '@DeItaone',
    });
    const second = await report({
      sourceId: 'x:firstsquawk',
      text: 'ISRAEL SAYS IT HAS STRUCK IRANIAN NUCLEAR SITES',
      author: '@FirstSquawk',
    });
    const third = await report({
      sourceId: 'x:reuters',
      text: 'Israel confirms strikes against nuclear facilities in Iran',
      author: '@Reuters',
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(third.accepted).toBe(false);
    expect(alerts()).toBe(1);
  });
});

describe('4. Discord reports first, X confirms second', () => {
  it('produces one alert and records both contributors', async () => {
    const first = await report({
      sourceId: 'discord:arbor-intel',
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR FACILITIES',
      minutesAgo: 5,
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });
    const second = await report({
      sourceId: 'x:deltaone',
      text: 'ISRAEL SAYS IT HAS STRUCK IRANIAN NUCLEAR SITES',
      author: '@DeItaone',
      minutesAgo: 3,
    });

    expect(second.accepted).toBe(false);
    expect(alerts()).toBe(1);

    const cluster = db.events.byId(first.cluster!.id)!;
    const p = provenanceOf(cluster.contributors);
    expect(p.confirmedBy).toBe(2);
    expect(p.label).toContain('OwlsKeyLevelsBot');
    expect(p.label).toContain('@DeItaone');
    // The EARLIEST report wins, and Discord was five minutes ago.
    expect(Date.parse(p.firstReportedAt!)).toBeLessThan(Date.now() - 4 * 60_000);
  });
});

describe('5. X reports first, Discord confirms second', () => {
  it('produces one alert and records both contributors', async () => {
    const first = await report({
      sourceId: 'x:deltaone',
      text: 'OPEC+ AGREES TO EXTEND PRODUCTION CUTS THROUGH THE SECOND QUARTER',
      author: '@DeItaone',
      minutesAgo: 6,
    });
    const second = await report({
      sourceId: 'discord:arbor-intel',
      text: 'OPEC+ EXTENDS OUTPUT CUTS INTO Q2',
      minutesAgo: 2,
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });

    expect(second.accepted).toBe(false);
    expect(alerts()).toBe(1);

    const p = provenanceOf(db.events.byId(first.cluster!.id)!.contributors);
    expect(p.confirmedBy).toBe(2);
    expect(p.origins).toContain('discord');
    expect(p.origins).toContain('x');
  });
});

describe('6. three or more sources report the same story', () => {
  it('produces one alert with three contributors', async () => {
    const first = await report({
      sourceId: 'discord:arbor-intel',
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR FACILITIES',
      minutesAgo: 7,
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });
    await report({
      sourceId: 'x:deltaone',
      text: 'ISRAEL SAYS IT HAS STRUCK IRANIAN NUCLEAR SITES',
      author: '@DeItaone',
      minutesAgo: 5,
    });
    await report({
      sourceId: 'x:firstsquawk',
      text: 'Israel confirms strikes against nuclear facilities in Iran',
      author: '@FirstSquawk',
      minutesAgo: 4,
    });

    expect(alerts()).toBe(1);

    const p = provenanceOf(db.events.byId(first.cluster!.id)!.contributors);
    expect(p.confirmedBy).toBe(3);
    expect(p.corroborated).toBe(true);
  });
});

/**
 * The opposite failure. These share vocabulary — inflation, rates, the Fed —
 * and are close together in time, but they are three developments, not one.
 * Collapsing them would hide two of them.
 */
describe('7. similar but genuinely separate events close together', () => {
  it('stays three events', async () => {
    const cpi = await report({
      sourceId: 'x:deltaone',
      text: 'US CPI RISES 0.4% M/M VS 0.2% EXPECTED',
      minutesAgo: 45,
    });
    const waller = await report({
      sourceId: 'x:reuters',
      text: 'FED GOVERNOR WALLER SAYS INFLATION PROGRESS HAS STALLED AND CUTS MAY WAIT',
      minutesAgo: 20,
    });
    const claims = await report({
      sourceId: 'x:firstsquawk',
      text: 'US INITIAL JOBLESS CLAIMS FALL TO 198,000 VS 215,000 EXPECTED',
      minutesAgo: 5,
    });

    expect(cpi.accepted).toBe(true);
    expect(waller.accepted).toBe(true);
    expect(claims.accepted).toBe(true);

    const clusters = new Set([cpi.cluster?.id, waller.cluster?.id, claims.cluster?.id]);
    expect(clusters.size, 'three separate developments collapsed into one').toBe(3);
    expect(alerts()).toBe(3);
  });
});

describe('8. a later follow-up development', () => {
  it('is its own event, not a duplicate of the first', async () => {
    const initial = await report({
      sourceId: 'x:deltaone',
      text: 'ISRAEL CONFIRMS STRIKES ON IRANIAN NUCLEAR FACILITIES',
      minutesAgo: 80,
    });
    // A genuinely new development in the same story.
    const followUp = await report({
      sourceId: 'x:deltaone',
      text: 'IRAN SAYS IT WILL CLOSE THE STRAIT OF HORMUZ TO ALL TANKER TRAFFIC',
      minutesAgo: 2,
    });

    expect(initial.accepted).toBe(true);
    expect(followUp.accepted, 'a new development was swallowed as a duplicate').toBe(true);
    expect(alerts()).toBe(2);
  });
});

/**
 * An event Scout could not classify must not silence a source that words the
 * same story comprehensibly — otherwise the first wire to phrase something
 * badly buries it for everyone.
 */
describe('an unreadable first report does not bury the story', () => {
  it('lets a clearer second report through', async () => {
    const vague = await report({
      sourceId: 'discord:arbor-intel',
      text: 'hormuz thing maybe happening idk',
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });
    expect(vague.accepted).toBe(false);

    const clear = await report({
      sourceId: 'x:deltaone',
      text: 'IRAN SAYS IT WILL CLOSE THE STRAIT OF HORMUZ TO ALL TANKER TRAFFIC',
      author: '@DeItaone',
    });

    expect(clear.accepted, 'a clear report was buried by an unreadable one').toBe(true);
    expect(alerts()).toBe(1);
  });
});

describe('provenance survives dedupe and restart', () => {
  it('reads back from SQLite with every contributor intact', async () => {
    const first = await report({
      sourceId: 'discord:arbor-intel',
      text: 'OPEC+ AGREES TO EXTEND PRODUCTION CUTS THROUGH THE SECOND QUARTER',
      minutesAgo: 6,
      discord: { authorName: 'OwlsKeyLevelsBot', channelName: 'market-news' },
    });
    await report({
      sourceId: 'x:deltaone',
      text: 'OPEC+ EXTENDS OUTPUT CUTS INTO Q2',
      author: '@DeItaone',
      minutesAgo: 3,
    });

    const path = join(dir, 'x.db');
    const clusterId = first.cluster!.id;
    db.close();

    // A different connection entirely — the process restarted.
    const reopened = openDatabase(path);
    reopened.migrate();
    const p = provenanceOf(reopened.events.byId(clusterId)!.contributors);

    expect(p.confirmedBy).toBe(2);
    expect(p.sources.find((s) => s.kind === 'discord')?.author).toBe('OwlsKeyLevelsBot');
    expect(p.sources.find((s) => s.kind === 'x')?.account).toBe('@DeItaone');
    reopened.close();

    db = openDatabase(path);
  });
});
