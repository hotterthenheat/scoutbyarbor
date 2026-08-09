import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { ScoutDb } from '../db/index.js';
import type { Logger } from '../util/logger.js';
import { isoNow, msBetween, minutesBetween } from '../util/time.js';
import {
  presentedSecret,
  secretsMatch,
  validateWebhookPayload,
  idempotencyKey,
  type NormalizedWebhookEvent,
} from './webhook.js';

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
  /** The port actually bound. Differs from the configured one when that is 0. */
  port(): number;
}

/** What the runtime does with a validated event. Must not await processing. */
export type WebhookAccepter = (
  event: NormalizedWebhookEvent,
  idempotencyKey: string,
) => { accepted: boolean; duplicate: boolean; eventId: string };

export interface WebhookConfig {
  token: string;
  accept: WebhookAccepter;
}

/**
 * Lets an external scheduler drive the Sprout replay over HTTP. Necessary
 * because a Render cron job runs in its own container and cannot mount the web
 * service's disk — so it cannot reach the database directly, only through the
 * service that owns it.
 */
export interface AdminConfig {
  token: string;
  replay: () => Promise<Record<string, unknown>>;
}

export interface ServerDeps {
  db: ScoutDb;
  logger: Logger;
  port: number;
  /** Critical dependency probes. All must pass for /ready to return 200. */
  readiness: () => Array<{ name: string; ok: boolean; detail?: string }>;
  startedAt?: Date;
  /** Omit to leave POST /webhook/news disabled. */
  webhook?: WebhookConfig;
  /** Omit to leave POST /admin/replay disabled. */
  admin?: AdminConfig;
}

/** Bodies larger than this are refused before being buffered. */
const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;

/** How long since the last webhook event before health says NO_RECENT_EVENTS. */
const WEBHOOK_QUIET_MINUTES = 120;

export function createServer_(deps: ServerDeps): ScoutServer {
  const { db, logger } = deps;
  const startedAt = deps.startedAt ?? new Date();
  let server: Server | null = null;
  let boundPort = deps.port;

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

  /**
   * POST /webhook/news — authenticate, validate, queue, acknowledge.
   *
   * Deliberately does NOT await Discord, Sprout, classification or any external
   * call. The upstream source gets 202 as soon as the event is durably queued;
   * everything after that is the same background processor a relayed post uses.
   */
  async function handleWebhook(req: IncomingMessage): Promise<{ status: number; body: string }> {
    const webhook = deps.webhook;
    const receivedAt = isoNow();
    db.metrics.record('webhook_requests_total', 1);

    if (!webhook?.token) {
      db.metrics.record('webhook_rejected_total', 1);
      return json({ error: 'webhook ingestion is not configured' }, 503);
    }

    const provided = presentedSecret(req.headers as Record<string, string | string[] | undefined>);
    // Compared in constant time, and never logged.
    if (!provided || !secretsMatch(provided, webhook.token)) {
      db.metrics.record('webhook_rejected_total', 1);
      logger.warn('webhook authentication failed');
      return json({ error: 'unauthorized' }, 401);
    }

    let raw: string;
    try {
      raw = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      db.metrics.record('webhook_rejected_total', 1);
      return json({ error: (err as Error).message }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      db.metrics.record('webhook_rejected_total', 1);
      return json({ error: 'body is not valid JSON' }, 400);
    }

    const validated = validateWebhookPayload(parsed, receivedAt);
    if (!validated.ok) {
      db.metrics.record('webhook_rejected_total', 1);
      return json({ error: validated.error }, validated.status);
    }

    const key = idempotencyKey(
      req.headers as Record<string, string | string[] | undefined>,
      validated.event.canonicalId,
    );

    try {
      const result = webhook.accept(validated.event, key);

      if (result.duplicate) {
        // A retry of a post already accepted. Success, but no second alert.
        db.metrics.record('webhook_duplicates_total', 1);
        return json({ status: 'duplicate', id: result.eventId, accepted: false }, 200);
      }

      db.metrics.record('webhook_events_accepted_total', 1);
      db.metrics.record(
        'webhook_processing_latency_ms',
        Math.max(0, msBetween(receivedAt, isoNow())),
      );
      return json({ status: 'accepted', id: result.eventId, accepted: true }, 202);
    } catch (err) {
      logger.error('webhook accept failed', { err: err as Error });
      return json({ error: 'could not queue the event' }, 500);
    }
  }

  /** POST /admin/replay — drives one Sprout replay pass and reports the counts. */
  async function handleAdminReplay(req: IncomingMessage): Promise<{ status: number; body: string }> {
    const admin = deps.admin;
    if (!admin?.token) return json({ error: 'admin endpoint is not configured' }, 503);

    const provided = presentedSecret(req.headers as Record<string, string | string[] | undefined>);
    if (!provided || !secretsMatch(provided, admin.token)) {
      logger.warn('admin authentication failed');
      return json({ error: 'unauthorized' }, 401);
    }

    try {
      const report = await admin.replay();
      return json({ status: 'ok', ...report }, 200);
    } catch (err) {
      logger.error('admin replay failed', { err: err as Error });
      return json({ error: 'replay failed' }, 500);
    }
  }

  /** Webhook liveness. Silence is normal for a push endpoint, never an outage. */
  function webhookHealth(): Record<string, unknown> {
    const lastReceivedAt = db.posts.lastReceivedAt('webhook');
    const configured = Boolean(deps.webhook?.token);

    const state = !configured
      ? 'NOT_CONFIGURED'
      : lastReceivedAt && minutesBetween(lastReceivedAt, isoNow()) <= WEBHOOK_QUIET_MINUTES
        ? 'HEALTHY'
        : 'NO_RECENT_EVENTS';

    return {
      // NO_RECENT_EVENTS is not a failure: an upstream source with nothing to
      // say is indistinguishable from a quiet news period, and calling that an
      // outage would be the same mistake the source-health layer avoids.
      state,
      lastReceivedAt,
      quietAfterMinutes: WEBHOOK_QUIET_MINUTES,
    };
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
      // The rate must be over the window the count covers, not over process
      // uptime — otherwise a service restarted a minute ago reports a day's
      // worth of alerts as its per-minute rate.
      const uptimeMinutes = msBetween(startedAt.toISOString(), isoNow()) / 60_000;
      const windowMinutes = Math.max(1, Math.min(24 * 60, uptimeMinutes));

      const summary = db.metrics.summary(since);

      return json({
        time: isoNow(),
        window: '24h',
        queue: { depth: db.jobs.queueDepth(), byStatus: jobs },
        webhook: {
          ...webhookHealth(),
          requestsTotal: summary.webhook_requests_total ?? 0,
          rejectedTotal: summary.webhook_rejected_total ?? 0,
          eventsAcceptedTotal: summary.webhook_events_accepted_total ?? 0,
          duplicatesTotal: summary.webhook_duplicates_total ?? 0,
          processingLatencyMs: Math.round(summary['webhook_processing_latency_ms.avg'] ?? 0),
          queueDepth: db.jobs.queueDepth(),
        },
        events: { byStatus: statuses, eventsPerMinute: Number((published / windowMinutes).toFixed(3)) },
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

        const respond = (result: { status: number; body: string }): void => {
          res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(result.body);
        };

        if (path === '/admin/replay') {
          if (req.method !== 'POST') {
            respond(json({ error: 'method not allowed' }, 405));
            return;
          }
          void handleAdminReplay(req)
            .then(respond)
            .catch((err: Error) => {
              logger.error('admin handler threw', { err });
              respond(json({ error: 'internal error' }, 500));
            });
          return;
        }

        if (path === '/webhook/news') {
          if (req.method !== 'POST') {
            respond(json({ error: 'method not allowed' }, 405));
            return;
          }
          void handleWebhook(req)
            .then(respond)
            .catch((err: Error) => {
              logger.error('webhook handler threw', { err });
              respond(json({ error: 'internal error' }, 500));
            });
          return;
        }

        respond(
          path === '/health'
            ? health()
            : path === '/ready'
              ? ready()
              : path === '/metrics'
                ? metrics()
                : json({ error: 'not found' }, 404),
        );
      });

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(deps.port, () => {
          const address = server?.address();
          // Port 0 asks the OS to pick one; report what it actually chose.
          if (address && typeof address === 'object') boundPort = address.port;
          logger.info('http server listening', { port: boundPort });
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

    port: () => boundPort,
  };
}

/** Buffers a request body, refusing anything over the limit. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export { createServer_ as createScoutServer };
