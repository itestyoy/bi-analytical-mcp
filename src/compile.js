// Compile a declarative create/update payload into resolved dbt semantic
// objects (measures/dimensions/metrics) for a single context. All physical SQL
// and namespacing happens here; the renderer just serializes.

import { jsonExtract, sqlLiteral, isNumericType } from './dialect.js';

// dbt 1.11 forbids dunders (__) in object names; use a single underscore.
// (The __ separator is reserved for MetricFlow query *paths* like user__country.)
const NS = (task, name) => `${task}_${name}`;

/** SQL predicate for a list of event names on the events model, or null. */
export function namesToScope(catalog, modelKey, names) {
  if (modelKey !== catalog.anchor || !names?.length) return null;
  const col = catalog.getModel(modelKey).event_name.column;
  if (names.length === 1) return `${col} = ${sqlLiteral(names[0])}`;
  return `${col} in (${names.map(sqlLiteral).join(', ')})`;
}

/** Build the SQL scope predicate from a semantic_models event_scope or null. */
export function scopeExpr(catalog, modelKey, eventScope) {
  return namesToScope(catalog, modelKey, eventScope?.event_name);
}

/** Wrap a base value expression with the scope (M3: scope baked into every measure). */
function applyScope(valueExpr, scope, { numeric }) {
  if (!scope) return valueExpr;
  if (valueExpr === '1') return `CASE WHEN ${scope} THEN 1 ELSE 0 END`;
  return `CASE WHEN ${scope} THEN ${valueExpr} END`;
}

/** Resolve a measure declaration to a dbt measure object (name, agg, expr, ...). */
function compileMeasure(catalog, task, modelKey, decl, smScope) {
  const name = NS(task, decl.name);
  const dialect = catalog.dialect;
  // a per-measure event_name overrides the SM-level scope (needed for funnels/
  // conversion where base and conversion measures target different events).
  const scope = decl.event_name?.length ? namesToScope(catalog, modelKey, decl.event_name) : smScope;
  const props = catalog.getModel(catalog.anchor).properties || {};

  // sum_boolean: sum a boolean per row (e.g. "did event X") — the scope IS the boolean.
  if (decl.agg === 'sum_boolean') {
    return { name, agg: 'sum_boolean', expr: scope || 'true' };
  }

  let agg = decl.agg;
  let valueExpr;

  const field = decl.field;
  if (field === '*' || field === undefined) {
    if (decl.agg !== 'count' && decl.agg !== 'sum') {
      throw new Error(`measure '${decl.name}': field '*' is only valid with agg count/sum`);
    }
    agg = 'sum'; // count(*) rendered as sum(1) so scope folds cleanly
    valueExpr = '1';
  } else if (modelKey === catalog.anchor && props[field]) {
    // numeric event property
    if (!isNumericType(props[field].type)) {
      throw new Error(`measure '${decl.name}': property '${field}' is not numeric`);
    }
    valueExpr = jsonExtract(dialect, catalog.getModel(modelKey).event_name ? 'event_properties' : 'event_properties', field, props[field].type);
  } else {
    // a physical column (entity key like user_id/session_id, or model column)
    valueExpr = field;
  }

  const m = { name, agg, expr: applyScope(valueExpr, scope, { numeric: true }) };
  if (decl.agg === 'percentile') {
    if (typeof decl.percentile !== 'number') throw new Error(`measure '${decl.name}': percentile required`);
    m.agg = 'percentile';
    m.agg_params = { percentile: decl.percentile, use_discrete_percentile: false };
  }
  return m;
}

/** Resolve a dimension declaration to a dbt dimension object. */
function compileDimension(catalog, task, modelKey, decl) {
  const dialect = catalog.dialect;
  if (decl.source === 'event_property') {
    if (modelKey !== catalog.anchor) throw new Error('event_property dimensions only valid on the events model');
    const props = catalog.getModel(catalog.anchor).properties || {};
    const p = props[decl.property];
    if (!p) throw new Error(`unknown event property: ${decl.property}`);
    if (decl.as_type === 'time') throw new Error('time dimensions from JSON properties are not allowed (m2)');
    return { name: NS(task, decl.property), type: 'categorical', expr: jsonExtract(dialect, 'event_properties', decl.property, p.type) };
  }
  if (decl.source === 'model_column') {
    const dim = { name: NS(task, decl.column), type: decl.as_type || 'categorical', expr: decl.column };
    if (dim.type === 'time') dim.type_params = { time_granularity: decl.grain || 'day' };
    return dim;
  }
  throw new Error(`unknown dimension source: ${decl.source}`);
}

/**
 * Compile a full declaration. Returns resolved additions per model, metric
 * specs (incl. auto-created simple metrics for ratio), used models, and the
 * declared measure/metric names (namespaced).
 */
export function compileDeclaration(catalog, decl) {
  const task = decl.name;
  if (!task) throw new Error('name (task) is required');

  const additions = {}; // modelKey -> { measures:[], dimensions:[] }
  const declaredMeasures = new Set(); // namespaced
  const ensure = (k) => (additions[k] ||= { measures: [], dimensions: [] });

  const usedModels = new Set([catalog.anchor]);
  for (const k of decl.use_base_models || []) {
    if (!catalog.models[k]) throw new Error(`use_base_models: unknown model '${k}'`);
    usedModels.add(k);
  }

  // event scope is taken from the events semantic_models entry (if any)
  let eventScope = null;
  for (const sm of decl.semantic_models || []) {
    const modelKey = sm.from;
    if (!catalog.models[modelKey]) throw new Error(`semantic_models.from: unknown model '${modelKey}'`);
    usedModels.add(modelKey);
    const scope = scopeExpr(catalog, modelKey, sm.event_scope);
    if (modelKey === catalog.anchor && scope) eventScope = scope;
    for (const d of sm.dimensions || []) ensure(modelKey).dimensions.push(compileDimension(catalog, task, modelKey, d));
    for (const m of sm.measures || []) {
      const cm = compileMeasure(catalog, task, modelKey, m, scope);
      declaredMeasures.add(cm.name);
      ensure(modelKey).measures.push(cm);
    }
  }

  const baseMeasureRefs = new Set(catalog.baseMeasureRefs());
  const resolveMeasure = (ref) => {
    const nsName = NS(task, ref);
    if (declaredMeasures.has(nsName)) return nsName;
    if (baseMeasureRefs.has(ref)) return ref; // base measure (already global name)
    throw new Error(`metric references unknown measure '${ref}'`);
  };

  const metrics = [];
  const metricNames = new Set();
  const simpleByMeasure = new Map(); // measureName -> simple metric name
  const addMetric = (m) => {
    if (metricNames.has(m.name)) return;
    if (!m.label) m.label = m.name; // dbt 1.11+ requires a label on every metric
    metricNames.add(m.name);
    metrics.push(m);
  };
  // ensure a simple metric wraps a measure (for ratio operands)
  const ensureSimpleFor = (measureName) => {
    if (simpleByMeasure.has(measureName)) return simpleByMeasure.get(measureName);
    const name = measureName; // simple metric shares the measure's name
    addMetric({ name, type: 'simple', type_params: { measure: { name: measureName } } });
    simpleByMeasure.set(measureName, name);
    return name;
  };

  for (const md of decl.metrics || []) {
    const name = NS(task, md.name);
    if (md.type === 'simple') {
      const measureName = resolveMeasure(md.measure.name);
      const tp = { measure: { name: measureName } };
      if (typeof md.fill_nulls_with === 'number') tp.measure.fill_nulls_with = md.fill_nulls_with;
      addMetric({ name, type: 'simple', type_params: tp });
      simpleByMeasure.set(measureName, name);
    } else if (md.type === 'ratio') {
      const num = ensureSimpleFor(resolveMeasure(md.numerator.name));
      const den = ensureSimpleFor(resolveMeasure(md.denominator.name));
      addMetric({ name, type: 'ratio', type_params: { numerator: { name: num }, denominator: { name: den } } });
    } else if (md.type === 'cumulative') {
      const ctp = {};
      if (md.window) ctp.window = md.window;
      if (md.grain_to_date) ctp.grain_to_date = md.grain_to_date;
      if (md.period_agg) ctp.period_agg = md.period_agg;
      addMetric({ name, type: 'cumulative', type_params: { measure: { name: resolveMeasure(md.measure.name) }, cumulative_type_params: ctp } });
    } else if (md.type === 'derived') {
      const inputs = md.metrics.map((x) => ({ name: NS(task, x.name), ...(x.alias ? { alias: x.alias } : {}) }));
      addMetric({ name, type: 'derived', type_params: { expr: md.expr, metrics: inputs } });
    } else if (md.type === 'conversion') {
      const ctp = {
        base_measure: { name: resolveMeasure(md.base_measure.name) },
        conversion_measure: { name: resolveMeasure(md.conversion_measure.name) },
        entity: md.entity || 'user',
        window: md.window,
        calculation: md.calculation || 'conversion_rate',
      };
      if (md.constant_properties) ctp.constant_properties = md.constant_properties;
      addMetric({ name, type: 'conversion', type_params: { conversion_type_params: ctp } });
    } else {
      throw new Error(`unknown metric type: ${md.type}`);
    }
  }

  return {
    task,
    additions,
    metrics,
    usedModels: [...usedModels],
    measureNames: [...declaredMeasures],
    metricNames: [...metricNames],
  };
}
