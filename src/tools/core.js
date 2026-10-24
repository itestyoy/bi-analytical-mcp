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
    description: `Explore the catalog: what the data means, its real values, coverage and freshness. Use it while you do not yet know which events, properties or attributes answer the question — not again for fields already established. An empty request gives the overview (models, events, recipe ids, index freshness). Views: { source } — its columns, relationships, amounts and required filters; { source, event } — the event's properties; { source, column } / { source, property } — meaning, values, NULL coverage; { search } — by word, typos tolerated; { recipe }; { guide: true } — which tool fits; { guide: "research" } — how to investigate; { bundle }; { notes: true }; { status } / { run }; { views: [...] } — several at once. ${SELF_REFUSAL_TOOL}`,
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.semantic_index(input),
  }),
  defineTool({
    name: 'build_model',
    title: 'Build Model',
    description: 'Build what a question is answered from, step by step: a table whose rows are the answer (funnels via match_recognize, sessions, windows, pivots) or, as the last step, a semantic layer of named metrics ({ stage: "semantic_model", measures, metrics, join? }) queried many ways with query_model. Each step is checked as it is added and answered with what it changed (include: ["columns", "steps"] for the full shape); the warehouse runs only on materialize (or materialize: true), which returns a task_id. A recipe\'s payload is a start request as it stands. A join names a model\'s join contract ({ source, on }). from_task builds on a finished task\'s stored table. A python stage, where offered, carries its own rules.'
      + ` Examples: ${callText(EXAMPLES.build_model[0])}; a semantic layer: ${callText(EXAMPLES.build_model[1])} — its metric is queried by its own name, events. Each → { task_id }, read with query_model({ request: { task_ids } }).`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (engine, input) => engine.build_model(input),
  }),
  defineTool({
    name: 'query_model',
    title: 'Query Model',
    description: `Query a context, or read its tasks back. A query is its steps. With a metrics step ({ stage: "metrics", metrics, group_by }) it is a metric query over a semantic layer (a build's semantic_model step, or one of the dbt project's own semantic models — contexts of their names, listed in semantic_index's project_semantic_layer): where steps before it filter the rows; read steps after it (where, compute, aggregate, pivot, unpivot, order_by, limit, sample, project) work on its result, naming a group_by item as group_by does and a metric as { metric }. Without a metrics step it reads build_model's table with the same read steps. A join, unnest, funnel or python step is a build_model step. Returns { task_id } at once (dry_run: true — the task holds its SQL). { task_ids } waits up to ${MAX_WAIT_SECONDS}s and returns a page of each result: ${READ_PAGE} rows from offset unless limit says; a query keeps its first limit rows (${KEPT_ROWS} by default), materialize: true stores every row. Independent queries go in one call ({ queries: [...] }). { task_ids, cancel: true } stops tasks. Examples: ${callText(EXAMPLES.query_model[0])}; a built table: ${callText(EXAMPLES.query_model[1])}.`,
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
    description: 'Only for a host that renders MCP Apps: show a finished model result (a metric query or a pipeline) to the person as a card — chart, KPI tiles, funnel, sankey, drill-down pivot. Use it once, for the result the person should see; each task is drawn once, and a running task is refused. An experiment draws its own card (card: true).',
    // draws a card, once per task: a second call is refused, not repeated
    annotations: { readOnlyHint: true, idempotentHint: false },
    view: 'result',
    appsOnly: true,
    resultCard: true,
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
    resultCard: true,
    run: (engine, input) => engine.drill_result(input),
  }),
  defineTool({
    name: 'context',
    output: OUTPUTS.context,
    title: 'Manage Contexts',
    description: 'The contexts build_model creates: action:"list" — a page of them, most recent first (offset, search); action:"describe" — one context: its steps, tasks and, where it holds a semantic layer, that layer as dbt parsed it (status, issues, semantic models, each metric with its meta and its group_by as query_model takes it). Use it before querying a metric you do not know; metric / semantic_model narrow it. validate: true checks the layer on the warehouse instead (a task, read with query_model). action:"delete" removes a context (what:"context", the default), its pipeline model (what:"pipeline_model") or one model\'s additions (what:"semantic_model", cascade also removes the metrics on them); it cannot be undone, a context another draft reads from is kept unless force is set, and the dbt project\'s own semantic models cannot be removed.',
    // list / describe read; delete removes a context or what it holds — done once, then there is nothing left to remove
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: (engine, input) => engine.context(input),
  }),
  defineTool({
    name: 'memory',
    output: OUTPUTS.memory,
    title: 'Use Memory',
    description: 'Durable analyst memory: save a non-obvious finding (a vague request tracked down to a real field, a gotcha, a useful source) so it comes back through semantic_index. action:"record" saves notes, one finding each: the question it answers, what it is about (as semantic_index addresses it: { source }, { source, event }, { source, column }, { source, property }, or { term }), the user\'s words and an English alias, links. action:"forget" removes one by id. Reading is semantic_index\'s ({ search }, { notes: true }, the views of what a note is about).',
    // it writes: record saves a finding, forget removes one — reading is semantic_index's, which asks nothing
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: (engine, input) => engine.memory(input),
  }),
  defineTool({
    name: 'experiment',
    title: 'A/B Experiment Toolkit',
    description: 'A/B test statistics over per-group numbers you bring (compute them with a pipeline first), answered at once. plan: sample size, or MDE at a given n. check_split: sample-ratio-mismatch χ² — p < 0.001 means the split is broken; run it before trusting a lift. analyze: proportion → z-test, mean → Welch t-test, ratio → delta method, cuped → variance reduction; lift with CI, p-value and a multiplicity-adjusted p per variant; sequential: true adds an always-valid p. Example: {action:"analyze",metric:"proportion",control:{n:5000,conversions:500},variants:[{label:"variant_b",n:5020,conversions:580}],correction:"holm"}.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    view: 'result',
    cardField: 'card',
    run: (engine, input) => engine.experiment(input),
  }),
  defineTool({
    name: 'explore_errors',
    output: OUTPUTS.explore_errors,
    title: 'Explore Errors',
    description: 'Read the failures this server kept: calls refused or failed (with arguments), tasks that ended in an error (what dbt or the warehouse said), what the last start could not serve. Use it when an error message does not explain itself, or to learn why the overview lists something as unavailable. An empty request gives the newest 20 with a summary; include: ["details"] gives each in full, { id } one with everything that reproduces it.',
    // reads the error log; writes nothing
    annotations: { readOnlyHint: true, idempotentHint: true },
    run: (engine, input) => engine.explore_errors(input),
  }),
];

/** The core tools by name — what a surface without an engine (a result's card, a test) consults. */
export const CORE_BY_NAME = new Map(CORE_TOOLS.map((t) => [t.name, t]));
