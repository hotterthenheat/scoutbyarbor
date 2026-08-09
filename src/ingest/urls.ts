/**
 * URL detection and normalization.
 *
 * x.com and twitter.com are the same platform, and the same post can arrive as
 * either — plus tracking parameters, plus a trailing `/photo/1`. Everything
 * normalises to one canonical id:
 *
 *   https://x.com/DeItaone/status/2058552301120360937  →  x:2058552301120360937
 *   https://twitter.com/DeItaone/status/2058552301120360937/photo/1
 *                                                      →  x:2058552301120360937
 *
 * That id is the deduplication key, so the same post relayed through five
 * channels by three different accounts produces exactly one event.
 */

export interface DetectedUrl {
  platform: 'x';
  username: string;
  postId: string;
  /** Stable dedupe key: `x:<post_id>`. */
  canonicalId: string;
  canonicalUrl: string;
  /** The URL exactly as it appeared, for the audit trail. */
  rawUrl: string;
}

const POST_URL_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/[^\s]*)?/gi;

/** Every supported post URL in a block of text, deduped by canonical id. */
export function detectPostUrls(text: string): DetectedUrl[] {
  if (!text) return [];
  const found = new Map<string, DetectedUrl>();

  for (const match of text.matchAll(POST_URL_RE)) {
    const username = match[1];
    const postId = match[2];
    if (!username || !postId) continue;

    const canonicalId = `x:${postId}`;
    if (found.has(canonicalId)) continue;

    found.set(canonicalId, {
      platform: 'x',
      username,
      postId,
      canonicalId,
      canonicalUrl: `https://x.com/${username}/status/${postId}`,
      rawUrl: match[0],
    });
  }

  return [...found.values()];
}

/** Single-URL form, for the CLI and for validating admin input. */
export function parsePostUrl(url: string): DetectedUrl | null {
  return detectPostUrls(url)[0] ?? null;
}

export function canonicalIdFor(postId: string): string {
  return `x:${postId}`;
}

/**
 * Source allowlist (§13). Random URLs pasted by arbitrary Discord users must
 * not become trading alerts, so only approved accounts enter the pipeline. An
 * empty allowlist means "no restriction", which is the right default for a
 * private server but should be filled in for production.
 */
export function isAllowedAccount(username: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.includes(username.replace(/^@/, '').toLowerCase());
}
