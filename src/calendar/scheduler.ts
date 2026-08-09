import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CONFIG_DIR } from '../config/loader.js';
import type { Logger } from '../util/logger.js';
import { formatAlertTimestamp, isoNow, minutesBetween } from '../util/time.js';

/**
 * Scheduled calendar events.
 *
 * A desk wants to know CPI is coming before it lands, so Scout fires reminders
 * at set intervals ahead of a scheduled release and then the release itself is
 * picked up by the normal pipeline. Reminders go to the trading channels, since
 * that is where they are useful.
 *
 *   SCOUT REMINDER
 *
 *   CPI TOMORROW
 *
 *   8:30 AM ET
 *
 *   EXPECTED IMPACT: CRITICAL
 */

export type ExpectedImpact = 'CRITICAL' | 'HIGH' | 'MODERATE';

export interface CalendarEvent {
  id: string;
  name: string;
  /** ISO-8601 with offset, e.g. 2026-08-12T08:30:00-04:00. */
  scheduledAt: string;
  expectedImpact: ExpectedImpact;
  note?: string | null;
}

const calendarSchema = z.object({
  version: z.number(),
  timeZone: z.string().default('America/New_York'),
  events: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      scheduledAt: z.string().min(1),
      expectedImpact: z.enum(['CRITICAL', 'HIGH', 'MODERATE']),
      note: z.string().nullable().optional(),
    }),
  ),
});

export function loadCalendar(path = resolve(CONFIG_DIR, 'calendar.yaml')): {
  timeZone: string;
  events: CalendarEvent[];
} {
  if (!existsSync(path)) return { timeZone: 'America/New_York', events: [] };
  const parsed = calendarSchema.parse(parseYaml(readFileSync(path, 'utf8')));
  return {
    timeZone: parsed.timeZone,
    events: parsed.events.map((e) => ({ ...e, note: e.note ?? null })),
  };
}

/**
 * Lead times, in minutes before the event. The wording changes with the
 * distance, because "CPI IN 1440 MINUTES" is not how anyone speaks.
 */
export const LEAD_TIMES: Array<{ minutes: number; label: (name: string) => string }> = [
  { minutes: 24 * 60, label: (n) => `${n} TOMORROW` },
  { minutes: 60, label: (n) => `${n} IN 1 HOUR` },
  { minutes: 15, label: (n) => `${n} IN 15 MINUTES` },
];

/** Reminders are only worth firing inside a small window around the lead time. */
const FIRE_WINDOW_MINUTES = 3;

export interface DueReminder {
  event: CalendarEvent;
  leadMinutes: number;
  headline: string;
  body: string;
  timeText: string;
}

/** Reminders due right now, excluding any key already in `alreadyFired`. */
export function dueReminders(
  events: CalendarEvent[],
  alreadyFired: Set<string>,
  timeZone: string,
  now: string = isoNow(),
): DueReminder[] {
  const due: DueReminder[] = [];

  for (const event of events) {
    const minutesUntil = minutesBetween(now, event.scheduledAt);
    if (minutesUntil < 0) continue;

    for (const lead of LEAD_TIMES) {
      const key = `${event.id}:${lead.minutes}`;
      if (alreadyFired.has(key)) continue;

      const delta = Math.abs(minutesUntil - lead.minutes);
      if (delta > FIRE_WINDOW_MINUTES) continue;

      // The scheduled time in the desk's own timezone, without the date part —
      // the headline already says when.
      const timeText = formatAlertTimestamp(event.scheduledAt, timeZone).split(' · ')[0] ?? '';

      due.push({
        event,
        leadMinutes: lead.minutes,
        headline: lead.label(event.name.toUpperCase()),
        body: event.note ?? '',
        timeText: `${timeText} ET`,
      });
      break;
    }
  }

  return due;
}

export function renderReminder(reminder: DueReminder): string {
  const blocks = [
    '**SCOUT REMINDER**',
    `**${reminder.headline}**`,
    reminder.timeText,
    `EXPECTED IMPACT: ${reminder.event.expectedImpact}`,
  ];
  if (reminder.body.trim()) blocks.push(reminder.body.trim());
  return blocks.join('\n\n');
}

export interface CalendarScheduler {
  start(intervalMs?: number): void;
  stop(): void;
  /** Evaluate once. Returns the reminders that fired. */
  tick(now?: string): Promise<DueReminder[]>;
}

export interface CalendarSchedulerDeps {
  events: CalendarEvent[];
  timeZone: string;
  logger: Logger;
  /** Publishes a rendered reminder to news + both trading channels. */
  publish: (rendered: string, reminder: DueReminder) => Promise<void>;
  /** Persisted so a restart does not refire a reminder already sent. */
  hasFired: (key: string) => boolean;
  markFired: (key: string) => void;
}

export function createCalendarScheduler(deps: CalendarSchedulerDeps): CalendarScheduler {
  let timer: NodeJS.Timeout | null = null;

  async function tick(now: string = isoNow()): Promise<DueReminder[]> {
    const fired = new Set<string>();
    for (const event of deps.events) {
      for (const lead of LEAD_TIMES) {
        const key = `${event.id}:${lead.minutes}`;
        if (deps.hasFired(key)) fired.add(key);
      }
    }

    const due = dueReminders(deps.events, fired, deps.timeZone, now);

    for (const reminder of due) {
      const key = `${reminder.event.id}:${reminder.leadMinutes}`;
      try {
        await deps.publish(renderReminder(reminder), reminder);
        deps.markFired(key);
        deps.logger.info('calendar reminder sent', {
          event: reminder.event.id,
          leadMinutes: reminder.leadMinutes,
        });
      } catch (err) {
        // Leave it unmarked so the next tick retries inside the window.
        deps.logger.warn('calendar reminder failed', { key, err: err as Error });
      }
    }

    return due;
  }

  return {
    start(intervalMs = 60_000): void {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void tick(), intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
