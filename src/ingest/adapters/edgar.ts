import { XMLParser } from 'fast-xml-parser';
import type { IngestAdapter, IngestResult, RawPost, Source, SourceVerification } from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import { describeFetchError } from '../../util/text.js';
import { parseEdgarTitle, extract8kItems, describe8kItems } from '../../pipeline/classify/filings.js';
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
  /**
   * Test seam. Every other adapter has one; this did not, which meant the
   * EDGAR parse path could only be exercised against the live SEC endpoint —
   * so in practice it was never exercised at all. 8-K filings are the highest
   * volume equity signal Scout has, and "polling fine, has never once produced
   * an item" is exactly the failure a parser test catches.
   */
  fetchImpl?: typeof fetch;
}

export function createEdgarAdapter(deps: EdgarAdapterDeps): IngestAdapter {
  const doFetch = deps.fetchImpl ?? fetch;
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
      return await doFetch(url, {
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
      const items = extract8kItems(`${entry.title} ${entry.summary}`);

      posts.push({
        sourceId: source.id,
        sourcePostId: entry.id,
        originalUrl: entry.link,
        author: parsed?.company ?? 'SEC EDGAR',
        text: describeFiling(parsed, entry, items),
        eventTime: Number.isFinite(filedAt) ? new Date(filedAt).toISOString() : ingestionTime,
        ingestionTime,
        meta: {
          // The filing time, or null when the feed did not carry one.
          publishedAt: Number.isFinite(filedAt) ? new Date(filedAt).toISOString() : null,
          form: parsed?.form ?? entry.category ?? '',
          company: parsed?.company ?? '',
          cik: parsed?.cik ?? '',
          title: entry.title,
          items,
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
          // "This operation was aborted" is the DOM's wording for a deadline
          // Scout itself set, and says nothing an operator can act on.
          const message = describeFetchError(err, deps.timeoutMs);
          deps.logger.warn('edgar poll failed', { sourceId: source.id, err: message });
          result.outcomes.push({
            sourceId: source.id,
            ok: false,
            itemCount: 0,
            error: message,
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

/**
 * Turns a filing into a sentence the classifier can read.
 *
 * EDGAR states the event in a code, not in words: "Items: 1.03" is a
 * bankruptcy, and the taxonomy has no way to know that. Expanding the codes
 * into SEC's own descriptions puts the actual vocabulary — "bankruptcy or
 * receivership", "material impairment", "delisting" — in front of a classifier
 * that was otherwise reading accession numbers and rejecting every filing as
 * uncategorisable.
 *
 * The company name leads, because a filing is a single-name event and the
 * subject gate requires one.
 */
function describeFiling(
  parsed: { form: string; company: string; cik: string } | null,
  entry: AtomEntry,
  items: string[],
): string {
  const company = parsed?.company ?? '';
  const form = parsed?.form ?? entry.category ?? '';
  const described = describe8kItems(items);

  if (company && described.length > 0) {
    // Company and event ONLY. Boilerplate is poison here: dedupe treats shared
    // significant tokens as entity agreement and merges anything above a 0.4
    // similarity floor, so adding "files 8-K" and "(items 1.03)" to every
    // headline gave all filings enough common vocabulary to collapse into
    // whichever one arrived first. The form and the codes are already in meta,
    // where the filings classifier reads them and dedupe does not.
    //
    // A COMMA, and neither of the two punctuation marks that look more natural:
    //
    //   - a colon, because headlineEquivalent strips a short uppercase
    //     "PREFIX:" as a wire tag, so "ACME CORP:" reads as a byline and is
    //     removed along with the only distinguishing entity in the line;
    //   - an em dash, because splitHeadlineAndBody treats "<15-120 chars> — "
    //     as headline-then-body, so any filer named with 15 characters or more
    //     kept the company as the headline and demoted the event to the body.
    //     "BETA INDUSTRIES" then classified as nothing at all.
    return `${company}, ${described.join('; ')}`;
  }
  // No recognised items — a 13D, a tender offer, or an unmapped code. The form
  // itself still carries the signal, and classifyFiling reads it downstream.
  if (company && form) return `${company} files ${form} — ${entry.title}`;
  return entry.summary ? `${entry.title} — ${entry.summary}` : entry.title;
}

/**
 * Reads an Atom node's text, whether the parser gave us a string or an object.
 *
 * With `ignoreAttributes: false`, fast-xml-parser represents an element that
 * carries attributes as an object with the text under `#text` — and EDGAR's
 * summary is always `<summary type="html">`. `String()` over that yields
 * "[object Object]", which is what every 8-K alert said, and what
 * `extract8kItems` was handed instead of the item codes.
 *
 * That is why no 8-K ever published. The summary is where EDGAR states
 * "Items: 1.03 2.02", the items decide materiality, and §16 drops any filing
 * below CRITICAL/HIGH — so losing them dropped the entire feed, including
 * bankruptcies, on a source that reported itself as polling perfectly.
 */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const text = (node as Record<string, unknown>)['#text'];
    return text === undefined ? '' : String(text);
  }
  return String(node);
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
    const title = normalizeWhitespace(textOf(entry.title));
    const category = entry.category as Record<string, unknown> | undefined;
    const id = textOf(entry.id);
    const updated = textOf(entry.updated) || textOf(entry.published);

    return {
      id: id || deterministicId(href ?? '', title).slice(0, 24),
      title,
      // stripHtml because EDGAR escapes markup into the summary: the item codes
      // arrive as "<b>Items:</b> 1.03 2.02".
      summary: normalizeWhitespace(stripHtml(textOf(entry.summary))),
      link: href ?? null,
      updated,
      category: (category?.['@_term'] as string | undefined) ?? null,
    };
  });
}

function accessionFrom(url: string | null): string | null {
  if (!url) return null;
  const m = /(\d{10}-\d{2}-\d{6})/.exec(url);
  return m?.[1] ?? null;
}
