import type {
  IngestAdapter,
  IngestResult,
  RawPost,
  Source,
  SourceVerification,
} from '../../core/types.js';
import type { Logger } from '../../util/logger.js';
import type { CreditBudget } from './creditBudget.js';
import { isoNow } from '../../util/time.js';
import { normalizeWhitespace, stripHtml, describeFetchError } from '../../util/text.js';

/**
 * Truth Social adapter, with two transports behind one ID scheme.
 *
 * ── DIRECT ───────────────────────────────────────────────────────────────────
 *
 * Truth Social runs a Mastodon-compatible server with standard public account
 * endpoints:
 *
 *   GET /api/v1/accounts/lookup?acct=<handle>       → the account
 *   GET /api/v1/accounts/<id>/statuses              → the posts
 *
 * No credential, no key, no cost. This is the preferred transport and it is
 * what runs when no vendor key is configured.
 *
 * The published tooling for this route sends every request through
 * FlareSolverr, whose only purpose is solving Cloudflare's bot challenge. Scout
 * does not, and will not: defeating a protection a site deployed is the same
 * line as a self-bot, whatever it is pointed at. When the endpoint answers with
 * a challenge, this transport stops.
 *
 * ── VENDOR ───────────────────────────────────────────────────────────────────
 *
 * It did stop. From a datacenter IP the public endpoints return HTTP 403, so on
 * the deployed instance every Truth Social source sat DISCONNECTED. The second
 * transport reads the same posts from Scrape Creators, a commercial API the
 * operator subscribes to. That is an ordinary paid data feed — the same
 * relationship Scout already has with Finnhub — and it is not a bypass: the
 * request goes to the vendor's own API with the operator's own key, and the
 * vendor's data sourcing is the vendor's business.
 *
 * It is, however, METERED, which is a constraint the direct transport never
 * had. See `creditBudget.ts`: polling is a standing order to spend money.
 *
 * ── ONE ID SCHEME ACROSS BOTH ────────────────────────────────────────────────
 *
 * Whichever transport reads a post, the canonical id is `truth:<status id>` —
 * identical to what the webhook path derives. A post seen directly, read
 * through the vendor, and pushed by somebody's relay must collapse into ONE
 * event, and dedupe is by canonical id. Switching transports must never
 * republish the wire's recent history.
 *
 * ── PUBLICATION TIME ─────────────────────────────────────────────────────────
 *
 * `created_at` is the post's own timestamp, so `publishedAt` is genuine and the
 * freshness gate works normally. A post without a usable one gets null rather
 * than the moment Scout fetched it.
 */

/** Posts are HTML fragments; the pipeline reads text. */
const MAX_ITEM_AGE_MS = 60 * 60_000;
const MAX_SEEN_IDS = 500;
/** Per request. The endpoint caps it well above this; being polite is free. */
const PAGE_LIMIT = 20;

const DEFAULT_VENDOR_BASE = 'https://api.scrapecreators.com';
/**
 * Posts fetched per vendor poll.
 *
 * Deliberately tiny. The direct transport pages 20 at a time because pages are
 * free there; on the vendor every post on the page is billed on every poll,
 * seen or not. Three is enough to survive a burst between two 30s polls without
 * paying for seventeen posts Scout already published.
 */
const DEFAULT_VENDOR_PAGE_LIMIT = 3;

export interface TruthSocialAdapterDeps {
  /** Identifies Scout to the server. Reused from the SEC setting. */
  userAgent: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Scrape Creators. Supplying a key switches every Truth Social source onto
   * the vendor transport; omitting it keeps the free direct one.
   */
  vendor?: {
    apiKey: string;
    baseUrl?: string;
    /**
     * Posts requested per poll. This is the price of a poll, not a tuning
     * detail: the vendor bills per post returned, so a page of 20 costs 20
     * credits every time it is fetched — including the 19 already seen.
     */
    pageLimit?: number;
    /** Refuses the request when the daily cap is reached. */
    budget?: CreditBudget;
  };
}

interface TruthAccount {
  id?: string;
  username?: string;
  display_name?: string;
}

interface TruthStatus {
  id?: string;
  created_at?: string;
  content?: string;
  url?: string;
  in_reply_to_id?: string | null;
  reblog?: unknown;
  account?: TruthAccount;
}

/** `@realDonaldTrump` → `realDonaldTrump`. */
export function acctOf(handle: string): string {
  return handle.trim().replace(/^@+/, '');
}

/**
 * The canonical id, matching the webhook path's scheme exactly.
 *
 * A post seen through this adapter and the same post pushed by a relay must
 * collapse into ONE event, and dedupe is by canonical id — so both produce
 * `truth:<status id>` or neither works.
 */
export function canonicalTruthId(statusId: string): string {
  return `truth:${statusId.trim()}`;
}

/**
 * Pulls the status list out of a vendor response.
 *
 * The vendor's docs are not reachable from the build environment, so the exact
 * envelope is unverified. Rather than guess one key and ship a source that
 * silently returns nothing, this accepts a bare array or any of the usual
 * wrappers, and the caller reports the actual top-level keys when none match —
 * so a wrong guess shows up as a named fault on the dashboard within one poll
 * instead of as an inexplicably quiet feed.
 */
export function statusesFromVendor(body: unknown): TruthStatus[] | null {
  if (Array.isArray(body)) return body as TruthStatus[];
  if (!body || typeof body !== 'object') return null;

  const record = body as Record<string, unknown>;
  for (const key of ['posts', 'data', 'statuses', 'results', 'items', 'timeline']) {
    const value = record[key];
    if (Array.isArray(value)) return value as TruthStatus[];
  }
  return null;
}

/** Describes an unrecognised payload precisely enough to fix it. */
function describeShape(body: unknown): string {
  if (body === null || body === undefined) return 'empty body';
  if (Array.isArray(body)) return 'array';
  if (typeof body !== 'object') return typeof body;
  const keys = Object.keys(body as Record<string, unknown>).slice(0, 8);
  return keys.length > 0 ? `object with keys [${keys.join(', ')}]` : 'object with no keys';
}

export function createTruthSocialAdapter(deps: TruthSocialAdapterDeps): IngestAdapter {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const seenBySource = new Map<string, Set<string>>();
  /** handle → account id. One lookup per process, not per poll. */
  const accountIds = new Map<string, string>();

  const vendorKey = deps.vendor?.apiKey?.trim() ?? '';
  const useVendor = vendorKey.length > 0;
  const vendorBase = (deps.vendor?.baseUrl?.trim() || DEFAULT_VENDOR_BASE).replace(/\/+$/, '');
  const vendorPageLimit = Math.max(1, deps.vendor?.pageLimit ?? DEFAULT_VENDOR_PAGE_LIMIT);
  const budget = deps.vendor?.budget;

  async function request(url: string, headers: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const res = await doFetch(url, { signal: controller.signal, headers });

      if (res.status === 404) throw new Error('account not found (HTTP 404)');
      if (res.status === 429) {
        throw new Error('rate limited (HTTP 429); backing off until next poll');
      }
      if (res.status === 401) {
        throw new Error('HTTP 401 — the API key was rejected. Check SCRAPECREATORS_API_KEY.');
      }
      if (res.status === 402) {
        throw new Error(
          'HTTP 402 — the vendor account is out of credits. Top up the balance or the ' +
            'Truth Social sources stay dark.',
        );
      }
      if (res.status === 400) {
        // Very likely the query parameter name. The vendor states which one is
        // missing, so pass its wording straight through rather than paraphrase.
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP 400 — the vendor rejected the request: ${detail.slice(0, 200)}`);
      }
      if (res.status === 403) {
        throw new Error(
          useVendor
            ? 'HTTP 403 — the vendor refused this resource.'
            : 'HTTP 403 — the public API is refusing anonymous reads. Scout does not ' +
              'circumvent bot protection, so this source stops here.',
        );
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reserves the worst-case cost of one vendor call.
   *
   * The vendor bills per POST returned, so the cost is the page size, not one.
   * The difference is released once the response is counted.
   */
  function reserveCredits(units: number): void {
    if (!budget) return;
    if (!budget.tryReserve(units)) {
      throw new Error(
        `daily credit budget spent (${budget.limit} credits, ${budget.spent()} used). ` +
          'Raise SCRAPECREATORS_DAILY_BUDGET, slow TRUTH_POLL_INTERVAL_MS, or top up ' +
          'the vendor balance.',
      );
    }
  }

  // ── DIRECT TRANSPORT ──────────────────────────────────────────────────────

  async function accountIdFor(source: Source): Promise<string> {
    const handle = acctOf(source.handle ?? '');
    if (!handle) throw new Error(`source ${source.id} has no handle`);

    const cached = accountIds.get(handle);
    if (cached) return cached;

    const base = source.url?.trim() || 'https://truthsocial.com';
    const body = (await request(
      `${base}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`,
      { accept: 'application/json', 'user-agent': deps.userAgent },
    )) as TruthAccount;

    const id = body?.id?.trim();
    if (!id) throw new Error(`lookup returned no account id for @${handle}`);
    accountIds.set(handle, id);
    deps.logger.info('resolved truth social account', { handle, accountId: id });
    return id;
  }

  async function statusesDirect(source: Source): Promise<TruthStatus[]> {
    const accountId = await accountIdFor(source);
    const base = source.url?.trim() || 'https://truthsocial.com';
    const body = await request(
      `${base}/api/v1/accounts/${accountId}/statuses?limit=${PAGE_LIMIT}&exclude_replies=true`,
      { accept: 'application/json', 'user-agent': deps.userAgent },
    );

    if (!Array.isArray(body)) throw new Error('statuses endpoint did not return an array');
    return body as TruthStatus[];
  }

  // ── VENDOR TRANSPORT ──────────────────────────────────────────────────────

  async function statusesViaVendor(source: Source): Promise<TruthStatus[]> {
    const handle = acctOf(source.handle ?? '');
    if (!handle) throw new Error(`source ${source.id} has no handle`);

    // Ask for as little as possible. Every post on the page is billable whether
    // or not Scout has already seen it, so the page size IS the cost of a poll
    // — the one lever that matters on a metered per-post feed.
    reserveCredits(vendorPageLimit);
    let returned = vendorPageLimit;
    try {
      const body = await request(
        `${vendorBase}/v1/truthsocial/user/posts?handle=${encodeURIComponent(handle)}` +
          `&limit=${vendorPageLimit}`,
        { accept: 'application/json', 'x-api-key': vendorKey, 'user-agent': deps.userAgent },
      );

      const statuses = statusesFromVendor(body);
      if (!statuses) {
        throw new Error(
          `vendor returned an unrecognised payload (${describeShape(body)}); ` +
            'the status list could not be located',
        );
      }
      returned = statuses.length;
      return statuses;
    } finally {
      // A call that returned fewer posts than the page allows cost less. A call
      // that threw keeps the full reservation, which is the safe direction.
      budget?.settle(vendorPageLimit, returned);
    }
  }

  const fetchStatuses = useVendor ? statusesViaVendor : statusesDirect;

  function toPost(status: TruthStatus, source: Source): RawPost | null {
    const id = status.id?.trim();
    if (!id) return null;

    // Replies are conversation, not statements. Reblogs are someone else's post
    // and would be attributed to the wrong account.
    if (status.in_reply_to_id) return null;
    if (status.reblog) return null;

    const text = normalizeWhitespace(stripHtml(status.content ?? ''));
    if (!text) return null;

    const at = status.created_at ? Date.parse(status.created_at) : NaN;
    const publishedAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
    const handle = acctOf(source.handle ?? '');

    return {
      sourceId: source.id,
      sourcePostId: canonicalTruthId(id),
      originalUrl: status.url ?? null,
      author: handle ? `@${handle}` : (source.name ?? null),
      text,
      // Orders the pipeline, so it must always be real. publishedAt stays null
      // when unknown — that is the one the freshness gate reads.
      eventTime: publishedAt ?? isoNow(),
      ingestionTime: isoNow(),
      meta: {
        publishedAt,
        publishedAtKnown: publishedAt !== null,
        provenance: 'truth_social',
        platform: 'truth_social',
        // The transport is how Scout obtained the post, never who said it. The
        // byline stays the account either way.
        retrievalSource: useVendor ? 'scrapecreators-api' : 'truthsocial-api',
        statusId: id,
        relayHandle: handle ? `@${handle}` : null,
      },
    };
  }

  return {
    type: 'truthsocial',

    async poll(sources: Source[]): Promise<IngestResult> {
      const posts: RawPost[] = [];
      const outcomes: IngestResult['outcomes'] = [];
      const cutoff = now() - MAX_ITEM_AGE_MS;

      for (const source of sources) {
        const startedAt = Date.now();
        try {
          const body = await fetchStatuses(source);
          const seen = seenBySource.get(source.id) ?? new Set<string>();
          let fresh = 0;

          for (const status of body) {
            const post = toPost(status, source);
            if (!post) continue;
            if (seen.has(post.sourcePostId)) continue;

            // The endpoint returns a page of history, so the age bound is what
            // stops a restart replaying an hour of it.
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
        } catch (err) {
          const message = describeFetchError(err, deps.timeoutMs);
          deps.logger.warn('truth social poll failed', { sourceId: source.id, err: message });
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
        if (useVendor) {
          const statuses = await statusesViaVendor(source);
          return {
            sourceId: source.id,
            ok: true,
            resolvedId: acctOf(source.handle ?? ''),
            detail: `vendor transport, ${statuses.length} post(s)`,
          };
        }
        const id = await accountIdFor(source);
        return { sourceId: source.id, ok: true, resolvedId: id, detail: `account ${id}` };
      } catch (err) {
        return { sourceId: source.id, ok: false, detail: (err as Error).message };
      }
    },
  };
}
