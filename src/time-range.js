// Time-window semantics shared by the semantic-layer and pipeline query paths:
// IANA-timezone boundary conversion (a "day" for a player in Europe/Berlin is not
// a UTC day) and incomplete-period detection (don't silently report a partial month).
//
// Scope: the TIMEZONE applies to the WINDOW BOUNDARIES — 'start'/'end' are read as
// local wall-clock times in `timezone` and converted to the UTC instants the
// warehouse stores. (Grouping grain stays warehouse-side; converting bucket
// boundaries inside MetricFlow-generated SQL is out of scope.)

/** True if `tz` is a valid IANA timezone name. */
export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Offset (ms) of timezone `tz` vs UTC at the given UTC instant. */
function tzOffsetMs(tz, atUtc) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(atUtc).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - atUtc.getTime();
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parse 'YYYY-MM-DD[ HH:mm[:ss]]' into naive UTC ms (components taken literally), or null. */
function naiveMs(value) {
  const m = LOCAL_RE.exec(String(value));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

const fmtUtc = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/**
 * Interpret a local date/datetime string as wall-clock time in `tz` and return the
 * equivalent UTC instant as 'YYYY-MM-DD HH:mm:ss'. Two-pass offset lookup handles
 * DST transitions. Returns null when the value isn't a plain date/datetime.
 */
export function localToUtc(value, tz) {
  const naive = naiveMs(value);
  if (naive == null) return null;
  let guess = naive - tzOffsetMs(tz, new Date(naive));
  guess = naive - tzOffsetMs(tz, new Date(guess)); // second pass settles DST edges
  return fmtUtc(guess);
}

/** True if the string is date-only (no time part). */
export const isDateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The next calendar day of a date-only string (exclusive upper bound helper). */
export function nextDay(dateOnly) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a {start, end, timezone} window to UTC bounds.
 * - start: date-only → local midnight; datetime → as given. Converted to UTC.
 * - end:   date-only → INCLUSIVE whole local day (endExclusive = next local midnight in UTC);
 *          datetime → inclusive instant converted to UTC.
 * Without a timezone the values pass through unchanged (warehouse-native semantics).
 * Returns { start, end, endExclusive } — endExclusive is set ONLY for date-only ends.
 */
export function resolveTimeRange(tr) {
  if (!tr) return null;
  const { start, end, timezone } = tr;
  if (!timezone) return { start: start ?? null, end: end ?? null, endExclusive: end && isDateOnly(end) ? nextDay(end) : null };
  const out = { start: null, end: null, endExclusive: null };
  if (start) out.start = localToUtc(start, timezone);
  if (end) {
    if (isDateOnly(end)) {
      out.endExclusive = localToUtc(`${nextDay(end)} 00:00:00`, timezone); // whole local day
      out.end = localToUtc(`${end} 23:59:59`, timezone); // inclusive form for engines without `lt`
    } else {
      out.end = localToUtc(end, timezone);
    }
  }
  return out;
}

/**
 * Warnings about the window itself (data-independent):
 * - no window at all → full-history scan warning;
 * - window reaching into today → the trailing period is incomplete.
 */
export function timeRangeWarnings(tr, now = new Date()) {
  const warnings = [];
  const today = now.toISOString().slice(0, 10);
  if (!tr || (!tr.start && !tr.end)) {
    warnings.push('No time_range: the query scans the WHOLE events history. Bound it with time_range {start, end} to prune partitions and keep results comparable.');
  } else if (!tr.end || String(tr.end).slice(0, 10) >= today) {
    warnings.push(`The window includes the current incomplete period (today is ${today}): trailing buckets are partial. For period comparisons set end to the last complete day.`);
  }
  return warnings;
}
