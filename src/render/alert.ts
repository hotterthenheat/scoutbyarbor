import type { RenderableAlert } from '../core/types.js';
import { formatAlertTimestamp } from '../util/time.js';
import { normalizeWhitespace, truncate } from '../util/text.js';

/**
 * THE ALERT (§3, §33).
 *
 * This is the whole user-facing surface, and its value is in what it refuses to
 * show. No author, no handle, no source name, no URL, no engagement counts, no
 * sentiment, no confidence, no AI summary, no buttons, no emoji.
 *
 *   MACRO ALERT
 *
 *   NO NUCLEAR IRAN
 *
 *   5:14 PM · May 24, 2026
 *
 *   Trump called the Obama-era Iran nuclear deal "one of the worst deals
 *   ever," saying it gave Iran a path to nuclear weapons...
 *
 * `RenderableAlert` has four fields and no way to carry the rest, so the
 * constraint is structural. `assertNoLeakedMetadata` is the belt to that
 * braces — the publisher runs it against the real handle and URL before send.
 */

export const BODY_MAX_CHARS = 320;

export interface BuildAlertInput {
  banner: string;
  headline: string;
  timestampIso: string;
  body: string;
  timeZone?: string;
}

export function buildAlert(input: BuildAlertInput): RenderableAlert {
  return {
    banner: normalizeWhitespace(input.banner).toUpperCase(),
    headline: normalizeWhitespace(input.headline).toUpperCase(),
    timestamp: formatAlertTimestamp(input.timestampIso, input.timeZone),
    body: truncate(normalizeWhitespace(input.body ?? ''), BODY_MAX_CHARS),
  };
}

/**
 * Plain text, because that is what the format is. Bold is the only markdown
 * used — it gives the banner and headline weight without adding furniture.
 */
export function renderAlert(alert: RenderableAlert): string {
  // The bolded segments are escaped: an unbalanced '*' inside a headline would
  // otherwise swallow the rest of the message into italics.
  const blocks = [
    `**${escapeMarkdown(alert.banner)}**`,
    `**${escapeMarkdown(alert.headline)}**`,
    alert.timestamp,
  ];
  if (alert.body.trim()) blocks.push(escapeMarkdown(alert.body));
  return blocks.join('\n\n');
}

/** Neutralises Discord's formatting characters without mangling the text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\])/g, '\\$1');
}

/** Muted, institutional. No category should read as decorative. */
const BANNER_COLOR: Record<string, number> = {
  'MACRO ALERT': 0x4a5568,
  'FED ALERT': 0x2c5282,
  'ECONOMIC ALERT': 0x2a4365,
  'GEOPOLITICAL ALERT': 0x742a2a,
  'MARKET ALERT': 0x1a365d,
  'EQUITY ALERT': 0x22543d,
  'EARNINGS ALERT': 0x276749,
  'OPTIONS / FLOW ALERT': 0x553c9a,
  'COMMODITY ALERT': 0x744210,
  'CRYPTO ALERT': 0x4a5568,
};

/**
 * Minimal embed for the cases where a coloured rule reads better than plain
 * text. Deliberately no author, footer, fields, thumbnail, url or timestamp
 * property — the timestamp is part of the description, in Scout's own format.
 */
export function renderAlertEmbed(alert: RenderableAlert): unknown {
  return {
    description: renderAlert(alert),
    color: BANNER_COLOR[alert.banner] ?? 0x4a5568,
  };
}

/**
 * Labels Scout must never add to an alert. These are patterns, not values: the
 * concern is Scout annotating an alert with its own metadata, which always
 * takes the form `LABEL:`.
 */
const FORBIDDEN_LABELS =
  /(?:^|\n)\s*(?:source|author|handle|via|url|link|likes?|retweets?|reposts?|engagement|confidence|sentiment|market impact|ai summary|summary|score|importance|band|severity|relevance|novelty|magnitude|credibility)\s*:/i;

/**
 * Score-like annotations. The importance score is an internal routing mechanism
 * and is never shown — not the number, not the band, not a percentage of
 * confidence. A percentage inside the body is fine and expected ("CPI ROSE
 * 0.3%"); what is banned is Scout labelling an alert with its own verdict.
 */
const FORBIDDEN_SCORE =
  /(?:^|\n|\s)(?:score|confidence|importance|severity)\s*[:=]\s*\d|(?:^|\n)\s*(?:CRITICAL|HIGH|MODERATE|LOW|IGNORE)\s*$|\b\d{1,3}\s*\/\s*100\b/i;

/**
 * Last line of defence before send. Throws rather than posting an alert that
 * carries backend metadata — a leak here is a product bug, not a cosmetic one.
 *
 * `forbidden` should carry only values Scout itself would have attached: the
 * author handle and the original URL. It must NOT include the source's display
 * name — wire services name themselves inside real headlines ("REUTERS: US,
 * IRAN REACH AGREEMENT"), and treating that as a leak would throw away the
 * story rather than publish it.
 */
export function assertNoLeakedMetadata(rendered: string, forbidden: string[]): void {
  const haystack = rendered.toLowerCase();

  for (const raw of forbidden) {
    const needle = (raw ?? '').trim().toLowerCase();
    // Very short fragments would false-positive on ordinary words.
    if (needle.length < 4) continue;
    // Only @handles and URLs belong here; a bare word is the caller's mistake.
    if (!needle.startsWith('@') && !needle.includes('://')) continue;
    if (haystack.includes(needle)) {
      throw new Error(`alert would leak backend metadata: ${raw}`);
    }
  }

  if (/https?:\/\//i.test(rendered)) {
    throw new Error('alert would leak a URL');
  }
  if (FORBIDDEN_LABELS.test(rendered)) {
    throw new Error('alert would carry a backend label');
  }
  if (FORBIDDEN_SCORE.test(rendered)) {
    throw new Error('alert would show an internal score');
  }
}
