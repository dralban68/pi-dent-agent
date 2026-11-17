/**
 * Time values of the `Schedule` tool (specs/schedule-tool.md Section 2.2):
 * parsing an RFC 3339 date-time into milliseconds since the Unix epoch, and
 * rendering an instant as a local time stamp.
 */

import { localStampIn } from "./billing-text.ts";

/** The latest instant an ECMAScript `Date` represents, ms since the Unix epoch (Section 1.2, check 10). */
export const MAX_INSTANT = 8640000000000000;

/** The `date-time` production of RFC 3339, Section 5.6. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month !== 2) return MONTH_DAYS[month - 1] ?? 0;
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

/** Milliseconds since the Unix epoch of the UTC calendar fields, years below 100 included. */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

function digitsOf(text: string | undefined): number {
  return text === undefined ? Number.NaN : Number(text);
}

/**
 * The instant an RFC 3339 date-time names, milliseconds since the Unix epoch, or
 * undefined when it is not one (Section 2.2): a `date-time` with a time-zone
 * offset, a valid calendar date, and a second below 60. `T` and `Z` are accepted
 * in either case, `-00:00` denotes UTC, and fractional seconds are truncated to
 * whole milliseconds.
 */
export function parseDateTime(text: string): number | undefined {
  const match = DATE_TIME.exec(text);
  if (!match) return;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    ,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = digitsOf(yearText);
  const month = digitsOf(monthText);
  const day = digitsOf(dayText);
  const hour = digitsOf(hourText);
  const minute = digitsOf(minuteText);
  const second = digitsOf(secondText);
  if (month < 1 || month > 12) return;
  if (day < 1 || day > daysInMonth(year, month)) return;
  if (hour > 23 || minute > 59 || second > 59) return;
  const offsetHour = digitsOf(offsetHourText);
  const offsetMinute = digitsOf(offsetMinuteText);
  if (sign !== undefined && (offsetHour > 23 || offsetMinute > 59)) return;
  const fraction = fractionText === undefined ? 0 : Number(`${fractionText}00`.slice(0, 3));
  const zone =
    sign === undefined ? 0 : (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60000;
  const instant = utcMs(year, month, day, hour, minute, second, fraction) - zone;
  if (!Number.isFinite(instant) || Math.abs(instant) > MAX_INSTANT) return;
  return instant;
}

/**
 * An instant as a local time stamp (Section 2.2): `YYYY-MM-DDTHH:MM:SS±HH:MM` in
 * `zone`, the local zone of billing.md Section 5, whole seconds rounded down,
 * with that zone's offset from UTC at the instant.
 */
export function localStamp(ms: number, zone: string): string {
  return localStampIn(ms, zone);
}
