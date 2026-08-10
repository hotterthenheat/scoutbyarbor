import type { Category, NormalizedPost, RejectionReason } from '../core/types.js';
import { significantTokens, simhashSimilarity, textSimilarity, tokenize } from '../util/text.js';

/**
 * DEDUPLICATE (§17).
 *
 * The same event reaches Scout through DeltaOne, FirstSquawk, Reuters,
 * Bloomberg, FinancialJuice and AP. It must become ONE event, not six alerts.
 *
 * Five layers, cheapest first, short-circuiting on the first hit:
 *   1. exact source post id      (handled upstream by raw_posts, re-checked here)
 *   2. canonicalised URL
 *   3. identical fingerprint
 *   4. normalised-text similarity inside the window
 *   5. shared entities + a lower similarity bar inside the window
 *
 * Layer 5 is what actually collapses reworded wire copy, because
 * "US AND IRAN REACH DEAL" and "U.S. AND IRAN HAVE REACHED AGREEMENT" share
 * few literal tokens but the same subject.
 */

export interface DedupeCandidateLike {
  id: string;
  headline: string;
  fingerprint: string;
  simhash: string;
  tickers: string[];
  countries: string[];
  category: Category | null;
  eventId: string | null;
  timestamp: string;
  importance: number;
  originalUrl?: string | null;
}

export interface DedupeInput {
  post: NormalizedPost;
  candidates: DedupeCandidateLike[];
  similarityThreshold: number;
  windowMinutes: number;
  now: string;
}

export interface DedupeResult {
  isDuplicate: boolean;
  reason: RejectionReason | null;
  matchedNewsEventId: string | null;
  matchedEventId: string | null;
  similarity: number;
  signals: string[];
}

/**
 * Entity-match layer needs agreement on subject, not on wording:
 * "US AND IRAN REACH DEAL" and "U.S. AND IRAN HAVE REACHED AGREEMENT" share
 * almost no literal tokens. The polarity guard below is what keeps this floor
 * safe — a reversal of the same story is not a duplicate of it.
 */
const ENTITY_SIMILARITY_FLOOR = 0.4;

/**
 * Numbers quoted in a headline, normalised so 198,000 and 198000 are one value.
 *
 * Two economic releases inside the same window share almost everything the
 * entity layer looks at — country US, category ECONOMIC, a "X VS Y EXPECTED"
 * shape — and merging them hides one of them. What actually separates them is
 * the figures: CPI quotes 0.4 and 0.2, jobless claims quote 198000 and 215000.
 * Nothing in common.
 */
function figuresIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/-?\d[\d,]*\.?\d*/g)) {
    const raw = match[0].replace(/,/g, '').replace(/\.$/, '');
    const value = Number(raw);
    // Years and small ordinals are shape, not substance: "Q2", "2026", "50 BPS"
    // all appear in unrelated stories about the same subject.
    if (!Number.isFinite(value)) continue;
    out.add(String(value));
  }
  return out;
}

/**
 * True when both headlines quote figures and share none of them.
 *
 * Used to WITHHOLD the relaxed entity floor, not to force a miss: a pair this
 * separates can still merge on the strict text threshold, which is what catches
 * the same release reported with an extra decimal place.
 */
export function quotesDifferentFigures(a: string, b: string): boolean {
  const left = figuresIn(a);
  const right = figuresIn(b);
  if (left.size === 0 || right.size === 0) return false;
  for (const value of left) if (right.has(value)) return false;
  return true;
}

export function detectDuplicate(input: DedupeInput): DedupeResult {
  const { post, candidates, similarityThreshold, windowMinutes } = input;
  const signals: string[] = [];
  const nowMs = Date.parse(input.now);
  const windowMs = windowMinutes * 60_000;

  const inWindow = candidates.filter((c) => {
    const ts = Date.parse(c.timestamp);
    return Number.isFinite(ts) && nowMs - ts <= windowMs && nowMs - ts >= -windowMs;
  });

  const miss = (): DedupeResult => ({
    isDuplicate: false,
    reason: null,
    matchedNewsEventId: null,
    matchedEventId: null,
    similarity: 0,
    signals,
  });

  if (inWindow.length === 0) {
    signals.push('dedupe:no-candidates');
    return miss();
  }

  const hit = (
    c: DedupeCandidateLike,
    reason: RejectionReason,
    similarity: number,
    signal: string,
  ): DedupeResult => {
    signals.push(signal);
    return {
      isDuplicate: true,
      reason,
      matchedNewsEventId: c.id,
      matchedEventId: c.eventId,
      similarity,
      signals,
    };
  };

  // ── Layer 2: same URL, ignoring tracking parameters ──────────────────────
  const postUrl = post.originalUrl ? canonicalizeUrl(post.originalUrl) : null;
  if (postUrl) {
    for (const c of inWindow) {
      if (c.originalUrl && canonicalizeUrl(c.originalUrl) === postUrl) {
        return hit(c, 'DUPLICATE_URL', 1, `dedupe:url:${c.id}`);
      }
    }
  }

  // ── Layer 3: identical significant content ───────────────────────────────
  for (const c of inWindow) {
    if (c.fingerprint && c.fingerprint === post.fingerprint) {
      return hit(c, 'DUPLICATE_TEXT', 1, `dedupe:fingerprint:${c.id}`);
    }
  }

  // ── Layers 4 and 5: similarity, with and without entity agreement ────────
  const postHeadline = headlineEquivalent(post.headline || post.cleanText);
  const postEntities = entitySetFor(post);

  let best: { candidate: DedupeCandidateLike; similarity: number; viaEntities: boolean } | null =
    null;

  for (const c of inWindow) {
    const headlineSim = textSimilarity(postHeadline, headlineEquivalent(c.headline));
    const structuralSim = simhashSimilarity(post.simhash, c.simhash);
    const similarity = Math.max(headlineSim, (headlineSim + structuralSim) / 2);

    const shared = sharedEntities(postEntities, entitySetForCandidate(c));
    // Two releases quoting entirely different numbers are different releases,
    // however much subject vocabulary they share. They may still merge on the
    // strict text threshold below — this only withholds the relaxed floor.
    // From the RAW headlines: headlineEquivalent strips decimal points and
    // thousands separators, so "0.4" and "198,000" would both degrade into a
    // set containing "0" and every pair would look like it shared a figure.
    const differentFigures = quotesDifferentFigures(post.headline, c.headline);
    const viaEntities =
      shared > 0 && similarity >= ENTITY_SIMILARITY_FLOOR && !differentFigures;
    const viaText = similarity >= similarityThreshold;

    if (!viaText && !viaEntities) continue;
    if (!best || similarity > best.similarity) best = { candidate: c, similarity, viaEntities };
  }

  if (best) {
    // A negation flip means this is a development, not a repeat: "TALKS
    // COLLAPSE" must not be swallowed by "REACH DEAL".
    if (polarityDiffers(postHeadline, headlineEquivalent(best.candidate.headline))) {
      signals.push(`dedupe:polarity-differs:${best.candidate.id}`);
      return miss();
    }
    return hit(
      best.candidate,
      'DUPLICATE_TEXT',
      best.similarity,
      `dedupe:${best.viaEntities ? 'entity' : 'text'}:${best.candidate.id}:${best.similarity.toFixed(2)}`,
    );
  }

  signals.push('dedupe:unique');
  return miss();
}

/**
 * Strip everything that varies between wires reporting the same fact: the
 * service prefix, punctuation inside abbreviations, and ampersands.
 */
export function headlineEquivalent(text: string): string {
  return text
    .toUpperCase()
    .replace(/^\s*(?:[A-Z][A-Z0-9.\s]{1,24}?):\s+/, '') // "AXIOS:", "REUTERS:", "BREAKING:"
    .replace(/\bU\.?\s?S\.?\b/g, 'US')
    .replace(/\bU\.?\s?K\.?\b/g, 'UK')
    .replace(/\bE\.?\s?U\.?\b/g, 'EU')
    .replace(/&/g, ' AND ')
    .replace(/[.,;:'"“”‘’()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical URL for identity comparison — not for display. */
export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '') || '/';

    const params = [...parsed.searchParams.entries()]
      .filter(([k]) => !/^(?:utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|source|s|t)$/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    return `${host}${path}${params ? `?${params}` : ''}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/** Words whose presence flips a headline's meaning. */
const NEGATIONS = new Set([
  'no', 'not', 'never', 'without', 'denies', 'denied', 'rejects', 'rejected',
  'collapse', 'collapses', 'collapsed', 'fails', 'failed', 'failure', 'halts',
  'halted', 'cancels', 'cancelled', 'canceled', 'withdraws', 'withdrawn',
  'refuses', 'refused', 'blocks', 'blocked', 'ends', 'ended', 'breaks',
]);

function polarityDiffers(a: string, b: string): boolean {
  const negA = tokenize(a).some((t) => NEGATIONS.has(t));
  const negB = tokenize(b).some((t) => NEGATIONS.has(t));
  return negA !== negB;
}

function entitySetFor(post: NormalizedPost): Set<string> {
  // Entity extraction has not run at dedupe time, so approximate with the
  // proper-noun-ish tokens. Cheap, and only used as a co-occurrence signal.
  return new Set(significantTokens(post.tokens).filter((t) => t.length >= 3));
}

function entitySetForCandidate(c: DedupeCandidateLike): Set<string> {
  const out = new Set<string>();
  for (const t of c.tickers) out.add(t.toLowerCase());
  for (const c2 of c.countries) out.add(c2.toLowerCase());
  for (const t of significantTokens(tokenize(c.headline))) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

function sharedEntities(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const item of a) if (b.has(item)) n++;
  return n;
}
