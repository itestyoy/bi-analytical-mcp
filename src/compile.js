// Compile a declaration (what a build's semantic_model step makes — src/pipeline/semantic-stage.js) into
// resolved dbt semantic objects (measures/dimensions/metrics) for a single context. All physical SQL is
// written here; the renderer just serializes.
//
// Every value a declaration computes is written in the ONE expression (src/pipeline/compute.js) and
// turned into SQL by its one writer, at its PLACE: a semantic model's where, a computed dimension, a
// measure's argument and scope at PLACES.semantic_model (the model's columns and event properties,
// constants and the current time; no raw — its SQL would reach MetricFlow unchecked — and no window), and
// a derived metric at PLACES.derived_metric (other metrics and numbers, in arithmetic). What is the
// semantic layer's own is only what MetricFlow is handed: a measure is ONE aggregate (dbt's `agg` and the
// `expr` it folds — a conditional one's a case, as written — with the model's where baked in as a case
// too), a derived metric a SQL expression over the stored names of the metrics it reads.

import { isNumericType } from './dialects/base.js';
import { getDialect } from './dialects/index.js';
import { NUMERIC_AGGS, TASK_MEASURE_AGGS } from './catalog.js';
import { exprSql, conditionListSql, eachNode, isAggregateCall } from './pipeline/compute.js';
import { refKind } from './schema/refs.js';
import { rankFuzzy } from './fuzzy.js';

// A metric, a measure and a computed dimension are stored under the name they are declared by: a context
// holds one semantic layer (its build's semantic_model step), so nothing else in it shares the names.
// What MetricFlow refuses of a name is refused here first, naming it as declared: a time grain or a word
// it reserves, and a name another element of the layer already holds as something else (a measure named
// as a dimension or an entity) — its ElementConsistencyRule and UniqueAndValidNameRule.
const RESERVED_NAMES = new Set(['metric_time', 'mf_internal_uuid']);
const GRAIN_NAMES = new Set(['nanosecond', 'microsecond', 'millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);
function checkName(kind, name, field) {
  if (GRAIN_NAMES.has(name)) fail(`${kind} '${name}': a time grain is no name — MetricFlow reads '${name}' as the grain; give it a name of its own (e.g. '${name}_n')`, field);
  if (RESERVED_NAMES.has(name)) fail(`${kind} '${name}': MetricFlow reserves the name '${name}' — give it a name of its own`, field);
}

/** Throw a compile error that CARRIES the input field it refers to — the engine
 *  surfaces it as ToolError.field so the caller knows exactly what to fix. */
function fail(msg, field) { const e = new Error(msg); e.field = field; throw e; }

/** Run `f`, a refusal of the one writer reported against the input `field`. */
function attempt(field, f) {
  try { return f(); } catch (e) { if (e.field) throw e; return fail(e.message, field); }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** "did you mean" over the names a place offers. */
const nearest = (name, names) => {
  const near = typeof name === 'string' ? rankFuzzy(name, names, { fields: (x) => [x], limit: 3 }).map((x) => x.item) : [];
  return near.length ? ` Did you mean ${near.map((x) => `'${x}'`).join(' or ')}?` : '';
};

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

/** The columns an expression of `modelKey` may name: its own, its entity keys, and the amounts the
 *  catalog marks aggregatable (each an expression over its columns). */
function columnNames(catalog, modelKey) {
  return [...new Set([
    ...catalog.modelColumns(modelKey).map((c) => c.name),
    ...catalog.entityKeyColumns(modelKey),
    ...catalog.aggregatableFields(modelKey).map((a) => a.name),
  ])].sort();
}

/**
 * The model's own leaves of an expression of `modelKey`, checked against the model before anything is
 * written: a { column } names one of its columns, an entity key or a declared amount; a { property } an
 * event property of the model, which is then an events source (one of another source is refused, naming
 * its owner). An event compared with the event column by eq / neq / in / not_in is one the source declares
 * — a name of another source's is refused with the fix, not left to match nothing. What the place does
 * not take — a ref, a window, raw SQL, a function it has not — the one writer refuses, naming what a
 * semantic model takes. `row` names a place that holds a value of each row (a where, a computed
 * dimension, what a measure folds): an aggregate there is refused as the semantic layer says it, not as a
 * pipeline stage would.
 */
function checkLeaves(catalog, modelKey, e, field, row = null) {
  const columns = columnNames(catalog, modelKey);
  const eventColumn = catalog.isFact(modelKey) ? catalog.getModel(modelKey).event_name?.column : null;
  eachNode(e, (n) => {
    if (n.fn !== undefined) {
      if (row && isAggregateCall(n)) fail(`${row}: ${n.fn} folds rows into one value, and this is a value of each row — an aggregate is what a measure is ({ name, expr: { fn: "${n.fn}", … } }); a formula over several aggregates is several measures and a derived metric`, field);
      const [subject, ...rest] = Array.isArray(n.args) ? n.args : [];
      if (eventColumn && EVENT_VALUE_OPS.has(n.fn) && isObj(subject) && subject.fn === undefined && !refKind(subject) && subject.column === eventColumn) {
        for (const x of rest) if (isObj(x) && typeof x.value === 'string') factName(catalog, modelKey, x.value, field);
      }
      return;
    }
    // a ref ({ source, column } …) names a thing elsewhere: the writer refuses it at this place
    if (refKind(n)) return;
    if (n.column !== undefined) {
      // SQL's count(*) habit, said as the pipeline's builder says it: the rows are a count with no argument
      if (n.column === '*') fail("'*' is not a column — a count with no argument counts the ROWS ({ fn: 'count' })", field);
      if (!columns.includes(n.column)) fail(`'${n.column}' is not a column, entity key or aggregatable amount of '${modelKey}'.${nearest(n.column, columns)} semantic_index({ request: { source: '${modelKey}' } }) lists them${catalog.isFact(modelKey) ? '; an event property is { property }' : ''}.`, field);
      return;
    }
    if (n.property !== undefined) {
      if (!catalog.isFact(modelKey)) fail(`{ property: '${n.property}' } reads an event property, and '${modelKey}' is not an events source — name one of its columns ({ column }).`, field);
      if (!factProp(catalog, modelKey, n.property, field)) fail(`'${n.property}' is not an event property of '${modelKey}'.${nearest(n.property, catalog.eventProps(modelKey))} semantic_index({ request: { source: '${modelKey}' } }) lists them.`, field);
    }
  });
}

/**
 * The one writer's options over `modelKey`: the place (a semantic model's — no window, no raw), the
 * columns typed as the catalog types them, an event property read where the source stores it, and a
 * declared amount written as the catalog's expression for it (a plain column of that name is the column
 * itself).
 */
function modelWriter(catalog, modelKey) {
  const d = getDialect(catalog.dialect);
  const types = new Map(catalog.modelColumns(modelKey).map((c) => [c.name, c.type]));
  const leaf = (n) => {
    if (n.column === undefined) return undefined;
    const amount = catalog.aggregatableField(modelKey, n.column);
    if (!amount || amount.expr === n.column) return undefined;
    return { sql: `(${amount.expr})`, type: amount.type ?? null, name: n.column };
  };
  return { d, opts: { place: 'semantic_model', catalog, source: modelKey, columnType: (n) => types.get(n) ?? null, leaf } };
}

/** A list of conditions over `modelKey` as one boolean (or null) — each item checked and written by the one writer. */
function conditionsOf(catalog, modelKey, list, at, field) {
  if (!list?.length) return null;
  checkLeaves(catalog, modelKey, list, field, at);
  const { d, opts } = modelWriter(catalog, modelKey);
  return attempt(field, () => conditionListSql(d, null, list, at, opts)).map((x) => `(${x})`).join(' AND ');
}

/** Wrap a base value expression with the scope (M3: scope baked into every measure). */
function applyScope(valueExpr, scope) {
  if (!scope) return valueExpr;
  if (valueExpr === '1') return `CASE WHEN ${scope} THEN 1 ELSE 0 END`;
  return `CASE WHEN ${scope} THEN ${valueExpr} END`;
}

/** The type of what a measure folds when the catalog says it: an event property's (a field of one is
 *  text), or a declared amount's. */
function argumentType(catalog, modelKey, arg) {
  if (!isObj(arg) || arg.fn !== undefined) return null;
  if (arg.property !== undefined) return arg.field !== undefined ? 'string' : catalog.propertyFor(modelKey, arg.property)?.spec?.type ?? 'string';
  if (arg.column !== undefined) return catalog.aggregatableField(modelKey, arg.column)?.type ?? null;
  return null;
}

/**
 * A measure declaration { name, expr, label? } → a dbt measure (name, agg, expr, ...). `expr` is ONE
 * aggregate of the task's (the one writer holds the rule: one at the top, its argument a row expression —
 * a case where it folds only the rows a condition holds for); MetricFlow is handed that aggregate's
 * function and the argument it folds, with the model's where baked in as the scope.
 */
function compileMeasure(catalog, modelKey, decl, smScope) {
  const name = decl.name;
  checkName('measure', name, 'measures.name');
  const field = 'measures.expr';
  const at = `measure '${decl.name}'`;
  const e = decl.expr;
  // what the aggregate folds is a value of each row
  if (isAggregateCall(e)) checkLeaves(catalog, modelKey, e.args || [], field, at);
  else checkLeaves(catalog, modelKey, e, field);
  const { d, opts } = modelWriter(catalog, modelKey);
  attempt(field, () => exprSql(d, null, e, at, { ...opts, context: 'measure', aggregates: [...TASK_MEASURE_AGGS] }));
  // the model's where (a measure that folds only some rows says which in its own case: a funnel step's
  // users are a count_distinct over a case naming the event and a property value)
  const scope = smScope || null;
  const [arg] = e.args || [];
  let agg = e.fn;
  let value;
  if (arg === undefined) {
    agg = 'sum'; // a count of the rows (the only aggregate without an argument), as sum(1) so a scope folds cleanly
    value = '1';
  } else {
    // a property or an amount the catalog types as something else is read as a number first (of a
    // conditional aggregate, each value its case yields)
    const yields = isObj(arg) && arg.fn === 'case' && Array.isArray(arg.cases) ? [...arg.cases.map((cs) => cs?.then), ...(arg.else !== undefined ? [arg.else] : [])] : [arg];
    const [bad, type] = yields.map((x) => [x, argumentType(catalog, modelKey, x)]).find(([, t]) => t && t !== 'unknown' && !isNumericType(t)) || [];
    if (NUMERIC_AGGS.has(e.fn) && bad) {
      fail(bad === arg
        ? `${at}: ${JSON.stringify(arg)} is ${type}, and ${e.fn} folds numbers — read it as one: { fn: "${e.fn}", args: [{ fn: "cast", args: [${JSON.stringify(arg)}], type: "numeric" }] }`
        : `${at}: ${JSON.stringify(bad)}, a value its case yields, is ${type}, and ${e.fn} folds numbers — read it as one there: { fn: "cast", args: [${JSON.stringify(bad)}], type: "numeric" }`, field);
    }
    value = attempt(field, () => exprSql(d, null, arg, `${at} ${e.fn} args[0]`, opts).sql);
  }
  const m = { name, agg, expr: applyScope(value, scope), ...(decl.label ? { label: decl.label } : {}) };
  if (e.fn === 'percentile') m.agg_params = { percentile: e.percentile, use_discrete_percentile: false };
  return m;
}

/**
 * One declared dimension → its manifest form, stored under the name it was declared by (a column's or a
 * property's own, a computed one's `name`). `_attribute` records what the caller DECLARED — the column,
 * the property or the name — which the tools read back to describe or resolve the dimension, and which
 * is stripped before the manifest is written (see yaml-render).
 *
 * A dimension is a column ({ column }: a column the catalog types as time is a time dimension, at `grain`
 * — default: the catalog's granularity for it — any other is categorical), an event property
 * ({ property }, categorical), or computed from the row ({ name, expr }: categorical, its expression
 * written by the one writer — a boolean there (a condition, array_contains, a boolean column, a case of
 * booleans …) is never missing, false where it cannot be decided, as a compute stage stores it). What a
 * column or a property IS comes from the catalog, never from the caller.
 */
function compileDimension(catalog, modelKey, decl) {
  const label = decl.label ? { label: decl.label } : {};
  const columns = catalog.modelDimensionColumns(modelKey);
  const props = catalog.isFact(modelKey) ? catalog.scalarEventProps(modelKey) : [];
  if (decl.expr !== undefined) {
    // a name of its own: as an attribute it would stand beside the column or property it shadows
    checkName('dimension', decl.name, 'dimensions.name');
    if ([...columns, ...props].includes(decl.name)) fail(`dimension '${decl.name}': '${modelKey}' already has an attribute of that name — give the computed dimension a name of its own, or declare that one as { ${columns.includes(decl.name) ? 'column' : 'property'}: '${decl.name}' }`, 'dimensions.name');
    checkLeaves(catalog, modelKey, decl.expr, 'dimensions.expr', `dimension '${decl.name}'`);
    const { d, opts } = modelWriter(catalog, modelKey);
    const r = attempt('dimensions.expr', () => exprSql(d, null, decl.expr, `dimension '${decl.name}'`, opts));
    return { name: decl.name, type: 'categorical', expr: r.type === 'boolean' ? `COALESCE(${r.sql}, FALSE)` : r.sql, ...label, _attribute: decl.name };
  }
  if (decl.column !== undefined) {
    if (!columns.includes(decl.column)) fail(`dimension: '${decl.column}' is not a groupable column of '${modelKey}'.${nearest(decl.column, columns)} Its groupable columns: ${columns.join(', ') || '(none)'}; a value computed from the row is { name, expr }.`, 'dimensions.column');
    const known = (catalog.getModel(modelKey).dimensions || {})[decl.column];
    if (known?.type === 'time') {
      // `expr` stays the bare column: the render reads it as the base model's own time dimensions are
      // read (the dialect's semanticTimeExpr, yaml-render.js renderContext) — for a context stored
      // earlier too, whose additions hold the column as it was compiled then
      return { name: decl.column, type: 'time', expr: decl.column, type_params: { time_granularity: decl.grain || known.granularity || 'day' }, ...label, _attribute: decl.column };
    }
    if (decl.grain !== undefined) fail(`dimension '${decl.column}' is categorical — a grain goes with a time column of '${modelKey}'`, 'dimensions.grain');
    return { name: decl.column, type: 'categorical', expr: decl.column, ...label, _attribute: decl.column };
  }
  if (decl.property !== undefined) {
    if (!props.includes(decl.property)) {
      if (catalog.isFact(modelKey)) factProp(catalog, modelKey, decl.property, 'dimensions.property'); // another source's is refused naming its owner
      fail(`dimension: '${decl.property}' is not a scalar event property of '${modelKey}'.${nearest(decl.property, props)} semantic_index({ request: { source: '${modelKey}' } }) lists them.`, 'dimensions.property');
    }
    const found = factProp(catalog, modelKey, decl.property, 'dimensions.property');
    return { name: found.name, type: 'categorical', expr: propExpr(catalog, modelKey, found.name), ...label, _attribute: found.name };
  }
  return fail(`a dimension is { column }, { property } or { name, expr } — ${JSON.stringify(decl)} is none of them`, 'dimensions');
}

/**
 * A derived metric's value (`md.expr`, an expression at PLACES.derived_metric: { metric } leaves and
 * numbers, in arithmetic) as the SQL MetricFlow computes it with, each metric written by its stored name —
 * `stored(name)` resolves one (or refuses it) and records it as an input. A metric is named bare:
 * MetricFlow reads a derived metric's inputs in its expression by their names, which the name pattern
 * keeps identifiers. A division by zero is NULL (div is the pipeline's NULLIF division).
 */
function derivedSql(catalog, md, stored) {
  const field = 'metrics.expr';
  const at = `derived metric '${md.name}'`;
  // what the place takes is the writer's to refuse; a constant beside metrics is a number
  eachNode(md.expr, (n) => {
    if (n.fn === undefined && Object.hasOwn(n, 'value') && typeof n.value !== 'number') fail(`${at}: ${JSON.stringify(n)} — a derived metric computes with numbers ({ value: 2 }) beside the metrics it reads`, field);
  });
  const leaf = (n) => (n.metric !== undefined ? { sql: stored(n.metric), type: 'numeric', name: n.metric } : undefined);
  return attempt(field, () => exprSql(getDialect(catalog.dialect), null, md.expr, at, { place: 'derived_metric', leaf }).sql);
}

/** The measures a compiled metric reads itself: a simple or cumulative metric's measure. */
function ownMeasures(metric) {
  const tp = metric?.type_params || {};
  const name = (v) => (typeof v === 'string' ? v : v?.name);
  return [tp.measure].map(name).filter(Boolean);
}

/** The metrics a compiled metric is built from: a derived metric's inputs — and, of a ratio an earlier
 *  version declared and a context keeps, its numerator and denominator. */
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
 * specs, used models, and the
 * declared measure/metric names, each stored as declared. What the context holds already: `measures`,
 * the names of its measures, which a metric may read; `metrics`, its compiled metrics, which a derived
 * metric may be built from; `models`, the models it reads already. Neither measures nor metrics may be
 * declared again under the same name: the context would keep one of the two.
 */
export function compileDeclaration(catalog, decl, { measures = [], metrics: contextMetrics = [], models = [] } = {}) {
  const task = decl.name;
  if (!task) fail('name (task) is required', 'name');

  const additions = {}; // modelKey -> { measures:[], dimensions:[] }
  const existingMeasures = new Set(measures); // declared before this call
  const declaredMeasures = new Set();
  const ensure = (k) => (additions[k] ||= { measures: [], dimensions: [] });
  // what a refusal lists, each name said as what it is: declared in this call, or already in the context
  const inScope = (kind, inCall, inContext) => [
    inCall.length ? `Declared in this call: ${inCall.join(', ')}.` : `This call declares no ${kind}.`,
    inContext.length ? `Already in this context: ${inContext.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  // The models this task READS — taken from the payload, never assumed. A context carries only
  // the sources it was asked for, so a task on one events source does not drag in another. An item
  // of semantic_models loads its model: one with only `source` loads it for its columns alone.
  const usedModels = new Set(models);
  const baseMeasureRefs = new Set(catalog.baseMeasureRefs());

  for (const sm of decl.semantic_models || []) {
    const modelKey = sm.source;
    if (!catalog.models[modelKey]) fail(`semantic_models.source: unknown model '${modelKey}'. Known models: ${catalog.semanticModelKeys().join(', ')}${catalog.unavailableHint?.(modelKey) || ''}`, 'semantic_models.source');
    // a model with no primary entity has nothing MetricFlow could address its dimensions through
    if (!catalog.semanticModelKeys().includes(modelKey)) fail(`semantic_models.source: '${modelKey}' has no primary entity, so a semantic layer cannot load it — its rows reach a pipeline instead${catalog.joinContract(modelKey) ? `: build_model with a join stage { stage: 'join', source: '${modelKey}', on: { … }, attrs }` : ' as its source'}. A semantic layer loads ${catalog.semanticModelKeys().join(', ')}`, 'semantic_models.source');
    // an item's where scopes the measures declared beside it — with none, it would scope nothing
    if (sm.where?.length && !sm.measures?.length) fail(`semantic_models: the '${modelKey}' item has a where but no measures — a where scopes the measures declared in the same item. Put it beside the measures it is for, or fold each measure over a case of its own condition ({ fn: "count", args: [{ fn: "case", cases: [{ when: [...], then: { value: 1 } }] }] }); { source: '${modelKey}' } alone loads the model for its columns`, 'semantic_models.where');
    usedModels.add(modelKey);
    // Each semantic model scopes its OWN measures: its where is baked into every measure expr below.
    const scope = conditionsOf(catalog, modelKey, sm.where, `${modelKey} where`, 'semantic_models.where');
    for (const d of sm.dimensions || []) ensure(modelKey).dimensions.push(compileDimension(catalog, modelKey, d));
    for (const m of sm.measures || []) {
      const cm = compileMeasure(catalog, modelKey, m, scope);
      // two measures of one name would both be written, and dbt refuses the duplicate at parse
      if (declaredMeasures.has(cm.name)) fail(`measure '${m.name}' is declared twice in this step`, 'measures.name');
      if (existingMeasures.has(cm.name)) fail(`measure '${m.name}' is already in this context. Each name is declared once in the semantic_model step`, 'measures.name');
      if (baseMeasureRefs.has(cm.name)) fail(`measure '${m.name}': the catalog governs a measure of that name on '${catalog.modelOwningMeasure(cm.name)}' — a metric reads it as it is ({ type: 'simple', measure: '${cm.name}' }); give yours a name of its own`, 'measures.name');
      declaredMeasures.add(cm.name);
      ensure(modelKey).measures.push(cm);
    }
  }

  const resolveMeasure = (ref) => {
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
  const derivedInputs = []; // derived metrics, their inputs resolved once every metric is known
  // A metric the caller declares takes a name nothing else holds: of two definitions under one name
  // the context would keep one and drop the other without a word.
  const declareMetric = (m, md) => {
    if (existingMetrics.has(m.name)) {
      fail(`metric '${md.name}' is already in this context. Each name is declared once in the semantic_model step`, 'metrics.name');
    }
    if (metricNames.has(m.name)) fail(`metric '${md.name}' is declared twice in this step`, 'metrics.name');
    if (!m.label) m.label = m.name; // dbt 1.11+ requires a label on every metric (the caller's, or its name)
    metricNames.add(m.name);
    metrics.push(m);
  };

  // what a metric reads is named by a string — a measure as `measure`; a derived metric's inputs are the
  // { metric } leaves of its expression
  for (const md of decl.metrics || []) {
    const name = md.name;
    checkName('metric', name, 'metrics.name');
    // the caller's label goes with the metric (declareMetric defaults a missing one to its name)
    const label = md.label ? { label: md.label } : {};
    if (md.type === 'simple') {
      const tp = { measure: { name: resolveMeasure(md.measure) } };
      if (typeof md.fill_nulls_with === 'number') tp.measure.fill_nulls_with = md.fill_nulls_with;
      declareMetric({ name, type: 'simple', ...label, type_params: tp }, md);
    } else if (md.type === 'cumulative') {
      // all history, a trailing window, or to date within a grain — the schema's two forms keep a
      // window and a grain_to_date apart, as MetricFlow refuses them together
      if (md.window && md.grain_to_date) fail(`cumulative metric '${md.name}': window and grain_to_date are two kinds of accumulation — give one`, 'metrics.grain_to_date');
      const ctp = {};
      if (md.window) ctp.window = md.window;
      if (md.grain_to_date) ctp.grain_to_date = md.grain_to_date;
      if (md.period_agg) ctp.period_agg = md.period_agg;
      declareMetric({ name, type: 'cumulative', ...label, type_params: { measure: { name: resolveMeasure(md.measure) }, cumulative_type_params: ctp } }, md);
    } else if (md.type === 'derived') {
      if (!isObj(md.expr)) fail(`derived metric '${md.name}': expr is an expression of the metrics it reads — e.g. { fn: "div", args: [{ metric: "payers" }, { metric: "users" }] }`, 'metrics.expr');
      // An input is named as it was declared; it is resolved once every metric of this declaration is
      // known, so the order they are written in is free
      const derived = { name, type: 'derived', ...label, type_params: { expr: null, metrics: [] } };
      derivedInputs.push({ derived, md });
      declareMetric(derived, md);
    } else {
      fail(`unknown metric type: ${md.type} — a metric is simple, cumulative or derived (a ratio is a derived metric dividing one metric by another: { fn: "div", args: [{ metric }, { metric }] })`, 'metrics.type');
    }
  }

  // Each { metric } of a derived metric resolves to the metric it names, and the expression is written
  // over those stored names. No aliases reach MetricFlow: it refuses one that equals an input's name,
  // and one shorter than two characters.
  const derivedFrom = new Map(); // a derived metric of this declaration → the metrics it reads
  for (const { derived, md } of derivedInputs) {
    const from = [...metricNames].filter((n) => n !== derived.name); // a metric is not built from itself
    const reads = new Set();
    const stored = (x) => {
      const s = from.includes(x) || existingMetrics.has(x) ? x : null;
      if (!s) fail(`derived metric '${md.name}': no metric named '${x}' to build it from. ${inScope('metric', from, [...existingMetrics.keys()])}`, 'metrics.expr');
      reads.add(s);
      return s;
    };
    const sql = derivedSql(catalog, md, stored);
    if (!reads.size) fail(`derived metric '${md.name}': its expression reads no metric — name the metrics it is computed from as { metric: <name> }`, 'metrics.expr');
    // a missing value (a bucket where an input has no rows) is the number the caller chose
    derived.type_params.expr = typeof md.fill_nulls_with === 'number' ? `coalesce(${sql}, ${md.fill_nulls_with})` : sql;
    derived.type_params.metrics = [...reads].map((n) => ({ name: n }));
    derivedFrom.set(derived.name, [...reads]);
  }
  // two derived metrics of one declaration built from each other have no value to compute
  const cycle = (n, path = []) => (path.includes(n) ? [...path, n] : (derivedFrom.get(n) || []).map((m) => cycle(m, [...path, n])).find(Boolean));
  for (const n of derivedFrom.keys()) {
    const c = cycle(n);
    if (c) fail(`derived metrics built from each other: ${c.join(' → ')} — one of them has to read other metrics`, 'metrics.expr');
  }

  if (!usedModels.size) {
    fail('this task reads no source: declare at least one semantic_models item ({ source, … })', 'semantic_models');
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
