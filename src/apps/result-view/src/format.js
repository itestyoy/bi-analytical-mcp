// HOW A VALUE READS, AND WHICH COLOUR A SERIES IS — the result view's own formats (percent, points,
// signed changes, times, p-values; the shared number formats are src/apps/shared/ui.js) and the
// theme's colours read from its CSS variables.

import { formatNumber } from '../../shared/ui.js';

export const formatPercent = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`);

export const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');

export const formatPoints = (v) => `${sign(v)}${Math.abs(v * 100).toFixed(2)} pp`;

export const formatSignedPercent = (v, digits = 1) => `${sign(v)}${Math.abs(v * 100).toFixed(digits)}%`;

/**
 * A time value as a reader wants it: a timestamp at midnight UTC — what a day/week/month bucket is —
 * is shown as its date ("Sep 16"), with the year when the values span more than one; a real time of
 * day keeps it. The raw value stays the sort key; only the label changes.
 */
/**
 * A warehouse time value as a Date. Warehouses spell it several ways — '2026-09-16',
 * '2026-09-16T00:00:00+00:00', '2026-09-16 00:00:00' — and the last one is not a format the
 * standard guarantees: WebKit (Safari, every iOS app) refuses it. So the value is normalised to
 * ISO 8601 first, and a time with no zone is read as UTC, which is what the warehouse means.
 */
export function parseTime(v) {
  let t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00';
  t = t.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += 'Z';
  return new Date(t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

export function timeFormatter(values) {
  const dates = values.map(parseTime).filter((d) => !Number.isNaN(d.getTime()));
  if (!dates.length) return (v) => String(v);
  const midnight = dates.every((d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0);
  const years = new Set(dates.map((d) => d.getUTCFullYear()));
  const fmt = new Intl.DateTimeFormat(undefined, midnight
    ? { month: 'short', day: 'numeric', ...(years.size > 1 ? { year: 'numeric' } : {}), timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return (v) => { const d = parseTime(v); return Number.isNaN(d.getTime()) ? String(v) : fmt.format(d); };
}

export const formatSignedNumber = (v) => `${sign(v)}${formatNumber(Math.abs(v))}`;

export const formatP = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));

/** One number format for a whole column: the same decimals down it, so the digits line up. */
export function columnFormat(values) {
  const xs = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!xs.length || xs.some((x) => x !== 0 && Math.abs(x) < 0.01)) return formatNumber;
  const places = (x) => (Math.abs(x) >= 1000 ? 0 : [0, 1, 2].find((d) => Math.abs(x - Number(x.toFixed(d))) < 1e-9) ?? 2);
  const digits = Math.max(...xs.map(places));
  const f = new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (x) => (x === null || x === undefined ? '—' : f.format(x));
}

export const correctionName = (c) => ({ holm: 'Holm', bh: 'Benjamini–Hochberg', bonferroni: 'Bonferroni' }[c] || c);

/**
 * A color variable RESOLVED to a concrete rgba — how the canvas chart picks up the host's theme.
 * The raw custom property can be `light-dark(…)`, `oklch(…)` or a host token; the computed color of
 * an element that uses it, painted once on a 1×1 canvas and read back, is always plain rgba.
 */
export const colorProbe = document.createElement('span');

export const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

export function cssVar(name) {
  colorProbe.style.color = `var(${name})`;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(colorProbe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

export const seriesColor = (i) => cssVar(`--color-series-${(i % 6) + 1}`);

/** A resolved rgba color at another opacity — an area's wash is its line's color, lighter. */
export const withAlpha = (rgba, a) => rgba.replace(/[\d.]+\)$/, `${a})`);
