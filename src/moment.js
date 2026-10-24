// A MOMENT, READ STRICTLY — the one spelling of a date or a date-time every window bound and every
// condition's time constant takes, and its UTC instant. A leaf: it imports nothing, so a module any other
// imports (the condition writer, the time window) can read a moment without closing an import cycle.

/** Offset (ms) of timezone `tz` vs UTC at the given UTC instant (whole seconds: a zone's offset has none). */
export function tzOffsetMs(tz, atUtc) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(atUtc).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  // the parts carry no milliseconds, so neither may the instant they are compared with
  return asUtc - Math.floor(atUtc.getTime() / 1000) * 1000;
}

// 'YYYY-MM-DD[( |T)HH:mm[:ss[.fff…]]][Z|±hh[[:]mm]]' — the one spelling of a moment every window takes
const MOMENT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * A moment, read strictly: { ms, offset, frac } — its components taken literally as UTC (ms), its own
 * offset when it carries one (minutes east of UTC; null for a wall-clock reading), and the fraction of a
 * second as written, to the microsecond a TIMESTAMP holds on both warehouses (`frac`, its digits) — or null
 * when it is no moment at all: a day the month does not have, an hour past 23, a minute past 59 are
 * refused, never rolled over into the next day.
 */
export function parseMoment(value) {
  const m = MOMENT_RE.exec(String(value));
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, sec = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? undefined : +x));
  const frac = m[7] ? m[7].slice(0, 6) : '';
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== sec) return null;
  let offset = null;
  if (m[8]) {
    if (m[8] === 'Z' || m[8] === 'z') offset = 0;
    else {
      const [, sign, oh, om = '0'] = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(m[8]);
      if (+oh > 23 || +om > 59) return null;
      offset = (sign === '-' ? -1 : 1) * (+oh * 60 + +om);
    }
  }
  return { ms: t, offset, frac };
}

/** An instant as 'YYYY-MM-DD HH:mm:ss[.f…]': its whole seconds, and the fraction of a second written as
 *  `digits` (an offset, and a zone's shift, move an instant by whole seconds, so the fraction written is
 *  the instant's) — at least the milliseconds, as many digits as were written up to the microsecond. */
const fmtUtc = (ms, digits = '') => {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const frac = /[1-9]/.test(digits) ? `.${digits.padEnd(3, '0')}` : '';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`;
};

/**
 * A moment as the UTC instant 'YYYY-MM-DD HH:mm:ss[.fff]' the warehouse stores: one carrying its own
 * offset (Z, ±hh[:mm]) is that instant whatever the zone; a wall-clock one is read in `tz` (two passes
 * of the offset lookup settle DST edges) — or, with no `tz`, as UTC already. The fraction of a second
 * is kept as written, to the microsecond. Null when it is no moment.
 */
export function localToUtc(value, tz) {
  const p = parseMoment(value);
  if (!p) return null;
  if (p.offset !== null) return fmtUtc(p.ms - p.offset * 60000, p.frac);
  if (!tz) return fmtUtc(p.ms, p.frac);
  const naive = p.ms;
  let guess = naive - tzOffsetMs(tz, new Date(naive));
  guess = naive - tzOffsetMs(tz, new Date(guess)); // second pass settles DST edges
  return fmtUtc(guess, p.frac);
}

/**
 * A moment as epoch milliseconds — one with an offset of its own at that instant, a wall-clock one read
 * as UTC (what resolveTimeRange's bounds are). Null when it is no moment.
 */
export function momentMs(value) {
  const p = parseMoment(value);
  return p ? p.ms - (p.offset ?? 0) * 60000 : null;
}

/** Whether a moment carries its own offset (Z, ±hh[:mm]): an instant, not a wall-clock reading. */
export const hasOffset = (v) => parseMoment(v)?.offset != null;
