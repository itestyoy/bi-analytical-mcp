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
    description: `Explore the catalog: what the data means, its real values, how complete and fresh it is. Use it before building anything while you do not yet know which events, properties or attributes answer the question, or when a field's meaning or values are unclear — not again for fields already established in the conversation. An empty request gives the overview (models, events, which event marks install / session / purchase, value-index freshness, recipe ids). One view drills in: { model } — its columns with sample values, relationships and aggregatable amounts; { source, event } — the properties that event carries; { source, property } — one column's meaning, value distribution and NULL coverage per event; { search } — events, properties, values, recipes and notes by word, typos tolerated; { recipe } — one ready-made recipe; { guide: true } — which tool fits which question; { guide: "research" } — how to run an investigation; { bundle } — which properties one app fills; { notes: true } — the saved findings; { status } / { run } — index sync state; { views: [...] } — several drill-ins at once. The source is always named: each owns its events and payload. ${SELF_REFUSAL_TOOL}`,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.semantic_index(input),
  }),
  defineTool({
    name: 'build_semantic_model',
    output: OUTPUTS.build_semantic_model,
    title: 'Build Semantic Model',
    description: 'Declare reusable, named metrics — semantic models (items per source model, several side by side, e.g. spend next to an event measure; an item with only `from` loads a model for its attributes) and metrics over them — in an isolated context, then query them many ways with query_semantic_model (group_by, grain, filters). Use it for measures such as DAU, revenue or a ratio of two counts; a one-off table whose rows are the answer (a funnel, a conversion within a window, sessions, a pivot) is build_pipeline_model. Omit context_id to start a task; action:"update" adds to or removes from the task in a context without restating it. It returns { task_id, context_id } at once — parsing is a task; a query on the context can start right away and waits for it. preview_semantic_model shows the layer as parsed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    side: 'semantic',
    run: (engine, input) => engine.build_semantic_model(input),
  }),
  defineTool({
    name: 'build_pipeline_model',
    title: 'Build Pipeline Model',
    description: 'Build a one-off table whose rows are the answer — funnels (match_recognize), sessions, window functions, pivots, whatever the named metrics of build_semantic_model cannot express (reusable metrics sliced many ways belong there). Compose it step by step: each stage is checked as it is added and answers with the columns the next one sees; nothing runs in the warehouse until materialize (or materialize: true beside the steps), which returns a task_id. A recipe\'s pipeline_payload is a start request as it stands. query_pipeline_model reads the rows ({ task_ids }) and filters or regroups the built table later ({ context_id, transform }). A join names a relationship the schema declares (via), not columns, and joins stack. start with from_task re-slices the stored table of a finished task without recomputing it. Where the warehouse runs Python, a python stage is offered; its own description holds its rules.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    side: 'pipeline',
    run: (engine, input) => engine.build_pipeline_model(input),
  }),
  defineTool({
    name: 'query_semantic_model',
    title: 'Query Semantic Model',
    description: `Start a metric query on a context, or read semantic tasks back. The query is checked in the call — a mistake is refused with the fix — and returns { task_id } without waiting. Joins are applied for you: group or filter by { model, attribute } and the declared key is used, for a slowly-changing model the version valid at each row's time. { task_ids } waits up to ${MAX_WAIT_SECONDS}s and returns each result (call again while it is running); a page is ${READ_PAGE} rows unless limit says otherwise, and says whether the rows are in a stated order. materialize: true stores the whole result as a table: pageable, drawable as a drill-down, a start for a pipeline (from_task). Independent queries on one context go in one call ({ queries: [...] }) and run side by side. { task_ids, cancel: true } stops tasks. Each of the dbt project's own semantic models is a context named after it, queried by the project's names ({ semantic_model, dimension }, { entity }); preview_semantic_model lists what a metric there can be grouped by.`,
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
    description: `Query a table build_pipeline_model built, or read pipeline tasks back. { context_id, transform? } starts a read-only projection over the stored table — where, group_by, measures, having, order_by, and a second level (then) over the grouped result — recomputing nothing upstream, and returns { task_id }. { task_ids } waits up to ${MAX_WAIT_SECONDS}s for a build or such a query and returns its rows (call again while it is running); a page is ${READ_PAGE} rows unless limit says otherwise. Several projections go in one call ({ queries: [...] }). { task_ids, cancel: true } stops tasks.`,
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
    description: `Show a semantic layer as dbt parsed it, and check it — one of the dbt project's own semantic models (context_id: its name) or a context build_semantic_model built. Use it before querying a metric you do not know: what it is, how it is computed, what its query may group by. It answers at once and runs nothing: the layer's status and issues (what the declaration gets wrong), each semantic model (table, entities, dimensions), each metric (type, meta — the project's notes on reading it — filter, definition) with its group_by spelled as query_semantic_model takes it; a metric of several semantic models offers only what they share. metric narrows it to one metric in full, semantic_model to one model. validate: true checks by running instead — MetricFlow compiles each metric, and with a time_range the warehouse runs each one and each model's dimensions, naming what fails; that is a task, read with query_semantic_model.`,
    // reads a parsed layer; validate starts a task that compiles and runs metrics, writing nothing
    annotations: { readOnlyHint: true, idempotentHint: true },
    side: 'semantic',
    run: (engine, input) => engine.preview_semantic_model(input),
  }),
  defineTool({
    name: 'display_model_result',
    title: 'Display Model Result',
    description: 'Show a finished model result — a semantic query or a pipeline — to the person as a card. It is the only tool that draws a model\'s rows, in a host that renders MCP Apps; any other client is refused, and there you answer in words. Use it once, for the result the person should see; reading a task for your own analysis needs no card. Each task is drawn once (a second call is refused). display says how the rows are drawn — a chart, KPI tiles, a funnel, a sankey, a drill-down pivot… — over the result\'s columns. A task still running is refused: read it with its query tool first. An experiment draws its own card (card: true).',
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
    description: 'Durable analyst memory: save what you found out, so it comes back through semantic_index next time. Use it after resolving something non-obvious — a vague request tracked down to a real field, a gotcha, a useful source. action:"record" saves notes, one finding each, with the business question it answers, the catalog entities it is about (targets), the user\'s own words in their language and in English (aliases) and links; several from one study go in one call. A note then appears on the semantic_index views of its targets and in { search }. Small notes link and match far better than one long one. action:"forget" removes one by id. Reading is semantic_index\'s: { search }, { notes: true }, and the views of what a note is about.',
    // it writes: record saves a finding, forget removes one — reading is semantic_index's, which asks nothing
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: (engine, input) => engine.memory(input),
  }),
  defineTool({
    name: 'experiment',
    title: 'A/B Experiment Toolkit',
    description: 'The A/B test in one tool, plan → check_split → analyze: statistics over numbers you bring (compute the per-group aggregates first with a pipeline), answered at once. plan: the sample size, or the MDE at a given n, before the test runs. check_split: the sample-ratio-mismatch χ² guardrail — p < 0.001 means randomization or logging is broken and the result is invalid, so run it before trusting any lift. analyze: the significance test on per-group stats (proportion → two-proportion z-test; mean → Welch t-test; ratio → delta method; cuped → variance reduction) — lift with its CI, p-value, significance and a multiplicity-adjusted p per variant; sequential: true adds an always-valid p for peeking at a live test. The names are exact: baseline (not baseline_rate), confidence (not alpha), and the expected split is check_split\'s expected_ratio. Example: {action:"analyze",metric:"proportion",control:{n:5000,conversions:500},variants:[{label:"variant_b",n:5020,conversions:580}],correction:"holm"}.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    view: 'result',
    cardField: 'card',
    run: (engine, input) => engine.experiment(input),
  }),
  defineTool({
    name: 'explore_errors',
    output: OUTPUTS.explore_errors,
    title: 'Explore Errors',
    description: 'Read the failures this server kept, to find out why something did not work: a call refused or failed (with its arguments), a task that ended in an error (what dbt or the warehouse said), and what the last start could not serve (the project\'s semantic layer, a join it leaves out, a feature that cannot run). Use it when an error\'s message does not explain it, or to learn why the overview lists something as unavailable. An empty request gives the newest 20 with a summary; the fields narrow them, and { id } gives one in full. It changes nothing.',
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
