// THE PIECES THE TOOL SCHEMAS SHARE — the name patterns, the reused descriptions, the items a
// declaration is written in (a measure, a dimension, a metric), the semantic declaration's `$defs` (the
// one expression of src/pipeline/compute.js), what the checks of the semantic side say (dry_run,
// validate), and the limits every tool quotes (how long a read waits, how many queries a batch holds).
// The tools are put together in src/schema.js; a metric query's one step of its own (the metrics step,
// no pipeline stage) is written here, and the place that takes it offers it (src/pipeline/stages.js
// STAGE_PLACES.metric_scope).

import { GRAINS } from '../catalog.js';
import { TASK_ID_PATTERN } from '../jobs.js';
import { form, pick, timeRange, measureForm } from '../schema-kit.js';
import { exprDefs, EXPR_REF, EXPR_KINDS, PLACES } from '../pipeline/compute.js';
import { CONTEXT_ID } from '../context-manager.js';
import { contractOnSchema } from '../catalog/joins.js';
import { SEMANTIC_NAME, NAME, TASK } from './names.js';

export { SEMANTIC_NAME, NAME, TASK } from './names.js';

export const CTX = CONTEXT_ID;

export const TASK_ID = TASK_ID_PATTERN;

// a trailing window MetricFlow reads: a count and a unit of the grains metric_time is offered at
export const WINDOW = '^[0-9]+ (day|week|month|quarter|year)s?$';

// Reusable property-description strings (kept consistent across tools).
export const D = {
  context_id: 'The context to work in; omitted on start, a new one.',
  label: 'Default: the name.',
};

/**
 * The `$defs` of a semantic declaration: the expression in the KINDS a declaration writes it in
 * (src/pipeline/compute.js EXPR_KINDS), each built by the one builder every tool's is and checked again as
 * it is compiled (src/compile.js): the row expression (`expr`) of a semantic model's where, computed
 * dimensions and a measure's arguments, and a measure itself (`aggregate`: ONE aggregate over row
 * expressions) — both at PLACES.semantic_model: its columns, checked against the model it is written on
 * with "did you mean", its event properties on an events source, constants, the current time, no window,
 * no raw — and a derived metric's value (`metric_expr`, PLACES.derived_metric: { metric } leaves and
 * numbers, in arithmetic). `kinds`: each kind's places (src/schema.js TOOL_PLACES). `project`: the dbt
 * project's own layer, whose names the expression's refs offer too.
 */
export function semanticDefs(catalog, { project = null, kinds = {} } = {}) {
  return exprDefs(catalog, { project, kinds });
}

/**
 * WHAT THE CHECKS SAY — two words, by what they need, one rule for every tool that takes one: `dry_run`
 * compiles and shows, in the call's task, reading nothing and building nothing (a declaration; a query,
 * after the context's build); `validate` checks on the warehouse, a task of its own (a pipeline preview:
 * dbt run --empty, reading no data; a context's describe: MetricFlow, and over a time_range the
 * warehouse). `what` is what dry_run shows, `validateAt` where the check on the warehouse is; `how` what
 * validate runs, `readWith` the tool its task is read with.
 */
export const DRY_RUN = (what, validateAt = null) => `Compile and show ${what}, reading nothing and building nothing${validateAt ? ` — the check that runs on the warehouse is ${validateAt}` : ''}.`;
export const VALIDATE = (how, readWith) => `Check on the warehouse: ${how} — a task, read with ${readWith}.`;

/** A computed dimension's name — what it is grouped and filtered by. */
const DIMENSION_NAME = { type: 'string', pattern: SEMANTIC_NAME, description: 'Queried as { semantic_model: [<its source>], dimension: <this name> }.' };

export function metricSchema(catalog) {
  // what a metric reads is named as a string — a measure of this step, or a governed measure of the
  // catalog, by its name
  const ref = (description) => ({ type: 'string', minLength: 1, description });
  const fields = {
    name: { type: 'string', pattern: SEMANTIC_NAME, description: 'Unique in the context; queried by this name.' },
    label: { type: 'string', description: D.label },
    measure: ref('A measure of this step, or a governed measure of the catalog.'),
    fill_nulls_with: { type: 'number', description: 'The value (e.g. 0) where a result row has none; it adds no rows.' },
    grain_to_date: { enum: GRAINS, description: 'E.g. month-to-date.' },
    period_agg: { enum: ['first', 'last', 'average'], description: 'What a week or a month shows of its daily values; default first, usually last is meant.' },
    window: { type: 'string', pattern: WINDOW, description: 'A trailing window, e.g. "7 days"; omitted, all history.' },
    expr: { $ref: EXPR_KINDS.metric_expr.ref, description: 'Over { metric } leaves and numbers; div is NULL where the divisor is 0. A ratio: { fn: "div", args: [{ metric: "payers" }, { metric: "users" }] }.' },
  };
  // one form per kind of metric, each with exactly the fields that kind reads (src/compile.js)
  const kind = (type, title, required, optional) => form({ title, tag: ['type', type], required: ['name', ...required], properties: pick(fields, ['name', 'label', ...required, ...optional]) });
  return {
    type: 'object',
    description: 'A cumulative metric with a window or grain_to_date is queried by metric_time. A conversion (B within a window of A) is a pipeline, not a metric: recipe "conversion_metric_window".',
    anyOf: [
      kind('simple', 'simple: one measure', ['measure'], ['fill_nulls_with']),
      kind('cumulative', 'cumulative: over all history or a trailing window', ['measure'], ['window', 'period_agg']),
      kind('cumulative', 'cumulative: to date within a grain', ['measure', 'grain_to_date'], ['period_agg']),
      kind('derived', 'derived: an expression over other metrics', ['expr'], ['fill_nulls_with']),
    ],
  };
}

/** A metric_time window, as a metric query takes it (src/schema-kit.js timeRange: the one window shape). */
export const METRIC_TIME_RANGE = timeRange('A metric query\'s metric_time window; unbounded scans the whole history. Days are UTC days.');

/** The fields a metric query takes beside its context — the one list query_model's start form
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
 * which puts it in query_model's `$defs.stage` — and what any other place says of it (`elsewhere`).
 */
export const METRICS_STEP = {
  stage: 'metrics',
  group: 'semantic',
  elsewhere: 'a metrics step is what the semantic layer computes, one per metric query (query_model)',
  schema: (_catalog, { project = null } = {}) => ({
    type: 'object', additionalProperties: false, required: ['stage', 'metrics'],
    description: 'The metrics, one column each, by group_by. Where steps before it filter the rows; steps after it work on its result.',
    properties: {
      stage: { enum: [METRICS_STEP.stage] },
      metrics: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'By the names the context offers (context describe lists them).' },
      group_by: {
        type: 'array', uniqueItems: true, items: { $ref: '#/$defs/ref' },
        description: `In a build's context: { time: "metric_time", grain }, { source, column } of a model the semantic_model step joins, { source, property } it declared a dimension, { semantic_model: [<its source>], dimension } it computed, { entity }.${project ? ' In a project semantic model\'s context: { semantic_model: [<chain of models>], dimension, grain? } and { entity } — context describe with metric lists them.' : ''}`,
      },
    },
  }),
};

/**
 * THE LAST STEP OF A BUILD — the semantic layer over the build's rows (src/pipeline/semantic-stage.js):
 * its dimensions, the models it joins for their attributes, its measures and its metrics. No stage of the
 * registry (MetricFlow computes what it declares); offered by the place of a build
 * (src/pipeline/stages.js STAGE_PLACES.build), and said where it is taken by every other place.
 */
export const SEMANTIC_MODEL_STEP = {
  stage: 'semantic_model',
  group: 'semantic',
  elsewhere: 'a semantic_model step is a build\'s last step, the semantic layer over its rows (build_model)',
  schema: (catalog) => {
    const label = { type: 'string', description: D.label };
    const loadable = catalog.semanticModelKeys();
    // a model whose attributes a metric is grouped by: one that declares a join contract, that the
    // semantic layer loads and that owns a key another model carries — what MetricFlow joins onto —
    // joined on its contract's parts (checked against that key when the step is built)
    const owns = (k) => Object.keys(catalog.entitiesOf(k)).some((r) => catalog.joinTargetFor(r) === k && catalog.modelKeys().some((m) => m !== k && catalog.entityKey(m, r)?.length));
    const joinable = catalog.joinableModels().filter((k) => loadable.includes(k) && owns(k));
    const dimension = {
      type: 'object', title: 'a dimension of the main model',
      anyOf: [
        form({ title: 'a column', required: ['column'], properties: { column: { type: 'string', pattern: NAME }, grain: { enum: catalog.timeGranularities() }, label } }),
        form({ title: 'an event property', required: ['property'], properties: { property: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'Queried as { source, property }.' }, label } }),
        form({ title: 'a computed dimension', required: ['name', 'expr'], properties: { name: DIMENSION_NAME, expr: { $ref: EXPR_REF, description: 'A row expression, no aggregate.' }, label } }),
      ],
    };
    return {
      type: 'object', additionalProperties: false, required: ['stage', 'metrics'],
      description: 'The build\'s last step: named metrics over its source, or over the table the steps before it built, queried with query_model.',
      properties: {
        stage: { enum: ['semantic_model'] },
        time: { type: 'string', pattern: NAME, description: 'The time axis of a table the steps before built.' },
        dimensions: { type: 'array', items: dimension, description: 'Beyond its catalog columns.' },
        ...(joinable.length ? {
          join: {
            type: 'array', uniqueItems: true,
            description: 'Models whose attributes the metrics are grouped by, each on its join contract.',
            items: { anyOf: joinable.map((k) => form({ title: `join ${k}`, required: ['source', 'on'], properties: { source: { const: k }, on: contractOnSchema(k, catalog.joinContract(k)) } })) },
          },
        } : {}),
        measures: {
          type: 'array',
          items: measureForm({
            ref: EXPR_KINDS.aggregate.ref, pattern: SEMANTIC_NAME,
            nameDescription: 'Metrics read it by this name.',
            exprDescription: 'ONE aggregate.',
            extra: { label, source: { enum: loadable, description: `${loadable.some((k) => catalog.models[k]?.scd) ? `A measure on a slowly-changing model (${loadable.filter((k) => catalog.models[k]?.scd).join(', ')}) is dropped. ` : ''}Fold this model\'s own rows instead of the main model\'s; omitted, the main model.` } },
          }),
        },
        metrics: { type: 'array', minItems: 1, items: metricSchema(catalog) },
      },
    };
  },
};

// The ceiling on a read's wait ({ task_ids }). A wait happens INSIDE a tool call, so it is bounded by
// the same thing a build's grace is bounded by: the client's own timeout, which this server neither
// knows nor can raise. Asking for more than this is refused by the schema (a read's `wait_seconds`),
// so a wait is never cut short behind the caller's back.
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
  task_ids: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: TASK_ID }, description: 'Read these tasks back (waits until all are done).' },
  wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: '0: just look.' },
  cancel: { type: 'boolean', const: true, description: 'Stop these tasks.' },
};
