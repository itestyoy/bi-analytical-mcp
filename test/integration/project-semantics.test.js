// THE PROJECT'S OWN SEMANTIC LAYER — a dbt project that declares its semantic models and metrics
// itself is read at start and queried with query_semantic_model in the context "project", with no
// build step; every number below is checked against the warehouse's own rows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { loadProjectSemantics, PROJECT_STORE } from '../../src/project-semantics.js';
import { mergeModelEntry } from '../../src/semantic-latest.js';
import { createDbt, DEFAULT_ENV } from '../../src/dbt/index.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, taskResult, isStartedTask } from '../helpers/settle.js';
import { DBT_BIN, PY_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project');
const opts = { timeout: 300000 };
const WINDOW = { start: '2025-01-01', end: '2027-12-31' };

let wh; let engine; let backend; let ctxs; let loaded;

const CHANNEL_OF_ROW = "case when campaign = 'winter_promo' then 'paid' else 'organic' end";
const CHANNEL_OF_SOURCE = "case when media_source = 'organic' then 'organic' else 'paid' end";

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
  // (a column named the way a project names its amounts — with `__` in it, which nothing may rewrite)
  // two different channels, so the two ways to project_channels give different numbers: the one a spend
  // row is booked under (by its campaign) and the one its media source belongs to
  writeFileSync(join(core, 'fct_project_acquisition.sql'), `{{ config(materialized='view') }}\nselect *, impressions as measure__impressions, ${CHANNEL_OF_ROW} as channel from {{ ref('fct_player_acquisition') }}\n`);
  writeFileSync(join(core, 'fct_project_media_sources.sql'), `{{ config(materialized='view') }}\nselect distinct media_source, upper(media_source) as source_label, ${CHANNEL_OF_SOURCE} as channel from {{ ref('fct_player_acquisition') }}\n`);
  writeFileSync(join(core, 'fct_project_channels.sql'), "{{ config(materialized='view') }}\nselect channel, upper(channel) as channel_kind from (select 'paid' as channel union all select 'organic')\n");
  writeFileSync(join(core, 'project_semantic_models.yml'), yaml.dump({ models: layer.models.filter((m) => !described.has(m.name)) }, { lineWidth: 120, noRefs: true }));
  writeFileSync(join(core, 'project_metrics.yml'), yaml.dump({ metrics: layer.metrics }, { lineWidth: 120, noRefs: true }));
}

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  backend = testDbt({ profilesDir: BASE });
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

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => {
  if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; }
  if (backend.semanticSpec !== 'latest') { t.skip('the fixture layer is in dbt\'s latest spec'); return true; }
  return false;
};

// each of the project's semantic models is a context of its own, named after it
const EV = 'project_events';
const ACQ = 'project_acquisition';
const q = (context_id, input) => engine.query_semantic_model({ context_id, time_range: WINDOW, ...input });
const rowsOf = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.rows; };
const num = (v) => Number(v);

test('each of the project\'s semantic models is read at start as a context named after it — its metrics, each with what it can be grouped by — with nothing built', opts, async (t) => {
  if (skip(t)) return;
  assert.ok(loaded?.layer, JSON.stringify(loaded));
  assert.deepEqual(loaded.contexts.sort(), [ACQ, EV]);
  const o = (await engine.semantic_index({})).project_semantic_layer;
  const ctxOf = (id) => o.contexts.find((c) => c.context_id === id);
  const names = (id) => ctxOf(id).metrics.map((m) => m.name);
  assert.deepEqual(names(ACQ), [
    'project_clicks', 'project_cost', 'project_cost_avg', 'project_cost_max', 'project_cost_per_touch', 'project_ctr',
    'project_events_per_click', 'project_impressions', 'project_impressions_last_day', 'project_paid_rows', 'project_touches',
  ]);
  // a metric of two semantic models is in the context of each
  assert.deepEqual(names(EV), ['project_active_players', 'project_events_per_click', 'project_events_per_player', 'project_events_total']);
  const of = (id, name) => ctxOf(id).metrics.find((m) => m.name === name);
  assert.deepEqual(of(EV, 'project_events_total').dimensions_from, [EV]);
  assert.deepEqual(ctxOf(EV).dimensions.map((d) => d.name).sort(), ['bundle_id', 'event_at', 'event_name']);
  assert.deepEqual(ctxOf(ACQ).dimensions.map((d) => d.name).sort(), ['campaign', 'spend_date']);
  // a ratio over a derived metric reads what its inputs read, and groups by the same — the keys
  // declared only as entities included
  assert.deepEqual(of(ACQ, 'project_cost_per_touch').semantic_models, [ACQ]);
  // its own model's dimensions, and those of the model its media_source entity joins onto
  assert.deepEqual(of(ACQ, 'project_cost_per_touch').dimensions_from.sort(), [ACQ, 'project_channels', 'project_media_sources']);
  // what the project says about reading a metric comes with it
  assert.deepEqual(of(ACQ, 'project_cost_max').meta, { additive: false });
  // (the model-level primary_entity has no column behind it: it addresses the dimensions, it is not a key to group by)
  assert.deepEqual(of(ACQ, 'project_cost_per_touch').entities, [{ entity: 'channel' }, { entity: 'media_source' }, { entity: 'player' }]);
  const described = await engine.context({ action: 'describe', context_id: ACQ });
  assert.equal(described.engine, 'project');
  assert.equal(described.context_id, ACQ);
  // the tools that take one of them offer them as values, and still take any id a build returned
  for (const tool of ['query_semantic_model', 'preview_semantic_model', 'context']) {
    const [presets, built] = engine.schemas[tool].properties.context_id.anyOf;
    assert.deepEqual(presets.enum, [ACQ, EV], tool);
    assert.ok(built.pattern, tool);
  }
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: 'Not-An-Id', metrics: ['project_cost'] })), /context_id/);
  // the parsed copy they share is nobody's to address, nor listed
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: PROJECT_STORE, metrics: ['project_cost'] })), /context_id/);
  assert.equal((await engine.context({ action: 'list' })).contexts?.some?.((c) => c.context_id === PROJECT_STORE) ?? false, false);
});

test('the dbt client the server runs on (createDbt, the `mf` CLI) reads the same layer — MetricFlow\'s group-bys included — and answers with the warehouse\'s numbers', opts, async (t) => {
  if (skip(t)) return;
  const client = createDbt({ environment: process.env.DBT_ENV || DEFAULT_ENV, profilesDir: BASE });
  const cm = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'projsem-client-')), timeSpineDialect: 'duckdb' });
  const viaClient = await loadProjectSemantics({ runner: client, contextManager: cm });
  assert.ok(viaClient?.layer, JSON.stringify(viaClient));
  assert.deepEqual(viaClient.contexts.sort(), loaded.contexts.sort());
  const tokens = (l) => Object.fromEntries(Object.entries(l.layer.groupBys).map(([m, items]) => [m, items.map((i) => `${i.kind}:${i.dunder_name || i.name}`).sort()]));
  assert.deepEqual(tokens(viaClient), tokens(loaded));
  const eng = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: cm, runner: client, project: viaClient }));
  const want = Object.fromEntries((await wh.query('select upper(media_source) as label, sum(cost) as cost from fct_player_acquisition group by 1')).rows.map((r) => [r.label, num(r.cost)]));
  const got = rowsOf(await eng.query_semantic_model({ context_id: ACQ, metrics: ['project_cost'], group_by: [{ semantic_model: ['project_media_sources'], dimension: 'label' }], time_range: WINDOW }));
  for (const [label, cost] of Object.entries(want)) assert.ok(Math.abs(num(got.find((r) => r.project_media_sources_label === label).project_cost) - cost) < 1e-9, label);
});

test('a query of the project\'s metric by one of its dimensions is the warehouse\'s own count', opts, async (t) => {
  if (skip(t)) return;
  const want = (await wh.query('select event_name, count(event_id) as n from fct_analytics_events group by 1')).rows;
  const got = rowsOf(await q(EV, { metrics: ['project_events_total'], group_by: [{ semantic_model: [EV], dimension: 'event_name' }] }));
  assert.deepEqual(Object.fromEntries(got.map((r) => [r.project_events_event_name, num(r.project_events_total)])), Object.fromEntries(want.map((r) => [r.event_name, num(r.n)])));
});

test('by day, a distinct count, a ratio and a filter — each the rows\' own numbers', opts, async (t) => {
  if (skip(t)) return;
  const perDay = (await wh.query("select cast(device_time as date) as d, count(distinct player_id_of_internal) as p, count(event_id) as n from fct_analytics_events group by 1")).rows;
  const byDay = rowsOf(await q(EV, { metrics: ['project_active_players', 'project_events_per_player'], group_by: [{ time: 'metric_time', grain: 'day' }] }));
  const day = (v) => String(v).slice(0, 10);
  assert.deepEqual(Object.fromEntries(byDay.map((r) => [day(r.metric_time_day), num(r.project_active_players)])), Object.fromEntries(perDay.map((r) => [day(r.d), num(r.p)])));
  for (const r of byDay) {
    const w = perDay.find((x) => day(x.d) === day(r.metric_time_day));
    assert.ok(Math.abs(num(r.project_events_per_player) - num(w.n) / num(w.p)) < 1e-9, day(r.metric_time_day));
  }
  // the project's own time dimension, at a grain
  const byEventDay = rowsOf(await q(EV, { metrics: ['project_events_total'], group_by: [{ semantic_model: [EV], dimension: 'event_at', grain: 'day' }] }));
  assert.deepEqual(Object.fromEntries(byEventDay.map((r) => [day(r.project_events_event_at_day), num(r.project_events_total)])), Object.fromEntries(perDay.map((r) => [day(r.d), num(r.n)])));
  // a where on its dimension
  const [one] = (await wh.query("select count(event_id) as n from fct_analytics_events where event_name in ('tutorial', 'level_started')")).rows;
  const filtered = rowsOf(await q(EV, { metrics: ['project_events_total'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', semantic_model: [EV], dimension: 'event_name' }, op: 'in', value: ['tutorial', 'level_started'] }] } }));
  assert.equal(num(filtered[0].project_events_total), num(one.n));
});

test('by a key declared only as an entity: sums, a max and an average over nullif, a boolean sum, a ratio, and a ratio over a derived metric', opts, async (t) => {
  if (skip(t)) return;
  const want = (await wh.query(`select media_source, sum(cost) as cost, sum(clicks) as clicks, sum(impressions) as impressions,
      max(nullif(cost, 0)) as cost_max, avg(nullif(cost, 0)) as cost_avg, sum(case when cost > 0 then 1 else 0 end) as paid
    from fct_player_acquisition group by 1`)).rows;
  const got = rowsOf(await q(ACQ, {
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
  const filtered = rowsOf(await q(ACQ, { metrics: ['project_cost'], where: { op: 'and', conditions: [
    { field: { kind: 'entity', entity: 'media_source' }, op: 'in', value: ['meta', 'google'] },
    { field: { kind: 'dimension', semantic_model: [ACQ], dimension: 'campaign' }, op: 'neq', value: 'search_brand' },
  ] } }));
  close(filtered[0].project_cost, one.cost, 'filtered cost');
});

test('a snapshot metric (non_additive_dimension) takes the last day of the period; by day it is each day\'s own sum', opts, async (t) => {
  if (skip(t)) return;
  const [last] = (await wh.query('select sum(impressions) as n from fct_player_acquisition where spend_date = (select max(spend_date) from fct_player_acquisition)')).rows;
  const whole = rowsOf(await q(ACQ, { metrics: ['project_impressions_last_day', 'project_impressions'] }));
  const [all] = (await wh.query('select sum(impressions) as n from fct_player_acquisition')).rows;
  assert.equal(num(whole[0].project_impressions_last_day), num(last.n));
  assert.equal(num(whole[0].project_impressions), num(all.n));
  const perDay = (await wh.query('select spend_date as d, sum(impressions) as n from fct_player_acquisition group by 1')).rows;
  const byDay = rowsOf(await q(ACQ, { metrics: ['project_impressions_last_day'], group_by: [{ semantic_model: [ACQ], dimension: 'spend_date', grain: 'day' }] }));
  const day = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  assert.deepEqual(Object.fromEntries(byDay.map((r) => [day(r.project_acquisition_spend_date_day), num(r.project_impressions_last_day)])), Object.fromEntries(perDay.map((r) => [day(r.d), num(r.n)])));
});

test('what the project does not define is refused in the call, naming what it does', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const refused = (input, re) => assert.rejects(Promise.resolve().then(() => raw.query_semantic_model({ context_id: EV, ...input })), re);
  await refused({ metrics: ['project_events_totl'] }, /not a metric of the context 'project_events'.*project_events_total/);
  // a metric of another semantic model is named with the context it lives in
  await refused({ metrics: ['project_cost'] }, /not a metric of the context 'project_events' — it reads project_acquisition: query it in the context 'project_acquisition'/);
  await refused({ metrics: ['project_events_total'], group_by: [{ semantic_model: [EV], dimension: 'no_such' }] }, /not a dimension project_events_total can be grouped by.*event_name/);
  await refused({ metrics: ['project_events_total'], group_by: [{ model: 'users', attribute: 'country' }] }, /\{ semantic_model: \[the chain of models it is reached through\], dimension \}/);
  // an entity only the acquisition model carries is not one the events metric reaches
  await refused({ metrics: ['project_events_total'], group_by: [{ entity: 'media_source' }] }, /not one project_events_total can be grouped by.*player/);
  // the project's contexts are read as they are: not built on, not dropped
  await assert.rejects(Promise.resolve().then(() => raw.build_semantic_model({ context_id: ACQ, name: 'xyz', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count', field: '*' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }] })), /own semantic layer/);
  await assert.rejects(Promise.resolve().then(() => raw.context({ action: 'drop', context_id: ACQ })), /nothing to drop/);
  // …not even as a dry run of a declaration over it
  await assert.rejects(Promise.resolve().then(() => raw.build_semantic_model({ context_id: ACQ, dry_run: true, name: 'xyz', semantic_models: [{ from: 'events', measures: [{ name: 'n', agg: 'count', field: '*' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }] })), /own semantic layer/);
  // …by any tool that would write into it
  await assert.rejects(Promise.resolve().then(() => raw.build_semantic_model({ action: 'update', context_id: ACQ, semantic_model: 'events', remove_metrics: ['project_cost'] })), /own semantic layer/);
  await assert.rejects(Promise.resolve().then(() => raw.build_pipeline_model({ action: 'start', name: 'xyz', source: 'events', draft_id: ACQ })), /own semantic layer/);
  await assert.rejects(Promise.resolve().then(() => raw.register_native_model({ context_id: EV, name: 'xyz', pipeline: { source: 'events', stages: [{ stage: 'join', with: 'users', via: 'user', kind: 'inner', attrs: ['country'] }] } })), /own semantic layer/);
  // and it still serves its layer after them
  assert.ok(rowsOf(await q(ACQ, { metrics: ['project_cost'] }))[0].project_cost != null);
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
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: out.context_id, metrics: ['own_tutorials'], group_by: [{ semantic_model: [EV], dimension: 'event_name' }] })), /'project_events\.event_name' is named as a dimension of the dbt project's own semantic layer.*context_id: its name/);
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: out.context_id, metrics: ['own_tutorials'], group_by: [{ entity: 'media_source' }] })), /context of one of its semantic models/);
  // …and a where named that way is refused the same way, with the way this context names it
  const whereOf = (field) => ({ context_id: out.context_id, metrics: ['own_tutorials'], time_range: WINDOW, where: { op: 'and', conditions: [{ field, op: 'eq', value: 'x' }] } });
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model(whereOf({ kind: 'dimension', semantic_model: [EV], dimension: 'country' }))), (e) => e.name === 'ToolError' && /dimension of the dbt project's own semantic layer.*\{ model, attribute \}/.test(e.message));
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model(whereOf({ kind: 'entity', entity: 'player' }))), (e) => e.name === 'ToolError' && /entity 'player'.*\{ model, attribute \}/.test(e.message));
});

test('queries of the project\'s layer started together run side by side, each with its own numbers', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const a = await raw.query_semantic_model({ context_id: ACQ, metrics: ['project_cost'], time_range: WINDOW });
  const b = await raw.query_semantic_model({ context_id: EV, metrics: ['project_events_total'], time_range: WINDOW });
  const c = await raw.query_semantic_model({ context_id: ACQ, metrics: ['project_clicks'], time_range: WINDOW });
  // the second is not queued behind the first: both are running before either is read
  assert.equal(raw.jobs.get(a.task_id).status, 'running');
  assert.equal(raw.jobs.get(b.task_id).status, 'running');
  assert.equal(raw.jobs.get(c.task_id).status, 'running');
  const [ra, rb, rc] = [await taskResult(raw, a.task_id), await taskResult(raw, b.task_id), await taskResult(raw, c.task_id)];
  const [{ cost }] = (await wh.query('select sum(cost) as cost from fct_player_acquisition')).rows;
  const [{ n }] = (await wh.query('select count(event_id) as n from fct_analytics_events')).rows;
  assert.ok(Math.abs(num(ra.rows[0].project_cost) - num(cost)) < 1e-9);
  assert.equal(num(rb.rows[0].project_events_total), num(n));
  const [{ clicks }] = (await wh.query('select sum(clicks) as clicks from fct_player_acquisition')).rows;
  assert.equal(num(rc.rows[0].project_clicks), num(clicks));
});

test('a stored result of the project\'s layer outlives a restart — even one whose project does not parse — is held while a pipeline reads it, and ages out like any context\'s', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  const want = Object.fromEntries((await wh.query('select media_source, sum(clicks) as n from fct_player_acquisition group by 1')).rows.map((r) => [r.media_source, num(r.n)]));
  const stored = await q(ACQ, { metrics: ['project_clicks'], group_by: [{ entity: 'media_source' }], materialize: true });
  assert.equal(stored.ok, true, JSON.stringify(stored.error));
  // a read of what is stored, not of the response still held in memory (a restart forgets that)
  const readStored = async (id) => { raw._taskResults.delete(id); return raw.query_semantic_model({ task_id: id }); };
  const readBack = () => readStored(stored.task_id);
  const clicks = (r) => Object.fromEntries(r.rows.map((x) => [x.media_source, num(x.project_clicks)]));
  // a start whose project does not parse serves nothing, and keeps what earlier starts stored
  const metricsFile = join(BASE, 'models', 'core', 'project_metrics.yml');
  const good = readFileSync(metricsFile, 'utf8');
  writeFileSync(metricsFile, 'metrics:\n  - name: [not closed\n'); // a property file dbt cannot read
  let failed;
  try { failed = await loadProjectSemantics({ runner: backend, contextManager: ctxs }); } finally { writeFileSync(metricsFile, good); }
  assert.ok(failed?.error, JSON.stringify(failed));
  assert.ok(ctxs.resultModels(PROJECT_STORE).some((m) => m.name === `qr_${stored.task_id}`), 'the stored result is kept');
  // the next start that parses serves it again, the warehouse's own numbers
  const again = await loadProjectSemantics({ runner: backend, contextManager: ctxs });
  assert.ok(again?.layer, JSON.stringify(again));
  const read = await readBack();
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.deepEqual(clicks(read), want);
  // a result a pipeline was started from is held through the retention (as gc holds any owner a draft
  // reads), while one nothing reads ages out
  const base = await q(ACQ, { metrics: ['project_clicks'], group_by: [{ entity: 'media_source' }], materialize: true });
  const draft = await raw.build_pipeline_model({ action: 'start', name: 'from_clicks', source: 'events', from_task: base.task_id });
  assert.ok(draft.draft_id, JSON.stringify(draft));
  await new Promise((r) => { setTimeout(r, 20); });
  engine.gc(10); // the store's results are swept first (the draft still reads `base`), then idle contexts — the draft among them
  const held = await readStored(base.task_id);
  assert.equal(held.ok, true, JSON.stringify(held.error));
  assert.deepEqual(clicks(held), want);
  const aged = await readBack();
  assert.equal(aged.ok, false);
  assert.equal(aged.error.code, 'result_gone');
  assert.equal(ctxs.has(draft.draft_id), false, 'the idle draft itself was reclaimed');
  // once nothing reads it, it ages out too: the context stays, the result goes
  engine.gc(10);
  assert.equal(ctxs.has(ACQ), true);
  const gone = await readStored(base.task_id);
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'result_gone');
});

// ---- preview_semantic_model: a context's layer as dbt parsed it, and checked by running it ----

const preview = (input) => (engine.raw || engine).preview_semantic_model(input);

test('a preview of a project metric lists every cut it takes — and each one, queried, is the warehouse\'s own number', opts, async (t) => {
  if (skip(t)) return;
  const p = await preview({ context_id: ACQ, metric: 'project_cost' });
  assert.equal(p.status.valid, true, JSON.stringify(p.status.issues));
  const [m] = p.metrics;
  assert.equal(m.name, 'project_cost');
  const [{ total }] = (await wh.query('select sum(cost) as total from fct_player_acquisition')).rows;
  const cuts = [...m.group_by.dimensions, ...m.group_by.entities];
  assert.ok(cuts.length >= 3, JSON.stringify(m.group_by));
  for (const cut of cuts) {
    // every cut, spelled as the preview gives it, is taken by the query and sums to the total
    const rows = rowsOf(await q(ACQ, { metrics: ['project_cost'], group_by: [cut] }));
    const sum = rows.reduce((a, r) => a + num(r.project_cost ?? 0), 0);
    assert.ok(Math.abs(sum - num(total)) < 1e-9, `${JSON.stringify(cut)}: ${sum} vs ${total}`);
  }
});

test('a ratio has the time axis of its inputs: the preview offers metric_time for it, and grouping by it is the rows\' own numbers', opts, async (t) => {
  if (skip(t)) return;
  const p = await preview({ context_id: EV, metric: 'project_events_per_player' });
  const axis = p.metrics.find((m) => m.name === 'project_events_per_player').group_by.metric_time;
  assert.deepEqual(axis, { grain: 'day' });
  const got = rowsOf(await q(EV, { metrics: ['project_events_per_player'], group_by: [{ time: 'metric_time', grain: axis.grain }] }));
  const want = (await wh.query('select cast(device_time as date) as d, count(event_id) * 1.0 / count(distinct player_id_of_internal) as r from fct_analytics_events group by 1')).rows;
  const day = (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  for (const w of want) {
    const r = got.find((x) => day(x.metric_time_day) === day(w.d));
    assert.ok(r && Math.abs(num(r.project_events_per_player) - num(w.r)) < 1e-9, day(w.d));
  }
});

test('a dimension of another semantic model is named by where it lives — MetricFlow makes the join — and is the warehouse\'s own join', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  // the preview lists it as the query takes it: what and where, no path (MetricFlow lists one)
  const p = await preview({ context_id: ACQ, metric: 'project_cost' });
  const joined = { semantic_model: ['project_media_sources'], dimension: 'label' };
  assert.ok(p.metrics[0].group_by.dimensions.some((d) => JSON.stringify(d) === JSON.stringify(joined)), JSON.stringify(p.metrics[0].group_by));
  // named as if it were the context's own, it is refused saying where it lives
  await assert.rejects(Promise.resolve().then(() => raw.query_semantic_model({ context_id: ACQ, metrics: ['project_cost'], group_by: [{ semantic_model: [ACQ], dimension: 'label' }] })), /not a dimension of project_acquisition; it is .*semantic_model: \["project_media_sources"\]/);
  // the numbers of the same join made by hand
  const want = Object.fromEntries((await wh.query('select upper(a.media_source) as label, sum(a.cost) as cost from fct_player_acquisition a group by 1')).rows.map((r) => [r.label, num(r.cost)]));
  const got = rowsOf(await q(ACQ, { metrics: ['project_cost'], group_by: [joined] }));
  assert.deepEqual(Object.keys(got[0]).sort(), ['project_cost', 'project_media_sources_label']);
  for (const [label, cost] of Object.entries(want)) assert.ok(Math.abs(num(got.find((r) => r.project_media_sources_label === label).project_cost) - cost) < 1e-9, label);
  // a path is not a thing to spell: only the chain of models
  await assert.rejects(Promise.resolve().then(() => raw.query_semantic_model({ context_id: ACQ, metrics: ['project_cost'], group_by: [{ ...joined, via: 'media_source' }] })), /via/);
  // a where on it
  const [{ meta }] = (await wh.query("select sum(cost) as meta from fct_player_acquisition where upper(media_source) = 'META'")).rows;
  const filtered = rowsOf(await q(ACQ, { metrics: ['project_cost'], where: { op: 'and', conditions: [{ field: { kind: 'dimension', ...joined }, op: 'eq', value: 'META' }] } }));
  assert.ok(Math.abs(num(filtered[0].project_cost) - num(meta)) < 1e-9);
});

test('a dimension reached through a chain of joins is named by the chain of semantic models — and the chain, not a shorter way, is what is joined', opts, async (t) => {
  if (skip(t)) return;
  const direct = { semantic_model: ['project_channels'], dimension: 'kind' };
  const chain = { semantic_model: ['project_media_sources', 'project_channels'], dimension: 'kind' };
  // the preview lists both, each as the query takes it
  const listed = (await preview({ context_id: ACQ, metric: 'project_cost' })).metrics[0].group_by.dimensions.map((d) => JSON.stringify(d));
  for (const ref of [direct, chain]) assert.ok(listed.includes(JSON.stringify(ref)), `${JSON.stringify(ref)} in ${listed}`);
  // each is its own join, made by hand: the channel of the row, and the channel of its media source
  const byHand = async (channel) => Object.fromEntries((await wh.query(`select upper(${channel}) as kind, sum(cost) as cost from fct_player_acquisition group by 1`)).rows.map((r) => [r.kind, num(r.cost)]));
  const got = async (ref) => Object.fromEntries(rowsOf(await q(ACQ, { metrics: ['project_cost'], group_by: [ref] })).map((r) => [r.project_channels_kind, num(r.project_cost)]));
  const [wantDirect, wantChain] = [await byHand(CHANNEL_OF_ROW), await byHand(CHANNEL_OF_SOURCE)];
  assert.notDeepEqual(wantDirect, wantChain, 'the fixture makes the two ways differ');
  const close = (a, b) => assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort()) || Object.keys(b).forEach((k) => assert.ok(Math.abs(a[k] - b[k]) < 1e-9, k));
  close(await got(direct), wantDirect);
  close(await got(chain), wantChain);
  // a chain MetricFlow does not list is refused, naming the ways there are
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: ACQ, metrics: ['project_cost'], group_by: [{ semantic_model: ['project_events', 'project_channels'], dimension: 'kind' }] })), /reached as .*project_media_sources/);
});

test('a metric of two semantic models is cut only by what both carry: the preview says so, and the query agrees with the rows', opts, async (t) => {
  if (skip(t)) return;
  const p = await preview({ context_id: ACQ, metric: 'project_events_per_click' });
  const m = p.metrics.find((x) => x.name === 'project_events_per_click');
  assert.deepEqual(m.group_by.dimensions, []);
  assert.deepEqual(m.group_by.entities, [{ entity: 'player' }]);
  // the metrics it is made of come with it
  assert.deepEqual(p.metrics.map((x) => x.name).sort(), ['project_clicks', 'project_events_per_click', 'project_events_total']);
  // a cut only one input has is refused in the call
  await assert.rejects(Promise.resolve().then(() => (engine.raw || engine).query_semantic_model({ context_id: ACQ, metrics: ['project_events_per_click'], group_by: [{ semantic_model: [ACQ], dimension: 'campaign' }] })), /not a dimension project_events_per_click can be grouped by/);
  // the one they share, on data: per player, events / clicks
  const ev = new Map((await wh.query('select player_id_of_internal as p, count(event_id) as n from fct_analytics_events group by 1')).rows.map((r) => [r.p, num(r.n)]));
  const cl = new Map((await wh.query('select player_id_of_internal as p, sum(clicks) as n from fct_player_acquisition group by 1')).rows.map((r) => [r.p, num(r.n)]));
  // the same metric, from the context of either semantic model it reads, is the same numbers
  const got = rowsOf(await q(ACQ, { metrics: ['project_events_per_click'], group_by: [{ entity: 'player' }] }));
  const byPlayer = (rows) => Object.fromEntries(rows.map((r) => [r.player, r.project_events_per_click]));
  assert.deepEqual(byPlayer(rowsOf(await q(EV, { metrics: ['project_events_per_click'], group_by: [{ entity: 'player' }] }))), byPlayer(got));
  let compared = 0;
  for (const r of got) {
    const want = ev.has(r.player) && cl.get(r.player) ? ev.get(r.player) / cl.get(r.player) : null;
    if (want == null) { assert.equal(r.project_events_per_click, null, r.player); continue; }
    assert.ok(Math.abs(num(r.project_events_per_click) - want) < 1e-9, `${r.player}: ${r.project_events_per_click} vs ${want}`);
    compared += 1;
  }
  assert.ok(compared > 0, 'some players have both events and clicks');
});

test('validate runs the project\'s metrics over a window — each value the warehouse\'s own — and its semantic models\' dimensions', opts, async (t) => {
  if (skip(t)) return;
  const started = await preview({ context_id: ACQ, validate: true, time_range: { start: '2026-01-02', end: '2026-01-04' } });
  assert.ok(isStartedTask(started), JSON.stringify(started));
  const v = await taskResult(engine.raw || engine, started.task_id);
  assert.equal(v.ok, true, JSON.stringify(v.error));
  assert.equal(v.valid, true, JSON.stringify(v));
  assert.ok(v.compiled.every((c) => c.ok), JSON.stringify(v.compiled));
  const [w] = (await wh.query("select sum(cost) as cost, sum(clicks) as clicks, sum(impressions) as impressions from fct_player_acquisition where spend_date between date '2026-01-02' and date '2026-01-04'")).rows;
  const value = (name) => num(v.ran.metrics.find((x) => x.metric === name).value);
  assert.ok(Math.abs(value('project_cost') - num(w.cost)) < 1e-9);
  assert.equal(value('project_clicks'), num(w.clicks));
  assert.equal(value('project_touches'), num(w.clicks) + num(w.impressions));
  const sm = v.ran.semantic_models.find((x) => x.semantic_model === 'project_acquisition');
  assert.equal(sm.ok, true, JSON.stringify(sm));
  assert.deepEqual(sm.dimensions.sort(), ['campaign', 'spend_date']);
});

test('validate names the metric and the dimension whose column the warehouse does not have — and runs the rest', opts, async (t) => {
  if (skip(t)) return;
  // a copy of the project with one metric and one dimension over a column that is not there: dbt
  // parses it (the expression is the warehouse's to judge), MetricFlow compiles it, the run fails
  const broken = join(mkdtempSync(join(tmpdir(), 'projsem-broken-')), 'project');
  cpSync(BASE, broken, { recursive: true, filter: (src) => !/\/(target|logs)(\/|$)/.test(src) });
  const file = join(broken, 'models', 'core', 'project_semantic_models.yml');
  const doc = yaml.load(readFileSync(file, 'utf8'));
  const acq = doc.models.find((m) => m.name === 'fct_project_acquisition');
  acq.metrics.push({ name: 'project_broken_amount', type: 'simple', agg: 'sum', expr: 'no_such_amount' });
  acq.derived_semantics = { dimensions: [{ name: 'broken_dim', type: 'categorical', expr: 'no_such_column' }] };
  writeFileSync(file, yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  const ctxs2 = new ContextManager({ baseProjectDir: broken, workspaceRoot: mkdtempSync(join(tmpdir(), 'projsem2-')), timeSpineDialect: 'duckdb' });
  const loaded2 = await loadProjectSemantics({ runner: backend, contextManager: ctxs2 });
  assert.ok(loaded2?.layer, JSON.stringify(loaded2));
  const engine2 = new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs2, runner: backend, project: loaded2 });
  const started = await engine2.preview_semantic_model({ context_id: ACQ, validate: true, time_range: WINDOW });
  const v = await taskResult(engine2, started.task_id);
  assert.equal(v.ok, true, JSON.stringify(v.error));
  assert.equal(v.valid, false);
  const failedMetrics = v.ran.metrics.filter((x) => !x.ok).map((x) => x.metric);
  assert.deepEqual(failedMetrics, ['project_broken_amount']);
  // the others still ran, each with the warehouse's own number
  const [{ cost }] = (await wh.query('select sum(cost) as cost from fct_player_acquisition')).rows;
  assert.ok(Math.abs(num(v.ran.metrics.find((x) => x.metric === 'project_cost').value) - num(cost)) < 1e-9);
  const sm = v.ran.semantic_models.find((x) => x.semantic_model === 'project_acquisition');
  assert.equal(sm.ok, false);
  assert.deepEqual(sm.failed.map((f) => f.dimension || f.entity), ['broken_dim']);
});

test('a context a task built is previewed and validated the same way: its definitions, what it is cut by, and its values', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_semantic_model({
    name: 'pvw', use_base_models: ['users'],
    semantic_models: [{ from: 'events', event_scope: { event_name: ['tutorial'] }, measures: [{ name: 'tutorials', agg: 'count', field: '*' }, { name: 'players', agg: 'count_distinct', field: 'player_id_of_internal' }] }],
    metrics: [{ name: 'tutorials', type: 'simple', measure: { name: 'tutorials' } }, { name: 'players', type: 'simple', measure: { name: 'players' } }, { name: 'per_player', type: 'ratio', numerator: { name: 'tutorials' }, denominator: { name: 'players' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const p = await preview({ context_id: out.context_id });
  assert.equal(p.layer, 'task');
  assert.equal(p.status.valid, true, JSON.stringify(p.status.issues));
  assert.deepEqual(p.metrics.map((m) => m.name).sort(), ['pvw_per_player', 'pvw_players', 'pvw_tutorials']);
  assert.deepEqual(p.metrics.find((m) => m.name === 'pvw_per_player').definition, { numerator: { metric: 'pvw_tutorials' }, denominator: { metric: 'pvw_players' } });
  // one metric of it: its group_by names the context's attributes in full, and its time axis
  const one = await preview({ context_id: out.context_id, metric: 'pvw_tutorials' });
  const tut = one.metrics.find((m) => m.name === 'pvw_tutorials');
  assert.deepEqual(tut.group_by.attributes, p.groupable);
  assert.ok(tut.group_by.metric_time, JSON.stringify(tut.group_by));
  // each cut the preview offers, queried, gives back the whole count
  const [{ n }] = (await wh.query("select count(*) as n from fct_analytics_events where event_name = 'tutorial'")).rows;
  for (const cut of p.groupable.slice(0, 3)) {
    const rows = rowsOf(await engine.query_semantic_model({ context_id: out.context_id, metrics: ['pvw_tutorials'], group_by: [cut], time_range: WINDOW }));
    assert.equal(rows.reduce((a, r) => a + num(r.pvw_tutorials ?? 0), 0), num(n), JSON.stringify(cut));
  }
  // a query running on the context is not a build: the preview does not say it is building
  const running = await (engine.raw || engine).query_semantic_model({ context_id: out.context_id, metrics: ['pvw_tutorials'], time_range: WINDOW });
  assert.equal((engine.raw || engine).jobs.get(running.task_id).status, 'running');
  assert.equal((await preview({ context_id: out.context_id })).status.building, undefined);
  await taskResult(engine.raw || engine, running.task_id);
  // a build that is running is
  const rebuilding = await (engine.raw || engine).build_semantic_model({ action: 'update', context_id: out.context_id, semantic_model: 'events', add_measures: [{ name: 'more', agg: 'count', field: '*' }], add_metrics: [{ name: 'more', type: 'simple', measure: { name: 'more' } }] });
  assert.equal((await preview({ context_id: out.context_id })).status.building, true);
  await taskResult(engine.raw || engine, rebuilding.task_id);
  const started = await preview({ context_id: out.context_id, validate: true, time_range: WINDOW });
  const v = await taskResult(engine.raw || engine, started.task_id);
  assert.equal(v.valid, true, JSON.stringify(v));
  const [{ players }] = (await wh.query("select count(distinct player_id_of_internal) as players from fct_analytics_events where event_name = 'tutorial'")).rows;
  const value = (name) => num(v.ran.metrics.find((x) => x.metric === name).value);
  assert.equal(value('pvw_tutorials'), num(n));
  assert.equal(value('pvw_players'), num(players));
  assert.ok(Math.abs(value('pvw_per_player') - num(n) / num(players)) < 1e-9);
});

test('a preview refuses what the context does not have, naming what it does', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(Promise.resolve().then(() => preview({ context_id: ACQ, metric: 'project_cots' })), /not a metric of context 'project_acquisition'.*project_cost/);
  await assert.rejects(Promise.resolve().then(() => preview({ context_id: ACQ, semantic_model: 'nope' })), /not a semantic model of context 'project_acquisition'.*project_events/);
  await assert.rejects(Promise.resolve().then(() => preview({ context_id: ACQ, time_range: WINDOW })), /pass validate: true/);
  await assert.rejects(Promise.resolve().then(() => preview({ context_id: 'project' })), /unknown context_id/);
});

test('nothing is keyed on a name: files moved and renamed, a semantic model and its metrics renamed — served under the new names, the same numbers', opts, async (t) => {
  if (skip(t)) return;
  const other = join(mkdtempSync(join(tmpdir(), 'projsem-renamed-')), 'project');
  cpSync(BASE, other, { recursive: true, filter: (src) => !/\/(target|logs)(\/|$)/.test(src) });
  // the layer's files in another folder, under other names
  const from = join(other, 'models', 'core');
  const to = join(other, 'models', 'marts', 'spend');
  mkdirSync(to, { recursive: true });
  const doc = yaml.load(readFileSync(join(from, 'project_semantic_models.yml'), 'utf8'));
  const metricsDoc = yaml.load(readFileSync(join(from, 'project_metrics.yml'), 'utf8'));
  // the semantic model and every metric under new names
  const renamed = (n) => n.replace(/^project_/, 'zz_');
  const acq = doc.models.find((m) => m.semantic_model?.name === ACQ);
  acq.semantic_model.name = 'paid_spend_daily';
  for (const m of acq.metrics) m.name = renamed(m.name);
  const keep = metricsDoc.metrics.filter((m) => ['project_touches', 'project_ctr', 'project_cost_per_touch'].includes(m.name)).map((m) => JSON.parse(JSON.stringify(m).replace(/"project_/g, '"zz_')));
  writeFileSync(join(to, 'layer.yaml'), yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  writeFileSync(join(to, 'derived.yml'), yaml.dump({ metrics: keep }, { lineWidth: 120, noRefs: true }));
  for (const f of ['project_semantic_models.yml', 'project_metrics.yml']) writeFileSync(join(from, f), '');
  // and a semantic model no metric reads — dimensions only
  const modelsFile = join(other, 'models', '_models.yml');
  const modelsDoc = yaml.load(readFileSync(modelsFile, 'utf8'));
  const users = modelsDoc.models.find((m) => m.name === 'dim_users');
  Object.assign(users, { primary_entity: 'user_version', semantic_model: { enabled: true, name: 'user_profiles' } });
  users.columns = users.columns.map((c) => (c.name === 'country' ? { ...c, dimension: { type: 'categorical' } } : c));
  writeFileSync(modelsFile, yaml.dump(modelsDoc, { lineWidth: 120, noRefs: true }));
  // (the events semantic model stays where it was, on the project's own entry)
  const ctxs3 = new ContextManager({ baseProjectDir: other, workspaceRoot: mkdtempSync(join(tmpdir(), 'projsem3-')), timeSpineDialect: 'duckdb' });
  const loaded3 = await loadProjectSemantics({ runner: backend, contextManager: ctxs3 });
  assert.ok(loaded3?.layer, JSON.stringify(loaded3));
  assert.deepEqual(loaded3.contexts.sort(), ['paid_spend_daily', EV]);
  const engine3 = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs3, runner: backend, project: loaded3 }));
  assert.deepEqual(engine3.schemas.query_semantic_model.properties.context_id.anyOf[0].enum, ['paid_spend_daily', EV]);
  // a semantic model no metric reads is no context of its own: nothing could be queried there
  assert.deepEqual(loaded3.dimension_only.sort(), ['project_channels', 'project_media_sources', 'user_profiles']);
  assert.deepEqual((await engine3.semantic_index({})).project_semantic_layer.dimension_only.sort(), ['project_channels', 'project_media_sources', 'user_profiles']);
  const want = Object.fromEntries((await wh.query('select media_source, sum(cost) as cost, sum(clicks) as clicks, sum(impressions) as imp from fct_player_acquisition group by 1')).rows.map((r) => [r.media_source, r]));
  const got = rowsOf(await engine3.query_semantic_model({ context_id: 'paid_spend_daily', time_range: WINDOW, metrics: ['zz_cost', 'zz_cost_per_touch'], group_by: [{ entity: 'media_source' }, { semantic_model: ['paid_spend_daily'], dimension: 'campaign' }] }));
  const sums = {};
  for (const r of got) sums[r.media_source] = (sums[r.media_source] || 0) + num(r.zz_cost);
  for (const [src, w] of Object.entries(want)) assert.ok(Math.abs(sums[src] - num(w.cost)) < 1e-9, src);
  // the result column of a dimension carries the semantic model's own name
  assert.ok(got.every((r) => 'paid_spend_daily_campaign' in r), JSON.stringify(got[0]));
  // the old names are nobody's now
  await assert.rejects(Promise.resolve().then(() => engine3.raw.query_semantic_model({ context_id: ACQ, metrics: ['project_cost'] })), /unknown context_id/);
});

test('a query is addressed by what and where, and nothing handed back spells MetricFlow\'s entity__dimension: an explained query\'s SQL, run as shown, is the query\'s own numbers', opts, async (t) => {
  if (skip(t)) return;
  const raw = engine.raw || engine;
  // the project's OWN columns may carry `__` (measure__impressions here, as a project names its amounts):
  // they are its names, not MetricFlow's, and stay as they are — the SQL below runs only if they do
  const own = ['measure__impressions'];
  const noInternal = (v, what) => assert.doesNotMatch(own.reduce((t, c) => t.split(c).join(''), JSON.stringify(v)), /[A-Za-z0-9]__[A-Za-z0-9]|[^A-Za-z0-9_]__[A-Za-z0-9]/, what);
  // the project's layer: by a dimension, a time dimension at a grain, and a where on a dimension
  const project = { context_id: EV, metrics: ['project_events_total'], group_by: [{ semantic_model: [EV], dimension: 'event_name' }, { semantic_model: [EV], dimension: 'event_at', grain: 'week' }], where: { op: 'and', conditions: [{ field: { kind: 'dimension', semantic_model: [EV], dimension: 'event_name' }, op: 'neq', value: 'x' }] }, time_range: WINDOW };
  // a task's context: an attribute through a join, metric_time, and a where through the join
  const built = await engine.build_semantic_model({ name: 'spelled', use_base_models: ['users'], semantic_models: [{ from: 'events', event_scope: { event_name: ['tutorial'] }, measures: [{ name: 'tutorials', agg: 'count', field: '*' }] }], metrics: [{ name: 'tutorials', type: 'simple', measure: { name: 'tutorials' } }] });
  const task = { context_id: built.context_id, metrics: ['spelled_tutorials'], group_by: [{ model: 'users', attribute: 'country' }, { time: 'metric_time', grain: 'week' }], where: { op: 'and', conditions: [{ field: { kind: 'dimension', model: 'users', attribute: 'platform' }, op: 'eq', value: 'ios' }] }, time_range: WINDOW };
  // a metric over the project's own `__` column, by a dimension of its model
  const ownColumn = { context_id: ACQ, metrics: ['project_impressions'], group_by: [{ semantic_model: [ACQ], dimension: 'campaign' }], time_range: WINDOW };
  for (const input of [project, task, ownColumn]) {
    const rows = rowsOf(await engine.query_semantic_model(input));
    const explained = await taskResult(raw, (await raw.query_semantic_model({ ...input, explain: true })).task_id);
    assert.equal(explained.ok, true, JSON.stringify(explained.error));
    noInternal(explained, 'the explained query');
    // the SQL as shown is the query: run it, and it gives the same rows under the same column names
    const shown = (await wh.query(explained.sql)).rows;
    const key = (r) => JSON.stringify(Object.keys(rows[0]).map((k) => (k.startsWith('metric_time') || /_week$/.test(k) ? String(r[k]).slice(0, 10) : typeof r[k] === 'bigint' || typeof r[k] === 'number' ? Number(r[k]) : r[k])));
    assert.deepEqual(shown.map(key).sort(), rows.map(key).sort(), input.context_id);
  }
  // what a refusal and a failed run say names things the same way
  const failed = await taskResult(raw, (await raw.query_semantic_model({ ...project, where: { op: 'and', conditions: [{ field: { kind: 'dimension', semantic_model: [EV], dimension: 'event_at' }, op: 'eq', value: 'not a date' }] } })).task_id);
  assert.equal(failed.ok, false, JSON.stringify(failed));
  noInternal(failed, 'a failed query');
});

test('the cost guardrail holds on the project\'s layer: a semantic model over a dbt model the catalog requires a window for is not scanned whole', opts, async (t) => {
  if (skip(t)) return;
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  // the events source — fct_analytics_events, which project_events reads too — requires a bounded window
  catalog.getModel('events').require_time_range = true;
  const guarded = settle(new Engine({ catalog, contextManager: ctxs, runner: backend, project: loaded }));
  await assert.rejects(Promise.resolve().then(() => guarded.raw.query_semantic_model({ context_id: EV, metrics: ['project_events_total'] })), /project_events requires a bounded time window \(require_time_range\)/);
  const [{ n }] = (await wh.query('select count(event_id) as n from fct_analytics_events')).rows;
  const bounded = rowsOf(await guarded.query_semantic_model({ context_id: EV, metrics: ['project_events_total'], time_range: WINDOW }));
  assert.equal(num(bounded[0].project_events_total), num(n));
  // a semantic model over a table the catalog does not require a window for is not held to one
  const [{ cost }] = (await wh.query('select sum(cost) as cost from fct_player_acquisition')).rows;
  const open = rowsOf(await guarded.query_semantic_model({ context_id: ACQ, metrics: ['project_cost'] }));
  assert.ok(Math.abs(num(open[0].project_cost) - num(cost)) < 1e-9);
});

// ---- a model joined through several keys (a role) is not served; declared one semantic model per key, it is ----

/** A copy of the project with `extra` models (name → { sql, entry }) added under models/roles. */
function projectWith(extra) {
  const dir = join(mkdtempSync(join(tmpdir(), 'projsem-roles-')), 'project');
  cpSync(BASE, dir, { recursive: true, filter: (src) => !/\/(target|logs)(\/|$)/.test(src) });
  const roles = join(dir, 'models', 'roles');
  mkdirSync(roles, { recursive: true });
  for (const [name, { sql }] of Object.entries(extra)) writeFileSync(join(roles, `${name}.sql`), `{{ config(materialized='view') }}\n${sql}\n`);
  writeFileSync(join(roles, 'roles.yml'), yaml.dump({ models: Object.entries(extra).map(([name, { entry }]) => ({ name, ...entry })) }, { lineWidth: 120, noRefs: true }));
  return dir;
}

// spend with two keys into the channels: the one a row is booked under, and its media source's
const ROLE_SPEND = {
  fct_role_spend: {
    sql: `select *, ${CHANNEL_OF_ROW} as booked_channel, ${CHANNEL_OF_SOURCE} as source_channel from {{ ref('fct_player_acquisition') }}`,
    entry: {
      agg_time_dimension: 'spend_date', primary_entity: 'role_spend_row',
      semantic_model: { enabled: true, name: 'role_spend' },
      columns: [
        { name: 'booked_channel', entity: { type: 'foreign', name: 'booked_channel' } },
        { name: 'source_channel', entity: { type: 'foreign', name: 'source_channel' } },
        { name: 'spend_date', granularity: 'day', dimension: { type: 'time', name: 'spend_date' } },
      ],
      metrics: [{ name: 'role_cost', type: 'simple', agg: 'sum', expr: 'cost' }],
    },
  },
};
const channelsKeyedBy = (keys) => ({
  sql: `select ${keys.map((k) => `channel as ${k}`).join(', ')}, upper(channel) as channel_kind from (select 'paid' as channel union all select 'organic')`,
  entry: (name) => ({
    semantic_model: { enabled: true, name },
    columns: [
      ...keys.map((k, i) => ({ name: k, entity: { type: i ? 'unique' : 'primary', name: k } })),
      { name: 'channel_kind', dimension: { type: 'categorical', name: 'kind' } },
    ],
  }),
});
/** Build `models` of a copy into the warehouse (new names only: the shared views are left alone). */
const runModels = (dir, models) => execFileP(DBT_BIN, ['run', '--select', ...models], { cwd: dir, env: { ...process.env, DBT_PROFILES_DIR: dir, DBT_PROJECT_DIR: dir, DUCKDB_PATH: wh.path }, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
async function loadedFrom(dir) {
  const cm = new ContextManager({ baseProjectDir: dir, workspaceRoot: mkdtempSync(join(tmpdir(), 'projsem-roles-ws-')), timeSpineDialect: 'duckdb' });
  const out = await loadProjectSemantics({ runner: backend, contextManager: cm });
  assert.ok(out?.layer, JSON.stringify(out));
  const eng = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: cm, runner: backend, project: out }));
  return { out, eng };
}

test('a semantic model joined onto through several keys is not served — said at start, in the preview and in the refusal, with how to declare it', opts, async (t) => {
  if (skip(t)) return;
  const roles = channelsKeyedBy(['booked_channel', 'source_channel']);
  const dir = projectWith({ ...ROLE_SPEND, fct_role_channels: { sql: roles.sql, entry: roles.entry('role_channels') } });
  const { out, eng } = await loadedFrom(dir);
  const [b] = out.layer.blocked;
  assert.deepEqual([b.semantic_model, b.keys, b.dimensions, b.metrics], ['role_channels', ['booked_channel', 'source_channel'], ['role_channels.kind'], ['role_cost']]);
  // the fix names the dbt model each role is built over
  assert.match(b.fix, /one semantic model per key.*ref\('fct_role_channels'\)/);
  assert.deepEqual((await eng.semantic_index({})).project_semantic_layer.joins_not_served.map((x) => x.semantic_model), ['role_channels']);
  // the preview does not offer it, and says why as an error of the declaration
  const p = await eng.raw.preview_semantic_model({ context_id: 'role_spend', metric: 'role_cost' });
  assert.deepEqual(p.metrics[0].group_by.dimensions.filter((d) => d.dimension === 'kind'), []);
  assert.equal(p.status.valid, false);
  assert.ok(p.status.issues.some((i) => i.severity === 'error' && i.semantic_model === 'role_channels' && /several keys/.test(i.message)), JSON.stringify(p.status.issues));
  // …and a query naming it is refused in the call, in group_by and in where alike
  const ref = { semantic_model: ['role_channels'], dimension: 'kind' };
  await assert.rejects(Promise.resolve().then(() => eng.raw.query_semantic_model({ context_id: 'role_spend', metrics: ['role_cost'], group_by: [ref], time_range: WINDOW })), /joined onto through several keys.*not served.*one semantic model per key/);
  await assert.rejects(Promise.resolve().then(() => eng.raw.query_semantic_model({ context_id: 'role_spend', metrics: ['role_cost'], time_range: WINDOW, where: { op: 'and', conditions: [{ field: { kind: 'dimension', ...ref }, op: 'eq', value: 'PAID' }] } })), /several keys/);
  // the rest of the layer is served as before
  await runModels(dir, ['fct_role_spend']);
  const [{ cost }] = (await wh.query('select sum(cost) as cost from fct_player_acquisition')).rows;
  const total = rowsOf(await eng.query_semantic_model({ context_id: 'role_spend', metrics: ['role_cost'], time_range: WINDOW }));
  assert.ok(Math.abs(num(total[0].role_cost) - num(cost)) < 1e-9);
});

test('declared as the fix says — one semantic model per key — each role is a semantic model of its own, both in one query, each the warehouse\'s own join', opts, async (t) => {
  if (skip(t)) return;
  const booked = channelsKeyedBy(['booked_channel']);
  const source = channelsKeyedBy(['source_channel']);
  const dir = projectWith({ ...ROLE_SPEND, fct_booked_channels: { sql: booked.sql, entry: booked.entry('booked_channels') }, fct_source_channels: { sql: source.sql, entry: source.entry('source_channels') } });
  await runModels(dir, ['fct_role_spend', 'fct_booked_channels', 'fct_source_channels']);
  const { out, eng } = await loadedFrom(dir);
  assert.deepEqual(out.layer.blocked, []);
  const refs = [{ semantic_model: ['booked_channels'], dimension: 'kind' }, { semantic_model: ['source_channels'], dimension: 'kind' }];
  const listed = (await eng.raw.preview_semantic_model({ context_id: 'role_spend', metric: 'role_cost' })).metrics[0].group_by.dimensions.map((d) => JSON.stringify(d));
  for (const r of refs) assert.ok(listed.includes(JSON.stringify(r)), `${JSON.stringify(r)} in ${listed}`);
  const want = (await wh.query(`select upper(${CHANNEL_OF_ROW}) as booked, upper(${CHANNEL_OF_SOURCE}) as src, sum(cost) as cost from fct_player_acquisition group by 1, 2`)).rows;
  const got = rowsOf(await eng.query_semantic_model({ context_id: 'role_spend', metrics: ['role_cost'], group_by: refs, time_range: WINDOW }));
  assert.equal(got.length, want.length);
  for (const w of want) {
    const r = got.find((x) => x.booked_channels_kind === w.booked && x.source_channels_kind === w.src);
    assert.ok(r && Math.abs(num(r.role_cost) - num(w.cost)) < 1e-9, `${w.booked}/${w.src}`);
  }
});
