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

  const sourceToScoutMs = nonNegative(
    msBetween(input.eventTime, input.ingestionTime),
    'sourceToScout',
  );

  const scoutToDiscordMs = input.discordTime
    ? nonNegative(
        msBetween(input.processingTime ?? input.ingestionTime, input.discordTime),
        'scoutToDiscord',
      )
    : null;

  const totalMs = input.discordTime
    ? nonNegative(msBetween(input.eventTime, input.discordTime), 'total')
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
