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
  const headline = normalizeWhitespace(input.headline).toUpperCase();
  const body = normalizeWhitespace(input.body ?? '');

  return {
    banner: normalizeWhitespace(input.banner).toUpperCase(),
    headline,
    timestamp: formatAlertTimestamp(input.timestampIso, input.timeZone),
    body: restatesHeadline(body, headline) ? '' : truncate(body, BODY_MAX_CHARS),
  };
}

/**
 * A body that only repeats the headline is noise in an alert whose whole point
 * is density. Compares on letters and digits alone so punctuation and casing
 * differences do not hide a restatement.
 */
function restatesHeadline(body: string, headline: string): boolean {
  if (!body) return true;
  const strip = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const b = strip(body);
  const h = strip(headline);
  if (!b || !h) return !b;
  return b === h || h.startsWith(b) || (b.startsWith(h) && b.length - h.length < 12);
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

/** Inverse of escapeMarkdown, so the leak guard sees the real characters. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([*_`~|\\])/g, '$1');
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
 * appears as `LABEL:` at the start of a line.
 *
 * Line-anchored on purpose. Matching mid-line would reject real headlines —
 * "US CONSUMER CONFIDENCE: 102.6 VS 100.4 EXPECTED" is an economic release,
 * not Scout labelling its own confidence.
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
  /(?:^|\n)\s*(?:score|confidence|importance|severity|relevance)\s*[:=]\s*\d|(?:^|\n)\s*(?:CRITICAL|HIGH|MODERATE|LOW|IGNORE)\s*$|(?:^|\n)\s*\d{1,3}\s*\/\s*100\s*$/i;

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
  // Compare against the UNESCAPED text. renderAlert escapes markdown, so a
  // handle like @zero_hedge appears as @zero\_hedge and a raw-needle search
  // would silently miss it — defeating the guard exactly where it matters.
  const haystack = unescapeMarkdown(rendered).toLowerCase();

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
