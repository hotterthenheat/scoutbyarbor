import type {
  IngestAdapter,
  IngestResult,
  RawPost,
  Source,
  SourceVerification,
} from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import { isoNow } from '../../util/time.js';
import { normalizeWhitespace, stripHtml, describeFetchError } from '../../util/text.js';

/**
 * Finnhub market-news adapter.
 *
 * A polled aggregator: Scout asks for the news, on a timer, with an API key.
 * Nothing has to be pasted, forwarded, or pushed by anyone — which is the whole
 * point of it next to the webhook, and why it is the closest thing to a wire
 * that a free key can buy.
 *
 * ── FINNHUB IS A TRANSPORT, NOT A SOURCE ─────────────────────────────────────
 *
 * Every item carries a `source` field naming who actually reported it — CNBC,
 * Reuters, MarketWatch. Attributing the story to "Finnhub" would be the same
 * mistake as crediting a forwarding bot for a message it relayed: it names the
 * pipe rather than the reporter, and it makes two outlets reporting one story
 * look like one outlet reporting twice.
 *
 * So the publisher becomes the organisation for corroboration purposes, and a
 * story that Finnhub and an RSS feed both carry from the same outlet counts
 * once — not twice.
 *
 * ── PUBLICATION TIME ─────────────────────────────────────────────────────────
 *
 * `datetime` is a real unix timestamp from the publisher, so `publishedAt` is
 * genuine and the freshness gate works normally. An item with no usable
 * timestamp gets `publishedAt: null` rather than the time Scout fetched it —
 * receipt time is never promoted here, exactly as everywhere else.
 */

const API_BASE = 'https://finnhub.io/api/v1';

/** Finnhub's own categories. `general` is the market-wide wire. */
export type FinnhubCategory = 'general' | 'forex' | 'crypto' | 'merger';

/**
 * How far back an item may be and still be emitted on a cold start.
 *
 * The endpoint returns a rolling window, so a first poll would otherwise treat
 * hours of history as breaking. Cold-start priming upstream withholds a
 * source's first batch anyway; this is the second line, and it also bounds what
 * a long outage replays when the process comes back.
 */
const MAX_ITEM_AGE_MS = 60 * 60_000;

/** Ids already emitted, so a rolling window does not re-emit its overlap. */
const MAX_SEEN_IDS = 2_000;

export interface FinnhubAdapterDeps {
  apiKey: string;
  timeoutMs: number;
  logger: Logger;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface FinnhubItem {
  id?: number;
  category?: string;
  datetime?: number;
  headline?: string;
  summary?: string;
  source?: string;
  url?: string;
  related?: string;
}

/**
 * The category a source polls, read off its id: `finnhub:general` → `general`.
 * Config is data, so the category rides in the id rather than in code.
 */
export function categoryOf(sourceId: string): FinnhubCategory {
  const suffix = sourceId.split(':')[1]?.trim().toLowerCase();
  if (suffix === 'forex' || suffix === 'crypto' || suffix === 'merger') return suffix;
  return 'general';
}

/** `Reuters` → `reuters`. The corroboration identity, not a display name. */
export function orgFor(publisher: string | null): string | null {
  const cleaned = publisher?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return cleaned ? cleaned : null;
}

export function createFinnhubAdapter(deps: FinnhubAdapterDeps): IngestAdapter {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const seenBySource = new Map<string, Set<string>>();

  async function request(category: FinnhubCategory): Promise<FinnhubItem[]> {
    const url = `${API_BASE}/news?category=${category}&token=${encodeURIComponent(deps.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });

      if (res.status === 401 || res.status === 403) {
        // A bad key is not a transient failure and retrying will not fix it.
        // The message says so plainly rather than surfacing as "poll failed".
        throw new Error(
          `Finnhub rejected the API key (HTTP ${res.status}). Check FINNHUB_API_KEY.`,
        );
      }
      if (res.status === 429) {
        throw new Error('Finnhub rate limit reached (HTTP 429); backing off until the next poll');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from Finnhub /news`);

      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error('Finnhub /news did not return an array');
      return body as FinnhubItem[];
    } finally {
      clearTimeout(timer);
    }
  }

  /** One API item → a RawPost, or null when it carries nothing usable. */
  function toPost(item: FinnhubItem, source: Source): RawPost | null {
    const headline = normalizeWhitespace(stripHtml(item.headline ?? ''));
    if (!headline) return null;

    const summary = normalizeWhitespace(stripHtml(item.summary ?? ''));
    // Headline first: the normalizer downstream reads the first line as one.
    const text = summary && summary !== headline ? `${headline}\n\n${summary}` : headline;

    // Seconds, per the API. Anything non-finite means the publisher did not
    // state a time, and null is the correct answer for that.
    const ms = typeof item.datetime === 'number' && item.datetime > 0 ? item.datetime * 1000 : null;
    const publishedAt = ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

    const publisher = item.source?.trim() || null;
    const id = item.id != null ? String(item.id) : (item.url ?? headline);

    return {
      sourceId: source.id,
      sourcePostId: `finnhub:${id}`,
      originalUrl: item.url ?? null,
      // The outlet that reported it, never "Finnhub".
      author: publisher,
      text,
      // Orders the pipeline, so it must always be real. publishedAt below is
      // the one the freshness gate reads, and it stays null when unknown.
      eventTime: publishedAt ?? isoNow(),
      ingestionTime: isoNow(),
      meta: {
        publishedAt,
        publishedAtKnown: publishedAt !== null,
        provenance: 'finnhub',
        platform: 'finnhub',
        retrievalSource: 'finnhub-api',
        // Read by the provenance layer so corroboration counts OUTLETS. Two
        // stories relayed by Finnhub from one outlet are one confirmation.
        publisher,
        publisherOrg: orgFor(publisher),
        finnhubId: item.id ?? null,
        finnhubCategory: item.category ?? null,
        // Comma-separated tickers the API attached. The extractor still does
        // its own work; this is a hint recorded for audit, not a shortcut.
        related: item.related ?? null,
      },
    };
  }

  return {
    type: 'finnhub',

    async poll(sources: Source[]): Promise<IngestResult> {
      const posts: RawPost[] = [];
      const outcomes: IngestResult['outcomes'] = [];
      const cutoff = now() - MAX_ITEM_AGE_MS;

      for (const source of sources) {
        const startedAt = Date.now();
        try {
          const items = await request(categoryOf(source.id));
          const seen = seenBySource.get(source.id) ?? new Set<string>();
          let fresh = 0;

          for (const item of items) {
            const post = toPost(item, source);
            if (!post) continue;
            if (seen.has(post.sourcePostId)) continue;

            // A rolling window replays its overlap on every poll, so the age
            // bound is what stops a restart re-emitting an hour of history.
            const at =
              typeof post.meta.publishedAt === 'string' ? Date.parse(post.meta.publishedAt) : NaN;
            if (Number.isFinite(at) && at < cutoff) {
              seen.add(post.sourcePostId);
              continue;
            }

            seen.add(post.sourcePostId);
            posts.push(post);
            fresh += 1;
          }

          seenBySource.set(
            source.id,
            seen.size > MAX_SEEN_IDS ? new Set([...seen].slice(-MAX_SEEN_IDS)) : seen,
          );

          outcomes.push({
            sourceId: source.id,
            ok: true,
            itemCount: fresh,
            latencyMs: Date.now() - startedAt,
          });
        } catch (rawErr) {
          const message = describeFetchError(rawErr, deps.timeoutMs);
          deps.logger.warn('finnhub poll failed', { sourceId: source.id, err: message });
          outcomes.push({
            sourceId: source.id,
            ok: false,
            itemCount: 0,
            error: message,
            latencyMs: Date.now() - startedAt,
          });
        }
      }

      return { posts, outcomes };
    },

    async verify(source: Source): Promise<SourceVerification> {
      try {
        const items = await request(categoryOf(source.id));
        return {
          sourceId: source.id,
          ok: true,
          detail: `${items.length} item(s) available`,
        };
      } catch (err) {
        return {
          sourceId: source.id,
          ok: false,
          detail: (err as Error).message,
        };
      }
    },
  };
}
