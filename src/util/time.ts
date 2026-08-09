/**
 * Time helpers. The alert timestamp format is part of the product surface, so
 * it is assembled by hand rather than left to a locale string.
 */

export const DEFAULT_TIMEZONE = 'America/New_York';

export function isoNow(): string {
  return new Date().toISOString();
}

export function msBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return b - a;
}

export function minutesBetween(aIso: string, bIso: string): number {
  return msBetween(aIso, bIso) / 60_000;
}

/**
 * AP style: March, April, May, June and July are never abbreviated; the rest
 * take a period. This is what makes the spec's two examples — "May 24, 2026"
 * and "Aug. 9, 2026" — consistent rather than contradictory.
 */
const AP_MONTH: Record<string, string> = {
  January: 'Jan.',
  February: 'Feb.',
  March: 'March',
  April: 'April',
  May: 'May',
  June: 'June',
  July: 'July',
  August: 'Aug.',
  September: 'Sept.',
  October: 'Oct.',
  November: 'Nov.',
  December: 'Dec.',
};

/** `5:14 PM · May 24, 2026` — Eastern by default, because it is a trading desk. */
export function formatAlertTimestamp(iso: string, timeZone: string = DEFAULT_TIMEZONE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const hour = get('hour');
  const minute = get('minute');
  const dayPeriod = get('dayPeriod').toUpperCase().replace(/\./g, '');
  const month = AP_MONTH[get('month')] ?? get('month');
  const day = get('day');
  const year = get('year');

  return `${hour}:${minute} ${dayPeriod} · ${month} ${day}, ${year}`;
}
