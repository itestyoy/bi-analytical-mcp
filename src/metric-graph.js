// WHAT A QUERY'S METRICS READ, FROM THEIR DEFINITIONS (a context's metrics, MetricFlow's legacy
// shape): how many days before a query's window they read — a cumulative window, an input's offset,
// through a ratio's or a derived metric's inputs.

/** Days in one unit of a metric window (a month and a year at their longest). */
const WINDOW_DAYS = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 31, quarter: 92, year: 366 };
const windowDays = (w) => {
  const m = /^(\d+) (second|minute|hour|day|week|month|quarter|year)s?$/.exec(String(w || ''));
  return m ? Math.ceil(Number(m[1]) * WINDOW_DAYS[m[2]]) : 0;
};

/**
 * How many days before a query's window its metrics read, rounded up to whole partition days: a
 * cumulative metric its window, a grain-to-date one up to a period of that grain, one with neither every day before
 * (Infinity); a ratio or derived metric what its inputs read. 0 for the rest.
 */
export function lookbackDays(names, metrics, seen = new Set()) {
  let most = 0;
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const mt = metrics.find((x) => x.name === name);
    if (!mt) continue;
    const tp = mt.type_params || {};
    let days = 0;
    if (mt.type === 'cumulative') {
      const c = tp.cumulative_type_params || {};
      const w = c.window ?? tp.window; const g = c.grain_to_date ?? tp.grain_to_date;
      days = w ? windowDays(w) : g ? WINDOW_DAYS[g] ?? Infinity : Infinity;
    } else {
      const inputs = [tp.numerator, tp.denominator, ...(tp.metrics || [])].filter((x) => x?.name);
      days = Math.max(0, ...inputs.map((x) => windowDays(x.offset_window)), lookbackDays(inputs.map((x) => x.name), metrics, seen));
    }
    most = Math.max(most, days);
  }
  return most;
}

/** A moment's day moved by `days` (date-only, UTC). */
export function shiftDay(moment, days) {
  const d = new Date(`${String(moment).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
