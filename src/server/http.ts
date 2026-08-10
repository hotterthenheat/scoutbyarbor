import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { ScoutDb } from '../db/index.js';
import type { LatencyStats, LatencyBreakdown } from '../db/repositories/metrics.js';
import { storageStatus } from '../db/storage.js';
import type { Logger } from '../util/logger.js';
import { isoNow, msBetween, minutesBetween } from '../util/time.js';
import {
  presentedSecret,
  secretsMatch,
  validateWebhookPayload,
  idempotencyKey,
  type NormalizedWebhookEvent,
} from './webhook.js';
import { dashboardHtml } from './dashboard.js';
import { validateDiscordPayload } from './discordWebhook.js';
import type { DiscordMessageEnvelope } from '../ingest/discordIntel/types.js';

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

/**
 * Discord intelligence intake. Separate from WebhookConfig on purpose: the X
 * contract is live, and a different payload shape has no business widening it.
 */
export interface DiscordIntelConfig {
  token: string;
  accept: DiscordAccepter;
}

/** Must not await processing — the bridge is acknowledged once the write lands. */
export type DiscordAccepter = (envelope: DiscordMessageEnvelope) => {
  accepted: boolean;
  duplicate: boolean;
  rejected: boolean;
  eventId: string;
  reason: string;
};

export interface ServerDeps {
  db: ScoutDb;
  logger: Logger;
  port: number;
  /** Critical dependency probes. All must pass for /ready to return 200. */
  readiness: () => Array<{ name: string; ok: boolean; detail?: string }>;
  startedAt?: Date;
  /** Where state lives, so /metrics can report whether the disk is persisting. */
  databasePath?: string;
  /** Omit to leave POST /webhook/news disabled. */
  webhook?: WebhookConfig;
  /** Omit to leave POST /admin/replay disabled. */
  admin?: AdminConfig;
  /** Omit to leave POST /webhook/discord disabled. */
  discordIntel?: DiscordIntelConfig;
  /**
   * Hand-submitted events from the dashboard. Authenticated with the admin
   * token, because unlike everything else the page shows, this one PUBLISHES.
   * Omit to leave POST /ingest disabled.
   */
  ingest?: {
    token: string;
    submit(input: { url: string | null; text: string }): { ok: boolean; id: string; error?: string };
  };
  /**
   * Channels Scout's own bot reads over the gateway. Reported in /metrics only
   * — the gateway path does not touch the HTTP server — so that "is my Discord
   * source live" has an answer that does not depend on the webhook.
   */
  intakeChannelIds?: string[];
  /**
   * Whether the Sprout hand-off has a URL configured.
   *
   * Reported because without it the dashboard shows Sprout with every event
   * SKIPPED and no reason, which reads as a broken delivery rather than an
   * optional downstream nobody wired up.
   */
  sproutConfigured?: boolean;
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

  /**
   * POST /webhook/discord — the Discord intelligence intake.
   *
   * Same contract as the X webhook: authenticate, validate, queue, acknowledge.
   * Nothing here awaits classification, Discord or Sprout. A message from a
   * channel that is not on the allowlist is answered 200 with `rejected`, not
   * an error — the bridge did nothing wrong, Scout simply is not configured to
   * process that channel, and a 4xx would make bridges retry forever.
   */
  async function handleDiscordIntel(req: IncomingMessage): Promise<{ status: number; body: string }> {
    const intel = deps.discordIntel;
    const receivedAt = isoNow();
    db.metrics.record('discord_requests_total', 1);

    if (!intel?.token) {
      db.metrics.record('discord_rejected_total', 1);
      return json({ error: 'discord intelligence ingestion is not configured' }, 503);
    }

    const provided = presentedSecret(req.headers as Record<string, string | string[] | undefined>);
    // Constant-time, and never logged.
    if (!provided || !secretsMatch(provided, intel.token)) {
      db.metrics.record('discord_rejected_total', 1);
      logger.warn('discord webhook authentication failed');
      return json({ error: 'unauthorized' }, 401);
    }

    let raw: string;
    try {
      raw = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      db.metrics.record('discord_rejected_total', 1);
      return json({ error: (err as Error).message }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      db.metrics.record('discord_rejected_total', 1);
      return json({ error: 'body is not valid JSON' }, 400);
    }

    const validated = validateDiscordPayload(parsed, receivedAt);
    if (!validated.ok) {
      db.metrics.record('discord_rejected_total', 1);
      return json({ error: validated.error }, validated.status);
    }

    try {
      const result = intel.accept(validated.envelope);

      if (result.rejected) {
        db.metrics.record('discord_filtered_total', 1);
        return json({ status: 'ignored', reason: result.reason, accepted: false }, 200);
      }
      if (result.duplicate) {
        db.metrics.record('discord_duplicates_total', 1);
        return json({ status: 'duplicate', id: result.eventId, accepted: false }, 200);
      }

      db.metrics.record('discord_events_accepted_total', 1);
      return json({ status: 'accepted', id: result.eventId, accepted: true }, 202);
    } catch (err) {
      logger.error('discord accept failed', { err: err as Error });
      return json({ error: 'could not queue the message' }, 500);
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

  /**
   * A hand-submitted event from the dashboard.
   *
   * The one authenticated action on that page: everything else it shows comes
   * from /metrics and is already public, but this one publishes to the trading
   * channels. Nothing about arriving here grants an event anything — it runs
   * the same dedupe, classification, scoring and routing as a webhook, and the
   * filters may well decline it.
   */
  async function handleIngest(req: IncomingMessage): Promise<{ status: number; body: string }> {
    const ingest = deps.ingest;
    if (!ingest?.token) {
      return json(
        { error: 'manual ingestion is not configured — set SCOUT_ADMIN_TOKEN to enable it' },
        503,
      );
    }

    const provided = presentedSecret(req.headers as Record<string, string | string[] | undefined>);
    if (!provided || !secretsMatch(provided, ingest.token)) {
      logger.warn('ingest authentication failed');
      return json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_WEBHOOK_BODY_BYTES));
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }

    const input = body as { url?: unknown; text?: unknown };
    const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null;
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!url && !text) return json({ error: 'give a url, some text, or both' }, 400);

    try {
      const result = ingest.submit({ url, text });
      return result.ok
        ? json({ status: 'accepted', id: result.id }, 202)
        : json({ error: result.error ?? 'not accepted' }, 400);
    } catch (err) {
      logger.error('manual ingest failed', { err: err as Error });
      return json({ error: 'ingest failed' }, 500);
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
      // Health is only meaningful for sources that are actually polled. A
      // source disabled in config keeps its last health row forever — so a feed
      // switched off precisely BECAUSE it was broken went on being reported as
      // broken, which makes the fix look like it did not work and buries any
      // genuine failure underneath.
      const enabledIds = new Set(db.sources.enabled().map((s) => s.id));
      const healthRows = db.health.all().filter((r) => enabledIds.has(r.sourceId));

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
        // Whether the persistent disk is actually persisting. `boots` counts
        // process starts recorded IN the database, so it can only climb if the
        // file survived. Still reading 1 after a redeploy means the disk is not
        // attached and dedupe/delivery/calendar state is being wiped each time.
        storage: storageStatus(db, deps.databasePath ?? 'unknown'),
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
        events: {
          byStatus: statuses,
          eventsPerMinute: Number((published / windowMinutes).toFixed(3)),
          duplicatesTotal: summary.duplicates ?? 0,
          rejectedTotal: summary.posts_rejected ?? 0,
          // The two freshness-gate outcomes, kept apart on purpose: an upstream
          // source that stopped sending timestamps and news that aged out
          // before delivery are different faults with different fixes.
          staleTotal: summary.events_stale_total ?? 0,
          unknownPublicationTimeTotal: summary.events_unknown_time_total ?? 0,
        },
        deliveries,
        // Split by destination, because a rising FAILED count is useless until
        // you know whether it is Sprout or Discord.
        deliveriesByDestination: db.deliveries.countsByDestination(since),
        sprout: {
          configured: Boolean(deps.sproutConfigured),
          deliveredTotal: summary.sprout_delivered_total ?? 0,
          failedTotal: summary.sprout_failed_total ?? 0,
          skippedTotal: summary.sprout_skipped_total ?? 0,
          latencyMsAvg: Math.round(summary['sprout_delivery_ms.avg'] ?? 0),
          samples: summary['sprout_delivery_ms.count'] ?? 0,
        },
        discord: {
          // Two independent ways in, and reporting only the webhook read as
          // "Discord is not configured" on a deployment whose intake channel
          // was running fine. Both are named, so the answer to "is my Discord
          // source live" is actually in here.
          webhookConfigured: Boolean(deps.discordIntel?.token),
          intakeChannels: deps.intakeChannelIds?.length ?? 0,
          configured: Boolean(deps.discordIntel?.token) || (deps.intakeChannelIds?.length ?? 0) > 0,
          requestsTotal: summary.discord_requests_total ?? 0,
          rejectedTotal: summary.discord_rejected_total ?? 0,
          filteredTotal: summary.discord_filtered_total ?? 0,
          duplicatesTotal: summary.discord_duplicates_total ?? 0,
          eventsAcceptedTotal: summary.discord_events_accepted_total ?? 0,
        },
        replay: {
          runsTotal: summary.replay_runs_total ?? 0,
          // What the automatic recovery actually bought.
          recoveredTotal: summary.replay_recovered_total ?? 0,
          stillFailingTotal: summary.replay_still_failing_total ?? 0,
          deferredTotal: summary.replay_deferred_total ?? 0,
        },
        latencyMs: {
          count: latency.count,
          avg: Math.round(latency.avg),
          p95: Math.round(latency.p95),
          p99: Math.round(latency.p99),
          // Per stage, because "Scout is slow" and "the source is slow" are
          // different problems and a blended number cannot tell them apart.
          byStage: roundStages(db.metrics.latencyBreakdown(since)),
        },
        sources: {
          byState: feedHealth,
          // A named list of anything not ACTIVE, because "which feed is down"
          // is the question an operator actually has.
          // Named, WITH the reason. "rss:bea-news is DISCONNECTED" tells an
          // operator which feed is down and nothing about why, which turns a
          // ten-second fix into a log-diving session — and the reason was
          // already stored, just never surfaced. A 404 means the URL moved; a
          // 403 usually means the User-Agent; a timeout means neither.
          //
          // These are Scout's own fetch errors against public feeds. They carry
          // no credential and no request headers, so /metrics stays safe to
          // leave public.
          degraded: healthRows
            .filter((r) => r.state !== 'ACTIVE')
            .map((r) => ({
              sourceId: r.sourceId,
              state: r.state,
              lastItemAt: r.lastItemAt,
              lastError: r.lastError,
              lastErrorAt: r.lastErrorAt,
              consecutiveFailures: r.consecutiveFailures,
            })),
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

        const respond = (result: {
          status: number;
          body: string;
          contentType?: string;
        }): void => {
          res.writeHead(result.status, {
            'content-type': result.contentType ?? 'application/json; charset=utf-8',
          });
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

        // The dashboard. Read-only, and shows nothing /metrics does not.
        if (path === '/' || path === '/dashboard') {
          respond({
            status: 200,
            body: dashboardHtml(),
            contentType: 'text/html; charset=utf-8',
          });
          return;
        }

        if (path === '/ingest') {
          if (req.method !== 'POST') {
            respond(json({ error: 'method not allowed' }, 405));
            return;
          }
          void handleIngest(req)
            .then(respond)
            .catch((err: Error) => {
              logger.error('ingest handler threw', { err });
              respond(json({ error: 'internal error' }, 500));
            });
          return;
        }

        if (path === '/webhook/discord') {
          if (req.method !== 'POST') {
            respond(json({ error: 'method not allowed' }, 405));
            return;
          }
          void handleDiscordIntel(req)
            .then(respond)
            .catch((err: Error) => {
              logger.error('discord webhook handler threw', { err });
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

/** Sub-millisecond precision is noise in a latency report. */
function roundStages(breakdown: LatencyBreakdown): Record<string, LatencyStats> {
  const round = (s: LatencyStats): LatencyStats => ({
    count: s.count,
    avg: Math.round(s.avg),
    p95: Math.round(s.p95),
    p99: Math.round(s.p99),
  });
  return {
    sourceToScout: round(breakdown.sourceToScout),
    scoutToDiscord: round(breakdown.scoutToDiscord),
    total: round(breakdown.total),
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
