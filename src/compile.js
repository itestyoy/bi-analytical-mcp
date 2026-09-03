// Compile a declarative create/update payload into resolved dbt semantic
// objects (measures/dimensions/metrics) for a single context. All physical SQL
// and namespacing happens here; the renderer just serializes.

import { jsonExtract, sqlLiteral, isNumericType, castExpr } from './dialect.js';

// dbt 1.11 forbids dunders (__) in object names; use a single underscore.
// (The __ separator is reserved for MetricFlow query *paths* like user__country.)
const NS = (task, name) => `${task}_${name}`;

/** Throw a compile error that CARRIES the input field it refers to — the engine
 *  surfaces it as ToolError.field so the caller knows exactly what to fix. */
function fail(msg, field) { const e = new Error(msg); e.field = field; throw e; }

// The catalog owns the bare-vs-qualified name rules (Catalog.eventNameFor / .propertyFor);
// these two wrappers only re-throw with the input `field` the engine reports back.
const HINT = 'declare it on a semantic model built from that fact';
function factName(catalog, modelKey, name, field) {
  try { return catalog.eventNameFor(modelKey, name, { hint: HINT }); } catch (e) { return fail(e.message, field); }
}
function factProp(catalog, modelKey, name, field) {
  try { return catalog.propertyFor(modelKey, name, { hint: HINT }); } catch (e) { return fail(e.message, field); }
}

/** SQL predicate for a list of event names on an events FACT, or null. */
export function namesToScope(catalog, modelKey, names) {
  if (!catalog.isFact(modelKey) || !names?.length) return null;
  const col = catalog.getModel(modelKey).event_name.column;
  const vals = names.map((n) => factName(catalog, modelKey, n, 'event_name'));
  if (vals.length === 1) return `${col} = ${sqlLiteral(vals[0])}`;
  return `${col} in (${vals.map(sqlLiteral).join(', ')})`;
}

/** Build the SQL scope predicate from a semantic_models event_scope or null. */
export function scopeExpr(catalog, modelKey, eventScope) {
  return namesToScope(catalog, modelKey, eventScope?.event_name);
}

/** SQL expression for an event property — the catalog's one rule (flat column or JSON extract). */
function propExpr(catalog, modelKey, name, _spec) {
  return catalog.propertyExpr(modelKey, name, catalog.dialect);
}

/** SQL for a single event_data property condition (used for funnel-step scoping). */
function propCond(catalog, modelKey, cond) {
  const found = factProp(catalog, modelKey, cond.property, 'where.property');
  if (!found) fail(`unknown event property in where: '${cond.property}' on model '${modelKey}'. Discover properties via semantic_index({ event })`, 'where.property');
  const lhs = propExpr(catalog, modelKey, found.name, found.spec);
  switch (cond.op) {
    case 'eq': return `${lhs} = ${sqlLiteral(cond.value)}`;
    case 'neq': return `${lhs} != ${sqlLiteral(cond.value)}`;
    case 'gt': return `${lhs} > ${sqlLiteral(cond.value)}`;
    case 'gte': return `${lhs} >= ${sqlLiteral(cond.value)}`;
    case 'lt': return `${lhs} < ${sqlLiteral(cond.value)}`;
    case 'lte': return `${lhs} <= ${sqlLiteral(cond.value)}`;
    case 'in':
    case 'not_in': {
      const arr = Array.isArray(cond.value) ? cond.value : [cond.value];
      return `${lhs} ${cond.op === 'in' ? 'in' : 'not in'} (${arr.map(sqlLiteral).join(', ')})`;
    }
    default: fail(`unsupported where op: ${cond.op}`, 'where.op');
  }
}

/** Combine event_name scope + property conditions into one boolean (or null). */
function measureScope(catalog, modelKey, decl, smScope) {
  const evScope = decl.event_name?.length ? namesToScope(catalog, modelKey, decl.event_name) : smScope;
  const propParts = (decl.where || []).map((c) => propCond(catalog, modelKey, c));
  return [evScope, ...propParts].filter(Boolean).join(' AND ') || null;
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
  // a per-measure event_name (+ optional property `where`) overrides the SM-level
  // scope — this is how a funnel step is defined as "event + property value".
  const scope = measureScope(catalog, modelKey, decl, smScope);

  // sum_boolean: sum a boolean per row (e.g. "did event X") — the scope IS the boolean.
  if (decl.agg === 'sum_boolean') {
    return { name, agg: 'sum_boolean', expr: scope || 'true' };
  }

  let agg = decl.agg;
  let valueExpr;
  let found = null; // the event property, when `field` names one (resolved once)

  const field = decl.field;
  if (field === '*' || field === undefined) {
    if (decl.agg !== 'count' && decl.agg !== 'sum') {
      fail(`measure '${decl.name}': field '*' is only valid with agg count/sum`, 'measures.field');
    }
    agg = 'sum'; // count(*) rendered as sum(1) so scope folds cleanly
    valueExpr = '1';
  } else if (catalog.isFact(modelKey) && (found = factProp(catalog, modelKey, field, 'measures.field'))) {
    // an event property; numeric aggregations need a numeric type OR an explicit cast
    // (e.g. complete_time arrives as STRING upstream → add "cast": "numeric").
    const { name: propName, spec } = found;
    const numericAgg = ['sum', 'average', 'median', 'min', 'max', 'percentile'].includes(decl.agg);
    if (numericAgg && !isNumericType(spec.type) && !decl.cast) {
      fail(`measure '${decl.name}': property '${field}' is type '${spec.type}'; add "cast":"numeric" to aggregate it as a number`, 'measures.cast');
    }
    valueExpr = propExpr(catalog, modelKey, propName, spec);
  } else if (catalog.aggregatableField(modelKey, field)) {
    // An AMOUNT the schema marks aggregatable on this source. The schema says only WHAT may be
    // aggregated (a column, or an expression over columns); the function is this caller's choice.
    const amount = catalog.aggregatableField(modelKey, field);
    const numericAgg = ['sum', 'average', 'median', 'min', 'max', 'percentile'].includes(decl.agg);
    if (numericAgg && amount.type && !isNumericType(amount.type) && !decl.cast) {
      fail(`measure '${decl.name}': '${field}' is type '${amount.type}'; add "cast":"numeric" to aggregate it as a number`, 'measures.cast');
    }
    valueExpr = amount.expr;
  } else {
    // a physical column of THIS model (an entity key like the player id, or any real column).
    // Anything else would compile into SQL the warehouse rejects — refuse it here, with the fix.
    const columns = new Set((catalog.modelColumns(modelKey) || []).map((col) => col.name));
    for (const parts of Object.values(catalog.entitiesOf(modelKey) || {})) for (const part of parts.key || []) columns.add(part.column);
    const pe = catalog.getModel(modelKey).primary_entity;
    if (pe && typeof pe === 'object') for (const part of pe.key || []) columns.add(part.column);
    if (!columns.has(field)) {
      fail(`measure '${decl.name}': '${field}' is not a column, event property or aggregatable amount of '${modelKey}'. semantic_index({ model: '${modelKey}' }) lists its columns and amounts; a payload property is addressed by its property name.`, 'measures.field');
    }
    valueExpr = field;
  }
  if (decl.cast) valueExpr = castExpr(catalog.dialect, valueExpr, decl.cast);

  const m = { name, agg, expr: applyScope(valueExpr, scope, { numeric: true }) };
  if (decl.agg === 'percentile') {
    if (typeof decl.percentile !== 'number') fail(`measure '${decl.name}': percentile required`, 'measures.percentile');
    m.agg = 'percentile';
    m.agg_params = { percentile: decl.percentile, use_discrete_percentile: false };
  }
  return m;
}

/** Resolve a dimension declaration to a dbt dimension object. */
function compileDimension(catalog, task, modelKey, decl) {
  if (decl.source === 'event_property') {
    if (!catalog.isFact(modelKey)) fail(`event_property dimensions are only valid on an events fact (${catalog.facts.join(', ')}), not on '${modelKey}'`, 'dimensions.source');
    const found = factProp(catalog, modelKey, decl.property, 'dimensions.property');
    if (!found) fail(`unknown event property: '${decl.property}' on model '${modelKey}'. Discover properties via semantic_index({ event })`, 'dimensions.property');
    if (decl.as_type === 'time') fail('time dimensions from JSON properties are not allowed', 'dimensions.as_type');
    return { name: NS(task, found.name), type: 'categorical', expr: propExpr(catalog, modelKey, found.name, found.spec) };
  }
  if (decl.source === 'model_column') {
    const dim = { name: NS(task, decl.column), type: decl.as_type || 'categorical', expr: decl.column };
    if (dim.type === 'time') dim.type_params = { time_granularity: decl.grain || 'day' };
    return dim;
  }
  fail(`unknown dimension source: ${decl.source}`, 'dimensions.source');
}

/**
 * Compile a full declaration. Returns resolved additions per model, metric
 * specs (incl. auto-created simple metrics for ratio), used models, and the
 * declared measure/metric names (namespaced).
 */
export function compileDeclaration(catalog, decl) {
  const task = decl.name;
  if (!task) fail('name (task) is required', 'name');

  const additions = {}; // modelKey -> { measures:[], dimensions:[] }
  const declaredMeasures = new Set(); // namespaced
  const ensure = (k) => (additions[k] ||= { measures: [], dimensions: [] });

  // The models this task READS — taken from the payload, never assumed. A context carries only
  // the sources it was asked for, so a task on one events source does not drag in another.
  const usedModels = new Set();
  for (const k of decl.use_base_models || []) {
    if (!catalog.models[k]) fail(`use_base_models: unknown model '${k}'. Known models: ${Object.keys(catalog.models).join(', ')}${catalog.unavailableHint?.(k) || ''}`, 'use_base_models');
    usedModels.add(k);
  }

  for (const sm of decl.semantic_models || []) {
    const modelKey = sm.from;
    if (!catalog.models[modelKey]) fail(`semantic_models.from: unknown model '${modelKey}'. Known models: ${Object.keys(catalog.models).join(', ')}${catalog.unavailableHint?.(modelKey) || ''}`, 'semantic_models.from');
    usedModels.add(modelKey);
    // Each fact scopes its OWN measures: the scope is baked into every measure expr below.
    const scope = scopeExpr(catalog, modelKey, sm.event_scope);
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
    if (baseMeasureRefs.has(ref)) { // base measure (already a global name) — load its own model
      const owner = catalog.modelOwningMeasure(ref);
      if (owner) usedModels.add(owner);
      return ref;
    }
    fail(`metric references unknown measure '${ref}'. Declared in this task: ${[...declaredMeasures].join(', ') || '(none)'}`, 'metrics.measure');
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
      // derived expr is a formula over the input metric aliases only. Enforce a
      // safe grammar: allowed charset (no quotes/semicolons), and every
      // identifier must be a declared input metric alias or a safe math fn.
      const expr = md.expr || '';
      if (!/^[A-Za-z0-9_+\-*/().,\s]+$/.test(expr)) {
        fail(`derived metric '${md.name}': expr contains illegal characters (only metric names, numbers, + - * / ( ) . , allowed)`, 'metrics.expr');
      }
      const aliases = new Set((md.metrics || []).map((x) => x.alias || x.name));
      const SAFE_FNS = new Set(['nullif', 'coalesce', 'abs', 'round', 'least', 'greatest', 'floor', 'ceil', 'ceiling', 'power', 'sqrt', 'ln', 'log', 'exp', 'mod']);
      for (const tok of expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        if (!aliases.has(tok) && !SAFE_FNS.has(tok)) {
          fail(`derived metric '${md.name}': expr references unknown identifier '${tok}' (only input metric names + safe math functions allowed)`, 'metrics.expr');
        }
      }
      // input metrics are namespaced; alias each to the raw name so the user's
      // `expr` (written with raw metric names) resolves correctly in MetricFlow.
      const inputs = md.metrics.map((x) => ({ name: NS(task, x.name), alias: x.alias || x.name }));
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
      fail(`unknown metric type: ${md.type}`, 'metrics.type');
    }
  }

  if (!usedModels.size) {
    fail('this task reads no source: declare at least one semantic_models entry (from: <source>) or use_base_models', 'semantic_models');
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
