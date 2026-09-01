// A SECOND events fact (role: crashlytics) is a first-class citizen: its own event
// vocabulary, its own event-scoped payload, governed metrics, a funnel over it, a join to
// dim_users, and metrics from BOTH facts answered in one query. Every assertion is on the
// NUMBERS returned by dbt + MetricFlow / the pipeline against PGlite — the exact totals
// recorded in test/integration/fixtures/SEED_DATA.md (§10).
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

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

let pg;
let engine;
let backend;
let crashCtx; // metrics built on the crashlytics fact
let bothCtx; // one context carrying metrics from BOTH facts

const num = (v) => Number(v === '' || v == null ? NaN : v);
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
// The dimension column as MetricFlow actually returned it (it entity-qualifies some paths).
const groupCol = (res, metric) => res.columns.map((c) => c.name).find((n) => n !== metric);

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-crash-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = new Engine({ catalog, contextManager: ctxs, runner: backend });

  // Metrics built FROM the crashlytics fact. Inside the semantic model its events and
  // properties are named bare, exactly like the primary fact's.
  const crash = await engine.create_semantic_model({
    name: 'stab',
    use_base_models: ['users'],
    semantic_models: [
      {
        from: 'crashlytics',
        event_scope: { event_name: ['fatal_crash'] },
        dimensions: [{ source: 'event_property', property: 'issue_title_of_event_data' }],
        measures: [
          { name: 'fatal', agg: 'count', field: '*' },
          { name: 'crashed_users', agg: 'count_distinct', field: 'player_id_of_internal' },
        ],
      },
    ],
    metrics: [
      { name: 'fatal', type: 'simple', measure: { name: 'fatal' } },
      { name: 'crashed_users', type: 'simple', measure: { name: 'crashed_users' } },
    ],
  });
  assert.equal(crash.parse.ok, true, `parse failed: ${JSON.stringify(crash.parse)}`);
  crashCtx = crash.context_id;

  // ONE context, TWO facts: a measure over the analytics fact and a measure over the crash
  // fact, each scoped to its own vocabulary.
  const both = await engine.create_semantic_model({
    name: 'mix',
    semantic_models: [
      { from: 'events', event_scope: { event_name: ['first_launch'] }, measures: [{ name: 'launches', agg: 'count', field: '*' }] },
      { from: 'crashlytics', event_scope: { event_name: ['fatal_crash'] }, measures: [{ name: 'fatal', agg: 'count', field: '*' }] },
    ],
    metrics: [
      { name: 'launches', type: 'simple', measure: { name: 'launches' } },
      { name: 'fatal', type: 'simple', measure: { name: 'fatal' } },
    ],
  });
  assert.equal(both.parse.ok, true, `parse failed: ${JSON.stringify(both.parse)}`);
  bothCtx = both.context_id;
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const q = (ctx, input) => engine.query_semantic_model({ context_id: ctx, ...input });

// SEED_DATA §10: 6 fatal_crash rows from 3 distinct players (u1×3, u2×2, u3×1).
test('governed metrics on the crash fact: fatal = 6 from 3 distinct players', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(crashCtx, { metrics: ['stab_fatal', 'stab_crashed_users'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].stab_fatal), 6);
  assert.equal(num(r.rows[0].stab_crashed_users), 3);
});

// SEED_DATA §10: fatal crashes by issue -> NullPointer 4, OutOfMemory 2. The dimension is an
// event-scoped PAYLOAD property of the crash fact, resolved against that fact only.
test('fatal crashes grouped by an event-scoped payload property = NullPointer 4 / OutOfMemory 2', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(crashCtx, { metrics: ['stab_fatal'], group_by: ['stab_issue_title_of_event_data'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'stab_fatal'), 'stab_fatal');
  assert.equal(by.NullPointer, 4);
  assert.equal(by.OutOfMemory, 2);
  assert.equal(sumCol(r.rows, 'stab_fatal'), 6);
});

// SEED_DATA §10: the crash fact joins to dim_users on player_id_of_internal, so the SAME
// user attributes segment it -> u1,u2 are US (5 crashes), u3 is GB (1).
test('fatal crashes by user__country (join to dim_users) = US 5 / GB 1', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(crashCtx, { metrics: ['stab_fatal'], group_by: ['user__country'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'stab_fatal'), 'stab_fatal');
  assert.equal(by.US, 5);
  assert.equal(by.GB, 1);
  assert.equal(sumCol(r.rows, 'stab_fatal'), 6);
});

// SEED_DATA §10: anr_duration_of_event_data exists ONLY on `anr` (3 rows, 5.5+8.0+12.5 = 26).
// Scoping to anr yields the real total; the same measure without a scope still sees only
// those 3 rows, because the column is NULL on every other crash event.
test('a payload property scoped to ONE event: anr rows 3, seconds 26, avg 26/3', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    context_id: crashCtx,
    name: 'anr',
    semantic_models: [{
      from: 'crashlytics',
      event_scope: { event_name: ['anr'] },
      measures: [
        { name: 'events', agg: 'count', field: '*' },
        { name: 'secs', agg: 'sum', field: 'anr_duration_of_event_data' },
        { name: 'avg_secs', agg: 'average', field: 'anr_duration_of_event_data' },
      ],
    }],
    metrics: [
      { name: 'events', type: 'simple', measure: { name: 'events' } },
      { name: 'secs', type: 'simple', measure: { name: 'secs' } },
      { name: 'avg_secs', type: 'simple', measure: { name: 'avg_secs' } },
    ],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = await q(crashCtx, { metrics: ['anr_events', 'anr_secs', 'anr_avg_secs'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].anr_events), 3);
  assert.equal(num(r.rows[0].anr_secs), 26);
  assert.ok(Math.abs(num(r.rows[0].anr_avg_secs) - 26 / 3) < 1e-6, `avg=${r.rows[0].anr_avg_secs}`);
});

// SEED_DATA §10: every crash row carries app_version -> 1.0 has 7 rows, 1.1 has 6.
// A physical column of the crash fact, grouped without any join.
test('all crash rows by app_version (a column of the crash fact) = 1.0 -> 7, 1.1 -> 6', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.create_semantic_model({
    context_id: crashCtx,
    name: 'ver',
    semantic_models: [{
      from: 'crashlytics',
      dimensions: [{ source: 'model_column', column: 'app_version' }],
      measures: [{ name: 'reports', agg: 'count', field: '*' }],
    }],
    metrics: [{ name: 'reports', type: 'simple', measure: { name: 'reports' } }],
  });
  assert.equal(out.parse.ok, true, JSON.stringify(out.parse));
  const r = await q(crashCtx, { metrics: ['ver_reports'], group_by: ['ver_app_version'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = mapCol(r.rows, groupCol(r, 'ver_reports'), 'ver_reports');
  assert.equal(by['1.0.0'], 7);
  assert.equal(by['1.1.0'], 6);
  assert.equal(sumCol(r.rows, 'ver_reports'), 13);
});

// The two facts are NEVER mixed, yet both answer in ONE query: 12 first_launch rows on the
// analytics fact (SEED_DATA §2) and 6 fatal crashes on the crash fact (§5).
test('metrics from BOTH facts in one query: launches 12, fatal 6', opts, async (t) => {
  if (skip(t)) return;
  const r = await q(bothCtx, { metrics: ['mix_launches', 'mix_fatal'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].mix_launches), 12);
  assert.equal(num(r.rows[0].mix_fatal), 6);
});

// SEED_DATA §10: players with a REPEATED fatal crash. 3 players crashed at all (u1,u2,u3);
// u1 (3 crashes) and u2 (2) reached a second one, u3 (1) did not.
test('funnel over the crash fact: 3 players crashed, 2 crashed again', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'crash_repeat', source: 'crashlytics' });
  assert.ok(s.draft_id, 'start returns a draft_id');
  const a = await engine.build_native_model({
    action: 'add_step',
    draft_id: s.draft_id,
    stage: {
      stage: 'match_recognize',
      partition_by: ['player_id_of_internal'],
      steps: [
        { name: 'first', event_name: ['fatal_crash'] },
        { name: 'again', event_name: ['fatal_crash'] },
      ],
    },
  });
  assert.equal(a.step_index, 1);
  const c = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  assert.equal(c.rows.length, 3, 'one row per player who crashed');
  assert.equal(c.rows.filter((r) => r.reached_again === true || r.reached_again === 't').length, 2);
  assert.equal(c.provenance?.source, 'crashlytics');
});

// A funnel runs over ONE fact: an event of the OTHER fact is rejected outright rather than
// silently matching nothing.
test('an event of the other fact is rejected in a crash-fact funnel', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'crash_mixed', source: 'crashlytics' });
  const a = await engine.build_native_model({
    action: 'add_step',
    draft_id: s.draft_id,
    stage: {
      stage: 'match_recognize',
      partition_by: ['player_id_of_internal'],
      steps: [
        { name: 'launch', event_name: ['first_launch'] },
        { name: 'crash', event_name: ['fatal_crash'] },
      ],
    },
  }).catch((e) => ({ error: { message: e.message } }));
  assert.ok(a.error, 'a cross-fact step is refused');
  assert.match(String(a.error.message), /first_launch/);
});

// SEED_DATA §10: breadcrumbs_of_event_data is a COMPLEX (JSON array) payload property of the
// crash fact — 20 elements across the 13 rows. Exploding it must read THIS fact's column, so
// the same unnest pipeline that works on the analytics fact works here.
test('unnest an ARRAY payload property of the crash fact = 20 elements, net_retry 4', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'crumbs', source: 'crashlytics' });
  const a = await engine.build_native_model({
    action: 'add_step',
    draft_id: s.draft_id,
    stage: { stage: 'unnest', source: 'breadcrumbs_of_event_data', as: 'crumb', type: 'string' },
  });
  assert.equal(a.step_index, 1);
  const g = await engine.build_native_model({
    action: 'add_step',
    draft_id: s.draft_id,
    stage: { stage: 'aggregate', group_by: ['crumb'], measures: [{ name: 'n', fn: 'count' }] },
  });
  assert.equal(g.step_index, 2);
  const c = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  const by = mapCol(c.rows, 'crumb', 'n');
  assert.equal(sumCol(c.rows, 'n'), 20, 'every array element became a row');
  assert.equal(by.net_retry, 4);
  assert.equal(by.level_start, 4);
  assert.equal(by.ui_freeze, 3);
  assert.equal(by.gc_pause, 3);
  assert.equal(by.iap_start, 1);
});
