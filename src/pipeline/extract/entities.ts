import type { ExtractedEntities, ExtractedFigure } from '../../core/types.js';
import type { TaxonomyFile } from '../../config/types.js';
import type { TickerExtractor } from './tickers.js';

/**
 * Entity extraction: who and what an item is about, plus the numbers in it.
 *
 * Surface forms come from the taxonomy so they are editable without a deploy.
 * Longest form wins, which is why "North Korea" never resolves as "Korea" and
 * "South China Sea" does not also yield CN.
 */

export interface EntityExtractor {
  extract(text: string, meta?: Record<string, unknown>): ExtractedEntities;
}

export interface EntityExtractorDeps {
  taxonomy: TaxonomyFile;
  tickers: TickerExtractor;
}

interface SurfaceEntry {
  canonical: string;
  surface: string;
  pattern: RegExp;
}

export function createEntityExtractor(deps: EntityExtractorDeps): EntityExtractor {
  const { taxonomy, tickers } = deps;

  const countries = buildIndex(taxonomy.countries);
  const organizations = buildIndex(taxonomy.organizations);
  const people = buildIndex(taxonomy.people);
  const commodities = buildIndex(taxonomy.commodities);

  function extract(text: string, meta?: Record<string, unknown>): ExtractedEntities {
    return {
      tickers: tickers.extract(text, meta),
      countries: resolve(countries, text),
      organizations: resolve(organizations, text),
      people: resolve(people, text),
      commodities: resolve(commodities, text),
      figures: extractFigures(text),
    };
  }

  return { extract };
}

function buildIndex(map: Record<string, string[]>): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  for (const [canonical, surfaces] of Object.entries(map ?? {})) {
    for (const surface of surfaces ?? []) {
      const trimmed = surface.trim();
      if (!trimmed) continue;
      // A short all-caps form is an acronym, and matching it case-insensitively
      // would turn the pronoun "us" into the United States. Longer or mixed-case
      // forms stay case-insensitive.
      const acronym = /^[A-Z]{2,5}$/.test(trimmed);
      entries.push({
        canonical,
        surface: trimmed,
        pattern: new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(trimmed)}(?![A-Za-z0-9])`,
          acronym ? '' : 'i',
        ),
      });
    }
  }
  // Longest surface form first so the most specific match consumes the span.
  return entries.sort((a, b) => b.surface.length - a.surface.length);
}

/**
 * Matches are consumed from a working copy of the text, so a longer form having
 * matched prevents a shorter form inside it from matching again.
 */
function resolve(index: SurfaceEntry[], text: string): string[] {
  if (!text) return [];
  let working = text;
  const found: string[] = [];
  const seen = new Set<string>();

  for (const entry of index) {
    if (seen.has(entry.canonical)) continue;
    const match = entry.pattern.exec(working);
    if (!match) continue;
    seen.add(entry.canonical);
    found.push(entry.canonical);
    working =
      working.slice(0, match.index) + ' '.repeat(match[0].length) + working.slice(match.index + match[0].length);
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Figures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scale suffixes as they actually appear on the wire. Currency figures are
 * normalised to an absolute value so the magnitude scorer can compare a $30B
 * deal against a $400M one without re-parsing the suffix.
 */
const SCALE_FACTOR: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  mln: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  bln: 1e9,
  billion: 1e9,
  t: 1e12,
  trn: 1e12,
  trillion: 1e12,
};

const LABEL_WORDS = new Set([
  'eps', 'revenue', 'revenues', 'sales', 'cpi', 'pce', 'ppi', 'gdp', 'guidance',
  'margin', 'margins', 'profit', 'income', 'capex', 'buyback', 'buybacks',
  'dividend', 'rate', 'rates', 'yield', 'yields', 'inflation', 'unemployment',
  'payrolls', 'claims', 'target', 'estimate', 'estimates', 'consensus',
  'earnings', 'bookings', 'backlog', 'output', 'production', 'inventories',
]);

export function extractFigures(text: string): ExtractedFigure[] {
  if (!text) return [];
  const figures: ExtractedFigure[] = [];

  const push = (f: ExtractedFigure): void => {
    if (Number.isFinite(f.value)) figures.push(f);
  };

  // Basis points, including the spoken forms.
  for (const m of text.matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:bps|bp\b|basis\s+points?)/gi)) {
    push({
      kind: 'BPS',
      raw: m[0],
      value: Number(m[1]),
      unit: 'bps',
      label: labelNear(text, m.index ?? 0),
    });
  }
  for (const m of text.matchAll(/\b(quarter|half|full)[\s-]point\b/gi)) {
    const word = (m[1] ?? '').toLowerCase();
    push({
      kind: 'BPS',
      raw: m[0],
      value: word === 'quarter' ? 25 : word === 'half' ? 50 : 100,
      unit: 'bps',
      label: labelNear(text, m.index ?? 0),
    });
  }

  // Percentages.
  for (const m of text.matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:%|pct\b|percent\b)/gi)) {
    push({
      kind: 'PERCENT',
      raw: m[0],
      value: Number(m[1]),
      unit: '%',
      label: labelNear(text, m.index ?? 0),
    });
  }

  // Currency amounts, with or without a scale suffix.
  for (const m of text.matchAll(
    /([$€£¥])\s?\(?(-?\d+(?:[.,]\d+)*)\)?\s*(k|thousand|mm|mn|mln|million|m|bn|bln|billion|b|trn|trillion|t)?\b/gi,
  )) {
    const rawNumber = (m[2] ?? '').replace(/,/g, '');
    const negative = (m[0] ?? '').includes('(');
    const factor = SCALE_FACTOR[(m[3] ?? '').toLowerCase()] ?? 1;
    push({
      kind: 'CURRENCY',
      raw: m[0],
      value: (negative ? -1 : 1) * Number(rawNumber) * factor,
      unit: currencyFor(m[1] ?? '$'),
      label: labelNear(text, m.index ?? 0),
    });
  }

  // Multiples: "trading at 30x earnings".
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*x\b/gi)) {
    push({
      kind: 'MULTIPLE',
      raw: m[0],
      value: Number(m[1]),
      unit: 'x',
      label: labelNear(text, m.index ?? 0),
    });
  }

  return figures;
}

function currencyFor(symbol: string): string {
  switch (symbol) {
    case '€':
      return 'EUR';
    case '£':
      return 'GBP';
    case '¥':
      return 'JPY';
    default:
      return 'USD';
  }
}

/** Nearest known label word in the five tokens preceding the figure. */
function labelNear(text: string, index: number): string | null {
  const before = text.slice(Math.max(0, index - 60), index).toLowerCase();
  const tokens = before.match(/[a-z]+/g) ?? [];
  for (let i = tokens.length - 1; i >= 0 && i >= tokens.length - 5; i--) {
    const token = tokens[i];
    if (token && LABEL_WORDS.has(token)) return token;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
