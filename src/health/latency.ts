import type { LatencyRecord } from '../core/types.js';
import { msBetween } from '../util/time.js';

/**
 * LATENCY (§22).
 *
 * Four stamps, tracked separately, because "Scout was slow" and "the source was
 * slow" are different problems with different fixes.
 */

export interface ComputeLatencyInput {
  eventTime: string;
  /**
   * What the source actually said, or null when it said nothing.
   *
   * This is NOT interchangeable with eventTime. eventTime falls back to the
   * receipt time so the pipeline always has something to order by, which means
   * measuring source→Scout against it produces exactly 0ms whenever the
   * publication time is unknown — a reading indistinguishable from an
   * instantaneous relay. Half the point of this metric is deciding whether the
   * relay is fast enough to trade on, and a fabricated zero is worse than no
   * number at all, because it looks like an answer.
   */
  publishedAt?: string | null;
  ingestionTime: string;
  processingTime?: string | null;
  discordTime?: string | null;
}

export function computeLatency(input: ComputeLatencyInput): LatencyRecord {
  const clamped: string[] = [];

  /** A source clock running ahead would otherwise produce negative latency. */
  const nonNegative = (value: number, label: string): number => {
    if (value < 0) {
      clamped.push(label);
      return 0;
    }
    return value;
  };

  // `undefined` means the caller did not say — fall back to the old behaviour
  // so callers that never had a publication time to give are unaffected.
  // Explicit `null` means the source genuinely had none, and that is
  // unmeasurable rather than instant.
  const knownPublishedAt =
    input.publishedAt === undefined ? input.eventTime : input.publishedAt;

  const sourceToScoutMs =
    knownPublishedAt === null
      ? null
      : nonNegative(msBetween(knownPublishedAt, input.ingestionTime), 'sourceToScout');

  const scoutToDiscordMs = input.discordTime
    ? nonNegative(
        msBetween(input.processingTime ?? input.ingestionTime, input.discordTime),
        'scoutToDiscord',
      )
    : null;

  // End to end means publication → Discord. Without a publication time there is
  // no "end to end" to report; scoutToDiscordMs above still covers the part
  // Scout is actually responsible for.
  const totalMs =
    input.discordTime && knownPublishedAt !== null
      ? nonNegative(msBetween(knownPublishedAt, input.discordTime), 'total')
      : null;

  return {
    eventTime: input.eventTime,
    ingestionTime: input.ingestionTime,
    processingTime: input.processingTime ?? null,
    discordTime: input.discordTime ?? null,
    sourceToScoutMs,
    scoutToDiscordMs,
    totalMs,
  };
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export interface LatencySummary {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarizeLatency(samples: number[]): LatencySummary {
  const values = samples.filter((v) => Number.isFinite(v));
  if (values.length === 0) {
    return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    count: values.length,
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
  };
}

/** The dashboard block from §22. */
export function formatLatencyReport(s: LatencySummary): string {
  return [
    '```',
    `SAMPLES       ${s.count}`,
    '',
    `AVG LATENCY   ${Math.round(s.avg)} ms`,
    `P95 LATENCY   ${Math.round(s.p95)} ms`,
    `P99 LATENCY   ${Math.round(s.p99)} ms`,
    `MAX LATENCY   ${Math.round(s.max)} ms`,
    '```',
  ].join('\n');
}
