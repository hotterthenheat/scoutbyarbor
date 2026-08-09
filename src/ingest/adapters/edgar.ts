import { XMLParser } from 'fast-xml-parser';
import type { IngestAdapter, IngestResult, RawPost, Source, SourceVerification } from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import { parseEdgarTitle, extract8kItems } from '../../pipeline/classify/filings.js';
import { deterministicId } from '../../util/id.js';
import { isoNow } from '../../util/time.js';
import { normalizeWhitespace, stripHtml } from '../../util/text.js';

/**
 * SEC EDGAR adapter (§16).
 *
 * EDGAR requires a descriptive User-Agent with contact information or it
 * returns 403, and it asks for no more than 10 requests/second — we stay under
 * that deliberately. Form type, CIK, company and accession number go into meta
 * so the filings classifier never has to re-parse the title.
 */

const MIN_REQUEST_SPACING_MS = 125; // ~8 req/s across the whole adapter
const FIRST_POLL_ITEM_CAP = 10;
/** Same cold-start rule as the RSS adapter: fresh only, never a backlog. */
const FIRST_POLL_MAX_AGE_MS = 15 * 60_000;

export interface EdgarAdapterDeps {
  userAgent: string;
  timeoutMs: number;
  logger: Logger;
}

export function createEdgarAdapter(deps: EdgarAdapterDeps): IngestAdapter {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const seen = new Map<string, Set<string>>();
  let lastRequestAt = 0;

  async function throttle(): Promise<void> {
    const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  }

  /** Fetches and reads the body under a single deadline. */
  async function requestText(url: string): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
    const response = await request(url);
    const text = await response.text();
    return { ok: response.ok, status: response.status, statusText: response.statusText, text };
  }

  async function request(url: string): Promise<Response> {
    if (!deps.userAgent || !/@|\bhttps?:/i.test(deps.userAgent)) {
      throw new Error(
        'SEC_USER_AGENT must include contact information (e.g. "Firm Name ops@example.com") or EDGAR returns 403',
      );
    }
    await throttle();
    const controller = new AbortController();
    // Deliberately NOT cleared here: requestText reads the body afterwards and
    // must stay under the same deadline. The timer is unref'd so it cannot hold
    // the process open.
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      return await fetch(url, {
        headers: {
          'user-agent': deps.userAgent,
          accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
          'accept-encoding': 'gzip, deflate',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async function pollOne(source: Source): Promise<{ posts: RawPost[]; itemCount: number }> {
    if (!source.url) throw new Error(`source ${source.id} has no url`);

    const response = await requestText(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const entries = parseAtomEntries(parser, response.text);
    const known = seen.get(source.id);
    const isFirstPoll = known === undefined;
    const knownSet = known ?? new Set<string>();

    const ingestionTime = isoNow();
    const posts: RawPost[] = [];

    for (const entry of entries) {
      if (knownSet.has(entry.id)) continue;
      knownSet.add(entry.id);

      const parsed = parseEdgarTitle(entry.title);
      const filedAt = Date.parse(entry.updated);

      posts.push({
        sourceId: source.id,
        sourcePostId: entry.id,
        originalUrl: entry.link,
        author: parsed?.company ?? 'SEC EDGAR',
        text: entry.summary ? `${entry.title} — ${entry.summary}` : entry.title,
        eventTime: Number.isFinite(filedAt) ? new Date(filedAt).toISOString() : ingestionTime,
        ingestionTime,
        meta: {
          // The filing time, or null when the feed did not carry one.
          publishedAt: Number.isFinite(filedAt) ? new Date(filedAt).toISOString() : null,
          form: parsed?.form ?? entry.category ?? '',
          company: parsed?.company ?? '',
          cik: parsed?.cik ?? '',
          title: entry.title,
          items: extract8kItems(`${entry.title} ${entry.summary}`),
          accessionNumber: accessionFrom(entry.link),
          edgar: true,
        },
      });
    }

    // Keep the seen-set bounded; EDGAR ids are only useful for a short window.
    if (knownSet.size > 4000) {
      seen.set(source.id, new Set([...knownSet].slice(-2000)));
    } else {
      seen.set(source.id, knownSet);
    }

    return {
      posts: isFirstPoll
        ? posts
            .filter((p) => Date.now() - Date.parse(p.eventTime) <= FIRST_POLL_MAX_AGE_MS)
            .slice(0, FIRST_POLL_ITEM_CAP)
        : posts,
      itemCount: entries.length,
    };
  }

  return {
    type: 'edgar',

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
          deps.logger.warn('edgar poll failed', { sourceId: source.id, err: err as Error });
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

    async fetchOne(source: Source, accessionNumber: string): Promise<RawPost | null> {
      const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&output=atom&accession_number=${encodeURIComponent(accessionNumber)}`;
      const response = await requestText(url);
      if (!response.ok) return null;
      const entries = parseAtomEntries(parser, response.text);
      const entry = entries[0];
      if (!entry) return null;

      const parsed = parseEdgarTitle(entry.title);
      return {
        sourceId: source.id,
        sourcePostId: entry.id,
        originalUrl: entry.link,
        author: parsed?.company ?? 'SEC EDGAR',
        text: entry.title,
        eventTime: entry.updated || isoNow(),
        ingestionTime: isoNow(),
        meta: {
          publishedAt: entry.updated || null,
          form: parsed?.form ?? '',
          company: parsed?.company ?? '',
          cik: parsed?.cik ?? '',
          title: entry.title,
          items: extract8kItems(entry.title),
          accessionNumber,
        },
      };
    },

    async verify(source: Source): Promise<SourceVerification> {
      if (!source.url) return { sourceId: source.id, ok: false, detail: 'no url configured' };
      try {
        const response = await requestText(source.url);
        if (!response.ok) {
          return {
            sourceId: source.id,
            ok: false,
            detail: `HTTP ${response.status} ${response.statusText}${response.status === 403 ? ' — check SEC_USER_AGENT includes contact info' : ''}`,
          };
        }
        const entries = parseAtomEntries(parser, response.text);
        return entries.length > 0
          ? { sourceId: source.id, ok: true, resolvedName: source.name, detail: `${entries.length} filings` }
          : { sourceId: source.id, ok: false, detail: 'feed parsed but contained no entries' };
      } catch (err) {
        return { sourceId: source.id, ok: false, detail: (err as Error).message };
      }
    },
  };
}

interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  link: string | null;
  updated: string;
  category: string | null;
}

function parseAtomEntries(parser: XMLParser, xml: string): AtomEntry[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const feed = doc.feed as { entry?: unknown } | undefined;
  const raw = feed?.entry;
  if (!raw) return [];
  const list = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];

  return list.map((entry) => {
    const link = entry.link as Record<string, unknown> | undefined;
    const href = Array.isArray(link)
      ? ((link[0] as Record<string, unknown> | undefined)?.['@_href'] as string | undefined)
      : (link?.['@_href'] as string | undefined);
    const title = normalizeWhitespace(String(entry.title ?? ''));
    const category = entry.category as Record<string, unknown> | undefined;

    return {
      id: String(entry.id ?? deterministicId(href ?? '', title).slice(0, 24)),
      title,
      summary: stripHtml(String(entry.summary ?? '')),
      link: href ?? null,
      updated: String(entry.updated ?? entry.published ?? ''),
      category: (category?.['@_term'] as string | undefined) ?? null,
    };
  });
}

function accessionFrom(url: string | null): string | null {
  if (!url) return null;
  const m = /(\d{10}-\d{2}-\d{6})/.exec(url);
  return m?.[1] ?? null;
}
