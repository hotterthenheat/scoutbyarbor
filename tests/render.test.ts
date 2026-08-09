import { describe, it, expect } from 'vitest';
import { buildAlert, renderAlert, assertNoLeakedMetadata } from '../src/render/alert.js';
import { formatAlertTimestamp } from '../src/util/time.js';

/**
 * §3 and §33. The alert format is the product's signature; these tests pin it
 * exactly, including the things that must NOT appear.
 */

describe('the alert format', () => {
  it('renders the spec’s worked example verbatim', () => {
    const alert = buildAlert({
      banner: 'MACRO ALERT',
      headline: 'NO NUCLEAR IRAN',
      timestampIso: '2026-05-24T21:14:00.000Z', // 5:14 PM ET
      // Deliberately longer than BODY_MAX_CHARS so the ellipsis in the spec's
      // worked example is exercised rather than assumed.
      body:
        'Trump called the Obama-era Iran nuclear deal “one of the worst deals ever,” ' +
        'saying it gave Iran a path to nuclear weapons and enriched a hostile regime while ' +
        'delivering nothing durable in return, and he pledged that no future administration ' +
        'would revive it under any circumstances whatsoever, adding that the terms had been ' +
        'negotiated from a position of weakness and that any successor agreement would have ' +
        'to be fundamentally different in both scope and enforcement.',
    });

    const out = renderAlert(alert);
    const lines = out.split('\n');

    expect(lines[0]).toContain('MACRO ALERT');
    expect(lines[1]).toBe('');
    expect(lines[2]).toContain('NO NUCLEAR IRAN');
    expect(lines[3]).toBe('');
    expect(lines[4]).toContain('5:14 PM · May 24, 2026');
    expect(lines[5]).toBe('');
    expect(lines[6]).toContain('Trump called the Obama-era Iran nuclear deal');
    expect(out.trimEnd()).toMatch(/\.\.\.$/);
  });

  it('omits the body block entirely when there is no body', () => {
    const out = renderAlert(
      buildAlert({
        banner: 'FED ALERT',
        headline: 'FED HOLDS RATES STEADY',
        timestampIso: '2026-08-09T18:31:00.000Z',
        body: '',
      }),
    );
    expect(out.trimEnd().split('\n').filter((l) => l !== '')).toHaveLength(3);
  });

  it('uppercases the banner and headline', () => {
    const out = renderAlert(
      buildAlert({
        banner: 'equity alert',
        headline: 'nvidia announces new ai partnership',
        timestampIso: '2026-08-09T18:31:00.000Z',
        body: '',
      }),
    );
    expect(out).toContain('EQUITY ALERT');
    expect(out).toContain('NVIDIA ANNOUNCES NEW AI PARTNERSHIP');
  });
});

describe('the alert never leaks backend metadata (§3, §33)', () => {
  const forbidden = [
    'Source:', 'SOURCE:', 'AUTHOR:', 'Author:', '@DeItaone', 'twitter.com', 'x.com',
    'https://', 'Likes', 'Retweets', 'CONFIDENCE:', 'SENTIMENT:', 'AI SUMMARY:',
    'MARKET IMPACT:',
  ];

  it('renders none of the forbidden fields', () => {
    const out = renderAlert(
      buildAlert({
        banner: 'GEOPOLITICAL ALERT',
        headline: 'US AND IRAN REACH AGREEMENT',
        timestampIso: '2026-05-24T21:14:00.000Z',
        body: 'Officials from both sides confirmed the outline of an agreement.',
      }),
    );
    for (const f of forbidden) expect(out).not.toContain(f);
  });

  it('assertNoLeakedMetadata throws when a handle would appear', () => {
    expect(() =>
      assertNoLeakedMetadata('MACRO ALERT\n\nvia @DeItaone', ['@DeItaone']),
    ).toThrow();
  });

  it('assertNoLeakedMetadata passes a clean alert', () => {
    expect(() =>
      assertNoLeakedMetadata('MACRO ALERT\n\nNO NUCLEAR IRAN', ['@DeItaone', 'https://x.com/i/1']),
    ).not.toThrow();
  });

  it('carries no emoji', () => {
    const out = renderAlert(
      buildAlert({
        banner: 'MARKET ALERT',
        headline: 'S&P 500 HALTED AFTER 7% DECLINE',
        timestampIso: '2026-08-09T18:31:00.000Z',
        body: 'Trading was paused market-wide.',
      }),
    );
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('timestamp formatting (§3, §10)', () => {
  it('matches the spec’s two worked examples', () => {
    // 5:14 PM ET on May 24, 2026 — May is never abbreviated.
    expect(formatAlertTimestamp('2026-05-24T21:14:00.000Z')).toBe('5:14 PM · May 24, 2026');
    // 2:31 PM ET on Aug 9, 2026 — August is abbreviated with a period.
    expect(formatAlertTimestamp('2026-08-09T18:31:00.000Z')).toBe('2:31 PM · Aug. 9, 2026');
  });

  it('follows AP style on month abbreviation', () => {
    const month = (iso: string) => formatAlertTimestamp(iso).split('· ')[1]?.split(' ')[0];
    expect(month('2026-03-10T15:00:00.000Z')).toBe('March');
    expect(month('2026-06-10T15:00:00.000Z')).toBe('June');
    expect(month('2026-07-10T15:00:00.000Z')).toBe('July');
    expect(month('2026-09-10T15:00:00.000Z')).toBe('Sept.');
    expect(month('2026-01-10T15:00:00.000Z')).toBe('Jan.');
  });

  it('does not zero-pad the hour or the day', () => {
    expect(formatAlertTimestamp('2026-08-09T13:05:00.000Z')).toBe('9:05 AM · Aug. 9, 2026');
  });

  it('renders in Eastern time by default', () => {
    // 00:30 UTC on Aug 10 is 8:30 PM ET on Aug 9.
    expect(formatAlertTimestamp('2026-08-10T00:30:00.000Z')).toBe('8:30 PM · Aug. 9, 2026');
  });
});

describe('the metadata guard does not block legitimate alerts', () => {
  // A wire service or filer naming itself inside a real headline is content,
  // not a leak. Blocking these would throw the story away rather than publish
  // it — the worst possible failure mode for a newswire.
  it('publishes an EDGAR headline containing the filer name', () => {
    const content = renderAlert(
      buildAlert({
        banner: 'EQUITY ALERT',
        headline: '8-K - NVIDIA CORP (0001045810) (FILER)',
        timestampIso: '2026-08-09T18:31:00.000Z',
        body: 'Item 2.02 Results of Operations and Financial Condition.',
      }),
    );
    expect(() => assertNoLeakedMetadata(content, ['NVIDIA CORP', 'SEC EDGAR'])).not.toThrow();
  });

  it('publishes a headline carrying a Reuters dateline', () => {
    const content = renderAlert(
      buildAlert({
        banner: 'MACRO ALERT',
        headline: 'FED HOLDS RATES STEADY',
        timestampIso: '2026-08-09T18:31:00.000Z',
        body: 'WASHINGTON (Reuters) - The Federal Reserve left rates unchanged.',
      }),
    );
    expect(() => assertNoLeakedMetadata(content, ['Reuters', 'Reuters Business'])).not.toThrow();
  });

  it('still blocks the handle and the URL', () => {
    expect(() =>
      assertNoLeakedMetadata('MACRO ALERT\n\nsomething via @DeItaone', ['@DeItaone']),
    ).toThrow();
    expect(() =>
      assertNoLeakedMetadata('MACRO ALERT\n\nhttps://x.com/i/status/1', ['https://x.com/i/status/1']),
    ).toThrow();
  });
});

describe('no score ever reaches a user-facing alert', () => {
  it.each([
    'MACRO ALERT\n\nFED CUTS RATES\n\n5:14 PM · May 24, 2026\n\nScore: 92',
    'MACRO ALERT\n\nFED CUTS RATES\n\nConfidence: 0.94',
    'MACRO ALERT\n\nFED CUTS RATES\n\nIMPORTANCE: 92',
    'MACRO ALERT\n\nFED CUTS RATES\n\nSENTIMENT: bullish',
    'MACRO ALERT\n\nFED CUTS RATES\n\nMARKET IMPACT: broad',
    'MACRO ALERT\n\nFED CUTS RATES\n\nAI SUMMARY: the Fed cut rates',
    'MACRO ALERT\n\nFED CUTS RATES\n\nSOURCE: @DeItaone',
    'MACRO ALERT\n\nFED CUTS RATES\n\n92/100',
    'MACRO ALERT\n\nFED CUTS RATES\n\nCRITICAL',
  ])('rejects %s', (content) => {
    expect(() => assertNoLeakedMetadata(content, [])).toThrow();
  });

  it('still allows a percentage that is part of the news', () => {
    const content = renderAlert(
      buildAlert({
        banner: 'ECONOMIC ALERT',
        headline: 'US CPI RISES 0.3% M/M VS 0.2% EXPECTED',
        timestampIso: '2026-08-09T12:30:00.000Z',
        body: 'Core CPI rose 0.2% on the month and 3.1% on the year.',
      }),
    );
    expect(() => assertNoLeakedMetadata(content, [])).not.toThrow();
  });

  it('renders no score for a real alert built from a scored event', () => {
    const content = renderAlert(
      buildAlert({
        banner: 'FED ALERT',
        headline: 'FED CUTS RATES BY 50 BPS IN EMERGENCY MEETING',
        timestampIso: '2026-08-09T18:31:00.000Z',
        body: 'The Committee cited deteriorating labour market conditions.',
      }),
    );
    expect(content).not.toMatch(/\b(?:9[0-9]|100)\b\s*(?:CRITICAL|HIGH)/);
    expect(content.toLowerCase()).not.toContain('score');
    expect(content.toLowerCase()).not.toContain('confidence');
  });
});
