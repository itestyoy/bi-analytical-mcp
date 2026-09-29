// THE PROJECT'S OWN SEMANTIC LAYER — a dbt project that declares its semantic models and metrics
// itself is read at start and queried with query_semantic_model in the context "project", with no
// build step; every number below is checked against the warehouse's own rows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { loadProjectSemantics, PROJECT_CONTEXT } from '../../src/project-semantics.js';
import { mergeModelEntry } from '../../src/semantic-latest.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, taskResult } from '../helpers/settle.js';
import { DBT_BIN, PY_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project');
const opts = { timeout: 300000 };
const WINDOW = { start: '2025-01-01', end: '2027-12-31' };

let wh; let engine; let backend; let ctxs; let loaded;

/**
 * The project's own semantic layer, laid out as a project on dbt's latest spec has it (models/core/):
 * a model the project already describes gets its semantic model merged into that entry (dbt allows one
 * entry per model); a model that exists only for the layer — a thin view — is described ONLY in the
 * layer's own file; the ratio / derived metrics are a file of their own.
 */
function declareProjectLayer() {
  const layer = yaml.load(readFileSync(join(process.cwd(), 'test', 'integration', 'fixtures', 'project_semantic_layer.yml'), 'utf8'));
  const file = join(BASE, 'models', '_models.yml');
  const doc = yaml.load(readFileSync(file, 'utf8'));
  const by = new Map(layer.models.map((m) => [m.name, m]));
  const described = new Set(doc.models.map((m) => m.name));
  doc.models = doc.models.map((m) => (by.has(m.name) ? mergeModelEntry(m, by.get(m.name)) : m));
  writeFileSync(file, yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  const core = join(BASE, 'models', 'core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'fct_project_acquisition.sql'), "{{ config(materialized='view') }}\nselect * from {{ ref('fct_player_acquisition') }}\n");
  writeFileSync(join(core, 'project_semantic_models.yml'), yaml.dump({ models: layer.models.filter((m) => !described.has(m.name)) }, { lineWidth: 120, noRefs: true }));
  writeFileSync(join(core, 'project_metrics.yml'), yaml.dump({ metrics: layer.metrics }, { lineWidth: 120, noRefs: true }));
}

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  // the layer is written in the latest spec, the one the tests' dbt (v2) reads
  if (backend.semanticSpec !== 'latest') return;
  declareProjectLayer();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'projsem-')), timeSpineDialect: 'duckdb' });
  // what the server does at start, before the tools are served
  loaded = await loadProjectSemantics({ runner: backend, contextManager: ctxs });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend, project: loaded }));
}, opts);

after(async () => { backend?.close(); if (wh) await wh.stop(); });
const skip = (t) => {
  if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; }
  if (backend.semanticSpec !== 'latest') { t.skip('the fixture layer is in dbt\'s latest spec'); return true; }
  return false;
};

const q = (input) => engine.query_semantic_model({ context_id: PROJECT_CONTEXT, time_range: WINDOW, ...input });
const rowsOf = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.rows; };
const num = (v) => Number(v);

test('the project\'s own metrics are read at start and listed — each with what it can be grouped by — with nothing built', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(loaded?.layer, JSON.stringify(loaded));
  const o = (await engine.semantic_index({})).project_semantic_layer;
  assert.equal(o.context_id, PROJECT_CONTEXT);
  assert.deepEqual(o.metrics.map((m) => m.name), [
    'project_active_players', 'project_clicks', 'project_cost', 'project_cost_avg', 'project_cost_max', 'project_cost_per_touch', 'project_ctr',
    'project_events_per_player', 'project_events_total', 'project_impressions', 'project_impressions_last_day', 'project_paid_rows', 'project_touches',
  ]);
  const of = (name) => o.metrics.find((m) => m.name === name);
  assert.deepEqual(of('project_events_total').semantic_models, ['project_events']);
  assert.deepEqual(of('project_events_total').dimensions_from, ['project_events']);
  const dims = (sm) => o.semantic_models.find((x) => x.name === sm).dimensions.map((d) => d.name).sort();
  assert.deepEqual(dims('project_events'), ['bundle_id', 'event_at', 'event_name']);
  assert.deepEqual(dims('project_acquisition'), ['campaign', 'spend_date']);
  // a ratio over a derived metric reads what its inputs read, and groups by the same — the keys
  // declared only as entities included
  assert.deepEqual(of('project_cost_per_touch').semantic_models, ['project_acquisition']);
  assert.deepEqual(of('project_cost_per_touch').dimensions_from, ['project_acquisition']);
  // what the project says about reading a metric comes with it
  assert.deepEqual(of('project_cost_max').meta, { additive: false });
  // (the model-level primary_entity has no column behind it: it addresses the dimensions, it is not a key to group by)
  assert.deepEqual(of('project_cost_per_touch').entities, ['media_source', 'player']);
  assert.equal((await engine.context({ action: 'describe', context_id: PROJECT_CONTEXT })).engine, 'project');
});

test('a query of the project\'s metric by one of its dimensions is the warehouse\'s own count', opts, async (t) => {
  if (skip(t)) return;
  const want = (await wh.query('select event_name, count(event_id) as n from fct_analytics_events group by 1')).rows;
  const got = rowsOf(await q({ metrics: ['project_events_total'], group_by: [{ semantic_model: 'project_events', dimension: 'event_name' }] }));
  assert.deepEqual(Object.fromEntries(got.map((r) => [r.project_events_event_name, num(r.project_events_total)])), Object.fromEntries(want.map((r) => [r.event_name, num(r.n)])));
});

test('by day, a distinct count, a ratio and a filter — each the rows\' own numbers', opts, async (t) => {
  if (skip(t)) return;
  const perDay = (await wh.query("select cast(device_time as date) as d, count(distinct player_id_of_internal) as p, count(event_id) as n from fct_analytics_events group by 1")).rows;
  const byDay = rowsOf(await q({ metrics: ['project_active_players', 'project_events_per_player'], group_by: [{ time: 'metric_time', grain: 'day' }] }));
  const day = (v) => String(v).slice(0, 10);
  assert.deepEqual(Object.fromEntries(byDay.map((r) => [day(r.metric_time_day), num(r.project_active_players)])), Object.fromEntries(perDay.map((r) => [day(r.d), num(r.p)])));
  for (const r of byDay) {
    const w = perDay.find((x) => day(x.d) === day(r.metric_time_day));
    assert.ok(Math.abs(num(r.project_events_per_player) - num(w.n) / num(w.p)) < 1e-9, day(r.metric_time_day));
  }
  // the project's own time dimension, at a grain
  const byEventDay = rowsOf(await q({ metrics: ['project_events_total'], group_by: [{ semantic_model: 'project_events', dimension: 'event_at', grain: 'day' }] }));
  assert.deepEqual(Object.fromEntries(byEventDay.map((r) => [day(r.project_events_event_at_day), num(r.project_events_total)])), Object.fromEntries(perDay.map((r) => [day(r.d), num(r.n)])));
  // a where on its dimension
  const [one] = (await wh.query("select count(event_id) as n from fct_analytics_events where event_name in ('tutorial', 'level_started')")).rows;
  const filtered = rowsOf(await q({ metrics: ['project_events_total'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', semantic_model: 'project_events', dimension: 'event_name' }, op: 'in', value: ['tutorial', 'level_started'] }] } }));
  assert.equal(num(filtered[0].project_events_total), num(one.n));
});

test('by a key declared only as an entity: sums, a max and an average over nullif, a boolean sum, a ratio, and a ratio over a derived metric', opts, async (t) => {
  if (skip(t)) return;
  const want = (await wh.query(`select media_source, sum(cost) as cost, sum(clicks) as clicks, sum(impressions) as impressions,
      max(nullif(cost, 0)) as cost_max, avg(nullif(cost, 0)) as cost_avg, sum(case when cost > 0 then 1 else 0 end) as paid
    from fct_player_acquisition group by 1`)).rows;
  const got = rowsOf(await q({
    metrics: ['project_cost', 'project_ctr', 'project_cost_per_touch', 'project_cost_max', 'project_cost_avg', 'project_paid_rows', 'project_touches'],
    group_by: [{ entity: 'media_source' }], order_by: [{ key: { entity: 'media_source' } }],
  }));
  assert.deepEqual(got.map((r) => r.media_source), want.map((r) => r.media_source).sort());
  const close = (a, b, what) => (b == null ? assert.equal(a, null, what) : assert.ok(Math.abs(num(a) - num(b)) < 1e-9, `${what}: ${a} vs ${b}`));
  for (const w of want) {
    const r = got.find((x) => x.media_source === w.media_source);
    close(r.project_cost, w.cost, `${w.media_source} cost`);
    close(r.project_touches, num(w.clicks) + num(w.impressions), `${w.media_source} touches`);
    close(r.project_ctr, num(w.impressions) ? num(w.clicks) / num(w.impressions) : null, `${w.media_source} ctr`);
    close(r.project_cost_per_touch, num(w.clicks) + num(w.impressions) ? num(w.cost) / (num(w.clicks) + num(w.impressions)) : null, `${w.media_source} cost per touch`);
    // an organic row has no spend: nullif keeps it out of the max and the average
    close(r.project_cost_max, w.cost_max, `${w.media_source} max`);
    close(r.project_cost_avg, w.cost_avg, `${w.media_source} avg`);
    close(r.project_paid_rows, w.paid, `${w.media_source} paid rows`);
  }
  // a where on the entity and on a dimension
  const [one] = (await wh.query("select sum(cost) as cost from fct_player_acquisition where media_source in ('meta', 'google') and campaign <> 'search_brand'")).rows;
  const filtered = rowsOf(await q({ metrics: ['project_cost'], where: { op: 'and', conditions: [
    { field: { kind: 'entity', entity: 'media_source' }, op: 'in', value: ['meta', 'google'] },
    { field: { kind: 'dimension', semantic_model: 'project_acquisition', dimension: 'campaign' }, op: 'neq', value: 'search_brand' },
  ] } }));
  close(filtered[0].project_cost, one.cost, 'filtered cost');
});

test('a snapshot metric (non_additive_dimension) takes the last day of the period; by day it is each day\'s own sum', opts, async (t) => {
  if (skip(t)) return;
  const [last] = (await wh.query('select sum(impressions) as n from fct_player_acquisition where spend_date = (select max(spend_date) from fct_player_acquisition)')).rows;
  const whole = rowsOf(await q({ metrics: ['project_impressions_last_day', 'project_impressions'] }));
  const [all] = (await wh.query('select sum(impressions) as n from fct_player_acquisition')).rows;
  assert.equal(num(whole[0].project_impressions_last_day), num(last.n));
  assert.equal(num(whole[0].project_impressions), num(all.n));
  const perDay = (await wh.query('select spend_date as d, sum(impressions) as n from fct_player_acquisition group by 1')).rows;
  const byDay = rowsOf(await q({ metrics: ['project_impressions_last_day'], group_by: [{ semantic_model: 'project_acquisition', dimension: 'spend_date', grain: 'day' }] }));
  const day = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  assert.deepEqual(Object.fromEntries(byDay.map((r) => [day(r.project_acquisition_spend_date_day), num(r.project_impressions_last_day)])), Object.fromEntries(perDay.map((r) => [day(r.d), num(r.n)])));
});

test('what the project does not define is refused in the call, naming what it does', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const refused = (input, re) => assert.rejects(Promise.resolve().then(() => raw.query_semantic_model({ context_id: PROJECT_CONTEXT, ...input })), re);
  await refused({ metrics: ['project_events_totl'] }, /not a metric of the project.*project_events_total/);
  await refused({ metrics: ['project_events_total'], group_by: [{ semantic_model: 'project_events', dimension: 'no_such' }] }, /not a dimension project_events_total can be grouped by.*event_name/);
  await refused({ metrics: ['project_events_total'], group_by: [{ model: 'users', attribute: 'country' }] }, /semantic_model, dimension/);
  // an entity only the acquisition model carries is not one the events metric reaches
  await refused({ metrics: ['project_events_total'], group_by: [{ entity: 'media_source' }] }, /not one project_events_total can be grouped by.*player/);
  // the project's context is read as it is: not built on, not dropped
  await assert.rejects(Promise.resolve().then(() => raw.build_semantic_model({ context_id: PROJECT_CONTEXT, name: 'xyz', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count', field: '*' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }] })), /own semantic layer/);
  await assert.rejects(Promise.resolve().then(() => raw.context({ action: 'drop', context_id: PROJECT_CONTEXT })), /nothing to drop/);
  // …by any tool that would write into it
  await assert.rejects(Promise.resolve().then(() => raw.build_semantic_model({ action: 'update', context_id: PROJECT_CONTEXT, semantic_model: 'events', remove_metrics: ['project_cost'] })), /own semantic layer/);
  await assert.rejects(Promise.resolve().then(() => raw.build_pipeline_model({ action: 'start', name: 'xyz', source: 'events', draft_id: PROJECT_CONTEXT })), /own semantic layer/);
  await assert.rejects(Promise.resolve().then(() => raw.register_native_model({ context_id: PROJECT_CONTEXT, name: 'xyz', pipeline: { source: 'events', stages: [{ stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] }] } })), /own semantic layer/);
  // and it still serves its layer after them
  assert.ok(rowsOf(await q({ metrics: ['project_cost'] }))[0].project_cost != null);
});

test('a task of one\'s own over the same project is built and queried as before, next to the project\'s layer', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_semantic_model({
    name: 'own', semantic_models: [{ from: 'events', event_scope: { event_name: ['tutorial'] }, measures: [{ name: 'tutorials', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'tutorials', type: 'simple', measure: { name: 'tutorials' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = rowsOf(await engine.query_semantic_model({ context_id: out.context_id, metrics: ['own_tutorials'], time_range: WINDOW }));
  const [want] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  assert.equal(num(r[0].own_tutorials), num(want.n));
  // the context holds its own layer only: the project's is served from the context "project"
  assert.deepEqual(backend.semanticManifest(ctxs.dir(out.context_id)).semantic_models.map((sm) => sm.name).filter((n) => n.startsWith('project_')), []);
  // a project dimension is not addressed there: it belongs to the project's context
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: out.context_id, metrics: ['own_tutorials'], group_by: [{ semantic_model: 'project_events', dimension: 'event_name' }] })), /context 'project'/);
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: out.context_id, metrics: ['own_tutorials'], group_by: [{ entity: 'media_source' }] })), /context 'project'/);
});

test('queries of the project\'s layer started together run side by side, each with its own numbers', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const a = await raw.query_semantic_model({ context_id: PROJECT_CONTEXT, metrics: ['project_cost'], time_range: WINDOW });
  const b = await raw.query_semantic_model({ context_id: PROJECT_CONTEXT, metrics: ['project_events_total'], time_range: WINDOW });
  // the second is not queued behind the first: both are running before either is read
  assert.equal(raw.jobs.get(a.task_id).status, 'running');
  assert.equal(raw.jobs.get(b.task_id).status, 'running');
  const [ra, rb] = [await taskResult(raw, a.task_id), await taskResult(raw, b.task_id)];
  const [{ cost }] = (await wh.query('select sum(cost) as cost from fct_player_acquisition')).rows;
  const [{ n }] = (await wh.query('select count(event_id) as n from fct_analytics_events')).rows;
  assert.ok(Math.abs(num(ra.rows[0].project_cost) - num(cost)) < 1e-9);
  assert.equal(num(rb.rows[0].project_events_total), num(n));
});

test('a stored result of the project\'s layer outlives a restart, and ages out like any context\'s', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const want = Object.fromEntries((await wh.query('select media_source, sum(clicks) as n from fct_player_acquisition group by 1')).rows.map((r) => [r.media_source, num(r.n)]));
  const stored = await q({ metrics: ['project_clicks'], group_by: [{ entity: 'media_source' }], materialize: true });
  assert.equal(stored.ok, true, JSON.stringify(stored.error));
  // a restart: the project is read again into a fresh copy, and the held response is forgotten
  const again = await loadProjectSemantics({ runner: backend, contextManager: ctxs });
  assert.ok(again?.layer, JSON.stringify(again));
  raw._taskResults.delete(stored.task_id);
  const read = await raw.query_semantic_model({ task_id: stored.task_id });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.deepEqual(Object.fromEntries(read.rows.map((r) => [r.media_source, num(r.project_clicks)])), want);
  // the retention: the context stays, its results older than the TTL go
  await new Promise((r) => { setTimeout(r, 20); });
  engine.gc(10);
  assert.equal(ctxs.has(PROJECT_CONTEXT), true);
  const gone = await raw.query_semantic_model({ task_id: stored.task_id });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'result_gone');
});
