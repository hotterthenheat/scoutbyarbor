import { XMLParser } from 'fast-xml-parser';
import { loadSourcesFile } from '../config/loader.js';

/**
 * Feed prospecting.
 *
 * Seven high-value primary feeds — BEA, Treasury, the New York Fed, PR
 * Newswire, SEC litigation, the IMF, the White House — sit in `sources.yaml`
 * disabled, each carrying the same note: the URL returned 404 or 403 in
 * production, and it was left visibly dead rather than replaced with a guess,
 * because an unverified substitute is a coin flip and a wrong one fails
 * identically while looking fixed.
 *
 * That note is right, and it is also a dead end: nobody can propose a
 * replacement without a way to test one. This command is that way. It fetches
 * candidate URLs, reports which return a parseable feed with recent items, and
 * changes nothing — the operator enables what passes.
 *
 * It has to run somewhere with real network access. The build environment's
 * egress policy blocks every one of these hosts, which is precisely why the
 * candidates below are UNVERIFIED and this exists at all.
 *
 *   npm run scout sources:probe            # candidates + disabled sources
 *   npm run scout sources:probe --all      # also re-check enabled ones
 *
 * A feed is only worth enabling if its newest item is recent AND it carries a
 * real publication timestamp. Scout's freshness window is measured against that
 * timestamp, so a feed that omits one, or that publishes hours late, will never
 * clear the gate no matter how authoritative the publisher is. Both are
 * reported.
 */

export interface FeedCandidate {
  /** Which source it would revive or add. */
  id: string;
  url: string;
  why: string;
}

/**
 * Candidate URLs, grouped by the publisher they would restore.
 *
 * Several alternates per publisher on purpose: the point of a probe run is to
 * find which one answers, not to bet on one. None of these are verified — that
 * is the operator's run to make.
 */
export const CANDIDATES: FeedCandidate[] = [
  // ── Macro releases that reprice the curve on arrival ──
  {
    id: 'rss:bea-news',
    url: 'https://apps.bea.gov/rss/rss.xml',
    why: 'GDP, PCE — the Fed’s preferred inflation gauge',
  },
  { id: 'rss:bea-news', url: 'https://www.bea.gov/rss.xml', why: 'BEA, currently configured URL' },
  { id: 'rss:bea-news', url: 'https://www.bea.gov/news/rss.xml', why: 'BEA, alternate path' },

  {
    id: 'rss:treasury-press',
    url: 'https://home.treasury.gov/rss/press.xml',
    why: 'auctions, debt management, OFAC sanctions',
  },
  {
    id: 'rss:treasury-press',
    url: 'https://home.treasury.gov/news/press-releases/feed',
    why: 'Treasury, alternate path',
  },

  {
    id: 'rss:census-indicators',
    url: 'https://www.census.gov/economic-indicators/indicator.xml',
    why: 'retail sales, durable goods, trade balance',
  },

  {
    id: 'rss:dol-claims',
    url: 'https://www.dol.gov/rss/releases.xml',
    why: 'weekly jobless claims — a rates mover',
  },
  { id: 'rss:dol-claims', url: 'https://oui.doleta.gov/unemploy/rss/claims.xml', why: 'ETA claims' },

  // ── Fed plumbing ──
  {
    id: 'rss:nyfed-news',
    url: 'https://www.newyorkfed.org/rss/news.xml',
    why: 'SOMA and repo operations; currently 403',
  },
  { id: 'rss:nyfed-news', url: 'https://www.newyorkfed.org/xml/rss_news.xml', why: 'NY Fed, alternate' },
  {
    id: 'rss:fed-h41',
    url: 'https://www.federalreserve.gov/feeds/h41.xml',
    why: 'weekly balance sheet',
  },

  // ── Energy and ag ──
  {
    id: 'rss:eia-wpsr',
    url: 'https://ir.eia.gov/wpsr/overview.xml',
    why: 'weekly petroleum status — moves crude on release',
  },
  {
    id: 'rss:usda-releases',
    url: 'https://www.usda.gov/rss/latest-releases.xml',
    why: 'WASDE and crop reports',
  },

  // ── Equity ──
  {
    id: 'rss:nasdaq-halts',
    url: 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts',
    why: 'trading halts — the highest-signal equity feed on this list',
  },
  {
    id: 'rss:prnewswire',
    url: 'https://www.prnewswire.com/rss/news-releases-list.rss',
    why: 'corporate announcements at the moment of release',
  },
  {
    id: 'rss:sec-litigation',
    url: 'https://www.sec.gov/rss/litigation/litreleases.xml',
    why: 'enforcement actions',
  },

  // ── Policy and geopolitics ──
  {
    id: 'rss:whitehouse',
    url: 'https://www.whitehouse.gov/presidential-actions/feed/',
    why: 'executive orders, tariff proclamations',
  },
  { id: 'rss:whitehouse', url: 'https://www.whitehouse.gov/feed/', why: 'White House, site-wide' },
  { id: 'rss:imf-news', url: 'https://www.imf.org/en/News/RSS?language=eng', why: 'IMF releases' },
];

export interface ProbeResult {
  id: string;
  url: string;
  why: string;
  ok: boolean;
  status: number | null;
  itemCount: number;
  /** Minutes since the newest item, or null when none carried a date. */
  newestAgeMinutes: number | null;
  /** False when items exist but none carried a parseable publication time. */
  hasTimestamps: boolean;
  detail: string;
}

interface ProbeDeps {
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DATE_FIELDS = ['pubDate', 'published', 'updated', 'dc:date', 'date'];

/** Newest item timestamp in a parsed feed, and how many items it carried. */
export function summariseFeed(
  xml: string,
  parser: XMLParser,
  now: number,
): { itemCount: number; newestAgeMinutes: number | null; hasTimestamps: boolean } {
  const doc = parser.parse(xml) as Record<string, any>;
  const channel = doc?.rss?.channel ?? doc?.feed ?? doc?.['rdf:RDF'] ?? {};
  const raw = channel.item ?? channel.entry ?? doc?.feed?.entry ?? [];
  const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  let newest = Number.NEGATIVE_INFINITY;
  let dated = 0;

  for (const item of items) {
    for (const field of DATE_FIELDS) {
      const value = item[field];
      if (value === undefined || value === null) continue;
      const parsed = Date.parse(typeof value === 'string' ? value : String((value as any)['#text'] ?? ''));
      if (Number.isFinite(parsed)) {
        dated += 1;
        if (parsed > newest) newest = parsed;
        break;
      }
    }
  }

  return {
    itemCount: items.length,
    newestAgeMinutes: Number.isFinite(newest) ? Math.round((now - newest) / 60_000) : null,
    hasTimestamps: dated > 0,
  };
}

async function probeOne(
  candidate: FeedCandidate,
  deps: ProbeDeps,
  parser: XMLParser,
): Promise<ProbeResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const base = { id: candidate.id, url: candidate.url, why: candidate.why };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await doFetch(candidate.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': deps.userAgent,
        accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      },
    });

    if (!res.ok) {
      return {
        ...base,
        ok: false,
        status: res.status,
        itemCount: 0,
        newestAgeMinutes: null,
        hasTimestamps: false,
        detail:
          res.status === 403
            ? 'HTTP 403 — the publisher refuses this client'
            : `HTTP ${res.status}`,
      };
    }

    const text = await res.text();
    const summary = summariseFeed(text, parser, now());

    if (summary.itemCount === 0) {
      return {
        ...base,
        ok: false,
        status: res.status,
        itemCount: 0,
        newestAgeMinutes: null,
        hasTimestamps: false,
        // A 200 carrying no items is usually an HTML error page, which is the
        // failure that looks healthy from the outside.
        detail: text.trimStart().startsWith('<!') ? '200 but HTML, not a feed' : '200 but no items',
      };
    }

    return {
      ...base,
      ok: true,
      status: res.status,
      ...summary,
      detail: summary.hasTimestamps
        ? 'live'
        : 'live, but no item timestamps — cannot clear the freshness gate',
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      status: null,
      itemCount: 0,
      newestAgeMinutes: null,
      hasTimestamps: false,
      detail: (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeOptions extends ProbeDeps {
  /** Also re-check sources already enabled, not just candidates and dead ones. */
  includeEnabled?: boolean;
}

/**
 * Probes the candidate list plus every disabled RSS source in config, so a feed
 * that has quietly come back to life is found in the same run.
 */
export async function probeFeeds(options: ProbeOptions): Promise<ProbeResult[]> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  const configured = loadSourcesFile()
    .sources.filter((s) => s.sourceType === 'rss' && Boolean(s.url))
    .filter((s) => options.includeEnabled || !s.enabled)
    .map((s) => ({
      id: s.id,
      url: s.url as string,
      why: s.enabled ? 'currently enabled' : 'currently disabled in config',
    }));

  // Candidates first, then configured URLs not already covered.
  const seen = new Set(CANDIDATES.map((c) => `${c.id}|${c.url}`));
  const queue: FeedCandidate[] = [...CANDIDATES];
  for (const entry of configured) {
    if (!seen.has(`${entry.id}|${entry.url}`)) queue.push(entry);
  }

  const results: ProbeResult[] = [];
  for (const candidate of queue) {
    results.push(await probeOne(candidate, options, parser));
  }
  return results;
}

/** Human-readable report. Grouped so the answer is "enable these". */
export function formatProbeReport(results: ProbeResult[]): string {
  const live = results.filter((r) => r.ok && r.hasTimestamps);
  const usable = results.filter((r) => r.ok && !r.hasTimestamps);
  const dead = results.filter((r) => !r.ok);

  const lines: string[] = [];
  const row = (r: ProbeResult): string =>
    `  ${r.id.padEnd(26)} ${String(r.status ?? '—').padEnd(4)} ` +
    `${String(r.itemCount).padStart(3)} items  ` +
    `${r.newestAgeMinutes === null ? 'age ?' : `newest ${r.newestAgeMinutes}m`}`.padEnd(16) +
    `${r.url}`;

  lines.push(`\nLIVE AND USABLE (${live.length}) — enable these in config/sources.yaml`);
  lines.push(live.length ? live.map(row).join('\n') : '  none');

  if (usable.length > 0) {
    lines.push(`\nLIVE BUT UNTIMESTAMPED (${usable.length}) — will not clear the freshness gate`);
    lines.push(usable.map(row).join('\n'));
  }

  lines.push(`\nDEAD (${dead.length})`);
  lines.push(
    dead.length
      ? dead.map((r) => `  ${r.id.padEnd(26)} ${r.detail.padEnd(38)} ${r.url}`).join('\n')
      : '  none',
  );

  // Several candidates share an id on purpose — alternates for one publisher.
  const winners = new Map<string, ProbeResult>();
  for (const r of live) if (!winners.has(r.id)) winners.set(r.id, r);
  if (winners.size > 0) {
    lines.push('\nBest URL per source:');
    for (const [id, r] of winners) lines.push(`  ${id.padEnd(26)} ${r.url}`);
  }

  lines.push('\nNothing was changed. Enabling a source is a config edit.');
  return lines.join('\n');
}
