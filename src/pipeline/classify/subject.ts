import type { Category, ExtractedEntities } from '../../core/types.js';

/**
 * SUBJECT IDENTIFICATION (§20).
 *
 * Some categories are inherently *about a company*. An EQUITY, EARNINGS or
 * OPTIONS alert is a claim that something happened to one specific issuer, and
 * that claim is only usable if the reader can tell which issuer it was.
 *
 * The wire published this:
 *
 *     EQUITY ALERT
 *     38-UNIT MOE'S FRANCHISEE DECLARES BANKRUPTCY
 *
 * Every part of the classifier behaved correctly. "bankruptcy" is a genuine
 * materiality term, RESTRUCTURING is a genuine subcategory, and the market
 * impact assessor reported `relevance: none` — it knew there was nothing here
 * to trade. The score still cleared the bar by nine tenths of a point, because
 * nothing in the chain asked the one question that decides whether a
 * single-name story is news at all: WHICH COMPANY?
 *
 * A 38-unit franchisee of a privately held brand is not an issuer. There is no
 * ticker, no bond, no counterparty exposure — no way to act on it, and no way
 * for a desk to even decide whether to care. It is trade-press material, and
 * carrying it costs more than missing it: every unusable alert trains the
 * reader to skim past the ones that matter.
 *
 * ── WHAT COUNTS AS IDENTIFIED ────────────────────────────────────────────────
 *
 * Either Scout resolved a security, or the taxonomy recognised the institution.
 * Both mean the same thing operationally: the subject is a name the desk
 * already tracks.
 *
 * ── THE SCALE ESCAPE HATCH ───────────────────────────────────────────────────
 *
 * A hard "resolvable issuer or nothing" rule would be wrong, because the
 * bankruptcies that move credit markets are frequently *private* companies
 * absent from any security master. First Brands is the obvious case: no ticker,
 * and its Chapter 11 repriced a swathe of private credit.
 *
 * What separates that from Moe's is not the ticker, it is the size — and the
 * size is usually stated right there in the headline. So an unidentified
 * subject still publishes when the text carries a figure large enough to make
 * it matter on its own. The bar is not "Scout knows this company", it is
 * "Scout can size this event".
 *
 * A headline that names no one and states no magnitude fails both, and that is
 * the one this gate is for.
 */

/**
 * Categories that assert something about a single issuer. The rest —
 * MACRO, FED, ECONOMIC, GEOPOLITICAL, MARKET, COMMODITY, CRYPTO — describe
 * conditions rather than companies, and are meaningful with no company named
 * at all.
 */
const SINGLE_NAME_CATEGORIES = new Set<Category>(['EQUITY', 'EARNINGS', 'OPTIONS']);

/**
 * The floor for the scale escape hatch, in USD.
 *
 * Set at a billion because that is roughly where a private company's failure
 * stops being a local story and starts showing up in somebody's credit book.
 */
const MATERIAL_USD = 1_000_000_000;

export interface SubjectInput {
  category: Category;
  entities: ExtractedEntities;
}

export interface SubjectVerdict {
  /** False → the event names no tradeable subject and states no scale. */
  identified: boolean;
  /** Reasoning, appended to the event's signals either way. */
  reason: string;
}

/** A currency figure at or above the materiality floor. */
function statesMaterialScale(entities: ExtractedEntities): number | null {
  for (const figure of entities.figures) {
    if (figure.kind !== 'CURRENCY') continue;
    if (typeof figure.value !== 'number' || !Number.isFinite(figure.value)) continue;
    if (figure.value >= MATERIAL_USD) return figure.value;
  }
  return null;
}

/** Rounds to the nearest billion for the signal text: 1e10 → "$10B". */
function billions(usd: number): string {
  return `$${Math.round(usd / 1_000_000_000)}B`;
}

export function identifySubject(input: SubjectInput): SubjectVerdict {
  if (!SINGLE_NAME_CATEGORIES.has(input.category)) {
    return { identified: true, reason: `subject:n/a ${input.category} is not single-name` };
  }

  const ticker = input.entities.tickers[0];
  if (ticker) {
    return { identified: true, reason: `subject:ticker ${ticker.ticker}` };
  }

  const org = input.entities.organizations[0];
  if (org) {
    return { identified: true, reason: `subject:org ${org}` };
  }

  const scale = statesMaterialScale(input.entities);
  if (scale !== null) {
    // No name, but a number big enough to stand on its own.
    return { identified: true, reason: `subject:unnamed but sized ${billions(scale)}` };
  }

  return {
    identified: false,
    reason: `subject:none — ${input.category} names no security or institution and states no scale`,
  };
}
