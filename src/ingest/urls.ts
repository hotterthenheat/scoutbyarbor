/**
 * URL detection and normalization.
 *
 * A post can arrive as any of several domains, with tracking parameters and a
 * trailing `/photo/1`. Everything normalises to one canonical id, which is the
 * deduplication key:
 *
 *   https://x.com/DeItaone/status/2058552301120360937        → x:2058552301120360937
 *   https://twitter.com/DeItaone/status/2058552301120360937  → x:2058552301120360937
 *   https://truthsocial.com/@realDonaldTrump/posts/11345678  → truth:11345678
 *
 * Truth Social runs the identical pipeline — it is a platform, not a special
 * case, so nothing downstream of this module needs to know which one a post
 * came from.
 */

export type Platform = 'discord' | 'x';

export interface DetectedUrl {
  platform: Platform;
  username: string;
  postId: string;
  canonicalId: string;
  canonicalUrl: string;
  rawUrl: string;
}

const X_URL_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/[^\s]*)?/gi;

/** Every supported post URL in a block of text, deduped by canonical id. */
export function detectPostUrls(text: string): DetectedUrl[] {
  if (!text) return [];
  const found = new Map<string, DetectedUrl>();

  for (const match of text.matchAll(X_URL_RE)) {
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

export function canonicalIdFor(platform: Platform, postId: string): string {
  if (platform === 'x') return `x:${postId}`;
  return `${platform}:${postId}`;
}

/**
 * Source allowlist. Random URLs pasted by arbitrary Discord users must not
 * become trading alerts, so only approved accounts enter the pipeline. An empty
 * allowlist means "no restriction", which is fine for a private server but
 * should be filled in for production.
 */
export function isAllowedAccount(username: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.includes(username.replace(/^@/, '').toLowerCase());
}
