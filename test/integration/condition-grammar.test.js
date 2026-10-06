// ONE CONDITION GRAMMAR (src/schema-kit.js conditionList, src/conditions.js): every `where` is a list
// of conditions that all hold, an item may be { or: [...] } (its items { and: [...] }), and every place
// takes the same operators — the text ones included. Proven on DATA: each count below is the
// warehouse's own count of the same rows, read with SQL written by hand in the test.
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v);
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

let wh;
let engine;
let seq = 0;
const truth = async (sql) => num((await wh.query(sql)).rows[0].n);

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-cond-')), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }) }));
}, opts);
after(async () => { try { engine?.close(); } catch { /* noop */ } if (wh) await wh.stop(); });

/** A pipeline over the events source, materialized; its rows. */
async function pipe(stages) {
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', draft_id: s.draft_id, stages });
  const built = await engine.build_pipeline_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  return { rows: built.rows, draft_id: s.draft_id };
}

test('a where keeps a row when any condition of an { or } holds, beside the conditions that all hold — and a text operator matches as LIKE does', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where (event_name = 'tutorial' or event_name like '%level%') and session_number <= 2");
  const { rows } = await pipe([
    { stage: 'where', conditions: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'event_name', op: 'contains', value: 'level' }] }, { column: 'session_number', op: 'lte', value: 2 }] },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.ok(want > 0, 'the fixture has such rows');
  assert.equal(num(rows[0].n), want);
  // an { and } inside an { or }: tutorials of the first session, or any level event
  const both = await truth("select count(*) as n from fct_analytics_events where (event_name = 'tutorial' and session_number = 1) or event_name like 'level%'");
  const nested = await pipe([
    { stage: 'where', conditions: [{ or: [{ and: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'session_number', op: 'eq', value: 1 }] }, { column: 'event_name', op: 'starts_with', value: 'level' }] }] },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(num(nested.rows[0].n), both);
});

test('a CASE branch takes the same conditions: an { or } in `when` flags the rows either event names', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where event_name in ('tutorial', 'level_started')");
  const { rows } = await pipe([
    { stage: 'compute', name: 'flag', expr: { fn: 'case', cases: [{ when: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'event_name', op: 'eq', value: 'level_started' }] }], then: { value: 1 } }], else: { value: 0 }, type: 'int' } },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'sum', column: 'flag' }] },
  ]);
  assert.equal(num(rows[0].n), want);
});

test('a read of a built model filters and keeps groups with the same grammar: where and having take { or }', opts, async (t) => {
  if (skip(t)) return;
  const { draft_id } = await pipe([{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] }]);
  const want = await truth("select count(*) as n from fct_analytics_events where event_name like 'level%' or event_name = 'tutorial'");
  const read = await engine.query_pipeline_model({ context_id: draft_id, transform: { where: [{ or: [{ column: 'event_name', op: 'starts_with', value: 'level' }, { column: 'event_name', op: 'eq', value: 'tutorial' }] }], aggregations: [{ agg: 'sum', column: 'n', name: 'n' }] } });
  assert.equal(num(read.rows[0].n), want);
  // the names whose count is the smallest or the largest
  const counts = (await wh.query('select event_name, count(*) as n from fct_analytics_events group by 1')).rows.map((r) => num(r.n));
  const lo = Math.min(...counts); const hi = Math.max(...counts);
  const kept = await engine.query_pipeline_model({ context_id: draft_id, transform: { group_by: ['event_name'], aggregations: [{ agg: 'sum', column: 'n', name: 'n' }], having: [{ or: [{ agg: 'sum', column: 'n', op: 'eq', value: lo }, { agg: 'sum', column: 'n', op: 'eq', value: hi }] }] } });
  assert.equal(kept.rows.length, counts.filter((n) => n === lo || n === hi).length);
});

test('a measure\'s where takes an { or }: the count is the rows either condition holds for', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth('select count(*) as n from fct_analytics_events where level_id_of_event_data = 1 or level_id_of_event_data >= 3');
  assert.ok(want > 0, 'the fixture has such rows');
  const built = await engine.build_semantic_model({
    name: 'cond_levels',
    semantic_models: [{ from: 'events', measures: [{ name: 'picked', agg: 'count', field: '*', where: [{ or: [{ property: 'level_id_of_event_data', op: 'eq', value: 1 }, { property: 'level_id_of_event_data', op: 'gte', value: 3 }] }] }] }],
    metrics: [{ name: 'picked', type: 'simple', measure: { name: 'picked' } }],
  });
  assert.ok(built.context_id, JSON.stringify(built.error || built));
  const r = await engine.query_semantic_model({ context_id: built.context_id, metrics: ['cond_levels_picked'], time_range: { start: '2020-01-01', end: '2030-12-31' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].cond_levels_picked), want);
});

test('a metric query\'s where names its field as group_by does, and takes the text operators and { or } too', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where event_name like '%level%' or event_name = 'tutorial'");
  const built = await engine.build_semantic_model({
    name: 'cond_where',
    semantic_models: [{ from: 'events', dimensions: [{ source: 'model_column', column: 'event_name' }], measures: [{ name: 'rows', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'rows', type: 'simple', measure: { name: 'rows' } }],
  });
  assert.ok(built.context_id, JSON.stringify(built.error || built));
  const r = await engine.query_semantic_model({
    context_id: built.context_id, metrics: ['cond_where_rows'], time_range: { start: '2020-01-01', end: '2030-12-31' },
    where: [{ or: [{ field: { model: 'events', attribute: 'event_name' }, op: 'contains', value: 'level' }, { field: { model: 'events', attribute: 'event_name' }, op: 'eq', value: 'tutorial' }] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].cond_where_rows), want);
});

test('a time window whose bounds carry their own offset is those instants, whatever timezone is named beside them', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where device_time >= '2026-01-02 00:00:00' and device_time <= '2026-01-03 23:59:59'");
  const all = await truth('select count(*) as n from fct_analytics_events');
  // read as Anchorage wall-clock instead, the window would move nine hours later — and hold another count
  const local = await truth("select count(*) as n from fct_analytics_events where device_time >= '2026-01-02 09:00:00' and device_time <= '2026-01-04 08:59:59'");
  assert.ok(want > 0 && want < all && want !== local, 'the fixture tells the readings apart');
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events', time_range: { start: '2026-01-02T00:00:00Z', end: '2026-01-03T23:59:59.000Z', timezone: 'America/Anchorage' } });
  await engine.build_pipeline_model({ action: 'add_steps', draft_id: s.draft_id, stages: [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }] });
  const built = await engine.build_pipeline_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  assert.equal(num(built.rows[0].n), want);
});

test('an aggregate measure takes a where of its own: a conditional count and sum beside the unconditional one, in one pass', opts, async (t) => {
  if (skip(t)) return;
  const all = await truth('select count(*) as n from fct_analytics_events');
  const tutorials = await truth("select count(*) as n from fct_analytics_events where event_name = 'tutorial' or event_name like 'level%'");
  const early = await truth('select sum(session_number) as n from fct_analytics_events where session_number <= 2');
  const { rows } = await pipe([
    { stage: 'aggregate', measures: [
      { name: 'n', agg: 'count' },
      { name: 'n_tut', agg: 'count', where: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'event_name', op: 'starts_with', value: 'level' }] }] },
      { name: 's_early', agg: 'sum', column: 'session_number', where: [{ column: 'session_number', op: 'lte', value: 2 }] },
    ] },
  ]);
  assert.ok(tutorials > 0 && tutorials < all, 'the condition keeps some rows, not all');
  assert.deepEqual([num(rows[0].n), num(rows[0].n_tut), num(rows[0].s_early)], [all, tutorials, early]);
});

test('a project stage drops the columns it names and keeps the rest; the next stage still reads them', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth('select count(distinct event_name) as n from fct_analytics_events');
  const { rows } = await pipe([
    { stage: 'project', drop: ['session_number'] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(rows.length, want);
  // once session_number is dropped the next stage cannot name it — refused as the step is added
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', draft_id: s.draft_id, stages: [{ stage: 'project', drop: ['session_number'] }, { stage: 'aggregate', measures: [{ name: 's', agg: 'sum', column: 'session_number' }] }] }), (e) => !(e instanceof assert.AssertionError));
});

test('a query over a built model computes a sample stddev and variance, as the warehouse does', opts, async (t) => {
  if (skip(t)) return;
  const sd = await truth('select stddev_samp(session_number) as n from fct_analytics_events');
  const vr = await truth('select var_samp(session_number) as n from fct_analytics_events');
  const { draft_id } = await pipe([{ stage: 'where', conditions: [{ column: 'session_number', op: 'is_not_null' }] }]);
  const read = await engine.query_pipeline_model({ context_id: draft_id, transform: { aggregations: [{ agg: 'stddev', column: 'session_number', name: 'sd' }, { agg: 'variance', column: 'session_number', name: 'vr' }] } });
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  assert.ok(sd > 0, 'the fixture has spread');
  assert.ok(Math.abs(num(read.rows[0].sd) - sd) < 1e-9 && Math.abs(num(read.rows[0].vr) - vr) < 1e-9);
});

test('a query over a built model reads columns named with reserved words (order, group): every name is quoted', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where event_name = 'tutorial'");
  const { draft_id } = await pipe([
    { stage: 'compute', name: 'group', expr: { column: 'event_name' } },
    { stage: 'aggregate', group_by: ['group'], measures: [{ name: 'order', agg: 'count' }] },
  ]);
  const read = await engine.query_pipeline_model({ context_id: draft_id, transform: { where: [{ column: 'group', op: 'eq', value: 'tutorial' }], group_by: ['group'], aggregations: [{ agg: 'sum', column: 'order', name: 'select' }], order_by: [{ key: 'select', direction: 'desc' }] } });
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  assert.deepEqual(read.rows.map((r) => [r.group, num(r.select)]), [['tutorial', want]]);
});

test('a text column of the warehouse compared with a boolean matches the ways text spells the flag, not run as STRING = BOOL', opts, async (t) => {
  if (skip(t)) return;
  const all = await truth('select count(*) as n from fct_analytics_events where bundle_id is not null');
  const truthy = await truth("select count(*) as n from fct_analytics_events where lower(trim(bundle_id)) in ('true', '1', 't')");
  const { rows } = await pipe([
    { stage: 'aggregate', measures: [
      { name: 'yes', agg: 'count', where: [{ column: 'bundle_id', op: 'eq', value: true }] },
      { name: 'no', agg: 'count', where: [{ column: 'bundle_id', op: 'ne', value: true }] },
    ] },
  ]);
  assert.ok(all > 0, 'the fixture has the column filled');
  assert.deepEqual([num(rows[0].yes), num(rows[0].no)], [truthy, all - truthy]);
  // an order compares no flag: refused as the step is added
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await assert.rejects(engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ column: 'bundle_id', op: 'gt', value: false }] } }), /text column in the warehouse/);
});

test('a raw expression takes its columns positionally, in args: the server writes each quoted, a reserved word too', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth('select sum(session_number * 2) as n from fct_analytics_events');
  const { rows } = await pipe([
    { stage: 'compute', name: 'order', expr: { column: 'session_number' } },
    { stage: 'compute', name: 'twice', expr: { fn: 'raw', sql: '{1} * 2', args: [{ column: 'order' }], type: 'int' } },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'sum', column: 'twice' }] },
  ]);
  assert.equal(num(rows[0].n), want);
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'compute', name: 'order', expr: { column: 'session_number' } } });
  // a placeholder with no argument, and an argument no placeholder uses, are refused
  await assert.rejects(engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'compute', name: 'twice', expr: { fn: 'raw', sql: '{2} * 2', args: [{ column: 'order' }] } } }), /has no argument/);
  await assert.rejects(engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'compute', name: 'twice', expr: { fn: 'raw', sql: '2', args: [{ column: 'order' }] } } }), /not used/);
});

test('preview with validate runs the draft\'s SQL against the warehouse with no data read: a refusal there is said, and nothing is left in the project', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', draft_id: s.draft_id, stages: [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'tutorial' }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
  ] });
  const good = await engine.build_pipeline_model({ action: 'preview', draft_id: s.draft_id, validate: true });
  assert.equal(good.ok, true, JSON.stringify(good.error));
  assert.equal(good.validated, true);
  // a function the warehouse does not have: only the warehouse can say so
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'compute', name: 'bad', expr: { fn: 'raw', sql: 'no_such_function_xyz({1})', args: [{ column: 'n' }] } } });
  const bad = await engine.raw.build_pipeline_model({ action: 'preview', draft_id: s.draft_id, validate: true });
  const read = await engine.raw.query_pipeline_model({ task_ids: [bad.task_id] });
  assert.equal(read.results[0].ok, false, JSON.stringify(read.results[0]));
  assert.ok(!engine.ctxs.generatedFiles(s.draft_id).some((f) => /_chk/.test(f)), 'the check left no model behind');
});

test('a time column compared with an expression that yields a moment keeps the rows the warehouse keeps; with a number it is refused as the step is added', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where device_time >= TIMESTAMP '2026-01-03 00:00:00'");
  const all = await truth('select count(*) as n from fct_analytics_events');
  assert.ok(want > 0 && want < all, 'the bound keeps some rows, not all');
  const { rows } = await pipe([
    { stage: 'where', conditions: [{ left: { column: 'device_time' }, op: 'gte', right: { fn: 'raw', sql: "DATE '2026-01-03'" } }] },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(num(rows[0].n), want);
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await assert.rejects(engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ left: { column: 'device_time' }, op: 'gte', right: { fn: 'length', args: [{ column: 'event_name' }] } }] } }), /is a moment/);
});
