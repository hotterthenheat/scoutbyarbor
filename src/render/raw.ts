import type { RawChannelPayload } from '../core/types.js';
import { truncate } from '../util/text.js';

/**
 * THE RAW CHANNEL (§27).
 *
 * The admin surface, and the only place the hidden fields appear. When someone
 * asks "why did that alert fire" or "why didn't it", the answer has to be here
 * — so the decision trail is never what gets truncated.
 */

const DISCORD_LIMIT = 1900; // leave headroom for the code fence

export function renderRawEntry(payload: RawChannelPayload): string {
  const lines: string[] = [];

  const verdict =
    payload.decision === 'ACCEPTED'
      ? 'ACCEPTED'
      : `${payload.decision}${payload.rejectionReason ? ` — ${payload.rejectionReason}` : ''}`;

  lines.push(`${verdict}`);
  lines.push(`source      ${payload.sourceName}${payload.handle ? ` (${payload.handle})` : ''}`);
  lines.push(`provenance  ${payload.provenance}`);
  lines.push(`category    ${payload.category ?? '—'}${payload.subcategory ? ` / ${payload.subcategory}` : ''}`);
  lines.push(`event       ${payload.eventTime}`);
  lines.push(`ingested    ${payload.ingestionTime}${payload.latencyMs === null ? '' : `  (+${payload.latencyMs}ms)`}`);
  if (payload.eventId) lines.push(`cluster     ${payload.eventId}`);
  if (payload.originalUrl) lines.push(`url         ${payload.originalUrl}`);

  if (payload.tickers.length) {
    lines.push(
      `tickers     ${payload.tickers
        .map((t) => `${t.ticker}[${t.evidence} ${t.confidence.toFixed(2)}]`)
        .join(' ')}`,
    );
  }

  if (payload.score) {
    const s = payload.score;
    lines.push(`score       ${Math.round(s.total)} ${s.band}`);
    lines.push(
      `  quality ${pad(s.sourceQuality)}  relevance ${pad(s.marketRelevance)}  novelty ${pad(s.novelty)}`,
    );
    lines.push(
      `  magnitude ${pad(s.magnitude)}  exposure ${pad(s.assetExposure)}  credibility ${pad(s.credibility)}`,
    );
    for (const note of s.notes.slice(0, 8)) lines.push(`  · ${note}`);
  }

  if (payload.signals.length) {
    lines.push('signals');
    for (const signal of payload.signals.slice(0, 14)) lines.push(`  · ${signal}`);
    if (payload.signals.length > 14) lines.push(`  · …and ${payload.signals.length - 14} more`);
  }

  // The decision trail above is the point of this channel, so the raw text is
  // what gets cut when we run out of room — never the reasoning.
  const decisionBlock = lines.join('\n');
  const budget = DISCORD_LIMIT - decisionBlock.length - 20;
  if (budget > 40) {
    lines.push('text');
    lines.push(`  ${truncate(payload.rawText.replace(/\n+/g, ' '), budget)}`);
  }

  return '```\n' + lines.join('\n').slice(0, DISCORD_LIMIT) + '\n```';
}

function pad(n: number): string {
  return String(Math.round(n)).padStart(3);
}
