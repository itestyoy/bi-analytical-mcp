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
