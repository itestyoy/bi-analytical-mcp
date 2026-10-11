// THE PIECES THE TOOL SCHEMAS SHARE — the name patterns, the reused descriptions, the items a
// declaration and a query are written in (a measure, a dimension, a metric, a reference into the
// project's own layer), the expression definitions of the semantic tools (a semantic model's, a derived
// metric's, a metric query's where — each the one grammar of src/pipeline/compute.js over its own
// leaves), and the limits every tool quotes (how long a read waits, how many queries a batch holds). The
// tools are put together in src/schema.js.

import { GRAINS } from '../catalog.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { strEnum, form, pick, timeRange, conditionSlot, measureForm } from '../schema-kit.js';
import { exprSchema, columnLeaf, propertyLeaf, valueLeaf } from '../pipeline/compute.js';
import { MODEL_FNS, DERIVED_FNS } from '../compile.js';
import { WHERE_FNS } from '../predicate.js';
import { CONTEXT_ID } from '../context-manager.js';

export const NAME = '^[a-z][a-z0-9_]{0,40}$';

export const TASK = '^[a-z][a-z0-9_]{2,40}$';

export const CTX = CONTEXT_ID;

export const TASK_ID = TASK_ID_PATTERN;

// a trailing window MetricFlow reads: a count and a unit of the grains metric_time is offered at
export const WINDOW = '^[0-9]+ (day|week|month|quarter|year)s?$';

// Reusable property-description strings (kept consistent across tools).
export const D = {
  context_id: 'ID of the isolated execution context to operate in. Omit on create to start a new, isolated context; pass an existing id to extend or query that same context. Each context is fully isolated, so parallel tasks never collide.',
  label: 'Human-readable label shown in BI tools / metadata. Defaults to the name when omitted.',
};

// A SEMANTIC MODEL'S EXPRESSIONS — its where, a computed dimension and a measure are written in the one
// expression grammar (src/pipeline/compute.js), over the model's own leaves: { column } (a column, an
// entity key, an amount the catalog declares aggregatable), { property } on an events source (an event
// property, read where it is stored), { value }. One definition serves every model of the tool
// (`$defs.expr`): a column is an open string and a property any of the catalog's event properties, each
// checked against the model it is written on when the declaration is compiled (src/compile.js, with
// "did you mean") — a definition per model would repeat the whole grammar once per source.

const EXPR_REF = '#/$defs/expr';
const METRIC_EXPR_REF = '#/$defs/metric_expr';

/** A metric a derived metric reads — { metric: <name> }. */
const metricLeaf = () => form({
  title: 'a metric — { metric }', required: ['metric'],
  properties: { metric: { type: 'string', minLength: 1, description: 'A metric of this call or already in the context, by name (as declared, or as stored: <task>_<name>).' } },
});

/** A number in a derived metric's expression — { value }. */
const numberLeaf = () => form({ title: 'a number — { value }', required: ['value'], properties: { value: { type: 'number', description: 'A number.' } } });

/**
 * The `$defs` of build_semantic_model: `expr`, the expression of a semantic model's where, computed
 * dimensions and measures (the conditions, the logic, the scalar functions and the aggregates a task
 * chooses from — src/compile.js MODEL_FNS), and `metric_expr`, a derived metric's value (arithmetic over
 * { metric } leaves and numbers — DERIVED_FNS).
 */
export function semanticDefs(catalog) {
  const leaves = [
    columnLeaf('A column of the model, an entity key, or an amount the catalog marks aggregatable (semantic_index({ request: { source } }) lists them).'),
    ...(catalog.facts.length ? [propertyLeaf(catalog.eventPropEnum(), 'An event property of the model — it is then an events source — read where it is stored: its own column, or the event_data payload.')] : []),
    valueLeaf(),
  ];
  return {
    expr: exprSchema(catalog, { ref: EXPR_REF, leaves, fns: MODEL_FNS, windows: false, sourced: false }),
    metric_expr: exprSchema(catalog, {
      ref: METRIC_EXPR_REF, leaves: [metricLeaf(), numberLeaf()], fns: DERIVED_FNS, windows: false, sourced: false,
      description: `A derived metric's value: arithmetic over other metrics — a leaf { metric: <name> } or a number { value }, or a function { fn, args: [expressions], … } of ${DERIVED_FNS.join(', ')}, nested to any depth. div is NULL where the divisor is 0. A ratio of two metrics: { fn: "div", args: [{ metric: "payers" }, { metric: "users" }] }.`,
    }),
  };
}

/** The model's columns the catalog types as time: a dimension of one is a time dimension, read at a grain. */
function timeDimensionFields(catalog, modelKey) {
  const dims = catalog.getModel(modelKey).dimensions || {};
  return catalog.modelDimensionColumns(modelKey).filter((c) => dims[c]?.type === 'time').sort();
}

/** A computed dimension's name — what it is grouped and filtered by. */
const DIMENSION_NAME = { type: 'string', pattern: NAME, description: 'The dimension\'s name — grouped and filtered as { model, attribute: <this name> }.' };

/** The scalar event properties a dimension of `modelKey` may be (none off an events source). */
const dimensionProps = (catalog, modelKey) => (catalog.isFact(modelKey) ? [...catalog.scalarEventProps(modelKey)].sort() : []);

/**
 * A dimension a declaration adds to a semantic model, in closed forms by what it is: a column the
 * catalog types as time, at `grain` (default: the catalog's granularity for it); any other groupable
 * column; a scalar event property; or one computed from the row ({ name, expr }: a row expression,
 * categorical). The column forms are told apart by the columns each takes.
 */
function dimensionItemSchema(catalog, modelKey) {
  const label = { type: 'string', description: D.label };
  const time = timeDimensionFields(catalog, modelKey);
  const other = catalog.modelDimensionColumns(modelKey).filter((c) => !time.includes(c)).sort();
  const props = dimensionProps(catalog, modelKey);
  const forms = [
    ...(time.length ? [form({ title: 'a time column', tag: ['column', time], properties: { grain: { enum: catalog.timeGranularities(), description: 'The bucket its values are read at (default: the column\'s own granularity in the catalog).' }, label } })] : []),
    ...(other.length ? [form({ title: 'a column', tag: ['column', other], properties: { label } })] : []),
    ...(props.length ? [form({ title: 'an event property', tag: ['property', props], properties: { label } })] : []),
    form({
      title: 'a computed dimension', required: ['name', 'expr'],
      properties: {
        name: DIMENSION_NAME,
        expr: { $ref: EXPR_REF, description: 'Its value, computed from the row: a row expression over the model\'s columns and properties (no aggregate) — e.g. { fn: "case", cases: [{ when: [{ fn: "gt", args: [{ column: "price" }, { value: 10 }] }], then: { value: "high" } }], else: { value: "low" } }. A condition is false where it does not hold.' },
        label,
      },
    }),
  ];
  return forms.length === 1 ? forms[0] : { type: 'object', anyOf: forms };
}

/**
 * A dimension an update removes, named the way it was declared — { from, column }, { from, property }
 * or { from, name } — over the models `keys` (those a semantic layer loads). → the item's forms.
 */
export function removedDimensionForms(catalog, keys) {
  return keys.flatMap((k) => {
    const from = { from: { const: k } };
    const columns = [...catalog.modelDimensionColumns(k)].sort();
    const props = dimensionProps(catalog, k);
    return [
      ...(columns.length ? [form({ title: `${k}: a column`, tag: ['column', columns], required: ['from'], properties: from })] : []),
      ...(props.length ? [form({ title: `${k}: an event property`, tag: ['property', props], required: ['from'], properties: from })] : []),
      form({ title: `${k}: a computed dimension`, required: ['from', 'name'], properties: { ...from, name: DIMENSION_NAME } }),
    ];
  });
}

export function semanticModelBranch(catalog, modelKey) {
  const label = { type: 'string', description: D.label };
  return {
    type: 'object', additionalProperties: false, required: ['from'], title: modelKey,
    properties: {
      from: { const: modelKey },
      where: conditionSlot(EXPR_REF, 'Rows every measure of this item folds: conditions that all hold (e.g. { fn: "in", args: [{ column: "event_name" }, { value: "purchase" }, { value: "refund" }] } when the task concerns some events). It scopes the measures declared beside it, so an item with a where declares measures.'),
      dimensions: { type: 'array', items: dimensionItemSchema(catalog, modelKey) },
      measures: {
        type: 'array',
        items: measureForm({
          ref: EXPR_REF, pattern: NAME,
          nameDescription: 'The measure\'s name; metrics read it by this name (stored as <task>_<name>).',
          exprDescription: 'ONE aggregate of the model\'s rows — sum, average, min, max, median, percentile (with `percentile`), count_distinct, or count (with no args it counts the rows) — over a row expression, its `where` the rows it folds (with the item\'s own where): { fn: "count", where: [{ fn: "eq", args: [{ column: "event_name" }, { value: "purchase" }] }] }, { fn: "percentile", args: [{ property: "load_ms" }], percentile: 0.9 }. A formula over several aggregates is several measures and a derived metric.',
          extra: { label },
        }),
      },
    },
  };
}

export function metricSchema(catalog) {
  // what a metric reads is named as a string — a measure of this call or already in the context, as it
  // was declared ('n') or as it is stored ('ret_n'), or a governed measure of the catalog — so no
  // pattern: a stored name is longer than a declared one
  const ref = (description) => ({ type: 'string', minLength: 1, description });
  const fields = {
    name: { type: 'string', pattern: NAME, description: 'Unique metric name (lowercase snake_case). Queried as <task>_<name>.' },
    label: { type: 'string', description: D.label },
    measure: ref('The measure it reads, by name: one declared in this call or already in the context (as declared, or as stored: <task>_<name>), or a governed measure of the catalog.'),
    fill_nulls_with: { type: 'number', description: 'Value to substitute for NULL results (e.g. 0) so gaps in a time series render as zeros.' },
    grain_to_date: { enum: GRAINS, description: 'Reset accumulation at the start of each period (e.g. month-to-date).' },
    period_agg: { enum: ['first', 'last', 'average'], description: 'How to collapse multiple values within a period.' },
    window: { type: 'string', pattern: WINDOW, description: 'Accumulate over a trailing window (e.g. "7 days"); omit it for all history.' },
    expr: { $ref: METRIC_EXPR_REF, description: 'The metric\'s value over the metrics it is built from — each a { metric } leaf (of this call or already in the context, as declared or as stored), which is how its inputs are named.' },
  };
  // one form per kind of metric, each with exactly the fields that kind reads (src/compile.js)
  const kind = (type, title, required, optional) => form({ title, tag: ['type', type], required: ['name', ...required], properties: pick(fields, ['name', 'label', ...required, ...optional]) });
  return {
    type: 'object',
    description: 'A metric: simple wraps one measure; cumulative accumulates a measure over time — over all history or a trailing window, or to date within a grain; derived computes an expression over other metrics (a ratio of two is a derived metric dividing one by the other). A conversion (B within a window of A) is a pipeline, not a metric: semantic_index({ request: { recipe: "conversion_metric_window" } }).',
    anyOf: [
      kind('simple', 'simple: one measure', ['measure'], ['fill_nulls_with']),
      kind('cumulative', 'cumulative: over all history or a trailing window', ['measure'], ['window', 'period_agg']),
      kind('cumulative', 'cumulative: to date within a grain', ['measure', 'grain_to_date'], ['period_agg']),
      kind('derived', 'derived: an expression over other metrics', ['expr'], ['fill_nulls_with']),
    ],
  };
}

/** A dimension of the dbt project's OWN semantic layer (src/project-semantics.js), addressed by the
 *  semantic model that carries it — what a query of a context of the project's own semantic models names. */
export function projectRef(project, catalog) {
  const names = project.semantic_models.map((m) => m.name);
  return {
    type: 'object', additionalProperties: false, required: ['semantic_model', 'dimension'], title: 'a dimension of the project\'s semantic models',
    description: `A dimension of one of the dbt project's own semantic models, used in that model's context (context_id: the semantic model's name), named by what it is and where it lives: semantic_model is the chain of semantic models it is reached through — ["<the context's own>"] for a dimension of the context's own model, ["X"] for one of X joined to directly, ["A", "X"] for one of X reached through A — and MetricFlow makes the joins. In group_by its result column is <semantic_model>_<dimension>, with _<grain> for a time dimension; in where the condition compares its values. preview_semantic_model({ request: { context_id, metric } }) lists every dimension a metric takes, spelled as here, under its group_by.dimensions.`,
    properties: {
      semantic_model: { type: 'array', minItems: 1, items: { enum: names }, description: 'Where the dimension lives: the chain of semantic models it is reached through, in order, ending with the one that carries it — one model for its own dimensions or a direct join, several for a chain of joins.' },
      dimension: { type: 'string', description: 'The dimension\'s name, as the project declares it.' },
      grain: { enum: catalog.timeGranularities(), description: 'Only for a time dimension: the bucket rows are grouped into (default: the dimension\'s own granularity).' },
    },
  };
}

/** An entity of the dbt project's own semantic layer, grouped or filtered by name — the key a project
 *  may declare only as an entity (an app, a country), which MetricFlow groups by as it is. → [] when
 *  the layer declares none, [ref] otherwise. */
export function projectEntityRef(project) {
  const entities = [...new Set(project.semantic_models.flatMap((m) => m.entities.map((e) => e.name)))].sort();
  if (!entities.length) return [];
  return [{
    type: 'object', additionalProperties: false, required: ['entity'], title: 'an entity of the project\'s semantic models',
    description: `An entity of one of the dbt project's own semantic models, by name, used in that model's context: a key the project declares as an entity — often a column with no dimension of its own, such as a foreign key. Grouping by it gives one row per key value, its result column the entity's name; in where the condition compares the key's values. Every requested metric has to carry it; preview_semantic_model({ request: { context_id, metric } }) lists a metric's entities under its group_by.entities.`,
    properties: {
      entity: { enum: entities, description: 'The entity\'s name, as the project declares it.' },
    },
  }];
}

/**
 * What a metric query can name on `model` as an attribute — the set the engine resolves
 * (semantic-query.js): its groupable dimensions and dimension columns and, on an events source, the
 * scalar payload properties a task declares as dimensions.
 */
export function modelAttributes(catalog, model) {
  const m = catalog.models[model];
  return [...new Set([
    ...Object.keys(m.dimensions || {}),
    ...catalog.modelDimensionColumns(model),
    ...(catalog.isFact(model) ? catalog.scalarEventProps(model) : []),
  ])];
}

/** The relationships that lead to `model`: each entity a model declares whose owner is `model`. */
export function relationshipsTo(catalog, model) {
  return [...new Set(catalog.modelKeys().flatMap((k) => Object.keys(catalog.entitiesOf(k))).filter((e) => catalog.joinTargetFor(e) === model))];
}

/**
 * `{ model, attribute, via? }` — ONE CLOSED FORM PER MODEL, each with that model's own attributes as
 * an enum, so an attribute is written exactly as the model carries it — or, on a model a semantic layer
 * loads, the name of a dimension a task computed there ({ name, expr }), which no catalog lists and the
 * query checks against the context; `via` is there only on a model several relationships lead to (one
 * is chosen for the caller otherwise). `lead` adds fixed fields in front (a where's `kind`).
 */
export function attributeRefForms(catalog, { lead = {}, required = [] } = {}) {
  const semantic = new Set(catalog.semanticModelKeys());
  return catalog.modelKeys().map((model) => {
    const attrs = modelAttributes(catalog, model);
    if (!attrs.length && !semantic.has(model)) return null;
    const vias = relationshipsTo(catalog, model);
    const listed = { ...strEnum(attrs, `An attribute of ${model}, as semantic_index({ request: { source: "${model}" } }) lists it.`), title: `an attribute ${model} carries` };
    const computed = { type: 'string', pattern: NAME, title: 'a computed dimension', description: `A dimension a task of this context computed on ${model} ({ name, expr }), by its name.` };
    return {
      type: 'object', additionalProperties: false, title: `an attribute of ${model}`, required: [...required, 'model', 'attribute'],
      properties: {
        ...lead,
        model: { const: model, description: 'The model that carries the attribute.' },
        attribute: semantic.has(model) ? (attrs.length ? { anyOf: [listed, computed] } : computed) : listed,
        ...(vias.length > 1 ? { via: { enum: vias, description: `The relationship to reach ${model} through — several lead to it.` } } : {}),
      },
    };
  }).filter(Boolean);
}

/** A metric_time window, as a metric query takes it (src/schema-kit.js timeRange: the one window shape). */
export const METRIC_TIME_RANGE = timeRange('Restrict to a metric_time range (ISO dates). Unbounded queries scan the whole history — always bound when exploring.');

/** The metric time axis at a grain — as group_by and where name it. */
export const timeRef = (catalog) => ({ type: 'object', additionalProperties: false, required: ['time'], title: 'the metric time axis', description: 'The metric time axis at a grain.', properties: { time: { enum: ['metric_time'], description: 'The metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time bucket size.' } } });

/**
 * A METRIC QUERY'S WHERE — query_semantic_model's `$defs.expr`: the one expression grammar over the
 * references its group_by takes (the metric time axis, { model, attribute }, and in a context of the
 * project's own layer { semantic_model, dimension } and { entity }) and constants, with the conditions,
 * the logic and the scalar functions (src/predicate.js WHERE_FNS) — no aggregate, no window, no column:
 * a where filters the rows a metric folds, named as the query names them. A where is a list of these
 * that all hold.
 */
export function whereDefs(catalog, project = null) {
  const refs = [timeRef(catalog), ...attributeRefForms(catalog), ...(project ? [projectRef(project, catalog), ...projectEntityRef(project)] : [])];
  return {
    expr: exprSchema(catalog, {
      ref: EXPR_REF, leaves: [...refs, valueLeaf()], fns: WHERE_FNS, windows: false, sourced: false,
      description: `A condition of a metric query, or a value in one: a leaf — what is compared, named as group_by names it (${project ? '{ model, attribute } in a task\'s context, { semantic_model, dimension } or { entity } in a context of the dbt project\'s own semantic models, ' : '{ model, attribute } — the join path is resolved from the schema — '}{ time: "metric_time", grain } for the time axis), or a constant { value } — or a function { fn, args: [expressions], … }, nested to any depth: eq / neq / gt / gte / lt / lte [a, b], in / not_in [a, member, …], between [a, low, high], is_null / is_not_null [a], like / not_like / contains / starts_with / ends_with [text, pattern]; and / or / not; and the scalar functions (date_part, lower, coalesce, …) around a reference. E.g. { fn: "eq", args: [{ model: "users", attribute: "country" }, { value: "US" }] }. A comparison with a missing value does not hold — test it with is_null.`,
    }),
  };
}

// The ceiling on the pacing timer (`time`). A wait happens INSIDE a tool call, so it is bounded by
// the same thing a build's grace is bounded by: the client's own timeout, which this server neither
// knows nor can raise. Asking for more than this is refused by the schema (the timer's `seconds` and a
// read's `wait_seconds` alike), so a wait is never cut short behind the caller's back.
export const MAX_WAIT_SECONDS = 30;
/** How many rows a read of a task ({ task_ids }) hands back unless it asks for another number: its offset and limit are row numbers of the task's result, the rest is a next_offset away. */
export const READ_PAGE = 50;
/** How many rows of its result a query task keeps unless its `limit` says otherwise — what a read pages through and a card draws (a stored result keeps every row in its table). */
export const KEPT_ROWS = 1000;
/** How many contexts one context({ action: list }) page holds, unless it asks for another number. */
export const CONTEXT_PAGE = 20;


/**
 * THE READ HALF OF A QUERY TOOL — { task_ids } waits for tasks of the tool's side and returns each one;
 * with cancel: true it stops them. One definition for every query tool, the core's and a feature's, so
 * a read is written the same way whichever side it reads.
 */
export const TASK_READ = {
  task_ids: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: TASK_ID }, description: 'Read tasks of this side back (instead of starting one) — one, or several read together: waits until all are done and returns each one\'s result under `results`, in this order.' },
  wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `How long to wait at most (default and cap ${MAX_WAIT_SECONDS}); it returns the moment every task is done. 0 = just look.` },
  cancel: { type: 'boolean', const: true, description: 'Stop these tasks instead of reading them: a running task ends at once as cancelled (its warehouse process is stopped; one still queued never starts); a finished one is left as it is.' },
};
