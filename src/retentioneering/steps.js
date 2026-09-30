// AN EVENTSTREAM SHAPED STEP BY STEP — its summary and the shape it has at each step (events, path
// columns, segments with their levels, custom columns); the library's steps, each checked by the
// library itself on stand-ins of that shape as it is added, edited, inserted or deleted; preview and
// fork; and materialize, which runs the steps not yet run in one dbt Python model.

import yaml from 'js-yaml';
import { dbtFailure } from '../dbt/index.js';
import { ToolError } from '../validate.js';
import { MAX_WAIT_SECONDS } from '../schema.js';
import { RESHAPED, ADDED } from './schema.js';
import { ES_COLUMNS } from './eventstream.js';
import { getDialect } from '../dialects/index.js';
import { compileStepsModel, analysisModelConfig } from './python.js';
import { byText } from './view-model.js';
import { BUILD, QUERY } from './names.js';
import { serially, basePaths } from './contexts.js';
import { pathKey, sampleOf, eventstreamOf, opParams } from './query.js';

/** How many levels of a segment the summary lists in full; a segment with more is known by its count. */
export const LEVEL_CAP = 1000;

export async function summarizeEventstream(runner, dir, model, { segments, paths, spec, dialect }) {
  const ref = `{{ ref('${model}') }}`;
  const sessionCol = paths.includes(ES_COLUMNS.session) ? ES_COLUMNS.session : null;
  const totals = await runner.show(dir, `select count(*) as events, count(distinct ${ES_COLUMNS.user}) as users, count(distinct ${ES_COLUMNS.event}) as names, min(${ES_COLUMNS.time}) as first_event, max(${ES_COLUMNS.time}) as last_event${sessionCol ? `, count(distinct ${sessionCol}) as sessions` : ''} from ${ref}`, 1);
  if (!totals.ok) return dbtFailure('summary', totals);
  const vocab = await runner.show(dir, `select ${ES_COLUMNS.event} as event, count(*) as events, count(distinct ${ES_COLUMNS.user}) as users from ${ref} group by ${ES_COLUMNS.event} order by count(*) desc, ${ES_COLUMNS.event}`, Math.max(Number(totals.rows[0]?.names) || 0, 1));
  if (!vocab.ok) return dbtFailure('summary', vocab);
  const levels = await segmentLevels(runner, dir, ref, segments, getDialect(dialect));
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
export async function segmentLevels(runner, dir, ref, segments, d) {
  if (!segments.length) return {};
  // a segment's name as an identifier (quoted: it may be a keyword) and as a literal, never pasted in
  const q = (s) => d.quoteIdent(s);
  const counts = await runner.show(dir, `select ${segments.map((s, i) => `count(distinct ${q(s)}) as c${i}`).join(', ')} from ${ref}`, 1);
  if (!counts.ok) return dbtFailure('summary', counts);
  const count = Object.fromEntries(segments.map((s, i) => [s, Number(counts.rows[0]?.[`c${i}`]) || 0]));
  const listed = segments.filter((s) => count[s] <= LEVEL_CAP);
  const rows = new Map(segments.map((s) => [s, []]));
  if (listed.length) {
    const sql = listed.map((s) => `select ${d.sqlLiteral(s)} as segment, ${q(s)} as level, count(distinct ${ES_COLUMNS.user}) as users from ${ref} where ${q(s)} is not null group by ${q(s)}`).join(' union all ');
    const res = await runner.show(dir, sql, Math.max(listed.reduce((n, s) => n + count[s], 0), 1));
    if (!res.ok) return dbtFailure('summary', res);
    for (const r of res.rows) rows.get(r.segment)?.push({ level: String(r.level), users: Number(r.users) });
  }
  return Object.fromEntries(segments.map((s) => {
    const list = rows.get(s).sort((a, b) => b.users - a.users || byText(a.level, b.level));
    return [s, { count: count[s], complete: count[s] <= LEVEL_CAP, levels: list.map((l) => l.level), users: list.map((l) => l.users) }];
  }));
}

/** What the library's check and the next step read of an eventstream: its event names, path columns,
 *  segments with their levels (complete or not) and custom columns. */
export function shapeOf(summary, paths, columns) {
  return {
    events: (summary.vocabulary || []).map((v) => v.event),
    paths,
    segments: Object.fromEntries((summary.segments || []).map((s) => [s, { levels: summary.segment_levels?.[s]?.levels || [], complete: !!summary.segment_levels?.[s]?.complete }])),
    columns,
  };
}

/** The eventstream's shape once the base is built — waited for (up to the read's wait) when the call
 *  comes right after the start. */
export async function builtShape(engine, name, es, ctx) {
  if (!es.base.shape && es.base.task_id) await engine.tasks.await([es.base.task_id], MAX_WAIT_SECONDS);
  // a fork made while its base was building shares the base's table, whose summary is kept by table
  const kept = ctx?.state.retentioneering.tables?.[es.base.model];
  if (!es.base.shape && kept) {
    es.base.summary = kept.summary;
    es.base.shape = shapeOf(kept.summary, basePaths(es.spec), []);
    if (es.model === es.base.model) es.summary = kept.summary;
  }
  if (es.base.shape) return es.base.shape;
  const job = es.base.task_id ? engine.jobs.get(es.base.task_id) : null;
  if (job?.status === 'running') throw new ToolError(`eventstream '${name}' is still being built (task ${es.base.task_id}) — its steps are checked against what it holds, so add them once it is built: ${QUERY}({ request: { task_id: '${es.base.task_id}' } }) waits for it`, { stage: 'validate', field: 'eventstream' });
  throw new ToolError(`eventstream '${name}' did not build${job?.error ? ` (${job.error})` : ''} — start it again`, { stage: 'validate', field: 'eventstream' });
}

/** The shape step `k` (1-based) reads: what the materialized steps left when it comes right after
 *  them, else what the step before it left, else the base; null when a step before it was not checked. */
export function shapeBefore(es, k) {
  const cp = es.checkpoint;
  if (cp && k === cp.upto + 1) return cp.shape;
  if (k === 1) return es.base.shape;
  return es.steps[k - 2]?.shape || null;
}

/** The shape at the end of the draft. */
export function shapeAtEnd(es) {
  return shapeBefore(es, es.steps.length + 1);
}

/** One step in the library's own form: `path` as the library's path column, a reshaped parameter
 *  translated back (RESHAPED). */
export function toLibrary(step, field) {
  const { path, ...rest } = step;
  if (path !== undefined && opParams(step.type).has('path_col')) rest.path_col = path === 'users' ? ES_COLUMNS.user : path === 'sessions' ? ES_COLUMNS.session : path;
  for (const [name, r] of Object.entries(RESHAPED)) if (rest[name] != null) rest[name] = r.toLibrary(rest[name], `${field}.${name}`);
  // a parameter this tool adds goes to the library as the one it stands for
  for (const [name, a] of Object.entries(ADDED[step.type] || {})) {
    if (rest[name] == null) continue;
    rest[a.library] = a.toLibrary(rest[name], `${field}.${name}`);
    delete rest[name];
  }
  return seeded(opParams(step.type), rest);
}

/** The seed a draw the caller left unseeded gets: every run of it keeps the same paths. */
export const SEED = 0;

/** A step's parameters with the library's random_state set when the caller left it unset — the
 *  library's default draws afresh on every run, and the feature is deterministic. (No analysis of the
 *  sheet takes one: the library's analyses seed themselves.) */
export function seeded(names, params) {
  return names.has('random_state') && params.random_state == null ? { ...params, random_state: SEED } : params;
}

export const NOT_CHECKED = 'not checked: the library\'s own check could not run here — the run itself will say';

/** Steps `from`..end of `view` checked by the library on the shape before `from` → one entry per
 *  step: { step, library, checked, shape | problem | note }. */
export async function checkSteps(feature, view, from, fieldOf) {
  const list = view.steps.slice(from - 1);
  const library = list.map((s, i) => toLibrary(s.step, fieldOf(from + i)));
  const entries = list.map((s, i) => ({ step: s.step, library: library[i], checked: false, shape: null }));
  const shape = shapeBefore(view, from);
  if (!shape) {
    entries.forEach((e) => { e.note = `not checked: a step before it (${from - 1}) could not be checked, so what it reads is not known — materialize to know it`; });
    return entries;
  }
  // the constants each step names, as the call wrote them: a parameter written into SQL (filter_events'
  // where) carries its levels only here, so the stand-ins hold them as a segment's levels
  const reply = await feature.checker.check({ shape, steps: library, analyses: [], constants: list.map((s) => s.step), reserved: [ORDER_COL, ROLES_COL] });
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
export function describeShape(shape) {
  if (!shape) return null;
  return {
    events: shape.events.slice(0, 200), ...(shape.events.length > 200 ? { events_more: shape.events.length - 200 } : {}),
    paths: shape.paths,
    segments: Object.fromEntries(Object.entries(shape.segments).map(([s, l]) => [s, { levels: l.levels.slice(0, 30), ...(l.levels.length > 30 ? { levels_more: l.levels.length - 30 } : {}), ...(l.complete ? {} : { complete: false }) }])),
    ...(shape.columns?.length ? { columns: shape.columns } : {}),
  };
}

/** What a step changed, between the shape it read and the one it left. */
export function shapeChange(before, after) {
  if (!before || !after) return null;
  const diff = (a, b) => b.filter((x) => !a.includes(x));
  const out = {
    events_added: diff(before.events, after.events), events_removed: diff(after.events, before.events),
    segments_added: diff(Object.keys(before.segments), Object.keys(after.segments)), segments_removed: diff(Object.keys(after.segments), Object.keys(before.segments)),
    paths_added: diff(before.paths, after.paths), paths_removed: diff(after.paths, before.paths),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v.length));
}

export async function editSteps(engine, feature, ctx, name, es, action, input) {
  await builtShape(engine, name, es, ctx);
  // the draft is read, checked and written back as one: another step, or a materialize that finishes
  // meanwhile, waits for it (and a materialize then sees the steps as they are after it)
  return serially(feature, ctx.id, () => {
    const now = ctx.state.retentioneering.eventstreams[name];
    if (!now?.base.shape) throw new ToolError(`eventstream '${name}' was started again meanwhile and is still being built — add the step once it is`, { stage: 'validate', field: 'eventstream' });
    return commitSteps(engine, feature, ctx, name, now, action, input);
  });
}

export async function commitSteps(engine, feature, ctx, name, es, action, input) {
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
      ? `add more steps, or materialize them: ${BUILD}({ request: { action: 'materialize', context_id: '${ctx.id}', eventstream: '${name}' } }) — the analyses read what is materialized`
      : `nothing to materialize: ${QUERY}({ request: { context_id: '${ctx.id}', eventstream: '${name}', analyses: [...] } }) reads it as it is`,
  };
}

export function preview(ctx, name, es) {
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

export function fork(engine, ctx, input) {
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

export const ORDER_COL = 'event_order';

export const ROLES_COL = 'es_roles';

export async function materializeSteps(engine, feature, ctx, name, es) {
  const upto = es.checkpoint?.upto || 0;
  if (!es.steps.length) throw new ToolError(`eventstream '${name}' has no steps — it is built already; add the library's steps with ${BUILD}({ request: { action: 'add_step', … } }), or run analyses on it as it is`, { stage: 'validate', field: 'eventstream' });
  if (upto === es.steps.length) throw new ToolError(`every step of eventstream '${name}' is materialized already (1..${upto}) — its table (${es.checkpoint.model}) is what the analyses read`, { stage: 'validate', field: 'eventstream' });
  if (es.building) throw new ToolError(`a materialize of eventstream '${name}' is already in flight (task ${es.building.task_id}) — read it with ${QUERY}({ request: { task_id: '${es.building.task_id}' } })`, { stage: 'validate', field: 'eventstream' });
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
  const expiry = engine.host.expiryConfig('python');
  if (Object.keys(expiry).length) engine.ctxs.writeFile(ctx.id, `${modelName}.yml`, yaml.dump({ version: 2, models: [{ name: modelName, config: expiry }] }, { lineWidth: 200, noRefs: true }));
  engine.ctxs.touch(ctx.id);
  const id = engine.tasks.start(ctx, BUILD, async (taskId) => {
    try {
      const dir = engine.ctxs.dir(ctx.id);
      const run = await feature.runner.run(dir, modelName);
      if (!run.ok) return dbtFailure('steps', run, 'the steps did not run');
      const ref = `{{ ref('${modelName}') }}`;
      const r = await feature.runner.show(dir, `select ${ROLES_COL} as roles from ${ref} where ${ROLES_COL} is not null`, 1);
      if (!r.ok) return dbtFailure('summary', r);
      let roles;
      try { roles = JSON.parse(r.rows[0]?.roles); } catch { roles = null; }
      if (!roles) return { ok: false, error: { stage: 'summary', message: 'the steps left no paths — every event was filtered out' } };
      const summary = await summarizeEventstream(feature.runner, dir, modelName, { segments: roles.segments, paths: roles.paths, spec: es.spec, dialect: engine.catalog.dialect });
      if (summary.ok === false) return summary;
      const shape = shapeOf(summary, roles.paths, roles.custom);
      // the eventstream still has these steps (it may have grown meanwhile): the table stands for them —
      // decided with the draft held, so a step being edited right now is seen as edited
      await serially(feature, ctx.id, () => {
        const now = ctx.state.retentioneering.eventstreams[name];
        if (now && now.steps.length >= through && JSON.stringify(now.steps.slice(0, through).map((s) => s.library)) === stood) {
          now.checkpoint = { upto: through, model: modelName, summary, shape, task_id: taskId };
          now.model = modelName;
          now.summary = summary;
        }
        (ctx.state.retentioneering.tables ||= {})[modelName] = { eventstream: name, summary, steps: through };
        engine.ctxs.touch(ctx.id);
      });
      return {
        ok: true, kind: 'eventstream', context_id: ctx.id, eventstream: name, model: modelName, steps_materialized: through,
        ...summary, paths: roles.paths, ...(roles.custom.length ? { custom_columns: roles.custom } : {}),
        next: `Run the analyses on it: ${QUERY}({ request: { context_id: '${ctx.id}', eventstream: '${name}', analyses: [...] } }).`,
      };
    } finally {
      const now = ctx.state.retentioneering.eventstreams[name];
      if (now?.building?.task_id === taskId) delete now.building;
    }
  }, { input: { action: 'materialize', eventstream: name } });
  es.building = { task_id: id, model: modelName };
  engine.jobs.setTable(id, modelName);
  engine.ctxs.touch(ctx.id);
  return engine.tasks.started(id, { context_id: ctx.id, eventstream: name, steps: through });
}
