// WHAT ONE PATH-ANALYSIS CARD SHOWS — the same code for the server (whether a result draws anything,
// src/retentioneering/index.js) and for the card (src/apps/retentioneering-view/): it takes what
// display_retentioneering_result returned and gives the card its model. Pure data shaping, no DOM,
// no numbers of its own: every value is one the analysis computed.

export const RETENTIONEERING_VIEW_URI = 'ui://betti/retentioneering-view.html';

/** Two names in code-point order — the same on every machine, whatever its locale (a locale-aware
 *  comparison orders mixed case and punctuation differently from one deployment to the next). */
export const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A distribution in the metric's OWN units. On a skewed continuous metric the library bins log10 of
 * the values (its `log_scale`), and its bin edges, mean and median are log10 numbers then — read as
 * they are, a duration of 300 s looked like 2.5. Here the edges and the median are put back (10^x: the
 * log is monotonic, so the median is the median), the mean of the logs is the GEOMETRIC mean, and the
 * scale is said. Without log_scale the values are as the library gave them.
 */
export function distributionInUnits(values) {
  if (values?.log_scale !== true) return values;
  const back = (x) => (typeof x === 'number' && Number.isFinite(x) ? 10 ** x : x);
  const out = { ...values, scale: 'log10' };
  for (const [name, v] of Object.entries(values)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.bins)) continue;
    const { mean, kde, ...rest } = v;
    out[name] = {
      ...rest, bins: v.bins.map(back), median: back(v.median),
      ...(mean !== undefined ? { geometric_mean: back(mean) } : {}),
      // the density is over log10 of the values: its x axis is put back too
      ...(Array.isArray(kde) && kde.length === 2 ? { kde: [kde[0].map(back), kde[1]] } : kde !== undefined ? { kde } : {}),
    };
  }
  // the distance between the groups is measured on the log10 values the library compared
  if (typeof values.distance === 'number') { delete out.distance; out.distance_log10 = values.distance; }
  return out;
}

/**
 * THE KINDS THAT HAVE A CARD — one table: a kind's title, whether its card is a chart of its own
 * (`charted`; a distribution is drawn as its histogram), how its card is built (`card`, from the
 * card's head, the result and what the drawing call carries), and for a diff that has a card, how
 * that one is built (`diff`) — the library's matrices as heatmaps, or, where `diffCharted`, in the
 * analysis's own shape (a funnel's: both groups on the same steps, and their difference). A kind not
 * in it has no card and is answered in words.
 */
const KINDS = {
  transition_graph: { title: 'Transition graph', charted: true, card: (head, r, at) => graph(head, r, at.weight, at.synthetic), diff: diffMatrices },
  step_matrix: { title: 'Step matrix', charted: true, card: (head, r, at) => stepMatrix(head, r, at.synthetic), diff: diffMatrices },
  step_sankey: { title: 'Step sankey', charted: true, card: stepSankey, diff: diffMatrices },
  funnel: { title: 'Funnel', charted: true, card: funnel, diff: funnelDiff, diffCharted: true },
  cluster_analysis: { title: 'Path clusters', charted: true, card: overview },
  segment_overview: { title: 'Segment overview', charted: true, card: overview },
  metric_distribution: { card: distribution },
};
const kindsWhere = (test) => Object.keys(KINDS).filter((k) => test(KINDS[k]));
/** The analyses the card draws as a chart of their own. */
export const CHARTED_KINDS = kindsWhere((k) => k.charted);
/** Which analyses have a card: the charted ones and a distribution (its histogram). */
export const CARD_KINDS = Object.keys(KINDS);
/** Which diffs have a card. */
export const DIFF_CARD_KINDS = kindsWhere((k) => k.diff);
/** The kinds whose diff keeps the analysis's own shape: the query spec tells the analysis step so
 *  (`diff_charted`), which then runs it — and its pre-run check — through the charted function. */
export const CHARTED_DIFF_KINDS = kindsWhere((k) => k.diffCharted);

/** How a stored result holds its diff: 'charted' (the analysis's own shape), 'tables' (the library's
 *  tables), or false for no diff. */
export const diffForm = (r) => (r?.diff ? (r.diff_charted ? 'charted' : 'tables') : false);

/** Whether an analysis of this kind has a card — decided by kind, and for a diff by the form the
 *  card of that kind reads (a diff stored in another form has none). */
export function hasCard(kind, diff = false) {
  if (!diff) return CARD_KINDS.includes(kind);
  return DIFF_CARD_KINDS.includes(kind) && (diff === 'charted') === CHARTED_DIFF_KINDS.includes(kind);
}

/** How each transition weight reads: a count, a share of 0..1, a plain number, or a duration in seconds. */
export const WEIGHT_UNITS = {
  count: 'count', unique_paths: 'count', share_of_total: 'share', avg_per_path: 'number',
  proba_in: 'share', proba_out: 'share', time_median: 'duration', time_q95: 'duration',
};
export const WEIGHT_LABELS = {
  count: 'Transitions', unique_paths: 'Paths', share_of_total: 'Share of all transitions', avg_per_path: 'Per path',
  proba_in: 'Share of the target\'s arrivals', proba_out: 'Share of the source\'s departures', time_median: 'Median time', time_q95: 'Time, 95th percentile',
};
/** A title for any analysis: its own, else its kind in words. */
const titleOf = (kind) => (Object.hasOwn(KINDS, kind) && KINDS[kind].title) || (kind.charAt(0).toUpperCase() + kind.slice(1)).replace(/_/g, ' ');
/** How the library's synthetic events read on a card: where a path begins, and where it has ended.
 *  Which events ARE synthetic is the library's word: the server draws a card with the facts sheet's
 *  `synthetic_events` (this page does not carry the sheet); a card drawn before it did falls back to
 *  the events these labels name, which test/unit/retentioneering-feature.test.js holds to the sheet. */
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
  if (r.error) return none('error');
  // analysis_kind stays the analysis's own kind where the card's kind is a shape of its (a diff, a distribution)
  const synthetic = new Set(Array.isArray(drawn.synthetic_events) ? drawn.synthetic_events : Object.keys(START_END));
  const head = { kind: r.kind, analysis_kind: r.kind, title: titleOf(r.kind), analysis: drawn.analysis, eventstream: drawn.eventstream || null, scope: isObj(drawn.scope) ? drawn.scope : null, paths: Number.isFinite(r.paths) ? r.paths : null };
  // a card per KIND (hasCard): any other analysis has none and is answered in words; a kind with a
  // card whose result holds nothing to draw is `empty`
  if (!hasCard(r.kind, diffForm(r))) return none('no_card');
  const kind = KINDS[r.kind];
  if (r.diff) return kind.diff(head, r);
  return kind.card(head, r, { weight: args.edge_weight || drawn.edge_weight, synthetic });
}

/** A library name as a reader reads it: "paths_with_start" → "Paths with start", "path_stats.user_id"
 *  → "Path stats · user_id" (the part after a dot is a name of the data, kept as it is). */
export function humanize(name) {
  const [head, ...rest] = String(name).split('.');
  const words = head.replace(/_/g, ' ').trim();
  return [words.charAt(0).toUpperCase() + words.slice(1), ...rest].join(' · ');
}

const NUMERIC = new Set(['integer', 'number', 'duration']);

/** Bin edges and what each bin holds, read by their shape: an increasing list of k+1 numbers and lists of k. */
function histogramOf(items) {
  const lists = items.filter((it) => Array.isArray(it.value) && it.value.length > 1 && it.value.every((x) => typeof x === 'number'));
  const edges = lists.find((e) => e.value.every((x, i) => i === 0 || x >= e.value[i - 1]) && lists.some((o) => o.value.length === e.value.length - 1));
  if (!edges) return null;
  const series = lists.filter((o) => o.value.length === edges.value.length - 1);
  return { edges: edges.value, series: series.map((o) => ({ label: o.label, values: o.value })), used: new Set([edges, ...series]) };
}

/** A value the card lists as a key figure: one number, flag or word (not a list, not a group). */
const scalar = (v) => v !== null && v !== undefined && typeof v !== 'object';
/** A value's kind as the analysis step read it from the data's type (a duration, a moment, a flag…). */
const kindOf = (v, kind) => (typeof kind === 'string' ? kind : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text');

/** metric_distribution: each group's bins as bars — two groups on the same bins in one chart — with
 *  the groups' own figures (mean, median) and the distance between them under it. */
function distribution(head, r) {
  // in the metric's own units, the scale said in each title (a log10 binning made 300 s read as 2.5)
  const values = distributionInUnits(r.values || {});
  const scaleNote = values.scale === 'log10' ? ' · log scale' : '';
  const groups = Object.entries(values).filter(([, v]) => isObj(v)).map(([name, v]) => {
    const kinds = isObj(r.value_kinds?.[name]) ? r.value_kinds[name] : {};
    const items = Object.entries(v).map(([k, x]) => ({ label: humanize(k), value: x, kind: kindOf(x, kinds[k]) }));
    const h = histogramOf(items);
    return h && { title: `${humanize(name)}${scaleNote}`, edges: h.edges, series: h.series, items: items.filter((it) => scalar(it.value) && !h.used.has(it)) };
  }).filter(Boolean);
  if (!groups.length) return none('empty');
  const loose = Object.entries(values).filter(([k, v]) => scalar(v) && k !== 'log_scale' && k !== 'scale').map(([name, value]) => ({ label: humanize(name), value, kind: kindOf(value, r.value_kinds?.[name]) }));
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
  histograms[0].items = [...histograms[0].items, ...loose];
  return { ...head, kind: 'distribution', histograms };
}

/** A diff (of a transition graph, a step matrix or a step sankey): the difference and the two groups
 *  as heatmaps — each part by the role the analysis step gave it, block by block around an anchor —
 *  each shaded on its own scale, the difference one hue above zero and another below. */
function diffMatrices(head, r) {
  const tables = (r.tables || []).filter((t) => t.role && t.columns?.length).map((t) => {
    const kinds = t.columns.map((_, j) => t.kinds?.[j] || (t.rows.length > 0 && t.rows.every((row) => row[j] == null || typeof row[j] === 'number') ? 'number' : 'text'));
    const numeric = kinds.map((k) => NUMERIC.has(k));
    const scale = Math.max(0, ...numeric.flatMap((n, j) => (n ? t.rows.map((row) => row[j]).filter((v) => typeof v === 'number').map(Math.abs) : [])));
    return { name: t.name, title: humanize(t.name), role: t.role, block: t.block ?? null, columns: t.columns, headers: t.columns.map(humanize), kinds, numeric, rows: t.rows, diverging: t.role === 'diff', scale };
  });
  if (!tables.length) return none('empty');
  return { ...head, kind: 'diff', title: `${head.title} — difference between two groups`, tables };
}

function graph(head, r, weight, synthetic) {
  const edges = (r.edges || []).filter((e) => e.count > 0);
  if (!edges.length) return none('empty');
  const weights = Object.keys(WEIGHT_UNITS).filter((w) => edges.some((e) => e[w] != null));
  return {
    ...head,
    nodes: (r.nodes || []).map((n) => ({ event: n.event, label: START_END[n.event] || n.event, count: n.count, x: n.x ?? null, y: n.y ?? null, synthetic: synthetic.has(n.event) })),
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
    .sort(([a, x], [b, y]) => (b === 'path_start') - (a === 'path_start') || (a === 'path_end') - (b === 'path_end') || x.step - y.step || y.share - x.share || byText(a, b))
    .map(([e]) => e);
}

function stepMatrix(head, r, synthetic) {
  const blocks = (r.blocks || []).filter((b) => b.cells?.length).map((b) => {
    const events = eventOrder(b.cells, b.steps);
    const at = new Map(b.cells.map((c) => [`${c.event}\u0000${c.step}`, c.share]));
    return { steps: b.steps, rows: events.map((e) => ({ event: e, label: STEP_START_END[e] || e, synthetic: synthetic.has(e), values: b.steps.map((s) => at.get(`${e}\u0000${s}`) ?? 0) })) };
  });
  return blocks.length ? { ...head, blocks } : none('empty');
}

function stepSankey(head, r) {
  const blocks = (r.blocks || []).filter((b) => b.cells?.length).map((b) => ({
    steps: b.steps,
    // within a step the events by share, the ended paths at the bottom — drop-off in one place
    columns: b.steps.map((s) => b.cells.filter((c) => c.step === s).sort((x, y) => (x.event === 'path_end') - (y.event === 'path_end') || y.share - x.share || byText(x.event, y.event)).map((c) => ({ event: c.event, label: STEP_START_END[c.event] || c.event, share: c.share }))),
    links: (b.links || []).filter((l) => l.share > 0),
  }));
  return blocks.length ? { ...head, blocks } : none('empty');
}

function funnel(head, r) {
  const steps = (r.steps || []).map((s) => ({ label: s.step, value: s.unique_paths, of_first: s.conversion_rate, of_previous: s.step_conversion_rate }));
  if (!steps.length) return none('empty');
  let biggest = null;
  steps.forEach((s, i) => { if (i > 0 && (biggest === null || s.of_previous < steps[biggest].of_previous)) biggest = i; });
  return { ...head, steps, biggest_drop: biggest };
}

/** A funnel's diff: each step with both groups (paths, share of all, share of the previous step) and
 *  their difference as the library computed it (first minus second); the step where the share that
 *  continues differs most is marked. */
function funnelDiff(head, r) {
  const side = (s, p) => ({ value: s[`${p}_unique_paths`], of_first: s[`${p}_conversion_rate`], of_previous: s[`${p}_step_conversion_rate`] });
  const steps = (r.steps || []).filter((s) => s.funnel1_unique_paths != null && s.funnel2_unique_paths != null).map((s) => ({
    label: s.step, first: side(s, 'funnel1'), second: side(s, 'funnel2'),
    delta: { value: s.delta_unique_paths, of_first: s.delta_conversion_rate, of_previous: s.delta_step_conversion_rate },
  }));
  if (!steps.length) return none('empty');
  let widest = null;
  steps.forEach((s, i) => { if (i > 0 && Number.isFinite(s.delta.of_previous) && (widest === null || Math.abs(s.delta.of_previous) > Math.abs(steps[widest].delta.of_previous))) widest = i; });
  const g = r.diff_groups || {};
  const named = (v) => (v === '<REST>' ? 'the other levels' : v === '<MISSING>' ? 'no level' : v);
  return {
    ...head, kind: 'funnel_diff', title: `${head.title} — two groups`,
    groups: { segment: g.segment ?? null, first: named(g.first ?? 'Group 1'), second: named(g.second ?? 'Group 2') },
    steps, widest_gap: widest,
  };
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
