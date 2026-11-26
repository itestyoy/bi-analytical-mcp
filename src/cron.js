// A CRON SCHEDULE: when a recurring background job runs (the value index's sync — its `dbt run` of the
// source models and the indexing after it), written as the standard five fields, read in an IANA time zone.
//
//   minute hour day-of-month month day-of-week     e.g. "30 3 * * *" — every day at 03:30
//
// Each field is `*`, a value, a range `a-b`, a step `*/n`, `a-b/n` or `a/n` (from a to the field's end),
// or a comma list of them; months and weekdays also by name (jan…dec, sun…sat), Sunday 0 or 7. As in
// Vixie cron, a day-of-month and a day-of-week that are both restricted match a day when EITHER does;
// @hourly, @daily (@midnight), @weekly, @monthly and @yearly (@annually) name the usual ones.
//
// The times are wall-clock in the zone: a minute that a daylight-saving change skips is not run, one it
// repeats runs once.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], base: 1 },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], base: 0 },
];

const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// how far ahead a next time is looked for: Feb 29 on a given weekday recurs within 28 years
const HORIZON_MS = 29 * 366 * 86400000;

function fieldValues(text, f, expr) {
  const bad = (why) => new Error(`cron '${expr}': the ${f.name} field '${text}' ${why} — five fields: minute (0-59) hour (0-23) day-of-month (1-31) month (1-12 or jan-dec) day-of-week (0-7 or sun-sat, 0 and 7 are Sunday)`);
  const value = (s) => {
    const i = f.names ? f.names.indexOf(s.toLowerCase()) : -1;
    if (i >= 0) return i + f.base;
    if (!/^\d+$/.test(s)) throw bad(`has '${s}', which is not a number${f.names ? ' or a name' : ''}`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw bad(`has ${n}, outside ${f.min}-${f.max}`);
    return n;
  };
  const out = new Set();
  for (const item of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(item);
    if (!m) throw bad(`has '${item}', which is no value, range or step`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw bad('has a step of 0');
    let lo; let hi;
    if (m[1] === '*') { lo = f.min; hi = f.max; }
    else if (m[1].includes('-')) {
      const [a, b, ...rest] = m[1].split('-');
      if (rest.length) throw bad(`has '${m[1]}', which is no range`);
      lo = value(a); hi = value(b);
      if (lo > hi) throw bad(`has the range ${m[1]}, which runs backwards`);
    } else { lo = value(m[1]); hi = m[2] === undefined ? lo : f.max; }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a cron expression → its fields as sets of values (throws, naming the field, on anything else). */
export function parseCron(expression) {
  const expr = String(expression ?? '').trim();
  const body = MACROS[expr.toLowerCase()] || expr;
  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`cron '${expr}': ${parts.length} field(s) — five are needed: minute hour day-of-month month day-of-week (e.g. "30 3 * * *": every day at 03:30), or @hourly / @daily / @weekly / @monthly / @yearly`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => fieldValues(p, FIELDS[i], expr));
  if (dow.delete(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2].startsWith('*'), dowAny: parts[4].startsWith('*') };
}

/** A schedule: the expression, read in `timeZone` (an IANA name; UTC by default). Throws on either. */
export class CronSchedule {
  constructor(expression, timeZone = 'UTC') {
    this.expression = String(expression).trim();
    this.timeZone = timeZone || 'UTC';
    this.spec = parseCron(this.expression);
    try {
      this._fmt = new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    } catch {
      throw new Error(`cron time zone '${this.timeZone}' is not an IANA time zone name (e.g. UTC, Europe/Moscow)`);
    }
    if (!this.next(new Date())) throw new Error(`cron '${this.expression}' never comes (no such date)`);
  }

  /** The wall clock in the schedule's zone at instant `t` (ms). */
  _wall(t) {
    const p = {};
    for (const { type, value } of this._fmt.formatToParts(new Date(t))) p[type] = value;
    return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, dow: WEEKDAYS[p.weekday] };
  }

  _dayMatches(w) {
    const { dom, dow, domAny, dowAny, month } = this.spec;
    if (!month.has(w.month)) return false;
    if (!domAny && !dowAny) return dom.has(w.day) || dow.has(w.dow);
    return dom.has(w.day) && dow.has(w.dow);
  }

  /**
   * The first instant after `after` (a Date) whose wall minute matches, or null when none comes. A wall
   * minute a clock change repeats is the same minute: the instant that repeats the wall minute of `after`
   * is passed over, so a run at it is not run again an hour later.
   */
  next(after) {
    const from = after.getTime();
    const key = (w) => `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}`;
    const was = key(this._wall(from));
    let t = Math.floor(from / 60000) * 60000 + 60000;
    while (t <= from + HORIZON_MS) {
      const w = this._wall(t);
      // a day that does not match: on to 23:00, then by the hour past midnight (so a clock change on the
      // way never steps over the next day's first hour)
      if (!this._dayMatches(w)) { t += (w.hour < 23 ? (23 - w.hour) * 60 - w.minute : 60 - w.minute) * 60000; continue; }
      if (!this.spec.hour.has(w.hour)) { t += (60 - w.minute) * 60000; continue; }
      if (!this.spec.minute.has(w.minute) || key(w) === was) { t += 60000; continue; }
      return new Date(t);
    }
    return null;
  }

  toString() { return `cron '${this.expression}' (${this.timeZone})`; }
}
