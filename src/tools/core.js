// THE CORE TOOLS — one definition each (src/tools/define.js). A tool's input schema is built with the
// others from the catalog (src/schema.js, by the tool's name); everything else about it is here.
//
// WHICH SIDE A TASK BELONGS TO (`side`) — and so which query tool reads it back (`reads`). A semantic
// task (a declared model being parsed, a metric query) and a pipeline task (a build, a read of a built
// table) are both read with query_model({ request: { task_ids } }). An experiment is no task at all: its
// statistics come back with its call.

import { MAX_WAIT_SECONDS } from '../schema.js';
import { READ_PAGE, KEPT_ROWS } from '../schema/fields.js';
import { SELF_REFUSAL_TOOL } from '../self-refusal.js';
import { defineTool } from './define.js';
import { OUTPUTS } from '../schema/outputs.js';

/**
 * ONE MINIMAL CALL PER TOOL THAT TAKES THE GRAMMAR (a list where a tool has two kinds of call), written into its description — a host that cuts a
 * schema down (Codex compacts one past 5,000 bytes to its skeleton) still hands the model its
 * description, and a model writes a call best from one it has seen. A name only the catalog knows is a
 * `<placeholder>`; test/unit/tool-examples.test.js fills each from the catalog and validates the call.
 */
export const EXAMPLES = {
  build_model: [
    { action: 'start', name: 'per_event', source: '<events source>', steps: [{ stage: 'aggregate', group_by: ['<event-name column>'], measures: [{ name: 'n', expr: { fn: 'count' } }] }], materialize: true },
    { action: 'start', name: 'activity', source: '<events source>', steps: [{ stage: 'semantic_model', measures: [{ name: 'events', expr: { fn: 'count' } }], metrics: [{ name: 'events', type: 'simple', measure: 'events' }] }], materialize: true },
  ],
  query_model: [
    { context_id: '<context_id>', steps: [{ stage: 'metrics', metrics: ['events'], group_by: [{ time: 'metric_time', grain: 'day' }] }], time_range: { start: '2026-01-01', end: '2026-01-31' } },
    { context_id: '<context_id>', steps: [{ stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }] }, { stage: 'limit', limit: 10 }] },
  ],
};

/** An example as the descriptions write a call: its JSON, keys unquoted. */
export const callText = (value) => JSON.stringify(value).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1: ').replace(/,(?=\S)/g, ', ');

export const CORE_TOOLS = [
  defineTool({
    name: 'semantic_index',
    title: 'Explore Semantic Index',
    description: `Explore the catalog: what the data means, its real values, how complete and fresh it is. Use it before building anything while you do not yet know which events, properties or attributes answer the question, or when a field's meaning or values are unclear — not again for fields already established in the conversation. An empty request gives the overview (models, events, which event marks install / session / purchase, value-index freshness, recipe ids). One view drills in: { source } — one source's columns with sample values, relationships and aggregatable amounts; { source, event } — the properties that event carries; { source, column } — one column of a model: its meaning, value distribution and NULL coverage; { source, property } — one event property's, with its coverage per event; { search } — events, properties, values, recipes and notes by word, typos tolerated; { recipe } — one ready-made recipe; { guide: true } — which tool fits which question; { guide: "research" } — how to run an investigation; { bundle } — which properties one app fills; { notes: true } — the saved findings; { status } / { run } — index sync state; { views: [...] } — several drill-ins at once. The source is always named: each owns its events and payload. ${SELF_REFUSAL_TOOL}`,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.semantic_index(input),
  }),
  defineTool({
    name: 'build_model',
    title: 'Build Model',
    description: 'Build what a question is answered from, step by step: a table whose rows are the answer — funnels (match_recognize), sessions, window functions, pivots — or, as the last step, a semantic layer of reusable named metrics ({ stage: "semantic_model", measures, metrics, join? }) over the build\'s source or the table the steps before it built, queried many ways with query_model (group_by, grain, filters): DAU, revenue, a ratio of two counts. Each step is a stage ({ stage: "where" | "compute" | "join" | …, … }), checked as it is added and answered with what it changed (include: ["columns", "steps"] adds every column the next step sees and every step); nothing runs in the warehouse until materialize (or materialize: true beside the steps), which returns a task_id. A recipe\'s payload is a start request as it stands. query_model reads the rows ({ task_ids }), filters or regroups a built table ({ context_id, steps }), and computes the metrics of a semantic layer (a metrics step). A join names a model\'s join contract ({ source, on }), and joins stack. start with from_task builds on the stored table of a finished task without recomputing it. Where the warehouse runs Python, a python stage is offered; its own description holds its rules.'
      + ` Examples: ${callText(EXAMPLES.build_model[0])}; a semantic layer: ${callText(EXAMPLES.build_model[1])} — its metric is queried by its own name, events. Each → { task_id }, read with query_model({ request: { task_ids } }).`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (engine, input) => engine.build_model(input),
  }),
  defineTool({
    name: 'query_model',
    title: 'Query Model',
    description: `Query a context, or read its tasks back. A query is its steps. With a metrics step ({ stage: "metrics", metrics, group_by }) it is a metric query over the metrics a build's semantic_model step declared (or one of the dbt project's own semantic models): where steps before it filter the rows its metrics fold; read steps after it (where, compute, aggregate, pivot, unpivot, order_by, limit, sample, project) work on its result — a group_by item named there as group_by names it, a metric as { metric }, a column made there by its name; a where there filters the result (a having). Without a metrics step it reads the table build_model built with the same read steps. Joins are applied for you: group or filter a metric by a model's column { source, column } and the declared key is used — for a slowly-changing model the version valid at each row's time; an event property { source, property } once the semantic_model step declares it among its dimensions. A join, unnest, funnel or python step makes a new table: build_model (from_task starts from a stored result). It is checked in the call and returns { task_id } at once; dry_run: true answers with its SQL instead of its rows. { task_ids } waits up to ${MAX_WAIT_SECONDS}s and returns a page of each result (call again while it is running): ${READ_PAGE} rows from offset — a row number of the result — unless limit says otherwise. A query keeps its first limit rows (${KEPT_ROWS} by default); a metric query's materialize: true stores every row as a table (paged to its last row, a start for a pipeline). Independent queries go in one call ({ queries: [...] }). { task_ids, cancel: true } stops tasks. Each of the dbt project's own semantic models is a context named after it. Examples: ${callText(EXAMPLES.query_model[0])}; a built table: ${callText(EXAMPLES.query_model[1])}.`,
    // every call starts or reads a task; a metric query's materialize:true stores its result — a write, never a removal
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    reads: ['semantic', 'pipeline'],
    waits: true,
    precheck: (engine, args) => { for (const id of args.task_ids) engine.tasks.forSide(id, ['semantic', 'pipeline']); },
    run: (engine, input) => engine.query_model(input),
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
    description: 'Read the isolated contexts that build_model creates: action:"list" gives a page of contexts, the most recently used first, each with the description its build gave (offset pages through them, search narrows them — the server keeps every conversation\'s); action:"describe" gives one context in depth — its steps and tasks and, where it holds a semantic layer (one of the dbt project\'s own semantic models, or a build\'s semantic_model step), that layer as dbt parsed it: its status and issues, each semantic model, each metric (type, meta — the notes on reading it — filter, definition) with its group_by spelled as query_model takes it. Use it before querying a metric you do not know. metric narrows it to one metric in full, semantic_model to one model; validate: true checks the layer on the warehouse instead — MetricFlow compiles each metric, and with a time_range the warehouse runs each one and each model\'s dimensions, naming what fails; that is a task, read with query_model. It changes nothing; to remove a context or a model in it, use delete_context.',
    // list / describe read the contexts (validate starts a task that compiles and runs metrics, writing
    // nothing); removing is delete_context
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.context(input),
  }),
  defineTool({
    name: 'delete_context',
    output: OUTPUTS.delete_context,
    title: 'Delete Context',
    description: 'Remove a context build_model created, or part of it: what:"context" (the default) tears the whole context down; what:"pipeline_model" removes its pipeline model and keeps the context; what:"semantic_model" removes one model\'s task additions (cascade also removes the metrics that depend on them). Use it when a workspace is no longer needed or a declaration has to be taken back; it cannot be undone. A context another draft reads a table from is kept unless force is set. The dbt project\'s own semantic models cannot be removed.',
    // removes a context or what it holds: done once, then there is nothing left to remove
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: (engine, input) => engine.delete_context(input),
  }),
  defineTool({
    name: 'memory',
    output: OUTPUTS.memory,
    title: 'Use Memory',
    description: 'Durable analyst memory: save what you found out, so it comes back through semantic_index next time. Use it after resolving something non-obvious — a vague request tracked down to a real field, a gotcha, a useful source. action:"record" saves notes, one finding each, with the business question it answers, the catalog entities it is about (about — each written as semantic_index addresses it: { source }, { source, event }, { source, column } for a model\'s column, { source, property } for an event property, or { term }), the user\'s own words in their language and in English (aliases) and links; several from one study go in one call. A note then appears on the semantic_index views of what it is about and in { search }. Small notes link and match far better than one long one. action:"forget" removes one by id. Reading is semantic_index\'s: { search }, { notes: true }, and the views of what a note is about.',
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
    description: 'Read the failures this server kept, to find out why something did not work: a call refused or failed (with its arguments), a task that ended in an error (what dbt or the warehouse said), and what the last start could not serve (the project\'s semantic layer, a join it leaves out, a feature that cannot run). Use it when an error\'s message does not explain it, or to learn why the overview lists something as unavailable. An empty request gives the newest 20 with a summary; the fields narrow them, include: ["details"] gives each of the page in full, and { id } gives one with everything that reproduces it. It changes nothing.',
    // reads the error log; writes nothing
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.explore_errors(input),
  }),
  defineTool({
    name: 'time',
    output: OUTPUTS.time,
    title: 'Timer',
    description: `Wait for \`seconds\` (at most ${MAX_WAIT_SECONDS}), then return — a timer that touches no data and follows no task. To wait for a task, call its query tool with { task_ids } instead (query_model): it returns the moment the task is done.`,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.time(input),
  }),
];

/** The core tools by name — what a surface without an engine (a result's card, a test) consults. */
export const CORE_BY_NAME = new Map(CORE_TOOLS.map((t) => [t.name, t]));
