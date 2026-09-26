// WHAT ONE PATH-ANALYSIS CARD SHOWS — the same code for the server (whether a result draws anything,
// src/retentioneering/index.js) and for the card (src/apps/retentioneering-view/): it takes what
// display_retentioneering_result returned and gives the card its model. Pure data shaping, no DOM,
// no numbers of its own: every value is one the analysis computed.

import { CARD_MIN } from '../apps/result-view-model.js';

export const RETENTIONEERING_VIEW_URI = 'ui://betti/retentioneering-view.html';

/** How each transition weight reads: a count, a share of 0..1, a plain number, or a duration in seconds. */
export const WEIGHT_UNITS = {
  count: 'count', unique_paths: 'count', share_of_total: 'share', avg_per_path: 'number',
  proba_in: 'share', proba_out: 'share', time_median: 'duration', time_q95: 'duration',
};
export const WEIGHT_LABELS = {
  count: 'Transitions', unique_paths: 'Paths', share_of_total: 'Share of all transitions', avg_per_path: 'Per path',
  proba_in: 'Share of the target\'s arrivals', proba_out: 'Share of the source\'s departures', time_median: 'Median time', time_q95: 'Time, 95th percentile',
};
const TITLES = {
  transition_graph: 'Transition graph', step_matrix: 'Step matrix', step_sankey: 'Step sankey',
  funnel: 'Funnel', cluster_analysis: 'Path clusters', segment_overview: 'Segment overview',
};
/** A title for any analysis: its own, else its kind in words. */
const titleOf = (kind) => TITLES[kind] || (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/_/g, ' ');
const SYNTHETIC = new Set(['path_start', 'path_end']);
/** How the library's synthetic events read on a card: where a path begins, and where it has ended. */
const START_END = { path_start: 'Path start', path_end: 'Path end' };
const STEP_START_END = { path_start: 'Path start', path_end: 'Ended' };
/** retentioneering's own default for the graph: each event keeps its strongest few exits (plus every
 *  event's strongest arrival), so the first view is a map, not a hairball. */
export const DEFAULT_EDGES_PER_EVENT = 3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const none = (reason) => ({ kind: 'none', reason });

export function retentioneeringViewModel(drawn, args = {}) {
  if (!isObj(drawn) || drawn.ok === false) return none('error');
  const r = drawn.result;
  if (!isObj(r) || typeof r.kind !== 'string') return none('empty');
  const head = { kind: r.kind, title: titleOf(r.kind), analysis: drawn.analysis, eventstream: drawn.eventstream || null, scope: isObj(drawn.scope) ? drawn.scope : null, paths: Number.isFinite(r.paths) ? r.paths : null };
  // the charted analyses in their own chart; any other result (and any diff) as the tables it returned
  if (r.kind === 'transition_graph' && r.edges) return graph(head, r, args.edge_weight || drawn.edge_weight);
  if (r.kind === 'step_matrix' && r.blocks) return stepMatrix(head, r);
  if (r.kind === 'step_sankey' && r.blocks) return stepSankey(head, r);
  if (r.kind === 'funnel' && r.steps) return funnel(head, r);
  if (r.levels) return overview(head, r);
  return tables(head, r);
}

/** A library name as a reader reads it: "paths_with_start" → "Paths with start", "path_stats.user_id"
 *  → "Path stats · user_id" (the part after a dot is a name of the data, kept as it is). */
export function humanize(name) {
  const [head, ...rest] = String(name).split('.');
  const words = head.replace(/_/g, ' ').trim();
  return [words.charAt(0).toUpperCase() + words.slice(1), ...rest].join(' · ');
}

const NUMERIC = new Set(['integer', 'number', 'duration']);

/** A histogram inside a group of values, recognised by its shape: an increasing list of k+1 numbers
 *  (the bin edges) and lists of k numbers (what each bin holds). */
function histogramOf(items) {
  const lists = items.filter((it) => Array.isArray(it.value) && it.value.length > 1 && it.value.every((x) => typeof x === 'number'));
  const edges = lists.find((e) => e.value.every((x, i) => i === 0 || x >= e.value[i - 1]) && lists.some((o) => o.value.length === e.value.length - 1));
  if (!edges) return null;
  const series = lists.filter((o) => o.value.length === edges.value.length - 1);
  return { edges: edges.value, series: series.map((o) => ({ label: o.label, values: o.value })), used: new Set([edges, ...series]) };
}

/**
 * The tables and values of a result — drawn only where they have a visual shape (a card is not made
 * for its own sake):
 *   matrix     the tables of a diff (`diff` — two groups' difference — and the two groups it is taken
 *              from): heatmaps on one scale per table, the difference a diverging one
 *   histogram  bin edges and what each bin holds (two groups on the same bins: one comparison),
 *              with the group's other values as key figures under it
 * Anything else — a table of numbers, a record, a summary — is `none('text')`: the model reads it
 * in the result and answers in words. Every kind (a duration, a moment, a number) is the one the
 * analysis step read from the data's types.
 */
function tables(head, r) {
  const hasDiff = (r.tables || []).some((t) => t.name === 'diff');
  const list = hasDiff ? (r.tables || []).filter((t) => t.columns?.length).map((t) => {
    const kinds = t.columns.map((_, j) => t.kinds?.[j] || (t.rows.length > 0 && t.rows.every((row) => row[j] == null || typeof row[j] === 'number') ? 'number' : 'text'));
    const numeric = kinds.map((k) => NUMERIC.has(k));
    // the largest magnitude a cell's shading is measured against: the whole matrix
    const scale = Math.max(0, ...numeric.flatMap((n, j) => (n ? t.rows.map((row) => row[j]).filter((v) => typeof v === 'number').map(Math.abs) : [])));
    return { name: t.name, title: humanize(t.name), columns: t.columns, headers: t.columns.map(humanize), kinds, numeric, rows: t.rows, diverging: t.name === 'diff', scale };
  }) : [];
  const groups = [];
  // a number standing alone (the distance between two distributions) goes under the histogram
  const loose = Object.entries(r.values || {}).filter(([, v]) => typeof v === 'number')
    .map(([name, value]) => ({ label: humanize(name), value, kind: typeof r.value_kinds?.[name] === 'string' ? r.value_kinds[name] : typeof value === 'number' ? 'number' : 'text' }));
  for (const [name, value] of Object.entries(r.values || {})) {
    if (!isObj(value)) continue;
    const kind = r.value_kinds?.[name];
    const items = [];
    const walk = (prefix, v, k) => {
      if (isObj(v)) Object.entries(v).forEach(([key, x]) => walk(prefix ? `${prefix} · ${humanize(key)}` : humanize(key), x, isObj(k) ? k[key] : undefined));
      else items.push({ label: prefix, value: v, kind: typeof k === 'string' ? k : typeof v === 'number' ? 'number' : 'text' });
    };
    walk('', value, kind);
    const histogram = histogramOf(items);
    if (histogram) groups.push({ title: humanize(name), items: items.filter((it) => it.value != null && !histogram.used.has(it) && !Array.isArray(it.value)), edges: histogram.edges, series: histogram.series });
  }
  if (!list.length && !groups.length) return none('text');
  // histograms that share their bins are one comparison: drawn together, their figures under it
  const shared = groups.length > 1 && groups.every((g) => JSON.stringify(g.edges) === JSON.stringify(groups[0].edges));
  const histograms = shared
    ? [{
      title: groups.map((g) => g.title).join(' vs '),
      edges: groups[0].edges,
      measure: groups[0].series[0].label,
      series: groups.map((g) => ({ label: g.title, values: g.series[0].values })),
      items: groups.flatMap((g) => g.items.map((it) => ({ ...it, label: `${g.title} · ${it.label}` }))),
    }]
    : groups.map((g) => ({ title: g.title, edges: g.edges, measure: g.series[0].label, series: g.series.slice(0, 1), items: g.items }));
  if (histograms.length) histograms[0].items = [...histograms[0].items, ...loose];
  return {
    ...head, kind: 'tables', title: hasDiff ? `${head.title} — difference between two groups` : head.title, analysis_kind: r.kind, diff: hasDiff,
    tables: list, histograms,
  };
}

function graph(head, r, weight) {
  const edges = (r.edges || []).filter((e) => e.count > 0);
  if (!edges.length) return none('empty');
  const weights = Object.keys(WEIGHT_UNITS).filter((w) => edges.some((e) => e[w] != null));
  return {
    ...head,
    nodes: (r.nodes || []).map((n) => ({ event: n.event, label: START_END[n.event] || n.event, count: n.count, x: n.x ?? null, y: n.y ?? null, synthetic: SYNTHETIC.has(n.event) })),
    edges,
    weights,
    weight: weights.includes(weight) ? weight : weights.includes('proba_out') ? 'proba_out' : weights[0],
    units: WEIGHT_UNITS,
    labels: WEIGHT_LABELS,
    per_event: DEFAULT_EDGES_PER_EVENT,
  };
}

/** The events of a block in reading order: by the step each one peaks at, then by that share. */
function eventOrder(cells, steps) {
  const peak = new Map();
  for (const c of cells) {
    const p = peak.get(c.event);
    if (!p || c.share > p.share) peak.set(c.event, { step: steps.indexOf(c.step), share: c.share });
  }
  return [...peak.entries()]
    // path_start first and path_end last, the events between them by where they peak
    .sort(([a, x], [b, y]) => (b === 'path_start') - (a === 'path_start') || (a === 'path_end') - (b === 'path_end') || x.step - y.step || y.share - x.share || a.localeCompare(b))
    .map(([e]) => e);
}

function stepMatrix(head, r) {
  const blocks = (r.blocks || []).filter((b) => b.cells?.length).map((b) => {
    const events = eventOrder(b.cells, b.steps);
    const at = new Map(b.cells.map((c) => [`${c.event}\u0000${c.step}`, c.share]));
    return { steps: b.steps, rows: events.map((e) => ({ event: e, label: STEP_START_END[e] || e, synthetic: SYNTHETIC.has(e), values: b.steps.map((s) => at.get(`${e}\u0000${s}`) ?? 0) })) };
  });
  return blocks.length ? { ...head, blocks } : none('empty');
}

function stepSankey(head, r) {
  const blocks = (r.blocks || []).filter((b) => b.cells?.length).map((b) => ({
    steps: b.steps,
    // within a step the events by share, the ended paths at the bottom — drop-off in one place
    columns: b.steps.map((s) => b.cells.filter((c) => c.step === s).sort((x, y) => (x.event === 'path_end') - (y.event === 'path_end') || y.share - x.share || x.event.localeCompare(y.event)).map((c) => ({ event: c.event, label: STEP_START_END[c.event] || c.event, share: c.share }))),
    links: (b.links || []).filter((l) => l.share > 0),
  }));
  return blocks.length ? { ...head, blocks } : none('empty');
}

function funnel(head, r) {
  const steps = (r.steps || []).map((s) => ({ label: s.step, value: s.unique_paths, of_first: s.conversion_rate, of_previous: s.step_conversion_rate }));
  if (!steps.length) return none('empty');
  // one or two steps are a conversion a sentence states — the same threshold as the result view's funnel
  if (steps.length < CARD_MIN.steps) return none('text');
  let biggest = null;
  steps.forEach((s, i) => { if (i > 0 && (biggest === null || s.of_previous < steps[biggest].of_previous)) biggest = i; });
  return { ...head, steps, biggest_drop: biggest };
}

function overview(head, r) {
  if (!r.levels?.length) return none('empty');
  const size = r.metrics.find((m) => m.metric === 'segment_size');
  const share = r.metrics.find((m) => m.metric === 'segment_share');
  // the metrics that tell the groups apart most come first: the spread across the groups, relative to
  // the metric's own scale (a share moves in 0..1, a duration in seconds)
  const spread = (m) => {
    const v = m.values.filter((x) => x != null);
    if (v.length < 2) return 0;
    const hi = Math.max(...v); const lo = Math.min(...v);
    return (hi - lo) / (Math.max(Math.abs(hi), Math.abs(lo)) || 1);
  };
  const clusters = r.kind === 'cluster_analysis';
  return {
    ...head,
    levels: r.levels.map((l, i) => ({ name: l, label: clusters ? `Cluster ${i + 1}` : l, size: size?.values[i] ?? null, share: share?.values[i] ?? null })),
    metrics: r.metrics.filter((m) => m !== size && m !== share).map((m, i) => ({ ...m, spread: spread(m), order: i })).sort((a, b) => b.spread - a.spread || a.order - b.order),
    ...(r.silhouette ? { silhouette: r.silhouette } : {}),
    ...(r.best_params ? { best_params: r.best_params } : {}),
  };
}
