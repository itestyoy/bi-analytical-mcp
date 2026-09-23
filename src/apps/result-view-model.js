// THE MODEL OF WHAT THE RESULT VIEW SHOWS — a pure function from a tool result to a view.
//
// The MCP App (src/apps.js) renders it inside the host's sandboxed iframe; this function decides
// WHAT to render: a table (always, for rows), a chart when the data has a shape a chart shows
// better than a table does, an A/B card, a value distribution. The view imports it and the unit
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

  if (!isObj(result)) return { kind: 'json', title: toolName || 'Result', json: result };

  // a build that is still running, or one that failed, says so — there is nothing to plot
  if (result.status === 'running' && result.query_id) {
    return { kind: 'running', title: 'Building…', query_id: result.query_id, message: result.message || 'The result is being built in the background.' };
  }
  if (result.ok === false || (result.error && !result.rows)) {
    const e = result.error || {};
    return { kind: 'error', title: 'Error', message: e.message || String(result.error || 'the call failed'), stage: e.stage || null };
  }

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
  // ── A/B: sample-ratio check ──
  if (toolName === 'experiment' && Array.isArray(result.groups) && 'srm_detected' in result) {
    return { kind: 'srm', title: 'Sample-ratio check', p_value: num(result.p_value), srm_detected: !!result.srm_detected, groups: result.groups.map((g) => ({ label: g.label, observed: num(g.observed), expected: num(g.expected) })) };
  }

  // ── A/B: a sample-size plan ──
  if (toolName === 'experiment' && ('n_per_group' in result || 'mde' in result)) {
    const figures = [
      { label: 'users per group', value: num(result.n_per_group) },
      { label: 'users in total', value: num(result.total_n) },
      { label: 'baseline', value: num(result.baseline), percent: result.metric === 'proportion' },
      { label: 'detectable effect (absolute)', value: num(result.mde), percent: result.metric === 'proportion' },
      { label: 'power', value: num(result.power), percent: true },
      { label: 'confidence', value: num(result.confidence), percent: true },
    ].filter((f) => f.value !== null);
    return { kind: 'plan', title: `Sample-size plan · ${result.metric || ''}`.trim(), figures };
  }
  // ── an explained query: its SQL is the result ──
  if (typeof result.sql === 'string' && !Array.isArray(result.rows)) {
    return { kind: 'sql', title: 'Query plan', sql: result.sql };
  }

  // ── a value distribution (semantic_index { source, property }) ──
  if (Array.isArray(result.samples) && result.samples.length && result.samples.every((s) => isObj(s) && 'value' in s)) {
    const bars = result.samples.map((s) => ({ label: s.value === null ? '∅ (NULL)' : String(s.value), value: num(s.freq ?? s.count) ?? 0 }));
    const stats = result.value_stats || {};
    return {
      kind: 'distribution',
      title: `${result.property || result.name || 'Values'}${result.source ? ` · ${result.source}` : ''}`,
      bars,
      total: num(stats.total_count),
      distinct: num(stats.distinct_count),
      has_more: !!stats.has_more,
      columns: [{ name: 'value', type: 'category' }, { name: 'freq', type: 'number' }],
      rows: bars.map((b) => [b.label, b.value]),
    };
  }

  // ── rows: a table, and a chart when the rows have a shape ──
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

    let chart = null;
    const timeIdx = columns.findIndex((c) => c.type === 'time');
    const numIdx = columns.map((c, i) => (c.type === 'number' ? i : -1)).filter((i) => i >= 0);
    const catIdx = columns.map((c, i) => (c.type === 'category' ? i : -1)).filter((i) => i >= 0);
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
      // one category and an amount: a bar per category (a funnel's steps, a segment breakdown)
      chart = { type: 'bar', x: names[catIdx[0]], y: names[numIdx[0]], bars: rows.map((r) => ({ label: r[catIdx[0]] === null ? '∅' : String(r[catIdx[0]]), value: num(r[numIdx[0]]) ?? 0 })) };
    }

    const page = isObj(result.page) ? { limit: num(result.page.limit), offset: num(result.page.offset) ?? 0, has_more: !!result.page.has_more } : null;
    // what re-fetching the NEXT page takes: the same call with a larger offset — only for
    // get_query_result, the one tool whose rows are a stored result that pages without recomputing
    const nextPage = toolName === 'get_query_result' && page?.has_more && isObj(toolInput)
      ? { name: 'get_query_result', arguments: { ...toolInput, offset: (page.offset || 0) + (page.limit || rows.length) } }
      : null;
    // and the PREVIOUS one: the same call stepped back by a page, never before the first row
    const prevPage = toolName === 'get_query_result' && page && page.offset > 0 && isObj(toolInput)
      ? { name: 'get_query_result', arguments: { ...toolInput, offset: Math.max(0, page.offset - (page.limit || rows.length)) } }
      : null;
    return {
      kind: 'table',
      title: result.table || (toolName === 'query_semantic_model' ? 'Metric query' : 'Result'),
      columns,
      rows,
      row_count: rows.length,
      sampled: !!result.sampled,
      approximate: !!result.approximate || !!result.provenance?.approximate,
      page,
      nextPage,
      prevPage,
      chart,
    };
  }

  return { kind: 'json', title: toolName || 'Result', json: result };
}
