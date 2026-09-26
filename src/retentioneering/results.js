// THE RESULT OF A QUERY CALL — the long table the analysis model wrote (analysis, kind, part, seq,
// payload), read back into one structured result per analysis. The card draws the whole of it; the
// model reads a summary that fits a conversation (the biggest transitions, the leading events per
// step, each cluster's profile) and asks for the card when the person should see the rest.

const TOP_EDGES = 25;
const TOP_PER_STEP = 3;
const TOP_PROFILE = 6;

/** rows → { <analysis id>: { kind, ...data } }, in the order the analyses were asked for. */
export function parseResultRows(rows, order = []) {
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
    return [id, { ...shape(a), ...(a.parts.scope?.length ? { paths: a.parts.scope[0].paths } : {}) }];
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

function shape({ kind, parts }) {
  if (kind === 'transition_graph') {
    const layout = Object.fromEntries((parts.layout || []).map((p) => [p.event, { x: p.x, y: p.y }]));
    return {
      kind,
      nodes: (parts.node || []).map((n) => ({ event: n.event, count: n.count, ...(layout[n.event] || {}) })),
      edges: (parts.edge || []).map(strip),
    };
  }
  if (kind === 'step_matrix' || kind === 'step_sankey') {
    return {
      kind,
      blocks: (parts.block || []).map((b) => ({
        block: b.block,
        steps: JSON.parse(b.steps),
        cells: (parts.cell || []).filter((c) => c.block === b.block).map(({ seq: _s, block: _b, ...c }) => c),
        ...(parts.link ? { links: parts.link.filter((l) => l.block === b.block).map(({ seq: _s, block: _b, ...l }) => l) } : {}),
      })),
    };
  }
  if (kind === 'funnel') return { kind, steps: (parts.step || []).map(strip) };
  if (kind === 'cluster_analysis' || kind === 'segment_overview') {
    const levelKey = kind === 'cluster_analysis' ? 'cluster' : 'level';
    const levels = [...new Set((parts.overview || []).map((o) => o[levelKey]))];
    const metrics = [...new Set((parts.overview || []).map((o) => o.metric))];
    const value = new Map((parts.overview || []).map((o) => [`${o.metric}\u0000${o[levelKey]}`, o.value]));
    const meta = new Map((parts.metric || []).map((m) => [m.metric, m]));
    return {
      kind,
      levels,
      metrics: metrics.map((m) => ({ metric: m, ...describeMetric(m, meta.get(m)), values: levels.map((l) => value.get(`${m}\u0000${l}`) ?? null) })),
      ...(parts.params?.length ? { best_params: JSON.parse(parts.params[0].params) } : {}),
      ...(parts.silhouette?.length ? { silhouette: parts.silhouette.map((s) => ({ params: JSON.parse(s.params), score: s.score, best: !!s.best })) } : {}),
    };
  }
  return { kind, parts };
}

const round = (x, digits = 4) => (typeof x === 'number' ? Number(x.toFixed(digits)) : x);

/** What the model reads of one analysis: the numbers that answer, not every cell. */
export function summarize(result) {
  const { kind } = result;
  if (kind === 'transition_graph') {
    const edges = [...result.edges].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    return {
      kind,
      events: result.nodes.map((n) => ({ event: n.event, count: n.count })),
      transitions: edges.length,
      top_transitions: edges.slice(0, TOP_EDGES).map((e) => ({ from: e.source, to: e.target, count: e.count, unique_paths: e.unique_paths, proba_out: round(e.proba_out), proba_in: round(e.proba_in), time_median_s: round(e.time_median, 1) })),
      ...(edges.length > TOP_EDGES ? { note: `${edges.length - TOP_EDGES} smaller transitions are in the card.` } : {}),
    };
  }
  if (kind === 'step_matrix' || kind === 'step_sankey') {
    return {
      kind,
      blocks: result.blocks.map((b) => ({
        steps: b.steps.map((step) => ({
          step,
          top: b.cells.filter((c) => c.step === step).sort((x, y) => y.share - x.share || x.event.localeCompare(y.event)).slice(0, TOP_PER_STEP).map((c) => ({ event: c.event, share: round(c.share) })),
        })),
      })),
    };
  }
  if (kind === 'funnel') return { kind, steps: result.steps.map((s) => ({ step: s.step, unique_paths: s.unique_paths, conversion_rate: round(s.conversion_rate), step_conversion_rate: round(s.step_conversion_rate) })) };
  if (kind === 'cluster_analysis' || kind === 'segment_overview') {
    const levelKey = kind === 'cluster_analysis' ? 'clusters' : 'levels';
    const size = result.metrics.find((m) => m.metric === 'segment_size');
    const share = result.metrics.find((m) => m.metric === 'segment_share');
    const rest = result.metrics.filter((m) => m !== size && m !== share);
    return {
      kind,
      [levelKey]: result.levels.map((l, i) => ({
        name: l,
        ...(size ? { size: size.values[i] } : {}),
        ...(share ? { share: round(share.values[i]) } : {}),
        // the metrics this group stands out on most, against the average of the others
        profile: rest
          .map((m) => {
            const others = m.values.filter((_, j) => j !== i && m.values[j] != null);
            const base = others.length ? others.reduce((a, b) => a + b, 0) / others.length : null;
            return { metric: m.label || m.metric, value: round(m.values[i]), vs_others: base != null && m.values[i] != null ? round(m.values[i] - base) : null };
          })
          .sort((a, b) => Math.abs(b.vs_others ?? 0) - Math.abs(a.vs_others ?? 0))
          .slice(0, TOP_PROFILE),
      })),
      ...(result.best_params ? { best_params: result.best_params } : {}),
      ...(result.silhouette ? { silhouette: result.silhouette.map((s) => ({ ...s.params, score: round(s.score), best: s.best })) } : {}),
    };
  }
  return { kind };
}
