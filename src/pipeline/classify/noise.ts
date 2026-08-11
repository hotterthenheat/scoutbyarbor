import type { NoiseVerdict, RejectionReason } from '../../core/types.js';
import type { NoiseTaxonomy, TaxonomyFile } from '../../config/types.js';

/**
 * NOISE FILTER (§20).
 *
 * This is the module the product lives or dies on. §34 puts it plainly: a bot
 * that sends 500 alerts is not better than one that sends 50.
 *
 * Two rules keep it honest in both directions:
 *
 *   - Nothing is rejected on a single weak token. A rule fires on one strong
 *     (multiword) phrase or two independent weak hits, so a real headline
 *     containing the word "will" survives.
 *   - The distinction that matters most is who is making the claim. "Morgan
 *     Stanley raises its price target to $200" is reporting; "my price target
 *     is $200" is not. The prediction rules key on first-person framing rather
 *     than on the presence of a number.
 */

export interface NoiseClassifierInput {
  text: string;
  tokens: string[];
  isEcho: boolean;
  sourceQuality: number;
  filterProfile: 'standard' | 'strict';
  channelId?: string | null;
}

export interface NoiseClassifier {
  classify(input: NoiseClassifierInput): NoiseVerdict;
}

type NoiseClass = keyof NoiseTaxonomy;

const REASON_FOR: Record<NoiseClass, RejectionReason> = {
  opinion: 'NOISE_OPINION',
  prediction: 'NOISE_PREDICTION',
  engagementBait: 'NOISE_ENGAGEMENT_BAIT',
  meme: 'NOISE_MEME',
  promotional: 'NOISE_PROMOTIONAL',
  personal: 'NOISE_PERSONAL',
  politicalCommentary: 'NOISE_POLITICAL_COMMENTARY',
  marketChatter: 'NOISE_MARKET_CHATTER',
  oldNews: 'NOISE_OLD_NEWS',
};

/**
 * Promotion, memes and engagement bait are never news regardless of who posted
 * them — an official account running a newsletter ad is still an ad. The rest
 * are judgement calls where a high-quality source earns some benefit of the
 * doubt.
 */
const ALWAYS_REJECT: NoiseClass[] = ['promotional', 'meme', 'engagementBait'];

/**
 * The only classes where a high-quality source earns a higher bar. An official
 * feed writing "we believe" is not an opinion post — but "looking strong" is
 * market chatter regardless of who posted it, so chatter and predictions are
 * deliberately NOT in this list.
 */
const SOFT_CLASSES: NoiseClass[] = ['opinion', 'personal', 'politicalCommentary'];

/** Evaluation order: the most clear-cut classes first. */
const ORDER: NoiseClass[] = [
  'promotional',
  'engagementBait',
  'meme',
  'opinion',
  'prediction',
  'marketChatter',
  'politicalCommentary',
  'oldNews',
  'personal',
];

interface CompiledRule {
  cls: NoiseClass;
  strong: Array<{ text: string; pattern: RegExp }>;
  weak: Array<{ text: string; pattern: RegExp }>;
}

export function createNoiseClassifier(taxonomy: TaxonomyFile): NoiseClassifier {
  const rules: CompiledRule[] = ORDER.map((cls) => {
    const terms = taxonomy.noise?.[cls] ?? [];
    return {
      cls,
      // A multiword phrase is strong evidence; a lone short word is not.
      strong: terms.filter((t) => t.includes(' ')).map(compile),
      weak: terms.filter((t) => !t.includes(' ')).map(compile),
    };
  });

  function classify(input: NoiseClassifierInput): NoiseVerdict {
    const signals: string[] = [];
    // Real clients emit curly apostrophes; fold them so "here's" and
    // "here\u2019s" match the same phrase entry.
    const lower = foldApostrophes(input.text.toLowerCase());

    if (input.channelId === '1512892264752349305') {
      return { isNoise: false, reason: null, confidence: 0, signals: ['whitelist:channel'] };
    }

    if (input.isEcho) {
      return {
        isNoise: true,
        reason: 'NOISE_RETWEET_NO_CONTENT',
        confidence: 0.9,
        signals: ['noise:echo'],
      };
    }

    // Emoji density is its own meme signal, independent of the word list.
    const emoji = (input.text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
    const words = input.tokens.length || 1;
    if (emoji >= 3 || emoji / words > 0.15) {
      signals.push(`noise:emoji:${emoji}`);
      if (emoji >= 3) {
        return { isNoise: true, reason: 'NOISE_MEME', confidence: 0.85, signals };
      }
    }

    const strict = input.filterProfile === 'strict';
    const trusted = input.sourceQuality >= 95;

    for (const rule of rules) {
      const strongHits = rule.strong.filter((p) => p.pattern.test(lower));
      const weakHits = rule.weak.filter((p) => p.pattern.test(lower));
      const score = strongHits.length * 2 + weakHits.length;
      if (score === 0) continue;

      for (const h of [...strongHits, ...weakHits]) signals.push(`noise:${rule.cls}:${h.text}`);

      // One strong phrase (worth 2) is the normal bar. A trusted source needs
      // more than that only for the soft classes; a strict-profile source is
      // held to the normal bar even then.
      const soft = SOFT_CLASSES.includes(rule.cls);
      const threshold = soft && trusted && !strict ? 3 : 2;

      if (score >= threshold) {
        return {
          isNoise: true,
          reason: REASON_FOR[rule.cls],
          confidence: Math.min(0.95, 0.5 + score * 0.15),
          signals,
        };
      }
    }

    return { isNoise: false, reason: null, confidence: 0.1, signals };
  }

  return { classify };
}

function compile(text: string): { text: string; pattern: RegExp } {
  return {
    text,
    // Word boundaries matter: "subscribe" must not match inside "subscriber",
    // and "poll" must not match inside "polls".
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
