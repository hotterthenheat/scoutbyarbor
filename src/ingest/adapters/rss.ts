import { XMLParser } from 'fast-xml-parser';
import type { IngestAdapter, IngestResult, RawPost, Source, SourceVerification } from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import { deterministicId } from '../../util/id.js';
import { isoNow } from '../../util/time.js';
import { normalizeWhitespace, stripHtml } from '../../util/text.js';

/**
 * RSS / Atom adapter.
 *
 * This is the layer that makes Scout useful without any API key: the Fed, BLS,
 * BEA, Treasury, the SEC and the central banks all publish here, and they are
 * the highest-credibility sources in the system.
 *
 * Two details matter operationally:
 *   - Conditional requests. A 304 is a SUCCESSFUL poll with zero items, which
 *     is exactly the "quiet, not broken" distinction §23 depends on.
 *   - First-poll capping. A new feed must not alert on its entire backlog.
 */

const FIRST_POLL_ITEM_CAP = 5;
/**
 * On the very first poll of a feed Scout has no watermark, so it would
 * otherwise treat the whole page as new. Emitting nothing would mean a restart
 * during a major event misses it; emitting everything means a cold boot floods
 * the wire with a backlog. Only genuinely fresh items pass.
 */
const FIRST_POLL_MAX_AGE_MS = 15 * 60_000;

export interface RssAdapterDeps {
  userAgent: string;
  timeoutMs: number;
  logger: Logger;
}

interface FeedState {
  etag?: string;
  lastModified?: string;
  lastSeenAt?: number;
  /**
   * Ids already emitted. Timestamps alone are not enough: feeds routinely
   * publish two items in the same second — the FOMC statement and its
   * implementation note are both stamped 14:00:00 — and a `<=` watermark drops
   * one of them permanently.
   */
  seenIds?: Set<string>;
  seeded: boolean;
}

/** Cap on remembered ids per feed, so the set cannot grow without bound. */
const MAX_SEEN_IDS = 400;

export function createRssAdapter(deps: RssAdapterDeps): IngestAdapter {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
  });
  const state = new Map<string, FeedState>();

  async function pollOne(source: Source): Promise<{ posts: RawPost[]; itemCount: number }> {
    if (!source.url) throw new Error(`source ${source.id} has no url`);
    const feedState = state.get(source.id) ?? { seeded: false };

    const headers: Record<string, string> = {
      'user-agent': deps.userAgent,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    };
    if (feedState.etag) headers['if-none-match'] = feedState.etag;
    if (feedState.lastModified) headers['if-modified-since'] = feedState.lastModified;

    const response = await fetchTextWithTimeout(source.url, headers, deps.timeoutMs);

    // Not modified: a healthy poll that produced nothing.
    if (response.status === 304) {
      state.set(source.id, feedState);
      return { posts: [], itemCount: 0 };
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    const items = parseFeed(parser, response.text);

    const ingestionTime = isoNow();
    const posts: RawPost[] = [];

    const seenIds = feedState.seenIds ?? new Set<string>();

    for (const item of items) {
      const publishedMs = Date.parse(item.published);
      if (seenIds.has(item.id)) continue;
      // Strictly older than the watermark is definitely stale; equal timestamps
      // fall through to the id check above.
      if (feedState.seeded && feedState.lastSeenAt && publishedMs < feedState.lastSeenAt) continue;

      posts.push({
        sourceId: source.id,
        sourcePostId: item.id,
        originalUrl: item.link,
        author: source.name,
        text: item.text,
        eventTime: Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : ingestionTime,
        ingestionTime,
        meta: { feedTitle: item.title, rss: true },
      });
      seenIds.add(item.id);
    }

    posts.sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime));

    const newest = items.reduce((max, i) => Math.max(max, Date.parse(i.published) || 0), 0);
    state.set(source.id, {
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      lastSeenAt: Math.max(newest, feedState.lastSeenAt ?? 0),
      seenIds: seenIds.size > MAX_SEEN_IDS ? new Set([...seenIds].slice(-MAX_SEEN_IDS)) : seenIds,
      seeded: true,
    });

    const emitted = feedState.seeded
      ? posts
      : posts
          .filter((p) => Date.now() - Date.parse(p.eventTime) <= FIRST_POLL_MAX_AGE_MS)
          .slice(-FIRST_POLL_ITEM_CAP);

    if (!feedState.seeded && emitted.length < posts.length) {
      deps.logger.info('seeded feed, skipped backlog', {
        sourceId: source.id,
        skipped: posts.length - emitted.length,
      });
    }

    return { posts: emitted, itemCount: items.length };
  }

  return {
    type: 'rss',

    async poll(sources: Source[]): Promise<IngestResult> {
      const result: IngestResult = { posts: [], outcomes: [] };

      for (const source of sources) {
        const started = Date.now();
        try {
          const { posts, itemCount } = await pollOne(source);
          result.posts.push(...posts);
          result.outcomes.push({
            sourceId: source.id,
            ok: true,
            itemCount,
            latencyMs: Date.now() - started,
          });
        } catch (err) {
          deps.logger.warn('rss poll failed', { sourceId: source.id, err: err as Error });
          result.outcomes.push({
            sourceId: source.id,
            ok: false,
            itemCount: 0,
            error: (err as Error).message,
            latencyMs: Date.now() - started,
          });
        }
      }
      return result;
    },

    async verify(source: Source): Promise<SourceVerification> {
      if (!source.url) {
        return { sourceId: source.id, ok: false, detail: 'no url configured' };
      }
      try {
        const response = await fetchTextWithTimeout(
          source.url,
          { 'user-agent': deps.userAgent, accept: 'application/rss+xml, application/xml, */*' },
          deps.timeoutMs,
        );
        if (!response.ok) {
          return {
            sourceId: source.id,
            ok: false,
            detail: `HTTP ${response.status} ${response.statusText}`,
          };
        }
        const items = parseFeed(parser, response.text);
        if (items.length === 0) {
          return { sourceId: source.id, ok: false, detail: 'response parsed but contained no items' };
        }
        return {
          sourceId: source.id,
          ok: true,
          resolvedName: source.name,
          detail: `${items.length} items; newest ${items[0]?.published ?? 'unknown'}`,
        };
      } catch (err) {
        return { sourceId: source.id, ok: false, detail: (err as Error).message };
      }
    },
  };
}

interface FeedItem {
  id: string;
  title: string;
  text: string;
  link: string | null;
  published: string;
}

/** Handles the RSS 2.0 / Atom shape differences in one place. */
export function parseFeed(parser: XMLParser, xml: string): FeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const rssChannel = (doc.rss as { channel?: unknown } | undefined)?.channel;
  const rawItems =
    asArray((rssChannel as { item?: unknown } | undefined)?.item) ??
    asArray((doc.feed as { entry?: unknown } | undefined)?.entry) ??
    asArray((doc['rdf:RDF'] as { item?: unknown } | undefined)?.item) ??
    [];

  const items: FeedItem[] = [];

  for (const raw of rawItems) {
    const entry = raw as Record<string, unknown>;
    const title = stripHtml(textOf(entry.title));
    const summary = stripHtml(
      textOf(entry.description) || textOf(entry.summary) || textOf(entry['content:encoded']) || textOf(entry.content),
    );
    const link = linkOf(entry);
    const published =
      textOf(entry.pubDate) ||
      textOf(entry.published) ||
      textOf(entry.updated) ||
      textOf(entry['dc:date']) ||
      '';

    if (!title && !summary) continue;

    const id =
      textOf(entry.guid) || textOf(entry.id) || deterministicId(link ?? '', title).slice(0, 24);

    items.push({
      id,
      title,
      // Headline first, then the summary — matches how the normalizer splits.
      text: summary ? `${title} — ${summary}` : title,
      link,
      published: published || new Date().toISOString(),
    });
  }

  return items.sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
}

function asArray(value: unknown): Record<string, unknown>[] | null {
  if (!value) return null;
  return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
}

/** Feed fields arrive as a string, a number, or `{ '#text': ... }`. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return normalizeWhitespace(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string' || typeof text === 'number') return normalizeWhitespace(String(text));
  }
  return '';
}

/** RSS uses a text `<link>`; Atom uses `<link href="...">`. */
function linkOf(entry: Record<string, unknown>): string | null {
  const link = entry.link;
  if (typeof link === 'string') return link.trim() || null;

  if (Array.isArray(link)) {
    const alternate =
      link.find((l) => (l as Record<string, unknown>)?.['@_rel'] === 'alternate') ?? link[0];
    const href = (alternate as Record<string, unknown> | undefined)?.['@_href'];
    return typeof href === 'string' ? href : null;
  }
  if (link && typeof link === 'object') {
    const href = (link as Record<string, unknown>)['@_href'];
    if (typeof href === 'string') return href;
    const text = (link as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * Fetches AND reads the body under one deadline. Clearing the abort timer when
 * the headers arrive leaves the body read unbounded, so a server that stalls
 * mid-response would hang the poll loop indefinitely.
 */
async function fetchTextWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; statusText: string; ok: boolean; headers: Headers; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    // 304 has no body; reading it is a no-op but keeps the shape uniform.
    const text = response.status === 304 ? '' : await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: response.headers,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}
