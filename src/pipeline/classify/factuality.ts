import type { FactualityVerdict } from '../../core/types.js';
import type { TaxonomyFile } from '../../config/types.js';

/**
 * FACTUAL NEWS vs COMMENTARY (§8).
 *
 * ZeroHedge and the Kobeissi Letter are fast on real headlines and heavy on
 * framing. Rather than banning them or trusting them, Scout asks a narrower
 * question of every post from a `strict` source: is there an actor, an action
 * and an attribution — or is this someone telling you what to think?
 *
 * An official feed short-circuits to FACTUAL_NEWS: a Fed press release is a
 * fact by construction.
 */

export interface FactualityInput {
  text: string;
  tokens: string[];
  hasFigures: boolean;
  isOfficial: boolean;
}

export interface FactualityClassifier {
  classify(input: FactualityInput): FactualityVerdict;
}

export function createFactualityClassifier(taxonomy: TaxonomyFile): FactualityClassifier {
  const factualMarkers = (taxonomy.factuality?.factualMarkers ?? []).map(compile);
  const commentaryMarkers = (taxonomy.factuality?.commentaryMarkers ?? []).map(compile);
  const attributionVerbs = new Set(
    (taxonomy.factuality?.attributionVerbs ?? []).map((v) => v.toLowerCase()),
  );

  function classify(input: FactualityInput): FactualityVerdict {
    const signals: string[] = [];
    // Real clients emit curly apostrophes; fold them so "here's" and
    // "here\u2019s" match the same phrase entry.
    const lower = foldApostrophes(input.text.toLowerCase());

    if (input.isOfficial) {
      return {
        verdict: 'FACTUAL_NEWS',
        confidence: 0.95,
        signals: ['factuality:official-source'],
      };
    }

    let factual = 0;
    let commentary = 0;

    for (const token of input.tokens) {
      if (attributionVerbs.has(token)) {
        factual += 1;
        signals.push(`factuality:verb:${token}`);
        break; // one attribution verb is the signal; more is not stronger
      }
    }

    for (const m of factualMarkers) {
      if (m.pattern.test(lower)) {
        factual += 2;
        signals.push(`factuality:marker:${m.text}`);
      }
    }

    // A wire-service attribution prefix ("AXIOS:", "REUTERS:") is reporting.
    if (/^\s*[A-Z][A-Z0-9.\s]{1,24}:\s/.test(input.text)) {
      factual += 2;
      signals.push('factuality:wire-prefix');
    }

    // Quoted speech is somebody on the record.
    if (/["“][^"”]{10,}["”]/.test(input.text)) {
      factual += 1.5;
      signals.push('factuality:quoted-speech');
    }

    if (input.hasFigures) {
      factual += 1.5;
      signals.push('factuality:figures');
    }

    for (const m of commentaryMarkers) {
      if (m.pattern.test(lower)) {
        commentary += 2;
        signals.push(`factuality:commentary:${m.text}`);
      }
    }

    // A rhetorical question is not a report.
    if (/\?\s*$/.test(input.text.trim()) || /^\s*(?:why|how|imagine|remember)\b/i.test(input.text)) {
      commentary += 1.5;
      signals.push('factuality:rhetorical');
    }

    // Addressing the reader directly.
    if (/(?<![A-Za-z])(?:you|your|you're|yours)(?![A-Za-z])/i.test(input.text)) {
      commentary += 1;
      signals.push('factuality:second-person');
    }

    const verdict = factual >= commentary ? 'FACTUAL_NEWS' : 'COMMENTARY';
    const total = factual + commentary;
    const margin = total === 0 ? 0 : Math.abs(factual - commentary) / total;

    return {
      verdict,
      // With no evidence either way, sit at 0.5 rather than claiming certainty.
      confidence: total === 0 ? 0.5 : Math.min(0.95, 0.55 + margin * 0.4),
      signals,
    };
  }

  return { classify };
}

function compile(text: string): { text: string; pattern: RegExp } {
  return {
    text,
    pattern: new RegExp(
      `(?<![A-Za-z0-9])${escapeRegExp(foldApostrophes(text.toLowerCase()))}(?![A-Za-z0-9])`,
      'i',
    ),
  };
}

function foldApostrophes(s: string): string {
  return s.replace(/[\u2018\u2019\u02BC`\u00B4]/g, "'");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
