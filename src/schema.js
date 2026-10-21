// Build JSON Schemas for the tools, with enums projected from the catalog.
// Everything that names a column/property/event/attribute is an enum -> an AI
// literally cannot submit an unknown name (validated by ajv at the boundary).
//
// Every property carries a `description` so the meaning/purpose of each
// parameter is self-explanatory to the MCP client (the AI) without external docs.
//
// This file puts the tools together; their pieces live in src/schema/: fields.js (what every tool
// shares — patterns, descriptions, the declaration and query items, the limits), display.js (the
// card), semantic-index.js, memory.js, experiment.js
// (each tool's own input), transport.js (how a schema is folded before it is sent).

import { ERROR_SOURCES } from './error-log.js';
import { stageDefs } from './pipeline.js';
import { exprDefs } from './pipeline/compute.js';
import { DRILL_ROWS } from './apps/result-view-model.js'; // the most rows one view of a drill-down card reads
import { TASK, CTX, TASK_ID, D, METRIC_TIME_RANGE, METRIC_QUERY_FIELDS, MAX_WAIT_SECONDS, READ_PAGE, KEPT_ROWS, CONTEXT_PAGE, TASK_READ, DRY_RUN, VALIDATE } from './schema/fields.js';
import { refSchema } from './schema/refs.js';
import { display } from './schema/display.js';
import { transportSchema } from './schema/transport.js';
import { form, pick, timeRange, SCALAR } from './schema-kit.js';
import { semanticIndexSchema } from './schema/semantic-index.js';
import { memorySchema } from './schema/memory.js';
import { analyzeContract, checkSplitContract, planContract, experimentSchema } from './schema/experiment.js';
export { MAX_WAIT_SECONDS, transportSchema };

/**
 * THE INPUT CONTRACTS OF THE ENGINE'S OWN METHODS — not tools. A tool hands its input to one of these
 * methods, and the method holds it to the exact contract named `<tool>.<mode>` below — experiment's
 * analyze / check_split / plan, delete_context's three targets, context's describe, a pipeline built
 * in one call. They are validated, never listed or called by a client: every tool is listed and called
 * by its one name.
 */
export const METHOD_CONTRACTS = new Set(['build_model.pipeline', 'delete_context.context', 'delete_context.pipeline_model', 'delete_context.semantic_model', 'context.describe', 'experiment.analyze', 'experiment.check_split', 'experiment.plan']);

/**
 * WHAT EACH TOOL'S DEFINITIONS HOLD — the places of the tool, by kind: where its expressions stand
 * (src/pipeline/compute.js PLACES), by the kind of expression each takes (EXPR_KINDS: `expr` the row
 * expression, and where a place takes a closed part of it, `aggregate` — a semantic measure — and
 * `metric_expr` — a derived metric's value), where its steps run (src/pipeline/stages.js STAGE_PLACES),
 * where it names a thing (src/schema/refs.js REF_PLACES). Its `$defs` of each expression kind, `$defs.stage`
 * and `$defs.ref` are one definition each, built for these places: they hold what the places take together
 * and nothing else, and where two places of one kind take different parts, each is checked as its value is
 * built. A method's contract takes its tool's (build_model.pipeline is a build's).
 */
export const TOOL_PLACES = {
  // a build: its steps over a source's rows, and its last step, the semantic layer over them — a semantic
  // model's row expression and measure (ONE aggregate of it), a derived metric's value, each a kind of its
  // own (src/pipeline/compute.js EXPR_KINDS)
  build_model: { expr: ['source_rows', 'semantic_model'], aggregate: ['semantic_model'], metric_expr: ['derived_metric'], stage: ['build'] },
  // a query: a metric query (where steps, its metrics step, then a read of its result) or a read of a
  // stored table (its read steps)
  query_model: { expr: ['metric_where', 'stored_rows', 'metric_result'], stage: ['metric_scope', 'metric_result', 'read'], ref: ['group_by', 'metric_result'] },
  // its views of the catalog's things, and the notes' filter by what they are about
  semantic_index: { ref: ['index_view', 'about'] },
  memory: { ref: ['about'] },
};

/**
 * `deletes`: the forms the features this deployment runs add to delete_context (src/features.js
 * featureDeletes) — each a kind of build a feature's context holds; none when no feature is on.
 */
export function buildSchemas(catalog, { project = null, projectContexts = [], deletes = [] } = {}) {
  // a context_id that may be a PRESET one — the dbt project's own semantic models, each a context
  // read at start and named after it — or any id a build returned: the presets are offered as values
  const contextId = (description) => (projectContexts.length
    ? {
      description,
      anyOf: [
        { type: 'string', enum: [...projectContexts].sort(), description: 'One of the dbt project\'s own semantic models: a context read at start, with nothing to build.' },
        { type: 'string', pattern: CTX, description: 'A context a build returned.' },
      ],
    }
    : { type: 'string', pattern: CTX, description });
  const modelKeys = catalog.modelKeys();
  // the models a semantic layer can load (a model with no primary entity is a pipeline join's)
  const semanticKeys = catalog.semanticModelKeys();
  // the window a pipeline reads its source in — the built-in-one-call contract and the builder's start alike
  const pipelineWindow = timeRange('Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied before the steps — avoids hand-written time literals and keeps whole-session windows intact.');

  // a pipeline built in one call (build_model.pipeline): a derived dbt model from a declarative PIPELINE
  // (a pipe-syntax transformation, optionally ending in a match_recognize funnel)
  // and materialize it. The pipeline's rows ARE the result. No caller writes this contract (a draft's
  // materialize hands its steps over in it), so its list keeps the engine's own name, `stages` — each
  // item the one stage definition (`$defs.stage`).
  const registerModel = {
    type: 'object', additionalProperties: false, required: ['name', 'pipeline'],
    description: 'Build a derived model from a PIPELINE: a `source` + ordered `stages` (where/compute/unnest/join/aggregate/pivot/unpivot/sample/order_by/limit/project, and the match_recognize funnel stage; window functions are compute expressions). Its ROWS are the result — the call returns a task_id and query_model({ request: { task_ids } }) returns them; a pipeline started from that task (from_task) re-slices them without recomputing. Funnels are pipelines too: add a match_recognize stage, then slice it with a downstream join/aggregate (e.g. conversion by country).',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
      description: { type: 'string', description: 'What this model computes, in your words. Kept with the context (returned by context({ request: { action: "describe" | "list" } })) and written into the generated model\'s config banner, so the table can be traced back to the question it answers.' },
      materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored: table (precomputed snapshot, default) or view (always fresh).' },
      dry_run: { type: 'boolean', description: DRY_RUN('the generated model definition') },
      pipeline: {
        type: 'object', additionalProperties: false, required: ['source', 'stages'],
        description: 'The transformation pipeline: a `source` table + ordered `stages` applied left-to-right.',
        properties: {
          source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Always named: each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
          time_range: pipelineWindow,
          stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/stage' }, description: 'Ordered pipe stages; each transforms the previous output.' },
        },
      },
    },
  };

  // build_model: compose a build INCREMENTALLY, one step at a time. A
  // single stateful tool with an `action`; add_steps validates each step and
  // returns the columns now available for the NEXT one (schema only — nothing is
  // materialized until materialize). A step is a stage, tagged by its `stage`.
  const pipelineFields = {
    context_id: { type: 'string', pattern: CTX, description: 'The context the draft is in — the context_id start returned. For fork it may also be a context whose pipeline was already materialized.' },
    name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
    description: { type: 'string', description: 'What this pipeline computes, in your words — kept with the draft, shown by context list / describe and in the model it builds, so two drafts can be told apart.' },
    materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored when materialized (chosen at start): table (default) or view.' },
    from_task: { type: 'string', pattern: TASK_ID, description: 'Begin from the stored table of a finished task — a query run with materialize:true, or a pipeline build — instead of a catalog source. The steps re-slice that result (filter, regroup, join, window…) without recomputing it.' },
    source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
    time_range: pipelineWindow,
    step: { $ref: '#/$defs/stage', description: 'One step — a stage { stage: "where" | "compute" | …, … } — that replaces step `index`, validated against the columns available at that point.' },
    steps: { type: 'array', minItems: 1, items: { $ref: '#/$defs/stage' }, description: 'Steps to append in order, each a stage { stage: "where" | "compute" | …, … } — one or several; with start, the draft\'s first ones. All or none; the response reports each step\'s effect on the data. A logical chunk at a time (scope, then the funnel, then the aggregate) shows how each changes the data.' },
    materialize: { type: 'boolean', description: 'Build right after the steps are added (or the step is replaced) — what a materialize call does: its task_id comes back beside the steps\' effects. The steps are added either way; a build that cannot start (one still running, say) is answered under `materialize` with why.' },
    index: { type: 'integer', minimum: 1, description: 'The step to replace (1-based, per steps[].index).' },
    after: { type: 'integer', minimum: 0, description: 'The steps the fork keeps: 1..after (omitted: every step; 0: none).' },
    validate: { type: 'boolean', description: VALIDATE('preview only — the draft\'s SQL runs with every input limited to zero rows (dbt run --empty), reading no data; worth it before an expensive materialize', 'query_model') },
    include: { type: 'array', uniqueItems: true, items: { enum: ['columns', 'steps'] }, description: 'What else the answer shows: "columns" — the full list of available columns (by default only what a step added and removed); "steps" — every step of the draft, as preview lists them (by default only the steps just added, or the one put in place, and steps_count).' },
  };
  // what an answer about the steps shows beyond what changed: offered to the actions that change them (and
  // fork), not to preview — which lists both already — nor to materialize / discard, whose answers carry neither
  const echo = ['include'];
  // One form per action, each with exactly the fields that action takes: a stray field is refused
  // rather than silently ignored, and nothing is said about it beside the form — it is not in it.
  const step = (action, title, tagDescription, required, optional = [], flags = echo) => form({ title, tag: ['action', action], tagDescription, required: ['context_id', ...required], properties: pick(pipelineFields, ['context_id', ...required, ...optional, ...flags]) });
  // a start makes the draft: in a new context, or — context_id given — in that one (its draft replaced)
  const startFields = { ...pipelineFields, context_id: { type: 'string', pattern: CTX, description: 'Start the draft in this context (one a build returned; a draft already in it is replaced). Omit it for a new context.' } };
  // a source is read within a window; a task's table was computed under its own already (a where step
  // filters it), so its form takes none
  const startOptional = ['context_id', 'description', 'materialized', 'steps', 'materialize', ...echo];
  const buildModel = {
    type: 'object',
    description: 'One form per `action`: start (the default — with `steps`, its first ones) → add_steps → optionally preview → materialize, then more steps and materialize again; materialize: true on start or add_steps builds right after the steps. Every edit revalidates the whole pipeline and names the step it breaks. A materialized table stands for the steps so far: later steps read it instead of recomputing the prefix, and editing a step at or before it retires it (from_checkpoint / steps_recomputed / checkpoints_dropped say which).',
    anyOf: [
      form({ title: 'start from a source', tag: ['action', 'start'], optionalTag: true, tagDescription: 'start (the default): a new draft over a catalog source (returns its context_id + the source columns).', required: ['name', 'source'], properties: pick(startFields, ['name', 'source', 'time_range', ...startOptional]) }),
      form({ title: 'start from a task', tag: ['action', 'start'], optionalTag: true, tagDescription: 'start (the default): a new draft over the stored table of a finished task (from_task); `source` names the source the steps resolve payload properties and relationships against (taken from the task when it read one source).', required: ['name', 'from_task'], properties: pick(startFields, ['name', 'from_task', 'source', ...startOptional]) }),
      step('add_steps', 'add steps', 'add_steps: append steps — one or several, in order, all or none; returns what each did to the data.', ['steps'], ['materialize']),
      step('edit_step', 'edit a step', 'edit_step: replace step `index` with `step`; every step after it is checked again.', ['index', 'step'], ['materialize']),
      step('fork', 'fork the draft', 'fork: branch a new draft, under a name of its own, from steps 1..`after` of this draft (or an already-materialized pipeline) without touching the original — iterate variants without re-typing the shared prefix, or go back to step N (after: N); description overrides the parent\'s.', ['name'], ['description', 'after']),
      step('preview', 'preview the draft', 'preview: the steps and the SQL that would run. With validate: true it starts a task instead (read with query_model) that runs the SQL with every input limited to zero rows (dbt run --empty): what the warehouse refuses is said in seconds, reading no data.', [], ['validate'], []),
      step(['materialize', 'discard'], 'materialize or discard', 'materialize builds the model and keeps the draft, recording the built table as the prefix the next steps read; discard drops the draft.', [], [], []),
    ],
  };

  // A QUERY IS ITS STEPS — a metric query (where steps, its metrics step, a read of its result) or a read
  // of a stored table (its read steps): the one expression, the one stage and the one ref (`$defs.expr`,
  // `$defs.stage`, `$defs.ref`), built for the tool's places — each step narrowed by its place as it is
  // built (STAGE_PLACES.metric_scope / metric_result / read, PLACES.metric_where / stored_rows), the
  // metrics step — no pipeline stage: the place up to it offers it (metric_scope's `offers`) — its own
  // group of the stage, its group_by the ref (REF_PLACES.group_by)
  const sq = TOOL_PLACES.query_model;
  const pdefs = { ...stageDefs(catalog, { project, places: sq.stage, exprPlaces: sq.expr }), ref: refSchema(catalog, { project, places: sq.ref }) };
  // THE MODES OF A QUERY TOOL, one form each: start one query (context_id + its fields), start a
  // batch (context_id + queries), read tasks (task_ids), cancel them. Told apart by the fields each
  // requires; each takes only its own.
  const queryModes = (startFields, batch, paging) => [
    form({ title: 'start a query', required: ['context_id', ...(startFields.required || [])], properties: { context_id: startFields.context_id, ...startFields.fields } }),
    form({ title: 'start a batch', required: ['context_id', 'queries'], properties: { context_id: startFields.context_id, queries: batch } }),
    form({ title: 'read tasks', required: ['task_ids'], properties: { ...pick(TASK_READ, ['task_ids', 'wait_seconds']), ...paging } }),
    form({ title: 'cancel tasks', required: ['task_ids', 'cancel'], properties: pick(TASK_READ, ['task_ids', 'cancel']) }),
  ];
  // A READ PAGES each task's result: its rows from `offset` (a row number of the result, 0 its first) —
  // the rows a task keeps, or the table it stored — READ_PAGE of them unless `limit` says otherwise
  const readPaging = {
    offset: { type: 'integer', minimum: 0, description: 'The row of each task\'s result the page starts at: 0 is its first row, next_offset where the previous page ended.' },
    limit: { type: 'integer', minimum: 1, maximum: 100000, description: `How many rows of each task's result the page holds (default ${READ_PAGE}).` },
  };
  const batchOf = (item, what) => ({ type: 'array', minItems: 1, description: `Several ${what} in one call, run side by side: each item is a single query's own fields — { steps, time_range?, … } — and context_id is written once, at the top beside queries, not in an item: { context_id, queries: [{ steps }, { steps }] }. All are checked first — one mistake refuses the batch. Returns task_ids, in order.`, items: item });

  // A METRIC QUERY IS ITS STEPS: one metrics step (what the semantic layer computes), where steps before
  // it, a read of its result after it — every rule of where a step may stand checked as the query is built
  // (src/engine/semantic-query.js _metricSteps). Its fields are the one list METRIC_QUERY_FIELDS, which
  // also tells an earlier metric query apart (src/earlier-spelling.js).
  const queryFields = pick({
      steps: { type: 'array', minItems: 1, items: { $ref: '#/$defs/stage' }, description: 'The query, in order. A METRIC QUERY has one metrics step — { stage: "metrics", metrics: [...], group_by: [...] }, what the semantic layer computes. Before it, where steps: they filter the rows its metrics fold, over what group_by names, named as it names them — { stage: "where", conditions: [{ fn: "eq", args: [{ source: "users", column: "country" }, { value: "US" }] }] }; a column of the rows, a metric or an aggregate is refused there. After it, steps over its result — where, compute, aggregate, pivot, unpivot, order_by, limit, sample, project — by the names its rows come back with: the metrics and the group_by items\' result columns ("metric_time_day", "users_country"); a where there filters the result (a having on a metric), { stage: "order_by", keys: [{ key: "<metric>", direction: "desc" }] } ranks it, so the rows a task keeps are the top ones. WITHOUT a metrics step the steps read the context\'s built pipeline table — the same read stages over its columns (a where after an aggregate is a having; a second aggregate folds the groups again); omitted, the table as it is. Nothing upstream is recomputed. A join, an unnest, a funnel or a python step makes a new table: build it with build_model from the task (from_task).' },
      time_range: METRIC_TIME_RANGE,
      limit: { type: 'integer', minimum: 1, maximum: 100000, description: `How many rows of the result the task keeps (default ${KEPT_ROWS}): a read ({ task_ids, offset, limit }) pages through them, and a card draws them; a built table itself is in its build's task, paged to its last row. With materialize the table stores every row and a read pages it to the last one; limit is then the rows the task keeps for a plain card (a drill-down reads its own views).` },
      materialize: { type: 'boolean', description: 'A metric query only: store every row of the result as a table. A stored result survives a restart, a read ({ task_ids, offset, limit }) pages it to its last row, it can be drawn as a drill-down, and it can start a pipeline (from_task).' },
      dry_run: { type: 'boolean', description: DRY_RUN('the query\'s SQL — a metric query\'s MetricFlow\'s, with the steps after it; a read\'s written over the stored table as {{ ref("<model>") }} — and the columns it answers with. It is a task as any query is — read it with { task_ids }; it waits for the context\'s build only') },
      include: { type: 'array', uniqueItems: true, items: { enum: ['plan'] }, description: 'What else a metric query\'s dry_run shows: "plan" — MetricFlow\'s dataflow plan (thousands of tokens; the SQL alone is usually what is wanted).' },
  }, METRIC_QUERY_FIELDS);
  const queryContextId = contextId(`The context to query${projectContexts.length ? ': one of the dbt project\'s own semantic models, by its name (the listed values — read at start, nothing to build), or the context_id a build returned' : ': the context_id a build returned'}. The context decides which metrics there are and how a dimension is named in group_by and a where; its built pipeline table is what a query without a metrics step reads.`);
  const query = {
    type: 'object',
    description: 'Start a query against a context — a metric query, or a read of its built table (or several at once with queries) — or, with task_ids, read tasks back.',
    $defs: pdefs,
    anyOf: queryModes({ context_id: queryContextId, fields: queryFields }, batchOf({ type: 'object', additionalProperties: false, properties: queryFields }, 'queries'), readPaging),
  };

  // context reads (list, describe), delete_context removes (the context, its pipeline model, or a
  // semantic model's additions). Strict per-action fields.
  // THE CONTEXTS, READ — list them, or describe one. Nothing here changes anything, so the tool is
  // read-only as a whole; removing what a context holds is delete_context, a tool of its own, because
  // a client asks before a destructive call and should not have to ask before a listing.
  // describe: one context in depth — and, where it holds a semantic layer, that layer as dbt parsed it
  // (one of the project's own semantic models, or a build's): its semantic models, each metric's
  // definition and its group_by, the declaration's own mistakes; validate checks it on the warehouse
  const describeFields = {
    action: { const: 'describe' },
    context_id: contextId(`The context to describe — the context_id a build returned${projectContexts.length ? ', or one of the dbt project\'s own semantic models by its name' : ''}.`),
    // a build's semantic models are named after the catalog's models it loads (and its own table, after the build); the project's are its own
    semantic_model: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$', description: 'Narrow the semantic layer shown to one semantic model of the context and the metrics that read it. With metric too, the metric\'s semantic models are narrowed to this one.' },
    metric: { type: 'string', description: 'Narrow the semantic layer shown to one metric: its definition, the metrics it is made of (each with its own), and its group_by in full — every dimension, entity and the time axis it can be grouped by, each item spelled exactly as the group_by of query_model\'s metrics step takes it.' },
    validate: { type: 'boolean', description: VALIDATE('MetricFlow compiles each metric in view, naming one it cannot build (with a time_range the warehouse also runs each metric and each semantic model\'s dimensions over it)', 'query_model') },
    time_range: timeRange('The metric_time window the metrics and dimensions are run over. Keep it short — the warehouse reads what falls in it.'),
  };
  const describeForms = [
    form({ title: 'describe a context', required: ['action', 'context_id'], properties: pick(describeFields, ['action', 'context_id', 'semantic_model', 'metric', 'validate']) }),
    form({ title: 'validate a context over a window', required: ['action', 'context_id', 'validate', 'time_range'], properties: { ...pick(describeFields, ['action', 'context_id', 'semantic_model', 'metric', 'time_range']), validate: { const: true, description: describeFields.validate.description } } }),
  ];
  const contextTool = {
    type: 'object',
    description: 'Read the isolated execution contexts (the workspaces build_model produces). action: list (a page of contexts, most recently used first) | describe (one context in depth: its steps and tasks, and its semantic layer as dbt parsed it — semantic models, each metric\'s definition and what it can be grouped by; with metric or semantic_model, one of them; validate: true checks it on the warehouse, a task). Removing one, or a model in one, is delete_context.',
    anyOf: [
      form({ title: 'list the contexts', tag: ['action', 'list'], tagDescription: `list: the contexts, most recently used first, ${CONTEXT_PAGE} to a page — the server keeps every conversation's, so page through them (offset) or narrow them (search).`, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: `How many contexts the page holds (default ${CONTEXT_PAGE}).` },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many first — next_offset of the previous page.' },
        search: { type: 'string', minLength: 1, description: 'Keep the contexts whose id, task or metric names, notes or description contain this text (any case).' },
      } }),
      ...describeForms,
    ],
  };
  // WHAT A CONTEXT HOLDS, REMOVED — the whole context, its pipeline model, or one model's task additions.
  const deleteId = { type: 'string', pattern: CTX, description: 'The context a build returned. The dbt project\'s own semantic models are read at start and cannot be removed.' };
  const deleteForms = {
    context: form({ title: 'the whole context', tag: ['what', 'context'], optionalTag: true, tagDescription: 'context (the default): tear the whole context down.', required: ['context_id'], properties: { context_id: deleteId, force: { type: 'boolean', description: 'Tear it down even though another draft reads a table it built (a fork that inherited a materialized prefix); those drafts then recompute that prefix from the source.' } } }),
    pipeline_model: form({ title: 'its pipeline model', tag: ['what', 'pipeline_model'], tagDescription: 'pipeline_model: remove the context\'s pipeline model and keep the context.', required: ['context_id'], properties: { context_id: deleteId } }),
    semantic_model: form({ title: 'one semantic model\'s additions', tag: ['what', 'semantic_model'], tagDescription: 'semantic_model: remove one model\'s task additions.', required: ['context_id', 'semantic_model'], properties: { context_id: deleteId, semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s task additions to remove.' }, cascade: { type: 'boolean', description: 'Also remove the metrics that depend on the removed measures.' } } }),
  };
  // …and a kind of build a feature's context holds, in the form the feature writes for it (src/features.js)
  for (const d of deletes) if (deleteForms[d.what]) throw new Error(`delete_context: a feature's form '${d.what}' collides with the core's`);
  const deleteContext = {
    type: 'object',
    description: 'Remove a context, or part of what it holds. It cannot be undone.',
    anyOf: [...Object.values(deleteForms), ...deletes.map((d) => d.form)],
  };

  const tools = {
    build_model: withStageDefs(buildModel, catalog, project, TOOL_PLACES.build_model),
    context: contextTool,
    delete_context: deleteContext,
    query_model: query,
    display_model_result: {
      type: 'object', additionalProperties: false, required: ['task_id'],
      description: 'Draw a finished result as a card for the person — once.',
      properties: {
        task_id: { type: 'string', pattern: TASK_ID, description: 'The task whose result to draw: a query, or a build of a pipeline (an experiment has no task: it draws its own card with card: true).' },
        display,
      },
    },
    drill_result: {
      type: 'object', additionalProperties: false, required: ['task_id'],
      description: 'One view of a drawn drill-down card — the card calls this, the model does not: the path taken so far and the level to open, read from the task\'s stored table as the card was drawn.',
      properties: {
        task_id: { type: 'string', pattern: TASK_ID },
        path: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['column', 'value'], properties: { column: { type: 'string' }, value: SCALAR } } },
        level: { type: 'string' },
        mode: { enum: ['trend', 'breakdown'] },
        limit: { type: 'integer', minimum: 1, maximum: DRILL_ROWS },
      },
    },
    semantic_index: semanticIndexSchema(catalog, { project, places: TOOL_PLACES.semantic_index.ref }),
    time: {
      type: 'object', additionalProperties: false, required: ['seconds'],
      description: `Wait for \`seconds\` (at most ${MAX_WAIT_SECONDS}), then return. Purely a timer; it touches no data and follows no task — waiting for a task is its side\'s query tool with { task_ids }.`,
      properties: {
        seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `Seconds to wait, at most ${MAX_WAIT_SECONDS}: the wait happens inside the call, which a client's own timeout bounds.` },
        reason: { type: 'string', description: 'Optional note on what you are waiting for (echoed back; metadata only).' },
      },
    },
    explore_errors: (() => {
      const errorFields = {
        id: { type: 'integer', minimum: 1, description: 'One error in full, with what reproduces it: the call\'s arguments, the state of the context it worked on, the code of each generated model the error names, and the runtime.' },
        time_range: timeRange('Only the errors kept within this window, by the moment each was kept.'),
        source: { enum: ERROR_SOURCES, description: 'Where it happened: tool — a call refused or failed; task — warehouse work that ended in an error; startup — what a start could not serve.' },
        severity: { enum: ['error', 'warning'], description: 'error — something failed; warning — something was left out and served without it (a join the project declares that no reference can name, a feature that cannot run here).' },
        tool: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'Only the errors of this tool (for a task: the tool that started it).' },
        stage: { type: 'string', pattern: '^[a-z_]+$', description: 'Only this stage (validate, query, build, task, …).' },
        // any id an error was kept under: a refused call is kept with the id it sent, whatever it was, and a
        // project semantic model renamed since keeps its errors under its old name
        context_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Only the errors kept under this context id — as the call sent it (a context a build returned, a dbt project semantic model by its name, or an id that was refused).' },
        task_id: { type: 'string', pattern: TASK_ID, description: 'Only this task\'s errors.' },
        search: { type: 'string', minLength: 1, description: 'Only errors whose message or detail contains this text (any case).' },
        include: { type: 'array', uniqueItems: true, items: { enum: ['details'] }, description: '"details" — each error of the page in full (its arguments and detail); by default each by its message.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many to return (default 20).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many of the newest first (next_offset of the previous page).' },
      };
      return {
        type: 'object',
        description: 'Read the failures the server kept. { id } → one in full; otherwise a page of them, newest first, narrowed by the fields given.',
        anyOf: [
          form({ title: 'one error in full', required: ['id'], properties: pick(errorFields, ['id']) }),
          form({ title: 'a page of errors', properties: pick(errorFields, ['time_range', 'source', 'severity', 'tool', 'stage', 'context_id', 'task_id', 'search', 'include', 'limit', 'offset']) }),
        ],
      };
    })(),
    experiment: experimentSchema(),
    memory: memorySchema(catalog, { project, places: TOOL_PLACES.memory.ref }),
  };
  // the input contracts of the engine methods the tools hand to (METHOD_CONTRACTS): validated, never offered
  const contracts = {
    // Stage schemas may reference root-level definitions (the recursive python body): hoist them.
    'build_model.pipeline': withStageDefs(registerModel, catalog, project, TOOL_PLACES.build_model),
    // what the tool's form takes, its tag left out — the method is handed the form's fields, so a field
    // added to the form reaches the method's contract with it
    'delete_context.context': untagged(deleteForms.context, 'what', 'Tear down an entire isolated context (delete its files + artifacts).'),
    'delete_context.pipeline_model': untagged(deleteForms.pipeline_model, 'what', 'Delete the pipeline model of a context (remove its view + semantic model) and re-parse.'),
    'delete_context.semantic_model': untagged(deleteForms.semantic_model, 'what', 'Remove a semantic model\'s task additions from a context.'),
    'context.describe': { type: 'object', anyOf: describeForms.map((f) => ({ title: f.title, ...untagged(f, 'action', f.title) })) },
    'experiment.analyze': analyzeContract(),
    'experiment.check_split': checkSplitContract(),
    'experiment.plan': planContract(),
  };
  // Every tool schema is written with its vocabulary SPELLED OUT where it is accepted — that is
  // what makes a refusal able to say which mode the caller was closest to. Repeating a 5 KB list
  // of payload properties three times in one tool is the transport paying for that authoring
  // choice, so the repetition is folded out HERE, after the schemas are written and before they
  // leave: identical subtrees become one `$defs` entry the sites point at. Authoring is unchanged,
  // validation is unchanged (ajv resolves the ref), and the client is handed each list once.
  return Object.fromEntries(Object.entries({ ...tools, ...contracts }).map(([name, schema]) => [name, transportSchema(schema)]));
}

/** A form of a tool without its tag — the contract of the method that form hands its fields to. */
function untagged(f, key, description) {
  const { [key]: _tag, ...properties } = f.properties;
  const required = (f.required || []).filter((k) => k !== key);
  return { type: 'object', additionalProperties: false, description, ...(required.length ? { required } : {}), properties };
}

/** Attach the stages' `$defs` at a tool schema's root (where `#/$defs/…` references resolve): the one
 *  expression and the one stage definition, built for the tool's `places` (TOOL_PLACES), the expression's
 *  refs naming `project`'s layer too. */
function withStageDefs(toolSchema, catalog, project, places) {
  // the closed kinds of the expression the tool's places take beside the row expression its stages
  // build (a build's semantic_model step: a measure — ONE aggregate, its args the row expression — and a
  // derived metric's value)
  const kinds = Object.fromEntries(Object.entries(places).filter(([k]) => k === 'aggregate' || k === 'metric_expr'));
  return { ...toolSchema, $defs: { ...(toolSchema.$defs || {}), ...stageDefs(catalog, { project, places: places.stage, exprPlaces: places.expr }), ...exprDefs(catalog, { project, kinds }) } };
}
