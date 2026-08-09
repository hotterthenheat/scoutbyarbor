import type { NewsEvent, EventCluster } from '../core/types.js';
import type { MarketImpactVerdict } from '../pipeline/marketImpact.js';
import type { Logger } from '../util/logger.js';
import { isoNow } from '../util/time.js';

/**
 * Scout → Sprout.
 *
 * Scout is the information layer; Sprout consumes normalized events for
 * news-aware trading restrictions. Two rules govern what crosses this boundary:
 *
 *   - Only events that pass the freshness gate. A headline whose publication
 *     time is unknown or outside the window may still appear in #scout-news,
 *     but handing it to a trading system would let a recycled story open a new
 *     blackout.
 *   - Never a blocker. Sprout being unreachable must not stop Scout publishing
 *     to Discord — the wire keeps running and the delivery is recorded as
 *     failed for retry.
 *
 * With no SPROUT_URL configured this is inert, which is the normal MVP state.
 */

export interface SproutEvent {
  eventId: string;
  slug: string;
  postId: string | null;
  headline: string;
  body: string;
  category: string | null;
  subcategory: string | null;
  severity: string;
  macro: boolean;
  marketRelevance: string;
  marketMoving: boolean;
  tickers: string[];
  countries: string[];
  entities: string[];
  publishedAt: string | null;
  detectedAt: string;
  sentAt: string;
  sourceCount: number;
}

export interface SproutDeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  skipped: boolean;
  reason: string;
}

export interface SproutClient {
  readonly enabled: boolean;
  send(event: SproutEvent): Promise<SproutDeliveryResult>;
}

export interface SproutClientDeps {
  url: string;
  token: string;
  timeoutMs: number;
  logger: Logger;
}

export function createSproutClient(deps: SproutClientDeps): SproutClient {
  const enabled = Boolean(deps.url);

  return {
    enabled,

    async send(event: SproutEvent): Promise<SproutDeliveryResult> {
      if (!enabled) {
        return { ok: false, status: null, error: null, skipped: true, reason: 'SPROUT_URL not configured' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

      try {
        const response = await fetch(deps.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {}),
            // Lets Sprout collapse a duplicate delivery after a Scout restart.
            'idempotency-key': event.eventId,
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        });

        // Drain the body inside the deadline so a stalled response cannot hang
        // the caller.
        const text = await response.text().catch(() => '');

        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error: `HTTP ${response.status} ${response.statusText} ${text.slice(0, 200)}`.trim(),
            skipped: false,
            reason: 'rejected by Sprout',
          };
        }
        return { ok: true, status: response.status, error: null, skipped: false, reason: 'delivered' };
      } catch (err) {
        const aborted = (err as Error).name === 'AbortError';
        return {
          ok: false,
          status: null,
          error: aborted ? `timed out after ${deps.timeoutMs}ms` : (err as Error).message,
          skipped: false,
          reason: 'unreachable',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Builds the payload from Scout's own normalized event. Deliberately carries
 * the severity band and market relevance — unlike a Discord alert, a trading
 * system is exactly who those are for.
 */
export function toSproutEvent(input: {
  newsEvent: NewsEvent;
  cluster: EventCluster | null;
  impact: MarketImpactVerdict | null;
  publishedAt: string | null;
}): SproutEvent {
  const { newsEvent, cluster, impact } = input;

  return {
    eventId: cluster?.id ?? newsEvent.id,
    slug: cluster?.slug ?? '',
    postId: typeof newsEvent.entities === 'object' ? (newsEvent.sourcePostId ?? null) : null,
    headline: newsEvent.headline,
    body: newsEvent.body,
    category: newsEvent.category,
    subcategory: newsEvent.subcategory,
    severity: newsEvent.score?.band ?? 'LOW',
    macro: impact?.macro ?? false,
    marketRelevance: impact?.relevance ?? 'none',
    marketMoving: impact?.marketMoving ?? false,
    tickers: newsEvent.tickers,
    countries: newsEvent.countries,
    entities: [...newsEvent.entities.organizations, ...newsEvent.entities.people],
    publishedAt: input.publishedAt,
    detectedAt: newsEvent.latency.ingestionTime,
    sentAt: isoNow(),
    sourceCount: cluster?.sourceCount ?? 1,
  };
}
