// Build JSON Schemas for the tools, with enums projected from the catalog.
// Everything that names a column/property/event/attribute is an enum -> an AI
// literally cannot submit an unknown name (validated by ajv at the boundary).
//
// Every property carries a `description` so the meaning/purpose of each
// parameter is self-explanatory to the MCP client (the AI) without external docs.
//
// This file puts the tools together; their pieces live in src/schema/: fields.js (what every tool
// shares — patterns, descriptions, the declaration and query items, the limits), display.js (the
// card), projection.js (a read over a stored table), semantic-index.js, memory.js, experiment.js
// (each tool's own input), transport.js (how a schema is folded before it is sent).

import { ERROR_SOURCES } from './error-log.js';
import { stageDefs } from './pipeline.js';
import { DRILL_ROWS } from './apps/result-view-model.js'; // the most rows one view of a drill-down card reads
import { TASK, CTX, TASK_ID, D, genericMeasureItem, genericDimensionItem, semanticModelBranch, metricSchema, projectRef, projectEntityRef, METRIC_TIME_RANGE, predicateDefs, MAX_WAIT_SECONDS, MAX_BATCH, terse } from './schema/fields.js';
import { display } from './schema/display.js';
import { projection } from './schema/projection.js';
import { transportSchema } from './schema/transport.js';
import { form, pick } from './schema-kit.js';
import { semanticIndexSchema } from './schema/semantic-index.js';
import { memorySchema } from './schema/memory.js';
import { analyzeContract, checkSplitContract, planContract, experimentSchema } from './schema/experiment.js';
export { MAX_WAIT_SECONDS, MAX_BATCH, transportSchema };

/**
 * THE INPUT CONTRACTS OF THE ENGINE'S OWN METHODS — not tools. A tool hands its input to one of these
 * methods, and the method holds it to the exact contract named `<tool>.<mode>` below — experiment's
 * analyze / check_split / plan, delete_context's three targets, context's describe, a pipeline built
 * in one call. They are validated, never listed or called by a client: every tool is listed and called
 * by its one name.
 */
export const METHOD_CONTRACTS = new Set(['build_pipeline_model.pipeline', 'delete_context.context', 'delete_context.pipeline_model', 'delete_context.semantic_model', 'context.describe', 'experiment.analyze', 'experiment.check_split', 'experiment.plan']);

export function buildSchemas(catalog, { project = null, projectContexts = [] } = {}) {
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
  const createFields = {
    context_id: { type: 'string', pattern: CTX, description: D.context_id },
    name: { type: 'string', pattern: TASK, description: 'Task name (lowercase snake_case). Namespaces all measures/metrics so multiple tasks coexist in one context.' },
    description: { type: 'string', description: 'What this task computes, in your words. Kept with the context and returned by context({ request: { action: "describe" | "list" } }), so a later call — or another session — can tell what this context is for without re-reading its YAML.' },
    use_base_models: { type: 'array', items: { type: 'string', enum: catalog.modelKeys() }, description: 'Additional source models to load so their attributes become groupable/filterable as { model, attribute } (e.g. "users" to slice by { model: "users", attribute: "country" }). Every source named in semantic_models[].from is loaded already — list here only a model you join TO but define no measures on. Measures from SEVERAL sources may live in one task (one semantic model each): each reaches the joined model by its own declared key. If that model is slowly-changing, the join is point-in-time automatically — MetricFlow applies its validity window, so nothing is stated here.' },
    semantic_models: { type: 'array', items: { anyOf: modelKeys.map((k) => semanticModelBranch(catalog, k)) }, description: 'Semantic model definitions (one per source model) carrying the measures/dimensions for this task.' },
    metrics: { type: 'array', minItems: 1, items: metricSchema(), description: 'The metrics to expose for querying (each references measures defined above).' },
    dry_run: { type: 'boolean', description: 'If true, validate and return the definition WITHOUT writing files or building anything.' },
    include_yaml: { type: 'boolean', description: 'Return the full rendered context YAML in the response (default false). The YAML is always written to the context files regardless; omit it to keep responses small.' },
  };
  // action: 'update' — the incremental path. Same vocabulary as a declaration (that is why the two are
  // one tool: two schemas meant two copies of every enum in every listing).
  const updateFields = {
    context_id: { type: 'string', pattern: CTX, description: 'The context whose task to change.' },
    semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s semantic model to change.' },
    add_dimensions: { type: 'array', items: genericDimensionItem(catalog), description: 'Dimensions to add.' },
    remove_dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimensions to remove, by the ATTRIBUTE they declare (the name `groupable` shows).' },
    add_measures: { type: 'array', items: genericMeasureItem(catalog), description: 'Measures to add.' },
    remove_measures: { type: 'array', items: { type: 'string' }, description: 'Measures to remove; refused while a metric depends on one, unless cascade.' },
    add_metrics: { type: 'array', items: metricSchema(), description: 'Metrics to add.' },
    remove_metrics: { type: 'array', items: { type: 'string' }, description: 'Metrics to remove.' },
    task: { type: 'string', description: 'The task the additions belong to (defaults to the context\'s first task).' },
    cascade: { type: 'boolean', description: 'Also remove the metrics that depend on a removed measure.' },
    dry_run: createFields.dry_run,
    include_yaml: createFields.include_yaml,
  };
  const create = {
    type: 'object',
    description: 'Declaratively create/extend the semantic models + metrics for an analytics task inside an isolated context — the governed path. Produces named metrics you query many ways with query_semantic_model (group_by / time / filters), reusably. Use this for measurable, re-sliceable metrics (DAU, revenue, conversion, retention). Two modes: the default declares a task (name + semantic_models + metrics); action:"update" edits the task already in a context — add_measures / add_dimensions / add_metrics and the matching remove_* on one `semantic_model`, without restating the rest. For a one-off derived table (funnel/sessionization/window/pivot — things the governed metrics cannot express), use build_pipeline_model instead. It returns a task_id: query_semantic_model({ request: { task_id } }) returns the parsed model (metrics, what it can be grouped by) — a query on this context waits for it by itself.',
    anyOf: [
      form({ title: 'declare a task', tag: ['action', 'create'], optionalTag: true, tagDescription: 'create (the default): declare a task — name + semantic_models + metrics.', required: ['name', 'metrics'], properties: createFields }),
      form({ title: 'update the task in a context', tag: ['action', 'update'], tagDescription: 'update: change the task already in this context — the add_*/remove_* fields, on one `semantic_model`.', required: ['context_id', 'semantic_model'], properties: updateFields }),
    ],
  };

  // a pipeline built in one call (build_pipeline_model.pipeline): a derived dbt model from a declarative PIPELINE
  // (a pipe-syntax transformation, optionally ending in a match_recognize funnel)
  // and materialize it. The pipeline's rows ARE the result.
  const registerModel = {
    type: 'object', additionalProperties: false, required: ['name', 'pipeline'],
    description: 'Build a derived model from a PIPELINE: a `source` + ordered `stages` (where/derive/compute/unnest/join/aggregate/pivot/unpivot/sample/window/order_by/limit/project, and the match_recognize funnel stage). Its ROWS are the result — the call returns a task_id and query_pipeline_model({ request: { task_id } }) returns them; a pipeline started from that task (from_task) re-slices them without recomputing. Funnels are pipelines too: add a match_recognize stage, then slice it with a downstream join/aggregate (e.g. conversion by country).',
    properties: {
      context_id: { type: 'string', pattern: CTX, description: D.context_id },
      name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
      description: { type: 'string', description: 'What this model computes, in your words. Kept with the context (returned by context({ request: { action: "describe" | "list" } })) and written into the generated model\'s config banner, so the table can be traced back to the question it answers.' },
      materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored: table (precomputed snapshot, default) or view (always fresh).' },
      dry_run: { type: 'boolean', description: 'If true, return the generated model definition for preview WITHOUT building anything.' },
      pipeline: {
        type: 'object', additionalProperties: false, required: ['source', 'stages'],
        description: 'The transformation pipeline: a `source` table + ordered `stages` applied left-to-right.',
        properties: {
          source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Always named: each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
          time_range: { type: 'object', additionalProperties: false, description: 'Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied BEFORE the stages — avoids hand-written device_time literals and keeps whole-session windows intact.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone (e.g. "Europe/Berlin"): start/end are read as wall-clock in this zone and converted to the UTC instants the warehouse stores. Omit for warehouse-native (UTC) bounds.' } } },
          stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/pipeline_stage' }, description: 'Ordered pipe stages; each transforms the previous output.' },
        },
      },
    },
  };

  // build_pipeline_model: compose a pipeline INCREMENTALLY, one stage at a time. A
  // single stateful tool with an `action`; each add_step validates the stage and
  // returns the columns now available for the NEXT stage (schema only — nothing is
  // materialized until materialize).
  const trProp = { type: 'object', additionalProperties: false, description: 'Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied BEFORE the stages.', properties: { start: { type: 'string', description: 'Inclusive start (ISO date/datetime).' }, end: { type: 'string', description: 'Inclusive end (ISO date/datetime; a date-only end means the WHOLE day).' }, timezone: { type: 'string', description: 'Optional IANA timezone: start/end are wall-clock in this zone, converted to UTC instants.' } } };
  const pipelineFields = {
    draft_id: { type: 'string', pattern: CTX, description: 'Draft handle returned by start (it is a context_id). For fork it may also be a context whose pipeline was already materialized.' },
    name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
    description: { type: 'string', description: 'What this pipeline computes, in your words. Kept with the draft and carried to the model it materializes: returned by context({ request: { action: "describe" | "list" } }) and written into the generated model\'s config banner. A draft is cheap to make and easy to lose track of — this is what tells two of them apart later.' },
    materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored when materialized (chosen at start): table (default) or view.' },
    from_task: { type: 'string', pattern: TASK_ID, description: 'Begin FROM the stored table of a finished task — a query run with materialize:true, or a pipeline build — instead of a catalog source. The steps re-slice that result (filter, regroup, join, window…) WITHOUT recomputing it.' },
    source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
    time_range: trProp,
    stage: { $ref: '#/$defs/pipeline_stage', description: 'ONE pipe stage — appended (add_step), or placed at `index` (edit_step/insert_step), validated against the columns available at that point.' },
    stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/pipeline_stage' }, description: 'Several pipe stages to append IN ORDER (add_steps). Applied sequentially; the response reports each stage\'s effect on the data. Keep this to a small LOGICAL chunk — do NOT dump the whole pipeline at once.' },
    index: { type: 'integer', minimum: 1, description: 'Target step (1-based, per steps[].index). insert_step places the stage BEFORE this position (count+1 appends).' },
    after: { type: 'integer', minimum: 0, description: 'Keep steps 1..after — truncate drops the rest; fork copies that prefix into the new draft (omit on fork to copy all steps). 0 = none.' },
    include_columns: { type: 'boolean', description: 'Also return the FULL available_columns list. Off by default — the per-step response returns only the diff (columns_added + columns_removed_count, with the removed names only when short) to avoid re-dumping the whole schema each step; use preview for the full list too.' },
    include_steps: { type: 'boolean', description: 'Also return the FULL steps array. Off by default — add_step is append-only, so it echoes just the applied `step` + `steps_count` (you already have the earlier steps); pass true, or use preview, when you need the whole pipeline back.' },
  };
  const echo = ['include_columns', 'include_steps'];
  // One form per action, each with exactly the fields that action takes: a stray field is refused
  // rather than silently ignored, and nothing is said about it beside the form — it is not in it.
  const step = (action, title, tagDescription, required, optional = []) => form({ title, tag: ['action', action], tagDescription, required: ['draft_id', ...required], properties: pick(pipelineFields, ['draft_id', ...required, ...optional, ...echo]) });
  const startOptional = ['draft_id', 'description', 'materialized', 'time_range', ...echo];
  const buildModel = {
    type: 'object',
    description: 'Compose a pipeline model incrementally, one stage at a time — a single tool driven by `action`. Each add_step validates the stage and returns the exact columns now available for the next stage (pure schema; nothing is materialized until materialize), so you build with full visibility instead of guessing a whole pipeline up front. Lifecycle: start → add_step* → (optional preview) → materialize (builds + runs the model) → add_step* → materialize again. Materialize is not the end: the draft stays open and the table it built stands for the steps so far, so the steps you add next read that table instead of recomputing an expensive prefix (an aggregate, a python model). Editing a step at or before a materialized prefix retires it (the next materialize rebuilds from the source); editing a step after it keeps it. Each response says what it started from (from_checkpoint / steps_recomputed) and what it retired (checkpoints_dropped). When to use: a one-off derived table whose rows are the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the governed metrics cannot express; materialize returns a task_id — read the rows with query_pipeline_model({ request: { task_id } }), filter or regroup them with query_pipeline_model({ request: { context_id, transform } }). For reusable named metrics you query many ways (group_by / time / filters), use build_semantic_model instead (the governed path). Every edit revalidates the whole pipeline end-to-end and reports the failing step if an edit breaks a later one. Prefer add_step or small add_steps chunks over one giant add_steps, so you see how each chunk changes the data.',
    anyOf: [
      form({ title: 'start from a source', tag: ['action', 'start'], tagDescription: 'start a new draft over a catalog source (returns a draft_id + the source columns); draft_id reuses a context.', required: ['name', 'source'], properties: pick(pipelineFields, ['name', 'source', ...startOptional]) }),
      form({ title: 'start from a task', tag: ['action', 'start'], tagDescription: 'start a new draft over the stored table of a finished task (from_task); `source` names the source the steps resolve payload properties and relationships against (taken from the task when it read one source).', required: ['name', 'from_task'], properties: pick(pipelineFields, ['name', 'from_task', 'source', ...startOptional]) }),
      step('add_step', 'add a step', 'add_step: append one stage; returns the columns available after it.', ['stage']),
      step('add_steps', 'add several steps', 'add_steps: append several stages at once (applied in order), atomic (all-or-nothing); returns a per-step breakdown of how each changed the data.', ['stages']),
      step(['edit_step', 'insert_step'], 'edit or insert a step', 'edit_step replaces step `index`; insert_step inserts a stage before `index`.', ['index', 'stage']),
      step('delete_step', 'delete a step', 'delete_step: remove step `index`.', ['index']),
      step('truncate', 'truncate the draft', 'truncate: keep only steps 1..`after` (cheap "go back to step N").', ['after']),
      step('fork', 'fork the draft', 'fork: branch a new draft from steps 1..`after` of this draft (or an already-materialized pipeline) without touching the original — iterate variants without re-typing the shared prefix; name defaults to the source draft\'s, description overrides the parent\'s.', [], ['name', 'description', 'after']),
      step(['preview', 'materialize', 'discard'], 'preview, materialize or discard', 'preview shows the steps + the SQL that would actually run (from a materialized prefix when there is one); materialize builds the model and keeps the draft, recording the built table as the prefix the next steps read; discard drops the draft.', []),
    ],
  };

  const pdefs = predicateDefs(catalog, project);
  const pipelineQueryFields = {
    transform: projection,
    limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Rows to return (default 1000); with task_id, pages a stored result.' },
    offset: { type: 'integer', minimum: 0, description: 'Rows to skip (paging); with task_id, pages a stored result.' },
  };
  // The read half of a query tool: { task_id } waits for a task of its side and returns it.
  const taskRead = {
    task_id: { type: 'string', pattern: TASK_ID, description: 'READ a task of this side back (instead of starting a query): wait for it and return its result.' },
    wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `With task_id: how long to wait for the task at most (default and cap ${MAX_WAIT_SECONDS}); it returns the moment the task is done. 0 = just look.` },
  };
  taskRead.cancel = { type: 'boolean', const: true, description: 'With task_id / task_ids: CANCEL those tasks instead of reading them — a running task ends at once as cancelled (its warehouse process is stopped; one still queued never starts); a finished one is left as it is.' };
  taskRead.task_ids = { type: 'array', minItems: 1, maxItems: MAX_BATCH, uniqueItems: true, items: { type: 'string', pattern: TASK_ID }, description: `READ up to ${MAX_BATCH} tasks of this side at once (the task_ids a batch returned): waits until all are done and returns each one's result, in this order.` };
  // THE MODES OF A QUERY TOOL, one form each: start one query (context_id + its fields), start a
  // batch (context_id + queries), read one task (task_id), read several (task_ids), cancel either.
  // Told apart by the fields each requires; each takes only its own.
  const queryModes = (startFields, batch) => [
    form({ title: 'start a query', required: ['context_id'], properties: { context_id: startFields.context_id, ...startFields.fields } }),
    form({ title: 'start a batch', required: ['context_id', 'queries'], properties: { context_id: startFields.context_id, queries: batch } }),
    form({ title: 'read a task', required: ['task_id'], properties: pick(taskRead, ['task_id', 'wait_seconds']) }),
    form({ title: 'read several tasks', required: ['task_ids'], properties: pick(taskRead, ['task_ids', 'wait_seconds']) }),
    form({ title: 'cancel a task', required: ['task_id', 'cancel'], properties: pick(taskRead, ['task_id', 'cancel']) }),
    form({ title: 'cancel several tasks', required: ['task_ids', 'cancel'], properties: pick(taskRead, ['task_ids', 'cancel']) }),
  ];
  // a read of one task may page what it returns
  const paged = (modes, paging) => modes.map((m) => (m.title === 'read a task' ? { ...m, properties: { ...m.properties, ...paging } } : m));
  const batchOf = (item, what) => ({ type: 'array', minItems: 1, maxItems: MAX_BATCH, description: `START up to ${MAX_BATCH} ${what} on this context in one call, run side by side: each item takes the fields of a single query (described above; context_id stays at the top). All are checked first — one mistake refuses the whole batch. Returns task_ids, in this order: read them together with { task_ids }.`, items: item });

  const semanticQueryFields = {
      task: { type: 'string', description: 'Optional task name hint (disambiguates when a context holds several tasks).' },
      metrics: { type: 'array', minItems: 1, items: { type: 'string' }, description: `The metrics to compute, by the names the context offers: in a task's context, <task>_<metric> as build_semantic_model returned them${project ? '; in a context of one of the dbt project\'s own semantic models, the project\'s own names — every metric that reads that model (preview_semantic_model({ request: { context_id } }) lists them)' : ''}.` },
      group_by: {
        type: 'array',
        description: `How to break the metrics down: one item per column of the result, in the order given. { time: "metric_time", grain } works in every context — the metrics' time axis at a grain, result column metric_time_<grain>. In a task's context an attribute is { model, attribute }, addressed by where it lives: the join path comes from the schema (add via: "<relationship>" when several lead to that model), and its model must be in use_base_models; result column <model>_<attribute>.${project ? ' In a context of one of the dbt project\'s own semantic models (context_id: its name) the project\'s own names are used instead: { semantic_model: [...], dimension, grain? } for a dimension, semantic_model being the chain of models it is reached through (the context\'s own model alone for its own dimensions), MetricFlow making the joins — and { entity } for a key the project declares as an entity; preview_semantic_model({ request: { context_id, metric } }) lists, under the metric\'s group_by, exactly the items MetricFlow accepts, each spelled as here.' : ''} No path strings.`,
        items: {
          anyOf: [
            { type: 'object', additionalProperties: false, required: ['time'], description: 'Group by the metric time axis at a grain.', properties: { time: { enum: ['metric_time'], description: 'The metric time dimension.' }, grain: { enum: catalog.timeGranularities(), description: 'Time bucket size.' } } },
            { type: 'object', additionalProperties: false, required: ['model', 'attribute'], description: 'An attribute addressed by where it lives: { model: "users", attribute: "country" }. semantic_index({ request: {} }) lists every one under groupable_attributes; build_semantic_model returns the context\'s under groupable. The response echoes the resolved column under group_by_resolved.', properties: { model: { enum: catalog.modelKeys(), description: 'The model that carries the attribute.' }, attribute: { type: 'string', description: 'The attribute (column or task dimension) on that model, as semantic_index({ request: { model } }) lists it.' }, via: { type: 'string', description: 'Optional: the relationship to reach the model through, when there are several (key variants).' } } },
            ...(project ? [projectRef(project, catalog), ...projectEntityRef(project)] : []),
          ],
        },
      },
      where: { $ref: '#/$defs/predicateGroup', description: 'Row filter applied before aggregation (boolean tree of conditions on dimensions / metric_time).' },
      order_by: { type: 'array', description: 'Sort order. Each key is a requested metric name, a RESULT COLUMN of this query ("metric_time_day", "users_country" — the names the rows come back with; "metric_time" is an alias of the time column), or a group_by attribute as { model, attribute }.', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { anyOf: [{ type: 'string', description: 'A requested metric name, a result column name (e.g. "users_country", "metric_time_day"), or "metric_time".' }, { type: 'object', additionalProperties: false, required: ['model', 'attribute'], properties: { model: { enum: catalog.modelKeys() }, attribute: { type: 'string' }, via: { type: 'string' } }, description: 'A group_by attribute, addressed as in group_by.' }, ...(project ? [projectRef(project, catalog), ...projectEntityRef(project)] : [])] }, direction: { enum: ['asc', 'desc'], description: 'Sort direction (default asc).' } } } },
      time_range: METRIC_TIME_RANGE,
      limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Max rows to return (default 1000); with task_id, pages a stored result.' },
      offset: { type: 'integer', minimum: 0, description: 'Rows to skip from the start (paging); with task_id, pages a stored result.' },
      materialize: { type: 'boolean', description: 'Store the WHOLE result as a table (the rows you get back are one page of it: `limit`/`offset`). A stored result survives a restart, is paged with query_semantic_model({ request: { task_id, offset, limit } }), can be drawn as a drill-down (a pivot, a chart with drill), and can be re-sliced by a pipeline started from it (build_pipeline_model({ request: { action: "start", from_task } })).' },
      dry_run: { type: 'boolean', description: 'If true, validate and return the compiled query WITHOUT executing it.' },
      explain: { type: 'boolean', description: 'If true, return the query plan (how the metrics compile) and the compiled query WITHOUT executing. A superset of dry_run; useful for inspecting/optimizing.' },
  };
  const semanticContextId = contextId(`The context to query${projectContexts.length ? ': one of the dbt project\'s own semantic models, by its name (the listed values — read at start, nothing to build), or the context_id build_semantic_model returned' : ': the context_id build_semantic_model returned'}. The context decides which metrics there are and how a dimension is named in group_by and where.`);
  const query = {
    type: 'object',
    description: `Start a metric query against a context (or up to ${MAX_BATCH} at once with queries) — or, with task_id / task_ids, read semantic tasks back.`,
    $defs: pdefs,
    anyOf: paged(
      queryModes({ context_id: semanticContextId, fields: semanticQueryFields }, batchOf({ type: 'object', additionalProperties: false, required: ['metrics'], properties: terse(semanticQueryFields) }, 'metric queries')),
      pick(semanticQueryFields, ['offset', 'limit']),
    ),
  };

  const ctxRef = { type: 'object', additionalProperties: false, required: ['context_id'], description: 'Reference an existing context by id.', properties: { context_id: { type: 'string', pattern: CTX, description: D.context_id } } };
  const del = { type: 'object', additionalProperties: false, required: ['context_id', 'semantic_model'], description: 'Remove a semantic model\'s task additions from a context.', properties: { context_id: { type: 'string', pattern: CTX, description: D.context_id }, semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s additions to remove.' }, cascade: { type: 'boolean', description: 'If true, also remove metrics that depend on the removed measures.' } } };

  // context reads (list, describe), delete_context removes (the context, its pipeline model, or a
  // semantic model's additions). Strict per-action fields.
  // THE CONTEXTS, READ — list them, or describe one. Nothing here changes anything, so the tool is
  // read-only as a whole; removing what a context holds is delete_context, a tool of its own, because
  // a client asks before a destructive call and should not have to ask before a listing.
  const contextTool = {
    type: 'object',
    description: 'Read the isolated execution contexts (the workspaces build_semantic_model / build_pipeline_model produce). action: list (all contexts) | describe (one context\'s tasks/models/metrics/group-by paths). Removing one, or a model in one, is delete_context.',
    anyOf: [
      form({ title: 'list the contexts', tag: ['action', 'list'], tagDescription: 'list: all active contexts.' }),
      form({ title: 'describe a context', tag: ['action', 'describe'], tagDescription: 'describe: one context in depth.', required: ['context_id'], properties: { context_id: contextId(`The context to describe — the context_id a build returned${projectContexts.length ? ', or one of the dbt project\'s own semantic models by its name' : ''}.`) } }),
    ],
  };
  // WHAT A CONTEXT HOLDS, REMOVED — the whole context, its pipeline model, or one model's task additions.
  const deleteId = { type: 'string', pattern: CTX, description: 'The context a build returned. The dbt project\'s own semantic models are read at start and cannot be removed.' };
  const deleteContext = {
    type: 'object',
    description: 'Remove a context, or part of what it holds. It cannot be undone.',
    anyOf: [
      form({ title: 'the whole context', tag: ['what', 'context'], optionalTag: true, tagDescription: 'context (the default): tear the whole context down.', required: ['context_id'], properties: { context_id: deleteId, force: { type: 'boolean', description: 'Tear it down even though another draft READS a table it built (a fork that inherited a materialized prefix); those drafts then recompute that prefix from the source.' } } }),
      form({ title: 'its pipeline model', tag: ['what', 'pipeline_model'], tagDescription: 'pipeline_model: remove the context\'s pipeline model and keep the context.', required: ['context_id'], properties: { context_id: deleteId } }),
      form({ title: 'one semantic model\'s additions', tag: ['what', 'semantic_model'], tagDescription: 'semantic_model: remove one model\'s task additions.', required: ['context_id', 'semantic_model'], properties: { context_id: deleteId, semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s task additions to remove.' }, cascade: { type: 'boolean', description: 'Also remove the metrics that depend on the removed measures.' } } }),
    ],
  };

  const tools = {
    build_semantic_model: create,
    build_pipeline_model: withStageDefs(buildModel, catalog),
    context: contextTool,
    delete_context: deleteContext,
    query_semantic_model: query,
    query_pipeline_model: {
      type: 'object',
      description: `Query a built pipeline model (or up to ${MAX_BATCH} queries at once with queries) — or, with task_id / task_ids, read pipeline tasks back.`,
      anyOf: paged(
        queryModes(
          { context_id: { type: 'string', pattern: CTX, description: 'The context whose BUILT pipeline model to query (the draft_id build_pipeline_model returned, after materialize).' }, fields: pipelineQueryFields },
          batchOf({ type: 'object', additionalProperties: false, properties: terse(pipelineQueryFields) }, 'queries over the built model'),
        ),
        pick(pipelineQueryFields, ['offset', 'limit']),
      ),
    },
    display_model_result: {
      type: 'object', additionalProperties: false, required: ['task_id'],
      description: 'Draw a finished result as a card for the person — once.',
      properties: {
        task_id: { type: 'string', pattern: TASK_ID, description: 'The task whose result to draw: a query, a pipeline build, or an experiment.' },
        display,
      },
    },
    drill_result: {
      type: 'object', additionalProperties: false, required: ['task_id', 'transform'],
      description: 'One view of a drawn drill-down card, read from its task\'s stored table (the card calls this; the model does not).',
      properties: {
        task_id: { type: 'string', pattern: TASK_ID, description: 'The task the card was drawn from.' },
        limit: { type: 'integer', minimum: 1, maximum: DRILL_ROWS, description: 'Rows of the view.' },
        transform: projection,
      },
    },
    // a context's semantic layer as dbt parsed it — one of the project's own semantic models, or a task's
    preview_semantic_model: {
      type: 'object', additionalProperties: false, required: ['context_id'],
      description: 'Three ways to call it: context_id alone shows the context\'s whole semantic layer; with metric, one metric in full (its inputs and everything its group_by takes); with semantic_model, one semantic model and the metrics that read it. Add validate: true (and time_range to read the warehouse) to check it by running it instead — that starts a task.',
      properties: {
        context_id: contextId(`The context to show: ${projectContexts.length ? 'one of the dbt project\'s own semantic models, by its name (the listed values), or ' : ''}the context_id build_semantic_model returned.`),
        semantic_model: { type: 'string', description: 'Narrow the answer to one semantic model of the context (as its semantic_models name them) and the metrics that read it — mostly for a task\'s context, which can hold several.' },
        metric: { type: 'string', description: 'Narrow the answer to one metric: its definition, the metrics it is made of (each with its own), and its group_by in full — every dimension, entity and the time axis it can be grouped by, each item spelled exactly as query_semantic_model\'s group_by takes it.' },
        validate: { type: 'boolean', description: 'Check the layer by running it rather than only reading it. MetricFlow compiles each metric in view, naming one whose SQL it cannot build; with time_range the warehouse also runs each metric over that window (its value comes back) and groups each semantic model\'s rows by all its dimensions and entities, naming a column it cannot read — the checks a dbt v2 parse skips. It is a task: the call returns { task_id }, and query_semantic_model({ request: { task_id } }) returns valid, compiled[], ran.metrics[], ran.semantic_models[] and a summary.' },
        time_range: { ...METRIC_TIME_RANGE, description: 'Only with validate: the metric_time window the metrics and dimensions are run over. Keep it short — the warehouse reads what falls in it. Without it, validate compiles only and reads nothing.' },
      },
    },
    semantic_index: semanticIndexSchema(catalog),
    time: {
      type: 'object', additionalProperties: false, required: ['seconds'],
      description: `Wait for \`seconds\` (capped at ${MAX_WAIT_SECONDS}), then return. Purely a timer; it touches no data and follows no task — waiting for a task is its side\'s query tool with { task_id }.`,
      properties: {
        seconds: { type: 'number', minimum: 0, maximum: 86400, description: `Seconds to wait; the actual wait is capped at ${MAX_WAIT_SECONDS} (larger values are clamped, with clamped:true and cap_seconds in the result).` },
        reason: { type: 'string', description: 'Optional note on what you are waiting for (echoed back; metadata only).' },
      },
    },
    explore_errors: {
      type: 'object', additionalProperties: false,
      description: 'Read the failures the server kept. { id } → one in full; otherwise a page of them, newest first, narrowed by the fields given.',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'One error in full — what reproduces it: the call\'s arguments (a task\'s input), the state of the context it worked on (a semantic declaration, a pipeline draft with its steps, an eventstream with its steps), the code of each generated model the error names (as written and as dbt compiled it), the runtime (server version, dbt, dialect), and everything that was said about it.' },
        since: { type: 'string', description: 'Only errors at or after this moment (ISO 8601 date or date-time, e.g. "2026-09-29" or "2026-09-29T10:00:00Z").' },
        until: { type: 'string', description: 'Only errors at or before this moment (ISO 8601; a date alone means the whole of that day).' },
        source: { enum: ERROR_SOURCES, description: 'Where it happened: tool — a call refused or failed; task — warehouse work that ended in an error; startup — what a start could not serve.' },
        severity: { enum: ['error', 'warning'], description: 'error — something failed; warning — something was left out and served without it (a join the project declares that no reference can name, a feature that cannot run here).' },
        tool: { type: 'string', description: 'Only the errors of this tool (for a task: the tool that started it).' },
        stage: { type: 'string', description: 'Only this stage (validate, query, build, task, …).' },
        context_id: { type: 'string', description: 'Only the errors on this context.' },
        task_id: { type: 'string', description: 'Only this task\'s errors.' },
        text: { type: 'string', minLength: 1, description: 'Only errors whose message contains this text (any case).' },
        detail: { type: 'boolean', description: 'Give each error of the page in full (arguments and detail), not only its message.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many to return (default 20).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many of the newest first (next_offset of the previous page).' },
      },
    },
    experiment: experimentSchema(),
    memory: memorySchema(catalog),
  };
  // the input contracts of the engine methods the tools hand to (METHOD_CONTRACTS): validated, never offered
  const contracts = {
    // Stage schemas may reference root-level definitions (the recursive python body): hoist them.
    'build_pipeline_model.pipeline': withStageDefs(registerModel, catalog),
    'delete_context.context': {
      ...ctxRef,
      description: 'Tear down an entire isolated context (delete its files + artifacts).',
      properties: { ...ctxRef.properties, force: { type: 'boolean', description: 'Drop even though another draft reads a table this context built.' } },
    },
    'delete_context.pipeline_model': { ...ctxRef, description: 'Delete the pipeline model of a context (remove its view + semantic model) and re-parse.' },
    'delete_context.semantic_model': del,
    'context.describe': { ...ctxRef, description: 'Describe a context: tasks, semantic models, measures, metrics, reachable group-by paths.' },
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

/** Attach the stages' `$defs` at a tool schema's root (where `#/$defs/…` references resolve). */
function withStageDefs(toolSchema, catalog) {
  const defs = stageDefs(catalog);
  return Object.keys(defs).length ? { ...toolSchema, $defs: { ...(toolSchema.$defs || {}), ...defs } } : toolSchema;
}
