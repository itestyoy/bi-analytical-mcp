// THE A/B TEST — each variant's lift, its interval on one shared scale, its verdict; as cards on a
// narrow page and a table on a wide one.
//
// One variant: a stat card (shadcn dashboard "section cards") — the comparison as the description,
// the lift as the headline, the verdict as the badge; the interval plot as the content; the key
// figures in a divided grid at the foot.
// Several variants: ONE card holding them all — the control as the baseline row, then a row per
// variant (value, lift, interval, verdict), every interval on the same scale with one shared axis
// under them, so the variants compare down a single column.

import { icon } from '../../shared/icons.js';
import { el, badge, card, integerFormat, stat } from '../../shared/ui.js';
import { cardsSection } from './page.js';
import { formatPercent, formatPoints, formatSignedPercent, formatSignedNumber, formatP, columnFormat, correctionName } from './format.js';
import { showAlert, setDescription } from './blocks.js';
import { showNotes } from './render.js';

// The badge names the direction; its colour says whether that direction is good for this metric
// (outcome, from the caller's `good`): an improvement green, a regression red, no difference plain.
export const VERDICTS = {
  increase: { icon: 'trending-up', text: 'Significant increase' },
  decrease: { icon: 'trending-down', text: 'Significant decrease' },
  // an interval across zero is not evidence of no effect — it is not enough evidence either way
  no_difference: { icon: 'minus', text: 'Inconclusive' },
};

export const OUTCOME_VARIANT = { better: 'success', worse: 'destructive', no_difference: 'outline' };

/** The axis under an interval: the scale's ends and the no-effect line in the middle. */
export function intervalAxis(scale, unit, fmt) {
  const tick = unit === 'relative' ? (x) => formatSignedPercent(x, Number.isInteger(Math.round(x * 1e6) / 1e4) ? 0 : 1) : fmt;
  const axis = el('div', 'ci-axis');
  axis.append(el('span', null, tick(-scale)), el('span', null, 'no effect'), el('span', null, tick(scale)));
  return axis;
}

/** The effect's interval on the shared scale: a range bar, the point estimate, the no-effect line. */
export function intervalPlot(v, scale, fmt, confidenceLabel, { axis = true } = {}) {
  const e = v.effect;
  const pos = (x) => `${(50 + (Math.max(-scale, Math.min(scale, x)) / scale) * 50).toFixed(2)}%`;
  const plot = el('div', `ci-plot${v.outcome === 'better' ? ' ci-better' : v.outcome === 'worse' ? ' ci-worse' : ''}`);
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', `${v.variant}: ${confidenceLabel} interval ${fmt(e.lo)} to ${fmt(e.hi)}, estimate ${fmt(e.point)}; zero means no effect`);
  const track = el('div', 'ci-track');
  const range = el('div', 'ci-range');
  range.style.left = pos(e.lo);
  range.style.right = `calc(100% - ${pos(e.hi)})`;
  range.title = `${confidenceLabel} CI ${fmt(e.lo)} … ${fmt(e.hi)}`;
  const point = el('div', 'ci-point');
  point.style.left = pos(e.point);
  point.title = `estimate ${fmt(e.point)}`;
  track.append(el('div', 'ci-zero'), range, point);
  plot.append(track);
  if (axis) plot.append(intervalAxis(scale, e.unit, fmt));
  return plot;
}

export function renderExperiment(model) {
  const confidenceLabel = model.confidence !== null ? `${Math.round(model.confidence * 100)}%` : '';
  const split = model.split;
  setDescription(
    confidenceLabel ? badge(`${confidenceLabel} confidence`, 'outline') : null,
    model.alternative && model.alternative !== 'two_sided' ? badge(`one-sided · ${model.alternative}`, 'outline') : null,
    model.correction ? badge(`${correctionName(model.correction)} correction`, 'outline') : null,
    // an inverted metric says so up front: a green decrease must not read as a mistake
    model.good === 'down' ? badge('lower is better', 'outline', 'trending-down') : null,
    model.variants.some((v) => v.p_value_sequential !== null) ? badge('sequential · safe to peek', 'outline') : null,
    split && !split.detected ? badge(`split as designed · p ${formatP(split.p_value)}`, 'outline', 'circle-check') : null,
  );
  // the trust gate comes first: a split that is not the designed one invalidates every lift below
  if (split?.detected) {
    showAlert({
      title: 'Sample ratio mismatch — these results cannot be trusted',
      description: `The groups are not the split the test was designed for (p ${formatP(split.p_value)}), so randomization or logging is broken. Find the cause before reading any lift.`,
      variant: 'destructive',
      iconName: 'circle-alert',
    });
  }

  const isRate = model.metric === 'proportion';
  const valueFormat = isRate ? formatPercent : columnFormat(model.variants.flatMap((v) => [v.control_value, v.variant_value]));
  const ctx = {
    model,
    confidenceLabel,
    // under a sample ratio mismatch no verdict is given: the badge says why instead
    verdictBadge: (v) => {
      if (split?.detected) return badge('Untrusted · split mismatch', 'destructive', 'circle-alert');
      const verdict = VERDICTS[v.verdict];
      return badge(verdict.text, OUTCOME_VARIANT[v.outcome] || 'outline', verdict.icon);
    },
    isRate,
    value: (x) => (x === null ? '—' : valueFormat(x)),
    size: (n) => (n === null ? null : `${integerFormat.format(n)} users`),
    // the effect's own unit: a relative lift as a signed percent, an absolute one in points or units
    fmtOf: (e) => (e?.unit === 'relative' ? (x) => formatSignedPercent(x) : isRate ? formatPoints : formatSignedNumber),
    absolute: (lift) => (isRate ? formatPoints(lift) : formatSignedNumber(lift)),
    // the p-value shown is the adjusted one when a correction ran; the raw one only when it differs
    pCaption: (v) => {
      const rawDiffers = v.p_value_adjusted !== null && v.p_value !== null && formatP(v.p_value_adjusted) !== formatP(v.p_value);
      return v.p_value_adjusted !== null ? `${correctionName(model.correction)}-adjusted${rawDiffers ? ` · raw ${formatP(v.p_value)}` : ''}` : null;
    },
    // what an inconclusive result still says: how large an effect this sample could have seen, and
    // that an interval clearing zero lost its significance only to the multiplicity correction
    evidence: (v, fmt) => {
      if (v.significant) return null;
      if (v.significant_raw && model.correction) return `significant only before the ${correctionName(model.correction)} correction`;
      return v.detectable !== null ? `could detect ±${fmt(v.detectable).replace(/^[+−-]/, '')}` : null;
    },
  };

  cardsSection.className = 'ab-list';
  const node = model.variants.length > 1 ? experimentTable(ctx) : experimentCard(ctx, model.variants[0]);
  if (split?.detected) node.classList.add('ab-untrusted');
  cardsSection.append(node);
  cardsSection.hidden = false;
  showNotes(model.notes);
}

/** One variant against the control: the stat card. */
export function experimentCard({ model, confidenceLabel, verdictBadge, value, size, fmtOf, absolute, pCaption, evidence }, v) {
  const e = v.effect;
  const fmt = fmtOf(e);

  const headline = e ? fmt(e.point) : v.lift === null ? '—' : formatSignedNumber(v.lift);
  const subline = [
    v.lift !== null && e?.unit === 'relative' ? `${absolute(v.lift)} absolute` : null,
    e ? `${confidenceLabel} CI ${fmt(e.lo)} to ${fmt(e.hi)}` : null,
    evidence(v, fmt),
  ].filter(Boolean).join(' · ');

  const content = el('div', 'card-content');
  if (e) content.append(intervalPlot(v, model.scale, fmt, confidenceLabel));

  const p = v.p_value_adjusted ?? v.p_value;
  const stats = el('dl', 'stat-grid');
  stats.append(...[
    stat(model.control, value(v.control_value), size(v.n_control)),
    stat(v.variant, value(v.variant_value), size(v.n_variant)),
    p !== null ? stat('p-value', formatP(p), pCaption(v)) : null,
    v.p_value_sequential !== null ? stat('Always-valid p', formatP(v.p_value_sequential), 'safe to peek') : null,
    v.variance_reduction !== null ? stat('Variance cut', formatPercent(v.variance_reduction), 'CUPED') : null,
  ].filter(Boolean));

  const node = card({
    description: `${v.variant} vs ${model.control}`,
    title: headline,
    titleClass: 'card-title card-title-stat',
    subline,
    action: verdictBadge(v),
  }, e ? content : null, stats);
  node.classList.add('ab-card');
  return node;
}

/** A cell of the variants table: its figure, with an optional caption under it. */
export function abCell(area, main, ...captions) {
  const node = el('div', `ab-cell ab-${area}`);
  node.append(main instanceof Node ? main : el('span', 'ab-main', main));
  for (const c of captions) if (c) node.append(el('span', 'ab-caption', c));
  return node;
}

/** Several variants against one control: one card, a row per group, the intervals on one axis. */
export function experimentTable({ model, confidenceLabel, verdictBadge, value, size, fmtOf, absolute, pCaption, evidence }) {
  const k = model.variants.length;
  const withEffect = model.variants.filter((v) => v.effect);
  // one axis serves every row only when every interval is in the same unit
  const units = new Set(withEffect.map((v) => v.effect.unit));
  const sharedAxis = withEffect.length > 0 && units.size === 1;

  const table = el('div', 'ab-table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', `${k} variants against ${model.control}`);

  const head = el('div', 'ab-row ab-head');
  head.setAttribute('role', 'row');
  for (const [area, text] of [['group', 'Group'], ['value', model.metric_label], ['lift', 'Lift'], ['plot', `${confidenceLabel} interval`.trim()], ['result', 'Result']]) {
    const h = el('div', `ab-cell ab-${area}`, text);
    h.setAttribute('role', 'columnheader');
    head.append(h);
  }
  table.append(head);

  const row = (className, ...cells) => {
    const node = el('div', `ab-row ${className}`);
    node.setAttribute('role', 'row');
    for (const c of cells) c.setAttribute('role', 'cell');
    node.append(...cells);
    table.append(node);
  };

  // the control: the baseline every lift below is measured from
  const controlValue = model.variants.find((v) => v.control_value !== null)?.control_value ?? null;
  const nControl = model.variants[0]?.n_control ?? null;
  row('ab-control',
    abCell('group', model.control, size(nControl)),
    abCell('value', value(controlValue)),
    abCell('lift', el('span', 'ab-caption', 'baseline')),
    abCell('plot', el('span')),
    abCell('result', badge('Control', 'secondary')),
  );

  for (const v of model.variants) {
    const e = v.effect;
    const fmt = fmtOf(e);
    const p = v.p_value_adjusted ?? v.p_value;
    const lift = e ? fmt(e.point) : v.lift === null ? '—' : formatSignedNumber(v.lift);
    const plot = e ? intervalPlot(v, model.scale, fmt, confidenceLabel, { axis: !sharedAxis }) : el('span', 'ab-caption', 'no interval');
    row(`ab-variant${v.outcome === 'better' ? ' ab-better' : v.outcome === 'worse' ? ' ab-worse' : ''}`,
      abCell('group', v.variant, size(v.n_variant)),
      abCell('value', value(v.variant_value)),
      abCell('lift', lift, v.lift !== null && e?.unit === 'relative' ? `${absolute(v.lift)} absolute` : null),
      abCell('plot', plot, e ? `CI ${fmt(e.lo)} to ${fmt(e.hi)}` : null),
      abCell('result', verdictBadge(v),
        evidence(v, fmt),
        p !== null ? `p ${formatP(p)}${pCaption(v) ? ` · ${pCaption(v)}` : ''}` : null,
        v.p_value_sequential !== null ? `always-valid p ${formatP(v.p_value_sequential)}` : null,
        v.variance_reduction !== null ? `CUPED cut variance ${formatPercent(v.variance_reduction)}` : null),
    );
  }

  if (sharedAxis) {
    const foot = el('div', 'ab-row ab-foot');
    foot.setAttribute('aria-hidden', 'true');
    const e = withEffect[0].effect;
    foot.append(el('div', 'ab-cell ab-group'), el('div', 'ab-cell ab-value'), el('div', 'ab-cell ab-lift'), abCell('plot', intervalAxis(model.scale, e.unit, fmtOf(e))), el('div', 'ab-cell ab-result'));
    table.append(foot);
  }

  const content = el('div', 'card-content');
  content.append(table);
  // the verdict in one line, in the words of the rows: better, worse, inconclusive
  const count = (o) => model.variants.filter((v) => v.outcome === o).length;
  const verdictLine = [['better', 'better'], ['worse', 'worse'], ['no_difference', 'inconclusive']]
    .map(([o, word]) => [count(o), word]).filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(' · ');
  const node = card({
    description: `${k} variants vs ${model.control}`,
    title: model.split?.detected ? 'No verdict · the split is not the designed one' : verdictLine,
  }, content);
  node.classList.add('ab-card', 'ab-multi');
  return node;
}
//
// A card per funnel (one, or one per segment side by side on the same steps): the overall
// conversion along its main line as the headline, then the steps in order — each with its count,
// its share of the first step and a bar of that share. Between a step and its parent, the share of
// the parent it holds: "continued" for the next step of the line, "of <parent>" for an outcome,
// which sits under its parent; the continuation that lost the most is marked.
