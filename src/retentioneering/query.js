// QUERY_RETENTIONEERING_MODEL — the analyses of one call, checked by the library on the eventstream's
// shape and run together in one dbt Python model over the eventstream as materialized; and a task read
// back: a page of each of its tables by their row numbers (offset / limit, as every query tool pages a
// result), with what the eventstream was.

import yaml from 'js-yaml';
import { dbtFailure } from '../dbt/index.js';
import { ToolError, RESULT_GONE } from '../validate.js';
import { TaskRunner } from '../task-runner.js';
import { READ_PAGE } from '../schema/fields.js';
import { pageBlock } from '../engine/helpers.js';
import { retentioneeringFacts } from './schema.js';
import { pathParts, OTHER_EVENT } from './eventstream.js';
import { getDialect } from '../dialects/index.js';
import { compileAnalysisModel, analysisModelConfig } from './python.js';
import { parseResultRows, readView, holdsPage } from './results.js';
import { hasCard, diffForm, CHARTED_DIFF_KINDS } from './view-model.js';
import { SIDE, BUILD, QUERY, DISPLAY, ES_COLUMNS } from './names.js';
import { pathContext } from './contexts.js';
import { suggest, namedColumns } from './build-input.js';
import { refuseEarlierRead } from './earlier.js';
import { ORDER_COL, ROLES_COL } from './steps.js';
import { drawnAlready } from './display.js';

/** Which column of the rows each eventstream column is — the eventstream names them as the library
 *  does (user_id, event, event_time, session_id), whatever the rows call them. */
export function columnsFrom(catalog, spec) {
  const cols = namedColumns(catalog, spec);
  return {
    [ES_COLUMNS.user]: pathKey(spec) ? pathKey(spec).join(' + ') : cols.user,
    [ES_COLUMNS.event]: cols.event,
    [ES_COLUMNS.time]: cols.time,
    ...(spec.sessions ? { [ES_COLUMNS.session]: `${ES_COLUMNS.user} + a gap of ${spec.sessions.gap_minutes} min` } : {}),
  };
}

/** Segments on a path of a whole user: its transitions cross segment values (an interstitial load
 *  followed by a banner show) — said once, with the path that keeps them apart. */
export function pathHint(catalog, spec) {
  const segments = spec.segments || [];
  if (pathKey(spec) || !segments.length) return null;
  const user = namedColumns(catalog, spec).user;
  if (!user) return null;
  return `Each path is one user's whole history, so its transitions run across ${segments.join(', ')} values (one format's event followed by another's). To follow one ${segments[0]} at a time, make it part of the path: path: ['${user}', '${segments[0]}'].`;
}

/** The columns of a path key the caller set (null: one path per user). */
export function pathKey(spec) {
  return pathParts(spec);
}

/** The events kept at a share of their rows (a share of 1 keeps them whole, so it is not a sample). */
export function sampledEvents(spec) {
  const kept = Object.entries(spec?.sample?.events || {}).filter(([, v]) => v < 1);
  return kept.length ? Object.fromEntries(kept) : null;
}

/** What the build's sample kept, said where the counts are read. */
export function sampleOf(spec) {
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

export function eventstreamOf(ctx, name) {
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
export function methodParams(kind) {
  return new Set(retentioneeringFacts().analyses[kind].params.map((p) => p.name));
}

export function opParams(op) {
  return new Set(retentioneeringFacts().ops[op].params.map((p) => p.name));
}

/** `path` → the library's path column: one of the path columns the eventstream holds (its shape's
 *  `paths`) — the build's path key (the default), its sessions, or a session column a step made. */
export function pathColumn(es, paths, path, field) {
  if (path === undefined) return ES_COLUMNS.user;
  if (!paths.includes(path)) {
    const sessions = paths.includes(ES_COLUMNS.session) ? '' : `; ${ES_COLUMNS.session} is there once eventstream '${es.name}' is started with sessions: { gap_minutes }`;
    throw new ToolError(`path '${path}' is not a path column of eventstream '${es.name}' — its path columns: ${paths.join(', ')}${sessions}; a split_sessions step makes another, once it is materialized`, { stage: 'validate', field });
  }
  return path;
}

export function validateAnalyses(es, shape, analyses) {
  const f = retentioneeringFacts();
  const vocab = shape?.events || null;
  const segments = shape ? Object.keys(shape.segments) : es.segments;
  const paths = shape?.paths || [ES_COLUMNS.user, ...(es.sessions ? [ES_COLUMNS.session] : [])];
  const event = (n, field) => {
    if (vocab && !vocab.includes(n)) throw new ToolError(`'${n}' is not an event of eventstream '${es.name}'${suggest(n, vocab)} — its names are the ones its start made${es.spec?.top ? `, with the rarest merged into '${OTHER_EVENT}'` : ''}${es.steps?.length ? ' and its steps' : ''}`, { stage: 'validate', field });
  };
  const names = new Set();
  return analyses.map((a) => {
    const { kind, name: given, path, ...params } = a;
    let id = given || kind;
    if (!given) for (let n = 2; names.has(id); n += 1) id = `${kind}_${n}`;
    if (names.has(id)) throw new ToolError(`two analyses are named '${id}' — give each its own name`, { stage: 'validate', field: 'analyses.name' });
    names.add(id);
    const pathCol = pathColumn(es, paths, path, 'analyses.path');
    // a funnel's steps are events of the stream (its path_start / path_end are not steps); an anchor or
    // a path pattern is the library's grammar, which its own check reads (the checker below)
    if (Array.isArray(params.steps)) params.steps.forEach((s) => event(s, 'analyses.steps'));
    const segment = params.segment_col ?? (Array.isArray(params.diff) && params.diff.length === 3 && typeof params.diff[0] === 'string' ? params.diff[0] : undefined);
    if (segment !== undefined && !segments.includes(segment)) throw new ToolError(`'${segment}' is not a segment of eventstream '${es.name}' (${segments.join(', ') || 'it holds none'}) — carry it with segments at start, or make it with an add_segment step and materialize`, { stage: 'validate', field: 'analyses.segment_col' });
    if (methodParams(kind).has('path_col')) params.path_col = pathCol;
    // a diff whose card keeps the analysis's own shape is run through the charted function (the analysis step and its check alike)
    return { id, kind, method: f.analyses[kind].method, path_col: pathCol, params, ...(params.diff != null && CHARTED_DIFF_KINDS.includes(kind) ? { diff_charted: true } : {}) };
  });
}

export async function query(engine, feature, input) {
  // a read in an earlier spelling is refused with how a read is made now (src/retentioneering/earlier.js)
  refuseEarlierRead(input);
  engine.host.validate(QUERY, input);
  if (input.cancel) return engine.tasks.cancel(input, SIDE);
  if (input.task_ids) return readTasks(engine, feature, input);
  if (!input.analyses) throw new ToolError(`${QUERY} takes { context_id, analyses } to start analyses, or { task_ids } to read them back`, { stage: 'validate' });
  const ctx = pathContext(engine, input.context_id);
  const es = eventstreamOf(ctx, input.eventstream);
  // the analyses read what is materialized: steps added after it are not what they would read
  const upto = es.checkpoint?.upto || 0;
  if (es.steps.length > upto) {
    const pending = es.steps.slice(upto).map((s, i) => `${upto + i + 1} ${s.step.type}`);
    throw new ToolError(`eventstream '${es.name}' has step${pending.length === 1 ? '' : 's'} not materialized yet (${pending.join(', ')}) — ${BUILD}({ request: { action: 'materialize', context_id: '${ctx.id}', eventstream: '${es.name}' } }) builds ${pending.length === 1 ? 'it' : 'them'}, and the analyses then read the eventstream after ${pending.length === 1 ? 'it' : 'them'}`, { stage: 'validate', field: 'eventstream' });
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
  // which eventstream, and which of its tables, a result was computed from — carried, so a later read
  // (and its card) speaks of those rows, whatever the eventstream became after
  (state.results ||= {})[modelName] = { eventstream: es.name, table: es.model, analyses: analyses.map((a) => a.id), rows_per_table: true };
  engine.ctxs.writeFile(ctx.id, `${modelName}.py`, compileAnalysisModel({ inputModel: es.model, spec, config: analysisModelConfig(engine.catalog, feature.operatorConfig) }));
  const expiry = engine.host.expiryConfig('python');
  if (Object.keys(expiry).length) engine.ctxs.writeFile(ctx.id, `${modelName}.yml`, yaml.dump({ version: 2, models: [{ name: modelName, config: expiry }] }, { lineWidth: 200, noRefs: true }));
  engine.ctxs.touch(ctx.id);
  const order = analyses.map((a) => a.id);
  const id = engine.tasks.start(ctx, QUERY, async () => {
    const dir = engine.ctxs.dir(ctx.id);
    const run = await feature.runner.run(dir, modelName);
    if (!run.ok) return dbtFailure('analysis', run, 'the analysis did not run');
    const out = await readResult(engine, feature, dir, modelName, { context_id: ctx.id, eventstream: es.name, order });
    // an analysis the library raised on is kept with the call's others, and logged like any failure
    for (const [a, r] of Object.entries(out.analyses || {})) {
      if (r.error) engine.errors.record({ source: 'task', tool: QUERY, stage: 'analysis', field: `analyses.${a}`, context_id: ctx.id, task_id: id, message: `${r.error.type}: ${r.error.message}`, args: input });
    }
    return out;
  }, { input });
  engine.jobs.setTable(id, modelName);
  return engine.tasks.started(id, { context_id: ctx.id, eventstream: es.name, analyses: order });
}

/** How many rows of each table a task holds in memory: every chart's records whole, and of a table as
 *  long as the paths (a cluster's label per path) its first rows — a page past them is read from the
 *  stored table, and a card reads every row there. */
export const KEPT_ROWS = 1000;

/** The stored result table of a query task, read and shaped: every record but a table's rows outside
 *  `from`..`from + rows` (rows Infinity: every one from `from`), of every analysis or of one. */
export async function readResult(engine, feature, dir, model, { context_id, eventstream, order, rows = feature.keptRows, from = 0, analysis = null }) {
  const d = getDialect(engine.catalog.dialect);
  const first = Math.trunc(Number(from)) || 0;
  const window = [first > 0 ? `seq >= ${first}` : null, Number.isFinite(rows) ? `seq < ${first + Math.trunc(Number(rows))}` : null].filter(Boolean);
  const where = [window.length ? `(part <> 'row' or (${window.join(' and ')}))` : null, analysis ? `analysis = ${d.sqlLiteral(analysis)}` : null].filter(Boolean);
  const sql = `from {{ ref('${model}') }}${where.length ? ` where ${where.join(' and ')}` : ''}`;
  const n = await feature.runner.show(dir, `select count(*) as n ${sql}`, 1);
  if (!n.ok) return dbtFailure('fetch', n);
  const res = await feature.runner.show(dir, `select analysis, kind, part, seq, payload ${sql} order by analysis, part, seq`, Math.max(Number(n.rows[0]?.n) || 0, 1));
  if (!res.ok) return dbtFailure('fetch', res);
  return { ok: true, kind: 'analyses', context_id, eventstream, analyses: parseResultRows(res.rows, order, { from: first }) };
}

/**
 * Where a query task's result came from: its eventstream and the table of it the analyses read. Its
 * rows are numbered within each table (`rows_per_table`), which is what lets a read keep each table's
 * first rows. A result recorded without that numbering — or not recorded at all — cannot be cut
 * right, so it is `gone`: that task's read says so (the same query run again stores it as it is read
 * now), and the other tasks of a read go on.
 */
export function resultOrigin(state, table) {
  const r = state?.results?.[table];
  if (r && typeof r === 'object' && r.rows_per_table) return r;
  return { eventstream: null, table: null, gone: `the result in ${table} was stored by an earlier version of this server, before its rows were numbered within their tables — run the same query again to read it` };
}

/** What a read of a finished task answers, a page of it (`at`: { offset, limit }): the eventstream's
 *  summary, or each analysis's tables paged with what it computes beyond them (readView). */
export function answer(engine, feature, id, out, at = {}) {
  if (out?.kind === 'eventstream') return withLevels(out, at);
  if (out?.kind !== 'analyses') return out;
  const drawable = Object.keys(out.analyses).filter((a) => !out.analyses[a].error && hasCard(out.analyses[a].kind, diffForm(out.analyses[a])) && !drawnAlready(engine, feature, id, a));
  return {
    ok: true, kind: 'analyses', context_id: out.context_id, eventstream: out.eventstream,
    analyses: Object.fromEntries(Object.entries(out.analyses).map(([a, r]) => [a, readView(r, at)])),
    ...(drawable.length ? { show_to_user: { tool: DISPLAY, arguments: { request: { task_id: id, display: { analysis: drawable[0] } } }, why: `in a host that renders MCP Apps this draws one analysis as a card (${drawable.join(', ')} can be drawn) — once per analysis, for what the person should see.` } } : {}),
  };
}

/** An eventstream read: each segment's levels with their users, the most users first — a page of them
 *  (`limit` from `offset`, READ_PAGE unless the read says), and how many levels there are. */
export function withLevels(out, { offset = 0, limit = READ_PAGE } = {}) {
  if (!out.segment_levels) return out;
  return {
    ...out,
    segment_levels: Object.fromEntries(Object.entries(out.segment_levels).map(([s, l]) => {
      const levels = l.levels.slice(offset, offset + limit).map((level, i) => ({ level, users: l.users[offset + i] }));
      return [s, {
        count: l.count,
        levels,
        page: pageBlock({ offset, limit, returned: levels.length, has_more: offset + levels.length < l.levels.length, total: l.levels.length }),
        ...(l.complete ? {} : { complete: false }),
      }];
    })),
  };
}

export async function readTask(engine, feature, id, { wait_seconds: wait, waited: already = null, offset = 0, limit = READ_PAGE } = {}) {
  const job = engine.tasks.forSide(id, SIDE);
  // a read of several waits for all of them once, and each answer says how long that was
  const waited = already ?? await engine.tasks.await([id], TaskRunner.clampWait(wait));
  const { head, pending } = engine.tasks.status(id, waited);
  if (pending) return pending;
  const now = engine.jobs.get(id);
  let out = await taskOutput(engine, feature, now);
  if (!out) return { ok: false, ...head, status: 'error', error: { stage: 'task', code: RESULT_GONE, message: now.error || 'this task\'s result is gone — run it again' } };
  if (out.ok === false) return { ...head, ...out, status: 'error' };
  // a page past the rows the task holds is read from the stored table — each table's rows from offset,
  // limit of them (not kept: a table as long as the paths is paged, never held whole)
  const at = { offset, limit };
  if (out.kind === 'analyses' && !Object.values(out.analyses).every((r) => holdsPage(r, at))) {
    if (!engine.ctxs.has(job.contextId)) return { ok: false, ...head, status: 'error', error: { stage: 'task', code: RESULT_GONE, message: 'this task\'s stored result is gone with its context (dropped, or expired) — run the analyses again' } };
    const page = await readResult(engine, feature, engine.ctxs.dir(job.contextId), now.table, { context_id: out.context_id, eventstream: out.eventstream, order: Object.keys(out.analyses), rows: limit, from: offset });
    if (page.ok === false) return { ...head, ...page, status: 'error' };
    out = page;
  }
  return { ...head, status: 'done', ...answer(engine, feature, id, out, at) };
}

export async function readTasks(engine, feature, input) {
  for (const id of input.task_ids) engine.tasks.forSide(id, SIDE);
  const waited = await engine.tasks.await(input.task_ids, TaskRunner.clampWait(input.wait_seconds));
  const results = [];
  // each task's result paged alike: every table of it from offset, limit rows (READ_PAGE unless asked)
  for (const id of input.task_ids) results.push(await readTask(engine, feature, id, { waited, offset: input.offset, limit: input.limit }));
  return TaskRunner.readAnswer(results, QUERY, { waited_seconds: waited });
}

/** A finished task's output: held in memory, else read from its stored table — a query task's with a
 *  table's first rows kept (`rows`: how many; Infinity: all), of every analysis or of one. Only the kept
 *  read of every analysis is held in memory. */
export async function taskOutput(engine, feature, job, { rows = feature.keptRows, analysis = null } = {}) {
  const kept = engine.tasks.held(job.id);
  if (kept) return kept;
  if (job.status !== 'ready' || !job.table || !engine.ctxs.has(job.contextId)) return job.status === 'error' ? { ok: false, error: { stage: 'task', message: job.error } } : null;
  const ctx = engine.ctxs.get(job.contextId);
  const dir = engine.ctxs.dir(job.contextId);
  if (job.tool === QUERY) {
    const origin = resultOrigin(ctx.state.retentioneering, job.table);
    if (origin.gone) return { ok: false, error: { stage: 'task', code: RESULT_GONE, message: origin.gone } };
    const out = await readResult(engine, feature, dir, job.table, { context_id: job.contextId, eventstream: origin.eventstream, order: origin.analyses || [], rows, analysis });
    if (out.ok && !analysis && rows === feature.keptRows) engine.tasks.keep(job.id, { tool: job.tool, input: null, out });
    return out;
  }
  const t = ctx.state.retentioneering?.tables?.[job.table];
  const es = t ? ctx.state.retentioneering.eventstreams[t.eventstream] : null;
  return t ? { ok: true, kind: 'eventstream', context_id: job.contextId, eventstream: t.eventstream, ...(es?.source ? { source: es.source } : {}), model: job.table, ...(t.steps ? { steps_materialized: t.steps } : {}), ...t.summary } : null;
}

// ── display ───────────────────────────────────────────────────────────────────────────────────
