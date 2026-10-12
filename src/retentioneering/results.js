// THE RESULT OF A QUERY CALL — the long table the analysis model wrote (analysis, kind, part, seq,
// payload), read back into one structured result per analysis: the charted analyses in their own
// shape, and whatever else the library returned (any other analysis, a diff, the per-path cluster
// labels) as its tables and values. A card, for an analysis that has one, draws all of it; a read
// (readView) PAGES it, as every query tool pages a result: each table of the analysis — its own (the
// transitions, the shares step by step, the groups' metrics…) in the order that answers (the biggest
// first), and the library's in its own order — by its row numbers, with what the analysis computes
// beyond rows (each group's profile, a distribution's figures) beside them.

import { byText, distributionInUnits, metricSpread, WEIGHT_UNITS } from './view-model.js';
import { retentioneeringFacts } from './schema.js';
import { pageBlock } from '../engine/helpers.js';
import { READ_PAGE } from '../schema/fields.js';
/** How many of the metrics a group stands out on most its profile names. */
const TOP_PROFILE = 6;

/** rows → { <analysis id>: { kind, ...data } }, in the order the analyses were asked for. `from`: the row
 *  number the read's table rows start at (a page read from the stored table), 0 for a read from the first. */
export function parseResultRows(rows, order = [], { from = 0 } = {}) {
  const by = new Map();
  for (const r of rows) {
    const id = String(r.analysis);
    if (!by.has(id)) by.set(id, { kind: String(r.kind), parts: {} });
    const a = by.get(id);
    (a.parts[r.part] ||= []).push({ seq: Number(r.seq), ...JSON.parse(r.payload) });
  }
  for (const a of by.values()) for (const list of Object.values(a.parts)) list.sort((x, y) => x.seq - y.seq);
  const ids = [...order.filter((id) => by.has(id)), ...[...by.keys()].filter((id) => !order.includes(id))];
  return Object.fromEntries(ids.map((id) => {
    const a = by.get(id);
    return [id, { ...shape(a, from), ...(a.parts.scope?.length ? { paths: a.parts.scope[0].paths } : {}) }];
  }));
}

const strip = ({ seq: _seq, ...rest }) => rest;

/**
 * A metric row as a reader wants it — from what the analysis step carried for it (the metric, the
 * event it is about, the roll-up; python/retentioneering_model.py), never read back out of its name:
 * "share with shop_opened", "length", "duration · median", and how its value reads (a duration in
 * seconds, a share of paths, a number).
 */
export function describeMetric(name, meta) {
  if (name === 'segment_size') return { label: 'paths', format: 'number' };
  if (name === 'segment_share') return { label: 'share of paths', format: 'share' };
  if (!meta) return { label: name, format: 'number' };
  const { base, event, agg } = meta;
  const isShare = base.startsWith('has_') || base === 'matches_pattern' || base.startsWith('in_segment');
  const isTime = base === 'duration' || base === 'time_between';
  const what = base.startsWith('has_event') && event ? `share with ${event}` : base.startsWith('event_count') && event ? `${event} per path` : event ? `${base.replace(/_/g, ' ')} · ${event}` : base.replace(/_/g, ' ');
  return { label: agg && agg !== 'mean' ? `${what} · ${agg}` : what, format: isShare && (!agg || agg === 'mean') ? 'share' : isTime ? 'duration' : 'number' };
}

/** The tables and values of any result, each under the name the library gave it — a table's rows those
 *  read, from row number `from` on. */
function generic(parts, from = 0) {
  const rows = new Map();
  for (const r of parts.row || []) {
    if (!rows.has(r.table)) rows.set(r.table, []);
    rows.get(r.table).push(JSON.parse(r.values));
  }
  // each column's and value's kind (a duration, a moment, a number…) as the analysis step read it from
  // the data's own types, so the card formats it without guessing from a name
  // how many rows a table has (the analysis step counts them), which a read that kept some of its rows says
  const tables = (parts.table || []).map((t) => {
    const held = rows.get(t.table) || [];
    const total = t.rows != null ? Number(t.rows) : from + held.length;
    return {
      name: t.table, columns: JSON.parse(t.columns), ...(t.kinds ? { kinds: JSON.parse(t.kinds) } : {}),
      ...(t.role ? { role: t.role } : {}), ...(t.block != null ? { block: t.block } : {}), rows: held,
      ...(from ? { from_row: from } : {}), total_rows: total, ...(from || held.length < total ? { truncated: true } : {}),
    };
  });
  const values = Object.fromEntries((parts.value || []).map((v) => [v.name, JSON.parse(v.value)]));
  const kinds = Object.fromEntries((parts.value || []).filter((v) => v.kinds).map((v) => [v.name, JSON.parse(v.kinds)]));
  return { ...(tables.length ? { tables } : {}), ...(Object.keys(values).length ? { values } : {}), ...(Object.keys(kinds).length ? { value_kinds: kinds } : {}) };
}

function shape({ kind, parts }, from = 0) {
  // an analysis the library raised on is its error alone: the others of the call keep their results
  if (parts.error?.length) return { kind, error: { type: parts.error[0].type, message: parts.error[0].message } };
  // a diff says so: the analysis step marks it, with its two groups and the form it stored it in — the
  // analysis's own shape (diff_charted) or the library's tables
  const d = parts.diff?.[0];
  const groups = d?.groups ? JSON.parse(d.groups) : null;
  return { kind, ...(d ? { diff: true, ...(d.charted ? { diff_charted: true } : {}), ...(groups ? { diff_groups: groups } : {}) } : {}), ...charted(kind, parts), ...generic(parts, from) };
}

/** The charted analyses' own shape — present when the analysis step wrote it: for an analysis, and
 *  for a diff stored in its analysis's shape (diff_charted). */
function charted(kind, parts) {
  if (kind === 'transition_graph' && parts.edge) {
    const layout = Object.fromEntries((parts.layout || []).map((p) => [p.event, { x: p.x, y: p.y }]));
    return {
      nodes: (parts.node || []).map((n) => ({ event: n.event, count: n.count, ...(layout[n.event] || {}) })),
      edges: (parts.edge || []).map(strip),
    };
  }
  if ((kind === 'step_matrix' || kind === 'step_sankey') && parts.block) {
    return {
      blocks: (parts.block || []).map((b) => ({
        block: b.block,
        steps: JSON.parse(b.steps),
        cells: (parts.cell || []).filter((c) => c.block === b.block).map(({ seq: _s, block: _b, ...c }) => c),
        ...(parts.link ? { links: parts.link.filter((l) => l.block === b.block).map(({ seq: _s, block: _b, ...l }) => l) } : {}),
      })),
    };
  }
  if (kind === 'funnel' && parts.step) return { steps: parts.step.map(strip) };
  if ((kind === 'cluster_analysis' || kind === 'segment_overview') && parts.overview) {
    const levelKey = kind === 'cluster_analysis' ? 'cluster' : 'level';
    const levels = [...new Set((parts.overview || []).map((o) => o[levelKey]))];
    const metrics = [...new Set((parts.overview || []).map((o) => o.metric))];
    const value = new Map((parts.overview || []).map((o) => [`${o.metric}\u0000${o[levelKey]}`, o.value]));
    const meta = new Map((parts.metric || []).map((m) => [m.metric, m]));
    return {
      levels,
      metrics: metrics.map((m) => ({ metric: m, ...describeMetric(m, meta.get(m)), values: levels.map((l) => value.get(`${m}\u0000${l}`) ?? null) })),
      ...(parts.params?.length ? { best_params: JSON.parse(parts.params[0].params) } : {}),
      ...(parts.silhouette?.length ? { silhouette: parts.silhouette.map((s) => ({ params: JSON.parse(s.params), score: s.score, best: !!s.best })) } : {}),
    };
  }
  return {};
}

const round = (x, digits = 4) => (typeof x === 'number' ? Number(x.toFixed(digits)) : x);

/**
 * WHAT A READ HANDS THE MODEL OF ONE ANALYSIS — a page of each of its tables, `limit` rows from row
 * `offset` (READ_PAGE unless the read says), each with its page (pageBlock, the one page shape of every
 * query tool): the analysis's own tables first, in the order that answers — the transitions and the
 * events by count, the shares step by step by the event's peak, the flows by share, a funnel's steps in
 * order, the groups' metrics by how far they tell the groups apart — then the library's in its own order.
 * Beside them, what the analysis computes beyond rows, whole: each group's size, share and profile (the
 * metrics it stands out on most), a clustering's parameters and silhouettes, a distribution's figures in
 * the metric's units, how many paths it read, a diff's groups. The numbers are rounded to 4 decimals.
 */
export function readView(result, { offset = 0, limit = READ_PAGE } = {}) {
  const { kind } = result;
  if (result.error) return { kind, error: result.error };
  const at = { offset, limit };
  const { tables: own = [], ...computed } = (OWN[kind] && OWN[kind](result, at)) || {};
  const tables = [...own, ...libraryTables(result, at)];
  // a list among the values (every path's label, say) is paged like a table's rows — whole on the first
  // page when it fits, no items past its end (pagedValues); a distribution's values are its figures, whole
  const values = computed.values === undefined && result.values ? pagedValues(result.values, at) : undefined;
  return {
    kind,
    ...(result.diff ? { diff: true, ...(result.diff_groups ? { groups: result.diff_groups } : {}) } : {}),
    ...(Number.isFinite(result.paths) ? { paths: result.paths } : {}),
    ...computed,
    ...(tables.length ? { tables } : {}),
    ...(values ? { values } : {}),
  };
}

/** One table of a read: the page of `rows` (every row of the table in its order, or — `from` — the rows
 *  held from that row number on, of `total`) from row `offset`, `limit` of them. */
function pageOf(name, columns, rows, { offset, limit }, { from = 0, total = from + rows.length, ...extra } = {}) {
  const start = Math.max(offset - from, 0);
  const held = rows.slice(start, start + limit);
  return { name, columns, ...extra, rows: held, page: pageBlock({ offset, limit, returned: held.length, has_more: offset + held.length < total, total }) };
}

/** A transition's columns in a read: who to whom, then every weight the analysis computes — the facts
 *  sheet's edge_weights, in its order — a duration's in seconds (WEIGHT_UNITS, the card's reading of each). */
const transitionTable = (r, at) => {
  const weights = retentioneeringFacts().edge_weights;
  const seconds = (w) => WEIGHT_UNITS[w] === 'duration';
  return pageOf('transitions', ['from', 'to', ...weights.map((w) => (seconds(w) ? `${w}_s` : w))], [...r.edges].sort((a, b) => b.count - a.count || byText(a.source, b.source) || byText(a.target, b.target))
    .map((e) => [e.source, e.target, ...weights.map((w) => round(e[w] ?? null, seconds(w) ? 1 : 4))]), at);
};

/** Each charted kind's own tables and what it computes beyond them — present when the result holds the
 *  kind's own shape (a diff stored in the library's tables has only those). */
const OWN = {
  transition_graph: (r, at) => r.edges && {
    tables: [
      transitionTable(r, at),
      pageOf('events', ['event', 'count'], [...(r.nodes || [])].sort((a, b) => b.count - a.count || byText(a.event, b.event)).map((n) => [n.event, n.count]), at),
    ],
  },
  step_matrix: (r, at) => r.blocks && { tables: stepTables(r, at) },
  step_sankey: (r, at) => r.blocks && { tables: stepTables(r, at) },
  funnel: (r, at) => r.steps && { tables: [funnelTable(r, at)] },
  cluster_analysis: (r, at) => r.levels && groups(r, at, 'clusters'),
  segment_overview: (r, at) => r.levels && groups(r, at, 'levels'),
  // each group's bins and counts with its figures, in the metric's own units — the density curve (a
  // thousand points a group) is the card's to draw, not a number to read
  metric_distribution: (r) => {
    if (!r.values) return null;
    const values = distributionInUnits(r.values);
    const lean = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.bins)
      ? Object.fromEntries(Object.entries(v).filter(([f]) => f !== 'kde').map(([f, x]) => [f, Array.isArray(x) ? x.map((n) => round(n)) : round(x)]))
      : v]));
    return { values: lean, ...(values.scale ? { scale_note: 'the library binned log10 of the values (a skewed metric); bins and median are put back into the metric\'s units, the mean of the logs is the geometric mean, and the distance is on the log10 values' } : {}) };
  },
};

/**
 * A step matrix's (a sankey's) shares as a table per block — a row per event, its share of the paths at
 * each step, the events by the highest share they reach — and a sankey's flows between consecutive steps
 * by share. Blocks around several anchors are named and marked as the library's diff tables are.
 */
function stepTables(r, at) {
  const several = r.blocks.length > 1;
  const named = (name, i) => (several ? `${name} ${i + 1}` : name);
  return r.blocks.flatMap((b, i) => {
    const share = new Map(b.cells.map((c) => [`${c.event}\u0000${c.step}`, c.share]));
    const peak = new Map();
    for (const c of b.cells) peak.set(c.event, Math.max(peak.get(c.event) ?? 0, c.share));
    const events = [...peak.keys()].sort((x, y) => peak.get(y) - peak.get(x) || byText(x, y));
    const block = several ? { block: b.block } : {};
    return [
      pageOf(named(r.kind, i), ['event', ...b.steps.map(String)], events.map((e) => [e, ...b.steps.map((s) => round(share.get(`${e}\u0000${s}`) ?? 0))]), at, block),
      ...(b.links?.length
        ? [pageOf(named('flows', i), ['step', 'from', 'to', 'share'], [...b.links].sort((x, y) => y.share - x.share || x.step - y.step || byText(x.source, y.source) || byText(x.target, y.target)).map((l) => [l.step, l.source, l.target, round(l.share)]), at, block)]
        : []),
    ];
  });
}

/** A funnel's steps in order — or a diff's: each step for both groups and their difference (first minus
 *  second), the groups named beside the table. */
function funnelTable(r, at) {
  const fields = ['unique_paths', 'conversion_rate', 'step_conversion_rate'];
  if (!r.diff) return pageOf('funnel', ['step', ...fields], r.steps.map((s) => [s.step, ...fields.map((f) => round(s[f]))]), at);
  const sides = [['first', 'funnel1'], ['second', 'funnel2'], ['difference', 'delta']];
  return pageOf('funnel', ['step', ...sides.flatMap(([g]) => fields.map((f) => `${g}_${f}`))], r.steps.map((s) => [s.step, ...sides.flatMap(([, p]) => fields.map((f) => round(s[`${p}_${f}`])))]), at);
}

/** A group overview (clusters, a segment's levels): each group with its size, share and profile — the
 *  metrics it stands out on most against the average of the others — and every metric as a table, a
 *  row per metric across the groups, those that tell the groups apart most first. */
function groups(r, at, key) {
  const size = r.metrics.find((m) => m.metric === 'segment_size');
  const share = r.metrics.find((m) => m.metric === 'segment_share');
  const profiled = r.metrics.filter((m) => m !== size && m !== share);
  return {
    [key]: r.levels.map((l, i) => ({
      name: l,
      ...(size ? { size: size.values[i] } : {}),
      ...(share ? { share: round(share.values[i]) } : {}),
      profile: profiled
        .map((m) => {
          const others = m.values.filter((_, j) => j !== i && m.values[j] != null);
          const base = others.length ? others.reduce((a, b) => a + b, 0) / others.length : null;
          return { metric: m.label || m.metric, value: round(m.values[i]), vs_others: base != null && m.values[i] != null ? round(m.values[i] - base) : null };
        })
        .sort((a, b) => Math.abs(b.vs_others ?? 0) - Math.abs(a.vs_others ?? 0))
        .slice(0, TOP_PROFILE),
    })),
    ...(r.best_params ? { best_params: r.best_params } : {}),
    ...(r.silhouette ? { silhouette: r.silhouette.map((s) => ({ ...s.params, score: round(s.score), best: s.best })) } : {}),
    tables: [pageOf('metrics', ['metric', 'label', ...r.levels.map(String)], profiled.map((m, i) => ({ m, i, spread: metricSpread(m) })).sort((a, b) => b.spread - a.spread || a.i - b.i)
      .map(({ m }) => [m.metric, m.label || m.metric, ...m.values.map((v) => round(v))]), at)],
  };
}

/** The library's own tables, each a page in its own order — a diff's parts with their role and block. */
function libraryTables(r, at) {
  return (r.tables || []).map((t) => pageOf(t.name, t.columns, t.rows.map((row) => row.map((v) => round(v))), at, {
    from: t.from_row ?? 0, total: t.total_rows ?? (t.from_row ?? 0) + t.rows.length, ...(t.role ? { role: t.role } : {}), ...(t.block != null ? { block: t.block } : {}),
  }));
}

/** Whether a result holds only some rows of one of its tables (the rest is in the stored table). */
export function truncatedTables(result) {
  return !!result?.tables?.some((t) => t.truncated);
}

/** Whether a read of `result` holds every row the page `offset`..`offset + limit` of each of its tables
 *  needs — else that page is read from the stored table. */
export function holdsPage(result, { offset = 0, limit = READ_PAGE } = {}) {
  return !(result?.tables || []).some((t) => {
    const from = t.from_row ?? 0;
    const end = Math.min(offset + limit, t.total_rows ?? from + t.rows.length);
    return offset < end && (offset < from || end > from + t.rows.length);
  });
}

/**
 * A value with its lists read as a table's rows are: the page of each from row `offset` ({ items, page })
 * — a list the first page holds whole is that list as it is, and past its end a page of it holds no
 * items, as a table's does, so paging to the end reads every item once. What an item holds (a list in
 * it) comes whole with the item, as a table's cell does; the rest as it is.
 */
function pagedValues(v, at, depth = 0, inItem = false) {
  if (Array.isArray(v)) {
    if (inItem || (at.offset === 0 && v.length <= at.limit)) return v.map((x) => pagedValues(x, at, depth + 1, true));
    const { rows: items, page } = pageOf(null, null, v, at);
    return { items: items.map((x) => pagedValues(x, at, depth + 1, true)), page };
  }
  if (v && typeof v === 'object' && depth < 6) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pagedValues(x, at, depth + 1, inItem)]));
  return v;
}
