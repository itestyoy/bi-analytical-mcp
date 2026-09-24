// THE MODEL OF WHAT THE RESULT VIEW SHOWS — a pure function from a tool result to a view.
//
// The MCP App (src/apps.js) renders it inside the host's sandboxed iframe; this function decides
// WHAT to render: a CHART (a time series or a breakdown, with its rows folded underneath), a FUNNEL,
// and the A/B TEST family — the test itself, the sample-ratio check and the sample-size plan, the
// three steps of one experiment. Anything else — a failure, a build still running, an explained
// query's SQL, rows with no chart shape — is `none` with its `reason`: the view shows one quiet
// status line (the host keeps a minimum frame, so drawing nothing would leave an empty box) and
// the tool's text result speaks for itself. Rows are drawn as the caller DECLARED them when the
// result carries `display` (a funnel, a line or a bar chart over named columns); only without one is
// the card inferred from the shape. The view imports it and the unit
// tests run it in node on real tool results, so the browser draws exactly what the tests checked.
//
// Everything below is data in, data out: no DOM, no module scope.

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
  if (result.status === 'running' && result.query_id) return none('running');
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
        // metric (conversion up is good, crash rate up is not), which the test does not know
        verdict: !significant ? 'no_difference' : (lift ?? 0) >= 0 ? 'increase' : 'decrease',
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
    const metricLabel = { proportion: 'conversion rate', mean: 'mean', ratio: 'ratio', cuped: 'mean (CUPED-adjusted)' }[result.metric] || result.metric || 'metric';
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

  // ── rows: a funnel, or a chart (with the rows folded under it) — or nothing ──
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
    const at = (name) => names.indexOf(name);
    const label = (v) => (v === null ? '∅' : String(v));
    if (d && rows.length) {
      const declaredTitle = typeof d.title === 'string' && d.title.trim() ? d.title.trim() : null;
      if (d.kind === 'funnel') {
        const steps = Array.isArray(d.steps) ? d.steps.filter((st) => isObj(st) && at(st.column) >= 0) : null;
        const labels = steps ? steps.map((st) => (typeof st.label === 'string' && st.label ? st.label : st.column)) : rows.map((r) => label(r[at(d.label_column)]));
        const values = steps ? steps.map((st) => num(rows[0][at(st.column)])) : rows.map((r) => num(r[at(d.value_column)]));
        const drawable = (steps || (at(d.label_column) >= 0 && at(d.value_column) >= 0)) && labels.length >= 2 && values[0] > 0 && values.every((v) => v !== null && v >= 0);
        if (drawable) return { ...funnelOf(labels, values, steps ? null : d.value_column), ...(declaredTitle ? { title: declaredTitle } : {}) };
      }
      if (d.kind === 'line' && at(d.x) >= 0 && Array.isArray(d.y) && d.y.length && d.y.every((y) => at(y) >= 0)) {
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
        return chartCard({ type: 'line', x: d.x, y: d.y.length === 1 ? d.y[0] : null, series, folded, ordered, title: declaredTitle }, declaredTitle || title);
      }
      if (d.kind === 'bar' && at(d.x) >= 0 && at(d.y) >= 0) {
        const xi = at(d.x);
        const yi = at(d.y);
        return chartCard({ type: 'bar', x: d.x, y: d.y, bars: rows.slice(0, 50).map((r) => ({ label: label(r[xi]), value: num(r[yi]) ?? 0 })), title: declaredTitle }, declaredTitle || title);
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
