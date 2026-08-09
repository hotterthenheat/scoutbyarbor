import { createHash } from 'node:crypto';

/**
 * Text primitives shared by normalization, dedupe and clustering.
 *
 * The load-bearing decision in here is `tokenize`: a hyphenated compound stays
 * a single token, so "META-ANALYSIS" never offers "META" as a ticker candidate
 * in the first place (§25).
 */

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'in', 'into', 'is', 'it', 'its',
  'not', 'of', 'on', 'or', 'she', 'that', 'the', 'their', 'they', 'this', 'to',
  'was', 'were', 'will', 'with', 'would', 'after', 'over', 'says', 'say', 'said',
  'new', 'more', 'than', 'about', 'up', 'down', 'out', 'we', 'you', 'i',
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const HANDLE_RE = /(^|\s)@[A-Za-z0-9_]{1,15}\b/g;
const RT_PREFIX_RE = /^\s*RT\s+@[A-Za-z0-9_]{1,15}:\s*/i;
const WIRE_PREFIX_RE = /^\s*(?:\*+\s*)?(?:BREAKING|JUST\s+IN|UPDATE|URGENT|ALERT|NEWS|FLASH)\s*[:\-—]\s*/i;

/** Trailing hashtag clouds — three or more in a row at the end of a post. */
const TRAILING_HASHTAGS_RE = /(?:\s*#[A-Za-z0-9_]+){3,}\s*$/;

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function stripUrls(s: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const text = s.replace(URL_RE, (m) => {
    urls.push(m);
    return ' ';
  });
  return { text: normalizeWhitespace(text), urls };
}

export function stripHandles(s: string): string {
  return normalizeWhitespace(s.replace(RT_PREFIX_RE, '').replace(HANDLE_RE, '$1'));
}

export function stripTrailingHashtags(s: string): string {
  return s.replace(TRAILING_HASHTAGS_RE, '').trim();
}

/**
 * Lowercase word/number tokens. Hyphenated compounds stay whole; possessives
 * are folded ("apple's" → "apple"); decimals stay intact ("2.40").
 */
export function tokenize(s: string): string[] {
  const lowered = s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/([a-z0-9])'s\b/g, '$1');

  return lowered.match(/\d+(?:[.,]\d+)*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g) ?? [];
}

export function significantTokens(s: string | string[]): string[] {
  const tokens = Array.isArray(s) ? s : tokenize(s);
  return tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Order-insensitive identity of a post's significant content. */
export function fingerprint(tokens: string[]): string {
  const sig = [...new Set(significantTokens(tokens))].sort();
  return createHash('sha256').update(sig.join(' ')).digest('hex').slice(0, 32);
}

function hash64(token: string): bigint {
  // FNV-1a, 64-bit.
  let h = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < token.length; i++) {
    h ^= BigInt(token.charCodeAt(i));
    h = (h * 0x100000001b3n) & mask;
  }
  return h;
}

/** 64-bit simhash as 16 hex chars, for Hamming-distance similarity. */
export function simhash64(tokens: string[]): string {
  const sig = significantTokens(tokens);
  if (sig.length === 0) return '0'.repeat(16);

  const weights = new Array<number>(64).fill(0);
  for (const token of sig) {
    const h = hash64(token);
    for (let bit = 0; bit < 64; bit++) {
      const set = (h >> BigInt(bit)) & 1n;
      weights[bit] = (weights[bit] ?? 0) + (set === 1n ? 1 : -1);
    }
  }

  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if ((weights[bit] ?? 0) > 0) out |= 1n << BigInt(bit);
  }
  return out.toString(16).padStart(16, '0');
}

export function hammingDistanceHex(a: string, b: string): number {
  let x: bigint;
  try {
    x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
  } catch {
    return 64;
  }
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

export function simhashSimilarity(a: string, b: string): number {
  return 1 - hammingDistanceHex(a, b) / 64;
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Combined similarity. Jaccard alone is brittle on short headlines that reword
 * the same fact; simhash alone is too generous on shared boilerplate. Half each
 * behaves well on wire copy.
 */
export function textSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const overlap = jaccard(significantTokens(tokensA), significantTokens(tokensB));
  const structural = simhashSimilarity(simhash64(tokensA), simhash64(tokensB));
  return overlap * 0.5 + structural * 0.5;
}

/** Uppercase wire style: no leading BREAKING marker, no trailing punctuation. */
export function toWireHeadline(s: string): string {
  return normalizeWhitespace(s)
    .replace(WIRE_PREFIX_RE, '')
    .replace(/^\*+\s*/, '')
    .replace(/[\s.:;,\-—–]+$/, '')
    .toUpperCase();
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z"“'])/;

/**
 * Newswire posts usually lead with the headline and follow with prose. Split on
 * the first newline, sentence boundary or dash separator — whichever comes
 * first — and treat a single short sentence as headline-only.
 */
export function splitHeadlineAndBody(clean: string): { headline: string; body: string } {
  const text = normalizeWhitespace(clean.replace(/\r/g, ''));
  if (!text) return { headline: '', body: '' };

  const newlineIdx = clean.indexOf('\n');
  if (newlineIdx > 0) {
    const head = clean.slice(0, newlineIdx);
    const rest = clean.slice(newlineIdx + 1);
    if (normalizeWhitespace(head).length >= 10) {
      return { headline: toWireHeadline(head), body: normalizeWhitespace(rest) };
    }
  }

  const dashSplit = text.match(/^(.{15,120}?)\s+[—–]\s+(.+)$/);
  if (dashSplit?.[1] && dashSplit[2]) {
    return { headline: toWireHeadline(dashSplit[1]), body: normalizeWhitespace(dashSplit[2]) };
  }

  const parts = text.split(SENTENCE_BOUNDARY);
  const first = parts[0];
  if (!first || parts.length === 1) {
    return text.length <= 140
      ? { headline: toWireHeadline(text), body: '' }
      : { headline: toWireHeadline(truncate(text, 120)), body: text };
  }

  return { headline: toWireHeadline(first), body: normalizeWhitespace(parts.slice(1).join(' ')) };
}

/** Truncate on a word boundary, appending an ellipsis when anything was cut. */
export function truncate(s: string, max: number): string {
  const text = s.trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s.,;:—–-]+$/, '')}...`;
}

/**
 * All-caps is the newswire's default voice, not a signal of shouting — callers
 * use this to tighten ticker matching, never to reject a post.
 */
export function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase();
}

/** Decode the handful of HTML entities that actually show up in RSS titles. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

export function stripHtml(s: string): string {
  return normalizeWhitespace(decodeEntities(s.replace(/<[^>]*>/g, ' ')));
}
