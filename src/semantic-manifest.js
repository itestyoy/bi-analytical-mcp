// A PARSED SEMANTIC LAYER, READ FROM THE MANIFEST dbt WROTE (target/semantic_manifest.json) — the one
// reader of what a context's semantic models and metrics ARE, for the project's own layer
// (src/project-semantics.js) and for a context a task built alike. Whatever dbt version and YAML spec
// wrote it, the manifest says the same things; the few places the two specs differ (a simple metric's
// aggregation on the metric in the latest spec, on a measure in the legacy one) are read here, once.
//
// From it: the semantic models (entities, dimensions, measures), every metric with what it reads and
// its DEFINITION in one shape for both specs, and the checks a manifest can be held to without running
// anything (an input that is missing, a time axis that is not one). It does NOT work out what a
// metric can be grouped by — which joins MetricFlow makes, through which entity, at which grain:
// MetricFlow says that itself (src/group-by-items.js), and a second copy of its rules here would be
// one that can disagree with it. What MetricFlow compiles and the warehouse runs is checked by running
// them (preview_semantic_model with validate) — this is only what the declaration itself says.



const hasMeta = (meta) => !!meta && typeof meta === 'object' && Object.keys(meta).length > 0;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));

/** A semantic model's primary entity as it declares it — `primary_entity`, or its entity of type
 *  primary — or null. Shown, and checked (a model with dimensions and none cannot be grouped by). */
function primaryEntity(sm) {
  return sm.primary_entity || (sm.entities || []).find((e) => e.type === 'primary')?.name || null;
}

/** A metric's where filter as the templates it holds (the manifest keeps them as { where_filters }). */
function filterOf(f) {
  if (!f) return undefined;
  const list = (f.where_filters || []).map((w) => w.where_sql_template).filter(Boolean);
  return list.length ? list : undefined;
}

/** A reference to an input metric: { metric, alias?, filter?, offset_window?, offset_to_grain? }. */
function inputOf(ref) {
  if (!ref) return undefined;
  const window = ref.offset_window;
  return compact({
    metric: ref.name,
    alias: ref.alias || undefined,
    filter: filterOf(ref.filter),
    offset_window: window && typeof window === 'object' ? `${window.count} ${window.granularity}` : window || undefined,
    offset_to_grain: ref.offset_to_grain || undefined,
  });
}

/**
 * The layer a semantic manifest describes: { semantic_models, metrics, definition, issues } — every
 * metric with the semantic models it reads (its own aggregation's, and its inputs');
 *   * `definition(metric)`: how it is computed, in one shape for both YAML specs;
 *   * `issues()`: what the declaration itself gets wrong, [{ severity, semantic_model?, metric?, message }].
 */
export function manifestLayer(manifest) {
  const rawModels = manifest?.semantic_models || [];
  const models = rawModels.map((sm) => ({
    name: sm.name,
    ...(sm.description ? { description: sm.description } : {}),
    table: sm.node_relation?.alias || sm.node_relation?.relation_name || null,
    entity: primaryEntity(sm),
    ...(sm.defaults?.agg_time_dimension ? { agg_time_dimension: sm.defaults.agg_time_dimension } : {}),
    entities: (sm.entities || []).map((e) => compact({ name: e.name, type: e.type, expr: e.expr ?? e.name, description: e.description || undefined })),
    ...(hasMeta(sm.config?.meta) ? { meta: sm.config.meta } : {}),
    dimensions: (sm.dimensions || []).map((d) => compact({
      name: d.name, type: d.type,
      grain: d.type === 'time' ? d.type_params?.time_granularity || undefined : undefined,
      expr: d.expr ?? d.name,
      label: d.label || undefined,
      description: d.description || undefined,
      validity: d.type_params?.validity_params ? (d.type_params.validity_params.is_start ? 'start' : d.type_params.validity_params.is_end ? 'end' : undefined) : undefined,
    })),
    // the legacy spec's aggregations; the latest spec has none (a simple metric carries its own)
    measures: (sm.measures || []).map((me) => compact({
      name: me.name, agg: me.agg, expr: me.expr ?? me.name,
      label: me.label || undefined,
      percentile: me.agg === 'percentile' ? me.agg_params?.percentile : undefined,
      agg_time_dimension: me.agg_time_dimension || undefined,
      non_additive_dimension: me.non_additive_dimension ? compact({ dimension: me.non_additive_dimension.name, window: me.non_additive_dimension.window_choice, group_by: me.non_additive_dimension.window_groupings }) : undefined,
      description: me.description || undefined,
    })),
  }));
  const modelNamed = new Map(models.map((m) => [m.name, m]));
  const measureAt = new Map(rawModels.flatMap((sm) => (sm.measures || []).map((me) => [me.name, { sm, me }])));
  const raw = new Map((manifest?.metrics || []).map((m) => [m.name, m]));

  /** The semantic model and aggregation a metric reads DIRECTLY (a simple metric, a measure-based
   *  cumulative or conversion), in one shape for both specs; null for a metric made of metrics. */
  const aggregationOf = (m) => {
    const tp = m?.type_params || {};
    const map = tp.metric_aggregation_params;
    if (map?.semantic_model) {
      const sm = rawModels.find((s) => s.name === map.semantic_model);
      return compact({
        semantic_model: map.semantic_model, agg: map.agg, expr: map.expr ?? tp.expr ?? m.name,
        percentile: map.agg === 'percentile' ? map.agg_params?.percentile : undefined,
        discrete: map.agg === 'percentile' ? !!map.agg_params?.use_discrete_percentile : undefined,
        approximate: map.agg === 'percentile' ? !!map.agg_params?.use_approximate_percentile : undefined,
        agg_time_dimension: map.agg_time_dimension || sm?.defaults?.agg_time_dimension || undefined,
        non_additive_dimension: map.non_additive_dimension ? compact({ dimension: map.non_additive_dimension.name, window: map.non_additive_dimension.window_choice, group_by: map.non_additive_dimension.window_groupings }) : undefined,
      });
    }
    const ref = tp.measure || (m?.type === 'conversion' ? tp.conversion_type_params?.base_measure : null);
    const hit = ref?.name ? measureAt.get(ref.name) : null;
    if (!hit) return null;
    const { sm, me } = hit;
    return compact({
      semantic_model: sm.name, measure: me.name, agg: me.agg, expr: me.expr ?? me.name,
      percentile: me.agg === 'percentile' ? me.agg_params?.percentile : undefined,
      discrete: me.agg === 'percentile' ? !!me.agg_params?.use_discrete_percentile : undefined,
      approximate: me.agg === 'percentile' ? !!me.agg_params?.use_approximate_percentile : undefined,
      agg_time_dimension: me.agg_time_dimension || sm.defaults?.agg_time_dimension || undefined,
      non_additive_dimension: me.non_additive_dimension ? compact({ dimension: me.non_additive_dimension.name, window: me.non_additive_dimension.window_choice, group_by: me.non_additive_dimension.window_groupings }) : undefined,
      measure_filter: filterOf(ref.filter),
      fill_nulls_with: ref.fill_nulls_with ?? undefined,
      join_to_timespine: ref.join_to_timespine || undefined,
    });
  };

  /** The metrics a metric is made of: [{ name, … }] (a ratio's two, a derived one's inputs, …). */
  const inputsOf = (m) => {
    const tp = m?.type_params || {};
    const c = tp.conversion_type_params || {};
    return [tp.numerator, tp.denominator, ...(tp.metrics || []), tp.cumulative_type_params?.metric, c.base_metric, c.conversion_metric].filter((x) => x?.name);
  };

  // what a metric reads: every semantic model under it
  const readsOf = new Map();
  const reads = (name, seen = new Set()) => {
    if (readsOf.has(name)) return readsOf.get(name);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const m = raw.get(name);
    const tp = m?.type_params || {};
    const out = new Set();
    const direct = aggregationOf(m);
    if (direct) out.add(direct.semantic_model);
    for (const me of [...(tp.input_measures || []).map((x) => x?.name), tp.conversion_type_params?.conversion_measure?.name].filter(Boolean)) {
      if (measureAt.has(me)) out.add(measureAt.get(me).sm.name);
    }
    for (const i of inputsOf(m)) for (const s of reads(i.name, seen)) out.add(s);
    readsOf.set(name, out);
    return out;
  };


  /** How a metric is computed, in one shape for both specs. */
  const definition = (name) => {
    const m = raw.get(name);
    if (!m) return null;
    const tp = m.type_params || {};
    const c = tp.conversion_type_params || {};
    const cum = tp.cumulative_type_params || {};
    const window = (w) => (w && typeof w === 'object' ? `${w.count} ${w.granularity}` : w || undefined);
    if (m.type === 'simple') return aggregationOf(m) || {};
    if (m.type === 'ratio') return compact({ numerator: inputOf(tp.numerator), denominator: inputOf(tp.denominator) });
    if (m.type === 'derived') return compact({ expr: tp.expr, inputs: (tp.metrics || []).map(inputOf) });
    if (m.type === 'cumulative') {
      return compact({
        input: cum.metric?.name ? inputOf(cum.metric) : aggregationOf(m) || undefined,
        window: window(cum.window ?? tp.window), grain_to_date: cum.grain_to_date ?? tp.grain_to_date ?? undefined, period_agg: cum.period_agg || undefined,
      });
    }
    if (m.type === 'conversion') {
      const conv = c.conversion_measure?.name ? measureAt.get(c.conversion_measure.name) : null;
      return compact({
        base: c.base_metric?.name ? inputOf(c.base_metric) : aggregationOf(m) || undefined,
        conversion: c.conversion_metric?.name ? inputOf(c.conversion_metric) : conv ? { semantic_model: conv.sm.name, measure: conv.me.name, agg: conv.me.agg, expr: conv.me.expr ?? conv.me.name } : undefined,
        entity: c.entity, calculation: c.calculation, window: window(c.window),
        constant_properties: (c.constant_properties || []).length ? c.constant_properties : undefined,
      });
    }
    return {};
  };

  const metrics = [...raw.values()].map((m) => ({
    name: m.name, type: m.type,
    ...(m.label ? { label: m.label } : {}),
    ...(m.description ? { description: m.description } : {}),
    // what the project says about reading it (additive: false, a threshold, available_from…)
    ...(hasMeta(m.config?.meta) ? { meta: m.config.meta } : {}),
    ...(filterOf(m.filter) ? { filter: filterOf(m.filter) } : {}),
    semantic_models: [...reads(m.name)].sort(),
  })).sort(byName);

  /** What the declaration itself gets wrong — checked without running anything. */
  const issues = () => {
    const out = [];
    const timeDims = (sm) => new Set((sm?.dimensions || []).filter((d) => d.type === 'time').map((d) => d.name));
    for (const sm of models) {
      if (!sm.entity && sm.dimensions.length) out.push({ severity: 'error', semantic_model: sm.name, message: `no primary entity: MetricFlow addresses a dimension through its semantic model's primary entity, so ${sm.dimensions.map((d) => d.name).join(', ')} cannot be grouped by — declare primary_entity (or an entity of type primary)` });
      if (!timeDims(sm).size) out.push({ severity: 'note', semantic_model: sm.name, message: 'no time dimension: its metrics have no time axis, so metric_time and time_range do not apply to them' });
    }
    for (const m of raw.values()) {
      for (const i of inputsOf(m)) if (!raw.has(i.name)) out.push({ severity: 'error', metric: m.name, message: `reads the metric '${i.name}', which the manifest does not define` });
      const agg = aggregationOf(m);
      if (m.type === 'simple' && !agg) { out.push({ severity: 'error', metric: m.name, message: 'a simple metric whose aggregation reads no semantic model of the manifest' }); continue; }
      if (!agg) continue;
      const sm = modelNamed.get(agg.semantic_model);
      if (!sm) { out.push({ severity: 'error', metric: m.name, message: `reads the semantic model '${agg.semantic_model}', which the manifest does not define` }); continue; }
      const times = timeDims(sm);
      if (agg.agg_time_dimension && !times.has(agg.agg_time_dimension)) out.push({ severity: 'error', metric: m.name, message: `its time axis '${agg.agg_time_dimension}' is not a time dimension of ${sm.name} (time dimensions: ${[...times].join(', ') || 'none'})` });
      if (agg.non_additive_dimension && !times.has(agg.non_additive_dimension.dimension)) out.push({ severity: 'error', metric: m.name, message: `its non_additive_dimension '${agg.non_additive_dimension.dimension}' is not a time dimension of ${sm.name}` });
    }
    return out;
  };

  return { semantic_models: models, metrics, definition, issues };
}
