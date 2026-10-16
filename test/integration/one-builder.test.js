// ONE BUILDER, ONE QUERY TOOL, ONE JOIN CONTRACT — the redesign proven on the data
// (docs/knowledge/decisions/2026/10/2026-10-15-20-30-00-one-builder-one-query-one-join-contract.md).
// Every call here is the tool's own, written as a caller writes it — no declaration helper:
//   1. a build whose one step is its semantic layer: the users model joined on its contract, an amount of
//      another model (acquisition) computed on its own rows beside the events, every name as declared;
//   2. the layer changed by edit_step and materialized again: the context holds the new one only;
//   3. a context's layer described as dbt parsed it, and validated on the warehouse over a window;
//   4. a pipeline taken back to an earlier step by a fork, its rows those of the steps it kept.
// DATA-ONLY assertions (the project's rule): every number is held to the warehouse's own count.

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

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 600000 };
const WINDOW = { start: '2026-01-01', end: '2026-01-31' };
const num = (v) => Number(v === '' || v == null ? NaN : v);
const near = (a, b) => Math.abs(a - b) < 1e-9;

let wh;
let engine;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('onebld'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }) }));
}, opts);

after(async () => { engine?.runner?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

const USERS = { source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } };
const LAYER = {
  stage: 'semantic_model',
  join: [USERS],
  measures: [
    { name: 'evts', expr: { fn: 'count' } },
    { name: 'players', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } },
    { name: 'spend', source: 'acquisition', expr: { fn: 'sum', args: [{ column: 'cost' }] } },
  ],
  metrics: [
    { name: 'evts', type: 'simple', measure: 'evts' },
    { name: 'players', type: 'simple', measure: 'players' },
    { name: 'spend', type: 'simple', measure: 'spend' },
    { name: 'evts_per_player', type: 'derived', expr: { fn: 'div', args: [{ metric: 'evts' }, { metric: 'players' }] } },
  ],
};
const metrics = (names, extra = {}) => ({ stage: 'metrics', metrics: names, ...extra });

let ctx;

test('a build whose one step is its layer: joined on the contract, an amount computed beside the events, every name as declared', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_model({ action: 'start', name: 'onebld', source: 'events', steps: [LAYER], materialize: true });
  ctx = out.context_id;
  assert.deepEqual(out.step_effects[0].metrics.sort(), ['evts', 'evts_per_player', 'players', 'spend']);
  const parsed = await taskResult(engine, out.materialize.task_id);
  assert.equal(parsed.parse?.ok ?? parsed.ok, true, JSON.stringify(parsed));

  const [truth] = (await wh.query('select count(*) as evts, count(distinct player_id_of_internal) as players from fct_analytics_events')).rows;
  const [{ spend }] = (await wh.query('select sum(cost) as spend from fct_player_acquisition')).rows;
  const all = await engine.query_model({ context_id: ctx, steps: [metrics(['evts', 'players', 'spend', 'evts_per_player'])], time_range: WINDOW });
  assert.equal(all.ok, true, JSON.stringify(all.error));
  const [row] = all.rows;
  // the result's columns are the names the step declared
  assert.equal(num(row.evts), num(truth.evts));
  assert.equal(num(row.players), num(truth.players));
  assert.ok(near(num(row.spend), num(spend)), `spend ${row.spend} vs ${spend}`);
  assert.ok(near(num(row.evts_per_player), num(truth.evts) / num(truth.players)));

  // grouped by an attribute of the joined model: every event counted once (the contract's key is unique
  // at a moment), the per-country counts those the warehouse gives for the version valid at the event
  const by = await engine.query_model({ context_id: ctx, steps: [metrics(['evts'], { group_by: [{ source: 'users', column: 'platform' }] })], time_range: WINDOW });
  assert.equal(by.ok, true, JSON.stringify(by.error));
  const col = by.group_by_resolved['users.platform'];
  const got = Object.fromEntries(by.rows.map((r) => [String(r[col] ?? 'null'), num(r.evts)]));
  assert.equal(Object.values(got).reduce((a, b) => a + b, 0), num(truth.evts), `no event repeats or is lost: ${JSON.stringify(got)}`);
  const sql = `select coalesce(u.platform, 'null') as k, count(*) as n from fct_analytics_events e
    left join dim_users u on u.player_id_of_internal = e.player_id_of_internal
     and e.device_time >= u.install_time_valid_from and (u.install_time_valid_until is null or e.device_time < u.install_time_valid_until)
    group by 1`;
  const want = Object.fromEntries((await wh.query(sql)).rows.map((r) => [String(r.k), num(r.n)]));
  assert.deepEqual(got, want);
});

test('edit_step and materialize replace the layer: the new metric answers, the old one is gone', opts, async (t) => {
  if (skip(t) || !ctx) return;
  const { steps } = await engine.build_model({ action: 'preview', context_id: ctx });
  const { index } = steps.find((s) => s.stage === 'semantic_model');
  const tutorials = { fn: 'count', args: [{ fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }], then: { value: 1 } }] }] };
  await engine.build_model({ action: 'edit_step', context_id: ctx, index, step: { stage: 'semantic_model', measures: [{ name: 'tutorials', expr: tutorials }], metrics: [{ name: 'tutorials', type: 'simple', measure: 'tutorials' }] } });
  const built = await engine.raw.build_model({ action: 'materialize', context_id: ctx });
  await taskResult(engine, built.task_id);
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  const r = await engine.query_model({ context_id: ctx, steps: [metrics(['tutorials'])], time_range: WINDOW });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].tutorials), num(n));
  await assert.rejects(() => engine.query_model({ context_id: ctx, steps: [metrics(['evts'])], time_range: WINDOW }), /unknown metric in context: 'evts'. Available: tutorials/);
});

test('describe shows the layer as dbt parsed it; validate runs each metric over the window, as the warehouse counts', opts, async (t) => {
  if (skip(t) || !ctx) return;
  const described = await engine.context({ action: 'describe', context_id: ctx, metric: 'tutorials' });
  assert.equal(described.status.valid, true, JSON.stringify(described.status));
  assert.deepEqual(described.metrics.map((m) => m.name), ['tutorials']);
  const started = await engine.raw.context({ action: 'describe', context_id: ctx, validate: true, time_range: WINDOW });
  const v = await taskResult(engine, started.task_id);
  assert.equal(v.valid, true, JSON.stringify(v));
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(num(v.ran.metrics.find((x) => x.metric === 'tutorials').value), num(n));
});

test('a fork after step N is the build taken back to it: its rows are those of the steps it kept', opts, async (t) => {
  if (skip(t)) return;
  const tutorial = { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }] };
  const perPlayer = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'events', expr: { fn: 'count' } }] };
  const s = await engine.build_model({ action: 'start', name: 'fork_src', source: 'events', steps: [tutorial, perPlayer] });
  const back = await engine.build_model({ action: 'fork', context_id: s.context_id, name: 'fork_back', after: 1 });
  assert.equal(back.steps_count, 1);
  const built = await engine.raw.build_model({ action: 'materialize', context_id: back.context_id });
  const done = await taskResult(engine, built.task_id);
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(done.page?.total_rows ?? done.total_rows ?? done.rows.length, num(n), 'one row per tutorial event: the aggregate is not kept');
  // the original keeps both steps: one row per player who did a tutorial
  const orig = await taskResult(engine, (await engine.raw.build_model({ action: 'materialize', context_id: s.context_id })).task_id);
  const [{ p }] = (await wh.query("select count(distinct player_id_of_internal) as p from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(orig.page?.total_rows ?? orig.total_rows ?? orig.rows.length, num(p));
});
