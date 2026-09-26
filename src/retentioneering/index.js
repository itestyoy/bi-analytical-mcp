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

import { createDbt, formatDbtError } from '../dbt/index.js';
import { ToolError, RESULT_GONE } from '../validate.js';
import { MAX_WAIT_SECONDS } from '../schema.js';
import { rankFuzzy } from '../fuzzy.js';
import { buildSchema, querySchema, displaySchema, retentioneeringFacts, userKeyColumn, pathSources, ANALYSIS_KINDS, OFFERED_OPS, NAME } from './schema.js';
import { renderEventstream, ES_COLUMNS, OTHER_EVENT } from './eventstream.js';
import { compileAnalysisModel, analysisModelConfig } from './python.js';
import { parseResultRows, summarize } from './results.js';
import { retentioneeringViewModel, RETENTIONEERING_VIEW_URI } from './view-model.js';
import { retentioneeringGuide, GUIDE_NAME, ROUTING_TRIGGERS, INSTRUCTIONS_LINE, retentioneeringSkill } from './guide.js';

export const SIDE = 'retentioneering';
const BUILD = 'build_retentioneering_model';
const QUERY = 'query_retentioneering_model';
const DISPLAY = 'display_retentioneering_result';

export const TOOL_DESCRIPTIONS = {
  [BUILD]: 'Build the eventstream a path analysis reads: which events source, which time window, which events (kept, dropped, merged into groups), which user attributes to carry as segments, optional sessions and a deterministic user sample. It is built in SQL where the data lives and materialized, and returns a task_id at once; query_retentioneering_model({ task_id }) returns its summary — users, events, the event vocabulary with counts. Use it for questions about paths and sequences: what users do after an event, where they drop off, which transitions dominate, what kinds of paths there are. Then run the analyses with query_retentioneering_model. For a metric over time use build_semantic_model; for a one-off table of numbers, build_pipeline_model.',
  [QUERY]: 'Run retentioneering over a built eventstream, or read a task back. { context_id, preprocess?, analyses: [...] } starts ONE task that computes every listed analysis together in the warehouse (one run for all of them, so list what the question needs in one call). Each analysis is a library method with its own parameters, under the library\'s names: transition_graph (which event follows which, every weight at once), step_matrix / step_sankey (the share of paths at each event step by step, optionally around an anchor), funnel, cluster_analysis (groups of similar paths), segment_overview, conversion_rate, metric_distribution, path_metrics, describe; diff compares two segment levels. preprocess is the library\'s own op model ({ type, ...params }: filter_paths, collapse_events, truncate_paths, split_sessions, add_segment, add_clusters, …), for the whole call or one analysis. It returns a task_id at once. { task_id } (or task_ids) waits up to 30s and returns each analysis summarized — the biggest transitions, the leading events per step, each group\'s profile, the first rows of a table — or, with detail: "full", every record; { task_id, cancel: true } stops it. Event names are the eventstream\'s own (after grouping).',
  [DISPLAY]: 'Draw one analysis of a finished query_retentioneering_model task as a card for the person — the transition graph, a step matrix heatmap, a step sankey, a funnel, the clusters or a segment overview, and for any other analysis or a diff the tables it returned — in hosts that render MCP Apps. Once per analysis: a second call for the same one is refused. Read the task first (query_retentioneering_model({ task_id })) to know what it found; draw the analysis the person should see before summarising it.',
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
      description: 'Card for one path analysis: a transition graph (switch the weight and how many exits per event are shown), a step matrix heatmap, a step sankey, a funnel, the clusters of paths, a segment overview — or the tables any other analysis (and any diff) returned.',
      asset: 'retentioneeringView',
      viewModel: (result, args) => retentioneeringViewModel(result, args),
    },
    guide: { name: GUIDE_NAME, build: (catalog) => retentioneeringGuide(catalog), triggers: ROUTING_TRIGGERS },
    skill: (engine) => retentioneeringSkill(engine.catalog),
    instructions: INSTRUCTIONS_LINE,
    overview: () => ({
      library: `retentioneering ${retentioneeringFacts().version}`,
      analyses: ANALYSIS_KINDS,
      preprocess: OFFERED_OPS,
      note: `Path analysis: ${BUILD} → ${QUERY} → ${DISPLAY}; semantic_index({ guide: "${GUIDE_NAME}" }) says which analysis answers which question.`,
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

function validateBuild(engine, input) {
  const c = engine.catalog;
  const { source } = input;
  if (!userKeyColumn(c, source)) throw new ToolError(`'${source}' names no single user key toward the users model, so its events have no path owner`, { stage: 'validate', field: 'source' });
  checkEvents(c, source, input.events?.include, 'events.include');
  checkEvents(c, source, input.events?.exclude, 'events.exclude');
  for (const [g, evs] of Object.entries(input.events?.groups || {})) {
    if (!new RegExp(NAME).test(g)) throw new ToolError(`group name '${g}' must be lowercase snake_case`, { stage: 'validate', field: 'events.groups' });
    checkEvents(c, source, evs, `events.groups.${g}`);
  }
  const reserved = new Set(Object.values(ES_COLUMNS));
  const segNames = [];
  const segments = (input.segments || []).map((seg) => {
    const dims = c.modelDimensionColumns(seg.model);
    if (!dims.includes(seg.attribute)) throw new ToolError(`'${seg.attribute}' is not an attribute of '${seg.model}'${suggest(seg.attribute, dims)}`, { stage: 'validate', field: 'segments.attribute' });
    const name = seg.as || seg.attribute;
    if (reserved.has(name) || segNames.includes(name)) throw new ToolError(`segment name '${name}' is taken — give it another with as`, { stage: 'validate', field: 'segments.as' });
    segNames.push(name);
    return { ...seg, via: relationshipTo(c, source, seg.model, seg.via) };
  });
  for (const w of input.where || []) {
    if (!segNames.includes(w.column)) throw new ToolError(`where filters on a segment column — '${w.column}' is not one (${segNames.join(', ') || 'none declared'})`, { stage: 'validate', field: 'where.column' });
    const needsValue = !['is_null', 'is_not_null'].includes(w.op);
    if (needsValue && w.value === undefined) throw new ToolError(`where ${w.op} on '${w.column}' needs a value`, { stage: 'validate', field: 'where.value' });
    if (['in', 'not_in'].includes(w.op) && !Array.isArray(w.value)) throw new ToolError(`where ${w.op} takes an array value`, { stage: 'validate', field: 'where.value' });
  }
  return { ...input, segments };
}

function contextFor(engine, input) {
  if (!input.context_id) {
    const ctx = engine.ctxs.create();
    ctx.state.retentioneering = { eventstreams: {}, queries: 0, drawn: {} };
    return ctx;
  }
  const ctx = engine._ctx(input.context_id);
  if (!ctx.state.retentioneering) throw new ToolError(`context '${input.context_id}' is not a path-analysis context — build without context_id to start one`, { stage: 'validate', field: 'context_id' });
  return ctx;
}

async function build(engine, feature, input) {
  engine._validate(BUILD, input);
  const spec = validateBuild(engine, input);
  const ctx = contextFor(engine, input);
  const state = ctx.state.retentioneering;
  const modelName = `rete_es_${spec.name}_${ctx.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const timeConditions = engine._timeRangeConditions(spec.source, spec.time_range);
  const physicalCols = await engine._physicalCols(spec.source);
  let rendered;
  try {
    rendered = renderEventstream(engine.catalog, spec, { modelName, physicalCols, timeConditions });
  } catch (e) {
    throw new ToolError(e?.message || String(e), { stage: 'validate' });
  }
  state.eventstreams[spec.name] = { model: modelName, source: spec.source, spec: input, columns: rendered.columns, segments: rendered.segments, sessions: !!spec.sessions, summary: null };
  if (input.description) state.description = input.description;
  engine.ctxs.writeModel(ctx.id, modelName, `{{ config(materialized='table') }}\n${rendered.sql}\n`);
  engine.ctxs.touch(ctx.id);
  const id = engine._startTask(ctx, BUILD, async () => {
    const dir = engine.ctxs.dir(ctx.id);
    const run = await feature.runner.run(dir, modelName);
    if (!run.ok) return { ok: false, error: { stage: 'build', message: formatDbtError(run.stdout, run.stderr) || run.error || 'the eventstream did not build' } };
    const summary = await summarizeEventstream(feature.runner, dir, modelName, rendered, spec);
    if (summary.ok === false) return summary;
    const es = ctx.state.retentioneering.eventstreams[spec.name];
    if (es) es.summary = summary;
    engine.ctxs.touch(ctx.id);
    return {
      ok: true, kind: 'eventstream', context_id: ctx.id, eventstream: spec.name, source: spec.source, model: modelName,
      columns: rendered.columns, ...summary,
      next: `Run the analyses the question needs in ONE call: ${QUERY}({ context_id: '${ctx.id}', analyses: [{ kind: 'transition_graph' }, { kind: 'step_matrix' }, …] }).`,
    };
  }, { input });
  engine.jobs.setTable(id, modelName);
  return engine._taskStarted(id, { context_id: ctx.id, eventstream: spec.name });
}

async function summarizeEventstream(runner, dir, model, rendered, spec) {
  const ref = `{{ ref('${model}') }}`;
  const totals = await runner.show(dir, `select count(*) as events, count(distinct ${ES_COLUMNS.user}) as users, count(distinct ${ES_COLUMNS.event}) as names, min(${ES_COLUMNS.time}) as first_event, max(${ES_COLUMNS.time}) as last_event${spec.sessions ? `, count(distinct ${ES_COLUMNS.session}) as sessions` : ''} from ${ref}`, 1);
  if (!totals.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(totals.stdout, totals.stderr) || totals.error } };
  const vocab = await runner.show(dir, `select ${ES_COLUMNS.event} as event, count(*) as events, count(distinct ${ES_COLUMNS.user}) as users from ${ref} group by ${ES_COLUMNS.event} order by count(*) desc, ${ES_COLUMNS.event}`, Math.max(Number(totals.rows[0]?.names) || 0, 1));
  if (!vocab.ok) return { ok: false, error: { stage: 'summary', message: formatDbtError(vocab.stdout, vocab.stderr) || vocab.error } };
  const t = totals.rows[0] || {};
  return {
    events: Number(t.events) || 0,
    users: Number(t.users) || 0,
    ...(spec.sessions ? { sessions: Number(t.sessions) || 0 } : {}),
    period: { first_event: t.first_event ?? null, last_event: t.last_event ?? null },
    segments: rendered.segments,
    vocabulary: vocab.rows.map((r) => ({ event: r.event, events: Number(r.events), users: Number(r.users) })),
    ...(spec.sample?.share != null && spec.sample.share < 1 ? { sample: { share: spec.sample.share, note: 'users kept by a hash of their key — the same users on every build' } } : {}),
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

/** The session columns split_sessions steps add (the library's own default name when none is given). */
function sessionColumns(steps) {
  const f = retentioneeringFacts();
  const fallback = f.ops.split_sessions?.params.find((p) => p.name === 'session_col')?.default;
  return (steps || []).filter((s) => s.type === 'split_sessions').map((s) => s.session_col || fallback).filter(Boolean);
}

/** `path` → the library's path column: the user key, the build's session, or a split_sessions column. */
function pathColumn(es, path, sessionCols, field) {
  if (path === undefined || path === 'users') return ES_COLUMNS.user;
  if (path === 'sessions') {
    if (!es.sessions) throw new ToolError(`path: "sessions" needs sessions — rebuild eventstream '${es.name}' with sessions: { gap_minutes }, or split them with a split_sessions preprocess step`, { stage: 'validate', field });
    return ES_COLUMNS.session;
  }
  if (!sessionCols.includes(path)) throw new ToolError(`path '${path}' is not a column of the paths — use "users", "sessions", or the session_col of a split_sessions step in preprocess (${sessionCols.join(', ') || 'none here'})`, { stage: 'validate', field });
  return path;
}

/** Preprocess steps in the library's own shape: `path` resolved to path_col. */
function libraryOps(es, steps, sessionCols, field) {
  return (steps || []).map((step) => {
    const { path, ...rest } = step;
    if (path !== undefined && opParams(step.type).has('path_col')) rest.path_col = pathColumn(es, path, sessionCols, field);
    return rest;
  });
}

function validateAnalyses(es, analyses, callSteps) {
  const f = retentioneeringFacts();
  const vocab = es.summary?.vocabulary?.map((v) => v.event) || null;
  const known = vocab ? [...vocab, ...f.synthetic_events] : null;
  const event = (n, field) => {
    if (known && !known.includes(n)) throw new ToolError(`'${n}' is not an event of eventstream '${es.name}'${suggest(n, known)} — its names are the ones after grouping${es.spec?.events?.top ? `, with the rarest merged into '${OTHER_EVENT}'` : ''}`, { stage: 'validate', field });
  };
  const anchorEvents = (spec, field) => {
    for (const one of Array.isArray(spec) ? spec : [spec]) {
      const pattern = typeof one === 'string' ? one : one?.event_col ? null : one?.pattern;
      if (pattern) pattern.split('->').map((t) => t.trim()).filter((t) => t && t !== '.*').forEach((t) => event(t, field));
    }
  };
  const callSessions = sessionColumns(callSteps);
  const ids = new Set();
  return analyses.map((a) => {
    const { kind, id: given, path, preprocess, ...params } = a;
    let id = given || kind;
    if (!given) for (let n = 2; ids.has(id); n += 1) id = `${kind}_${n}`;
    if (ids.has(id)) throw new ToolError(`two analyses are named '${id}' — give each its own id`, { stage: 'validate', field: 'analyses.id' });
    ids.add(id);
    const sessionCols = [...callSessions, ...sessionColumns(preprocess)];
    const pathCol = pathColumn(es, path, sessionCols, 'analyses.path');
    // names the eventstream had when it was built — checked here unless a preprocess step may change them
    if (!callSteps?.length && !preprocess?.length) {
      if (Array.isArray(params.steps)) params.steps.forEach((s) => event(s, 'analyses.steps'));
      for (const k of Object.keys(params)) if (/anchor$/.test(k)) anchorEvents(params[k], `analyses.${k}`);
      const segment = params.segment_col ?? (Array.isArray(params.diff) && params.diff.length === 3 && typeof params.diff[0] === 'string' ? params.diff[0] : undefined);
      if (segment !== undefined && !es.segments.includes(segment)) throw new ToolError(`'${segment}' is not a segment of eventstream '${es.name}' (${es.segments.join(', ') || 'it was built with none'}) — add it to segments in ${BUILD}, or make it with an add_segment preprocess step`, { stage: 'validate', field: 'analyses.segment_col' });
    }
    if (methodParams(kind).has('path_col')) params.path_col = pathCol;
    return {
      id, kind, method: f.analyses[kind].method, path_col: pathCol,
      ...(preprocess?.length ? { preprocess: libraryOps(es, preprocess, sessionCols, 'analyses.preprocess') } : {}),
      params,
    };
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
  const ctx = engine._ctx(input.context_id);
  if (!ctx.state.retentioneering) throw new ToolError(`context '${input.context_id}' is not a path-analysis context — build an eventstream with ${BUILD} first`, { stage: 'validate', field: 'context_id' });
  const es = eventstreamOf(ctx, input.eventstream);
  const analyses = validateAnalyses(es, input.analyses, input.preprocess);
  const state = ctx.state.retentioneering;
  state.queries = (state.queries || 0) + 1;
  const modelName = `rete_q${state.queries}_${es.name}_${ctx.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const spec = {
    columns: { user: ES_COLUMNS.user, event: ES_COLUMNS.event, time: ES_COLUMNS.time, session: es.sessions ? ES_COLUMNS.session : null, segments: es.segments },
    edge_weights: retentioneeringFacts().edge_weights,
    preprocess: libraryOps(es, input.preprocess, sessionColumns(input.preprocess), 'preprocess'),
    analyses,
  };
  // which eventstream a result table was computed from — carried, so a later read never takes it apart
  (state.results ||= {})[modelName] = es.name;
  engine.ctxs.writeFile(ctx.id, `${modelName}.py`, compileAnalysisModel({ inputModel: es.model, spec, config: analysisModelConfig(engine.catalog, feature.operatorConfig) }));
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
  if (out?.kind !== 'analyses') return out;
  const drawable = Object.keys(out.analyses).filter((a) => !drawnAlready(engine, id, a));
  return {
    ok: true, kind: 'analyses', context_id: out.context_id, eventstream: out.eventstream,
    analyses: detail === 'full' ? out.analyses : Object.fromEntries(Object.entries(out.analyses).map(([a, r]) => [a, summarize(r)])),
    ...(drawable.length ? { show_to_user: { tool: DISPLAY, arguments: { task_id: id, analysis: drawable[0] }, why: `in a host that renders MCP Apps this draws one analysis as a card (${drawable.join(', ')} can be drawn) — once per analysis, for what the person should see.` } } : {}),
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
  const es = Object.entries(ctx.state.retentioneering?.eventstreams || {}).find(([, e]) => e.model === job.table);
  return es?.[1]?.summary ? { ok: true, kind: 'eventstream', context_id: job.contextId, eventstream: es[0], source: es[1].source, model: job.table, columns: es[1].columns, ...es[1].summary } : null;
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
  const ctx0 = engine.ctxs.get(job.contextId);
  const es = Object.entries(ctx0.state.retentioneering?.eventstreams || {}).find(([name]) => name === out.eventstream)?.[1];
  // what the numbers are about — who, when, how much of it — shown on the card with them
  const scope = es?.summary ? {
    users: es.summary.users, events: es.summary.events, ...(es.summary.sessions != null ? { sessions: es.summary.sessions } : {}),
    period: es.summary.period, ...(es.spec?.sample?.share != null && es.spec.sample.share < 1 ? { sample: es.spec.sample.share } : {}),
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
