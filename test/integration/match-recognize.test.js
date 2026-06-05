// Funnels are PIPELINES: register_native_model builds a pipe-syntax pipeline whose
// match_recognize stage produces one row per user, and downstream stages (join,
// aggregate) slice it. The model's rows ARE the result. Data-only assertions on
// the returned rows (Postgres equivalent here; BigQuery MATCH_RECOGNIZE in prod).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine; let backend; let ctxId; let seq = 0;
const num = (v) => Number(v);
const tru = (v) => v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const reached = (rows, step) => rows.filter((r) => tru(r[`reached_${step}`])).length;

// Build a funnel/transform pipeline and return the materialized result rows.
async function pipe(stages, name) {
  const out = await engine.register_native_model({ name: name || `fnl_${seq++}`, context_id: ctxId, pipeline: { stages } });
  assert.equal(out.kind, 'pipeline');
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  ctxId = out.context_id;
  return out;
}

// The canonical 4-step activation funnel as a single match_recognize stage.
const activationSteps = [
  { name: 'launch', event_name: ['first_launch'] },
  { name: 'tut1', event_name: ['tutorial'], where: [{ property: 'chain_of_event_data', op: 'eq', value: 'step_1' }] },
  { name: 'tut2', event_name: ['tutorial'], where: [{ property: 'chain_of_event_data', op: 'eq', value: 'step_2' }] },
  { name: 'tut3', event_name: ['tutorial'], where: [{ property: 'chain_of_event_data', op: 'eq', value: 'step_3' }] },
];
const matchActivation = (extra = {}) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], mode: 'ordered', steps: activationSteps, ...extra });

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mr-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend });
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// #9: a pipeline-level time_range bounds the window (applied before the stages).
test('native pipeline time_range bounds the window: full 8 purchases vs windowed 6', opts, async (t) => {
  if (skip(t)) return;
  const count = async (time_range) => {
    const out = await engine.register_native_model({ name: `tr_${seq++}`, context_id: ctxId, pipeline: { time_range, stages: [
      { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
      { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] },
    ] } });
    assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
    ctxId = out.context_id;
    return Number(out.rows[0].n);
  };
  assert.equal(await count(undefined), 8);                                  // all purchases
  assert.equal(await count({ start: '2026-01-01', end: '2026-01-04' }), 6); // 01-01..01-04 inclusive (date-only end = whole day)
});

test('funnel: reached per step = 12 / 8 / 5 / 3 (match_recognize stage → per-user rows)', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([matchActivation()]);
  assert.equal(reached(out.rows, 'launch'), 12);
  assert.equal(reached(out.rows, 'tut1'), 8);
  assert.equal(reached(out.rows, 'tut2'), 5);
  assert.equal(reached(out.rows, 'tut3'), 3);
});

// A1: between_steps option. 'any' = nearest-later occurrence (repeats between steps
// don't break the match) — exactly the local engine's native behavior, so setting it
// explicitly equals the default (the cross-engine consistency contract: the same value
// makes BigQuery match too). 'gap' = only non-step events may fill the gap; it can
// never ADD matches, so it is a subset of 'any'.
test('match_recognize between_steps: explicit "any" equals the default; "gap" is a valid subset', opts, async (t) => {
  if (skip(t)) return;
  const steps = [{ name: 'start', event_name: ['currency_outcome'] }, { name: 'done', event_name: ['ad_finished'] }];
  const mk = (between_steps) => [{ stage: 'match_recognize', partition_by: ['player_id_of_internal'], rows: 'one_per_match', between_steps, steps }];
  const completed = (o) => o.rows.filter((r) => tru(r.completed)).length;
  const A = completed(await pipe(mk('any')));
  const D = completed(await pipe(mk(undefined)));
  const G = completed(await pipe(mk('gap'))); // builds ok ⇒ the NOT EXISTS gap guard is valid SQL
  assert.equal(A, 5, 'all 5 currency_outcome occurrences reach a later ad_finished');
  assert.equal(D, A, 'explicit between_steps="any" == default (nearest-later) on the local engine');
  assert.ok(G <= A && G >= 0, `gap (${G}) is a subset of any (${A}) — never over-matches`);
});

// A2/A4: the pipeline response documents its output columns + how to re-read it.
test('pipeline response: output_columns (carried partition key) + read_with hint', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([matchActivation()]);
  assert.ok(Array.isArray(out.output_columns), 'output_columns present');
  const names = out.output_columns.map((c) => c.name);
  assert.ok(names.includes('player_id_of_internal'), 'partition key carried through to the output');
  assert.ok(names.includes('reached_launch') && names.includes('completed'), 'funnel columns present');
  assert.equal(out.read_with?.tool, 'get_query_result');
  assert.equal(out.read_with?.table, out.model);
});

// A5: dry_run returns a cheap source-volume estimate; a narrower window scans fewer rows.
test('dry_run estimated_source_rows: real count, monotonic in the time window', opts, async (t) => {
  if (skip(t)) return;
  const stages = [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] }];
  const wide = await engine.register_native_model({ dry_run: true, name: 'est_wide', pipeline: { stages } });
  const narrow = await engine.register_native_model({ dry_run: true, name: 'est_narrow', pipeline: { time_range: { start: '2026-01-05', end: '2026-01-05' }, stages } });
  assert.ok(Number.isInteger(wide.estimated_source_rows) && wide.estimated_source_rows > 0, 'full source count is a positive integer');
  assert.ok(narrow.estimated_source_rows > 0 && narrow.estimated_source_rows < wide.estimated_source_rows, 'a single day scans fewer rows than the whole fact');
  assert.ok(wide.output_columns.some((c) => c.name === 'event_name'), 'dry_run also reports output_columns');
});

// #5: rows option — one_per_partition (players) vs one_per_match (situations).
test('match_recognize rows: one_per_partition (12 players) vs one_per_match (28 starts)', opts, async (t) => {
  if (skip(t)) return;
  const steps = [{ name: 'start', event_name: ['level_started'] }, { name: 'done', event_name: ['level_completed'] }];
  const players = await pipe([{ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps }]);
  const situations = await pipe([{ stage: 'match_recognize', partition_by: ['player_id_of_internal'], rows: 'one_per_match', steps }]);
  assert.equal(players.rows.length, 12);               // one row per user who started a level
  assert.equal(reached(players.rows, 'start'), 12);
  assert.equal(situations.rows.length, 28);            // one row per level_started occurrence
  assert.equal(reached(situations.rows, 'start'), 28);
});

test('funnel flexible partition: "user" alias and a per-(user,session) composite key', opts, async (t) => {
  if (skip(t)) return;
  // The partition key is caller-chosen. The "user" alias resolves to the user
  // column → same 12 launched as the explicit ["player_id_of_internal"].
  const alias = await pipe([matchActivation({ partition_by: ['user'] })]);
  assert.equal(reached(alias.rows, 'launch'), 12);
  // A COMPOSITE key matches the sequence independently per (user, session) — one
  // row per matched (user,session); still 12 first_launch partitions (one/user).
  const composite = await pipe([matchActivation({ partition_by: ['player_id_of_internal', 'session_number'], steps: activationSteps.slice(0, 2) })]);
  assert.ok('player_id_of_internal' in composite.rows[0] && 'session_number' in composite.rows[0], 'both partition keys exposed');
  assert.equal(reached(composite.rows, 'launch'), 12);
});

test('funnel: furthest_step_name distribution sums to 12; tut3 = 3', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([matchActivation()]);
  assert.equal(out.rows.length, 12); // one row per user who entered (launched)
  assert.equal(out.rows.filter((r) => String(r.furthest_step_name) === 'tut3').length, 3);
});

test('funnel: conversion launch→tut1 = 8/12 (computed from per-user reached flags)', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([matchActivation()]);
  const cr = reached(out.rows, 'tut1') / reached(out.rows, 'launch');
  assert.ok(Math.abs(cr - 8 / 12) < 1e-9, `cr=${cr}`);
});

test('funnel sliced by a user attribute: join dim_users → reached_tut1 by country sums to 8', opts, async (t) => {
  if (skip(t)) return;
  // The funnel is sliced by joining dim_users AFTER match_recognize — all within
  // the pipeline (no separate semantic layer).
  const out = await pipe([matchActivation(), { stage: 'join', with: 'users', on: 'player_id_of_internal', attrs: ['country', 'platform'] }]);
  assert.ok(out.rows.every((r) => 'country' in r && 'platform' in r), 'attrs joined onto each row');
  assert.equal(reached(out.rows, 'tut1'), 8);
  const byCountry = {};
  for (const r of out.rows) if (tru(r.reached_tut1)) byCountry[String(r.country)] = (byCountry[String(r.country)] || 0) + 1;
  assert.equal(Object.values(byCountry).reduce((s, n) => s + n, 0), 8);
});

test('funnel sliced + aggregated in-pipeline: aggregate count by furthest_step_name', opts, async (t) => {
  if (skip(t)) return;
  // match_recognize → aggregate is the composable replacement for the old
  // semantic-model "users by furthest step".
  const out = await pipe([
    matchActivation(),
    { stage: 'aggregate', group_by: ['furthest_step_name'], measures: [{ name: 'users', fn: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'users', direction: 'desc' }] },
  ]);
  const by = Object.fromEntries(out.rows.map((r) => [String(r.furthest_step_name), num(r.users)]));
  assert.equal(Object.values(by).reduce((s, n) => s + n, 0), 12);
  assert.equal(by.tut3, 3);
  const vals = out.rows.map((r) => num(r.users));
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i - 1] >= vals[i], `not descending: ${vals}`);
});

test('funnel filtered to a user segment via join+where (country=US): only the 4 US users enter', opts, async (t) => {
  if (skip(t)) return;
  // user-attribute filtering is now a pipeline concern: join dim_users, where on
  // the attribute, THEN match_recognize — no special user_segment property.
  const out = await pipe([
    { stage: 'join', with: 'users', on: 'player_id_of_internal', attrs: ['country'] },
    { stage: 'where', conditions: [{ column: 'country', op: 'eq', value: 'US' }] },
    { stage: 'match_recognize', partition_by: ['player_id_of_internal'], mode: 'ordered', steps: activationSteps.slice(0, 2) },
  ]);
  assert.equal(reached(out.rows, 'launch'), 4); // exactly the 4 US users
  assert.ok(reached(out.rows, 'tut1') <= 4);
});

test('funnel prefilter time_range (wide) keeps all data: 12 / 8', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([matchActivation({ filter: { time_range: { start: '2000-01-01', end: '2100-01-01' } }, steps: activationSteps.slice(0, 2) })]);
  assert.equal(reached(out.rows, 'launch'), 12);
  assert.equal(reached(out.rows, 'tut1'), 8);
});

test('funnel + prepare derive (array_length): agg_at_step avg(n_words) at level 1 = 3', opts, async (t) => {
  if (skip(t)) return;
  // A derive stage runs BEFORE match_recognize; its column is referenceable in
  // step where / agg_at_step.
  const out = await pipe([
    { stage: 'derive', name: 'n_words', op: 'array_length', source: 'words_collected' },
    { stage: 'match_recognize', partition_by: ['player_id_of_internal'], mode: 'ordered',
      steps: [{ name: 'launch', event_name: ['first_launch'] }, { name: 'lvl1', event_name: ['level_completed'], where: [{ property: 'level_id_of_event_data', op: 'eq', value: 1 }] }],
      metrics: [{ name: 'avg_words', type: 'agg_at_step', agg: 'avg', property: 'n_words', step: 'lvl1' }] },
  ]);
  assert.equal(reached(out.rows, 'lvl1'), 12);
  const vals = out.rows.filter((r) => tru(r.reached_lvl1)).map((r) => num(r.pv_avg_words));
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  assert.ok(Math.abs(avg - 3) < 1e-9, `avg n_words=${avg}`);
});

test('funnel + prepare derive (contains): step filtered by derived boolean reaches 12', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([
    { stage: 'derive', name: 'has_cat', op: 'contains', source: 'words_collected', value: 'cat' },
    { stage: 'match_recognize', partition_by: ['player_id_of_internal'], mode: 'ordered',
      steps: [{ name: 'launch', event_name: ['first_launch'] }, { name: 'cat_lvl', event_name: ['level_completed'], where: [{ property: 'has_cat', op: 'eq', value: true }] }] },
  ]);
  assert.equal(reached(out.rows, 'cat_lvl'), 12); // every user's level-1 completion has 'cat'
});

test('pipeline aggregate: IAP revenue by country = US35 / GB25 / BR25', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'player_id_of_internal', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
  ]);
  const by = Object.fromEntries(out.rows.map((r) => [String(r.country), num(r.revenue)]));
  assert.equal(by.US, 35); assert.equal(by.GB, 25); assert.equal(by.BR, 25);
});

test('pipeline pivot: revenue pivoted into per-country columns', opts, async (t) => {
  if (skip(t)) return;
  const out = await pipe([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'player_id_of_internal', attrs: ['country'] },
    { stage: 'pivot', group_by: [], on: 'country', fn: 'sum', value_column: 'price', values: ['US', 'GB', 'BR'] },
  ]);
  assert.equal(out.rows.length, 1);
  assert.equal(num(out.rows[0].US), 35);
  assert.equal(num(out.rows[0].GB), 25);
});

test('register_native_model: dry_run returns SQL without building', opts, async (t) => {
  if (skip(t)) return;
  const dr = await engine.register_native_model({ name: 'dry_pipe', dry_run: true, pipeline: { stages: [{ stage: 'aggregate', group_by: [], measures: [{ name: 'n', fn: 'count' }] }] } });
  assert.equal(dr.dry_run, true);
  assert.equal(dr.kind, 'pipeline');
  assert.equal(typeof dr.model_sql, 'string');
  assert.equal(typeof dr.model_sql_bigquery, 'string');
});

test('register_native_model: same name in two contexts → distinct relations', opts, async (t) => {
  if (skip(t)) return;
  const a = await engine.register_native_model({ name: 'iso', pipeline: { stages: [{ stage: 'limit', n: 1 }] } });
  const b = await engine.register_native_model({ name: 'iso', pipeline: { stages: [{ stage: 'limit', n: 1 }] } });
  assert.notEqual(a.context_id, b.context_id);
  assert.notEqual(a.model, b.model);
  assert.match(a.model, /^pipe_iso_[a-z0-9]{6,}$/);
});

test('describe_catalog: overview lists models, then { model } drills into REAL physical columns', opts, async (t) => {
  if (skip(t)) return;
  const overview = await engine.describe_catalog();
  assert.ok(overview.models.find((m) => m.key === 'events'), 'events model present in overview');
  assert.ok(Array.isArray(overview.event_names) && overview.event_names.length > 0, 'overview lists event names');
  assert.equal(overview.models.find((m) => m.key === 'events').physical_columns, undefined, 'overview does NOT dump physical columns');
  // drill down for the real physical columns (adapter.get_columns_in_relation)
  const events = await engine.describe_catalog({ model: 'events' });
  assert.ok(Array.isArray(events.physical_columns) && events.physical_columns.length > 0, 'events { model } has REAL physical columns');
  // #4/#3: pipeline-referenceable columns + the time axis are discoverable
  assert.ok(Array.isArray(events.pipeline_columns), 'events { model } lists pipeline_columns');
  const pcNames = events.pipeline_columns.map((c) => c.name);
  assert.ok(pcNames.includes('device_time') && pcNames.includes('player_id_of_internal'), 'pipeline_columns include time + key');
  assert.equal(events.time, 'device_time', 'time axis (default window/match_recognize order) is reported');
  // { event } returns only the properties carried by that event
  const ev = await engine.describe_catalog({ event: 'iap_purchase_completed' });
  assert.ok(ev.property_count > 0 && ev.properties.some((p) => p.name === 'price_in_usd_of_event_data'), 'event lists its scoped properties');
});

// #2: a date-only time_range bound includes the WHOLE day (not collapsed to midnight).
test('native pipeline time_range: single date-only day is not collapsed to a midnight instant', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.register_native_model({ name: `day_${seq++}`, context_id: ctxId, pipeline: { time_range: { start: '2026-01-05', end: '2026-01-05' }, stages: [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] },
  ] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  ctxId = out.context_id;
  assert.equal(Number(out.rows[0].n), 2); // u10 + u11 purchased on 2026-01-05 — whole day, not 0
});
