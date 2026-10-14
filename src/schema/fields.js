// THE PIECES THE TOOL SCHEMAS SHARE — the name patterns, the reused descriptions, the items a
// declaration is written in (a measure, a dimension, a metric), the semantic declaration's `$defs` (the
// one expression of src/pipeline/compute.js), what the checks of the semantic side say (dry_run,
// validate), and the limits every tool quotes (how long a read waits, how many queries a batch holds).
// The tools are put together in src/schema.js; a metric query's one step of its own (the metrics step,
// no pipeline stage) is written here, and the place that takes it offers it (src/pipeline/stages.js
// STAGE_PLACES.metric_scope).

import { GRAINS } from '../catalog.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { form, pick, timeRange, conditionSlot, measureForm } from '../schema-kit.js';
import { exprSchema, EXPR_REF, PLACES } from '../pipeline/compute.js';
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

/**
 * The `$defs` of build_semantic_model: the one expression (`expr`, src/pipeline/compute.js), built by the
 * one builder every tool's is. A declaration writes it at two places, each checked as it is compiled
 * (src/compile.js): a semantic model's where, computed dimensions and measures (PLACES.semantic_model —
 * its columns, checked against the model it is written on with "did you mean", its event properties on
 * an events source, constants, the current time), and a derived metric's value (PLACES.derived_metric —
 * { metric } leaves and numbers, in arithmetic). `places`: those two (src/schema.js TOOL_PLACES), so the
 * definition holds what they take together — no window, no raw. `project`: the dbt project's own layer,
 * whose names the expression's refs offer too.
 */
export function semanticDefs(catalog, { project = null, places = null } = {}) {
  return { expr: exprSchema(catalog, { project, places }) };
}

/**
 * WHAT THE CHECKS SAY — two words, by what they need, one rule for every tool that takes one: `dry_run`
 * compiles and shows, in the call's task, reading nothing and building nothing (a declaration; a query,
 * after the context's build); `validate` checks on the warehouse, a task of its own (a pipeline preview:
 * dbt run --empty, reading no data; preview_semantic_model: MetricFlow, and over a time_range the
 * warehouse). `what` is what dry_run shows, `validateAt` where the check on the warehouse is; `how` what
 * validate runs, `readWith` the tool its task is read with.
 */
export const DRY_RUN = (what, validateAt = null) => `Compile and show ${what}, reading nothing and building nothing${validateAt ? ` — the check that runs on the warehouse is ${validateAt}` : ''}.`;
export const VALIDATE = (how, readWith) => `Check on the warehouse: ${how} — a task, read with ${readWith}.`;

/** The model's columns the catalog types as time: a dimension of one is a time dimension, read at a grain. */
function timeDimensionFields(catalog, modelKey) {
  const dims = catalog.getModel(modelKey).dimensions || {};
  return catalog.modelDimensionColumns(modelKey).filter((c) => dims[c]?.type === 'time').sort();
}

/** A computed dimension's name — what it is grouped and filtered by. */
const DIMENSION_NAME = { type: 'string', pattern: NAME, description: 'The dimension\'s name — grouped and filtered as { semantic_model: [<its source>], dimension: <this name> }.' };

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
 * A dimension an update removes, named the way it was declared — { source, column }, { source, property }
 * or { source, name } — over the models `keys` (those a semantic layer loads). → the item's forms.
 */
export function removedDimensionForms(catalog, keys) {
  return keys.flatMap((k) => {
    const source = { source: { const: k } };
    const columns = [...catalog.modelDimensionColumns(k)].sort();
    const props = dimensionProps(catalog, k);
    return [
      ...(columns.length ? [form({ title: `${k}: a column`, tag: ['column', columns], required: ['source'], properties: source })] : []),
      ...(props.length ? [form({ title: `${k}: an event property`, tag: ['property', props], required: ['source'], properties: source })] : []),
      form({ title: `${k}: a computed dimension`, required: ['source', 'name'], properties: { ...source, name: DIMENSION_NAME } }),
    ];
  });
}

export function semanticModelBranch(catalog, modelKey) {
  const label = { type: 'string', description: D.label };
  return {
    type: 'object', additionalProperties: false, required: ['source'], title: modelKey,
    properties: {
      source: { const: modelKey },
      where: conditionSlot(EXPR_REF, 'Rows every measure of this item folds: conditions that all hold (e.g. { fn: "in", args: [{ column: "event_name" }, { value: "purchase" }, { value: "refund" }] } when the task concerns some events). It scopes the measures declared beside it, so an item with a where declares measures.'),
      dimensions: { type: 'array', items: dimensionItemSchema(catalog, modelKey) },
      measures: {
        type: 'array',
        items: measureForm({
          ref: EXPR_REF, pattern: NAME,
          nameDescription: 'The measure\'s name; metrics read it by this name (stored as <task>_<name>).',
          exprDescription: 'ONE aggregate of the model\'s rows — sum, average, min, max, median, percentile (with `percentile`), count_distinct, or count (with no args it counts the rows) — over a row expression, a case where it folds only the rows a condition holds for (within the item\'s own where): { fn: "count", args: [{ fn: "case", cases: [{ when: [{ fn: "eq", args: [{ column: "event_name" }, { value: "purchase" }] }], then: { value: 1 } }] }] }, { fn: "percentile", args: [{ property: "load_ms" }], percentile: 0.9 }. A formula over several aggregates is several measures and a derived metric.',
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
    expr: { $ref: EXPR_REF, description: `The metric's value over the metrics it is built from — each a { metric } leaf (of this call or already in the context, as declared or as stored), which is how its inputs are named — and numbers ({ value: 2 }), combined by ${PLACES.derived_metric.fns.join(', ')}, nested to any depth; div is NULL where the divisor is 0. A ratio of two metrics: { fn: "div", args: [{ metric: "payers" }, { metric: "users" }] }.` },
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

/** A metric_time window, as a metric query takes it (src/schema-kit.js timeRange: the one window shape). */
export const METRIC_TIME_RANGE = timeRange('Restrict to a metric_time range (ISO dates). Unbounded queries scan the whole history — always bound when exploring.');

/** The fields a metric query takes beside its context — the one list query_semantic_model's start form
 *  and a batch's item are built from (src/schema.js), and what tells an earlier metric query apart from
 *  a bare list of metric names (src/earlier-spelling.js). */
export const METRIC_QUERY_FIELDS = ['steps', 'time_range', 'limit', 'materialize', 'dry_run', 'include'];

/**
 * WHAT A METRIC QUERY COMPUTES — its metrics step: the metrics by the names the context offers, and what
 * they are broken down by, each a ref of those a group_by takes (`$defs.ref`, built for REF_PLACES.group_by).
 * It is no pipeline stage: MetricFlow writes its SQL (src/engine/semantic-query.js runs it), so the stage
 * registry does not hold it and no build reaches it. ONE DEFINITION, read where it is offered and where it
 * is refused: its form (`schema`; `project` — the dbt project's own layer, whose contexts name their
 * dimensions its way), the group of `$defs.stage` it is listed under (STAGE_GROUPS, src/pipeline/stages.js),
 * the place that takes it and offers it — the steps of a metric query up to it (STAGE_PLACES.metric_scope),
 * which puts it in query_semantic_model's `$defs.stage` — and what any other place says of it (`elsewhere`).
 */
export const METRICS_STEP = {
  stage: 'metrics',
  group: 'semantic',
  elsewhere: 'a metrics step is what the semantic layer computes, one per metric query (query_semantic_model)',
  schema: (_catalog, { project = null } = {}) => ({
    type: 'object', additionalProperties: false, required: ['stage', 'metrics'],
    description: 'What the semantic layer computes: the metrics, one column each, broken down by group_by — one row per combination of its items. MetricFlow writes the SQL and makes every join. A query has one; the where steps before it filter the rows its metrics fold, the steps after it work on its result.',
    properties: {
      stage: { enum: [METRICS_STEP.stage] },
      metrics: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: `The metrics to compute, by the names the context offers: in a task's context, <task>_<metric> as build_semantic_model returned them${project ? '; in a context of one of the dbt project\'s own semantic models, the project\'s own names — every metric that reads that model (preview_semantic_model({ request: { context_id } }) lists them)' : ''}.` },
      group_by: {
        type: 'array', uniqueItems: true, items: { $ref: '#/$defs/ref' },
        description: `How to break the metrics down, one result column per item, in order — each a ref, of those a group_by takes. { time: "metric_time", grain } works in every context (column metric_time_<grain>). In a task's context: a column of a model, { source, column } — the join comes from the schema, and the context has to read the model (a semantic_models item of the build, { source } alone to load it; column <source>_<column>); an event property the task declared a dimension, { source, property } (column <source>_<property>); a dimension it computed, { semantic_model: [<its source>], dimension } (column <source>_<dimension>); an entity, { entity } (column: its name).${project ? ' In a context of one of the dbt project\'s own semantic models: { semantic_model: [...], dimension, grain? } — semantic_model is the chain of models the dimension is reached through (the context\'s own model alone for its own; column <semantic_model>_<dimension>) — and { entity }; preview_semantic_model({ request: { context_id, metric } }) lists exactly the items a metric takes.' : ''}`,
      },
    },
  }),
};

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
