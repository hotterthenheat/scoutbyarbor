import { decodeEntities, normalizeWhitespace } from '../util/text.js';
import type { DetectedUrl } from './urls.js';

/**
 * Relay-content parser.
 *
 * A permitted relay usually posts the content alongside the link:
 *
 *   Macro Alert (@DeItaone):
 *
 *   NO NUCLEAR IRAN
 *
 *   Trump called the Obama-era Iran nuclear deal "one of the worst deals
 *   ever," saying it gave Iran a path to nuclear weapons...
 *   https://x.com/DeItaone/status/2058552301120360937
 *
 * Everything Scout needs is already in that message, so parsing it is both
 * faster than a second upstream request and free of any credential. This is the
 * primary MVP path; an API resolver is a fallback, not a prerequisite.
 *
 * The one thing this will NOT invent is a publication time. If the relay did
 * not state one, `publishedAt` stays null — the relay's own message time is
 * when Scout heard about the post, not when it was published, and conflating
 * them is how a recycled headline becomes a fresh trading signal.
 */

export interface ParsedRelayContent {
  /** Display name or label the relay used, e.g. "Macro Alert". */
  author: string | null;
  /** `@handle` if the relay named one, else the handle from the URL. */
  authorHandle: string | null;
  /** Headline plus body, with the relay's own framing removed. */
  text: string;
  /** Only when the relay genuinely stated one. Never the relay's message time. */
  publishedAt: string | null;
  /** Which cues fired, for the raw channel. */
  signals: string[];
}

/**
 * A leading attribution line. Matches the shapes relays actually use:
 *   "Macro Alert (@DeItaone):"   "@DeItaone:"   "DeItaone (@DeItaone) ·"
 *   "**Walter Bloomberg** @DeItaone"
 */
const ATTRIBUTION_RE =
  /^\s*\**\s*(?:(?<label>[^\n(@*]{1,60}?)\s*)?\(?\s*@(?<handle>[A-Za-z0-9_.]{1,30})\s*\)?\s*[:·\-–—]?\s*$/;

/** An attribution and the first line of content on the same line. */
const INLINE_ATTRIBUTION_RE =
  /^\s*\**\s*(?:(?<label>[^\n(@*]{1,60}?)\s*)?\(\s*@(?<handle>[A-Za-z0-9_.]{1,30})\s*\)\s*[:·\-–—]\s*(?<rest>.+)$/;

/**
 * Timestamps a relay may state explicitly. Deliberately narrow: a bare time
 * with no date is ambiguous across days and is not worth guessing at.
 */
const EXPLICIT_TIMESTAMP_RE =
  /(?:^|\n)\s*(?:posted|published|sent|at)?\s*:?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)\s*(?:$|\n)/i;

export function parseRelayContent(raw: string, url: DetectedUrl): ParsedRelayContent {
  const signals: string[] = [];
  const decoded = decodeEntities(raw ?? '');

  // Strip every URL: the link is the trigger, not the content.
  const withoutUrls = decoded.replace(/https?:\/\/\S+/g, ' ');

  const publishedAt = extractExplicitTimestamp(withoutUrls, signals);
  const lines = withoutUrls
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => l.trim() !== '' || (i > 0 && i < arr.length - 1));

  let author: string | null = null;
  let handle: string | null = null;
  const contentLines: string[] = [];

  for (const [index, line] of lines.entries()) {
    // Attribution is only credible at the top of the message; a mention further
    // down is part of the story, not a byline.
    if (index <= 2 && !handle) {
      const inline = INLINE_ATTRIBUTION_RE.exec(line);
      if (inline?.groups) {
        author = cleanLabel(inline.groups.label);
        handle = inline.groups.handle ?? null;
        signals.push('relay:inline-attribution');
        if (inline.groups.rest) contentLines.push(inline.groups.rest);
        continue;
      }

      const standalone = ATTRIBUTION_RE.exec(line);
      if (standalone?.groups?.handle) {
        author = cleanLabel(standalone.groups.label);
        handle = standalone.groups.handle;
        signals.push('relay:attribution-line');
        continue;
      }
    }
    contentLines.push(line);
  }

  const text = normalizeWhitespace(contentLines.join('\n').replace(/\n{3,}/g, '\n\n'))
    ? contentLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';

  if (!handle) signals.push('relay:handle-from-url');

  return {
    author,
    // Falling back to the URL's handle is safe — it is the post's actual author.
    authorHandle: handle ? `@${handle}` : `@${url.username}`,
    text,
    publishedAt,
    signals,
  };
}

/**
 * True when the relay carried enough to build an event without any upstream
 * request. A bare link with no words is not enough.
 */
export function hasUsableContent(parsed: ParsedRelayContent): boolean {
  const letters = parsed.text.replace(/[^A-Za-z]/g, '');
  return letters.length >= 12;
}

function extractExplicitTimestamp(text: string, signals: string[]): string | null {
  const match = EXPLICIT_TIMESTAMP_RE.exec(text);
  if (!match?.[1]) return null;

  const parsed = Date.parse(match[1].replace(' ', 'T'));
  if (!Number.isFinite(parsed)) return null;

  // A stated time far in the future is a parsing accident, not a publication.
  if (parsed > Date.now() + 60 * 60_000) return null;

  signals.push('relay:explicit-timestamp');
  return new Date(parsed).toISOString();
}

function cleanLabel(label: string | undefined): string | null {
  const cleaned = normalizeWhitespace((label ?? '').replace(/[*_`]/g, ''));
  if (!cleaned) return null;
  // "Macro Alert" is a relay's own category label, not a person; keep it as the
  // author field but never let it reach an alert (§3 forbids it either way).
  return cleaned.replace(/[:·\-–—]\s*$/, '').trim() || null;
}
