// THE RETENTIONEERING FEATURE — path analysis (retentioneering 5.x, Apache-2.0) as a side of its own,
// switched on with MCP_RETENTIONEERING=on (src/features.js) and absent otherwise.
//
//   build_retentioneering_model    the DATA: an eventstream declared by the caller and built in SQL
//                                  (src/retentioneering/eventstream.js), materialized → a task
//   query_retentioneering_model    the COMPUTATION: the analyses of one call run together as ONE dbt
//                                  Python model over that table (python/retentioneering_model.py) —
//                                  on DuckDB in the dbt process, on BigQuery on the warehouse runtime
//                                  (Colab Enterprise via bigframes) → a task; { task_ids } reads it back
//   display_retentioneering_result the SHOW: one analysis of a finished task drawn as a card, once
//
// Heavy work never runs in this server: a call starts a task and returns its id, the warehouse
// computes, and what comes back is a small result table. The feature has its own dbt environment
// (`retentioneering`, src/dbt/environment-specs.js), so the core's dbt and the python stage are
// untouched by it. Everything is deterministic: a hashed user sample, ordered rows, the library's
// fixed seeds.
//
// This file is the feature (its definition, its tools' dispatch) and a build's start; the rest by
// concern: build-input.js (a build's input checked), steps.js (the steps, checked by the library, and
// their materialize), query.js (the analyses and a task read back), display.js (the card), contexts.js,
// names.js — besides schema.js, eventstream.js, python.js, checker.js, results.js, view-model.js, guide.js.

import { join } from 'node:path';
import { createDbt, dbtFailure } from '../dbt/index.js';
import { ToolError } from '../validate.js';
import { READ_PAGE } from '../schema/fields.js';
import { buildSchema, querySchema, displaySchema, deleteSchema, retentioneeringFacts, pathSources, analysisKinds, offeredOps, COMPLEX_EVENT_LOGIC } from './schema.js';
import { renderEventstream } from './eventstream.js';
import { LibraryChecker } from './checker.js';
import { retentioneeringViewModel, RETENTIONEERING_VIEW_URI } from './view-model.js';
import { readView } from './results.js';
import { retentioneeringGuide, GUIDE_NAME, ROUTING_TRIGGERS, INSTRUCTIONS_LINE, retentioneeringSkill } from './guide.js';
import { SIDE, BUILD, QUERY, DISPLAY } from './names.js';
import { contextFor, pathContext, basePaths } from './contexts.js';
import { validateStart, checkStepPlaces, precheckPlaces } from './build-input.js';
import { summarizeEventstream, shapeOf, editSteps, preview, fork, materializeSteps, deleteEventstream } from './steps.js';
import { columnsFrom, pathHint, eventstreamOf, query, KEPT_ROWS } from './query.js';
import { drawnAlready, display } from './display.js';
export { SIDE };

export const TOOL_DESCRIPTIONS = {
  [BUILD]: `Build and shape the eventstream a path analysis reads, step by step like a pipeline. start (the default) declares it and builds it in SQL where the data lives: the rows of an events source within a window, or of the table a build_model pipeline made (from_task) — then the columns that are the event, the path and the segments; optional sessions, a deterministic sample, a top N of events. ${COMPLEX_EVENT_LOGIC} It returns a task_id; query_retentioneering_model({ request: { task_ids } }) returns its summary — users, events, the vocabulary with counts, each segment\'s levels. Then shape the paths with the library\'s own steps (filter_paths, collapse_events, truncate_paths, split_sessions, add_segment, add_clusters, …): add_steps checks each one with the library itself on what the eventstream holds at that point and answers at once — refused with the library\'s message, or each step with what it changed (the events, path columns and segments) — so fix a step when it is refused rather than waiting for a run. edit_step / insert_step / delete_step / truncate re-check every step after; fork tries a variant in a new eventstream; preview lists the steps; materialize runs them on the warehouse (a task), and the analyses read the eventstream as materialized. Use it for paths and sequences: what users do after an event, where they drop off, which transitions dominate, what kinds of paths there are. For a metric over time or a one-off table of numbers, use build_model.`,
  [QUERY]: `Run retentioneering over a built eventstream (as materialized: its steps included), or read a task back. { context_id, eventstream, analyses: [...] } checks the analyses with the library itself on what the eventstream holds — refused at once, with its message — and starts ONE task that computes every listed analysis together in the warehouse (one run for all of them, so list what the question needs in one call). Each analysis is a library method with its own parameters, under the library\'s names: transition_graph (which event follows which, every weight at once), step_matrix / step_sankey (the share of paths at each event step by step, optionally around an anchor), funnel, cluster_analysis (groups of similar paths), segment_overview, conversion_rate, metric_distribution, path_metrics, describe; diff compares two segment levels. The paths are shaped by the eventstream\'s own steps (build_retentioneering_model add_steps), not here: a variant is a fork of it. It returns a task_id at once. { task_ids: [id] } waits up to 30s and returns, for each task, a page of each analysis\'s tables — ${READ_PAGE} rows from offset (a row number, 0 the first) unless limit says, the biggest first: transitions by count, events by their share at each step, metrics by how far they set the groups apart — with what it computes beyond rows (each group\'s profile); { task_ids, cancel: true } stops it. Event names are the eventstream\'s own (as its start named them, and after its steps).`,
  [DISPLAY]: 'Draw one analysis of a finished query_retentioneering_model task as a card for the person — { task_id, display: { analysis, title?, edge_weight? } } — the transition graph, a step matrix heatmap, a step sankey, a funnel, the clusters, a segment overview, a distribution\'s histogram, or a diff\'s heatmaps — in hosts that render MCP Apps. Other analyses (describe, conversion_rate, path_metrics) have no card: answer them in words from the read. Once per analysis: a second call for the same one is refused. Read the task first (query_retentioneering_model({ request: { task_ids } })) to know what it found; draw the analysis the person should see before summarising it. These cards are the one picture of paths and transitions — for an eventstream built from a pipeline table (from_task) as for one from a source — so there is no need to draw a diagram of your own.',
};

// ── the feature definition (src/features.js) ────────────────────────────────────────────────────

export const retentioneeringDefinition = {
  id: 'retentioneering',
  flag: 'MCP_RETENTIONEERING',
  resolve({ env, catalog, profilesDir, baseProjectDir }) {
    if (!pathSources(catalog).length) return { reason: 'no events source declares a relationship to the users model, so no path has an owner' };
    if (!baseProjectDir) return { reason: 'no dbt project (DBT_BASE_PROJECT) to build the eventstreams in' };
    let runner;
    try {
      runner = createDbt({ version: 'auto', environment: env.MCP_RETENTIONEERING_ENV || 'retentioneering', profilesDir, timeout: (Number(env.DBT_TIMEOUT_SECONDS) || 3600) * 1000 });
    } catch (e) {
      return { reason: `its dbt environment is not usable: ${e?.message || e} (npm run dbt:env -- create retentioneering)` };
    }
    if (!runner.pythonModelsOn(catalog.dialect)) return { reason: `the feature's dbt runs no Python models on ${catalog.dialect}` };
    let operatorConfig = {};
    if (env.MCP_RETENTIONEERING_MODEL_CONFIG) {
      try { operatorConfig = JSON.parse(env.MCP_RETENTIONEERING_MODEL_CONFIG); } catch { return { reason: 'MCP_RETENTIONEERING_MODEL_CONFIG is not valid JSON' }; }
    }
    return { feature: createRetentioneeringFeature({ runner, operatorConfig }) };
  },
};

/**
 * The feature over a dbt client of its own. Tests build it directly with their runner; the server
 * resolves it from the environment (retentioneeringDefinition.resolve).
 */
export function createRetentioneeringFeature({ runner, operatorConfig = {}, keptRows = KEPT_ROWS } = {}) {
  if (!runner) throw new Error('the retentioneering feature needs its dbt client (the `retentioneering` environment)');
  const feature = {
    id: 'retentioneering',
    runner,
    operatorConfig,
    keptRows,
    // the library's own check of every step and analysis, on the environment's own interpreter (the
    // client's pythonBin is MetricFlow's)
    checker: new LibraryChecker(runner.environment?.dir ? join(runner.environment.dir, 'bin', 'python') : null),
    tools: {
      [BUILD]: {
        title: 'Build Retentioneering Model',
        description: TOOL_DESCRIPTIONS[BUILD],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        side: SIDE,
        // `project` (the dbt project's own layer) when the engine passes it: the one expression's refs name its semantic models
        schema: (catalog, opts) => buildSchema(catalog, opts),
        run: (engine, input) => build(engine, feature, input),
      },
      [QUERY]: {
        title: 'Query Retentioneering Model',
        description: TOOL_DESCRIPTIONS[QUERY],
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        side: SIDE,
        reads: SIDE,
        waits: true,
        schema: () => querySchema(),
        run: (engine, input) => query(engine, feature, input),
        precheck: (engine, args) => {
          engine.host.validate(QUERY, args);
          for (const id of args.task_ids) engine.tasks.forSide(id, SIDE);
        },
      },
      [DISPLAY]: {
        title: 'Display Retentioneering Result',
        description: TOOL_DESCRIPTIONS[DISPLAY],
        annotations: { readOnlyHint: true, idempotentHint: false },
        draws: true,
        waits: true,
        schema: () => displaySchema(),
        run: (engine, input) => display(engine, feature, input),
        precheck: (engine, args) => {
          engine.host.validate(DISPLAY, args);
          engine.tasks.forSide(args.task_id, SIDE);
          const { analysis } = args.display;
          if (drawnAlready(engine, feature, args.task_id, analysis)) throw new ToolError(`analysis '${analysis}' of task ${args.task_id} is shown already — its card is in the conversation above`, { stage: 'validate', field: 'display.analysis' });
        },
      },
    },
    // what a path-analysis context holds besides itself, removed by delete_context in this form (src/features.js)
    deletes: {
      eventstream: { form: () => deleteSchema(), run: (engine, input) => deleteEventstream(engine, feature, input) },
    },
    view: {
      uri: RETENTIONEERING_VIEW_URI,
      name: 'retentioneering-view',
      title: 'Path Analysis',
      description: 'Card for one path analysis: a transition graph (switch the weight and how many exits per event are shown), a step matrix heatmap, a step sankey, a funnel, the clusters of paths, a segment overview, a distribution\'s histogram or a diff\'s heatmaps.',
      asset: 'retentioneeringView',
      // the drawn result carries what its display asked for (title, edge_weight)
      viewModel: (result) => retentioneeringViewModel(result),
      // what the MODEL reads of a drawn card: the analysis as a read's first page gives it — the card
      // holds every record (the structured copy), and every path's cluster label or a density's thousand
      // points would not fit the conversation
      forModel: (drawn) => (drawn?.result ? { ...drawn, result: readView(drawn.result), note: `The card holds every record; this is the first page a read gives — ${QUERY}({ request: { task_ids, offset, limit } }) pages the rest of each table.` } : drawn),
    },
    guide: { name: GUIDE_NAME, build: () => retentioneeringGuide(), triggers: ROUTING_TRIGGERS },
    skill: () => retentioneeringSkill(),
    instructions: INSTRUCTIONS_LINE,
    close: () => feature.checker.close(),
    // what a path-analysis context holds, for context({ action: list | describe }): null for any other
    describeContext: (engine, ctx) => describePathContext(ctx),
    overview: () => ({
      library: `retentioneering ${retentioneeringFacts().version}`,
      analyses: analysisKinds(),
      steps: offeredOps(),
      note: `Path analysis: ${BUILD} (start, then the library's steps, each checked as it is added; materialize) → ${QUERY} → ${DISPLAY}; semantic_index({ request: { guide: "${GUIDE_NAME}" } }) says which analysis answers which question.`,
    }),
  };
  return feature;
}

/**
 * A path-analysis context as context() shows it: each eventstream — its description, its source (or
 * the task it was started from), what it was forked from, its steps as preview gives them, how far
 * they are materialized and the shape at the end — and how to go on with it. `brief` is the listing's
 * line: the eventstreams by name, with their steps_count. (A context stored before an eventstream kept
 * its own description carries one for the context: shown as it was.)
 */
function describePathContext(ctx) {
  const state = ctx.state?.retentioneering;
  if (!state) return null;
  const eventstreams = Object.entries(state.eventstreams || {}).map(([name, es]) => {
    const p = preview(ctx, name, es);
    return {
      name, source: es.source, ...(es.from_task ? { from_task: es.from_task } : {}), ...(es.forked_from ? { forked_from: es.forked_from } : {}),
      ...(es.description ? { description: es.description } : {}), base: p.base, steps: p.steps, materialized_through: p.materialized_through, ...(p.table ? { table: p.table } : {}), shape: p.shape,
    };
  });
  return {
    engine: SIDE,
    ...(state.description ? { description: state.description } : {}),
    eventstreams,
    brief: { ...(state.description ? { description: state.description } : {}), eventstreams: eventstreams.map((e) => ({ name: e.name, ...(e.description ? { description: e.description } : {}), source: e.source, steps_count: e.steps.length, materialized_through: e.materialized_through })) },
    continue_with: `${BUILD}({ request: { action: 'preview' | 'add_steps' | 'materialize' | 'fork', context_id: '${ctx.id}', eventstream } }) shapes an eventstream; ${QUERY}({ request: { context_id: '${ctx.id}', eventstream, analyses } }) runs analyses over it; delete_context({ request: { what: 'eventstream', context_id: '${ctx.id}', eventstream } }) removes one.`,
  };
}

// ── build ─────────────────────────────────────────────────────────────────────────────────────

/** A build: `start` declares the eventstream in SQL (the default); the other actions shape it with the
 *  library's steps, a draft like a pipeline's, each step checked by the library itself as it is added. */
async function build(engine, feature, input) {
  // each step at its place, said before the schema lists the forms: a start takes none, the steps added
  // after it are the library's own (src/retentioneering/build-input.js)
  precheckPlaces(input, input?.action || 'start');
  engine.host.validate(BUILD, input);
  checkStepPlaces(engine.catalog, input, input.action || 'start');
  return buildAction(engine, feature, input, input.action || 'start');
}

async function buildAction(engine, feature, input, action) {
  if (action === 'start') return start(engine, feature, input);
  const ctx = pathContext(engine, input.context_id);
  if (action === 'fork') return fork(engine, ctx, input);
  const name = eventstreamOf(ctx, input.eventstream).name;
  const es = ctx.state.retentioneering.eventstreams[name];
  if (action === 'preview') return preview(ctx, name, es);
  if (action === 'materialize') return materializeSteps(engine, feature, ctx, name, es);
  return editSteps(engine, feature, ctx, name, es, action, input);
}

/**
 * An eventstream is read from rows of events, so a task it starts from is one of the PIPELINE side: a
 * build's table (or a read of it stored with materialize). A task of the semantic side is refused before
 * anything is looked up — a semantic layer's build holds metrics, not rows, and a metric query's result
 * holds them aggregated (one row per group, not per event) — with the way to the events it meant.
 */
function refuseSemanticTask(engine, taskId) {
  const job = engine.jobs.get(taskId);
  if (!job || engine.tasks.sideOf(job.tool) !== 'semantic') return;
  throw new ToolError(`task ${taskId} is of a semantic layer — its metrics are queried with query_model, and what a metric query stores is aggregated, one row per group, not one per event. An eventstream reads events: start it from the source itself (source, with steps), or from the task of a build_model pipeline whose table holds one row per event (its stages materialized, no semantic_model step)`, { stage: 'validate', field: 'from_task' });
}

async function start(engine, feature, input) {
  // a task's stored table (a pipeline build) as the rows — found, and checked to be there, the way a
  // pipeline started from a task finds it; the source is then what its steps read properties and
  // relationships of. A semantic task is no such table (refuseSemanticTask).
  if (input.from_task) refuseSemanticTask(engine, input.from_task);
  const found = input.from_task ? engine.host.taskBase({ from_task: input.from_task, source: input.source }) : null;
  const spec = validateStart(engine.catalog, found ? { ...input, source: found.source } : input);
  // the source's real columns, as a pipeline's are grounded: a column is compared in the type the
  // warehouse stores it in (a flag kept as text as text)
  const physicalCols = found ? null : await engine.host.grounding(spec.source, []);
  const timeConditions = found ? null : engine.host.timeRangeConditions(spec.source, spec.time_range);
  // the catalog's cost guardrail, as a pipeline applies it: an eventstream over the whole history
  // of a source that requires a window would scan every partition (a task's table was bounded by
  // the pipeline that built it)
  if (!found && !timeConditions && engine.catalog.requireTimeRangeFor(spec.source)) {
    throw new ToolError(`source '${spec.source}' requires a bounded time window (require_time_range): pass time_range { start, end } — the eventstream is scanned only within it`, { stage: 'validate', field: 'time_range' });
  }
  const ctx = contextFor(engine, input);
  const state = ctx.state.retentioneering;
  // a table of its own for every start: a later start of the same name makes a new one, so a fork of
  // the earlier eventstream (and that build's task) keep reading the rows they were made from
  state.builds = (state.builds || 0) + 1;
  const modelName = `rete_es${state.builds}_${spec.name}_${ctx.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  let rendered;
  try {
    rendered = renderEventstream(engine.catalog, spec, { modelName, physicalCols, timeConditions, from: found ? { model: found.base.model, columns: found.base.columns } : null });
  } catch (e) {
    // a refused start leaves nothing behind: a context it made for itself goes with it
    if (!input.context_id) engine.ctxs.drop(ctx.id); else state.builds -= 1;
    throw e instanceof ToolError ? e : new ToolError(e?.message || String(e), { stage: 'validate' });
  }
  if (found) engine.host.holdTaskBase(ctx, found.base);
  const paths = basePaths(spec);
  // a later start of the same name replaces the eventstream, its steps with it
  const es = {
    model: modelName, source: spec.source, ...(found ? { from_task: found.base.task_id } : {}), ...(input.description ? { description: input.description } : {}), spec: input, columns: rendered.columns, segments: rendered.segments, sessions: !!spec.sessions, summary: null,
    base: { model: modelName, task_id: null, summary: null, shape: null },
    steps: [], checkpoint: null,
  };
  state.eventstreams[spec.name] = es;
  engine.ctxs.writeModel(ctx.id, modelName, `${engine.host.modelConfigLine('table')}\n${rendered.sql}\n`);
  engine.ctxs.touch(ctx.id);
  const id = engine.tasks.start(ctx, BUILD, async (taskId) => {
    const dir = engine.ctxs.dir(ctx.id);
    const run = await feature.runner.run(dir, modelName);
    if (!run.ok) return dbtFailure('build', run, 'the eventstream did not build');
    const summary = await summarizeEventstream(feature.runner, dir, modelName, { segments: rendered.segments, paths, spec, dialect: engine.catalog.dialect });
    if (summary.ok === false) return summary;
    // the eventstream this task built — unless a later start of the same name replaced it meanwhile
    const now = ctx.state.retentioneering.eventstreams[spec.name];
    if (now?.base.task_id === taskId) {
      now.base.summary = summary;
      now.base.shape = shapeOf(summary, paths, []);
      if (now.model === modelName) now.summary = summary;
    }
    (ctx.state.retentioneering.tables ||= {})[modelName] = { eventstream: spec.name, summary };
    engine.ctxs.touch(ctx.id);
    return {
      ok: true, kind: 'eventstream', context_id: ctx.id, eventstream: spec.name, ...(found ? { from_task: found.base.task_id } : { source: spec.source }), model: modelName,
      columns: rendered.columns,
      // the eventstream's own column names are the library's; which column of the rows each one is
      columns_from: columnsFrom(engine.catalog, spec),
      ...summary,
      ...(pathHint(engine.catalog, spec) ? { path_hint: pathHint(engine.catalog, spec) } : {}),
      next: `Run the analyses the question needs in ONE call: ${QUERY}({ request: { context_id: '${ctx.id}', eventstream: '${spec.name}', analyses: [{ kind: 'transition_graph' }, { kind: 'step_matrix' }, …] } }) — or shape the paths first with the library's steps: ${BUILD}({ request: { action: 'add_steps', context_id: '${ctx.id}', eventstream: '${spec.name}', steps: [{ type: … }] } }), each checked at once, then materialize.`,
    };
  }, { input });
  es.base.task_id = id;
  engine.jobs.setTable(id, modelName);
  return engine.tasks.started(id, { context_id: ctx.id, eventstream: spec.name });
}
