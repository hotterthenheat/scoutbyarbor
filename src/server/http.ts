import { createServer, type Server } from 'node:http';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import { isoNow, msBetween } from '../util/time.js';

/**
 * Operational HTTP surface for a long-running deployment.
 *
 *   GET /health   liveness — the process is up
 *   GET /ready    readiness — the dependencies ingestion actually needs are up
 *   GET /metrics  queue depth, latency percentiles, feed health, throughput
 *
 * /ready returns 503 when a critical dependency is unavailable, so the platform
 * restarts or holds traffic rather than leaving Scout silently deaf. That is the
 * same principle as source health: not receiving news and not being able to
 * receive news must never look the same.
 */

export interface ScoutServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
}

export interface ServerDeps {
  db: ScoutDb;
  logger: Logger;
  port: number;
  /** Critical dependency probes. All must pass for /ready to return 200. */
  readiness: () => Array<{ name: string; ok: boolean; detail?: string }>;
  startedAt?: Date;
}

export function createServer_(deps: ServerDeps): ScoutServer {
  const { db, logger } = deps;
  const startedAt = deps.startedAt ?? new Date();
  let server: Server | null = null;

  function json(body: unknown, status = 200): { status: number; body: string } {
    return { status, body: JSON.stringify(body, null, 2) };
  }

  function health(): { status: number; body: string } {
    return json({
      status: 'ok',
      uptimeSeconds: Math.round(msBetween(startedAt.toISOString(), isoNow()) / 1000),
      time: isoNow(),
    });
  }

  function ready(): { status: number; body: string } {
    let checks: Array<{ name: string; ok: boolean; detail?: string }>;
    try {
      checks = deps.readiness();
    } catch (err) {
      return json({ status: 'not_ready', error: (err as Error).message }, 503);
    }
    const ok = checks.every((c) => c.ok);
    return json({ status: ok ? 'ready' : 'not_ready', checks }, ok ? 200 : 503);
  }

  function metrics(): { status: number; body: string } {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();

    try {
      const latency = db.metrics.latencyStats(since);
      const jobs = db.jobs.countsByStatus();
      const statuses = db.newsEvents.countsByStatus(since);
      const deliveries = db.deliveries.countsByStatus(since);
      const healthRows = db.health.all();

      const feedHealth: Record<string, number> = {};
      for (const row of healthRows) {
        feedHealth[row.state] = (feedHealth[row.state] ?? 0) + 1;
      }

      const published = statuses.PUBLISHED ?? 0;
      const uptimeMinutes = Math.max(1, msBetween(startedAt.toISOString(), isoNow()) / 60_000);

      return json({
        time: isoNow(),
        window: '24h',
        queue: { depth: db.jobs.queueDepth(), byStatus: jobs },
        events: { byStatus: statuses, eventsPerMinute: Number((published / uptimeMinutes).toFixed(3)) },
        deliveries,
        latencyMs: {
          count: latency.count,
          avg: Math.round(latency.avg),
          p95: Math.round(latency.p95),
          p99: Math.round(latency.p99),
        },
        sources: {
          byState: feedHealth,
          // A named list of anything not ACTIVE, because "which feed is down"
          // is the question an operator actually has.
          degraded: healthRows
            .filter((r) => r.state !== 'ACTIVE')
            .map((r) => ({ sourceId: r.sourceId, state: r.state, lastItemAt: r.lastItemAt })),
        },
      });
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  }

  return {
    async start(): Promise<void> {
      server = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        const result =
          path === '/health'
            ? health()
            : path === '/ready'
              ? ready()
              : path === '/metrics'
                ? metrics()
                : json({ error: 'not found' }, 404);

        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(result.body);
      });

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(deps.port, () => {
          logger.info('http server listening', { port: deps.port });
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      server = null;
    },

    port: () => deps.port,
  };
}

export { createServer_ as createScoutServer };
