import { describe, it, expect } from 'vitest';
import { dueReminders, renderReminder, LEAD_TIMES, loadCalendar } from '../src/calendar/scheduler.js';
import type { CalendarEvent } from '../src/calendar/scheduler.js';

/** Scheduled calendar reminders and their lead times. */

const CPI: CalendarEvent = {
  id: 'cpi-test',
  name: 'CPI',
  // 8:30 AM ET on 12 Aug 2026.
  scheduledAt: '2026-08-12T08:30:00-04:00',
  expectedImpact: 'CRITICAL',
  note: null,
};

const at = (iso: string): string => new Date(iso).toISOString();

describe('lead times', () => {
  it('fires a day, an hour and fifteen minutes ahead', () => {
    expect(LEAD_TIMES.map((l) => l.minutes)).toEqual([24 * 60, 60, 15]);
  });

  it('produces the spec’s wording at each lead time', () => {
    const cases: Array<[string, string]> = [
      ['2026-08-11T12:30:00Z', 'CPI TOMORROW'], // 24h before
      ['2026-08-12T11:30:00Z', 'CPI IN 1 HOUR'],
      ['2026-08-12T12:15:00Z', 'CPI IN 15 MINUTES'],
    ];
    for (const [now, expected] of cases) {
      const due = dueReminders([CPI], new Set(), 'America/New_York', at(now));
      expect(due[0]?.headline, `at ${now}`).toBe(expected);
    }
  });

  it('stays quiet between lead times', () => {
    const due = dueReminders([CPI], new Set(), 'America/New_York', at('2026-08-12T06:00:00Z'));
    expect(due).toHaveLength(0);
  });

  it('does not fire for an event that has already happened', () => {
    const due = dueReminders([CPI], new Set(), 'America/New_York', at('2026-08-12T14:00:00Z'));
    expect(due).toHaveLength(0);
  });

  it('does not refire a reminder already sent', () => {
    const now = at('2026-08-12T11:30:00Z');
    const first = dueReminders([CPI], new Set(), 'America/New_York', now);
    expect(first).toHaveLength(1);

    const fired = new Set([`${CPI.id}:60`]);
    expect(dueReminders([CPI], fired, 'America/New_York', now)).toHaveLength(0);
  });
});

describe('rendering', () => {
  it('matches the specified format', () => {
    const due = dueReminders([CPI], new Set(), 'America/New_York', at('2026-08-11T12:30:00Z'));
    const rendered = renderReminder(due[0]!);
    const lines = rendered.split('\n').filter((l) => l.trim());

    expect(lines[0]).toContain('SCOUT REMINDER');
    expect(lines[1]).toContain('CPI TOMORROW');
    expect(lines[2]).toBe('8:30 AM ET');
    expect(lines[3]).toBe('EXPECTED IMPACT: CRITICAL');
  });

  it('carries no emoji or source metadata', () => {
    const due = dueReminders([CPI], new Set(), 'America/New_York', at('2026-08-12T12:15:00Z'));
    const rendered = renderReminder(due[0]!);
    expect(rendered).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(rendered).not.toMatch(/https?:\/\//);
  });
});

describe('the shipped calendar file', () => {
  it('parses and every entry carries an explicit UTC offset', () => {
    const { events, timeZone } = loadCalendar();
    expect(timeZone).toBe('America/New_York');
    for (const event of events) {
      // A bare local time is an hour wrong across a DST boundary.
      expect(event.scheduledAt, event.id).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
      expect(Number.isNaN(Date.parse(event.scheduledAt)), event.id).toBe(false);
    }
  });

  /**
   * A reminder goes to #scout-news, #trading-floor AND #spx-trading. A guessed
   * date does not produce a harmless note in a side channel — it announces
   * "CPI TOMORROW" to the trading channels for a release that is not happening.
   * So the repository ships no dates at all; they are populated per deployment
   * from the published BLS and Fed schedules.
   */
  it('ships empty, so no invented date can reach a trading channel', () => {
    expect(loadCalendar().events).toEqual([]);
  });

  it('an empty calendar is valid, not an error', () => {
    const { events } = loadCalendar();
    // No entries means no reminders due, at any time, rather than a throw.
    expect(dueReminders(events, at('2026-08-11T12:30:00Z'))).toEqual([]);
  });
});
