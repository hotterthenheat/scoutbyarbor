import type { Category, CategoryVerdict, ExtractedEntities } from '../../core/types.js';
import { CATEGORIES } from '../../core/types.js';
import type { TaxonomyCategory, TaxonomyFile } from '../../config/types.js';

/**
 * CLASSIFY (§4).
 *
 * Ten categories, scored on keyword, phrase and entity evidence. Two design
 * choices matter more than the keyword lists themselves:
 *
 *   - `requires` gates. MARKET and EQUITY cannot fire without a materiality
 *     term, so ordinary price movement and bare company mentions never become
 *     alerts.
 *   - precedence. An actual data release is ECONOMIC rather than MACRO, a
 *     Powell remark is FED rather than MACRO, and an earnings post is EARNINGS
 *     rather than EQUITY — the spec gives each of those its own alert type, so
 *     a near-tie resolves toward the more specific one.
 */

export interface CategoryClassifierInput {
  text: string;
  tokens: string[];
  entities: ExtractedEntities;
  sourceCategory: Category | 'MIXED';
  isCurated?: boolean;
}

export interface CategoryClassifier {
  classify(input: CategoryClassifierInput): CategoryVerdict | null;
}

const PHRASE_WEIGHT = 3;
/** A satisfied materiality gate is itself evidence, not just a gate. */
const REQUIRES_WEIGHT = 2;
const KEYWORD_WEIGHT = 1;
/** Below this, the evidence is too thin to call it anything (§20 NO_CATEGORY). */
const MIN_EVIDENCE = 2.5;

/**
 * A weaker tier, for market news that is real but thinly worded.
 *
 * "OPEC+ AGREES TO CUT OUTPUT BY 1 MILLION BARRELS PER DAY" scores a single
 * keyword and was therefore dropped outright — a genuine, market-moving
 * commodity headline discarded for using few of the words the taxonomy happens
 * to list. Requiring 2.5 points of evidence is right for a CONFIDENT call; it
 * is too strict for "does this belong on a market wire at all".
 *
 * So one point of evidence is enough — but ONLY alongside a recognised market
 * entity: a ticker, an institution, a country, a commodity, a named policymaker.
 *
 * That second condition is not decoration. Without it, "Manchester United BEAT
 * Arsenal 3-1" classified as EARNINGS, because `beat` is an earnings keyword
 * and a single keyword was enough. A generic word is not evidence that a story
 * is about markets; a generic word ATTACHED TO OPEC, or the Fed, or a ticker,
 * is. OPEC+ cutting output has the entity and passes. A football result has no
 * entity and never leaves the classifier.
 *
 * Confidence is scored accordingly, so a thin classification competes weakly:
 * it reaches the general feed and still has to earn a trading channel on the
 * market-impact test. Nothing here bypasses the noise filters, which run
 * afterwards.
 */
const FALLBACK_EVIDENCE = 1;

/** Does the text name something a market actually trades or reacts to? */
function hasMarketEntity(entities: CategoryClassifierInput['entities']): boolean {
  return (
    entities.tickers.length > 0 ||
    entities.organizations.length > 0 ||
    entities.commodities.length > 0 ||
    entities.people.length > 0 ||
    entities.countries.length > 0
  );
}

/** Applied when two categories are close; the more specific one should win. */
const PRECEDENCE: Category[] = [
  'EARNINGS',
  'FED',
  'ECONOMIC',
  'GEOPOLITICAL',
  'COMMODITY',
  'CRYPTO',
  'OPTIONS',
  'EQUITY',
  'MARKET',
  'MACRO',
];

interface CompiledCategory {
  category: Category;
  def: TaxonomyCategory;
  keywords: Set<string>;
  phrases: Array<{ text: string; pattern: RegExp }>;
  requires: Array<{ text: string; pattern: RegExp }>;
  subcategories: Array<{ name: string; patterns: RegExp[] }>;
}

export function createCategoryClassifier(taxonomy: TaxonomyFile): CategoryClassifier {
  const compiled: CompiledCategory[] = [];

  for (const category of CATEGORIES) {
    const def = taxonomy.categories[category];
    if (!def) continue;

    compiled.push({
      category,
      def,
      keywords: new Set((def.keywords ?? []).filter((k) => !k.includes(' ')).map((k) => k.toLowerCase())),
      phrases: [
        ...(def.phrases ?? []),
        ...(def.keywords ?? []).filter((k) => k.includes(' ')),
      ].map((text) => ({ text, pattern: wordBoundary(text) })),
      requires: (def.requires ?? []).map((text) => ({ text, pattern: wordBoundary(text) })),
      subcategories: Object.entries(def.subcategories ?? {}).map(([name, terms]) => ({
        name,
        patterns: (terms ?? []).map(wordBoundary),
      })),
    });
  }

  function classify(input: CategoryClassifierInput): CategoryVerdict | null {
    const lower = input.text.toLowerCase();
    const tokenSet = new Set(input.tokens);
    const scores = new Map<Category, { score: number; signals: string[] }>();

    for (const c of compiled) {
      const signals: string[] = [];
      let score = 0;

      for (const keyword of c.keywords) {
        if (tokenSet.has(keyword)) {
          score += KEYWORD_WEIGHT;
          signals.push(`${c.category}:kw:${keyword}`);
        }
      }
      for (const phrase of c.phrases) {
        if (phrase.pattern.test(lower)) {
          score += PHRASE_WEIGHT;
          signals.push(`${c.category}:phrase:${phrase.text}`);
        }
      }

      // A gated category needs a materiality term, or it does not fire at all.
      if (c.requires.length > 0) {
        const satisfied = c.requires.find((r) => r.pattern.test(lower));
        if (!satisfied) {
          scores.set(c.category, { score: 0, signals: [`${c.category}:requires-unmet`] });
          continue;
        }
        signals.push(`${c.category}:requires:${satisfied.text}`);
        score += REQUIRES_WEIGHT;
      }

      score *= c.def.weight ?? 1;
      score += entityBoost(c.category, input.entities, signals);

      if (input.sourceCategory === c.category) {
        score += 0.5;
        signals.push(`${c.category}:source-beat`);
      }

      scores.set(c.category, { score, signals });
    }

    const ranked = [...scores.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || precedenceOf(a.category) - precedenceOf(b.category));

    let winner = ranked[0];

    // For curated sources, if the text didn't hit ANY keywords but human curation
    // says it's news, give it a baseline MACRO score so it isn't discarded.
    if (!winner && input.isCurated) {
      winner = { category: 'MACRO', score: 0.1, signals: ['category:curated-fallback'] };
    }

    const requiredEvidence = input.isCurated ? 0 : FALLBACK_EVIDENCE;
    if (!winner || winner.score < requiredEvidence) return null;

    const weak = winner.score < MIN_EVIDENCE;
    // A thin call needs a market entity to stand on. See FALLBACK_EVIDENCE.
    // Curated sources (like human-forwarded Discord channels) bypass this:
    // human judgement has already decided it is market-relevant.
    if (weak && !input.isCurated && !hasMarketEntity(input.entities)) return null;

    // Resolve a near-tie toward the more specific category.
    let chosen = winner;
    for (const candidate of ranked.slice(1)) {
      if (candidate.score >= winner.score * 0.85 && precedenceOf(candidate.category) < precedenceOf(chosen.category)) {
        chosen = candidate;
      }
    }

    const compiledChosen = compiled.find((c) => c.category === chosen.category);
    const subcategory = compiledChosen ? findSubcategory(compiledChosen, lower) : null;

    const secondary = ranked
      .filter((r) => r.category !== chosen.category && r.score >= chosen.score * 0.6)
      .map((r) => r.category)
      .slice(0, 3);

    return {
      category: chosen.category,
      subcategory,
      // Halved on the fallback tier, so a thin classification competes weakly
      // rather than arriving as an equal of a well-evidenced one.
      confidence: Math.min(1, chosen.score / 12) * (weak ? 0.5 : 1),
      signals: weak ? [...chosen.signals, 'category:weak-evidence'] : chosen.signals,
      secondary,
    };
  }

  return { classify };
}

function findSubcategory(c: CompiledCategory, lower: string): string | null {
  for (const sub of c.subcategories) {
    if (sub.patterns.some((p) => p.test(lower))) return sub.name;
  }
  return null;
}

/** Resolved entities are corroborating evidence for the categories they imply. */
function entityBoost(category: Category, entities: ExtractedEntities, signals: string[]): number {
  let boost = 0;
  const add = (amount: number, why: string): void => {
    boost += amount;
    signals.push(`${category}:entity:${why}`);
  };

  const strongTickers = entities.tickers.filter((t) => t.confidence >= 0.8);
  const centralBanks = entities.organizations.filter((o) =>
    ['FED', 'ECB', 'BOJ', 'BOE', 'BOC', 'PBOC', 'SNB', 'RBA', 'RBNZ'].includes(o),
  );

  switch (category) {
    case 'EQUITY':
    case 'EARNINGS':
      if (strongTickers.length > 0) add(2, `ticker:${strongTickers[0]?.ticker}`);
      break;
    case 'GEOPOLITICAL':
      if (entities.countries.length >= 2) add(2, 'countries');
      else if (entities.countries.length === 1) add(1, 'country');
      // A head of state acting is geopolitics almost by definition.
      if (
        entities.people.some((p) =>
          ['TRUMP', 'PUTIN', 'ZELENSKY', 'XI', 'NETANYAHU', 'KHAMENEI', 'MBS'].includes(p),
        )
      ) {
        add(1.5, 'head-of-state');
      }
      break;
    case 'COMMODITY':
      if (entities.commodities.length > 0) add(2, `commodity:${entities.commodities[0]}`);
      break;
    case 'FED':
      if (centralBanks.length > 0) add(2.5, `cb:${centralBanks[0]}`);
      if (entities.people.some((p) => ['POWELL', 'LAGARDE', 'UEDA', 'BAILEY', 'WALLER', 'WILLIAMS', 'BOWMAN', 'GOOLSBEE'].includes(p))) {
        add(2, 'official');
      }
      break;
    case 'ECONOMIC':
      if (entities.organizations.some((o) => ['BLS', 'BEA', 'CENSUS'].includes(o))) add(2, 'agency');
      break;
    default:
      break;
  }
  return boost;
}

function precedenceOf(category: Category): number {
  const idx = PRECEDENCE.indexOf(category);
  return idx === -1 ? PRECEDENCE.length : idx;
}

function wordBoundary(text: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(text.toLowerCase())}(?![A-Za-z0-9])`, 'i');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
