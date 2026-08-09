import type { Security, TickerMatch } from '../../core/types.js';
import { isAllCaps } from '../../util/text.js';

/**
 * Ticker extraction (§25).
 *
 * The previous system turned ordinary words into tickers — META-ANALYSIS became
 * $META — so this module is built around refusing to guess. Three defences:
 *
 *   1. a real security master, with a per-symbol `ambiguity` level
 *   2. a standalone-token rule, so a hyphenated or possessive compound can
 *      never surrender a fragment as a symbol
 *   3. an evidence trail on every match, so a false positive is diagnosable
 *      from #scout-raw instead of being a mystery
 *
 * A missed ticker costs one tag on one alert. A false ticker puts a wrong
 * company on the wire. When the evidence is thin, we decline.
 */

export interface TickerExtractorOptions {
  securities: Security[];
  stopwords?: string[];
}

export interface TickerExtractor {
  extract(text: string, meta?: Record<string, unknown>): TickerMatch[];
}

/** Acronyms that must never bare-match, whatever the security master says. */
export const DEFAULT_TICKER_STOPWORDS = [
  'CEO', 'CFO', 'COO', 'CTO', 'CIO', 'CPI', 'PPI', 'PCE', 'GDP', 'NFP', 'FOMC',
  'ETF', 'ETFS', 'IPO', 'SEC', 'FDA', 'DOJ', 'FTC', 'FCC', 'IRS', 'EPA', 'OPEC',
  'NATO', 'EPS', 'PMI', 'ISM', 'ADP', 'JOLTS', 'YOY', 'QOQ', 'MOM', 'EBIT',
  'EBITDA', 'ECB', 'BOJ', 'BOE', 'BOC', 'RBA', 'RBNZ', 'SNB', 'PBOC', 'IMF',
  'WTO', 'UN', 'EU', 'US', 'USA', 'UK', 'AI', 'EV', 'ESG', 'GAAP', 'QE', 'QT',
  'Q1', 'Q2', 'Q3', 'Q4', 'FY', 'AM', 'PM', 'ET', 'EST', 'EDT', 'GMT', 'UTC',
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD', 'BPS', 'BLN',
  'MLN', 'YTD', 'WSJ', 'CNBC', 'AP', 'AFP', 'NEWS', 'BREAKING', 'UPDATE',
  'ALERT', 'LIVE', 'VIA', 'RT', 'TBD', 'TBA', 'CEO', 'MD', 'VP',
];

/**
 * Company names that collapse to a single ordinary English word once the
 * corporate suffix is stripped. "Target Corp" must not let the word "target"
 * in "raises price target" resolve to TGT.
 */
const COMMON_SINGLE_WORDS = new Set([
  'target', 'block', 'square', 'open', 'snap', 'net', 'shop', 'coin', 'spot',
  'dash', 'team', 'now', 'key', 'all', 'cat', 'dow', 'ice', 'low', 'well',
  'big', 'run', 'real', 'true', 'love', 'play', 'car', 'eat', 'fast', 'has',
  'are', 'see', 'gold', 'silver', 'copper', 'total', 'shell', 'ford', 'visa',
  'progressive', 'travelers', 'discovery', 'paramount', 'fox', 'chipotle',
  'match', 'peak', 'summit', 'apex', 'core', 'edge', 'pure', 'prime', 'first',
  'general', 'united', 'american', 'national', 'global', 'standard', 'liberty',
]);

/** Words that make a nearby ambiguous symbol plausible as a company. */
const CORPORATE_CONTEXT = new Set([
  'shares', 'share', 'stock', 'stocks', 'earnings', 'revenue', 'guidance',
  'eps', 'dividend', 'buyback', 'upgraded', 'downgraded', 'upgrade',
  'downgrade', 'acquires', 'acquired', 'acquisition', 'merger', 'merges',
  'takeover', 'ceo', 'cfo', 'quarterly', 'quarter', 'filing', 'filed', 'ipo',
  'analyst', 'analysts', 'nasdaq', 'nyse', 'halted', 'split', 'sec',
  'investors', 'valuation', 'market', 'profit', 'sales', 'outlook', 'forecast',
  'reports', 'reported', 'announces', 'announced', 'unveils', 'launches',
  'recall', 'lawsuit', 'bankruptcy', 'layoffs', 'stake', 'bid', 'deal',
]);

const CORPORATE_SUFFIX_RE =
  /\s*(?:,)?\s*\b(?:inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|ltd|ltd\.|limited|plc|sa|nv|ag|se|holdings|holding|group|companies|trust|lp|llc|class\s+[abc])\b\.?/gi;

const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9.\-]{0,6})\b/g;
const SYMBOL_RE = /\b([A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?)\b/g;

export function createTickerExtractor(opts: TickerExtractorOptions): TickerExtractor {
  const stopwords = new Set(
    [...DEFAULT_TICKER_STOPWORDS, ...(opts.stopwords ?? [])].map((s) => s.toUpperCase()),
  );

  const byTicker = new Map<string, Security>();
  for (const sec of opts.securities) byTicker.set(sec.ticker.toUpperCase(), sec);

  // Name index: normalised surface form → ticker. Longest first so
  // "Meta Platforms" wins over a bare "Meta".
  const nameIndex: Array<{ pattern: RegExp; ticker: string; surface: string; isAlias: boolean }> =
    [];

  for (const sec of opts.securities) {
    const variants = new Set<string>();
    addNameVariants(sec.name, variants);
    for (const alias of sec.aliases) addNameVariants(alias, variants);

    for (const variant of variants) {
      const trimmed = variant.trim();
      if (trimmed.length < 2) continue;
      // A single ordinary word is not enough evidence on its own.
      if (!trimmed.includes(' ') && COMMON_SINGLE_WORDS.has(trimmed.toLowerCase())) continue;

      nameIndex.push({
        pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(trimmed)}(?![A-Za-z0-9])`, 'i'),
        ticker: sec.ticker,
        surface: trimmed,
        isAlias: trimmed.toLowerCase() !== stripSuffixes(sec.name).toLowerCase(),
      });
    }
  }
  nameIndex.sort((a, b) => b.surface.length - a.surface.length);

  function extract(text: string, meta?: Record<string, unknown>): TickerMatch[] {
    if (!text) return [];
    const found = new Map<string, TickerMatch>();

    const record = (m: TickerMatch): void => {
      const existing = found.get(m.ticker);
      if (!existing || m.confidence > existing.confidence) found.set(m.ticker, m);
    };

    // ── 1. Cashtags. Unambiguous by construction. ──────────────────────────
    for (const match of text.matchAll(CASHTAG_RE)) {
      const symbol = (match[1] ?? '').toUpperCase();
      if (byTicker.has(symbol)) {
        record({ ticker: symbol, evidence: 'CASHTAG', confidence: 0.99, matchedText: match[0] });
      }
    }

    // ── 2. Company names and aliases. ──────────────────────────────────────
    for (const entry of nameIndex) {
      if (found.has(entry.ticker) && (found.get(entry.ticker)?.confidence ?? 0) >= 0.95) continue;
      const m = entry.pattern.exec(text);
      if (m) {
        record({
          ticker: entry.ticker,
          evidence: entry.isAlias ? 'ALIAS' : 'NAME',
          confidence: 0.95,
          matchedText: m[0],
        });
      }
    }

    // ── 3. Provider metadata from the adapter. ─────────────────────────────
    for (const key of ['cashtags', 'tickers'] as const) {
      const supplied = meta?.[key];
      if (!Array.isArray(supplied)) continue;
      for (const item of supplied) {
        if (typeof item !== 'string') continue;
        const symbol = item.replace(/^\$/, '').toUpperCase();
        if (byTicker.has(symbol)) {
          record({
            ticker: symbol,
            evidence: 'PROVIDER_METADATA',
            confidence: 0.9,
            matchedText: item,
          });
        }
      }
    }

    // ── 4. Bare uppercase symbols — the dangerous path. ────────────────────
    const allCaps = isAllCaps(text);
    const contextTokens = new Set(
      (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => CORPORATE_CONTEXT.has(t)),
    );

    for (const match of text.matchAll(SYMBOL_RE)) {
      const symbol = match[0];
      const index = match.index ?? 0;

      if (stopwords.has(symbol)) continue;
      const sec = byTicker.get(symbol);
      if (!sec) continue;

      // A cashtag already covered this occurrence.
      if (text[index - 1] === '$') continue;

      // Standalone-token rule: a neighbouring letter, digit, hyphen, slash or
      // apostrophe means this is part of a larger word. META-ANALYSIS dies here.
      if (!isStandalone(text, index, symbol.length)) continue;

      if (sec.ambiguity === 'blocked') continue;

      if (sec.ambiguity === 'safe') {
        record({ ticker: symbol, evidence: 'BARE_SYMBOL', confidence: 0.8, matchedText: symbol });
        continue;
      }

      // Ambiguous: needs corroboration from elsewhere in the same text.
      const alreadyEvidenced = (found.get(symbol)?.confidence ?? 0) >= 0.9;
      if (alreadyEvidenced) continue; // already recorded at higher confidence

      if (contextTokens.size > 0) {
        record({
          ticker: symbol,
          evidence: 'BARE_SYMBOL',
          confidence: allCaps ? 0.7 : 0.75,
          matchedText: symbol,
        });
      }
    }

    return [...found.values()].sort(
      (a, b) => b.confidence - a.confidence || a.ticker.localeCompare(b.ticker),
    );
  }

  return { extract };
}

/**
 * True when the run of characters at [index, index+length) is its own token.
 * This is the single rule that stops fragments of compounds becoming tickers.
 */
function isStandalone(text: string, index: number, length: number): boolean {
  const before = index > 0 ? text[index - 1] : '';
  const after = index + length < text.length ? text[index + length] : '';
  const attached = /[A-Za-z0-9\-/'’.]/;

  if (before && attached.test(before)) return false;
  // A trailing period is fine at the end of a sentence, but not mid-token
  // ("BRK.B" is handled by the symbol pattern itself).
  if (after && attached.test(after)) {
    if (after === '.' && (index + length + 1 >= text.length || /\s/.test(text[index + length + 1] ?? ' '))) {
      return true;
    }
    return false;
  }
  return true;
}

function addNameVariants(name: string, into: Set<string>): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  into.add(trimmed);
  const stripped = stripSuffixes(trimmed);
  if (stripped && stripped.length >= 3) into.add(stripped);
}

function stripSuffixes(name: string): string {
  return name.replace(CORPORATE_SUFFIX_RE, '').replace(/[,.]+$/, '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
