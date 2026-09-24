// THE MODEL OF WHAT THE RESULT VIEW SHOWS — a pure function from a tool result to a view.
//
// The MCP App (src/apps.js) renders it inside the host's sandboxed iframe; this function decides
// WHAT to render: a CHART (a time series or a breakdown), KPI tiles, a FUNNEL,
// and the A/B TEST family — the test itself, the sample-ratio check and the sample-size plan, the
// three steps of one experiment. Anything else — a failure, a build still running (with the query_id
// the card follows to its rows), an explained
// query's SQL, rows with no chart shape — is `none` with its `reason`: the view shows one quiet
// status line (the host keeps a minimum frame, so drawing nothing would leave an empty box) and
// the tool's text result speaks for itself. Rows are drawn as the caller DECLARED them when the
// result carries `display` (a funnel, KPI tiles, a drill-down pivot, a line, area, bar, pie or sankey chart over named columns); only without one is
// the card inferred from the shape. The view imports it and the unit
// tests run it in node on real tool results, so the browser draws exactly what the tests checked.
//
// Everything below is data in, data out: no DOM, no module state.

/** How many rows one drill-down level reads — the top level and every level a row opens into. */
export const PIVOT_LEVEL_ROWS = 200;

/**
 * A drill-down's read of one level (display kind pivot): the rows of the stored result under `path`
 * (the keys of the rows opened above, top level first), grouped by the next level, each value folded
 * with its agg, the largest first. The engine reads the top level with it and the card each level it
 * opens — one definition of what a level is.
 */
export function pivotTransform(display, path) {
  return {
    where: path.map((key, i) => (key === null ? { column: display.levels[i].column, op: 'is_null' } : { column: display.levels[i].column, op: 'eq', value: key })),
    group_by: [display.levels[path.length].column],
    aggregations: display.values.map((v) => ({ fn: v.agg || 'sum', column: v.column, as: v.column })),
    // the largest first, an empty value last — the same on every warehouse
    order_by: [{ key: display.values[0].column, direction: 'desc', nulls: 'last' }],
  };
}

/** The rows of one drill-down level read with pivotTransform: the key as it came (to filter by), and the values. */
export function pivotRows(result, display, depth) {
  const level = display.levels[depth].column;
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const names = Array.isArray(result?.columns) && result.columns.length ? result.columns.map((c) => (c && typeof c === 'object' ? c.name : String(c))) : null;
  const get = (r, name) => (Array.isArray(r) ? (names ? r[names.indexOf(name)] : undefined) : r?.[name]);
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return rows.map((r) => {
    const key = get(r, level) ?? null;
    return { key, label: key === null ? '∅' : String(key), values: display.values.map((v) => num(get(r, v.column))) };
  });
}

export function buildViewModel(toolName, result, toolInput) {
  const MAX_SERIES = 6; // lines share one axis; past six the legend stops being readable

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
    return null;
  };
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
  const isTimeName = (n) => /^metric_time|(_|^)(date|day|week|month|quarter|year|time|ts|hour)(__|$|_)/i.test(n);

  if (!isObj(result)) return { kind: 'none', reason: 'not_an_object' };

  // a build that is still running, or one that failed, says so — there is nothing to plot
  const none = (reason, extra = {}) => ({ kind: 'none', reason, ...extra });
  // (the query_id is what the card follows to the rows)
  if (result.status === 'running' && result.query_id) return none('running', { query_id: String(result.query_id) });
  // a result that existed and is no longer there (deleted, expired) is not a failure: it says so
  // plainly — error.code is RESULT_GONE in src/validate.js
  if (result.ok === false && result.error?.code === 'result_gone') return none('gone');
  // a failure is only NAMED in the view — the reason is for the reply, not the card
  if (result.ok === false || (result.error && !result.rows)) return none('error');

  // ── A/B: significance per variant (experiment analyze) ──
  if (toolName === 'experiment' && Array.isArray(result.results)) {
    // group sizes are the caller's input, not part of the test result: matched by label, else by
    // position (results come back in the order the variants went in)
    const input = isObj(toolInput) ? toolInput : {};
    const inVariants = Array.isArray(input.variants) ? input.variants : [];
    const nControl = num(input.control?.n);
    const variants = result.results.map((r, i) => {
      const lift = num(r.absolute_lift ?? r.lift);
      const relative = num(r.relative_lift);
      const ci = Array.isArray(r.confidence_interval) ? r.confidence_interval.map(num) : null;
      const relativeCi = Array.isArray(r.relative_lift_ci) ? r.relative_lift_ci.map(num) : null;
      const adjusted = num(r.p_value_adjusted);
      const significant = !!(r.significant_adjusted ?? r.significant);
      // the interval is drawn in the SAME unit as the headline: relative when both the relative lift
      // and its interval exist, absolute otherwise — never a relative number over an absolute bar
      const useRelative = relative !== null && relativeCi && relativeCi.every((v) => v !== null);
      const effect = useRelative
        ? { unit: 'relative', point: relative, lo: relativeCi[0], hi: relativeCi[1] }
        : lift !== null && ci && ci.every((v) => v !== null) ? { unit: 'absolute', point: lift, lo: ci[0], hi: ci[1] } : null;
      const inV = inVariants.find((v) => isObj(v) && v.label === r.variant) ?? inVariants[i];
      return {
        variant: r.variant,
        control_value: num(r.control_rate ?? r.control_mean ?? r.control_ratio ?? r.control_value),
        variant_value: num(r.variant_rate ?? r.variant_mean ?? r.variant_ratio ?? r.variant_value),
        n_control: nControl,
        n_variant: num(inV?.n),
        lift,
        relative_lift: relative,
        ci,
        relative_ci: relativeCi,
        effect,
        p_value: num(r.p_value),
        p_value_adjusted: adjusted,
        p_value_sequential: num(r.p_value_sequential),
        significant,
        // a significant result has a direction; whether that direction is GOOD depends on the
        // metric (conversion up is good, crash rate up is not) — the `outcome` below
        verdict: !significant ? 'no_difference' : (lift ?? 0) >= 0 ? 'increase' : 'decrease',
        // whether that direction is GOOD is the caller's to say (good: up | down, echoed by the test)
        outcome: r.outcome || (!significant || !lift ? 'no_difference' : (lift > 0) === ((result.good || 'up') === 'up') ? 'better' : 'worse'),
        variance_reduction: num(r.variance_reduction),
      };
    });
    // one symmetric scale for every variant, so their intervals line up and compare at a glance
    const extent = Math.max(0, ...variants.flatMap((v) => (v.effect ? [Math.abs(v.effect.lo), Math.abs(v.effect.hi), Math.abs(v.effect.point)] : [])));
    const nice = (x) => {
      if (!(x > 0)) return 1;
      const p = 10 ** Math.floor(Math.log10(x));
      return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= x);
    };
    // a proportion where lower is better (crash rate, churn) is not a conversion — it is a rate
    const metricLabel = { proportion: result.good === 'down' ? 'rate' : 'conversion rate', mean: 'mean', ratio: 'ratio', cuped: 'mean (CUPED-adjusted)' }[result.metric] || result.metric || 'metric';
    return {
      kind: 'experiment',
      title: `A/B test · ${metricLabel}`,
      metric: result.metric,
      metric_label: metricLabel,
      confidence: num(result.confidence),
      alternative: result.alternative || null,
      control: result.control || 'control',
      correction: result.correction && result.correction !== 'none' ? result.correction : null,
      variants,
      significant_count: variants.filter((v) => v.significant).length,
      good: result.good || 'up',
      scale: nice(extent * 1.1),
      notes: result.recommendations || [],
    };
  }
  // ── A/B: the sample-ratio check — is the observed split the one that was intended? ──
  if (toolName === 'experiment' && Array.isArray(result.groups) && 'srm_detected' in result) {
    const groups = result.groups.map((g) => ({ label: String(g.label ?? ''), observed: num(g.observed), expected: num(g.expected) }));
    const total = groups.reduce((a, g) => a + (g.observed ?? 0), 0);
    const expectedTotal = groups.reduce((a, g) => a + (g.expected ?? 0), 0);
    return {
      kind: 'srm',
      title: 'Sample ratio check',
      p_value: num(result.p_value),
      srm_detected: !!result.srm_detected,
      total,
      groups: groups.map((g) => ({
        ...g,
        observed_share: total > 0 && g.observed !== null ? g.observed / total : null,
        expected_share: expectedTotal > 0 && g.expected !== null ? g.expected / expectedTotal : null,
      })),
    };
  }
  // ── A/B: the sample-size plan — how many users, or the smallest effect a given n can see ──
  if (toolName === 'experiment' && 'n_per_group' in result) {
    const metricLabel = { proportion: 'conversion rate', mean: 'mean' }[result.metric] || result.metric || 'metric';
    return {
      kind: 'plan',
      title: `Sample-size plan · ${metricLabel}`,
      metric: result.metric || null,
      // which side was solved: a total comes back only when n was the unknown
      solved: 'total_n' in result ? 'n' : 'mde',
      n_per_group: num(result.n_per_group),
      total_n: num(result.total_n),
      baseline: num(result.baseline),
      stddev: num(result.stddev),
      mde: num(result.mde),
      relative_mde: num(result.relative_mde),
      power: num(result.power),
      confidence: num(result.confidence),
      alternative: result.alternative || null,
    };
  }
  if (toolName === 'experiment') return none('experiment');
  if (typeof result.sql === 'string' && !Array.isArray(result.rows)) return none('sql');

  // ── rows: a funnel, or a chart — or nothing ──
  if (Array.isArray(result.rows)) {
    const names = Array.isArray(result.columns) && result.columns.length
      ? result.columns.map((c) => (isObj(c) ? c.name : String(c)))
      : (isObj(result.rows[0]) ? Object.keys(result.rows[0]) : result.rows[0] ? result.rows[0].map((_, i) => `col_${i + 1}`) : []);
    const cell = (row, i) => (Array.isArray(row) ? row[i] : isObj(row) ? row[names[i]] : undefined);
    const rows = result.rows.map((r) => names.map((_, i) => { const v = cell(r, i); return v === undefined ? null : v; }));
    const columns = names.map((name, i) => {
      const vals = rows.map((r) => r[i]).filter((v) => v !== null && v !== '');
      const numeric = vals.length > 0 && vals.every((v) => num(v) !== null);
      const time = vals.length > 0 && (isTimeName(name) || vals.every((v) => typeof v === 'string' && ISO_DAY.test(v))) && !numeric;
      return { name, type: time ? 'time' : numeric ? 'number' : 'category' };
    });

    const timeIdx = columns.findIndex((c) => c.type === 'time');
    const numIdx = columns.map((c, i) => (c.type === 'number' ? i : -1)).filter((i) => i >= 0);
    const catIdx = columns.map((c, i) => (c.type === 'category' ? i : -1)).filter((i) => i >= 0);
    // the result TABLE's name is generated (qr_<id>, pipe_<name>_<context>) — an address, not a
    // title: the card names what it shows, and the chart names its metric
    const title = toolName === 'query_semantic_model' ? 'Metric query' : 'Query result';

    // ── no declaration: a FUNNEL, ordered steps whose counts never grow. Recognised only on an explicit signal —
    // step-like names, or ordinal step labels — so a breakdown sorted by size never becomes one.
    // Two shapes: ONE row with a count column per step (a metric query over step measures), or a
    // row per step (a pipeline's step × users).
    const STEP_NAME = /step|stage|funnel|reached|level/i;
    const nonIncreasing = (vs) => vs.length >= 2 && vs[0] > 0 && vs.every((v, i) => v !== null && v >= 0 && (i === 0 || v <= vs[i - 1]));
    const funnelOf = (labels, values, measure) => {
      const first = values[0];
      const steps = labels.map((label, i) => ({
        label,
        value: values[i],
        of_first: values[i] / first,
        of_previous: i === 0 ? null : values[i - 1] > 0 ? values[i] / values[i - 1] : null,
      }));
      // the step that loses the largest share of the users who reached the one before it
      let worst = null;
      for (let i = 1; i < steps.length; i++) if (steps[i].of_previous !== null && (worst === null || steps[i].of_previous < steps[worst].of_previous)) worst = i;
      return { kind: 'funnel', title: 'Funnel', measure, steps, overall: values[values.length - 1] / first, biggest_drop: worst };
    };
    const page = isObj(result.page) ? { limit: num(result.page.limit), offset: num(result.page.offset) ?? 0, has_more: !!result.page.has_more } : null;
    const chartCard = (chart, cardTitle = title) => ({
      kind: 'chart',
      title: cardTitle,
      columns,
      rows,
      row_count: rows.length,
      sampled: !!result.sampled,
      approximate: !!result.approximate || !!result.provenance?.approximate,
      page,
      chart,
    });

    // ── a DECLARED card: the caller said what this result is (the server checked the columns
    // exist), so it is drawn as declared — in the declared order, with no shape guessing ──
    const d = isObj(result.display) ? result.display : null;
    // a sankey flows one way: links that loop back cannot be laid out
    const acyclic = (links) => {
      const next = new Map();
      for (const l of links) { if (!next.has(l.from)) next.set(l.from, []); next.get(l.from).push(l.to); }
      const seen = new Map();
      const loops = (n) => {
        if (seen.get(n) === 1) return true;
        if (seen.get(n) === 2) return false;
        seen.set(n, 1);
        for (const m of next.get(n) || []) if (loops(m)) return true;
        seen.set(n, 2);
        return false;
      };
      return ![...next.keys()].some(loops);
    };
    const at = (name) => names.indexOf(name);
    const label = (v) => (v === null ? '∅' : String(v));
    if (d && rows.length) {
      const declaredTitle = typeof d.title === 'string' && d.title.trim() ? d.title.trim() : null;
      if (d.kind === 'funnel') {
        // steps as COLUMNS of one row, or as ROWS ({ label_column, value_column })
        const steps = Array.isArray(d.steps) ? d.steps.filter((st) => isObj(st) && at(st.column) >= 0) : null;
        const byRow = isObj(d.steps) && at(d.steps.label_column) >= 0 && at(d.steps.value_column) >= 0 ? d.steps : null;
        const labels = steps ? steps.map((st) => (typeof st.label === 'string' && st.label ? st.label : st.column)) : byRow ? rows.map((r) => label(r[at(byRow.label_column)])) : [];
        const values = steps ? steps.map((st) => num(rows[0][at(st.column)])) : byRow ? rows.map((r) => num(r[at(byRow.value_column)])) : [];
        const drawable = labels.length >= 2 && values[0] > 0 && values.every((v) => v !== null && v >= 0);
        if (drawable) return { ...funnelOf(labels, values, byRow ? byRow.value_column : null), ...(declaredTitle ? { title: declaredTitle } : {}) };
      }
      if ((d.kind === 'line' || d.kind === 'area') && at(d.x) >= 0 && Array.isArray(d.y) && d.y.length && d.y.every((y) => at(y) >= 0)) {
        const xi = at(d.x);
        // a time axis is put in time order; any other axis keeps the order the rows came in
        const ordered = columns[xi].type !== 'time';
        const kept = rows.filter((r) => r[xi] !== null);
        const inOrder = ordered ? kept : kept.slice().sort((a, b) => (String(a[xi]) < String(b[xi]) ? -1 : String(a[xi]) > String(b[xi]) ? 1 : 0));
        let series;
        let folded = 0;
        if (d.series_column && at(d.series_column) >= 0) {
          const si = at(d.series_column);
          const yi = at(d.y[0]);
          const bySeries = new Map();
          for (const r of inOrder) {
            const k = label(r[si]);
            if (!bySeries.has(k)) bySeries.set(k, []);
            const y = num(r[yi]);
            if (y !== null) bySeries.get(k).push([String(r[xi]), y]);
          }
          const all = [...bySeries.entries()].map(([name, points]) => ({ name, points, total: points.reduce((s, p) => s + p[1], 0) })).sort((a, b) => b.total - a.total);
          series = all.slice(0, MAX_SERIES).map(({ name, points }) => ({ name, points }));
          folded = Math.max(0, all.length - MAX_SERIES);
        } else {
          series = d.y.slice(0, MAX_SERIES).map((y) => ({ name: y, points: inOrder.map((r) => [String(r[xi]), num(r[at(y)])]).filter((p) => p[1] !== null) }));
        }
        // an area stacks its series: they are the parts of one total over time
        return chartCard({ type: 'line', x: d.x, y: d.y.length === 1 ? d.y[0] : null, series, folded, ordered, ...(d.kind === 'area' ? { area: true, stacked: series.length > 1 } : {}), title: declaredTitle }, declaredTitle || title);
      }
      const ys = d.y === undefined ? [] : [].concat(d.y);
      if (d.kind === 'bar' && at(d.x) >= 0 && ys.length && ys.every((y) => at(y) >= 0)) {
        const xi = at(d.x);
        const kept = rows.slice(0, 50);
        let labels;
        let series;
        let folded = 0;
        if (d.series_column && at(d.series_column) >= 0) {
          // categories in the order they first appear; a bar per series value inside each
          const si = at(d.series_column);
          const yi = at(ys[0]);
          labels = [...new Set(kept.map((r) => label(r[xi])))];
          const bySeries = new Map();
          for (const r of kept) {
            const k = label(r[si]);
            if (!bySeries.has(k)) bySeries.set(k, new Map());
            const cell = bySeries.get(k);
            cell.set(label(r[xi]), (cell.get(label(r[xi])) ?? 0) + (num(r[yi]) ?? 0));
          }
          const all = [...bySeries.entries()].map(([name, byX]) => ({ name, values: labels.map((l) => byX.get(l) ?? 0) })).map((x) => ({ ...x, total: x.values.reduce((a, v) => a + v, 0) })).sort((a, b) => b.total - a.total);
          series = all.slice(0, MAX_SERIES).map(({ name, values }) => ({ name, values }));
          folded = Math.max(0, all.length - MAX_SERIES);
        } else {
          labels = kept.map((r) => label(r[xi]));
          series = ys.slice(0, MAX_SERIES).map((y) => ({ name: y, values: kept.map((r) => num(r[at(y)]) ?? 0) }));
        }
        const single = series.length === 1 && !d.series_column;
        return chartCard({
          type: 'bar',
          x: d.x,
          y: ys.length === 1 ? ys[0] : null,
          labels,
          series,
          ...(single ? { bars: labels.map((l, i) => ({ label: l, value: series[0].values[i] })) } : {}),
          stacked: !!d.stacked && series.length > 1,
          horizontal: typeof d.horizontal === 'boolean' ? d.horizontal : null,
          folded,
          title: declaredTitle,
        }, declaredTitle || title);
      }
      // a drill-down: the top level the server read, and where the card reads the levels below
      if (d.kind === 'pivot' && Array.isArray(d.levels) && d.levels.length && d.levels.every(isObj) && Array.isArray(d.values) && d.values.length && isObj(result.pivot_source)) {
        return {
          kind: 'pivot',
          title: declaredTitle || 'Pivot',
          display: d,
          levels: d.levels.map((l) => ({ column: l.column, label: typeof l.label === 'string' && l.label ? l.label : l.column })),
          values: d.values.map((v) => ({ column: v.column, label: typeof v.label === 'string' && v.label ? v.label : v.column, agg: v.agg || 'sum', format: v.format || 'number', currency: v.currency || 'USD' })),
          rows: pivotRows(result, d, 0),
          has_more: !!result.page?.has_more,
          source: result.pivot_source,
        };
      }
      if (d.kind === 'kpi' && Array.isArray(d.values) && d.values.length && d.values.every((v) => isObj(v) && at(v.column) >= 0) && (at(d.x) >= 0 || rows.length === 1)) {
        // with an axis: the rows in its order (time sorted, any other axis as the rows came); the
        // tile is the LAST row, its change is against the row before, its trend is every row
        const xi = at(d.x);
        const series = xi >= 0
          ? (columns[xi].type === 'time' ? rows.filter((r) => r[xi] !== null).slice().sort((a, b) => (String(a[xi]) < String(b[xi]) ? -1 : String(a[xi]) > String(b[xi]) ? 1 : 0)) : rows.filter((r) => r[xi] !== null))
          : rows;
        const last = series[series.length - 1];
        const before = series.length > 1 ? series[series.length - 2] : null;
        if (last) {
          const tiles = d.values.map((v) => {
            const value = num(last[at(v.column)]);
            const previous = at(v.previous_column) >= 0 ? num(last[at(v.previous_column)]) : before ? num(before[at(v.column)]) : null;
            const trend = xi >= 0 && series.length >= 2 ? series.map((r) => num(r[at(v.column)])) : null;
            return {
              label: typeof v.label === 'string' && v.label ? v.label : v.column,
              value,
              previous,
              change: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null,
              format: v.format || 'number',
              currency: v.currency || 'USD',
              good: v.good || null,
              trend: trend && trend.filter((y) => y !== null).length >= 2 ? trend : null,
            };
          });
          return { kind: 'kpi', title: declaredTitle || 'Key metrics', as_of: xi >= 0 ? String(last[xi]) : null, x: xi >= 0 ? d.x : null, compared_to: at(d.values[0].previous_column) >= 0 ? 'previous' : before && xi >= 0 ? String(before[xi]) : null, tiles };
        }
      }
      if (d.kind === 'sankey' && at(d.source_column) >= 0 && at(d.target_column) >= 0 && at(d.value_column) >= 0) {
        const fi = at(d.source_column);
        const ti = at(d.target_column);
        const vi = at(d.value_column);
        // a link seen twice is one link with the sum; empty or non-positive amounts carry no flow
        const byLink = new Map();
        for (const r of rows) {
          const from = label(r[fi]);
          const to = label(r[ti]);
          const flow = num(r[vi]);
          if (flow === null || flow <= 0 || from === to) continue;
          const k = JSON.stringify([from, to]);
          byLink.set(k, (byLink.get(k) ?? 0) + flow);
        }
        const links = [...byLink.entries()].map(([k, flow]) => { const [from, to] = JSON.parse(k); return { from, to, flow }; });
        // a node's size is the larger of what flows in and what flows out
        const inOut = new Map();
        for (const l of links) {
          inOut.set(l.from, { in: inOut.get(l.from)?.in ?? 0, out: (inOut.get(l.from)?.out ?? 0) + l.flow });
          inOut.set(l.to, { in: (inOut.get(l.to)?.in ?? 0) + l.flow, out: inOut.get(l.to)?.out ?? 0 });
        }
        const nodes = [...inOut.entries()].map(([name, v]) => ({ name, size: Math.max(v.in, v.out) })).sort((a, b) => b.size - a.size);
        if (links.length && !acyclic(links)) return none('no_chart_shape');
        if (links.length) return chartCard({ type: 'sankey', x: d.source_column, to: d.target_column, y: d.value_column, links, nodes, title: declaredTitle }, declaredTitle || title);
      }
      if (d.kind === 'pie' && at(d.label_column) >= 0 && at(d.value_column) >= 0) {
        const li = at(d.label_column);
        const vi = at(d.value_column);
        const MAX_SLICES = 6; // a donut reads a share at a glance only while the slices are few
        const all = rows.map((r) => ({ label: label(r[li]), value: num(r[vi]) })).filter((x) => x.value !== null && x.value > 0).sort((a, b) => b.value - a.value);
        const total = all.reduce((a, x) => a + x.value, 0);
        if (all.length >= 2 && total > 0) {
          const shown = all.length > MAX_SLICES ? all.slice(0, MAX_SLICES - 1) : all;
          const rest = all.slice(shown.length);
          const slices = [...shown, ...(rest.length ? [{ label: 'Other', value: rest.reduce((a, x) => a + x.value, 0), other: rest.length }] : [])].map((x) => ({ ...x, share: x.value / total }));
          return chartCard({ type: 'pie', x: d.label_column, y: d.value_column, slices, total, folded: rest.length, title: declaredTitle }, declaredTitle || title);
        }
      }
      // a declaration the rows cannot fill falls through to the inferred card
    }

    if (rows.length === 1 && timeIdx < 0 && catIdx.length === 0) {
      const counts = numIdx.filter((i) => Number.isInteger(num(rows[0][i])));
      // the column names are the steps' names, shown as they are (they are the caller's metrics)
      const stepLike = counts.length >= 2 && counts.every((i) => STEP_NAME.test(names[i]));
      const values = counts.map((i) => num(rows[0][i]));
      if (stepLike && nonIncreasing(values)) return funnelOf(counts.map((i) => names[i]), values, null);
    }
    if (timeIdx < 0 && catIdx.length === 1 && numIdx.length >= 1 && rows.length >= 2 && rows.length <= 20) {
      const labels = rows.map((r) => (r[catIdx[0]] === null ? '∅' : String(r[catIdx[0]])));
      const values = rows.map((r) => num(r[numIdx[0]]));
      const stepLike = STEP_NAME.test(names[catIdx[0]]) || /funnel/i.test(String(result.table || '')) || labels.every((l) => /^\s*\d+\s*[._:)\-\s]/.test(l));
      if (stepLike && nonIncreasing(values)) return funnelOf(labels, values, names[numIdx[0]]);
    }

    let chart = null;
    if (timeIdx >= 0 && numIdx.length && rows.length >= 2) {
      // one line per numeric column — or, with exactly one numeric column and one category, one
      // line per category value (the long "time × segment × value" shape a group-by returns)
      if (numIdx.length === 1 && catIdx.length === 1) {
        const byCat = new Map();
        for (const r of rows) {
          const k = r[catIdx[0]] === null ? '∅' : String(r[catIdx[0]]);
          if (!byCat.has(k)) byCat.set(k, []);
          const y = num(r[numIdx[0]]);
          if (y !== null && r[timeIdx] !== null) byCat.get(k).push([String(r[timeIdx]), y]);
        }
        // largest series first; the rest fold into the table rather than into a ninth colour
        const series = [...byCat.entries()]
          .map(([name, points]) => ({ name, points: points.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), total: points.reduce((s, p) => s + p[1], 0) }))
          .sort((a, b) => b.total - a.total);
        chart = { type: 'line', x: names[timeIdx], y: names[numIdx[0]], series: series.slice(0, MAX_SERIES).map(({ name, points }) => ({ name, points })), folded: Math.max(0, series.length - MAX_SERIES) };
      } else if (catIdx.length === 0) {
        const ordered = rows.filter((r) => r[timeIdx] !== null).slice().sort((a, b) => (String(a[timeIdx]) < String(b[timeIdx]) ? -1 : String(a[timeIdx]) > String(b[timeIdx]) ? 1 : 0));
        const series = numIdx.slice(0, MAX_SERIES).map((i) => ({ name: names[i], points: ordered.map((r) => [String(r[timeIdx]), num(r[i])]).filter((p) => p[1] !== null) }));
        chart = { type: 'line', x: names[timeIdx], y: numIdx.length === 1 ? names[numIdx[0]] : null, series, folded: Math.max(0, numIdx.length - MAX_SERIES) };
      }
    } else if (timeIdx < 0 && catIdx.length === 1 && numIdx.length >= 1 && rows.length >= 1 && rows.length <= 50) {
      // one category and an amount: a bar per category (a segment breakdown)
      chart = { type: 'bar', x: names[catIdx[0]], y: names[numIdx[0]], bars: rows.map((r) => ({ label: r[catIdx[0]] === null ? '∅' : String(r[catIdx[0]]), value: num(r[numIdx[0]]) ?? 0 })) };
    }

    if (!chart) return none('no_chart_shape');
    return chartCard(chart);
  }

  return none('no_rows');
}
