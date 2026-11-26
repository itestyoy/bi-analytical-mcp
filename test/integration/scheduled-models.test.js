// SCHEDULED MODELS (src/engine/scheduled.js, src/scheduled-models.js): a build whose table is computed again
// daily after the value index's sync, read by its context id, kept with what its columns mean — put to sleep
// when nobody queries it, woken by the next query, which answers from the table as it stands.
//
// DATA ONLY: every expectation is the warehouse's own count, read with SQL written here, before and after rows
// are added to the source; what is refused is input validation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, taskResult } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project');
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');
const opts = { timeout: 600000 };
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const ABOUT = { description: 'Events per event name', question: 'What do players do most often?' };
const DAY = 86400000;
let wh; let engine; let backend; let seq = 0;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  backend = testDbt({ profilesDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('sched'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog: loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend, scheduledIdleDays: 7 }));
}, opts);

after(async () => { backend?.close?.(); try { engine?.close(); } catch { /* noop */ } if (wh) await wh.stop(); });

const perEvent = [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }] }];
const counts = (rows) => Object.fromEntries(rows.map((r) => [String(r.event_name), Number(r.n)]));

/** The warehouse's own events per event name. */
async function truth() {
  const { rows } = await wh.query('SELECT event_name, count(*) AS n FROM fct_analytics_events GROUP BY 1');
  return counts(rows);
}

/** A draft over the events, its steps added. */
async function draft(steps = perEvent) {
  const s = await engine.build_model({ action: 'start', name: `sched_${seq++}`, ...ABOUT, source: 'events' });
  await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps });
  return s.context_id;
}

/** A read of the scheduled model by its context id: its rows, and what the answer says of the model. */
async function read(contextId) {
  const r = await engine.query_model({ context_id: contextId, name: 'read_counts', ...ABOUT, steps: [{ stage: 'order_by', keys: [{ key: 'event_name' }] }] });
  assert.notEqual(r.ok, false, JSON.stringify(r.error));
  return r;
}

/** Add `n` events of a new name to the source. */
async function addEvents(name, n) {
  await wh.exec(`INSERT INTO fct_analytics_events SELECT * REPLACE ('${name}' AS event_name) FROM (SELECT * FROM fct_analytics_events ORDER BY device_time LIMIT ${n})`);
}

/** Wait for every task the engine runs on the context to settle. */
async function settled(contextId) {
  const raw = engine.raw;
  for (const j of raw.jobs.list().filter((x) => x.context_id === contextId && x.status === 'running')) await taskResult(engine, j.task_id);
}

test('what a scheduled model is told about its columns: every one described, else refused naming those that are not', opts, async (t) => {
  if (skip(t)) return;
  const id = await draft();
  // `n` is made by the steps: it says nothing until described; event_name is the source's, described there
  await assert.rejects(Promise.resolve().then(() => engine.build_model({ action: 'schedule', context_id: id, grain: 'one row per event name' })), /columns:.*\bn\b/);
  await assert.rejects(Promise.resolve().then(() => engine.build_model({ action: 'schedule', context_id: id, grain: 'one row per event name', columns: [{ name: 'n', description: 'events' }, { name: 'nope', description: 'x' }] })), /nope — no column/);
  // a build started from a task computed once is not scheduled: it would recompute the same rows
  const once = await engine.build_model({ action: 'materialize', context_id: id });
  assert.equal(once.build?.ok, true, JSON.stringify(once.error || once.build));
  const s = await engine.build_model({ action: 'start', name: `sched_${seq++}`, ...ABOUT, from_task: once.task_id || engine.raw.ctxs.get(id).state.pipeline_model.task_id });
  await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'n' }, { value: 0 }] }] }] });
  await assert.rejects(Promise.resolve().then(() => engine.build_model({ action: 'schedule', context_id: s.context_id, grain: 'one row per event name', columns: [{ name: 'n', description: 'events' }] })), /computed once/);
});

test('scheduled: its table is read by context id, computed again after a sync once a day, and its steps are fixed', opts, async (t) => {
  if (skip(t)) return;
  const id = await draft();
  const built = await engine.build_model({ action: 'schedule', context_id: id, grain: 'one row per event name', columns: [{ name: 'n', description: 'How many events of that name', unit: 'events' }] });
  assert.notEqual(built.ok, false, JSON.stringify(built.error));
  const before0 = await truth();
  assert.deepEqual(counts((await read(id)).rows), before0);

  // described: the source's description carried over, the step that made `n` read off the steps
  const d = await engine.context({ action: 'describe', context_id: id });
  const col = Object.fromEntries(d.scheduled.columns.map((c) => [c.name, c]));
  assert.equal(col.event_name.description_from, 'catalog');
  assert.equal(col.n.computed.stage, 'aggregate');
  assert.equal(col.n.unit, 'events');

  // fixed: no step is added, and it is not materialized again
  await assert.rejects(Promise.resolve().then(() => engine.build_model({ action: 'add_steps', context_id: id, steps: [{ stage: 'limit', limit: 1 }] })), /scheduled model/);
  await assert.rejects(Promise.resolve().then(() => engine.build_model({ action: 'materialize', context_id: id })), /scheduled model/);
  // …a change is a fork: a new draft with its steps, built as any draft
  const fork = await engine.build_model({ action: 'fork', context_id: id, name: `sched_${seq++}`, ...ABOUT });
  await engine.build_model({ action: 'add_steps', context_id: fork.context_id, steps: [{ stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'n' }, { value: 10 }] }] }] });
  const forked = await engine.build_model({ action: 'materialize', context_id: fork.context_id });
  assert.deepEqual(counts(forked.rows), Object.fromEntries(Object.entries(before0).filter(([, n]) => n > 10)));

  // a sync the same day computes nothing again: the new rows are not in the table yet
  await addEvents('sched_probe_a', 3);
  await engine.raw.schedules.afterSync();
  await settled(id);
  assert.deepEqual(counts((await read(id)).rows), before0);
  // the next day's sync does
  engine.raw.ctxs.get(id).state.scheduled.refreshed_at = new Date(Date.now() - DAY).toISOString();
  await engine.raw.schedules.afterSync();
  await settled(id);
  const after1 = await truth();
  assert.equal(after1.sched_probe_a, 3);
  const r = await read(id);
  assert.deepEqual(counts(r.rows), after1);
  assert.ok(r.scheduled?.refreshed_at, 'a read says when the table was computed');
  assert.ok(!(r.warnings || []).some((w) => /before the steps changed/.test(w)), 'its table is the build of its steps');
});

test('a model nobody queries sleeps instead of refreshing; the next query answers from its table and wakes it', opts, async (t) => {
  if (skip(t)) return;
  const id = await draft();
  await engine.build_model({ action: 'schedule', context_id: id, grain: 'one row per event name', columns: [{ name: 'n', description: 'How many events of that name' }] });
  const spec = engine.raw.ctxs.get(id).state.scheduled;
  const stale = await truth();
  await addEvents('sched_probe_b', 2);
  // unqueried for 8 days, refreshed yesterday: the sync puts it to sleep, its table is as it was
  spec.last_queried_at = new Date(Date.now() - 8 * DAY).toISOString();
  spec.refreshed_at = new Date(Date.now() - DAY).toISOString();
  await engine.raw.schedules.afterSync();
  await settled(id);
  assert.ok(spec.suspended, 'asleep');
  // the query wakes it: its rows are the table before the refresh, and it says so
  const woke = await read(id);
  assert.deepEqual(counts(woke.rows), stale);
  assert.equal(woke.scheduled.woken, true);
  // the refresh it started brings the new rows in
  for (let i = 0; i < 600 && !(spec.last_run?.reason === 'woken by a query' && spec.last_run.finished_at); i += 1) await new Promise((r) => { setTimeout(r, 100); });
  assert.equal(spec.last_run.ok, true, JSON.stringify(spec.last_run));
  assert.equal(spec.suspended, undefined);
  assert.deepEqual(counts((await read(id)).rows), await truth());
});

test('a build ending in a semantic layer: scheduled, its metrics are read over the table it refreshes', opts, async (t) => {
  if (skip(t)) return;
  const id = await draft([
    { stage: 'compute', name: 'day', expr: { fn: 'date_trunc', grain: 'day', args: [{ column: 'device_time' }] } },
    { stage: 'aggregate', group_by: ['event_name', 'day'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
    { stage: 'semantic_model', time: 'day', measures: [{ name: 'events', expr: { fn: 'sum', args: [{ column: 'n' }] } }], metrics: [{ name: 'events', type: 'simple', measure: 'events' }] },
  ]);
  const out = await engine.build_model({ action: 'schedule', context_id: id, grain: 'one row per event name and day', columns: [{ name: 'day', description: 'The UTC day' }, { name: 'n', description: 'Events of that name that day' }] });
  assert.notEqual(out.ok, false, JSON.stringify(out.error));
  const total = async () => {
    const r = await engine.query_model({ context_id: id, name: 'total_events', ...ABOUT, steps: [{ stage: 'metrics', metrics: ['events'] }] });
    assert.notEqual(r.ok, false, JSON.stringify(r.error));
    return Number(r.rows[0].events);
  };
  const sum = (o) => Object.values(o).reduce((a, n) => a + n, 0);
  assert.equal(await total(), sum(await truth()));
  await addEvents('sched_probe_c', 4);
  engine.raw.ctxs.get(id).state.scheduled.refreshed_at = new Date(Date.now() - DAY).toISOString();
  await engine.raw.schedules.afterSync();
  await settled(id);
  assert.equal(await total(), sum(await truth()));
});

test('deleting a scheduled model drops its table from the warehouse', opts, async (t) => {
  if (skip(t)) return;
  const id = await draft();
  await engine.build_model({ action: 'schedule', context_id: id, grain: 'one row per event name', columns: [{ name: 'n', description: 'How many events of that name' }] });
  const model = engine.raw.ctxs.get(id).state.scheduled.model;
  const tables = async () => (await wh.query(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = '${model}'`)).rows[0].n;
  assert.equal(Number(await tables()), 1);
  await engine.context({ action: 'delete', context_id: id });
  assert.equal(Number(await tables()), 0);
});
