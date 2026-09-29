/**
 * calendar.js — the pulse run's calendar day (PULSE_TZ).
 *
 * The documented crontab (`30 6 * * 1-5`, docs/pulse.md) fires in the
 * HOST'S LOCAL time, but raw Date math (getUTCDay, toISOString date
 * slices) is UTC-keyed. On a host east of UTC+6.5, local Monday 06:30 is
 * still Sunday in UTC: weekly subscribers silently never match and the
 * Monday daily digest is skipped — no warning, exit 0. In UTC− zones with
 * an evening run, every date label / overdue-day count drifts by one day
 * (cubic PR #20 R2).
 *
 * Fix strategy: pulseBody re-keys `now` ONCE onto ONE calendar day — the
 * PULSE_TZ day when set, else the host's local day — by anchoring it to
 * UTC midnight of that calendar day (calendarAnchor). Anchored, the
 * existing UTC math everywhere downstream (cadenceDue's getUTCDay, the
 * ISO date slices in render/writeDryRun, calendarDays) reads the pulse
 * calendar with zero per-call-site changes, and date-only due dates
 * ('YYYY-MM-DD', parsed as UTC midnight by parseDate) diff against the
 * same UTC-midnight anchor exactly.
 */

/**
 * Resolve PULSE_TZ to a usable IANA zone name. Empty/absent → host local
 * (`timeZone: undefined`). An invalid zone fails soft — warning + host
 * local — per the pulse convention that bad config warns, never crashes.
 */
export function resolvePulseTimeZone(env = process.env) {
  const raw = typeof env.PULSE_TZ === 'string' ? env.PULSE_TZ.trim() : '';
  if (raw === '') return { timeZone: undefined };
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw });
    return { timeZone: raw };
  } catch {
    return { timeZone: undefined, warning: `invalid PULSE_TZ "${raw}" — using host local calendar` };
  }
}

/** Y/M/D of the calendar day containing `now`, in `timeZone`
 * (undefined = host local). en-CA yields ISO-ordered numeric parts. */
export function calendarParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : NaN;
  };
  return { year: value('year'), month: value('month'), day: value('day') };
}

/** Weekday (0=Sun..6=Sat) of the calendar day containing `now`. Computed
 * from the Y/M/D itself — a calendar date's weekday is zone-independent
 * once the date is known. */
export function calendarWeekday(now, timeZone) {
  const { year, month, day } = calendarParts(now, timeZone);
  if ([year, month, day].some(Number.isNaN)) return NaN;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Re-key `now` onto its calendar day: a UTC-midnight Date whose UTC Y/M/D
 * equals the Y/M/D of `now` in `timeZone`. Downstream UTC-keyed math then
 * operates on that calendar. Returns `now` unchanged when it is not a
 * valid Date (fail-soft; the caller keeps its own fallback).
 */
export function calendarAnchor(now, timeZone) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return now;
  const { year, month, day } = calendarParts(now, timeZone);
  if ([year, month, day].some(Number.isNaN)) return now;
  return new Date(Date.UTC(year, month - 1, day));
}
