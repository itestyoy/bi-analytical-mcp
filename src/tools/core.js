// THE CORE TOOLS — one definition each (src/tools/define.js). A tool's input schema is built with the
// others from the catalog (src/schema.js, by the tool's name); everything else about it is here.
//
// WHICH SIDE A TASK BELONGS TO (`side`) — and so which query tool reads it back (`reads`). A semantic
// task (a declared model being parsed, a metric query) is read with query_semantic_model({ request: { task_ids } }); a
// pipeline task (a build, a query over a built model) with query_pipeline_model({ request: { task_ids } }). An
// experiment is no task at all: its statistics come back with its call.

import { MAX_WAIT_SECONDS } from '../schema.js';
import { READ_PAGE } from '../schema/fields.js';
import { SELF_REFUSAL_TOOL } from '../self-refusal.js';
import { defineTool } from './define.js';
import { OUTPUTS } from '../schema/outputs.js';

export const CORE_TOOLS = [
  defineTool({
    name: 'semantic_index',
    title: 'Explore Semantic Index',
    description: `Explore the catalog: what the data means, its real values, how complete and how fresh it is. Use it before building anything while you do not yet know which events, properties or attributes answer the question, and whenever a field's meaning or values are unclear; fields already established earlier in the conversation need no second look. No arguments → the overview (models, event names, event_semantics — which event marks install / session / purchase, group-by paths, value-index freshness, recipe ids). Exactly one view key drills in: { model } → its columns and attributes with real sample values, the relationships it declares (join name, key columns, target) and the amounts it marks aggregatable (unit, meaning); { source, event } → the properties that event carries; { source, property } → one column's passport (spec/unit, value distribution — pageable, NULL coverage per event telling expected NULLs from data gaps, indexing history). Name the source every time: each owns its events and payload, never mixed. { search } → fuzzy search over events, properties, attributes, values, recipes and notes (typos tolerated; fuzzy:false for substring only); { recipe: id } → one ready-made recipe in full (payload, example_queries, the reusable \`hack\`); { guide: true } → how to approach a question: the analyst workflow, which tool fits which question, recipe families (pass a family name to narrow); { guide: "research" } → how to run an investigation (the field names a guide per domain); { bundle: id } → which event properties one app populates and which it leaves empty (the overview lists apps under \`bundles\`); { notes: true } → the analyst memory's notes; { status: true } → value-index sync state and background query jobs; { run } → one sync run's per-property breakdown. ${SELF_REFUSAL_TOOL}`,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.semantic_index(input),
  }),
  defineTool({
    name: 'build_semantic_model',
    output: OUTPUTS.build_semantic_model,
    title: 'Build Semantic Model',
    description: 'Declare reusable, named metrics for a task — semantic models (one per source; several sources may sit side by side, e.g. spend next to an event measure) plus metrics — in an isolated context, then query them many ways with query_semantic_model (group_by, time grain, filters). Use it for measurable metrics such as DAU, revenue or a ratio of two counts; for a one-off derived table whose rows are the answer (a funnel, a conversion or a return within a window of an event, sessions, a window, a pivot) use build_pipeline_model instead. Omit context_id to start a task; pass it to extend the same one. To change a task already in a context — add or remove measures, dimensions or metrics on one model without restating the rest — call it with action:"update" (context_id, semantic_model, the add_*/remove_* fields). The declaration is validated in the call; parsing it is a task, so the call returns only { task_id, context_id } and does not wait. query_semantic_model({ request: { task_ids } }) returns the parse, the metrics and what they can be grouped by; a query on the context can be started right away (it waits for the parse). preview_semantic_model shows the context\'s layer as parsed and checks it.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    side: 'semantic',
    run: (engine, input) => engine.build_semantic_model(input),
  }),
  defineTool({
    name: 'build_pipeline_model',
    title: 'Build Pipeline Model',
    description: 'Build a one-off derived table whose rows are the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the named metrics of build_semantic_model cannot express; for reusable metrics sliced many ways, use build_semantic_model instead. The pipeline is composed step by step with `action`: start a draft, add_step one stage at a time (where / derive / compute — expressions, window functions included / unnest / join / aggregate / pivot / unpivot / sample / order_by / limit / project / match_recognize), optionally preview the SQL, then materialize. Each add_step validates the stage and returns the columns available to the next one; nothing runs in the warehouse until materialize. A join names the relationship the schema declares (via: <name>) rather than its columns, and joins stack, so one pipeline can reach several sources. materialize returns only a task_id and does not wait: query_pipeline_model({ request: { task_ids } }) returns the rows, and query_pipeline_model({ request: { context_id, transform } }) filters or regroups the built table later (query_semantic_model does not read pipelines). start with from_task re-slices the stored table of a finished task (a materialized query, an earlier build) without recomputing it. A `python` stage is a dbt Python model of its own, run on the warehouse\'s Python runtime; it may appear anywhere in the pipeline, more than once, and carries only what SQL cannot say. Its own description holds the rules — what belongs in it, what this warehouse\'s frame raises, and the recipes to study before writing one. Its table is read with query_pipeline_model like any pipeline.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    side: 'pipeline',
    run: (engine, input) => engine.build_pipeline_model(input),
  }),
  defineTool({
    name: 'query_semantic_model',
    title: 'Query Semantic Model',
    description: `Start a metric query on a context built by build_semantic_model, or read one back. metrics, group_by and where are validated in the call; a mistake is refused at once, with the fix. Joins are applied for you: group or filter by an attribute addressed as { model, attribute } and the declared key is used — including the validity window of a slowly-changing model, so each row gets the attribute valid at its time. Starting a query returns only { task_id } and does not wait. The same tool reads it back: { task_ids: [id] } waits for semantic tasks — this query, or a model build_semantic_model is parsing — for up to ${MAX_WAIT_SECONDS}s and returns the moment it is done; while it says running, call again. materialize:true stores the whole result as a table: pageable ({ task_ids, offset, limit }), drawable as a drill-down, and a starting point for a pipeline (from_task). Several independent queries on one context — other metrics, another breakdown, another window — go in one call: { context_id, queries: [ … ] }, run side by side; { task_ids } reads them back together, each one's result under results, in order (each stays a task of its own: paged, drawn, started from one by one). A read hands back ${READ_PAGE} rows a page unless limit says otherwise; its page says total_rows, has_more and next_offset, and whether the rows are in a stated order (without order_by they are not). Stop tasks you no longer need with { task_ids, cancel: true }. Each of the dbt project's own semantic models is a context of its own (context_id: its name, nothing to build), queried by the project's names — { semantic_model: [chain of models], dimension }, { entity } — rather than { model, attribute }; preview_semantic_model lists what a metric there is and each item its group_by takes, as MetricFlow resolves it.`,
    // every call starts a task; materialize:true persists the result into the context — a write, never a removal
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    side: 'semantic',
    reads: 'semantic',
    waits: true,
    precheck: (engine, args) => { for (const id of args.task_ids) engine.tasks.forSide(id, 'semantic'); },
    run: (engine, input) => engine.query_semantic_model(input),
  }),
  defineTool({
    name: 'query_pipeline_model',
    title: 'Query Pipeline Model',
    description: `Query a table built by build_pipeline_model, or read a pipeline task back — the pipeline side's counterpart of query_semantic_model. { context_id, transform? } starts a read-only projection (where / group_by / aggregations, each optionally over the rows its where holds for / having / order_by, and a second level — then — over the grouped result, to count the groups that passed) over the stored table, recomputing nothing upstream, and returns only { task_id }. { task_ids: [id] } waits for pipeline tasks — a build (materialize) or such a query — for up to ${MAX_WAIT_SECONDS}s, returns its rows the moment it is done, and says running otherwise (call again); a read hands back ${READ_PAGE} rows a page unless limit says otherwise (offset/limit page a stored table; page says total_rows, has_more, next_offset, and whether the rows are in a stated order). Several projections of one model go in one call — { context_id, queries: [{ transform }, …] }, run side by side — and are read back together with { task_ids }. Stop tasks you no longer need with { task_ids, cancel: true }.`,
    // every call starts or reads a task; a query over a built model writes nothing to the warehouse
    annotations: { readOnlyHint: true, idempotentHint: false },
    side: 'pipeline',
    reads: 'pipeline',
    waits: true,
    precheck: (engine, args) => { for (const id of args.task_ids) engine.tasks.forSide(id, 'pipeline'); },
    run: (engine, input) => engine.query_pipeline_model(input),
  }),
  defineTool({
    name: 'preview_semantic_model',
    title: 'Preview Semantic Model',
    description: `Show a semantic layer as dbt parsed it, and check it — of one of the dbt project's own semantic models (context_id: its name; they have no build step that would report them) or of a context build_semantic_model built. Use it before querying a metric you do not know: what it is, how it is computed, and what its query may group by. It answers at once and runs nothing:
- status: parsed, valid, and issues — what the declaration itself gets wrong (a missing input metric, a time axis that is not a time dimension), each an error or a note.
- semantic_models: each with its table, entity (the primary entity its dimensions are addressed through), entities (keys: name, type, expr — the column) and dimensions (name, type categorical or time, grain, expr — the column or expression).
- metrics: each with type, label, description, meta (the project's notes on reading it, such as additive: false), filter, and definition — a simple metric's semantic_model, agg and expr (plus percentile, non_additive_dimension, agg_time_dimension when set); a ratio's numerator and denominator; a derived metric's expr and inputs with their aliases. Its group_by is what it can be grouped by, each item spelled as query_semantic_model's group_by takes it: dimensions, entities, and metric_time (its time axis and grain); without metric, dimensions_from names the semantic models whose dimensions it takes. A metric of several semantic models offers only what they all share.
- groupable: a task context's { model, attribute } list. query_with and validate_with: calls to start from.
metric narrows it to one metric with its inputs and its group_by in full; semantic_model to one semantic model. validate: true checks by running instead — MetricFlow compiles each metric, and with a time_range the warehouse runs each one (its value comes back) and each semantic model's dimensions, naming what fails. That is warehouse work: it returns { task_id }, read with query_semantic_model({ request: { task_ids } }). semantic_index lists what exists.`,
    // reads a parsed layer; validate starts a task that compiles and runs metrics, writing nothing
    annotations: { readOnlyHint: true, idempotentHint: true },
    side: 'semantic',
    run: (engine, input) => engine.preview_semantic_model(input),
  }),
  defineTool({
    name: 'display_model_result',
    title: 'Display Model Result',
    description: 'Show a finished model result — a semantic query or a pipeline — to the person as a card, in a host that renders MCP Apps; it is the only tool that draws a model\'s rows. A client that has not declared the MCP Apps extension draws no card and is refused: there, answer with the rows in words. Use it once, for the result the person should see; reading a task for your own analysis goes through its query tool and needs no card. It reads the task the way the query tools do and draws it once — a second call for the same task is refused, so one question gets one card. `display` says how the rows are drawn (a chart, KPI tiles, a funnel, a sankey, a drill-down pivot…; its schema lists each kind and the fields it needs), over the result\'s columns. A task still running is refused: wait for it with its query tool ({ task_ids }) first. An experiment is not a model result: it draws its own card with card: true.',
    // draws a card, once per task: a second call is refused, not repeated
    annotations: { readOnlyHint: true, idempotentHint: false },
    view: 'result',
    appsOnly: true,
    waits: true,
    precheck: (engine, args) => engine._refuseDrawnAgain(args.task_id),
    run: (engine, input) => engine.display_model_result(input),
  }),
  defineTool({
    name: 'drill_result',
    title: 'Drill Into Result',
    description: 'The card\'s own read of the next view of a drawn drill-down (a pivot row opened, a chart mark clicked). The card calls it; the model has no reason to.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    appsOnly: true,
    appCallable: true,
    run: (engine, input) => engine.drill_result(input),
  }),
  defineTool({
    name: 'context',
    output: OUTPUTS.context,
    title: 'Read Contexts',
    description: 'Read the isolated contexts that build_semantic_model and build_pipeline_model create: action:"list" gives a page of contexts, the most recently used first, each with its description (offset pages through them, search narrows them — the server keeps every conversation\'s); action:"describe" gives one context\'s tasks, models, metrics and group-by paths. It changes nothing; to remove a context or a model in it, use delete_context.',
    // list / describe read the contexts; removing is delete_context
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.context(input),
  }),
  defineTool({
    name: 'delete_context',
    output: OUTPUTS.delete_context,
    title: 'Delete Context',
    description: 'Remove a context build_semantic_model or build_pipeline_model created, or part of it: what:"context" (the default) tears the whole context down; what:"pipeline_model" removes its pipeline model and keeps the context; what:"semantic_model" removes one model\'s task additions (cascade also removes the metrics that depend on them). Use it when a workspace is no longer needed or a declaration has to be taken back; it cannot be undone. A context another draft reads a table from is kept unless force is set. The dbt project\'s own semantic models cannot be removed.',
    // removes a context or what it holds: done once, then there is nothing left to remove
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: (engine, input) => engine.delete_context(input),
  }),
  defineTool({
    name: 'memory',
    output: OUTPUTS.memory,
    title: 'Use Memory',
    description: 'Durable analyst memory: record what you found out, so it comes back through semantic_index next time. Use it after you resolve something non-obvious — a vague request tracked down to a real field, a gotcha, a useful source. action:"record" takes `note` (the finding); `question` (the original business question it answers, in the stakeholder\'s words — it is embedded with the note, so a later question with the same meaning retrieves it); `targets` (the catalog entities it is about, each { source, name } — a property, attribute or event of that source, e.g. { source: "events", name: "ad_type_of_event_data" }, { source: "users", name: "country" } — or { source } for a model); `aliases` (the words the user actually used, e.g. "ad format", in the original language and in English so search works across languages); `links` (any sources). The note then appears on the linked semantic_index views ({ model } / { source, event } / { source, property }) and in semantic_index({ request: { search } }). Keep one finding per note: when studying a topic or a document, split it into several small notes, each with its own targets and aliases — small notes link precisely and are retrieved far better, while an over-long note matches poorly and may fail to index. action:"forget" removes one by id. Reading the memory is semantic_index\'s: { search } (by word and, with embeddings, by meaning), { notes: true } (every note with its id), and the views of what a note is about.',
    // it writes: record saves a finding, forget removes one — reading is semantic_index's, which asks nothing
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: (engine, input) => engine.memory(input),
  }),
  defineTool({
    name: 'experiment',
    title: 'A/B Experiment Toolkit',
    description: 'The A/B experiment lifecycle in one tool, by action: plan → check_split → analyze. It is statistics over numbers you bring: compute the per-group aggregates first with a pipeline. action:"plan" — power / sample size (the users required, or the MDE at a given n), before the test runs. action:"check_split" — the sample-ratio-mismatch χ² guardrail; p < 0.001 means randomization or logging is broken and the result is invalid, so run it before trusting any lift. action:"analyze" — the significance test on pre-aggregated per-group stats (metric: proportion → two-proportion z-test; mean → Welch t-test; ratio → delta method; cuped → variance reduction), returning lift (with a relative-lift CI), p-value, CI, significance and a multiplicity-adjusted p per variant; sequential:true adds an always-valid p for peeking at a live test. Field names are exact: `baseline` (not baseline_rate) and `confidence` (not alpha); there is no `allocation` field (use check_split.expected_ratio). For proportion, each group needs `conversions` between 0 and n. Examples — plan: {action:"plan",metric:"proportion",baseline:0.1,mde:0.02}; check_split: {action:"check_split",groups:[{label:"control",n:5000},{label:"variant_b",n:5020}]}; analyze: {action:"analyze",metric:"proportion",control:{n:5000,conversions:500},variants:[{label:"variant_b",n:5020,conversions:580}],correction:"holm"}.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    view: 'result',
    cardField: 'card',
    run: (engine, input) => engine.experiment(input),
  }),
  defineTool({
    name: 'explore_errors',
    output: OUTPUTS.explore_errors,
    title: 'Explore Errors',
    description: 'Read the failures this server kept, to find out why something did not work: a tool call that was refused or failed (with the arguments it was called with), a task that ended in an error (what dbt or the warehouse said), and what the last start could not serve (the dbt project\'s semantic layer, a join it leaves out, a feature that cannot run here). Use it when a result was an error you cannot explain from its message, when a task failed earlier in the conversation, or when something the overview lists as unavailable needs its reason. With an empty request it gives the newest 20 and a summary by source, tool and stage; since / until, source, severity, tool, stage, context_id, task_id and text narrow them, and { id } gives one in full. It reads the log only and changes nothing.',
    // reads the error log; writes nothing
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.explore_errors(input),
  }),
  defineTool({
    name: 'time',
    output: OUTPUTS.time,
    title: 'Timer',
    description: `Wait for \`seconds\` (capped at ${MAX_WAIT_SECONDS}), then return — a timer that touches no data and follows no task. To wait for a task, call its query tool with { task_ids } instead (query_semantic_model or query_pipeline_model): it returns the moment the task is done.`,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.time(input),
  }),
];

/** The core tools by name — what a surface without an engine (a result's card, a test) consults. */
export const CORE_BY_NAME = new Map(CORE_TOOLS.map((t) => [t.name, t]));
