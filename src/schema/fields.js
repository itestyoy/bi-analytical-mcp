// THE PIECES THE TOOL SCHEMAS SHARE — the name patterns, the reused descriptions, the items a
// declaration and a query are written in (a measure, a dimension, a where item, a metric, a reference
// into the project's own layer), the predicate grammar, and the limits every tool quotes (how long a
// read waits, how many queries a batch holds). The tools are put together in src/schema.js.

import { TASK_MEASURE_AGGS, NUMERIC_AGGS, GRAINS } from '../catalog.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { strEnum, anyOfOr, withoutEmpty, form, pick, conditionList, CONSTANT, timeRange } from '../schema-kit.js';
import { measureSchema, TYPES } from '../pipeline/sql.js';
import { OPS } from '../conditions.js';
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

// A SEMANTIC MODEL'S FIELDS — what a declaration names on its source: its columns, and on an events
// source its scalar payload properties (the catalog reads either where it is stored) and the amounts
// the schema marks aggregatable. One word for all of them, `field`, in a measure, a dimension and a
// condition alike.

/** The fields a condition of a semantic model compares: its columns and scalar properties. */
const conditionFields = (catalog, modelKey) => [...new Set([...catalog.modelColumns(modelKey).map((c) => c.name), ...(catalog.isFact(modelKey) ? catalog.scalarEventProps(modelKey) : [])])].sort();

/** A semantic model's conditions — the one condition grammar, its subject a `field` of the model. */
function fieldConditions(catalog, modelKey, description) {
  const fields = conditionFields(catalog, modelKey);
  const leaf = {
    type: 'object', additionalProperties: false, required: ['field', 'op'],
    properties: {
      field: strEnum(fields),
      op: { enum: OPS },
      value: { ...CONSTANT, description: 'An array for in/not_in, [low, high] for between, none for is_null/is_not_null.' },
    },
  };
  return conditionList(leaf, description);
}

/** What a measure may aggregate on a model: an entity key, any column, a scalar property, a declared amount. */
const measureFields = (catalog, modelKey) => [...new Set([
  ...catalog.entityKeyColumns(modelKey),
  ...catalog.modelColumns(modelKey).map((c) => c.name),
  ...(catalog.isFact(modelKey) ? catalog.scalarEventProps(modelKey) : []),
  ...catalog.aggregatableFields(modelKey).map((a) => a.name),
])].sort();

/** A measure of a semantic model: the measure every place aggregates with, over the model's fields —
 *  the functions a task chooses from (TASK_MEASURE_AGGS), and `cast` only where a number is folded. */
function measureItemSchema(catalog, modelKey) {
  return measureSchema({
    aggs: [...TASK_MEASURE_AGGS],
    key: 'field',
    column: strEnum(measureFields(catalog, modelKey)),
    pattern: NAME,
    nameDescription: 'The measure\'s name; metrics read it by this name (stored as <task>_<name>).',
    optional: ['count'],
    where: fieldConditions(catalog, modelKey, 'The rows this measure folds: all of them hold (with the model\'s own where). A funnel step is a measure whose where names the event and a property value; a count of the rows where a condition holds is a count with that where.'),
    extra: { label: { type: 'string', description: D.label } },
    numeric: {
      aggs: [...NUMERIC_AGGS],
      extra: { cast: { enum: TYPES.filter((t) => t !== 'string'), description: 'Read the field as a number first — for a text field that holds numbers (a value that does not convert is NULL).' } },
    },
  });
}

/** The fields a dimension of `modelKey` may name: its groupable columns and, on an events source,
 *  its scalar payload properties — what a declaration adds and an update removes. */
export function dimensionFields(catalog, modelKey) {
  return [...new Set([...catalog.modelDimensionColumns(modelKey), ...(catalog.isFact(modelKey) ? catalog.scalarEventProps(modelKey) : [])])].sort();
}

/** The model's columns the catalog types as time: a dimension of one is a time dimension, read at a grain. */
export function timeDimensionFields(catalog, modelKey) {
  const dims = catalog.getModel(modelKey).dimensions || {};
  return catalog.modelDimensionColumns(modelKey).filter((c) => dims[c]?.type === 'time').sort();
}

/**
 * A dimension of a semantic model, in closed forms by what its field is: a column the catalog types
 * as time is a time dimension at `grain` (default: the catalog's granularity for it), everything
 * else — a column, a scalar payload property — is categorical and takes no grain.
 */
function dimensionItemSchema(catalog, modelKey) {
  const fields = dimensionFields(catalog, modelKey);
  if (!fields.length) return undefined;
  const time = timeDimensionFields(catalog, modelKey);
  const other = fields.filter((f) => !time.includes(f));
  const label = { type: 'string', description: D.label };
  const forms = [
    ...(time.length ? [form({ title: 'a time column', tag: ['field', time], properties: { grain: { enum: catalog.timeGranularities(), description: 'The bucket its values are read at (default: the column\'s own granularity in the catalog).' }, label } })] : []),
    ...(other.length ? [form({ title: 'a categorical field', tag: ['field', other], properties: { label } })] : []),
  ];
  return forms.length === 1 ? forms[0] : { type: 'object', anyOf: forms };
}

export function semanticModelBranch(catalog, modelKey) {
  const dimItem = dimensionItemSchema(catalog, modelKey);
  const props = withoutEmpty({
    from: { const: modelKey },
    where: fieldConditions(catalog, modelKey, 'Rows every measure of this item folds: all of them hold (e.g. { field: "event_name", op: "in", value: [...] } when the task concerns some events). It scopes the measures declared beside it, so an item with a where declares measures.'),
    dimensions: dimItem && { type: 'array', items: dimItem },
    measures: { type: 'array', items: measureItemSchema(catalog, modelKey) },
  });
  return { type: 'object', additionalProperties: false, required: ['from'], title: modelKey, properties: props };
}

export function metricSchema(catalog) {
  // what a metric reads is named as a string — a measure or a metric of this call or already in the
  // context, as it was declared ('n') or as it is stored ('ret_n'), or a governed measure of the
  // catalog — so no pattern: a stored name is longer than a declared one
  const ref = (description) => ({ type: 'string', minLength: 1, description });
  const fields = {
    name: { type: 'string', pattern: NAME, description: 'Unique metric name (lowercase snake_case). Queried as <task>_<name>.' },
    label: { type: 'string', description: D.label },
    measure: ref('The measure it reads, by name: one declared in this call or already in the context (as declared, or as stored: <task>_<name>), or a governed measure of the catalog.'),
    fill_nulls_with: { type: 'number', description: 'Value to substitute for NULL results (e.g. 0) so gaps in a time series render as zeros.' },
    numerator: ref('The measure on top of the division, by name (as `measure` names one).'),
    denominator: ref('The measure on the bottom of the division, by name (as `measure` names one).'),
    grain_to_date: { enum: GRAINS, description: 'Reset accumulation at the start of each period (e.g. month-to-date).' },
    period_agg: { enum: ['first', 'last', 'average'], description: 'How to collapse multiple values within a period.' },
    window: { type: 'string', pattern: WINDOW, description: 'Accumulate over a trailing window (e.g. "7 days"); omit it for all history.' },
    expr: { type: 'string', description: 'Arithmetic over the metrics listed in `metrics`, each written as it is listed there, e.g. "coins_in - coins_out". Restricted to a safe grammar: those names, numbers, + - * / ( ) and basic math functions.' },
    metrics: { type: 'array', minItems: 1, uniqueItems: true, items: ref('A metric of this call or already in the context, by name (as declared, or as stored: <task>_<name>).'), description: 'The metrics `expr` is computed from, each named as `expr` writes it.' },
  };
  // one form per kind of metric, each with exactly the fields that kind reads (src/compile.js)
  const kind = (type, title, required, optional) => form({ title, tag: ['type', type], required: ['name', ...required], properties: pick(fields, ['name', 'label', ...required, ...optional]) });
  return {
    type: 'object',
    description: 'A metric: simple wraps one measure; ratio = numerator / denominator; cumulative accumulates a measure over time — over all history or a trailing window, or to date within a grain; derived computes an expression over other metrics. A conversion (B within a window of A) is a pipeline, not a metric: semantic_index({ request: { recipe: "conversion_metric_window" } }).',
    anyOf: [
      kind('simple', 'simple: one measure', ['measure'], ['fill_nulls_with']),
      kind('ratio', 'ratio: numerator / denominator', ['numerator', 'denominator'], []),
      kind('cumulative', 'cumulative: over all history or a trailing window', ['measure'], ['window', 'period_agg']),
      kind('cumulative', 'cumulative: to date within a grain', ['measure', 'grain_to_date'], ['period_agg']),
      kind('derived', 'derived: an expression over other metrics', ['expr', 'metrics'], []),
    ],
  };
}

/** A dimension of the dbt project's OWN semantic layer (src/project-semantics.js), addressed by the
 *  semantic model that carries it — what a query of a context of the project's own semantic models names. */
export function projectRef(project, catalog) {
  const names = project.semantic_models.map((m) => m.name);
  return {
    type: 'object', additionalProperties: false, required: ['semantic_model', 'dimension'],
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
    type: 'object', additionalProperties: false, required: ['entity'],
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
 * an enum, so an attribute is written exactly as the model carries it; `via` is there only on a model
 * several relationships lead to (one is chosen for the caller otherwise). `lead` adds fixed fields in
 * front (a where's `kind`).
 */
export function attributeRefForms(catalog, { lead = {}, required = [] } = {}) {
  return catalog.modelKeys().map((model) => {
    const attrs = modelAttributes(catalog, model);
    if (!attrs.length) return null;
    const vias = relationshipsTo(catalog, model);
    return {
      type: 'object', additionalProperties: false, title: `an attribute of ${model}`, required: [...required, 'model', 'attribute'],
      properties: {
        ...lead,
        model: { const: model, description: 'The model that carries the attribute.' },
        attribute: strEnum(attrs, `An attribute of ${model}, as semantic_index({ request: { source: "${model}" } }) lists it.`),
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
 * A query's conditions: `predicate` is one condition — a field named exactly as group_by names it,
 * an operator, a value — and a where is a list of them (src/schema-kit.js conditionList).
 */
export function predicateDefs(catalog, project = null) {
  return {
    predicate: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'op'],
      description: 'A single filter condition (field OP value).',
      properties: {
        field: {
          description: 'What is compared, named as group_by names it: { model, attribute } for a dimension (the join path is resolved from the schema), { time: "metric_time", grain } for the metric time axis' + (project ? '; in a context of one of the dbt project\'s own semantic models, { semantic_model, dimension } or { entity }' : '') + '.',
          anyOf: [timeRef(catalog), ...attributeRefForms(catalog), ...(project ? [projectRef(project, catalog), ...projectEntityRef(project)] : [])],
        },
        op: { enum: OPS, description: 'Comparison operator. between takes [low, high]; in/not_in take an array; the text operators a string; is_null/is_not_null take no value.' },
        value: { ...CONSTANT, description: 'Value to compare against (scalar, array for in/not_in/between). Bound as an escaped literal.' },
      },
    },
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
