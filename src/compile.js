// Compile a declarative create/update payload into resolved dbt semantic
// objects (measures/dimensions/metrics) for a single context. All physical SQL
// and namespacing happens here; the renderer just serializes.
//
// Every value a declaration computes is written in the ONE expression grammar (src/pipeline/compute.js)
// and turned into SQL by its one writer: a semantic model's where, a computed dimension, a measure's
// argument and scope over the model's leaves, and a derived metric over { metric } leaves. What is the
// semantic layer's own is only which leaves a place takes and what MetricFlow is handed: a measure is
// ONE aggregate (dbt's `agg` and the `expr` it folds, the scope baked in), a derived metric a SQL
// expression over the stored names of the metrics it reads.

import { isNumericType } from './dialects/base.js';
import { getDialect } from './dialects/index.js';
import { NUMERIC_AGGS, TASK_MEASURE_AGGS } from './catalog.js';
import { exprSql, conditionListSql, eachNode, isConditionCall, isAggregateCall, FNS, CONDITION_FNS, LOGIC_FNS, SCALAR_FNS } from './pipeline/compute.js';
import { rankFuzzy } from './fuzzy.js';

// dbt 1.11 forbids dunders (__) in object names; use a single underscore.
// (The __ separator is reserved for MetricFlow query *paths* like user__country.)
// Exported so an update names what it removes by the same rule (src/engine/semantic-build.js).
export const NS = (task, name) => `${task}_${name}`;

/**
 * The functions a semantic model's expressions take — a where, a computed dimension, a measure's
 * argument and its scope: the conditions, the logic, the scalar functions and, where a measure is
 * written, the aggregates a task chooses from (TASK_MEASURE_AGGS). Not raw: its dialect SQL would be
 * handed to MetricFlow unchecked — a semantic model's columns are not tracked the way a pipeline step's
 * are, so no column could be refused in its text. No window either: a semantic model has no order of rows.
 */
export const MODEL_FNS = [...CONDITION_FNS, ...LOGIC_FNS, ...SCALAR_FNS.filter((fn) => fn !== 'raw'), ...TASK_MEASURE_AGGS];

/** What a derived metric's value is computed with: arithmetic over other metrics and numbers. */
export const DERIVED_FNS = ['add', 'sub', 'mul', 'div', 'round', 'floor', 'ceil', 'abs', 'coalesce', 'least', 'greatest'];

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
 * Every leaf of an expression of `modelKey`, checked against the model before anything is written: a
 * { column } names one of its columns, an entity key or a declared amount; a { property } an event
 * property of the model, which is then an events source (one of another source is refused, naming its
 * owner); a { value } is a constant. An event compared with the event column by eq / neq / in / not_in is
 * one the source declares — a name of another source's is refused with the fix, not left to match nothing.
 * `row` names a place that holds a value of each row (a where, a computed dimension, what a measure
 * folds): an aggregate there is refused as the semantic layer says it, not as a pipeline stage would.
 */
function checkLeaves(catalog, modelKey, e, field, row = null) {
  const columns = columnNames(catalog, modelKey);
  const eventColumn = catalog.isFact(modelKey) ? catalog.getModel(modelKey).event_name?.column : null;
  eachNode(e, (n) => {
    if (n.fn !== undefined) {
      if (typeof n.fn === 'string' && Object.hasOwn(FNS, n.fn) && !MODEL_FNS.includes(n.fn)) fail(`${n.fn} is not a function a semantic model's expression takes — it computes with conditions, and / or / not, the scalar functions and, in a measure, one aggregate (${[...TASK_MEASURE_AGGS].join(', ')}); a window or a raw SQL is a pipeline's`, field);
      if (row && isAggregateCall(n)) fail(`${row}: ${n.fn} folds rows into one value, and this is a value of each row — an aggregate is what a measure is ({ name, expr: { fn: "${n.fn}", … } }); a formula over several aggregates is several measures and a derived metric`, field);
      const [subject, ...rest] = Array.isArray(n.args) ? n.args : [];
      if (eventColumn && EVENT_VALUE_OPS.has(n.fn) && isObj(subject) && subject.fn === undefined && subject.column === eventColumn) {
        for (const x of rest) if (isObj(x) && typeof x.value === 'string') factName(catalog, modelKey, x.value, field);
      }
      return;
    }
    if (n.column !== undefined) {
      // SQL's count(*) habit, said as the pipeline's builder says it: the rows are a count with no argument
      if (n.column === '*') fail("'*' is not a column — a count with no argument counts the ROWS ({ fn: 'count' })", field);
      if (!columns.includes(n.column)) fail(`'${n.column}' is not a column, entity key or aggregatable amount of '${modelKey}'.${nearest(n.column, columns)} semantic_index({ request: { source: '${modelKey}' } }) lists them${catalog.isFact(modelKey) ? '; an event property is { property }' : ''}.`, field);
      return;
    }
    if (n.property !== undefined) {
      if (!catalog.isFact(modelKey)) fail(`{ property: '${n.property}' } reads an event property, and '${modelKey}' is not an events source — name one of its columns ({ column }).`, field);
      if (!factProp(catalog, modelKey, n.property, field)) fail(`'${n.property}' is not an event property of '${modelKey}'.${nearest(n.property, catalog.eventProps(modelKey))} semantic_index({ request: { source: '${modelKey}' } }) lists them.`, field);
      return;
    }
    if (Object.hasOwn(n, 'value')) return;
    fail(`${JSON.stringify(n)}: an expression of a semantic model reads its columns ({ column }), its event properties on an events source ({ property }) and constants ({ value }).`, field);
  });
}

/**
 * The one writer's options over `modelKey`: no window, the columns typed as the catalog types them, an
 * event property read where the source stores it, and a declared amount written as the catalog's
 * expression for it (a plain column of that name is the column itself).
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
  return { d, opts: { catalog, source: modelKey, windows: false, columnType: (n) => types.get(n) ?? null, leaf } };
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

/** The type of what a measure folds when the catalog says it: an event property's, or a declared amount's. */
function argumentType(catalog, modelKey, arg) {
  if (!isObj(arg) || arg.fn !== undefined) return null;
  if (arg.property !== undefined) return arg.type ?? (arg.field !== undefined ? 'string' : catalog.propertyFor(modelKey, arg.property)?.spec?.type ?? 'string');
  if (arg.column !== undefined) return catalog.aggregatableField(modelKey, arg.column)?.type ?? null;
  return null;
}

/**
 * A measure declaration { name, expr, label? } → a dbt measure (name, agg, expr, ...). `expr` is ONE
 * aggregate of the task's (the one writer holds the rule: one at the top, its argument and its where row
 * expressions); MetricFlow is handed that aggregate's function and the argument it folds, with the
 * model's where AND the aggregate's own baked in as the scope.
 */
function compileMeasure(catalog, task, modelKey, decl, smScope) {
  const name = NS(task, decl.name);
  const field = 'measures.expr';
  const at = `measure '${decl.name}'`;
  const e = decl.expr;
  // what the aggregate folds and the rows it folds are values of each row
  if (isAggregateCall(e)) checkLeaves(catalog, modelKey, [...(e.args || []), ...(e.where || [])], field, at);
  else checkLeaves(catalog, modelKey, e, field);
  const { d, opts } = modelWriter(catalog, modelKey);
  attempt(field, () => exprSql(d, null, e, at, { ...opts, context: 'measure', aggregates: [...TASK_MEASURE_AGGS] }));
  // the model's where AND the aggregate's own — a funnel step is a measure whose where names the event
  // and a property value; a count of the rows where a condition holds is a count with that where
  const scope = [smScope, conditionsOf(catalog, modelKey, e.where, `${at} where`, field)].filter(Boolean).join(' AND ') || null;
  const [arg] = e.args || [];
  let agg = e.fn;
  let value;
  if (arg === undefined) {
    agg = 'sum'; // a count of the rows (the only aggregate without an argument), as sum(1) so a scope folds cleanly
    value = '1';
  } else {
    // a property or an amount the catalog types as something else is read as a number first
    const type = argumentType(catalog, modelKey, arg);
    if (NUMERIC_AGGS.has(e.fn) && type && type !== 'unknown' && !isNumericType(type)) {
      fail(`${at}: ${JSON.stringify(arg)} is ${type}, and ${e.fn} folds numbers — read it as one: { fn: "${e.fn}", args: [{ fn: "cast", args: [${JSON.stringify(arg)}], type: "numeric" }] }`, field);
    }
    value = attempt(field, () => exprSql(d, null, arg, `${at} ${e.fn} args[0]`, opts).sql);
  }
  const m = { name, agg, expr: applyScope(value, scope), ...(decl.label ? { label: decl.label } : {}) };
  if (e.fn === 'percentile') m.agg_params = { percentile: e.percentile, use_discrete_percentile: false };
  return m;
}

/**
 * One declared dimension → its manifest form. `_attribute` records what the caller DECLARED (the
 * attribute name it was given) next to the namespaced name
 * the manifest uses: they are read back when the tools describe or resolve the dimension, and are
 * stripped before the manifest is written (see yaml-render). Recovering them from the generated
 * identifier instead would mis-split the moment one task name is a prefix of another.
 *
 * A dimension is a column ({ column }: a column the catalog types as time is a time dimension, at `grain`
 * — default: the catalog's granularity for it — any other is categorical), an event property
 * ({ property }, categorical), or computed from the row ({ name, expr }: categorical, its expression
 * written by the one writer — a condition there is never missing, false where it does not hold, as a
 * compute stage stores it). What a column or a property IS comes from the catalog, never from the caller.
 */
function compileDimension(catalog, task, modelKey, decl) {
  const label = decl.label ? { label: decl.label } : {};
  const columns = catalog.modelDimensionColumns(modelKey);
  const props = catalog.isFact(modelKey) ? catalog.scalarEventProps(modelKey) : [];
  if (decl.expr !== undefined) {
    // a name of its own: as an attribute it would stand beside the column or property it shadows
    if ([...columns, ...props].includes(decl.name)) fail(`dimension '${decl.name}': '${modelKey}' already has an attribute of that name — give the computed dimension a name of its own, or declare that one as { ${columns.includes(decl.name) ? 'column' : 'property'}: '${decl.name}' }`, 'dimensions.name');
    checkLeaves(catalog, modelKey, decl.expr, 'dimensions.expr', `dimension '${decl.name}'`);
    const { d, opts } = modelWriter(catalog, modelKey);
    const r = attempt('dimensions.expr', () => exprSql(d, null, decl.expr, `dimension '${decl.name}'`, opts));
    return { name: NS(task, decl.name), type: 'categorical', expr: isConditionCall(decl.expr) ? `COALESCE(${r.sql}, FALSE)` : r.sql, ...label, _attribute: decl.name };
  }
  if (decl.column !== undefined) {
    if (!columns.includes(decl.column)) fail(`dimension: '${decl.column}' is not a groupable column of '${modelKey}'.${nearest(decl.column, columns)} Its groupable columns: ${columns.join(', ') || '(none)'}; a value computed from the row is { name, expr }.`, 'dimensions.column');
    const known = (catalog.getModel(modelKey).dimensions || {})[decl.column];
    if (known?.type === 'time') {
      // `expr` stays the bare column: the render reads it as the base model's own time dimensions are
      // read (the dialect's semanticTimeExpr, yaml-render.js renderContext) — for a context stored
      // earlier too, whose additions hold the column as it was compiled then
      return { name: NS(task, decl.column), type: 'time', expr: decl.column, type_params: { time_granularity: decl.grain || known.granularity || 'day' }, ...label, _attribute: decl.column };
    }
    if (decl.grain !== undefined) fail(`dimension '${decl.column}' is categorical — a grain goes with a time column of '${modelKey}'`, 'dimensions.grain');
    return { name: NS(task, decl.column), type: 'categorical', expr: decl.column, ...label, _attribute: decl.column };
  }
  if (decl.property !== undefined) {
    if (!props.includes(decl.property)) {
      if (catalog.isFact(modelKey)) factProp(catalog, modelKey, decl.property, 'dimensions.property'); // another source's is refused naming its owner
      fail(`dimension: '${decl.property}' is not a scalar event property of '${modelKey}'.${nearest(decl.property, props)} semantic_index({ request: { source: '${modelKey}' } }) lists them.`, 'dimensions.property');
    }
    const found = factProp(catalog, modelKey, decl.property, 'dimensions.property');
    return { name: NS(task, found.name), type: 'categorical', expr: propExpr(catalog, modelKey, found.name), ...label, _attribute: found.name };
  }
  return fail(`a dimension is { column }, { property } or { name, expr } — ${JSON.stringify(decl)} is none of them`, 'dimensions');
}

/**
 * A derived metric's value (`md.expr`, an expression of { metric } leaves and numbers) as the SQL
 * MetricFlow computes it with, each metric written by its stored name — `stored(name)` resolves one (or
 * refuses it) and records it as an input. A metric is named bare: MetricFlow reads a derived metric's
 * inputs in its expression by their names, which the name pattern keeps identifiers. A division by zero
 * is NULL (div is the pipeline's NULLIF division).
 */
function derivedSql(catalog, md, stored) {
  const field = 'metrics.expr';
  const at = `derived metric '${md.name}'`;
  eachNode(md.expr, (n) => {
    if (n.fn !== undefined) {
      if (!DERIVED_FNS.includes(n.fn)) fail(`${at}: ${n.fn} is not arithmetic over metrics — a derived metric is computed with ${DERIVED_FNS.join(', ')}; what a metric folds is its measure's`, field);
      return;
    }
    const keys = Object.keys(n);
    if (keys.length === 1 && typeof n.metric === 'string') return;
    if (keys.length === 1 && typeof n.value === 'number') return;
    fail(`${at}: ${JSON.stringify(n)} — a derived metric reads other metrics ({ metric: <name> }) and numbers ({ value: 2 })`, field);
  });
  const leaf = (n) => (n.metric !== undefined ? { sql: stored(n.metric), type: 'numeric', name: n.metric } : undefined);
  return attempt(field, () => exprSql(getDialect(catalog.dialect), null, md.expr, at, { windows: false, leaf }).sql);
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
 * declared measure/metric names (namespaced). What the context declared into already holds (an
 * update's, or a declaration beside a task already there): `measures`, the stored names of its
 * measures, which a metric reads by the name it was declared under or the stored one; `metrics`,
 * its compiled metrics, which a derived metric may be built from;
 * `models`, the models it reads already (an update compiles against them, so metrics or removals
 * alone have a source). Neither measures nor metrics may be declared again under the same stored
 * name: the context would keep one of the two.
 */
export function compileDeclaration(catalog, decl, { measures = [], metrics: contextMetrics = [], models = [] } = {}) {
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
  // the sources it was asked for, so a task on one events source does not drag in another. An item
  // of semantic_models loads its model: one with only `from` loads it for its attributes alone.
  const usedModels = new Set(models);

  for (const sm of decl.semantic_models || []) {
    const modelKey = sm.from;
    if (!catalog.models[modelKey]) fail(`semantic_models.from: unknown model '${modelKey}'. Known models: ${catalog.semanticModelKeys().join(', ')}${catalog.unavailableHint?.(modelKey) || ''}`, 'semantic_models.from');
    // a model with no primary entity has nothing MetricFlow could address its dimensions through
    if (!catalog.semanticModelKeys().includes(modelKey)) fail(`semantic_models.from: '${modelKey}' has no primary entity, so a semantic layer cannot load it — its rows are joined in a pipeline instead: build_pipeline_model with a join stage { stage: 'join', with: '${modelKey}', … }. A semantic layer loads ${catalog.semanticModelKeys().join(', ')}`, 'semantic_models.from');
    // an item's where scopes the measures declared beside it — with none, it would scope nothing
    if (sm.where?.length && !sm.measures?.length) fail(`semantic_models: the '${modelKey}' item has a where but no measures — a where scopes the measures declared in the same item. Put it beside the measures it is for, or put each measure's own condition in its aggregate's where; { from: '${modelKey}' } alone loads the model for its attributes`, 'semantic_models.where');
    usedModels.add(modelKey);
    // Each semantic model scopes its OWN measures: its where is baked into every measure expr below.
    const scope = conditionsOf(catalog, modelKey, sm.where, `${modelKey} where`, 'semantic_models.where');
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
  const derivedInputs = []; // derived metrics, their inputs resolved once every metric is known
  // A metric the caller declares takes a name nothing else holds: of two definitions under one name
  // the context would keep one and drop the other without a word.
  const declareMetric = (m, md) => {
    if (existingMetrics.has(m.name)) {
      fail(`metric '${md.name}' is already in this context, as '${m.name}'. To replace it, remove it and declare it again in one update: build_semantic_model({ request: { action: 'update', context_id, remove: { metrics: ['${m.name}'] }, metrics: [...] } }) — with cascade: true when other metrics are built from it`, 'metrics.name');
    }
    if (metricNames.has(m.name)) fail(`metric '${md.name}' is declared twice in this call (stored as '${m.name}')`, 'metrics.name');
    if (!m.label) m.label = m.name; // dbt 1.11+ requires a label on every metric (the caller's, or its name)
    metricNames.add(m.name);
    metrics.push(m);
  };

  // what a metric reads is named by a string — a measure as `measure`; a derived metric's inputs are the
  // { metric } leaves of its expression
  for (const md of decl.metrics || []) {
    const name = NS(task, md.name);
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
      // An input is named as it was declared ('n') or as it is stored ('ret_n'), as a measure is; it is
      // resolved once every metric of this declaration is known, so the order they are written in is free
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
      const s = [NS(task, x), x].find((n) => from.includes(n) || existingMetrics.has(n));
      if (!s) fail(`derived metric '${md.name}': no metric named '${x}' or '${NS(task, x)}' to build it from. ${inScope('metric', from, [...existingMetrics.keys()])}`, 'metrics.expr');
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
    fail('this task reads no source: declare at least one semantic_models item ({ from: <source>, … })', 'semantic_models');
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
