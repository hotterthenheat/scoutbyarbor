import type {
  EarningsData,
  ExtractedFigure,
  FinancialFigure,
  TickerMatch,
} from '../../core/types.js';

/**
 * EARNINGS ENGINE (§15).
 *
 * The spec is blunt about the failure mode: don't post "Apple reports
 * earnings" when the actual numbers are sitting in the text. So this parses the
 * wire formats as they really appear —
 *
 *   APPLE Q3 EPS $2.40 VS $2.35 EST
 *   REVENUE $18.12 BLN VS EST $17.80 BLN
 *   adjusted EPS 1.42 (est 1.35)
 *   Q3 EPS $(0.15) vs $(0.10) est
 *   sees Q4 revenue $32B-$34B vs $31.5B est
 *
 * and only calls a beat or a miss when BOTH the actual and the consensus were
 * found. Guessing a surprise is worse than omitting it.
 */

const SCALE_WORDS: Record<string, FinancialFigure['scale']> = {
  k: 'THOUSAND',
  thousand: 'THOUSAND',
  m: 'MILLION',
  mm: 'MILLION',
  mn: 'MILLION',
  mln: 'MILLION',
  million: 'MILLION',
  b: 'BILLION',
  bn: 'BILLION',
  bln: 'BILLION',
  billion: 'BILLION',
};

const SCALE_PATTERN = 'k|thousand|mm|mn|mln|million|m|bn|bln|billion|b';
const NUMBER = String.raw`\$?\s*\(?\s*-?\$?\s*\d+(?:[.,]\d+)*\s*\)?`;

const EARNINGS_MARKERS =
  /(?<![A-Za-z0-9])(?:eps|earnings per share|revenue|revenues|quarterly results|reports? (?:q[1-4]|first|second|third|fourth|full[ -]year)|q[1-4] (?:results|earnings|revenue|eps)|adjusted eps|consensus|vs\.? est|estimates?)(?![A-Za-z0-9])/i;

export function isEarningsPost(text: string): boolean {
  if (!text) return false;
  if (!EARNINGS_MARKERS.test(text)) return false;
  // "will report earnings next week" is a calendar note, not a result.
  if (/(?<![A-Za-z0-9])(?:will report|is expected to report|due to report|scheduled to report|reports? (?:tomorrow|next week|after the close|on \w+day))(?![A-Za-z0-9])/i.test(text)) {
    return false;
  }
  return true;
}

export function extractEarnings(input: {
  text: string;
  tickers: TickerMatch[];
  figures: ExtractedFigure[];
}): EarningsData | null {
  const { text } = input;
  if (!text) return null;

  const eps = findMetric(text, ['adjusted eps', 'adj eps', 'eps', 'earnings per share']);
  const revenue = findMetric(text, ['revenue', 'revenues', 'net sales', 'sales']);

  const data: EarningsData = {
    ticker: input.tickers[0]?.ticker ?? null,
    company: null,
    period: findPeriod(text),
    eps: eps.actual,
    epsConsensus: eps.consensus,
    revenue: revenue.actual,
    revenueConsensus: revenue.consensus,
    guidance: findGuidance(text),
    grossMargin: findPercentMetric(text, ['gross margin']),
    operatingMargin: findPercentMetric(text, ['operating margin', 'op margin']),
    capex: findMetric(text, ['capex', 'capital expenditure', 'capital expenditures']).actual,
    buybacks: findMetric(text, ['buyback', 'buybacks', 'share repurchase', 'repurchase']).actual,
    dividend: findMetric(text, ['dividend']).actual,
    bookings: findMetric(text, ['bookings']).actual,
    backlog: findMetric(text, ['backlog']).actual,
    freeCashFlow: findMetric(text, ['free cash flow', 'fcf']).actual,
    epsSurprise: null,
    revenueSurprise: null,
  };

  data.epsSurprise = surpriseOf(data.eps, data.epsConsensus);
  data.revenueSurprise = surpriseOf(data.revenue, data.revenueConsensus);

  const hasAnything =
    data.eps ||
    data.revenue ||
    data.guidance ||
    data.grossMargin ||
    data.operatingMargin ||
    data.capex ||
    data.buybacks ||
    data.dividend ||
    data.bookings ||
    data.backlog ||
    data.freeCashFlow;

  return hasAnything ? data : null;
}

/**
 * Wire headline from what was actually parsed. Falls back rather than inventing
 * detail that is not in the source.
 */
export function buildEarningsHeadline(data: EarningsData, fallback: string): string {
  if (!data) return fallback;
  const subject = (data.company ?? data.ticker ?? '').toUpperCase().trim();
  const period = data.period ? `${data.period.toUpperCase()} ` : '';

  const say = (metric: string, surprise: 'BEAT' | 'MISS' | 'INLINE'): string => {
    const verb =
      surprise === 'BEAT' ? 'ABOVE EXPECTATIONS' : surprise === 'MISS' ? 'MISSES ESTIMATES' : 'IN LINE WITH ESTIMATES';
    const lead = subject ? `${subject} ` : '';
    return `${lead}${period}${metric} ${verb}`.replace(/\s+/g, ' ').trim();
  };

  if (data.epsSurprise) return say('EPS', data.epsSurprise);
  if (data.revenueSurprise) return say('REVENUE', data.revenueSurprise);

  if (data.eps && subject) {
    return `${subject} ${period}REPORTS EPS ${formatFigure(data.eps)}`.replace(/\s+/g, ' ').trim();
  }
  if (data.revenue && subject) {
    return `${subject} ${period}REPORTS REVENUE ${formatFigure(data.revenue)}`.replace(/\s+/g, ' ').trim();
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────

interface MetricPair {
  actual: FinancialFigure | null;
  consensus: FinancialFigure | null;
}

/**
 * Finds "<label> <number> [vs|versus|(est] <number>". The consensus side is
 * only claimed when an estimate marker is genuinely present.
 */
function findMetric(text: string, labels: string[]): MetricPair {
  for (const label of labels) {
    const labelRe = escapeRegExp(label);

    // actual + consensus in one go
    const paired = new RegExp(
      String.raw`(?<![A-Za-z0-9])${labelRe}[^\n]{0,20}?(${NUMBER})\s*(${SCALE_PATTERN})?\.?\s*` +
        String.raw`(?:vs\.?|versus|compared (?:to|with)|\(\s*est\.?|est\.?\s*|consensus\s*(?:of|was)?)\s*` +
        String.raw`(?:est\.?|estimates?|consensus)?\s*(${NUMBER})\s*(${SCALE_PATTERN})?`,
      'i',
    ).exec(text);

    if (paired) {
      return {
        actual: toFigure(paired[1] ?? '', paired[2], label),
        consensus: toFigure(paired[3] ?? '', paired[4], label),
      };
    }

    // actual only
    const solo = new RegExp(
      String.raw`(?<![A-Za-z0-9])${labelRe}\s*(?:of|was|at|:)?\s*(${NUMBER})\s*(${SCALE_PATTERN})?`,
      'i',
    ).exec(text);
    if (solo) {
      return { actual: toFigure(solo[1] ?? '', solo[2], label), consensus: null };
    }
  }
  return { actual: null, consensus: null };
}

function findPercentMetric(text: string, labels: string[]): FinancialFigure | null {
  for (const label of labels) {
    const m = new RegExp(
      String.raw`(?<![A-Za-z0-9])${escapeRegExp(label)}\s*(?:of|was|at|:)?\s*(-?\d+(?:\.\d+)?)\s*%`,
      'i',
    ).exec(text);
    if (m) {
      return { value: Number(m[1]), unit: 'PERCENT', scale: 'UNIT', raw: m[0] };
    }
  }
  return null;
}

function findPeriod(text: string): string | null {
  const q = /(?<![A-Za-z0-9])(Q[1-4])\s*(?:FY)?\s*((?:20)?\d{2})?/i.exec(text);
  if (q) return q[2] ? `${(q[1] ?? '').toUpperCase()} ${normalizeYear(q[2])}` : (q[1] ?? '').toUpperCase();
  const fy = /(?<![A-Za-z0-9])(?:FY|fiscal(?:\s+year)?)\s*((?:20)?\d{2})/i.exec(text);
  if (fy?.[1]) return `FY ${normalizeYear(fy[1])}`;
  return null;
}

function findGuidance(text: string): string | null {
  const m =
    /(?<![A-Za-z0-9])(?:sees|guides?|guidance|forecasts?|expects?|raises? (?:its )?(?:full[- ]year |fy )?(?:guidance|outlook)|cuts? (?:its )?(?:guidance|outlook)|lowers? (?:its )?(?:guidance|outlook)|reaffirms? (?:its )?(?:guidance|outlook))[^.;\n]{0,120}/i.exec(
      text,
    );
  return m ? m[0].trim() : null;
}

function toFigure(raw: string, scaleWord: string | undefined, label: string): FinancialFigure | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  // A loss is written either as -0.15 or as (0.15), sometimes as $(0.15).
  const negative = cleaned.includes('(') || cleaned.includes('-');
  const numeric = cleaned.replace(/[()$,\s-]/g, '');
  if (!numeric) return null;

  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;

  const scale = scaleWord ? (SCALE_WORDS[scaleWord.toLowerCase()] ?? 'UNIT') : 'UNIT';
  return {
    value: negative ? -value : value,
    unit: /margin/i.test(label) ? 'PERCENT' : 'USD',
    scale,
    raw: cleaned,
  };
}

/** Only meaningful when both sides were found; INLINE within half a percent. */
function surpriseOf(
  actual: FinancialFigure | null,
  consensus: FinancialFigure | null,
): 'BEAT' | 'MISS' | 'INLINE' | null {
  if (!actual || !consensus) return null;

  const a = absolute(actual);
  const c = absolute(consensus);
  if (!Number.isFinite(a) || !Number.isFinite(c) || c === 0) {
    if (a === c) return 'INLINE';
    return a > c ? 'BEAT' : 'MISS';
  }

  const delta = (a - c) / Math.abs(c);
  if (Math.abs(delta) <= 0.005) return 'INLINE';
  return delta > 0 ? 'BEAT' : 'MISS';
}

function absolute(f: FinancialFigure): number {
  const factor =
    f.scale === 'BILLION' ? 1e9 : f.scale === 'MILLION' ? 1e6 : f.scale === 'THOUSAND' ? 1e3 : 1;
  return f.value * factor;
}

function formatFigure(f: FinancialFigure): string {
  const suffix =
    f.scale === 'BILLION' ? 'B' : f.scale === 'MILLION' ? 'M' : f.scale === 'THOUSAND' ? 'K' : '';
  const prefix = f.unit === 'USD' ? '$' : '';
  return `${prefix}${f.value}${suffix}${f.unit === 'PERCENT' ? '%' : ''}`;
}

function normalizeYear(y: string): string {
  return y.length === 2 ? `20${y}` : y;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
