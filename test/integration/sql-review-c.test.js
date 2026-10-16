// A BOOLEAN A COMPUTE STAGE STORES IS NEVER NULL, and AN UNPIVOT OF TEXT COLUMNS IS COMPARED AS TEXT.
// (1) Whatever makes the boolean — a condition, array_contains, a case whose branches are booleans — where it
// cannot be decided it does not hold, so it is stored false: array_contains over an array property on the
// rows that lack it (DuckDB's JSON read of a missing array is NULL), a case of `true` with no else on the
// rows no branch takes. SEED_DATA: 184 events; `words_collected` holds 'cat' on 12 level_completed rows,
// is an array on 25 and missing (or no array, e2) on the rest; 16 tutorial events.
// (2) The value column of an unpivot of two text columns is text, so a where finds a text in it; (3) of a
// DATE and a TIMESTAMP, a moment.
// Proven on DATA against DuckDB. Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v === '' || v == null ? NaN : v);
/** A flag as a row holds it (true, 't', …), or 'missing'. */
const flag = (v) => (v == null || v === '' ? 'missing' : String([true, 't', 'true', 1, '1'].includes(v)));

let wh;
let engine;
let seq = 0;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('sql-review-c'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }) }));
}, opts);

after(async () => { if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** The rows a pipeline over the events source leaves after `steps`, materialized. */
async function rows(steps) {
  const s = await engine.build_model({ action: 'start', name: `review_c_${seq++}`, source: 'events' });
  await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps });
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}
const COUNT = { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] };
const isFalse = (column) => ({ stage: 'where', conditions: [{ fn: 'eq', args: [{ column }, { value: false }] }] });

test('a boolean a compute stores is never missing: array_contains over an array property on rows that lack it is false', opts, async (t) => {
  if (skip(t)) return;
  const [all] = (await wh.query('select count(*) as n from fct_analytics_events')).rows;
  assert.equal(num(all.n), 184);
  const hasCat = { stage: 'compute', name: 'has_cat', expr: { fn: 'array_contains', args: [{ property: 'words_collected' }, { value: 'cat' }] } };
  // every row is true or false — none missing
  const groups = await rows([hasCat, { stage: 'aggregate', group_by: ['has_cat'], measures: [{ name: 'n', expr: { fn: 'count' } }] }]);
  assert.deepEqual(Object.fromEntries(groups.map((r) => [flag(r.has_cat), num(r.n)])), { true: 12, false: 172 });
  // …so a where on false keeps every row without 'cat', the rows without the array among them
  const [notCat] = await rows([hasCat, isFalse('has_cat'), COUNT]);
  assert.equal(num(notCat.n), num(all.n) - 12);
});

test('a boolean a compute stores is never missing: a case of true with no else is false on the rows no branch takes', opts, async (t) => {
  if (skip(t)) return;
  const tut = { stage: 'compute', name: 'is_tutorial', expr: { fn: 'case', cases: [{ when: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'tutorial' }] }], then: { value: true } }] } };
  const [other] = await rows([tut, isFalse('is_tutorial'), COUNT]);
  assert.equal(num(other.n), 184 - 16);
});

test('an unpivot of two text columns makes a text value column: a where finds a text in it', opts, async (t) => {
  if (skip(t)) return;
  const out = await rows([
    { stage: 'unpivot', keep: ['event_id'], columns: ['event_name', 'bundle_id'], name_column: 'which', value_column: 'text' },
    { stage: 'where', conditions: [{ fn: 'in', args: [{ column: 'text' }, { value: 'tutorial' }, { value: 'com.omg.colorfit' }] }] },
    { stage: 'aggregate', group_by: ['which', 'text'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ]);
  assert.deepEqual(Object.fromEntries(out.map((r) => [`${r.which}/${r.text}`, num(r.n)])), { 'event_name/tutorial': 16, 'bundle_id/com.omg.colorfit': 53 });
});

// (3) An unpivot of a DATE and a TIMESTAMP (both moments) folds them into one moment column — a date its
// midnight (BigQuery's lowering reads each as a TIMESTAMP, as DuckDB's UNION ALL promotes them) — and a
// where compares that column as a moment. e1 arrived on the day of its event, e108 three days later.
test('an unpivot of a DATE and a TIMESTAMP folds them into moments: each its own, a date its midnight', opts, async (t) => {
  if (skip(t)) return;
  const want = (await wh.query(`select event_id, strftime(cast(event_date as timestamp), '%Y-%m-%d %H:%M:%S') as day, strftime(device_time, '%Y-%m-%d %H:%M:%S') as at
    from fct_analytics_events where event_id in ('e1', 'e108')`)).rows;
  const expected = Object.fromEntries(want.flatMap((r) => [[`${r.event_id}/event_date`, r.day], [`${r.event_id}/device_time`, r.at]]));
  const fold = [
    { stage: 'where', conditions: [{ fn: 'in', args: [{ column: 'event_id' }, { value: 'e1' }, { value: 'e108' }] }] },
    { stage: 'unpivot', keep: ['event_id'], columns: ['event_date', 'device_time'], name_column: 'which', value_column: 'at' },
    { stage: 'compute', name: 'at_text', expr: { fn: 'substring', args: [{ fn: 'cast', args: [{ column: 'at' }], type: 'string' }], start: 1, len: 19 } },
  ];
  const out = await rows([...fold, { stage: 'project', keep: ['event_id', 'which', 'at_text'] }]);
  assert.deepEqual(Object.fromEntries(out.map((r) => [`${r.event_id}/${r.which}`, String(r.at_text)])), expected);
  // the value column is a moment: the folded values from 2026-01-02 on are e108's arrival day alone
  const later = await rows([...fold, { stage: 'where', conditions: [{ fn: 'gte', args: [{ column: 'at' }, { value: '2026-01-02' }] }] }, { stage: 'project', keep: ['event_id', 'which'] }]);
  assert.deepEqual(later.map((r) => `${r.event_id}/${r.which}`), Object.keys(expected).filter((k) => expected[k] >= '2026-01-02'));
});
