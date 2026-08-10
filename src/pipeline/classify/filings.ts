import type { FilingData, Materiality } from '../../core/types.js';

/**
 * SEC FILINGS ENGINE (§16).
 *
 * EDGAR is a firehose and most of it is not news. The rule from the spec is
 * that materiality is classified first, and only CRITICAL/HIGH normally reaches
 * a user-facing channel — so this module's real job is deciding what to throw
 * away.
 *
 * 8-K item codes carry most of the signal, because the filer has already told
 * you what kind of event it is.
 */

/**
 * Plain-language wording for an item code.
 *
 * The classifier reads TEXT, and an EDGAR entry is bureaucratic metadata:
 * "8-K - ACME CORP (0001234567) (Filer) — Filed: 2026-08-10 AccNo: ...
 * Items: 1.03". There is not one word in that a taxonomy can categorise, so
 * every filing was rejected NO_CATEGORY before its materiality was ever
 * consulted — the item codes were sitting right there, already parsed, saying
 * "bankruptcy", and nothing turned them into language.
 *
 * Returns SEC's own description of the item, so the vocabulary is the filer's
 * rather than Scout's invention.
 */
export function describe8kItems(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const label = ITEM_MATERIALITY[item.trim()]?.label;
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

/** 8-K item → what it means and how much it matters. */
const ITEM_MATERIALITY: Record<string, { level: Materiality; label: string }> = {
  '1.01': { level: 'HIGH', label: 'material definitive agreement' },
  '1.02': { level: 'HIGH', label: 'termination of a material agreement' },
  '1.03': { level: 'CRITICAL', label: 'bankruptcy or receivership' },
  '2.01': { level: 'HIGH', label: 'completion of acquisition or disposition' },
  '2.02': { level: 'HIGH', label: 'results of operations' },
  '2.03': { level: 'MEDIUM', label: 'creation of a direct financial obligation' },
  '2.04': { level: 'CRITICAL', label: 'acceleration of a financial obligation' },
  '2.05': { level: 'MEDIUM', label: 'costs associated with exit or disposal' },
  '2.06': { level: 'CRITICAL', label: 'material impairment' },
  '3.01': { level: 'HIGH', label: 'delisting or transfer of listing' },
  '3.02': { level: 'MEDIUM', label: 'unregistered sale of equity' },
  '3.03': { level: 'MEDIUM', label: 'modification to security holder rights' },
  '4.01': { level: 'CRITICAL', label: 'change in certifying accountant' },
  '4.02': { level: 'CRITICAL', label: 'non-reliance on previously issued financials' },
  '5.01': { level: 'HIGH', label: 'change in control' },
  '5.02': { level: 'HIGH', label: 'departure or appointment of directors or officers' },
  '5.03': { level: 'LOW', label: 'amendment to bylaws or fiscal year' },
  '5.07': { level: 'LOW', label: 'submission of matters to a vote' },
  '7.01': { level: 'MEDIUM', label: 'Regulation FD disclosure' },
  '8.01': { level: 'MEDIUM', label: 'other events' },
  '9.01': { level: 'LOW', label: 'financial statements and exhibits' },
};

/** Forms whose materiality is fixed regardless of items. */
const FORM_MATERIALITY: Array<{ match: RegExp; level: Materiality; label: string }> = [
  { match: /^SC\s*13D(?!\/A)/i, level: 'CRITICAL', label: 'new activist stake (13D)' },
  { match: /^SC\s*13D\/A/i, level: 'HIGH', label: 'amended activist stake (13D/A)' },
  { match: /^SC\s*13G/i, level: 'LOW', label: 'passive stake (13G)' },
  { match: /^SC\s*TO-T/i, level: 'CRITICAL', label: 'third-party tender offer' },
  { match: /^S-1(?:\/A)?$/i, level: 'HIGH', label: 'registration statement (IPO)' },
  { match: /^S-3(?:\/A)?$/i, level: 'MEDIUM', label: 'shelf registration' },
  { match: /^S-4(?:\/A)?$/i, level: 'HIGH', label: 'merger registration statement' },
  { match: /^DEFM14A/i, level: 'HIGH', label: 'merger proxy' },
  { match: /^DEF\s*14A/i, level: 'LOW', label: 'proxy statement' },
  { match: /^10-K/i, level: 'MEDIUM', label: 'annual report' },
  { match: /^10-Q/i, level: 'MEDIUM', label: 'quarterly report' },
  { match: /^424B/i, level: 'LOW', label: 'prospectus' },
  { match: /^4$/i, level: 'LOW', label: 'insider transaction (Form 4)' },
  { match: /^3$/i, level: 'IGNORE', label: 'initial insider holdings (Form 3)' },
  { match: /^5$/i, level: 'LOW', label: 'annual insider statement (Form 5)' },
  { match: /^(?:CORRESP|UPLOAD|EFFECT|ARS|NT[\s-]|15-12B|15-15D|RW|AW|CT\sORDER)/i, level: 'IGNORE', label: 'administrative filing' },
];

const RANK: Record<Materiality, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  IGNORE: 0,
};

export interface FilingInput {
  form: string;
  items: string[];
  title: string;
  company: string;
  ticker: string | null;
  cik: string;
  filedAt: string;
  accessionNumber: string | null;
}

export function classifyFiling(input: FilingInput): FilingData {
  const form = (input.form ?? '').trim();
  const signals: string[] = [];
  let level: Materiality = 'IGNORE';

  const formRule = FORM_MATERIALITY.find((r) => r.match.test(form));
  if (formRule) {
    level = formRule.level;
    signals.push(`filing:form:${form}:${formRule.label}`);
  } else if (/^8-K/i.test(form)) {
    // An 8-K with no parsed items is still a material-event filing, but we
    // cannot say which kind, so it sits below the alert bar until we can.
    level = 'MEDIUM';
    signals.push('filing:form:8-K:unclassified');
  } else if (form) {
    signals.push(`filing:form:${form}:unrecognised`);
  }

  // Item codes outrank the form-level default: an 8-K is only as important as
  // the thing it is reporting.
  for (const raw of input.items ?? []) {
    const item = raw.trim();
    const rule = ITEM_MATERIALITY[item];
    if (!rule) {
      signals.push(`filing:item:${item}:unknown`);
      continue;
    }
    signals.push(`filing:item:${item}:${rule.label}`);
    if (RANK[rule.level] > RANK[level]) level = rule.level;
  }

  // A 5.02 that is specifically the CEO or CFO leaving is a different event
  // from a board member rotating off.
  if ((input.items ?? []).includes('5.02') && /chief executive|chief financial|\bceo\b|\bcfo\b/i.test(input.title)) {
    level = 'CRITICAL';
    signals.push('filing:item:5.02:ceo-or-cfo-departure');
  }
  if ((input.items ?? []).includes('1.01') && /merger|acquisition|definitive agreement/i.test(input.title)) {
    level = 'CRITICAL';
    signals.push('filing:item:1.01:merger-agreement');
  }

  return {
    form,
    cik: input.cik ?? '',
    company: input.company ?? '',
    ticker: input.ticker ?? null,
    filedAt: input.filedAt,
    items: input.items ?? [],
    materiality: level,
    materialitySignals: signals,
    accessionNumber: input.accessionNumber ?? null,
  };
}

/** EDGAR atom titles look like "8-K - NVIDIA CORP (0001045810) (Filer)". */
export function parseEdgarTitle(title: string): { form: string; company: string; cik: string } | null {
  const m = /^\s*(\S+(?:\s\S+)*?)\s+-\s+(.+?)\s*\((\d{6,10})\)/.exec(title ?? '');
  if (!m) return null;
  return {
    form: (m[1] ?? '').trim(),
    company: (m[2] ?? '').trim(),
    cik: (m[3] ?? '').trim(),
  };
}

/** Finds "Item 5.02" / "Items 2.02, 9.01" style references. */
export function extract8kItems(text: string): string[] {
  const found = new Set<string>();
  // Two things EDGAR actually does that the earlier pattern refused.
  //
  //   - It writes "Items:" with a colon. Requiring whitespace straight after
  //     the word meant the label never matched at all, so a real 8-K summary
  //     yielded no items.
  //   - It SPACE-separates the codes: "Items: 1.03 2.02". Accepting only
  //     comma/semicolon/"and" stopped at the first code.
  //
  // Both matter more than they look: items decide materiality, and §16 drops
  // any filing below CRITICAL/HIGH — so an unparsed item list silently
  // discarded every 8-K, bankruptcies included.
  for (const m of (text ?? '').matchAll(
    /items?\s*:?\s*(\d\.\d{2}(?:[\s,;]*(?:and\s+)?\d\.\d{2})*)/gi,
  )) {
    for (const item of (m[1] ?? '').split(/[,;\s]+|\band\b/i)) {
      const trimmed = item.trim();
      if (/^\d\.\d{2}$/.test(trimmed)) found.add(trimmed);
    }
  }
  return [...found].sort();
}
