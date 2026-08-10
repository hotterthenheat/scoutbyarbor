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
 * Truth Social adapter.
 *
 * Truth Social runs a Mastodon-compatible server and exposes the standard
 * public account endpoints. Scout reads those directly: no credential, no key,
 * no cost, and nothing that works around an access control.
 *
 *   GET /api/v1/accounts/lookup?acct=<handle>       → the account
 *   GET /api/v1/accounts/<id>/statuses              → the posts
 *
 * ── WHY NOT THE USUAL TOOLING ────────────────────────────────────────────────
 *
 * The published tools for this route every request through FlareSolverr, whose
 * only purpose is solving Cloudflare's bot challenge. Scout does not, because
 * the endpoints above answer plain JSON without one — and because defeating a
 * protection a site deployed is the same line as a self-bot, whatever it is
 * pointed at. If Truth Social closes these endpoints, the correct response is
 * that this adapter stops working, not that it starts pretending to be a
 * browser.
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

export interface TruthSocialAdapterDeps {
  /** Identifies Scout to the server. Reused from the SEC setting. */
  userAgent: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
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

export function createTruthSocialAdapter(deps: TruthSocialAdapterDeps): IngestAdapter {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const seenBySource = new Map<string, Set<string>>();
  /** handle → account id. One lookup per process, not per poll. */
  const accountIds = new Map<string, string>();

  async function request(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': deps.userAgent },
      });

      if (res.status === 404) throw new Error('account not found (HTTP 404)');
      if (res.status === 429) throw new Error('rate limited (HTTP 429); backing off until next poll');
      if (res.status === 403) {
        // The endpoint answering with a challenge rather than JSON is exactly
        // the case this adapter refuses to work around.
        throw new Error(
          'HTTP 403 — the public API is refusing anonymous reads. Scout does not ' +
            'circumvent bot protection, so this source stops here.',
        );
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function accountIdFor(source: Source): Promise<string> {
    const handle = acctOf(source.handle ?? '');
    if (!handle) throw new Error(`source ${source.id} has no handle`);

    const cached = accountIds.get(handle);
    if (cached) return cached;

    const base = source.url?.trim() || 'https://truthsocial.com';
    const body = (await request(
      `${base}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`,
    )) as TruthAccount;

    const id = body?.id?.trim();
    if (!id) throw new Error(`lookup returned no account id for @${handle}`);
    accountIds.set(handle, id);
    deps.logger.info('resolved truth social account', { handle, accountId: id });
    return id;
  }

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
        retrievalSource: 'truthsocial-api',
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
          const accountId = await accountIdFor(source);
          const base = source.url?.trim() || 'https://truthsocial.com';
          const body = (await request(
            `${base}/api/v1/accounts/${accountId}/statuses?limit=${PAGE_LIMIT}&exclude_replies=true`,
          )) as unknown;

          if (!Array.isArray(body)) throw new Error('statuses endpoint did not return an array');

          const seen = seenBySource.get(source.id) ?? new Set<string>();
          let fresh = 0;

          for (const status of body as TruthStatus[]) {
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
        const id = await accountIdFor(source);
        return { sourceId: source.id, ok: true, resolvedId: id, detail: `account ${id}` };
      } catch (err) {
        return { sourceId: source.id, ok: false, detail: (err as Error).message };
      }
    },
  };
}
