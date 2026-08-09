import type { NormalizedPost, RawPost } from '../core/types.js';
import {
  decodeEntities,
  fingerprint,
  normalizeWhitespace,
  simhash64,
  splitHeadlineAndBody,
  stripHandles,
  stripTrailingHashtags,
  stripUrls,
  textSimilarity,
  tokenize,
} from '../util/text.js';

/**
 * NORMALIZE — the second stage (§2, §35).
 *
 * Turns a provider's payload into the canonical shape the rest of the pipeline
 * reasons about. URLs come out of the text but are kept in meta: the alert must
 * never show one (§3), yet the database keeps it (§24).
 */

export interface NormalizeOptions {
  now?: () => Date;
}

export function normalizePost(raw: RawPost, opts: NormalizeOptions = {}): NormalizedPost {
  const now = opts.now ?? (() => new Date());

  const decoded = decodeEntities(raw.text ?? '');
  const withoutRt = decoded.replace(/^\s*RT\s+@[A-Za-z0-9_]{1,15}:\s*/i, '');
  const { text: withoutUrls, urls } = stripUrls(withoutRt);
  const withoutHandles = stripHandles(withoutUrls);
  const cleanText = normalizeWhitespace(stripTrailingHashtags(withoutHandles));

  const { headline, body } = splitHeadlineAndBody(cleanText);
  const tokens = tokenize(cleanText);

  return {
    ...raw,
    // Preserve the provider's original text verbatim in rawText upstream; the
    // stripped URLs ride along in meta so nothing is silently lost.
    meta: { ...raw.meta, strippedUrls: urls },
    ingestionTime: raw.ingestionTime || now().toISOString(),
    cleanText,
    headline,
    body,
    tokens,
    fingerprint: fingerprint(tokens),
    simhash: simhash64(tokens),
    isEcho: detectEcho(raw, decoded, cleanText),
    language: detectLanguage(cleanText),
  };
}

/**
 * A retweet or quote that adds nothing is not news (§20). We only call it an
 * echo when the poster contributed no text of their own — a quote tweet with
 * real added reporting still gets a fair hearing from the classifier.
 */
function detectEcho(raw: RawPost, decoded: string, cleanText: string): boolean {
  const isRetweet = raw.meta?.isRetweet === true || /^\s*RT\s+@/i.test(decoded);
  const quoted = typeof raw.meta?.quotedText === 'string' ? raw.meta.quotedText : null;

  // An echo is a post that carries no information, not merely a retweet. A
  // newswire account relaying a headline verbatim is often the only route by
  // which Scout sees a source outside its watchlist, and dedupe already
  // collapses it against the original when both arrive.
  if (isRetweet && cleanText.trim().length === 0) return true;
  if (quoted && cleanText.length > 0) {
    // Quote post whose "own" text is really just a copy of what it quotes.
    return textSimilarity(cleanText, quoted) > 0.9;
  }
  return false;
}

/**
 * Cheap script check, not a language model. Non-Latin copy is held back unless
 * the source is official, because the classifiers are English-only.
 */
function detectLanguage(text: string): string {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return 'en';
  const nonLatin = letters.replace(/[\p{Script=Latin}]/gu, '').length;
  return nonLatin / letters.length > 0.3 ? 'non-latin' : 'en';
}
