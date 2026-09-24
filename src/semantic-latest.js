// THE SEMANTIC LAYER IN dbt's LATEST YAML SPEC — what dbt v2 (and 1.12+) reads. The context's
// semantic models and metrics are rendered once, in the legacy shape (src/yaml-render.js:
// `semantic_models:` + measures + `metrics:` with type_params); this turns that ONE rendering into
// the latest spec, so both specs always say the same thing:
//   * a semantic model is part of its dbt MODEL's entry (`models: - name: <model>` with
//     `semantic_model: { enabled, name }`), keeping OUR semantic-model name (`users`, `events`) so
//     every group-by path (`user__country`) and metric name stays what it was;
//   * entities and dimensions sit on the COLUMNS they read (`columns[].entity` / `.dimension`,
//     `granularity` on the column); what is an expression, or a second role of a column already
//     taken, goes to `derived_semantics`;
//   * measures are gone: a simple metric carries its own `agg` / `expr` (and percentile,
//     non_additive_dimension, agg_time_dimension, filter). A measure that only a cumulative or
//     conversion metric used becomes a simple metric of its own, which that metric names;
//   * ratio / derived / cumulative / conversion lose `type_params`, and sit at the top level.
//
// dbt v2 parses strictly (an unknown key is an error), so only keys of the latest spec are written.

const PLAIN_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `ref('dim_users')` → `dim_users`. */
function dbtModelOf(sm) {
  const m = String(sm.model || '').match(/ref\(\s*['"]([^'"]+)['"]\s*\)/);
  return m ? m[1] : sm.name;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * A measure's aggregation as a simple metric's keys (the latest spec puts them on the metric).
 * A percentile also records what was ASKED under `config.meta.mcp_percentile`: dbt v2 writes every
 * percentile as approximate (and the fraction as a float32), and its client puts the exact request
 * back into the manifest from this (src/dbt/v2.js).
 */
function aggregationOf(me) {
  const out = { agg: me.agg, expr: me.expr ?? me.name };
  if (me.agg === 'percentile' && me.agg_params) {
    out.percentile = me.agg_params.percentile;
    out.percentile_type = me.agg_params.use_discrete_percentile ? 'discrete' : 'continuous';
    out.config = { meta: { mcp_percentile: { percentile: me.agg_params.percentile, discrete: !!me.agg_params.use_discrete_percentile, approximate: !!me.agg_params.use_approximate_percentile } } };
  }
  if (me.non_additive_dimension) {
    const nad = me.non_additive_dimension;
    out.non_additive_dimension = { name: nad.name, ...(nad.window_choice ? { window_agg: nad.window_choice } : {}), ...(nad.window_groupings ? { group_by: nad.window_groupings } : {}) };
  }
  if (me.agg_time_dimension) out.agg_time_dimension = me.agg_time_dimension;
  return out;
}

/** A metric input (`name` or `{ name, filter, alias, … }`) in the latest spec's shape. */
function inputRef(ref, extra = []) {
  if (typeof ref === 'string') return ref;
  const out = pick(ref, ['name', 'filter', 'alias', ...extra]);
  return Object.keys(out).length === 1 ? out.name : out;
}

const andFilters = (...fs) => {
  const parts = fs.flat().filter(Boolean);
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' AND ');
};

/**
 * { models: [...entries], metrics: [...top-level advanced metrics] } for a legacy document
 * { semantic_models, metrics }.
 */
export function toLatestSpec(doc) {
  const semanticModels = doc.semantic_models || [];
  const legacyMetrics = doc.metrics || [];

  // where each measure lives, and what it aggregates
  const measureOwner = new Map(); // measure name → semantic model name
  const measures = new Map();
  for (const sm of semanticModels) for (const me of sm.measures || []) { measureOwner.set(me.name, sm.name); measures.set(me.name, me); }

  const metricNames = new Set(legacyMetrics.map((m) => m.name));
  const simpleByModel = new Map(semanticModels.map((sm) => [sm.name, []]));
  const topLevel = [];
  const measureAsMetric = new Map(); // measure name → the simple metric that carries it

  const common = (mt) => pick(mt, ['name', 'description', 'label', 'config']);

  /** The simple metric a measure becomes when a cumulative / conversion metric names it. */
  const metricForMeasure = (measureName) => {
    if (measureAsMetric.has(measureName)) return measureAsMetric.get(measureName);
    const me = measures.get(measureName);
    if (!me) throw new Error(`metric references measure '${measureName}', which no semantic model declares`);
    let name = measureName;
    while (metricNames.has(name)) name = `${name}_m`;
    metricNames.add(name);
    simpleByModel.get(measureOwner.get(measureName)).push({ name, type: 'simple', label: me.label || name, ...aggregationOf(me) });
    measureAsMetric.set(measureName, name);
    return name;
  };

  // simple metrics first: a measure one of them already carries unchanged is what a cumulative or
  // conversion metric then names, instead of a second copy
  const ordered = [...legacyMetrics.filter((m) => m.type === 'simple'), ...legacyMetrics.filter((m) => m.type !== 'simple')];
  for (const mt of ordered) {
    const tp = mt.type_params || {};
    if (mt.type === 'simple') {
      const ref = typeof tp.measure === 'string' ? { name: tp.measure } : tp.measure || {};
      const me = measures.get(ref.name);
      if (!me) throw new Error(`simple metric '${mt.name}' references measure '${ref.name}', which no semantic model declares`);
      const agg = aggregationOf(me);
      const out = { ...common(mt), type: 'simple', ...agg };
      if (mt.config && agg.config) out.config = { ...mt.config, meta: { ...(mt.config.meta || {}), ...agg.config.meta } };
      const filter = andFilters(mt.filter, ref.filter);
      if (filter) out.filter = filter;
      if (ref.join_to_timespine !== undefined) out.join_to_timespine = ref.join_to_timespine;
      if (ref.fill_nulls_with !== undefined) out.fill_nulls_with = ref.fill_nulls_with;
      simpleByModel.get(measureOwner.get(ref.name)).push(out);
      if (!measureAsMetric.has(ref.name) && !filter && ref.join_to_timespine === undefined && ref.fill_nulls_with === undefined) measureAsMetric.set(ref.name, out.name);
      continue;
    }
    const out = { ...common(mt), type: mt.type, ...(mt.filter ? { filter: mt.filter } : {}) };
    if (mt.type === 'ratio') {
      out.numerator = inputRef(tp.numerator);
      out.denominator = inputRef(tp.denominator);
    } else if (mt.type === 'derived') {
      out.expr = tp.expr;
      out.input_metrics = (tp.metrics || []).map((m) => pick(m, ['name', 'filter', 'alias', 'offset_window', 'offset_to_grain']));
    } else if (mt.type === 'cumulative') {
      const ref = typeof tp.measure === 'string' ? { name: tp.measure } : tp.measure || {};
      const inner = metricForMeasure(ref.name);
      out.input_metric = ref.filter ? { name: inner, filter: ref.filter } : inner;
      Object.assign(out, pick({ ...tp, ...(tp.cumulative_type_params || {}) }, ['window', 'grain_to_date', 'period_agg']));
    } else if (mt.type === 'conversion') {
      const c = tp.conversion_type_params || {};
      const base = typeof c.base_measure === 'string' ? { name: c.base_measure } : c.base_measure;
      const conv = typeof c.conversion_measure === 'string' ? { name: c.conversion_measure } : c.conversion_measure;
      Object.assign(out, pick(c, ['entity', 'calculation', 'window', 'constant_properties']));
      out.base_metric = base.filter ? { name: metricForMeasure(base.name), filter: base.filter } : metricForMeasure(base.name);
      out.conversion_metric = conv.filter ? { name: metricForMeasure(conv.name), filter: conv.filter } : metricForMeasure(conv.name);
    } else {
      throw new Error(`metric '${mt.name}': type '${mt.type}' has no latest-spec form here`);
    }
    topLevel.push(out);
  }

  const models = semanticModels.map((sm) => {
    const entry = { name: dbtModelOf(sm), semantic_model: { enabled: true, name: sm.name } };
    if (sm.primary_entity) entry.primary_entity = sm.primary_entity;
    const aggTime = sm.defaults?.agg_time_dimension;
    if (aggTime) entry.agg_time_dimension = aggTime;
    const columns = new Map(); // column → its entry, in first-seen order
    const col = (name) => { if (!columns.has(name)) columns.set(name, { name }); return columns.get(name); };
    const derived = { entities: [], dimensions: [] };

    for (const e of sm.entities || []) {
      const source = e.expr ?? e.name;
      const role = { type: e.type, ...(PLAIN_COLUMN.test(source) && source !== e.name ? { name: e.name } : {}), ...pick(e, ['description']) };
      if (PLAIN_COLUMN.test(source) && !columns.get(source)?.entity) col(source).entity = role;
      else derived.entities.push({ name: e.name, type: e.type, expr: source, ...pick(e, ['description']) });
    }
    for (const d of sm.dimensions || []) {
      const source = d.expr ?? d.name;
      const granularity = d.type_params?.time_granularity;
      const validity = d.type_params?.validity_params;
      const role = { type: d.type, ...(source !== d.name ? { name: d.name } : {}), ...pick(d, ['label', 'description']), ...(validity ? { validity_params: validity } : {}) };
      if (PLAIN_COLUMN.test(source) && !columns.get(source)?.dimension) {
        const c = col(source);
        c.dimension = role;
        if (granularity) c.granularity = granularity;
      } else {
        derived.dimensions.push({ name: d.name, type: d.type, expr: source, ...(granularity ? { granularity } : {}), ...pick(d, ['label', 'description']), ...(validity ? { validity_params: validity } : {}) });
      }
    }
    if (columns.size) entry.columns = [...columns.values()];
    if (derived.entities.length || derived.dimensions.length) {
      entry.derived_semantics = {};
      if (derived.entities.length) entry.derived_semantics.entities = derived.entities;
      if (derived.dimensions.length) entry.derived_semantics.dimensions = derived.dimensions;
    }
    const simple = simpleByModel.get(sm.name) || [];
    if (simple.length) entry.metrics = simple;
    return entry;
  });

  return { models, metrics: topLevel };
}

/**
 * A dbt model's own property entry (from the project's YAML) with the semantic layer attached:
 * its config, description and column docs stay; the semantic keys come from `semantic`, and a
 * column both describe is one column carrying both.
 */
export function mergeModelEntry(own, semantic) {
  if (!own) return semantic;
  const merged = { ...own, ...semantic, name: own.name };
  const byName = new Map((own.columns || []).map((c) => [c.name, { ...c }]));
  for (const c of semantic.columns || []) byName.set(c.name, { ...(byName.get(c.name) || {}), ...c });
  if (byName.size) merged.columns = [...byName.values()];
  return merged;
}
