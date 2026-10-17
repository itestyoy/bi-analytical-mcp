// Time-window semantics shared by the semantic-layer and pipeline query paths:
// IANA-timezone boundary conversion (a "day" for a player in Europe/Berlin is not
// a UTC day) and incomplete-period detection (don't silently report a partial month).
//
// Scope: the TIMEZONE applies to the WINDOW BOUNDARIES — 'start'/'end' are read as
// local wall-clock times in `timezone` and converted to the UTC instants the
// warehouse stores. (Grouping grain stays warehouse-side; converting bucket
// boundaries inside MetricFlow-generated SQL is out of scope.)

import { ToolError } from './validate.js';
import { localToUtc, momentMs, hasOffset } from './moment.js';

// (the moment's own reading lives in a leaf module, ./moment.js: these are re-exported for the window's callers)
export { localToUtc, momentMs };

/** True if `tz` is a valid IANA timezone name. */
export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

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

/** A column compared with a constant, as the one expression grammar writes a condition
 *  (src/pipeline/compute.js): what a where stage takes, and what a scan writes through the same writer. */
const bound = (column, op, value) => ({ fn: op, args: [{ column }, { value }] });

/**
 * The conditions on a model's partition column for a window on its time axis — [] when the model
 * has none, or when it partitions by the time axis itself (the window already bounds it). An event
 * lies in the partition of its own day, or up to `partition_late_days` days later.
 * @returns the conditions, each { fn: 'gte' | 'lt', args: [{ column }, { value }] }
 */
export function partitionConditions(model, bounds) {
  const part = model?.partition_column;
  if (!part || part === model.time?.column) return [];
  const { from, until } = partitionDays(bounds, model.partition_late_days || 0);
  return [...(from ? [bound(part, 'gte', from)] : []), ...(until ? [bound(part, 'lt', until)] : [])];
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
    if (utc == null) throw new ToolError(`time_range.${which}: '${v}' is not a date or a date-time (YYYY-MM-DD, or YYYY-MM-DD HH:mm[:ss[.fff]] with an optional Z or ±hh[:mm])`, { stage: 'validate', field: `time_range.${which}` });
    return utc;
  };
  // a window that ends before it starts holds no moment: refused, never read as an empty result
  // (a date-only end is its whole day: the window holds a moment while start is before the next day)
  if (start && end && (isDateOnly(end) ? at(start, 'start') >= at(nextDay(end), 'end') : at(start, 'start') > at(end, 'end'))) throw new ToolError(`time_range ends before it starts (start '${start}', end '${end}') — swap them`, { stage: 'validate', field: 'time_range' });
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
 * longer carries it): the ONE rule every stage, build and funnel filter applies, written in the one
 * expression grammar ({ fn: 'gte' | 'lt' | 'lte', args: [{ column }, { value }] }) — a where stage's
 * conditions as they are. The timezone is checked by the caller (isValidTimezone), which knows how to
 * refuse. → the conditions | null
 */
export function timeRangeConditions(model, tr, { partition = true } = {}) {
  if (!tr || !(tr.start || tr.end)) return null;
  const timeCol = model?.time?.column;
  if (!timeCol) return null;
  const r = resolveTimeRange(tr);
  const conditions = [];
  if (r.start) conditions.push(bound(timeCol, 'gte', r.start));
  if (r.endExclusive) conditions.push(bound(timeCol, 'lt', r.endExclusive));
  else if (r.end) conditions.push(bound(timeCol, 'lte', r.end));
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
