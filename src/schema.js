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
import { TASK, CTX, TASK_ID, D, semanticModelBranch, metricSchema, projectRef, projectEntityRef, METRIC_TIME_RANGE, predicateDefs, MAX_WAIT_SECONDS, READ_PAGE, KEPT_ROWS, CONTEXT_PAGE, TASK_READ, attributeRefForms, timeRef, dimensionFields } from './schema/fields.js';
import { display } from './schema/display.js';
import { projection } from './schema/projection.js';
import { transportSchema } from './schema/transport.js';
import { form, pick, conditionList, timeRange, SCALAR } from './schema-kit.js';
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
  // the models a semantic layer can load: an item of semantic_models, and the dimensions an update
  // removes, are offered only over them (a model with no primary entity is a pipeline join's)
  const semanticKeys = catalog.semanticModelKeys();
  const createFields = {
    context_id: { type: 'string', pattern: CTX, description: D.context_id },
    name: { type: 'string', pattern: TASK, description: 'Task name (lowercase snake_case). Namespaces all measures/metrics so multiple tasks coexist in one context.' },
    description: { type: 'string', description: 'What this task computes, in your words. Kept with the context and returned by context({ request: { action: "describe" | "list" } }), so a later call — or another session — can tell what this context is for without re-reading its YAML.' },
    semantic_models: { type: 'array', items: { anyOf: semanticKeys.map((k) => semanticModelBranch(catalog, k)) }, description: 'One or more per source model: { from, where?, dimensions?, measures? }; each item\'s where scopes its own measures. An item with only `from` loads that model, so its attributes can be grouped and filtered as { model, attribute } (e.g. { from: "users" } for { model: "users", attribute: "country" }; a slowly-changing model is joined point-in-time). Every name in an item is a `field` of its model — a column, a scalar payload property, a declared amount. A measure is { name, agg, field?, percentile?, where?, cast?, label? }: count without field counts rows.' },
    metrics: { type: 'array', minItems: 1, items: metricSchema(catalog), description: 'The metrics to expose for querying (each references measures defined above).' },
    dry_run: { type: 'boolean', description: 'If true, validate and return the definition without writing files or building anything.' },
    include_yaml: { type: 'boolean', description: 'Return the full rendered context YAML in the response (default false). The YAML is always written to the context files regardless; omit it to keep responses small.' },
  };
  // action: 'update' — the incremental path, in the SAME vocabulary as a declaration: what it adds is
  // written exactly as a declaration writes it (the same items, so a listing carries them once), and
  // what it removes is named the way it was added.
  const updateFields = {
    context_id: { type: 'string', pattern: CTX, description: 'The context whose task to change.' },
    task: { type: 'string', pattern: TASK, description: 'The task to change, one the context holds (default: its first). To add a task beside it, declare one: { name, context_id, … } without action.' },
    semantic_models: { ...createFields.semantic_models, description: 'What to add, per source model: dimensions and measures (an item\'s where scopes the measures declared beside it, never those already there). An item with only `from` loads a model this context does not read yet, so its attributes can be grouped and filtered as { model, attribute }.' },
    metrics: { type: 'array', minItems: 1, items: metricSchema(catalog), description: 'Metrics to add.' },
    remove: {
      type: 'object', additionalProperties: false,
      description: 'What to remove, by the names it was added under. Removals come first, so one update replaces a measure or a metric by removing it and declaring it again.',
      properties: {
        dimensions: { type: 'array', minItems: 1, items: { anyOf: semanticKeys.filter((k) => dimensionFields(catalog, k).length).map((k) => form({ title: k, tag: ['from', k], required: ['field'], properties: { field: { enum: dimensionFields(catalog, k), description: `A dimension this context declared on ${k}, by its field.` } } })) }, description: 'Dimensions to remove: { from, field }, as they were declared.' },
        measures: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Refused while a metric reads one, unless cascade.' },
        metrics: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Refused while a ratio or derived metric is built from one, unless cascade.' },
      },
    },
    cascade: { type: 'boolean', description: 'Also remove what is built on a removed item: the metrics that read a removed measure, and the ratio and derived metrics built from a removed metric.' },
    dry_run: createFields.dry_run,
    include_yaml: createFields.include_yaml,
  };
  const create = {
    type: 'object',
    description: 'Two forms. The default declares a task — name, semantic_models, metrics — in a new context, or beside the task already in context_id. action:"update" changes the task in a context in the same words: semantic_models and metrics are added, `remove` takes them away by name, and the rest stays as declared.',
    anyOf: [
      form({ title: 'declare a task', tag: ['action', 'create'], optionalTag: true, required: ['name', 'metrics'], properties: createFields }),
      form({ title: 'update the task in a context', tag: ['action', 'update'], required: ['context_id'], properties: updateFields }),
    ],
  };

  // the window a pipeline reads its source in — the built-in-one-call contract and the builder's start alike
  const pipelineWindow = timeRange('Restrict the pipeline to a time window on the source\'s time column (ISO dates), applied before the stages — avoids hand-written time literals and keeps whole-session windows intact.');

  // a pipeline built in one call (build_pipeline_model.pipeline): a derived dbt model from a declarative PIPELINE
  // (a pipe-syntax transformation, optionally ending in a match_recognize funnel)
  // and materialize it. The pipeline's rows ARE the result.
  const registerModel = {
    type: 'object', additionalProperties: false, required: ['name', 'pipeline'],
    description: 'Build a derived model from a PIPELINE: a `source` + ordered `stages` (where/compute/unnest/join/aggregate/pivot/unpivot/sample/order_by/limit/project, and the match_recognize funnel stage; window functions are compute expressions). Its ROWS are the result — the call returns a task_id and query_pipeline_model({ request: { task_ids } }) returns them; a pipeline started from that task (from_task) re-slices them without recomputing. Funnels are pipelines too: add a match_recognize stage, then slice it with a downstream join/aggregate (e.g. conversion by country).',
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
          time_range: pipelineWindow,
          stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/pipeline_stage' }, description: 'Ordered pipe stages; each transforms the previous output.' },
        },
      },
    },
  };

  // build_pipeline_model: compose a pipeline INCREMENTALLY, one stage at a time. A
  // single stateful tool with an `action`; add_steps validates each stage and
  // returns the columns now available for the NEXT stage (schema only — nothing is
  // materialized until materialize).
  const pipelineFields = {
    context_id: { type: 'string', pattern: CTX, description: 'The context the draft is in — the context_id start returned. For fork it may also be a context whose pipeline was already materialized.' },
    name: { type: 'string', pattern: TASK, description: 'Model name (lowercase snake_case); generated as pipe_<name>.' },
    description: { type: 'string', description: 'What this pipeline computes, in your words — kept with the draft, shown by context list / describe and in the model it builds, so two drafts can be told apart.' },
    materialized: { enum: ['view', 'table'], default: 'table', description: 'How the result is stored when materialized (chosen at start): table (default) or view.' },
    from_task: { type: 'string', pattern: TASK_ID, description: 'Begin from the stored table of a finished task — a query run with materialize:true, or a pipeline build — instead of a catalog source. The steps re-slice that result (filter, regroup, join, window…) without recomputing it.' },
    source: { type: 'string', enum: modelKeys, description: `Source table the pipeline reads. Each source (${catalog.modelKeys().join(', ')}) has its own columns, events and payload, and they are never mixed.` },
    time_range: pipelineWindow,
    stage: { $ref: '#/$defs/pipeline_stage', description: 'One pipe stage, placed at `index` (edit_step replaces it, insert_step goes before it), validated against the columns available at that point.' },
    stages: { type: 'array', minItems: 1, items: { $ref: '#/$defs/pipeline_stage' }, description: 'Stages to append in order — one or several; with start, the draft\'s first ones. All or none; the response reports each stage\'s effect on the data. A logical chunk at a time (scope, then the funnel, then the aggregate) shows how each changes the data.' },
    materialize: { type: 'boolean', description: 'Build right after the steps are added — what a materialize call does: its task_id comes back beside the steps\' effects. The steps are added either way; a build that cannot start (one still running, say) is answered under `materialize` with why.' },
    index: { type: 'integer', minimum: 1, description: 'Target step (1-based, per steps[].index). insert_step places the stage before this position (count+1 appends).' },
    after: { type: 'integer', minimum: 0, description: 'Keep steps 1..after — truncate drops the rest; fork copies that prefix into the new draft (omit on fork to copy all steps). 0 = none.' },
    validate: { type: 'boolean', description: 'preview only: check the draft\'s SQL against the warehouse without reading data (dbt run --empty) — a task, read with query_pipeline_model. Worth it before an expensive materialize.' },
    include_columns: { type: 'boolean', description: 'Also return the full list of available columns; by default each answer gives only what a step added and removed.' },
    include_steps: { type: 'boolean', description: 'Also return every step of the draft; by default only the steps just added and steps_count.' },
  };
  const echo = ['include_columns', 'include_steps'];
  // One form per action, each with exactly the fields that action takes: a stray field is refused
  // rather than silently ignored, and nothing is said about it beside the form — it is not in it.
  const step = (action, title, tagDescription, required, optional = []) => form({ title, tag: ['action', action], tagDescription, required: ['context_id', ...required], properties: pick(pipelineFields, ['context_id', ...required, ...optional, ...echo]) });
  // a start makes the draft: in a new context, or — context_id given — in that one (its draft replaced)
  const startFields = { ...pipelineFields, context_id: { type: 'string', pattern: CTX, description: 'Start the draft in this context (one a build returned; a draft already in it is replaced). Omit it for a new context.' } };
  // a source is read within a window; a task's table was computed under its own already (a where step
  // filters it), so its form takes none
  const startOptional = ['context_id', 'description', 'materialized', 'stages', 'materialize', ...echo];
  const buildModel = {
    type: 'object',
    description: 'One form per `action`: start (the default — with `stages`, its first steps) → add_steps → optionally preview → materialize, then more steps and materialize again; materialize: true on start or add_steps builds right after the steps. Every edit revalidates the whole pipeline and names the step it breaks. A materialized table stands for the steps so far: later steps read it instead of recomputing the prefix, and editing a step at or before it retires it (from_checkpoint / steps_recomputed / checkpoints_dropped say which).',
    anyOf: [
      form({ title: 'start from a source', tag: ['action', 'start'], optionalTag: true, tagDescription: 'start (the default): a new draft over a catalog source (returns its context_id + the source columns).', required: ['name', 'source'], properties: pick(startFields, ['name', 'source', 'time_range', ...startOptional]) }),
      form({ title: 'start from a task', tag: ['action', 'start'], optionalTag: true, tagDescription: 'start (the default): a new draft over the stored table of a finished task (from_task); `source` names the source the steps resolve payload properties and relationships against (taken from the task when it read one source).', required: ['name', 'from_task'], properties: pick(startFields, ['name', 'from_task', 'source', ...startOptional]) }),
      step('add_steps', 'add steps', 'add_steps: append stages — one or several, in order, all or none; returns what each did to the data.', ['stages'], ['materialize']),
      step(['edit_step', 'insert_step'], 'edit or insert a step', 'edit_step replaces step `index`; insert_step inserts a stage before `index`.', ['index', 'stage']),
      step('delete_step', 'delete a step', 'delete_step: remove step `index`.', ['index']),
      step('truncate', 'truncate the draft', 'truncate: keep only steps 1..`after` (cheap "go back to step N").', ['after']),
      step('fork', 'fork the draft', 'fork: branch a new draft from steps 1..`after` of this draft (or an already-materialized pipeline) without touching the original — iterate variants without re-typing the shared prefix; name defaults to the source draft\'s, description overrides the parent\'s.', [], ['name', 'description', 'after']),
      step('preview', 'preview the draft', 'preview: the steps and the SQL that would run. With validate: true it starts a task instead (read with query_pipeline_model) that runs the SQL with every input limited to zero rows (dbt run --empty): what the warehouse refuses is said in seconds, reading no data.', [], ['validate']),
      step(['materialize', 'discard'], 'materialize or discard', 'materialize builds the model and keeps the draft, recording the built table as the prefix the next steps read; discard drops the draft.', []),
    ],
  };

  const pdefs = predicateDefs(catalog, project);
  const pipelineQueryFields = {
    transform: projection,
    limit: { type: 'integer', minimum: 1, maximum: 100000, description: `How many rows of the projection the task keeps (default ${KEPT_ROWS}) — what a read ({ task_ids, offset, limit }) pages through. Every row of the model is in its build's task, whose stored table a read pages to the last row.` },
  };

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
  const batchOf = (item, what) => ({ type: 'array', minItems: 1, description: `Several ${what} in one call, run side by side: each item takes a single query's fields (context_id stays at the top). All are checked first — one mistake refuses the batch. Returns task_ids, in order.`, items: item });

  const semanticQueryFields = {
      metrics: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: `The metrics to compute, by the names the context offers: in a task's context, <task>_<metric> as build_semantic_model returned them${project ? '; in a context of one of the dbt project\'s own semantic models, the project\'s own names — every metric that reads that model (preview_semantic_model({ request: { context_id } }) lists them)' : ''}.` },
      group_by: {
        type: 'array',
        uniqueItems: true,
        description: `How to break the metrics down, one result column per item, in order. { time: "metric_time", grain } works in every context (column metric_time_<grain>). In a task's context an attribute is { model, attribute }: the join comes from the schema, and the context has to read the model — a semantic_models item of the build, { from: <model> } alone to load it (column <model>_<attribute>).${project ? ' In a context of one of the dbt project\'s own semantic models: { semantic_model: [...], dimension, grain? } — semantic_model is the chain of models the dimension is reached through (the context\'s own model alone for its own) — and { entity }; preview_semantic_model({ request: { context_id, metric } }) lists exactly the items a metric takes.' : ''}`,
        items: {
          anyOf: [
            timeRef(catalog),
            ...attributeRefForms(catalog),
            ...(project ? [projectRef(project, catalog), ...projectEntityRef(project)] : []),
          ],
        },
      },
      where: conditionList({ $ref: '#/$defs/predicate' }, 'Row filter applied before aggregation: conditions on dimensions / metric_time that all hold — an item may be { or: [...] }, any of its conditions holds (each a condition or { and: [...] }).'),
      order_by: { type: 'array', description: 'Sort order, by the names the rows come back with: a requested metric, or the result column of a group_by item ("users_country", "metric_time_day").', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } } },
      time_range: METRIC_TIME_RANGE,
      limit: { type: 'integer', minimum: 1, maximum: 100000, description: `How many rows of the result the task keeps (default ${KEPT_ROWS}): a read ({ task_ids, offset, limit }) pages through them, and a card draws them. With materialize the table stores every row and a read pages it to the last one; limit is then the rows the task keeps for a plain card (a drill-down reads its own views).` },
      materialize: { type: 'boolean', description: 'Store every row of the result as a table. A stored result survives a restart, a read ({ task_ids, offset, limit }) pages it to its last row, it can be drawn as a drill-down, and it can start a pipeline (from_task).' },
      dry_run: { type: 'boolean', description: 'Return the compiled SQL without running it (it waits for the context\'s build only).' },
      include_plan: { type: 'boolean', description: 'With dry_run: also MetricFlow\'s dataflow plan — thousands of tokens; the SQL alone is usually what is wanted.' },
  };
  const semanticContextId = contextId(`The context to query${projectContexts.length ? ': one of the dbt project\'s own semantic models, by its name (the listed values — read at start, nothing to build), or the context_id build_semantic_model returned' : ': the context_id build_semantic_model returned'}. The context decides which metrics there are and how a dimension is named in group_by and where.`);
  const query = {
    type: 'object',
    description: 'Start a metric query against a context (or several at once with queries) — or, with task_ids, read semantic tasks back.',
    $defs: pdefs,
    anyOf: queryModes({ context_id: semanticContextId, fields: semanticQueryFields, required: ['metrics'] }, batchOf({ type: 'object', additionalProperties: false, required: ['metrics'], properties: semanticQueryFields }, 'metric queries'), readPaging),
  };

  // context reads (list, describe), delete_context removes (the context, its pipeline model, or a
  // semantic model's additions). Strict per-action fields.
  // THE CONTEXTS, READ — list them, or describe one. Nothing here changes anything, so the tool is
  // read-only as a whole; removing what a context holds is delete_context, a tool of its own, because
  // a client asks before a destructive call and should not have to ask before a listing.
  const describeForm = form({ title: 'describe a context', tag: ['action', 'describe'], tagDescription: 'describe: one context in depth.', required: ['context_id'], properties: { context_id: contextId(`The context to describe — the context_id a build returned${projectContexts.length ? ', or one of the dbt project\'s own semantic models by its name' : ''}.`) } });
  const contextTool = {
    type: 'object',
    description: 'Read the isolated execution contexts (the workspaces build_semantic_model / build_pipeline_model produce). action: list (a page of contexts, most recently used first) | describe (one context\'s tasks/models/metrics/group-by paths). Removing one, or a model in one, is delete_context.',
    anyOf: [
      form({ title: 'list the contexts', tag: ['action', 'list'], tagDescription: `list: the contexts, most recently used first, ${CONTEXT_PAGE} to a page — the server keeps every conversation's, so page through them (offset) or narrow them (search).`, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: `How many contexts the page holds (default ${CONTEXT_PAGE}).` },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many first — next_offset of the previous page.' },
        search: { type: 'string', minLength: 1, description: 'Keep the contexts whose id, task or metric names, notes or description contain this text (any case).' },
      } }),
      describeForm,
    ],
  };
  // WHAT A CONTEXT HOLDS, REMOVED — the whole context, its pipeline model, or one model's task additions.
  const deleteId = { type: 'string', pattern: CTX, description: 'The context a build returned. The dbt project\'s own semantic models are read at start and cannot be removed.' };
  const deleteForms = {
    context: form({ title: 'the whole context', tag: ['what', 'context'], optionalTag: true, tagDescription: 'context (the default): tear the whole context down.', required: ['context_id'], properties: { context_id: deleteId, force: { type: 'boolean', description: 'Tear it down even though another draft reads a table it built (a fork that inherited a materialized prefix); those drafts then recompute that prefix from the source.' } } }),
    pipeline_model: form({ title: 'its pipeline model', tag: ['what', 'pipeline_model'], tagDescription: 'pipeline_model: remove the context\'s pipeline model and keep the context.', required: ['context_id'], properties: { context_id: deleteId } }),
    semantic_model: form({ title: 'one semantic model\'s additions', tag: ['what', 'semantic_model'], tagDescription: 'semantic_model: remove one model\'s task additions.', required: ['context_id', 'semantic_model'], properties: { context_id: deleteId, semantic_model: { type: 'string', enum: modelKeys, description: 'Which model\'s task additions to remove.' }, cascade: { type: 'boolean', description: 'Also remove the metrics that depend on the removed measures.' } } }),
  };
  const deleteContext = {
    type: 'object',
    description: 'Remove a context, or part of what it holds. It cannot be undone.',
    anyOf: Object.values(deleteForms),
  };

  const tools = {
    build_semantic_model: create,
    build_pipeline_model: withStageDefs(buildModel, catalog),
    context: contextTool,
    delete_context: deleteContext,
    query_semantic_model: query,
    query_pipeline_model: {
      type: 'object',
      description: 'Query a built pipeline model (or several queries at once with queries) — or, with task_ids, read pipeline tasks back.',
      anyOf: queryModes(
        { context_id: { type: 'string', pattern: CTX, description: 'The context whose BUILT pipeline model to query (the context_id build_pipeline_model returned, after materialize).' }, fields: pipelineQueryFields },
        batchOf({ type: 'object', additionalProperties: false, properties: pipelineQueryFields }, 'queries over the built model'),
        readPaging,
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
    // a context's semantic layer as dbt parsed it — one of the project's own semantic models, or a task's
    preview_semantic_model: (() => {
      const fields = {
        context_id: contextId(`The context to show: ${projectContexts.length ? 'one of the dbt project\'s own semantic models, by its name (the listed values), or ' : ''}the context_id build_semantic_model returned.`),
        // a task's context names its semantic models after the catalog's models it loads; the project's are its own
        semantic_model: { type: 'string', enum: [...new Set([...semanticKeys, ...(project ? project.semantic_models.map((m) => m.name) : [])])].sort(), description: 'Narrow the answer to one semantic model of the context and the metrics that read it — mostly for a task\'s context, which can hold several. With metric too, the metric\'s semantic models are narrowed to this one.' },
        metric: { type: 'string', description: 'Narrow the answer to one metric: its definition, the metrics it is made of (each with its own), and its group_by in full — every dimension, entity and the time axis it can be grouped by, each item spelled exactly as query_semantic_model\'s group_by takes it.' },
        validate: { type: 'boolean', description: 'Check the layer by running it: MetricFlow compiles each metric in view, naming one it cannot build. A task: it returns { task_id }, read with query_semantic_model.' },
        time_range: timeRange('The metric_time window the metrics and dimensions are run over. Keep it short — the warehouse reads what falls in it.'),
      };
      return {
        type: 'object',
        description: 'context_id alone shows the context\'s whole semantic layer; with metric, one metric in full (its inputs and everything its group_by takes); with semantic_model, one semantic model and the metrics that read it. validate: true checks it by running it instead — a task; with a time_range the warehouse also runs each metric over that window and reads each semantic model\'s dimensions and entities.',
        anyOf: [
          form({ title: 'show the layer', required: ['context_id'], properties: pick(fields, ['context_id', 'semantic_model', 'metric', 'validate']) }),
          form({ title: 'validate over a window', tag: ['validate', true], required: ['context_id', 'time_range'], properties: pick(fields, ['context_id', 'semantic_model', 'metric', 'time_range']) }),
        ],
      };
    })(),
    semantic_index: semanticIndexSchema(catalog),
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
        detail: { enum: ['summary', 'full'], description: 'summary (the default): each error of the page by its message; full: each in full (arguments and detail).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many to return (default 20).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many of the newest first (next_offset of the previous page).' },
      };
      return {
        type: 'object',
        description: 'Read the failures the server kept. { id } → one in full; otherwise a page of them, newest first, narrowed by the fields given.',
        anyOf: [
          form({ title: 'one error in full', required: ['id'], properties: pick(errorFields, ['id']) }),
          form({ title: 'a page of errors', properties: pick(errorFields, ['time_range', 'source', 'severity', 'tool', 'stage', 'context_id', 'task_id', 'search', 'detail', 'limit', 'offset']) }),
        ],
      };
    })(),
    experiment: experimentSchema(),
    memory: memorySchema(catalog),
  };
  // the input contracts of the engine methods the tools hand to (METHOD_CONTRACTS): validated, never offered
  const contracts = {
    // Stage schemas may reference root-level definitions (the recursive python body): hoist them.
    'build_pipeline_model.pipeline': withStageDefs(registerModel, catalog),
    // what the tool's form takes, its tag left out — the method is handed the form's fields, so a field
    // added to the form reaches the method's contract with it
    'delete_context.context': untagged(deleteForms.context, 'what', 'Tear down an entire isolated context (delete its files + artifacts).'),
    'delete_context.pipeline_model': untagged(deleteForms.pipeline_model, 'what', 'Delete the pipeline model of a context (remove its view + semantic model) and re-parse.'),
    'delete_context.semantic_model': untagged(deleteForms.semantic_model, 'what', 'Remove a semantic model\'s task additions from a context.'),
    'context.describe': untagged(describeForm, 'action', 'Describe a context: tasks, semantic models, measures, metrics, reachable group-by paths.'),
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

/** Attach the stages' `$defs` at a tool schema's root (where `#/$defs/…` references resolve). */
function withStageDefs(toolSchema, catalog) {
  const defs = stageDefs(catalog);
  return Object.keys(defs).length ? { ...toolSchema, $defs: { ...(toolSchema.$defs || {}), ...defs } } : toolSchema;
}
