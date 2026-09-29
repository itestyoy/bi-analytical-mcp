// THE RETENTIONEERING FEATURE — path analysis (retentioneering 5.x, Apache-2.0) as a side of its own,
// switched on with MCP_RETENTIONEERING=on (src/features.js) and absent otherwise.
//
//   build_retentioneering_model    the DATA: an eventstream declared by the caller and built in SQL
//                                  (src/retentioneering/eventstream.js), materialized → a task
//   query_retentioneering_model    the COMPUTATION: the analyses of one call run together as ONE dbt
//                                  Python model over that table (python/retentioneering_model.py) —
//                                  on DuckDB in the dbt process, on BigQuery on the warehouse runtime
//                                  (Colab Enterprise via bigframes) → a task; { task_id } reads it back
//   display_retentioneering_result the SHOW: one analysis of a finished task drawn as a card, once
//
// Heavy work never runs in this server: a call starts a task and returns its id, the warehouse
// computes, and what comes back is a small result table. The feature has its own dbt environment
// (`retentioneering`, src/dbt/environment-specs.js), so the core's dbt and the python stage are
// untouched by it. Everything is deterministic: a hashed user sample, ordered rows, the library's
// fixed seeds.

import { join } from 'node:path';
import yaml from 'js-yaml';
import { createDbt, formatDbtError } from '../dbt/index.js';
import { ToolError, RESULT_GONE } from '../validate.js';
import { MAX_WAIT_SECONDS } from '../schema.js';
import { rankFuzzy } from '../fuzzy.js';
import { buildSchema, querySchema, displaySchema, retentioneeringFacts, userKeyColumn, pathSources, sourceColumns, ANALYSIS_KINDS, OFFERED_OPS, NAME, COMPLEX_EVENT_LOGIC, RESHAPED } from './schema.js';
import { renderEventstream, pathColumns, ES_COLUMNS, OTHER_EVENT } from './eventstream.js';
import { compileAnalysisModel, compileStepsModel, analysisModelConfig } from './python.js';
import { LibraryChecker } from './checker.js';
import { parseResultRows, summarize } from './results.js';
import { retentioneeringViewModel, RETENTIONEERING_VIEW_URI, hasCard } from './view-model.js';
import { retentioneeringGuide, GUIDE_NAME, ROUTING_TRIGGERS, INSTRUCTIONS_LINE, retentioneeringSkill } from './guide.js';

export const SIDE = 'retentioneering';
const BUILD = 'build_retentioneering_model';
const QUERY = 'query_retentioneering_model';
const DISPLAY = 'display_retentioneering_result';

export const TOOL_DESCRIPTIONS = {
  [BUILD]: `Build and shape the eventstream a path analysis reads, step by step like a pipeline. start (the default) declares it and builds it in SQL where the data lives: which events source and window, which events (kept, dropped, merged into groups, split into new events by a parameter — ad_finished by is_error into ad_finished_failed / ad_finished_success), a filter on the source\'s own columns and event properties or on segments, what to carry as segments (a related model\'s attribute, a column of the source, an event property), optional sessions, a deterministic sample. ${COMPLEX_EVENT_LOGIC} It returns a task_id; query_retentioneering_model({ task_id }) returns its summary — users, events, the vocabulary with counts, each segment\'s levels. Then shape the paths with the library\'s own steps (filter_paths, collapse_events, truncate_paths, split_sessions, add_segment, add_clusters, …): add_step checks each one with the library itself on what the eventstream holds at that point and answers at once — refused with the library\'s message, or what it changed (events, path columns, segments and their levels) — so fix a step when it is refused rather than waiting for a run. edit_step / insert_step / delete_step / truncate re-check every step after; fork tries a variant in a new eventstream; preview lists the steps; materialize runs them on the warehouse (a task), and the analyses read the eventstream as materialized. Use it for paths and sequences: what users do after an event, where they drop off, which transitions dominate, what kinds of paths there are. For a metric over time use build_semantic_model; for a one-off table of numbers, build_pipeline_model.`,
  [QUERY]: 'Run retentioneering over a built eventstream (as materialized: its steps included), or read a task back. { context_id, eventstream, analyses: [...] } checks the analyses with the library itself on what the eventstream holds — refused at once, with its message — and starts ONE task that computes every listed analysis together in the warehouse (one run for all of them, so list what the question needs in one call). Each analysis is a library method with its own parameters, under the library\'s names: transition_graph (which event follows which, every weight at once), step_matrix / step_sankey (the share of paths at each event step by step, optionally around an anchor), funnel, cluster_analysis (groups of similar paths), segment_overview, conversion_rate, metric_distribution, path_metrics, describe; diff compares two segment levels. The paths are shaped by the eventstream\'s own steps (build_retentioneering_model add_step), not here: a variant is a fork of it. It returns a task_id at once. { task_id } (or task_ids) waits up to 30s and returns each analysis summarized — the biggest transitions, the leading events per step, each group\'s profile, the first rows of a table — or, with detail: "full", every record; { task_id, cancel: true } stops it. Event names are the eventstream\'s own (after grouping and its steps).',
  [DISPLAY]: 'Draw one analysis of a finished query_retentioneering_model task as a card for the person — the transition graph, a step matrix heatmap, a step sankey, a funnel, the clusters, a segment overview, a distribution\'s histogram, or a diff\'s heatmaps — in hosts that render MCP Apps. Other analyses (describe, conversion_rate, path_metrics) have no card: answer them in words from the read. Once per analysis: a second call for the same one is refused. Read the task first (query_retentioneering_model({ task_id })) to know what it found; draw the analysis the person should see before summarising it. These cards are the one picture of paths and transitions — for an eventstream built from a pipeline table (from_task) as for one from a source — so there is no need to draw a diagram of your own.',
};

// ── the feature definition (src/features.js) ────────────────────────────────────────────────────

export const retentioneeringDefinition = {
  id: 'retentioneering',
  flag: 'MCP_RETENTIONEERING',
  resolve({ env, catalog, profilesDir, baseProjectDir }) {
    if (!['duckdb', 'bigquery'].includes(catalog.dialect)) return { reason: `path analysis runs on DuckDB or BigQuery, not ${catalog.dialect}` };
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
export function createRetentioneeringFeature({ runner, operatorConfig = {} } = {}) {
  if (!runner) throw new Error('the retentioneering feature needs its dbt client (the `retentioneering` environment)');
  const feature = {
    id: 'retentioneering',
    runner,
    operatorConfig,
    // the library's own check of every step and analysis, on the environment's own interpreter (the
    // client's pythonBin is MetricFlow's)
    checker: new LibraryChecker(runner.environment?.dir ? join(runner.environment.dir, 'bin', 'python') : null),
    sides: { [SIDE]: QUERY },
    tools: {
      [BUILD]: {
        title: 'Build Retentioneering Model',
        description: TOOL_DESCRIPTIONS[BUILD],
        behaviour: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        side: SIDE,
        schema: (catalog) => buildSchema(catalog),
        run: (engine, input) => build(engine, feature, input),
      },
      [QUERY]: {
        title: 'Query Retentioneering Model',
        description: TOOL_DESCRIPTIONS[QUERY],
        behaviour: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        side: SIDE,
        waits: true,
        schema: () => querySchema(),
        run: (engine, input) => query(engine, feature, input),
        precheck: (engine, args) => {
          engine._validate(QUERY, args);
          for (const id of args.task_ids || [args.task_id]) engine._taskForSide(id, SIDE);
        },
      },
      [DISPLAY]: {
        title: 'Display Retentioneering Result',
        description: TOOL_DESCRIPTIONS[DISPLAY],
        behaviour: { readOnlyHint: true, idempotentHint: false },
        draws: true,
        waits: true,
        schema: () => displaySchema(),
        run: (engine, input) => display(engine, feature, input),
        precheck: (engine, args) => {
          engine._validate(DISPLAY, args);
          engine._taskForSide(args.task_id, SIDE);
          if (drawnAlready(engine, args.task_id, args.analysis)) throw new ToolError(`analysis '${args.analysis}' of task ${args.task_id} is shown already — its card is in the conversation above`, { stage: 'validate', field: 'analysis' });
        },
      },
    },
    view: {
      uri: RETENTIONEERING_VIEW_URI,
      name: 'retentioneering-view',
      title: 'Path Analysis',
      description: 'Card for one path analysis: a transition graph (switch the weight and how many exits per event are shown), a step matrix heatmap, a step sankey, a funnel, the clusters of paths, a segment overview, a distribution\'s histogram or a diff\'s heatmaps.',
      asset: 'retentioneeringView',
      viewModel: (result, args) => retentioneeringViewModel(result, args),
    },
    guide: { name: GUIDE_NAME, build: (catalog) => retentioneeringGuide(catalog), triggers: ROUTING_TRIGGERS },
    skill: (engine) => retentioneeringSkill(engine.catalog),
    instructions: INSTRUCTIONS_LINE,
    close: () => feature.checker.close(),
    overview: () => ({
      library: `retentioneering ${retentioneeringFacts().version}`,
      analyses: ANALYSIS_KINDS,
      steps: OFFERED_OPS,
      note: `Path analysis: ${BUILD} (start, then the library's steps, each checked as it is added; materialize) → ${QUERY} → ${DISPLAY}; semantic_index({ guide: "${GUIDE_NAME}" }) says which analysis answers which question.`,
    }),
  };
  return feature;
}

// ── build ─────────────────────────────────────────────────────────────────────────────────────

function suggest(value, known) {
  const near = rankFuzzy(value, known, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => m.item);
  return near.length ? ` — did you mean ${near.map((n) => `'${n}'`).join(', ')}?` : '';
}

function checkEvents(catalog, source, names, field) {
  const known = catalog.eventNames(source);
  if (!known.length) return; // a source that declares no vocabulary: the warehouse decides
  for (const n of names || []) {
    if (!known.includes(n)) throw new ToolError(`'${n}' is not an event of '${source}'${suggest(n, known)}`, { stage: 'validate', field });
  }
}

/** The relationship `source` reaches `model` by — the one declared, or the one the caller named. */
function relationshipTo(catalog, source, model, via) {
  const shared = Object.keys(catalog.entitiesOf(source)).filter((name) => catalog.joinTargetFor(name) === model);
  if (via) {
    if (!shared.includes(via)) throw new ToolError(`'${source}' reaches '${model}' by ${shared.length ? shared.map((n) => `'${n}'`).join(', ') : 'no declared relationship'}, not '${via}'`, { stage: 'validate', field: 'segments.via' });
    return via;
  }
  if (!shared.length) throw new ToolError(`'${source}' declares no relationship toward '${model}', so its attributes cannot be carried onto the events`, { stage: 'validate', field: 'segments.model' });
  if (shared.length > 1) throw new ToolError(`'${source}' reaches '${model}' by several relationships (${shared.join(', ')}) — name the one you mean with via`, { stage: 'validate', field: 'segments.via' });
  return shared[0];
}

function validateBuild(engine, input, physical = null) {
  const c = engine.catalog;
  const { source } = input;
  if (!userKeyColumn(c, source)) throw new ToolError(`'${source}' names no single user key toward the users model, so its events have no path owner`, { stage: 'validate', field: 'source' });
  checkEvents(c, source, input.events?.include, 'events.include');
  checkEvents(c, source, input.events?.exclude, 'events.exclude');
  // a group merges events of the source, or events events.split makes: the names it gives, and for
  // a split by value, <event>_<value> (the value is known only from the data)
  const rules = input.events?.split || [];
  const splitNames = new Set(rules.flatMap((rule) => [...Object.values(rule.names || {}), ...(rule.cases || []).map((cs) => cs.name), ...(rule.else ? [rule.else] : [])]));
  const byValue = rules.filter((rule) => rule.by).map((rule) => `${rule.event}_`);
  const madeBySplit = (e) => splitNames.has(e) || byValue.some((p) => e.startsWith(p));
  for (const [g, evs] of Object.entries(input.events?.groups || {})) {
    if (!new RegExp(NAME).test(g)) throw new ToolError(`group name '${g}' must be lowercase snake_case`, { stage: 'validate', field: 'events.groups' });
    checkEvents(c, source, evs.filter((e) => !madeBySplit(e)), `events.groups.${g}`);
  }
  checkEvents(c, source, Object.keys(input.sample?.events || {}).filter((e) => !madeBySplit(e)), 'sample.events');
  const reserved = new Set(Object.values(ES_COLUMNS));
  const own = sourceColumns(c, source, physical);
  const props = c.scalarEventProps(source);
  // a parameter or condition names a column of the source or one of its scalar event properties
  const checkRef = (ref, field) => {
    if (ref.property !== undefined && !props.includes(ref.property)) throw new ToolError(`'${ref.property}' is not a scalar event property of '${source}'${suggest(ref.property, props)}`, { stage: 'validate', field });
    if (ref.column !== undefined && !own.includes(ref.column)) throw new ToolError(`'${ref.column}' is not a column of '${source}'${suggest(ref.column, own)}`, { stage: 'validate', field });
  };
  (input.events?.split || []).forEach((rule, i) => {
    checkEvents(c, source, [rule.event], `events.split.${i}.event`);
    if (rule.by) checkRef(rule.by, `events.split.${i}.by`);
    for (const cs of rule.cases || []) cs.where.forEach((w) => { checkRef(w, `events.split.${i}.cases.where`); checkBetween(w, `events.split.${i}.cases.where`); });
  });
  // what one path is, when not the user: columns and properties of the source
  (input.path || []).forEach((ref) => checkRef(ref, 'path'));
  const segNames = [];
  const segments = (input.segments || []).map((seg) => {
    let name;
    let out;
    if (seg.column !== undefined) {
      // a column of the source itself: no join
      if (!own.includes(seg.column)) throw new ToolError(`'${seg.column}' is not a column of '${source}'${suggest(seg.column, own)} (its columns: ${own.join(', ') || 'none declared'})`, { stage: 'validate', field: 'segments.column' });
      name = seg.as || seg.column;
      out = { column: seg.column, name };
    } else if (seg.property !== undefined) {
      if (!props.includes(seg.property)) throw new ToolError(`'${seg.property}' is not a scalar event property of '${source}'${suggest(seg.property, props)}`, { stage: 'validate', field: 'segments.property' });
      name = seg.as || seg.property;
      out = { property: seg.property, name };
    } else {
      const dims = c.modelDimensionColumns(seg.model);
      if (!dims.includes(seg.attribute)) throw new ToolError(`'${seg.attribute}' is not an attribute of '${seg.model}'${suggest(seg.attribute, dims)}`, { stage: 'validate', field: 'segments.attribute' });
      name = seg.as || seg.attribute;
      out = { ...seg, name, via: relationshipTo(c, source, seg.model, seg.via) };
    }
    if (reserved.has(name) || segNames.includes(name)) throw new ToolError(`segment name '${name}' is taken — give it another with as`, { stage: 'validate', field: 'segments.as' });
    segNames.push(name);
    return out;
  });
  for (const w of input.where || []) {
    const field = w.property !== undefined ? 'where.property' : 'where.column';
    if (w.property !== undefined) {
      if (!props.includes(w.property)) throw new ToolError(`'${w.property}' is not a scalar event property of '${source}'${suggest(w.property, props)}`, { stage: 'validate', field });
    } else if (!segNames.includes(w.column) && !own.includes(w.column)) {
      const known = [...own, ...segNames];
      throw new ToolError(`where filters on a column of '${source}' or a declared segment — '${w.column}' is neither${suggest(w.column, known)} (columns: ${own.join(', ') || 'none'}; segments: ${segNames.join(', ') || 'none'})`, { stage: 'validate', field });
    }
    const needsValue = !['is_null', 'is_not_null'].includes(w.op);
    if (needsValue && w.value === undefined) throw new ToolError(`where ${w.op} on '${w.column ?? w.property}' needs a value`, { stage: 'validate', field: 'where.value' });
    if (['in', 'not_in'].includes(w.op) && !Array.isArray(w.value)) throw new ToolError(`where ${w.op} takes an array value`, { stage: 'validate', field: 'where.value' });
    if (w.op === 'between' && !(Array.isArray(w.value) && w.value.length === 2)) throw new ToolError('where between takes [low, high] (both included)', { stage: 'validate', field: 'where.value' });
  }
  return { ...input, segments };
}

/** A between condition takes [low, high]. */
function checkBetween(w, field) {
  if (w.op === 'between' && !(Array.isArray(w.value) && w.value.length === 2)) throw new ToolError('between takes [low, high] (both included)', { stage: 'validate', field });
}

/**
 * A build FROM A TASK's stored table (a pipeline build — the place for event logic the build's own
 * rules cannot say: windows, a match_recognize, several sources joined, a cohort). The table has no
 * catalog meaning, so the caller names its path columns, and what the build reads is its columns:
 * a filter, a segment and a split parameter each name one. Payload properties and joined attributes
 * belong in the pipeline that made the table.
 */
function validateTaskBuild(input, base) {
  const have = base.columns.map((c) => c.name);
  const typeOf = new Map(base.columns.map((c) => [c.name, c.type]));
  const known = (col, field) => {
    if (!have.includes(col)) throw new ToolError(`'${col}' is not a column of task ${base.task_id}'s table${suggest(col, have)} (its columns: ${have.join(', ')})`, { stage: 'validate', field });
  };
  if (input.path) throw new ToolError('with from_task the path is named in columns.path (the table\'s own columns), not in path', { stage: 'validate', field: 'path' });
  const { event, time } = input.columns;
  const path = [].concat(input.columns.path);
  path.forEach((col) => known(col, 'columns.path'));
  known(event, 'columns.event'); known(time, 'columns.time');
  if (new Set([...path, event, time]).size < path.length + 2) throw new ToolError('columns.path, columns.event and columns.time name different columns', { stage: 'validate', field: 'columns' });
  const t = String(typeOf.get(time) || 'unknown');
  if (!['time', 'timestamp', 'date', 'datetime', 'unknown'].includes(t)) throw new ToolError(`columns.time '${time}' is a ${t} column — the paths are ordered by a time (a timestamp or a date)`, { stage: 'validate', field: 'columns.time' });
  const noCatalog = (what, field) => { throw new ToolError(`${what} — a task's table carries no catalog meaning: bring it in as a column in the pipeline that made the table (a derive of the property, a join of the attribute), then name that column here`, { stage: 'validate', field }); };
  (input.events?.split || []).forEach((rule, i) => {
    if (rule.by?.property !== undefined) noCatalog(`events.split.${i}.by names the event property '${rule.by.property}'`, `events.split.${i}.by`);
    if (rule.by) known(rule.by.column, `events.split.${i}.by`);
    for (const cs of rule.cases || []) for (const w of cs.where) {
      if (w.property !== undefined) noCatalog(`a case of events.split.${i} names the event property '${w.property}'`, `events.split.${i}.cases.where`);
      known(w.column, `events.split.${i}.cases.where`);
      checkBetween(w, `events.split.${i}.cases.where`);
    }
  });
  const reserved = new Set(Object.values(ES_COLUMNS));
  const segNames = [];
  const segments = (input.segments || []).map((seg) => {
    if (seg.property !== undefined) noCatalog(`the segment names the event property '${seg.property}'`, 'segments.property');
    if (seg.column === undefined) noCatalog(`the segment names ${seg.model}.${seg.attribute}`, 'segments.model');
    known(seg.column, 'segments.column');
    const name = seg.as || seg.column;
    if (reserved.has(name) || segNames.includes(name)) throw new ToolError(`segment name '${name}' is taken — give it another with as`, { stage: 'validate', field: 'segments.as' });
    segNames.push(name);
    return { column: seg.column, name };
  });
  for (const w of input.where || []) {
    if (w.property !== undefined) noCatalog(`where names the event property '${w.property}'`, 'where.property');
    if (!segNames.includes(w.column)) known(w.column, 'where.column');
    const needsValue = !['is_null', 'is_not_null'].includes(w.op);
    if (needsValue && w.value === undefined) throw new ToolError(`where ${w.op} on '${w.column}' needs a value`, { stage: 'validate', field: 'where.value' });
    if (['in', 'not_in'].includes(w.op) && !Array.isArray(w.value)) throw new ToolError(`where ${w.op} takes an array value`, { stage: 'validate', field: 'where.value' });
    if (w.op === 'between' && !(Array.isArray(w.value) && w.value.length === 2)) throw new ToolError('where between takes [low, high] (both included)', { stage: 'validate', field: 'where.value' });
  }
  return { ...input, segments };
}

function contextFor(engine, input) {
  if (!input.context_id) {
    const ctx = engine.ctxs.create();
    ctx.state.retentioneering = { eventstreams: {}, queries: 0, drawn: {} };
    return ctx;
  }
  return pathContext(engine, input.context_id);
}

/** A path-analysis context the call names. */
function pathContext(engine, id) {
  if (!id) throw new ToolError('context_id is needed: the context the eventstream was built in', { stage: 'validate', field: 'context_id' });
  const ctx = engine._ctx(id);
  if (!ctx.state.retentioneering) throw new ToolError(`context '${id}' is not a path-analysis context — build an eventstream with ${BUILD} first (without context_id to start one)`, { stage: 'validate', field: 'context_id' });
  return ctx;
}

/** A build: `start` declares the eventstream in SQL (the default); the other actions shape it with the
 *  library's steps, a draft like a pipeline's, each step checked by the library itself as it is added. */
async function build(engine, feature, input) {
  engine._validate(BUILD, input);
  const action = input.action || 'start';
  if (action === 'start') return start(engine, feature, input);
  const ctx = pathContext(engine, input.context_id);
  if (action === 'fork') return fork(engine, ctx, input);
  const name = eventstreamOf(ctx, input.eventstream).name;
  const es = ctx.state.retentioneering.eventstreams[name];
  if (action === 'preview') return preview(ctx, name, es);
  if (action === 'materialize') return materializeSteps(engine, feature, ctx, name, es);
  return editSteps(engine, feature, ctx, name, es, action, input);
}

/** The path columns an eventstream built in SQL has: the user, and the session when asked for. */
function basePaths(spec) {
  return [ES_COLUMNS.user, ...(spec.sessions?.gap_minutes ? [ES_COLUMNS.session] : [])];
}

async function start(engine, feature, input) {
  // a task's stored table (a pipeline build) as the rows — found, and checked to be there, the way a
  // pipeline started from a task finds it
  const found = input.from_task ? engine._taskBase({ from_task: input.from_task, source: input.source, time_range: input.time_range }) : null;
  // the table's real columns, read once: what a segment or a filter on the source itself may name
  const physicalCols = found ? null : await engine._physicalCols(input.source);
  const spec = found ? { ...validateTaskBuild(input, found.base), source: found.source } : validateBuild(engine, input, physicalCols);
  const ctx = contextFor(engine, input);
  const state = ctx.state.retentioneering;
  const modelName = `rete_es_${spec.name}_${ctx.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const timeConditions = found ? null : engine._timeRangeConditions(spec.source, spec.time_range);
  // the catalog's cost guardrail, as a pipeline applies it: an eventstream over the whole history
  // of a source that requires a window would scan every partition (a task's table was bounded by
  // the pipeline that built it)
  if (!found && !timeConditions && engine.catalog.requireTimeRangeFor(spec.source)) {
    throw new ToolError(`source '${spec.source}' requires a bounded time window (require_time_range): pass time_range { start, end } — the eventstream is scanned only within it`, { stage: 'validate', field: 'time_range' });
  }
  let rendered;
  try {
    rendered = renderEventstream(engine.catalog, spec, { modelName, physicalCols, timeConditions, from: found ? { model: found.base.model, columns: found.base.columns } : null });
  } catch (e) {
    throw new ToolError(e?.message || String(e), { stage: 'validate' });
  }
  if (found) engine._holdTaskBase(ctx, found.base);
  const paths = basePaths(spec);
  // a later start of the same name replaces the eventstream, its steps with it
  const es = {
    model: modelName, source: spec.source, ...(found ? { from_task: found.base.task_id } : {}), spec: input, columns: rendered.columns, segments: rendered.segments, sessions: !!spec.sessions, summary: null,
    base: { model: modelName, task_id: null, summary: null, shape: null },
    steps: [], checkpoint: null,
  };
  state.eventstreams[spec.name] = es;
  if (input.description) state.description = input.description;
  engine.ctxs.writeModel(ctx.id, modelName, `${engine._modelConfigLine('table')}\n${rendered.sql}\n`);
  engine.ctxs.touch(ctx.id);
  const id = engine._startTask(ctx, BUILD, async (taskId) => {
    const dir = engine.ctxs.dir(ctx.id);
    const run = await feature.runner.run(dir, modelName);
    if (!run.ok) return { ok: false, error: { stage: 'build', message: formatDbtError(run.stdout, run.stderr) || run.error || 'the eventstream did not build' } };
    const summary = await summarizeEventstream(feature.runner, dir, modelName, { segments: rendered.segments, paths, spec });
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
      next: `Run the analyses the question needs in ONE call: ${QUERY}({ context_id: '${ctx.id}', eventstream: '${spec.name}', analyses: [{ kind: 'transition_graph' }, { kind: 'step_matrix' }, …] }) — or shape the paths first with the library's steps: ${BUILD}({ action: 'add_step', context_id: '${ctx.id}', eventstream: '${spec.name}', step: { type: … } }), each checked at once, then materialize.`,
    };
  }, { input });
  es.base.task_id = id;
  engine.jobs.setTable(id, modelName);
  return engine._taskStarted(id, { context_id: ctx.id, eventstream: spec.name });
}

/** How many levels of a segment the summary lists in full; a segment with more is known by its count. */
const LEVEL_CAP = 1000;

async function summarizeEventstream(runner, dir, model, { segments, paths, spec }) {
  const ref = `{{ ref('${model}') }}`;
  const sessionCol = paths.includes(ES_COLUMNS.session) ? ES_COLUMNS.session : null;
  const totals = await runner.show(dir, `select count(*) as events, count(distinct ${ES_COLUMNS.user}) as users, count(distinct ${ES_COLUMNS.event}) as names, min(${ES_COLUMNS.time}) as first_event, max(${ES_COLUMNS.time}) as last_event${sessionCol ? `, count(distinct ${sessionCol}) as sessions` : ''} from ${ref}`, 1);
  if (!totals.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(totals.stdout, totals.stderr) || totals.error } };
  const vocab = await runner.show(dir, `select ${ES_COLUMNS.event} as event, count(*) as events, count(distinct ${ES_COLUMNS.user}) as users from ${ref} group by ${ES_COLUMNS.event} order by count(*) desc, ${ES_COLUMNS.event}`, Math.max(Number(totals.rows[0]?.names) || 0, 1));
  if (!vocab.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(vocab.stdout, vocab.stderr) || vocab.error } };
  const levels = await segmentLevels(runner, dir, ref, segments);
  if (levels.ok === false) return levels;
  const t = totals.rows[0] || {};
  return {
    events: Number(t.events) || 0,
    users: Number(t.users) || 0,
    ...(sessionCol ? { sessions: Number(t.sessions) || 0 } : {}),
    period: { first_event: t.first_event ?? null, last_event: t.last_event ?? null },
    segments,
    vocabulary: vocab.rows.map((r) => ({ event: r.event, events: Number(r.events), users: Number(r.users) })),
    ...(segments.length ? { segment_levels: levels } : {}),
    ...(sampleOf(spec) ? { sample: sampleOf(spec) } : {}),
    // a path that is not a user: what one is — its count is under `users` (the library's path owner)
    ...(pathKey(spec) ? { path: pathKey(spec), path_note: `each path is one value of ${pathKey(spec).join(' + ')}: "users" counts paths` } : {}),
  };
}

/** Each segment's levels, with the users on each — all of them up to LEVEL_CAP (`complete`), else
 *  the count alone: what a step, a diff or a level filter may name, known before anything runs. */
async function segmentLevels(runner, dir, ref, segments) {
  if (!segments.length) return {};
  const counts = await runner.show(dir, `select ${segments.map((s) => `count(distinct ${s}) as ${s}`).join(', ')} from ${ref}`, 1);
  if (!counts.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(counts.stdout, counts.stderr) || counts.error } };
  const count = Object.fromEntries(segments.map((s) => [s, Number(counts.rows[0]?.[s]) || 0]));
  const listed = segments.filter((s) => count[s] <= LEVEL_CAP);
  const rows = new Map(segments.map((s) => [s, []]));
  if (listed.length) {
    const sql = listed.map((s) => `select '${s}' as segment, ${s} as level, count(distinct ${ES_COLUMNS.user}) as users from ${ref} where ${s} is not null group by ${s}`).join(' union all ');
    const res = await runner.show(dir, sql, Math.max(listed.reduce((n, s) => n + count[s], 0), 1));
    if (!res.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(res.stdout, res.stderr) || res.error } };
    for (const r of res.rows) rows.get(r.segment)?.push({ level: String(r.level), users: Number(r.users) });
  }
  return Object.fromEntries(segments.map((s) => {
    const list = rows.get(s).sort((a, b) => b.users - a.users || a.level.localeCompare(b.level));
    return [s, { count: count[s], complete: count[s] <= LEVEL_CAP, levels: list.map((l) => l.level), users: list.map((l) => l.users) }];
  }));
}

/** What the library's check and the next step read of an eventstream: its event names, path columns,
 *  segments with their levels (complete or not) and custom columns. */
function shapeOf(summary, paths, columns) {
  return {
    events: (summary.vocabulary || []).map((v) => v.event),
    paths,
    segments: Object.fromEntries((summary.segments || []).map((s) => [s, { levels: summary.segment_levels?.[s]?.levels || [], complete: !!summary.segment_levels?.[s]?.complete }])),
    columns,
  };
}

/** The eventstream's shape once the base is built — waited for (up to the read's wait) when the call
 *  comes right after the start. */
async function builtShape(engine, name, es, ctx) {
  if (!es.base.shape && es.base.task_id) await engine._awaitTask(es.base.task_id, MAX_WAIT_SECONDS);
  // a fork made while its base was building shares the base's table, whose summary is kept by table
  const kept = ctx?.state.retentioneering.tables?.[es.base.model];
  if (!es.base.shape && kept) {
    es.base.summary = kept.summary;
    es.base.shape = shapeOf(kept.summary, basePaths(es.spec), []);
    if (es.model === es.base.model) es.summary = kept.summary;
  }
  if (es.base.shape) return es.base.shape;
  const job = es.base.task_id ? engine.jobs.get(es.base.task_id) : null;
  if (job?.status === 'running') throw new ToolError(`eventstream '${name}' is still being built (task ${es.base.task_id}) — its steps are checked against what it holds, so add them once it is built: ${QUERY}({ task_id: '${es.base.task_id}' }) waits for it`, { stage: 'validate', field: 'eventstream' });
  throw new ToolError(`eventstream '${name}' did not build${job?.error ? ` (${job.error})` : ''} — start it again`, { stage: 'validate', field: 'eventstream' });
}

/** The shape step `k` (1-based) reads: what the materialized steps left when it comes right after
 *  them, else what the step before it left, else the base; null when a step before it was not checked. */
function shapeBefore(es, k) {
  const cp = es.checkpoint;
  if (cp && k === cp.upto + 1) return cp.shape;
  if (k === 1) return es.base.shape;
  return es.steps[k - 2]?.shape || null;
}

/** The shape at the end of the draft. */
function shapeAtEnd(es) {
  return shapeBefore(es, es.steps.length + 1);
}

/** One step in the library's own form: `path` as the library's path column, a reshaped parameter
 *  translated back (RESHAPED). */
function toLibrary(step, field) {
  const { path, ...rest } = step;
  if (path !== undefined && opParams(step.type).has('path_col')) rest.path_col = path === 'users' ? ES_COLUMNS.user : path === 'sessions' ? ES_COLUMNS.session : path;
  for (const [name, r] of Object.entries(RESHAPED)) if (rest[name] != null) rest[name] = r.toLibrary(rest[name], `${field}.${name}`);
  return rest;
}

const NOT_CHECKED = 'not checked: the library\'s own check could not run here — the run itself will say';

/** Steps `from`..end of `view` checked by the library on the shape before `from` → one entry per
 *  step: { step, library, checked, shape | problem | note }. */
async function checkSteps(feature, view, from, fieldOf) {
  const list = view.steps.slice(from - 1);
  const library = list.map((s, i) => toLibrary(s.step, fieldOf(from + i)));
  const entries = list.map((s, i) => ({ step: s.step, library: library[i], checked: false, shape: null }));
  const shape = shapeBefore(view, from);
  if (!shape) {
    entries.forEach((e) => { e.note = `not checked: a step before it (${from - 1}) could not be checked, so what it reads is not known — materialize to know it`; });
    return entries;
  }
  const reply = await feature.checker.check({ shape, steps: library, analyses: [] });
  if (!reply) {
    entries.forEach((e) => { e.note = NOT_CHECKED; });
    return entries;
  }
  let known = true;
  entries.forEach((e, i) => {
    const r = reply.steps[i];
    if (!known || !r) { e.note = 'not checked: a step before it could not be checked'; return; }
    if (r.ok === false) { e.problem = r.problem; known = false; return; }
    if (r.ok === null) { e.note = r.note; known = false; return; }
    e.checked = true;
    e.shape = r.shape;
  });
  return entries;
}

/** A shape as a read shows it: the event names (the first 200), the path columns, each segment's
 *  levels (the first 30) and the custom columns. */
function describeShape(shape) {
  if (!shape) return null;
  return {
    events: shape.events.slice(0, 200), ...(shape.events.length > 200 ? { events_more: shape.events.length - 200 } : {}),
    paths: shape.paths,
    segments: Object.fromEntries(Object.entries(shape.segments).map(([s, l]) => [s, { levels: l.levels.slice(0, 30), ...(l.levels.length > 30 ? { levels_more: l.levels.length - 30 } : {}), ...(l.complete ? {} : { complete: false }) }])),
    ...(shape.columns?.length ? { columns: shape.columns } : {}),
  };
}

/** What a step changed, between the shape it read and the one it left. */
function shapeChange(before, after) {
  if (!before || !after) return null;
  const diff = (a, b) => b.filter((x) => !a.includes(x));
  const out = {
    events_added: diff(before.events, after.events), events_removed: diff(after.events, before.events),
    segments_added: diff(Object.keys(before.segments), Object.keys(after.segments)), segments_removed: diff(Object.keys(after.segments), Object.keys(before.segments)),
    paths_added: diff(before.paths, after.paths), paths_removed: diff(after.paths, before.paths),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v.length));
}

async function editSteps(engine, feature, ctx, name, es, action, input) {
  await builtShape(engine, name, es, ctx);
  const n = es.steps.length;
  const inRange = (i, max, field) => { if (!Number.isInteger(i) || i < 1 || i > max) throw new ToolError(`${field} ${i} is not a step of eventstream '${name}' (it has ${n}${n ? `: 1..${n}` : ''})`, { stage: 'validate', field }); };
  let list = es.steps.slice();
  let from = null;
  let fieldOf = () => 'step';
  if (action === 'add_step') { list.push({ step: input.step }); from = list.length; }
  if (action === 'add_steps') { from = n + 1; list.push(...input.steps.map((step) => ({ step }))); fieldOf = (i) => `steps[${i - from}]`; }
  if (action === 'edit_step') { inRange(input.index, n, 'index'); list[input.index - 1] = { step: input.step }; from = input.index; }
  if (action === 'insert_step') { inRange(input.index, n + 1, 'index'); list.splice(input.index - 1, 0, { step: input.step }); from = input.index; }
  if (action === 'delete_step') { inRange(input.index, n, 'index'); list.splice(input.index - 1, 1); from = input.index; }
  if (action === 'truncate') {
    if (!Number.isInteger(input.after) || input.after < 0 || input.after > n) throw new ToolError(`after ${input.after} is not a step count of eventstream '${name}' (0..${n})`, { stage: 'validate', field: 'after' });
    list = list.slice(0, input.after);
  }
  const upto = es.checkpoint?.upto || 0;
  // a change at or before the materialized steps retires their table (it no longer stands for them)
  const dropped = !!es.checkpoint && (from != null ? from <= upto : list.length < upto);
  const view = { base: es.base, steps: list, checkpoint: dropped ? null : es.checkpoint };
  let checked = [];
  if (from != null && from <= list.length) {
    checked = await checkSteps(feature, view, from, fieldOf);
    const bad = checked.findIndex((e) => e.problem);
    if (bad >= 0) {
      const i = from + bad;
      const which = `step ${i} (${checked[bad].step.type})`;
      const own = action === 'add_step' || action === 'edit_step' || action === 'insert_step' ? i === from : action === 'add_steps';
      throw new ToolError(`${own ? `the library refuses ${which}` : `after this ${action}, the library refuses ${which}`}: ${checked[bad].problem} — nothing changed (the eventstream still has ${n} step${n === 1 ? '' : 's'}). Checked by the library itself on what the eventstream holds at that step; nothing ran.`, { stage: 'validate', field: fieldOf(i) });
    }
    checked.forEach((e, j) => { list[from - 1 + j] = e; });
  }
  es.steps = list;
  if (dropped) { es.checkpoint = null; es.model = es.base.model; es.summary = es.base.summary; }
  engine.ctxs.touch(ctx.id);
  const at = action === 'add_steps' ? n + input.steps.length : action === 'truncate' || action === 'delete_step' ? null : from;
  const entry = at ? es.steps[at - 1] : null;
  const pending = es.steps.length - (es.checkpoint?.upto || 0);
  const unchecked = es.steps.map((s, i) => (s.checked ? null : i + 1)).filter(Boolean);
  return {
    ok: true, context_id: ctx.id, eventstream: name, action, steps: es.steps.length,
    ...(entry ? { step: { index: at, type: entry.step.type, checked: entry.checked, ...(entry.note ? { note: entry.note } : {}) } } : {}),
    ...(action === 'add_steps' ? { added: checked.map((e, j) => ({ index: from + j, type: e.step.type, checked: e.checked, ...(shapeChange(shapeBefore(view, from + j), e.shape) ? { changed: shapeChange(shapeBefore(view, from + j), e.shape) } : {}) })) } : {}),
    ...(entry && shapeChange(shapeBefore(es, at), entry.shape) ? { changed: shapeChange(shapeBefore(es, at), entry.shape) } : {}),
    shape: describeShape(shapeAtEnd(es)),
    ...(unchecked.length ? { unchecked_steps: unchecked } : {}),
    materialized_through: es.checkpoint?.upto || 0,
    ...(dropped ? { checkpoint_dropped: `the table of steps 1..${upto} no longer stands for them — the next materialize builds from the eventstream's start` } : {}),
    next: pending
      ? `add more steps, or materialize them: ${BUILD}({ action: 'materialize', context_id: '${ctx.id}', eventstream: '${name}' }) — the analyses read what is materialized`
      : `nothing to materialize: ${QUERY}({ context_id: '${ctx.id}', eventstream: '${name}', analyses: [...] }) reads it as it is`,
  };
}

function preview(ctx, name, es) {
  const upto = es.checkpoint?.upto || 0;
  return {
    ok: true, context_id: ctx.id, eventstream: name, action: 'preview',
    base: { model: es.base.model, ...(es.base.summary ? { events: es.base.summary.events, users: es.base.summary.users } : { building: es.base.task_id }) },
    steps: es.steps.map((s, i) => ({ index: i + 1, step: s.step, library: s.library, checked: s.checked, ...(s.note ? { note: s.note } : {}), materialized: i < upto, ...(shapeChange(shapeBefore(es, i + 1), s.shape) ? { changed: shapeChange(shapeBefore(es, i + 1), s.shape) } : {}) })),
    materialized_through: upto,
    ...(es.checkpoint ? { table: es.checkpoint.model } : {}),
    shape: describeShape(shapeAtEnd(es)),
  };
}

function fork(engine, ctx, input) {
  const state = ctx.state.retentioneering;
  const parentName = eventstreamOf(ctx, input.eventstream).name;
  const parent = state.eventstreams[parentName];
  if (!input.name) throw new ToolError('fork needs name: the new eventstream\'s', { stage: 'validate', field: 'name' });
  if (state.eventstreams[input.name]) throw new ToolError(`eventstream '${input.name}' exists in context '${ctx.id}' — fork under a new name`, { stage: 'validate', field: 'name' });
  const after = input.after ?? parent.steps.length;
  if (!Number.isInteger(after) || after < 0 || after > parent.steps.length) throw new ToolError(`after ${after} is not a step count of eventstream '${parentName}' (0..${parent.steps.length})`, { stage: 'validate', field: 'after' });
  const child = structuredClone({ ...parent, building: null });
  child.steps = child.steps.slice(0, after);
  // the parent's materialized steps stand for the fork's too when they are all within it
  if (child.checkpoint && child.checkpoint.upto > after) { child.checkpoint = null; child.model = child.base.model; child.summary = child.base.summary; }
  child.forked_from = { eventstream: parentName, after };
  state.eventstreams[input.name] = child;
  if (input.description) child.description = input.description;
  engine.ctxs.touch(ctx.id);
  return {
    ok: true, context_id: ctx.id, eventstream: input.name, action: 'fork', forked_from: child.forked_from, steps: after,
    materialized_through: child.checkpoint?.upto || 0,
    shape: describeShape(shapeAtEnd(child)),
    next: `shape '${input.name}' with its own steps (add_step, edit_step, …) — '${parentName}' is not touched`,
  };
}

const ORDER_COL = 'event_order';
const ROLES_COL = 'es_roles';

async function materializeSteps(engine, feature, ctx, name, es) {
  const upto = es.checkpoint?.upto || 0;
  if (!es.steps.length) throw new ToolError(`eventstream '${name}' has no steps — it is built already; add the library's steps with ${BUILD}({ action: 'add_step', … }), or run analyses on it as it is`, { stage: 'validate', field: 'eventstream' });
  if (upto === es.steps.length) throw new ToolError(`every step of eventstream '${name}' is materialized already (1..${upto}) — its table (${es.checkpoint.model}) is what the analyses read`, { stage: 'validate', field: 'eventstream' });
  if (es.building) throw new ToolError(`a materialize of eventstream '${name}' is already in flight (task ${es.building.task_id}) — read it with ${QUERY}({ task_id: '${es.building.task_id}' })`, { stage: 'validate', field: 'eventstream' });
  const inputShape = shapeBefore(es, upto + 1) || await builtShape(engine, name, es, ctx);
  const inputModel = es.checkpoint?.model || es.base.model;
  const state = ctx.state.retentioneering;
  state.materialized = (state.materialized || 0) + 1;
  const modelName = `rete_st${state.materialized}_${name}_${ctx.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const through = es.steps.length;
  const pending = es.steps.slice(upto).map((s) => s.library);
  const spec = {
    columns: {
      user: ES_COLUMNS.user, event: ES_COLUMNS.event, time: ES_COLUMNS.time,
      paths: inputShape.paths, segments: Object.keys(inputShape.segments), custom: inputShape.columns || [],
      ...(es.checkpoint ? { order: ORDER_COL, roles: ROLES_COL } : {}),
    },
    out: { order: ORDER_COL, roles: ROLES_COL },
    steps: pending,
  };
  // what the table stands for: these steps, as the library takes them
  const stood = JSON.stringify(es.steps.slice(0, through).map((s) => s.library));
  engine.ctxs.writeFile(ctx.id, `${modelName}.py`, compileStepsModel({ inputModel, spec, config: analysisModelConfig(engine.catalog, feature.operatorConfig) }));
  const expiry = engine._expiryConfig('python');
  if (Object.keys(expiry).length) engine.ctxs.writeFile(ctx.id, `${modelName}.yml`, yaml.dump({ version: 2, models: [{ name: modelName, config: expiry }] }, { lineWidth: 200, noRefs: true }));
  engine.ctxs.touch(ctx.id);
  const id = engine._startTask(ctx, BUILD, async (taskId) => {
    try {
      const dir = engine.ctxs.dir(ctx.id);
      const run = await feature.runner.run(dir, modelName);
      if (!run.ok) return { ok: false, error: { stage: 'steps', message: formatDbtError(run.stdout, run.stderr) || run.error || 'the steps did not run' } };
      const ref = `{{ ref('${modelName}') }}`;
      const r = await feature.runner.show(dir, `select ${ROLES_COL} as roles from ${ref} where ${ROLES_COL} is not null`, 1);
      if (!r.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(r.stdout, r.stderr) || r.error } };
      let roles;
      try { roles = JSON.parse(r.rows[0]?.roles); } catch { roles = null; }
      if (!roles) return { ok: false, error: { stage: 'summary', message: 'the steps left no paths — every event was filtered out' } };
      const summary = await summarizeEventstream(feature.runner, dir, modelName, { segments: roles.segments, paths: roles.paths, spec: es.spec });
      if (summary.ok === false) return summary;
      const shape = shapeOf(summary, roles.paths, roles.custom);
      // the eventstream still has these steps (it may have grown meanwhile): the table stands for them
      const now = ctx.state.retentioneering.eventstreams[name];
      if (now && now.steps.length >= through && JSON.stringify(now.steps.slice(0, through).map((s) => s.library)) === stood) {
        now.checkpoint = { upto: through, model: modelName, summary, shape, task_id: taskId };
        now.model = modelName;
        now.summary = summary;
      }
      (ctx.state.retentioneering.tables ||= {})[modelName] = { eventstream: name, summary, steps: through };
      engine.ctxs.touch(ctx.id);
      return {
        ok: true, kind: 'eventstream', context_id: ctx.id, eventstream: name, model: modelName, steps_materialized: through,
        ...summary, paths: roles.paths, ...(roles.custom.length ? { custom_columns: roles.custom } : {}),
        next: `Run the analyses on it: ${QUERY}({ context_id: '${ctx.id}', eventstream: '${name}', analyses: [...] }).`,
      };
    } finally {
      const now = ctx.state.retentioneering.eventstreams[name];
      if (now?.building?.task_id === taskId) delete now.building;
    }
  }, { input: { action: 'materialize', eventstream: name } });
  es.building = { task_id: id, model: modelName };
  engine.jobs.setTable(id, modelName);
  engine.ctxs.touch(ctx.id);
  return engine._taskStarted(id, { context_id: ctx.id, eventstream: name, steps: through });
}

/** Which column of the rows each eventstream column is — the eventstream names them as the library
 *  does (user_id, event, event_time, session_id), whatever the source calls them. */
function columnsFrom(catalog, spec) {
  const cols = pathColumns(catalog, spec);
  const split = (spec.events?.split || []).length;
  return {
    [ES_COLUMNS.user]: pathKey(spec) ? pathKey(spec).join(' + ') : cols.user,
    [ES_COLUMNS.event]: split ? `${cols.event} (events.split applied)` : cols.event,
    [ES_COLUMNS.time]: cols.time,
    ...(spec.sessions ? { [ES_COLUMNS.session]: `${ES_COLUMNS.user} + a gap of ${spec.sessions.gap_minutes} min` } : {}),
  };
}

/** Segments on a path of a whole user: its transitions cross segment values (an interstitial load
 *  followed by a banner show) — said once, with the path that keeps them apart. */
function pathHint(catalog, spec) {
  if (pathKey(spec) || !(spec.segments || []).length) return null;
  const user = pathColumns(catalog, spec).user;
  const seg = spec.segments[0];
  const ref = seg.column !== undefined ? `{ column: '${seg.column}' }` : seg.property !== undefined ? `{ property: '${seg.property}' }` : null;
  if (!ref) return null;
  return `Each path is one user's whole history, so its transitions run across ${spec.segments.map((sg) => sg.name).join(', ')} values (one format's event followed by another's). To follow one ${seg.name} at a time, make it part of the path: path: [{ column: '${user}' }, ${ref}].`;
}

/** The names of a path key the caller set (null: one path per user). */
function pathKey(spec) {
  if (spec.columns) return [].concat(spec.columns.path);
  return spec.path ? spec.path.map((ref) => ref.column ?? ref.property) : null;
}

/** The events kept at a share of their rows (a share of 1 keeps them whole, so it is not a sample). */
function sampledEvents(spec) {
  const kept = Object.entries(spec?.sample?.events || {}).filter(([, v]) => v < 1);
  return kept.length ? Object.fromEntries(kept) : null;
}

/** What the build's sample kept, said where the counts are read. */
function sampleOf(spec) {
  const users = spec.sample?.share != null && spec.sample.share < 1 ? spec.sample.share : null;
  const events = sampledEvents(spec);
  if (users == null && !events) return null;
  return {
    ...(users != null ? { share: users } : {}),
    ...(events ? { events } : {}),
    note: [
      users != null ? 'users kept by a hash of their key, with all their events — the same users on every build' : null,
      events ? `rows of ${Object.keys(events).join(', ')} kept at the share given, by a hash of the row: their counts here are that share of the real ones, and transitions into and out of them are not exact` : null,
    ].filter(Boolean).join('; '),
  };
}

// ── query ─────────────────────────────────────────────────────────────────────────────────────

function eventstreamOf(ctx, name) {
  const all = ctx.state.retentioneering?.eventstreams || {};
  const names = Object.keys(all);
  if (!names.length) throw new ToolError(`context '${ctx.id}' holds no eventstream — build one with ${BUILD}`, { stage: 'validate', field: 'context_id' });
  if (!name) {
    if (names.length > 1) throw new ToolError(`context '${ctx.id}' holds several eventstreams (${names.join(', ')}) — name one with eventstream`, { stage: 'validate', field: 'eventstream' });
    return { name: names[0], ...all[names[0]] };
  }
  if (!all[name]) throw new ToolError(`no eventstream '${name}' in context '${ctx.id}' (it holds ${names.join(', ')})`, { stage: 'validate', field: 'eventstream' });
  return { name, ...all[name] };
}

/** The library method's parameter names, from the sheet. */
function methodParams(kind) {
  return new Set(retentioneeringFacts().analyses[kind].params.map((p) => p.name));
}
function opParams(op) {
  return new Set(retentioneeringFacts().ops[op].params.map((p) => p.name));
}

/** `path` → the library's path column: the user key, the build's session, or a path column a step
 *  made (a split_sessions session_col) — among the ones the eventstream holds. */
function pathColumn(es, paths, path, field) {
  if (path === undefined || path === 'users') return ES_COLUMNS.user;
  const col = path === 'sessions' ? ES_COLUMNS.session : path;
  if (!paths.includes(col)) {
    const made = paths.filter((p) => p !== ES_COLUMNS.user && p !== ES_COLUMNS.session);
    throw new ToolError(path === 'sessions'
      ? `path: "sessions" needs sessions — start eventstream '${es.name}' with sessions: { gap_minutes }, or add a split_sessions step and materialize it${made.length ? ` (its path columns: ${made.join(', ')})` : ''}`
      : `path '${path}' is not a path column of eventstream '${es.name}' (${paths.join(', ')}) — a split_sessions step makes one, once it is materialized`, { stage: 'validate', field });
  }
  return col;
}

function validateAnalyses(es, shape, analyses) {
  const f = retentioneeringFacts();
  const vocab = shape?.events || null;
  const segments = shape ? Object.keys(shape.segments) : es.segments;
  const paths = shape?.paths || [ES_COLUMNS.user, ...(es.sessions ? [ES_COLUMNS.session] : [])];
  const event = (n, field) => {
    if (vocab && !vocab.includes(n)) throw new ToolError(`'${n}' is not an event of eventstream '${es.name}'${suggest(n, vocab)} — its names are the ones after grouping${es.spec?.events?.top ? `, with the rarest merged into '${OTHER_EVENT}'` : ''}${es.steps?.length ? ' and its steps' : ''}`, { stage: 'validate', field });
  };
  const ids = new Set();
  return analyses.map((a) => {
    const { kind, id: given, path, ...params } = a;
    let id = given || kind;
    if (!given) for (let n = 2; ids.has(id); n += 1) id = `${kind}_${n}`;
    if (ids.has(id)) throw new ToolError(`two analyses are named '${id}' — give each its own id`, { stage: 'validate', field: 'analyses.id' });
    ids.add(id);
    const pathCol = pathColumn(es, paths, path, 'analyses.path');
    // a funnel's steps are events of the stream (its path_start / path_end are not steps); an anchor or
    // a path pattern is the library's grammar, which its own check reads (the checker below)
    if (Array.isArray(params.steps)) params.steps.forEach((s) => event(s, 'analyses.steps'));
    const segment = params.segment_col ?? (Array.isArray(params.diff) && params.diff.length === 3 && typeof params.diff[0] === 'string' ? params.diff[0] : undefined);
    if (segment !== undefined && !segments.includes(segment)) throw new ToolError(`'${segment}' is not a segment of eventstream '${es.name}' (${segments.join(', ') || 'it holds none'}) — carry it with segments at start, or make it with an add_segment step and materialize`, { stage: 'validate', field: 'analyses.segment_col' });
    if (methodParams(kind).has('path_col')) params.path_col = pathCol;
    return { id, kind, method: f.analyses[kind].method, path_col: pathCol, params };
  });
}

async function query(engine, feature, input) {
  engine._validate(QUERY, input);
  if (input.cancel) {
    if (!input.task_id && !input.task_ids) throw new ToolError('cancel needs task_id or task_ids', { stage: 'validate', field: 'cancel' });
    return engine._cancelTasks(input, SIDE);
  }
  if (input.task_ids) return readTasks(engine, feature, input);
  if (input.task_id) return readTask(engine, feature, input.task_id, input);
  if (!input.analyses) throw new ToolError(`${QUERY} takes { context_id, analyses } to start analyses, or { task_id } to read one back`, { stage: 'validate' });
  const ctx = pathContext(engine, input.context_id);
  const es = eventstreamOf(ctx, input.eventstream);
  // the analyses read what is materialized: steps added after it are not what they would read
  const upto = es.checkpoint?.upto || 0;
  if (es.steps.length > upto) {
    const pending = es.steps.slice(upto).map((s, i) => `${upto + i + 1} ${s.step.type}`);
    throw new ToolError(`eventstream '${es.name}' has step${pending.length === 1 ? '' : 's'} not materialized yet (${pending.join(', ')}) — ${BUILD}({ action: 'materialize', context_id: '${ctx.id}', eventstream: '${es.name}' }) builds ${pending.length === 1 ? 'it' : 'them'}, and the analyses then read the eventstream after ${pending.length === 1 ? 'it' : 'them'}`, { stage: 'validate', field: 'eventstream' });
  }
  const shape = es.checkpoint?.shape || es.base.shape;
  const analyses = validateAnalyses(es, shape, input.analyses);
  const edgeWeights = retentioneeringFacts().edge_weights;
  // the library's own check of the analyses, on stand-ins of exactly what the eventstream holds
  const reply = shape ? await feature.checker.check({ shape, steps: [], analyses, edge_weights: edgeWeights }) : null;
  const problems = reply?.analyses || [];
  if (problems.length) {
    const [first, ...rest] = problems;
    throw new ToolError(`the library refuses ${first.where}: ${first.message}${rest.length ? ` — and ${rest.map((p) => `${p.where}: ${p.message}`).join('; ')}` : ''} (checked by the library itself on what eventstream '${es.name}' holds; nothing ran)`, { stage: 'validate', field: first.where });
  }
  const spec = {
    columns: {
      user: ES_COLUMNS.user, event: ES_COLUMNS.event, time: ES_COLUMNS.time,
      paths: shape?.paths || [ES_COLUMNS.user, ...(es.sessions ? [ES_COLUMNS.session] : [])],
      segments: shape ? Object.keys(shape.segments) : es.segments,
      custom: shape?.columns || [],
      ...(es.checkpoint ? { order: ORDER_COL, roles: ROLES_COL } : {}),
    },
    edge_weights: edgeWeights,
    analyses,
  };
  const state = ctx.state.retentioneering;
  state.queries = (state.queries || 0) + 1;
  const modelName = `rete_q${state.queries}_${es.name}_${ctx.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  // which eventstream a result table was computed from — carried, so a later read never takes it apart
  (state.results ||= {})[modelName] = es.name;
  engine.ctxs.writeFile(ctx.id, `${modelName}.py`, compileAnalysisModel({ inputModel: es.model, spec, config: analysisModelConfig(engine.catalog, feature.operatorConfig) }));
  const expiry = engine._expiryConfig('python');
  if (Object.keys(expiry).length) engine.ctxs.writeFile(ctx.id, `${modelName}.yml`, yaml.dump({ version: 2, models: [{ name: modelName, config: expiry }] }, { lineWidth: 200, noRefs: true }));
  engine.ctxs.touch(ctx.id);
  const order = analyses.map((a) => a.id);
  const id = engine._startTask(ctx, QUERY, async () => {
    const dir = engine.ctxs.dir(ctx.id);
    const run = await feature.runner.run(dir, modelName);
    if (!run.ok) return { ok: false, error: { stage: 'analysis', message: formatDbtError(run.stdout, run.stderr) || run.error || 'the analysis did not run' } };
    return readResult(feature, dir, modelName, { context_id: ctx.id, eventstream: es.name, order });
  }, { input });
  engine.jobs.setTable(id, modelName);
  return engine._taskStarted(id, { context_id: ctx.id, eventstream: es.name, analyses: order });
}

/** The stored result table of a query task, read and shaped. */
async function readResult(feature, dir, model, { context_id, eventstream, order }) {
  const n = await feature.runner.show(dir, `select count(*) as n from {{ ref('${model}') }}`, 1);
  if (!n.ok) return { ok: false, error: { stage: 'fetch', message: formatDbtError(n.stdout, n.stderr) || n.error } };
  const res = await feature.runner.show(dir, `select analysis, kind, part, seq, payload from {{ ref('${model}') }} order by analysis, part, seq`, Math.max(Number(n.rows[0]?.n) || 0, 1));
  if (!res.ok) return { ok: false, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) || res.error } };
  return { ok: true, kind: 'analyses', context_id, eventstream, analyses: parseResultRows(res.rows, order) };
}

/** What a read of a finished task answers: the eventstream summary, or each analysis summarized. */
function answer(engine, id, out, detail = 'summary') {
  if (out?.kind === 'eventstream') return withLevels(out, detail);
  if (out?.kind !== 'analyses') return out;
  const drawable = Object.keys(out.analyses).filter((a) => hasCard(out.analyses[a].kind, !!out.analyses[a].diff) && !drawnAlready(engine, id, a));
  return {
    ok: true, kind: 'analyses', context_id: out.context_id, eventstream: out.eventstream,
    analyses: detail === 'full' ? out.analyses : Object.fromEntries(Object.entries(out.analyses).map(([a, r]) => [a, summarize(r)])),
    ...(drawable.length ? { show_to_user: { tool: DISPLAY, arguments: { task_id: id, analysis: drawable[0] }, why: `in a host that renders MCP Apps this draws one analysis as a card (${drawable.join(', ')} can be drawn) — once per analysis, for what the person should see.` } } : {}),
  };
}

/** An eventstream read: each segment's levels with their users — the first 30 (every one with detail:
 *  "full"), and how many there are. */
function withLevels(out, detail) {
  if (!out.segment_levels) return out;
  const cut = detail === 'full' ? Infinity : 30;
  return {
    ...out,
    segment_levels: Object.fromEntries(Object.entries(out.segment_levels).map(([s, l]) => [s, {
      count: l.count,
      levels: l.levels.slice(0, cut).map((level, i) => ({ level, users: l.users[i] })),
      ...(l.levels.length > cut ? { levels_more: l.levels.length - cut } : {}),
      ...(l.complete ? {} : { complete: false }),
    }])),
  };
}

async function readTask(engine, feature, id, { wait_seconds: wait, detail } = {}) {
  const job = engine._taskForSide(id, SIDE);
  const seconds = Math.min(Math.max(wait ?? MAX_WAIT_SECONDS, 0), MAX_WAIT_SECONDS);
  const waited = await engine._awaitTask(id, seconds);
  const head = { task_id: id, tool: job.tool, ...(job.contextId ? { context_id: job.contextId } : {}) };
  const now = engine.jobs.get(id);
  if (now.status === 'running') {
    if (!engine.jobs.isLive(id)) return { ok: false, ...head, status: 'error', error: { stage: 'task', message: 'this task was started by a server process that is gone (it restarted) — start it again' } };
    return { ok: true, ...head, status: 'running', waited_seconds: waited, next: `still running — call ${QUERY}({ task_id: '${id}' }) again; it waits up to ${MAX_WAIT_SECONDS}s` };
  }
  if (now.status === 'cancelled') return { ok: false, ...head, status: 'cancelled', error: { stage: 'cancelled', code: 'cancelled', message: now.error || 'cancelled' } };
  const out = await taskOutput(engine, feature, now);
  if (!out) return { ok: false, ...head, status: 'error', error: { stage: 'task', code: RESULT_GONE, message: now.error || 'this task\'s result is gone — run it again' } };
  if (out.ok === false) return { ...head, ...out, status: 'error' };
  return { ...head, status: 'done', ...answer(engine, id, out, detail) };
}

async function readTasks(engine, feature, input) {
  for (const id of input.task_ids) engine._taskForSide(id, SIDE);
  const seconds = Math.min(Math.max(input.wait_seconds ?? MAX_WAIT_SECONDS, 0), MAX_WAIT_SECONDS);
  await engine._awaitTasks(input.task_ids, seconds);
  const results = [];
  for (const id of input.task_ids) results.push(await readTask(engine, feature, id, { wait_seconds: 0, detail: input.detail }));
  const running = results.filter((r) => r.status === 'running').map((r) => r.task_id);
  return { ok: true, status: running.length ? 'running' : 'done', results, ...(running.length ? { next: `${running.length} still running — call ${QUERY}({ task_ids: [${running.map((i) => `'${i}'`).join(', ')}] }) for them` } : {}) };
}

/** A finished task's full output: held in memory, else re-read from its stored table (a query task). */
async function taskOutput(engine, feature, job) {
  const kept = engine._taskResults?.get(job.id)?.out;
  if (kept) return kept;
  if (job.status !== 'ready' || !job.table || !engine.ctxs.has(job.contextId)) return job.status === 'error' ? { ok: false, error: { stage: 'task', message: job.error } } : null;
  const ctx = engine.ctxs.get(job.contextId);
  const dir = engine.ctxs.dir(job.contextId);
  if (job.tool === QUERY) {
    const out = await readResult(feature, dir, job.table, { context_id: job.contextId, eventstream: ctx.state.retentioneering?.results?.[job.table] ?? null, order: [] });
    if (out.ok) engine._keepTaskResult(job.id, { tool: job.tool, input: null, out });
    return out;
  }
  const t = ctx.state.retentioneering?.tables?.[job.table];
  const es = t ? ctx.state.retentioneering.eventstreams[t.eventstream] : null;
  return t ? { ok: true, kind: 'eventstream', context_id: job.contextId, eventstream: t.eventstream, ...(es?.source ? { source: es.source } : {}), model: job.table, ...(t.steps ? { steps_materialized: t.steps } : {}), ...t.summary } : null;
}

// ── display ───────────────────────────────────────────────────────────────────────────────────

function drawnAlready(engine, taskId, analysis) {
  const job = engine.jobs.get(taskId);
  if (!job?.contextId || !engine.ctxs.has(job.contextId)) return false;
  return !!engine.ctxs.get(job.contextId).state.retentioneering?.drawn?.[taskId]?.includes(analysis);
}

async function display(engine, feature, input) {
  engine._validate(DISPLAY, input);
  const job = engine._taskForSide(input.task_id, SIDE);
  if (job.tool !== QUERY) throw new ToolError(`task ${input.task_id} built an eventstream — draw an analysis of a ${QUERY} task`, { stage: 'validate', field: 'task_id' });
  if (drawnAlready(engine, input.task_id, input.analysis)) throw new ToolError(`analysis '${input.analysis}' of task ${input.task_id} is shown already — its card is in the conversation above`, { stage: 'validate', field: 'analysis' });
  await engine._awaitTask(input.task_id, MAX_WAIT_SECONDS);
  const now = engine.jobs.get(input.task_id);
  if (now.status === 'running') throw new ToolError(`task ${input.task_id} is still running — read it with ${QUERY}({ task_id }) until it is done, then draw it`, { stage: 'validate', field: 'task_id' });
  const out = await taskOutput(engine, feature, now);
  if (!out || out.ok === false) throw new ToolError(`task ${input.task_id} has no result to draw${out?.error?.message ? ` (${out.error.message})` : ''}`, { stage: 'validate', field: 'task_id' });
  const result = out.analyses[input.analysis];
  if (!result) throw new ToolError(`task ${input.task_id} has no analysis '${input.analysis}' (it has ${Object.keys(out.analyses).join(', ')})`, { stage: 'validate', field: 'analysis' });
  if (!hasCard(result.kind, !!result.diff)) throw new ToolError(`'${input.analysis}' is ${result.diff ? `a diff of ${result.kind}` : `a ${result.kind}`}, which has no card: answer it in words from the numbers query_retentioneering_model({ task_id }) returned`, { stage: 'validate', field: 'analysis' });
  const ctx0 = engine.ctxs.get(job.contextId);
  const es = Object.entries(ctx0.state.retentioneering?.eventstreams || {}).find(([name]) => name === out.eventstream)?.[1];
  // what the numbers are about — who, when, how much of it — shown on the card with them
  const scope = es?.summary ? {
    users: es.summary.users, events: es.summary.events, ...(es.summary.sessions != null ? { sessions: es.summary.sessions } : {}),
    period: es.summary.period,
    ...(es.summary.path ? { path: es.summary.path } : {}),
    ...(es.spec?.sample?.share != null && es.spec.sample.share < 1 ? { sample: es.spec.sample.share } : {}),
    ...(sampledEvents(es.spec) ? { sampled_events: sampledEvents(es.spec) } : {}),
  } : null;
  const drawn = { ok: true, task_id: input.task_id, analysis: input.analysis, eventstream: out.eventstream, ...(scope ? { scope } : {}), ...(input.edge_weight ? { edge_weight: input.edge_weight } : {}), result };
  const vm = retentioneeringViewModel(drawn, input);
  if (vm.kind === 'none') return { ...drawn, drawn: false, note: 'this analysis has nothing to draw (no transitions, steps, groups or rows)' };
  const ctx = engine.ctxs.get(job.contextId);
  const marks = (ctx.state.retentioneering.drawn ||= {});
  (marks[input.task_id] ||= []).push(input.analysis);
  engine.ctxs.touch(ctx.id);
  return { ...drawn, drawn: true };
}
