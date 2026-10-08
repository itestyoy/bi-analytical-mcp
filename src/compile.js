// Compile a declarative create/update payload into resolved dbt semantic
// objects (measures/dimensions/metrics) for a single context. All physical SQL
// and namespacing happens here; the renderer just serializes.

import { isNumericType } from './dialects/base.js';
import { getDialect } from './dialects/index.js';
import { NUMERIC_AGGS } from './catalog.js';
import { comparison, conditionsSql } from './conditions.js';

// dbt 1.11 forbids dunders (__) in object names; use a single underscore.
// (The __ separator is reserved for MetricFlow query *paths* like user__country.)
// Exported so an update names what it removes by the same rule (src/engine/semantic-build.js).
export const NS = (task, name) => `${task}_${name}`;

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

/** SQL expression for an event property — the catalog's one rule (flat column or JSON extract). */
function propExpr(catalog, modelKey, name) {
  return catalog.propertyExpr(modelKey, name, catalog.dialect);
}

/** The operators whose constants ARE events — a pattern's (like, contains, …) is text, not an event. */
const EVENT_VALUE_OPS = new Set(['eq', 'neq', 'in', 'not_in']);

/**
 * SQL for one condition of a semantic model on a `field` — a column of the model (its event name
 * spelled as the source stores it), or a scalar payload property read where it is stored.
 */
function fieldCond(catalog, modelKey, cond) {
  const m = catalog.getModel(modelKey);
  const columns = new Set(catalog.modelColumns(modelKey).map((c) => c.name));
  let lhs; let value = cond.value;
  if (catalog.isFact(modelKey) && cond.field === m.event_name?.column) {
    lhs = cond.field;
    // an event of the source, as it stores it — one that is not its own is refused, naming the owner
    if (EVENT_VALUE_OPS.has(cond.op) && value !== undefined && value !== null) value = Array.isArray(value) ? value.map((v) => factName(catalog, modelKey, v, 'where.value')) : factName(catalog, modelKey, value, 'where.value');
  } else if (catalog.isFact(modelKey) && catalog.scalarEventProps(modelKey).includes(cond.field)) {
    const found = factProp(catalog, modelKey, cond.field, 'where.field');
    lhs = propExpr(catalog, modelKey, found.name);
  } else if (columns.has(cond.field)) lhs = cond.field;
  else fail(`where: '${cond.field}' is not a column or scalar property of '${modelKey}'. semantic_index({ request: { model: '${modelKey}' } }) lists them`, 'where.field');
  try { return comparison(lhs, cond.op, value); } catch (e) { return fail(e.message, 'where.op'); }
}

/** A semantic model's conditions (its own, or a measure's) as one boolean (or null). */
function conditionsOf(catalog, modelKey, list) {
  return conditionsSql(list, (c) => fieldCond(catalog, modelKey, c)).join(' AND ') || null;
}

/** The rows a measure folds: the semantic model's `where` AND the measure's own. */
function measureScope(catalog, modelKey, decl, smScope) {
  return [smScope, conditionsOf(catalog, modelKey, decl.where)].filter(Boolean).join(' AND ') || null;
}

/** Wrap a base value expression with the scope (M3: scope baked into every measure). */
function applyScope(valueExpr, scope) {
  if (!scope) return valueExpr;
  if (valueExpr === '1') return `CASE WHEN ${scope} THEN 1 ELSE 0 END`;
  return `CASE WHEN ${scope} THEN ${valueExpr} END`;
}

/** Resolve a measure declaration to a dbt measure object (name, agg, expr, ...). */
function compileMeasure(catalog, task, modelKey, decl, smScope) {
  const name = NS(task, decl.name);
  // the model's where AND the measure's own — a funnel step is a measure whose where names the
  // event and a property value
  const scope = measureScope(catalog, modelKey, decl, smScope);

  // sum_boolean: sum a boolean per row (e.g. "did event X") — the scope IS the boolean.
  if (decl.agg === 'sum_boolean') {
    return { name, agg: 'sum_boolean', expr: scope || 'true' };
  }

  let agg = decl.agg;
  let valueExpr;
  let found = null; // the event property, when `field` names one (resolved once)

  const field = decl.field;
  if (field === undefined) {
    if (decl.agg !== 'count') fail(`measure '${decl.name}': ${decl.agg} needs a field to fold — only a count counts rows without one`, 'measures.field');
    agg = 'sum'; // count(*) rendered as sum(1) so scope folds cleanly
    valueExpr = '1';
  } else if (catalog.isFact(modelKey) && (found = factProp(catalog, modelKey, field, 'measures.field'))) {
    // an event property; numeric aggregations need a numeric type OR an explicit cast
    // (e.g. complete_time arrives as STRING upstream → add "cast": "numeric").
    const { name: propName, spec } = found;
    if (NUMERIC_AGGS.has(decl.agg) && !isNumericType(spec.type) && !decl.cast) {
      fail(`measure '${decl.name}': property '${field}' is type '${spec.type}'; add "cast":"numeric" to aggregate it as a number`, 'measures.cast');
    }
    valueExpr = propExpr(catalog, modelKey, propName);
  } else if (catalog.aggregatableField(modelKey, field)) {
    // An AMOUNT the schema marks aggregatable on this source. The schema says only WHAT may be
    // aggregated (a column, or an expression over columns); the function is this caller's choice.
    const amount = catalog.aggregatableField(modelKey, field);
    if (NUMERIC_AGGS.has(decl.agg) && amount.type && !isNumericType(amount.type) && !decl.cast) {
      fail(`measure '${decl.name}': '${field}' is type '${amount.type}'; add "cast":"numeric" to aggregate it as a number`, 'measures.cast');
    }
    valueExpr = amount.expr;
  } else {
    // a physical column of THIS model (an entity key like the player id, or any real column).
    // Anything else would compile into SQL the warehouse rejects — refuse it here, with the fix.
    // The same set the measure `field` enum is built from (schema.js) — asked for once, here, so
    // the tool cannot offer a field this then rejects.
    const columns = new Set([...(catalog.modelColumns(modelKey) || []).map((col) => col.name), ...catalog.entityKeyColumns(modelKey)]);
    if (!columns.has(field)) {
      fail(`measure '${decl.name}': '${field}' is not a column, event property or aggregatable amount of '${modelKey}'. semantic_index({ request: { model: '${modelKey}' } }) lists its columns and amounts; a payload property is addressed by its property name.`, 'measures.field');
    }
    valueExpr = field;
  }
  if (decl.cast) valueExpr = getDialect(catalog.dialect).castExpr(valueExpr, decl.cast);

  const m = { name, agg, expr: applyScope(valueExpr, scope) };
  if (decl.agg === 'percentile') {
    if (typeof decl.percentile !== 'number') fail(`measure '${decl.name}': percentile required`, 'measures.percentile');
    m.agg = 'percentile';
    m.agg_params = { percentile: decl.percentile, use_discrete_percentile: false };
  }
  return m;
}

/**
 * One declared dimension → its manifest form. `_attribute` records what the caller DECLARED (the
 * attribute name it was given) next to the namespaced name
 * the manifest uses: they are read back when the tools describe or resolve the dimension, and are
 * stripped before the manifest is written (see yaml-render). Recovering them from the generated
 * identifier instead would mis-split the moment one task name is a prefix of another.
 */
function compileDimension(catalog, task, modelKey, decl) {
  // a `field` of the model: a column (a time dimension when asked), or a scalar payload property
  const isColumn = catalog.modelDimensionColumns(modelKey).includes(decl.field);
  const isProperty = catalog.isFact(modelKey) && catalog.scalarEventProps(modelKey).includes(decl.field);
  if (isColumn && (decl.as_type === 'time' || !isProperty)) {
    const dim = { name: NS(task, decl.field), type: decl.as_type || 'categorical', expr: decl.field, _attribute: decl.field };
    if (dim.type === 'time') dim.type_params = { time_granularity: decl.grain || 'day' };
    return dim;
  }
  if (isProperty) {
    if (decl.as_type === 'time') fail(`dimension '${decl.field}': a payload property is categorical — a time dimension is a column`, 'dimensions.as_type');
    const found = factProp(catalog, modelKey, decl.field, 'dimensions.field');
    return { name: NS(task, found.name), type: 'categorical', expr: propExpr(catalog, modelKey, found.name), _attribute: found.name };
  }
  fail(`dimension '${decl.field}' is not a groupable column or scalar property of '${modelKey}'. semantic_index({ request: { model: '${modelKey}' } }) lists them`, 'dimensions.field');
}

/** The measures a compiled metric reads itself: a simple or cumulative metric's measure. */
function ownMeasures(metric) {
  const tp = metric?.type_params || {};
  const name = (v) => (typeof v === 'string' ? v : v?.name);
  return [tp.measure].map(name).filter(Boolean);
}

/** The metrics a compiled metric is built from: a ratio's numerator and denominator, a derived metric's inputs. */
export function inputMetrics(metric) {
  const tp = metric?.type_params || {};
  const name = (v) => (typeof v === 'string' ? v : v?.name);
  return [tp.numerator, tp.denominator, ...(tp.metrics || [])].map(name).filter(Boolean);
}

/**
 * EVERY measure a compiled metric reads — its own and, through the metrics it is built from, theirs
 * (`metrics`: the context's compiled metrics). The one walk of that graph: which metrics a removed
 * measure takes with it, and which a model that cannot carry measures drops before dbt parses them.
 */
export function measureRefs(metric, metrics = []) {
  const byName = new Map(metrics.map((m) => [m.name, m]));
  const found = new Set();
  const seen = new Set();
  const walk = (m) => {
    if (!m || seen.has(m.name)) return;
    seen.add(m.name);
    for (const x of ownMeasures(m)) found.add(x);
    for (const n of inputMetrics(m)) walk(byName.get(n));
  };
  walk(metric);
  return found;
}

/**
 * Compile a full declaration. Returns resolved additions per model, metric
 * specs (incl. auto-created simple metrics for ratio), used models, and the
 * declared measure/metric names (namespaced). What the context declared into already holds (an
 * update's, or a declaration beside a task already there): `measures`, the stored names of its
 * measures, which a metric reads by the name it was declared under or the stored one; `metrics`,
 * its compiled metrics, which a derived metric may be built from and a ratio may read through.
 * Neither may be declared again under the same stored name: the context would keep one of the two.
 */
export function compileDeclaration(catalog, decl, { measures = [], metrics: contextMetrics = [] } = {}) {
  const task = decl.name;
  if (!task) fail('name (task) is required', 'name');

  const additions = {}; // modelKey -> { measures:[], dimensions:[] }
  const existingMeasures = new Set(measures); // namespaced, declared before this call
  const declaredMeasures = new Set(); // namespaced
  const ensure = (k) => (additions[k] ||= { measures: [], dimensions: [] });
  // what a refusal lists, each name said as what it is: declared in this call, or already in the context
  const inScope = (kind, inCall, inContext) => [
    inCall.length ? `Declared in this call: ${inCall.join(', ')}.` : `This call declares no ${kind}.`,
    inContext.length ? `Already in this context: ${inContext.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

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
    // Each semantic model scopes its OWN measures: its where is baked into every measure expr below.
    const scope = conditionsOf(catalog, modelKey, sm.where);
    for (const d of sm.dimensions || []) ensure(modelKey).dimensions.push(compileDimension(catalog, task, modelKey, d));
    for (const m of sm.measures || []) {
      const cm = compileMeasure(catalog, task, modelKey, m, scope);
      // two measures of one name would both be written, and dbt refuses the duplicate at parse
      if (declaredMeasures.has(cm.name)) fail(`measure '${m.name}' is declared twice in this call (stored as '${cm.name}')`, 'measures.name');
      if (existingMeasures.has(cm.name)) {
        fail(`measure '${m.name}' is already in this context, as '${cm.name}'. To replace it, remove it and declare it again in one update: build_semantic_model({ request: { action: 'update', context_id, remove: { measures: ['${cm.name}'] }, semantic_models: [...] } }) — with cascade: true when metrics read it`, 'measures.name');
      }
      declaredMeasures.add(cm.name);
      ensure(modelKey).measures.push(cm);
    }
  }

  const baseMeasureRefs = new Set(catalog.baseMeasureRefs());
  const resolveMeasure = (ref) => {
    const nsName = NS(task, ref);
    if (declaredMeasures.has(nsName) || existingMeasures.has(nsName)) return nsName;
    // …or by the stored name a context describes it under ('ret_n'), as remove takes it too
    if (declaredMeasures.has(ref) || existingMeasures.has(ref)) return ref;
    if (baseMeasureRefs.has(ref)) { // base measure (already a global name) — load its own model
      const owner = catalog.modelOwningMeasure(ref);
      if (owner) usedModels.add(owner);
      return ref;
    }
    // listed as stored — a name a metric takes as it is, beside the one it was declared under
    fail(`metric references unknown measure '${ref}'. ${inScope('measure', [...declaredMeasures], [...existingMeasures])}`, 'metrics.measure');
  };

  const existingMetrics = new Map(contextMetrics.map((m) => [m.name, m]));
  const metrics = [];
  const metricNames = new Set();
  const declaredMetrics = new Set(); // the ones the caller named, beside those a ratio made
  const derivedInputs = []; // derived metrics, their inputs resolved once every metric is known
  const simpleByMeasure = new Map(); // measureName -> simple metric name
  const addMetric = (m) => {
    if (!m.label) m.label = m.name; // dbt 1.11+ requires a label on every metric
    metricNames.add(m.name);
    metrics.push(m);
  };
  // a metric a ratio may read a measure through: a simple metric over exactly that measure
  const simpleOver = (m, measureName) => m?.type === 'simple' && ownMeasures(m)[0] === measureName;
  const described = (m) => `a ${m.type} metric${ownMeasures(m).length ? ` over measure '${ownMeasures(m)[0]}'` : ''}`;
  // A metric the caller declares takes a name nothing else holds: of two definitions under one name
  // the context would keep one and drop the other without a word.
  const declareMetric = (m, md) => {
    if (existingMetrics.has(m.name)) {
      fail(`metric '${md.name}' is already in this context, as '${m.name}'. To replace it, remove it and declare it again in one update: build_semantic_model({ request: { action: 'update', context_id, remove: { metrics: ['${m.name}'] }, metrics: [...] } }) — with cascade: true when other metrics are built from it`, 'metrics.name');
    }
    if (declaredMetrics.has(m.name)) fail(`metric '${md.name}' is declared twice in this call (stored as '${m.name}')`, 'metrics.name');
    declaredMetrics.add(m.name);
    const made = metrics.findIndex((x) => x.name === m.name); // made by a ratio above, to read a measure through
    if (made < 0) return addMetric(m);
    if (!simpleOver(m, ownMeasures(metrics[made])[0])) {
      fail(`metric '${md.name}' is stored as '${m.name}', the name of the simple metric over measure '${ownMeasures(metrics[made])[0]}' that a ratio of this call reads it through. Give the metric another name`, 'metrics.name');
    }
    if (!m.label) m.label = m.name;
    metrics[made] = m; // the same reading: the ratio reads the caller's definition (its fill_nulls_with)
  };
  // a ratio reads each measure through a simple metric over it: one already declared over that
  // measure, else one named as the measure is — never a different metric that holds that name
  const ensureSimpleFor = (measureName, ref, md) => {
    if (simpleByMeasure.has(measureName)) return simpleByMeasure.get(measureName);
    const name = measureName; // simple metric shares the measure's name
    const holder = metrics.find((x) => x.name === name) || existingMetrics.get(name);
    if (holder && !simpleOver(holder, measureName)) {
      const inContext = !metricNames.has(name);
      fail(`ratio '${md.name}' reads measure '${ref}' through a simple metric named '${name}', and '${name}' is already ${described(holder)} ${inContext ? 'in this context' : 'of this call'}. Declare a simple metric over measure '${ref}' under another name before the ratio, and the ratio reads that one${inContext ? `; or remove '${name}' in the update that declares the ratio` : ''}`, 'metrics.name');
    }
    if (!holder) addMetric({ name, type: 'simple', type_params: { measure: { name: measureName } } });
    simpleByMeasure.set(measureName, name);
    return name;
  };

  for (const md of decl.metrics || []) {
    const name = NS(task, md.name);
    if (md.type === 'simple') {
      const measureName = resolveMeasure(md.measure.name);
      const tp = { measure: { name: measureName } };
      if (typeof md.fill_nulls_with === 'number') tp.measure.fill_nulls_with = md.fill_nulls_with;
      declareMetric({ name, type: 'simple', type_params: tp }, md);
      simpleByMeasure.set(measureName, name);
    } else if (md.type === 'ratio') {
      const num = ensureSimpleFor(resolveMeasure(md.numerator.name), md.numerator.name, md);
      const den = ensureSimpleFor(resolveMeasure(md.denominator.name), md.denominator.name, md);
      declareMetric({ name, type: 'ratio', type_params: { numerator: { name: num }, denominator: { name: den } } }, md);
    } else if (md.type === 'cumulative') {
      const ctp = {};
      if (md.window) ctp.window = md.window;
      if (md.grain_to_date) ctp.grain_to_date = md.grain_to_date;
      if (md.period_agg) ctp.period_agg = md.period_agg;
      declareMetric({ name, type: 'cumulative', type_params: { measure: { name: resolveMeasure(md.measure.name) }, cumulative_type_params: ctp } }, md);
    } else if (md.type === 'derived') {
      // derived expr is a formula over the input metric aliases only. Enforce a
      // safe grammar: allowed charset (no quotes/semicolons), and every
      // identifier must be a declared input metric alias or a safe math fn.
      const expr = md.expr || '';
      if (!/^[A-Za-z0-9_+\-*/().,\s]+$/.test(expr)) {
        fail(`derived metric '${md.name}': expr contains illegal characters (only metric names, numbers, + - * / ( ) . , allowed)`, 'metrics.expr');
      }
      const aliases = new Set((md.metrics || []).map((x) => x.name || x.metric));
      const SAFE_FNS = new Set(['nullif', 'coalesce', 'abs', 'round', 'least', 'greatest', 'floor', 'ceil', 'ceiling', 'power', 'sqrt', 'ln', 'log', 'exp', 'mod']);
      for (const tok of expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        if (!aliases.has(tok) && !SAFE_FNS.has(tok)) {
          fail(`derived metric '${md.name}': expr references unknown identifier '${tok}' (only input metric names + safe math functions allowed)`, 'metrics.expr');
        }
      }
      // An input is named as it was declared ('n') or as it is stored ('ret_n'), as a measure is; it is
      // resolved once every metric of this declaration is known, so the order they are written in is free
      const derived = { name, type: 'derived', type_params: { expr: md.expr, metrics: [] } };
      derivedInputs.push({ derived, md });
      declareMetric(derived, md);
    } else {
      fail(`unknown metric type: ${md.type}`, 'metrics.type');
    }
  }

  // Each input resolves to the metric it names, and the formula is written over those names — no
  // aliases: MetricFlow refuses an alias that equals an input's name, and one shorter than two
  // characters, while the identifiers of the formula are checked against the inputs above already.
  const derivedFrom = new Map(); // a derived metric of this declaration → the metrics it reads
  for (const { derived, md } of derivedInputs) {
    const from = [...metricNames].filter((n) => n !== derived.name); // a metric is not built from itself
    const storedOf = new Map();
    for (const x of md.metrics) {
      const stored = [NS(task, x.metric), x.metric].find((n) => from.includes(n) || existingMetrics.has(n));
      if (!stored) fail(`derived metric '${md.name}': no metric named '${x.metric}' or '${NS(task, x.metric)}' to build it from. ${inScope('metric', from, [...existingMetrics.keys()])}`, 'metrics.metrics');
      storedOf.set(x.name || x.metric, stored);
    }
    derived.type_params.expr = derived.type_params.expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (tok) => storedOf.get(tok) ?? tok);
    derived.type_params.metrics = [...new Set(storedOf.values())].map((n) => ({ name: n }));
    derivedFrom.set(derived.name, [...new Set(storedOf.values())]);
  }
  // two derived metrics of one declaration built from each other have no value to compute
  const cycle = (n, path = []) => (path.includes(n) ? [...path, n] : (derivedFrom.get(n) || []).map((m) => cycle(m, [...path, n])).find(Boolean));
  for (const n of derivedFrom.keys()) {
    const c = cycle(n);
    if (c) fail(`derived metrics built from each other: ${c.join(' → ')} — one of them has to read other metrics`, 'metrics.metrics');
  }

  if (!usedModels.size) {
    fail('this task reads no source: declare at least one semantic_models entry (from: <source>) or use_base_models', 'semantic_models');
  }

  return {
    task,
    // What the caller said this task is for, carried through so the context can report it
    // (mergeCompiled → state.task_notes). It changes no SQL and no YAML.
    ...(decl.description ? { description: decl.description } : {}),
    additions,
    metrics,
    usedModels: [...usedModels],
    measureNames: [...declaredMeasures],
    metricNames: [...metricNames],
  };
}
