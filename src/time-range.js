// Time-window semantics shared by the semantic-layer and pipeline query paths:
// IANA-timezone boundary conversion (a "day" for a player in Europe/Berlin is not
// a UTC day) and incomplete-period detection (don't silently report a partial month).
//
// Scope: the TIMEZONE applies to the WINDOW BOUNDARIES — 'start'/'end' are read as
// local wall-clock times in `timezone` and converted to the UTC instants the
// warehouse stores. (Grouping grain stays warehouse-side; converting bucket
// boundaries inside MetricFlow-generated SQL is out of scope.)

import { ToolError } from './validate.js';

/** True if `tz` is a valid IANA timezone name. */
export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Offset (ms) of timezone `tz` vs UTC at the given UTC instant (whole seconds: a zone's offset has none). */
function tzOffsetMs(tz, atUtc) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(atUtc).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  // the parts carry no milliseconds, so neither may the instant they are compared with
  return asUtc - Math.floor(atUtc.getTime() / 1000) * 1000;
}

// 'YYYY-MM-DD[( |T)HH:mm[:ss[.fff]]][Z|±hh[:]mm]' — the one spelling of a moment every window takes
const MOMENT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A moment, read strictly: { ms, offset } — its components taken literally as UTC (ms), and its own
 * offset when it carries one (minutes east of UTC; null for a wall-clock reading) — or null when it is
 * no moment at all: a day the month does not have, an hour past 23, a minute past 59 are refused, never
 * rolled over into the next day.
 */
function parseMoment(value) {
  const m = MOMENT_RE.exec(String(value));
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, sec = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? undefined : +x));
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== sec) return null;
  let offset = null;
  if (m[8]) {
    if (m[8] === 'Z') offset = 0;
    else {
      const [, sign, oh, om] = /^([+-])(\d{2}):?(\d{2})$/.exec(m[8]);
      if (+oh > 23 || +om > 59) return null;
      offset = (sign === '-' ? -1 : 1) * (+oh * 60 + +om);
    }
  }
  return { ms: t, offset };
}

const fmtUtc = (ms) => {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const frac = d.getUTCMilliseconds() ? `.${pad(d.getUTCMilliseconds(), 3)}` : '';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`;
};

/**
 * A moment as the UTC instant 'YYYY-MM-DD HH:mm:ss[.fff]' the warehouse stores: one carrying its own
 * offset (Z, ±hh:mm) is that instant whatever the zone; a wall-clock one is read in `tz` (two passes
 * of the offset lookup settle DST edges) — or, with no `tz`, as UTC already. Null when it is no moment.
 */
export function localToUtc(value, tz) {
  const p = parseMoment(value);
  if (!p) return null;
  if (p.offset !== null) return fmtUtc(p.ms - p.offset * 60000);
  if (!tz) return fmtUtc(p.ms);
  const naive = p.ms;
  let guess = naive - tzOffsetMs(tz, new Date(naive));
  guess = naive - tzOffsetMs(tz, new Date(guess)); // second pass settles DST edges
  return fmtUtc(guess);
}

/** Whether a moment carries its own offset (Z, ±hh:mm): an instant, not a wall-clock reading. */
const hasOffset = (v) => parseMoment(v)?.offset != null;

export const isDateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The next calendar day of a date-only string (exclusive upper bound helper). */
export function nextDay(dateOnly) {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The partition days a window on the time axis touches, for a source partitioned by the DAY of its
 * time axis (a day column next to it): { from, until } as date-only values, `until` exclusive, and
 * `lateDays` more after it for a source that files a late event under the day it arrived.
 * Bounds are in the warehouse clock (UTC), as resolveTimeRange returns them or a condition states
 * them: `start` inclusive, `endExclusive` exclusive (at midnight it touches no day of its own),
 * `end` inclusive. A bound that is not a date is left out.
 */
export function partitionDays({ start = null, endExclusive = null, end = null } = {}, lateDays = 0) {
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const atMidnight = (v) => v.length === 10 || /^\d{4}-\d{2}-\d{2}[ T]00:00(:00(\.0+)?)?(Z|[+-]00(:?00)?)?$/.test(v);
  const from = day(start);
  let until = null;
  if (day(endExclusive)) until = atMidnight(endExclusive) ? day(endExclusive) : nextDay(day(endExclusive));
  else if (day(end)) until = nextDay(day(end));
  for (let i = 0; until && i < lateDays; i += 1) until = nextDay(until);
  return { from, until };
}

/**
 * The conditions on a model's partition column for a window on its time axis — [] when the model
 * has none, or when it partitions by the time axis itself (the window already bounds it). An event
 * lies in the partition of its own day, or up to `partition_late_days` days later.
 * @returns {{ column, op: 'gte'|'lt', value }[]}
 */
export function partitionConditions(model, bounds) {
  const part = model?.partition_column;
  if (!part || part === model.time?.column) return [];
  const { from, until } = partitionDays(bounds, model.partition_late_days || 0);
  return [...(from ? [{ column: part, op: 'gte', value: from }] : []), ...(until ? [{ column: part, op: 'lt', value: until }] : [])];
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
  // a bound that does not read as a moment is refused, never dropped: a window without it would
  // scan the whole history and report it as the window asked for
  const at = (v, which) => {
    const utc = localToUtc(v, timezone);
    if (utc == null) throw new ToolError(`time_range.${which}: '${v}' is not a date or a date-time (YYYY-MM-DD, or YYYY-MM-DD HH:mm[:ss[.fff]] with an optional Z or ±hh:mm)`, { stage: 'validate', field: `time_range.${which}` });
    return utc;
  };
  if (!timezone) {
    // warehouse-native (UTC): a wall-clock bound stands as written, an instant with an offset of its own
    // is written as the UTC instant it is — so the partition day taken from it is that instant's day
    const native = (v, which) => (v == null ? null : (at(v, which), hasOffset(v) ? localToUtc(v) : v));
    return { start: native(start, 'start'), end: native(end, 'end'), endExclusive: end && isDateOnly(end) ? (at(end, 'end'), nextDay(end)) : null };
  }
  const out = { start: null, end: null, endExclusive: null };
  if (start) out.start = at(start, 'start');
  if (end) {
    if (isDateOnly(end)) {
      out.endExclusive = at(`${nextDay(end)} 00:00:00`, 'end'); // whole local day
      out.end = at(`${end} 23:59:59`, 'end'); // inclusive form for engines without `lt`
    } else {
      out.end = at(end, 'end');
    }
  }
  return out;
}

/**
 * The conditions a {start, end, timezone} window puts on a model's time axis — and on its partition
 * column when it partitions by another (`partition: false` leaves that out, for a relation that no
 * longer carries it): the ONE rule every stage, build and funnel filter applies. The timezone is
 * checked by the caller (isValidTimezone), which knows how to refuse. → { column, op, value }[] | null
 */
export function timeRangeConditions(model, tr, { partition = true } = {}) {
  if (!tr || !(tr.start || tr.end)) return null;
  const timeCol = model?.time?.column;
  if (!timeCol) return null;
  const r = resolveTimeRange(tr);
  const conditions = [];
  if (r.start) conditions.push({ column: timeCol, op: 'gte', value: r.start });
  if (r.endExclusive) conditions.push({ column: timeCol, op: 'lt', value: r.endExclusive });
  else if (r.end) conditions.push({ column: timeCol, op: 'lte', value: r.end });
  // a source partitioned by ANOTHER column (the day of the event time, next to it) is pruned only by a
  // condition on that column; the time axis above stays the exact bound
  if (partition) conditions.push(...partitionConditions(model, { start: r.start, endExclusive: r.endExclusive, end: r.endExclusive ? null : r.end }));
  return conditions.length ? conditions : null;
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
