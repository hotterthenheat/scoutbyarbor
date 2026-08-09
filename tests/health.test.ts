import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ScoutDb } from '../src/db/index.js';
import { createHealthMonitor } from '../src/health/monitor.js';
import { computeLatency, summarizeLatency, percentile } from '../src/health/latency.js';
import { loadSourcesFile, toSource } from '../src/config/loader.js';
import { createLogger, setLogLevel } from '../src/util/logger.js';

/**
 * §23's rule, which is the one that matters most operationally: a broken feed
 * must never be readable as a quiet news environment.
 */

setLogLevel('silent');
const log = createLogger('test');

let dir: string;
let db: ScoutDb;
let warnings: string[];
let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scout-health-'));
  db = openDatabase(join(dir, 'h.db'));
  db.migrate();
  db.sources.upsertMany(loadSourcesFile().sources.map((s) => toSource(s, new Date().toISOString())));
  warnings = [];
  clock = new Date('2026-08-09T12:00:00.000Z');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const monitor = () =>
  createHealthMonitor({
    db,
    logger: log,
    onWarning: async (msg) => {
      warnings.push(msg);
    },
    now: () => clock,
  });

const advance = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

const stateOf = (rows: ReturnType<ReturnType<typeof monitor>['evaluate']>, id: string) =>
  rows.find((r) => r.sourceId === id)?.state;

describe('the state machine', () => {
  it('is ACTIVE while items keep arriving', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'x:deltaone', ok: true, itemCount: 3, latencyMs: 40 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('ACTIVE');
  });

  it('goes DELAYED then STALE as the silence lengthens', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'x:deltaone', ok: true, itemCount: 1, latencyMs: 40 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('ACTIVE');

    // The configured expected interval for this source is 15 minutes.
    advance(20);
    h.recordPoll({ sourceId: 'x:deltaone', ok: true, itemCount: 0, latencyMs: 40 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('DELAYED');

    advance(40);
    h.recordPoll({ sourceId: 'x:deltaone', ok: true, itemCount: 0, latencyMs: 40 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('STALE');
  });

  it('goes ERROR then DISCONNECTED as failures accumulate', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'HTTP 500', itemCount: 0, latencyMs: 5 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('ERROR');

    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'HTTP 500', itemCount: 0, latencyMs: 5 });
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'HTTP 500', itemCount: 0, latencyMs: 5 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('DISCONNECTED');
  });

  it('says nothing about a source it has never polled', () => {
    const h = monitor();
    h.evaluate();
    // Neither healthy nor broken — claiming either would be a lie.
    expect(warnings).toHaveLength(0);
  });

  it('recovers when items resume', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'boom', itemCount: 0, latencyMs: 5 });
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'boom', itemCount: 0, latencyMs: 5 });
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'boom', itemCount: 0, latencyMs: 5 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('DISCONNECTED');

    h.recordPoll({ sourceId: 'x:deltaone', ok: true, itemCount: 2, latencyMs: 30 });
    expect(stateOf(h.evaluate(), 'x:deltaone')).toBe('ACTIVE');
    expect(warnings.some((w) => w.includes('SOURCE RECOVERED'))).toBe(true);
  });
});

describe('warnings', () => {
  it('raises a SOURCE HEALTH WARNING on the way into a bad state', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'HTTP 500', itemCount: 0, latencyMs: 5 });
    h.evaluate();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SOURCE HEALTH WARNING');
    expect(warnings[0]).toContain('x:deltaone');
    // The operative sentence: a stale feed is not a quiet news environment.
    expect(warnings[0]).toContain('not a quiet news environment');
  });

  it('debounces a flapping source', () => {
    const h = monitor();
    for (let i = 0; i < 5; i++) {
      h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'boom', itemCount: 0, latencyMs: 5 });
      h.evaluate();
      h.recordPoll({ sourceId: 'x:deltaone', ok: true, itemCount: 1, latencyMs: 5 });
      h.evaluate();
      advance(1);
    }
    // Five flaps must not produce ten messages.
    expect(warnings.length).toBeLessThanOrEqual(2);
  });

  it('persists state so a restart does not lose it', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'x:deltaone', ok: false, error: 'boom', itemCount: 0, latencyMs: 5 });
    h.evaluate();
    expect(db.health.byId('x:deltaone')?.state).toBe('ERROR');
  });
});

describe('per-source expected interval', () => {
  it('reads the value configured in sources.yaml', () => {
    // An RSS release feed is naturally sparse; treating it like a newswire
    // account would raise a false STALE warning every quiet afternoon.
    const rss = db.sources.byId('rss:fed-monetary');
    const x = db.sources.byId('x:deltaone');
    expect(rss?.expectedIntervalMs).toBeGreaterThan(x?.expectedIntervalMs ?? 0);
  });

  it('does not call a sparse official feed stale after minutes', () => {
    const h = monitor();
    h.recordPoll({ sourceId: 'rss:fed-monetary', ok: true, itemCount: 1, latencyMs: 40 });
    advance(120);
    h.recordPoll({ sourceId: 'rss:fed-monetary', ok: true, itemCount: 0, latencyMs: 40 });
    expect(stateOf(h.evaluate(), 'rss:fed-monetary')).toBe('ACTIVE');
  });
});

describe('latency (§22)', () => {
  it('separates the source and Scout legs', () => {
    const l = computeLatency({
      eventTime: '2026-08-09T12:00:00.000Z',
      ingestionTime: '2026-08-09T12:00:01.000Z',
      processingTime: '2026-08-09T12:00:01.200Z',
      discordTime: '2026-08-09T12:00:01.500Z',
    });
    expect(l.sourceToScoutMs).toBe(1000);
    expect(l.scoutToDiscordMs).toBe(300);
    expect(l.totalMs).toBe(1500);
  });

  it('clamps a source clock running ahead instead of reporting negative latency', () => {
    const l = computeLatency({
      eventTime: '2026-08-09T12:00:05.000Z',
      ingestionTime: '2026-08-09T12:00:00.000Z',
    });
    expect(l.sourceToScoutMs).toBe(0);
  });

  it('reports null, not zero, for stages that have not happened', () => {
    const l = computeLatency({
      eventTime: '2026-08-09T12:00:00.000Z',
      ingestionTime: '2026-08-09T12:00:01.000Z',
    });
    expect(l.discordTime).toBeNull();
    expect(l.totalMs).toBeNull();
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(percentile([], 95)).toBe(0);

    const s = summarizeLatency([100, 200, 300, 400, 5000]);
    expect(s.count).toBe(5);
    expect(s.max).toBe(5000);
    expect(s.p99).toBe(5000);
  });
});
