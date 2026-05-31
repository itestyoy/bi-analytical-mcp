// The unified pipe-style transformation pipeline (src/pipeline.js), executed on
// DATA: each pipeline is lowered to Postgres SQL and run via `dbt show` against
// the seed, asserting exact numbers. Covers aggregate (group_by), pivot, and
// unpivot. (BigQuery lowers the same op IR to native pipe syntax; not run here.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { DbtRunner } from '../../src/dbt-runner.js';
import { renderPipeline } from '../../src/pipeline.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let pg; let runner; let catalog;
const run = (stages) => runner.show(BASE, renderPipeline(catalog, 'postgres', 'events', stages).sql, 1000);

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  runner = new DbtRunner({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
}, opts);

after(async () => { if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// where -> derive -> join -> aggregate(group_by)
test('pipeline aggregate: IAP revenue by country = US35 / GB25 / BR25', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.country), num(x.revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  assert.equal(r.rows.reduce((s, x) => s + num(x.revenue), 0), 85);
});

// ... |> PIVOT: country values become columns
test('pipeline pivot: revenue pivoted into per-country columns (US=35, GB=25, BR=25)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'pivot', group_by: [], on: 'country', fn: 'sum', value_column: 'price', values: ['US', 'GB', 'BR'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);            // one pivoted row
  const row = r.rows[0];
  assert.equal(num(row.US), 35);
  assert.equal(num(row.GB), 25);
  assert.equal(num(row.BR), 25);
});

// statistical aggregates over the 8 IAP prices [5,5,5,10,10,10,20,20]
test('pipeline statistical aggregates: median=10, stddev≈6.2317, p90=20, p25=5', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'aggregate', group_by: [], measures: [
      { name: 'n', fn: 'count' },
      { name: 'med', fn: 'median', column: 'price' },
      { name: 'sd', fn: 'stddev', column: 'price' },
      { name: 'p90', fn: 'percentile', column: 'price', q: 0.9 },
      { name: 'p25', fn: 'percentile', column: 'price', q: 0.25 },
    ] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = r.rows[0];
  assert.equal(num(row.n), 8);
  assert.equal(num(row.med), 10);
  assert.ok(Math.abs(num(row.sd) - 6.23176) < 1e-3, `stddev=${row.sd}`);
  assert.equal(num(row.p90), 20);
  assert.equal(num(row.p25), 5);
});

// compute: scalar arithmetic over a derived column
test('pipeline compute arithmetic: sum(price*2) = 170 (= 2 × total revenue 85)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'compute', name: 'double_price', op: 'mul', left: { column: 'price' }, right: { value: 2 } },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'd', fn: 'sum', column: 'double_price' }, { name: 's', fn: 'sum', column: 'price' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].d), 170);
  assert.equal(num(r.rows[0].s), 85);
});

// compute window: row_number per user to find repeat purchasers
test('pipeline compute window: row_number per user → exactly 1 user has a 2nd purchase (u1)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'pseq', op: 'window', fn: 'row_number', partition_by: ['appsflyer_id'], order_by: [{ key: 'device_time', direction: 'asc' }] },
    { stage: 'where', conditions: [{ column: 'pseq', op: 'eq', value: 2 }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'repeat_buyers', fn: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].repeat_buyers), 1); // only u1 purchased twice
});

// compute case: bucket prices into tiers
test('pipeline compute case: price tiers low(<10)=3 rows, high(>=10)=5 rows', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'compute', name: 'tier', op: 'case', cases: [{ when: [{ column: 'price', op: 'lt', value: 10 }], then: { value: 'low' } }], else: { value: 'high' } },
    { stage: 'aggregate', group_by: ['tier'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.tier), num(x.n)]));
  assert.equal(by.low, 3);
  assert.equal(by.high, 5);
});

// sample: a 100% sample keeps all rows; a partial sample stays within bounds
test('pipeline sample: 100% keeps all 8 IAP rows; 10% returns a bounded subset', opts, async (t) => {
  if (skip(t)) return;
  const full = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'sample', percent: 100 },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(num(full.rows[0].n), 8); // 100% keeps every row (random() < 1.0 always true)

  const part = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'sample', percent: 10 },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(part.ok, true, JSON.stringify(part));
  const n = num(part.rows[0].n);
  assert.ok(n >= 0 && n <= 8, `sampled count ${n} out of bounds`); // random subset
});

// where with operand constants: column-vs-constant + column-vs-now (in past)
test('pipeline where operands: price>=10 (operand const) and device_time<now → 5 rows summing 70', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'where', conditions: [
      { column: 'event_name', op: 'eq', value: 'iap_purchase_completed' },
      { left: { column: 'price' }, op: 'gte', right: { value: 10 } }, // column vs constant operand
      { left: { column: 'device_time' }, op: 'lt', right: { now: true } }, // column vs now
    ] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', fn: 'count' }, { name: 's', fn: 'sum', column: 'price' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].n), 5); // prices >=10: 10,20,10,20,10
  assert.equal(num(r.rows[0].s), 70);
});

// compute window with a RANGE frame over a unix_date day-number → rolling N-day sum
test('pipeline window RANGE frame: rolling 1-day sum for u1 = {5, 15} (unix_date order key)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'appsflyer_id', op: 'eq', value: 'u1' }, { column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'compute', name: 'day', op: 'unix_date', column: 'device_time' },
    { stage: 'compute', name: 'roll', op: 'window', fn: 'sum', column: 'price', partition_by: ['appsflyer_id'], order_by: [{ key: 'day' }], frame: { mode: 'range', preceding: 1, following: 0 } },
    { stage: 'order_by', keys: [{ key: 'day', direction: 'asc' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rolls = r.rows.map((x) => num(x.roll));
  // u1: 01-01 price 5 → window [day-1,day] = 5; 01-02 price 10 → [day-1,day] = 5+10 = 15
  assert.deepEqual(rolls, [5, 15]);
});

// unnest array-of-struct + json_field: extract BOTH item and qty from one element
test('pipeline unnest struct + json_field: reward item/qty extracted together', opts, async (t) => {
  if (skip(t)) return;
  // seed: level-1 completions grant [coin×10, gem×2]; other completions grant [coin×5].
  // Every level_completed row has a coin reward; gem only on level-1.
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'unnest', source: 'rewards', as: 'rw' },
    { stage: 'compute', name: 'item', op: 'json_field', column: 'rw', field: 'item', type: 'string' },
    { stage: 'compute', name: 'qty', op: 'json_field', column: 'rw', field: 'qty', type: 'int' },
    { stage: 'aggregate', group_by: ['item'], measures: [{ name: 'grants', fn: 'count' }, { name: 'total_qty', fn: 'sum', column: 'qty' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const grants = Object.fromEntries(r.rows.map((x) => [String(x.item), num(x.grants)]));
  const qty = Object.fromEntries(r.rows.map((x) => [String(x.item), num(x.total_qty)]));
  assert.equal(grants.coin, 25); // every level_completed row grants a coin
  assert.ok(grants.gem >= 1 && grants.gem < 25); // gem only on level-1 completions
  assert.equal(qty.gem, 2 * grants.gem); // each gem reward qty = 2 → qty extracted correctly
  assert.equal(qty.coin, 125 + 5 * grants.gem); // level-1 coin=10, others=5: 5*25 + 5*gemCount
});

// compute const: a literal numeric column summed = row count
test('pipeline compute const: a numeric constant column sums to the row count (8 IAP rows)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'one', op: 'const', value: 1 },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'rows', fn: 'sum', column: 'one' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].rows), 8);
});

// compute string ops: concat a product_id with a string constant, upper-cased
test('pipeline compute string/const: concat + upper labels group correctly (P1=3, P2=3, P3=2)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'pid', op: 'extract', source: 'product_id', type: 'string' },
    { stage: 'compute', name: 'label', op: 'concat', parts: [{ column: 'pid' }, { value: '_iap' }] },
    { stage: 'compute', name: 'up', op: 'upper', column: 'label' },
    { stage: 'aggregate', group_by: ['up'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.up), num(x.n)]));
  assert.equal(by.P1_IAP, 3); // p1: e118, e120, e123
  assert.equal(by.P2_IAP, 3); // p2: e119, e122, e125
  assert.equal(by.P3_IAP, 2); // p3: e121, e124
});

// compute: date_diff against the joined install_date (days-since-install)
test('pipeline compute date_diff: u1 purchases on install-day and +1 → sum(dsi)=1, count=2', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'appsflyer_id', op: 'eq', value: 'u1' }, { column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['install_date'] },
    { stage: 'compute', name: 'dsi', op: 'date_diff', from: { column: 'install_date' }, to: { column: 'device_time' }, unit: 'day' },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'total_dsi', fn: 'sum', column: 'dsi' }, { name: 'max_dsi', fn: 'max', column: 'dsi' }, { name: 'n', fn: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].n), 2);
  assert.equal(num(r.rows[0].total_dsi), 1);
  assert.equal(num(r.rows[0].max_dsi), 1);
});

// compute: date_trunc to bucket by month
test('pipeline compute date_trunc: all 8 IAP purchases fall in one month bucket', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'mon', op: 'date_trunc', column: 'device_time', granularity: 'month' },
    { stage: 'aggregate', group_by: ['mon'], measures: [{ name: 'n', fn: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'mon', direction: 'asc' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);
  assert.equal(num(r.rows[0].n), 8);
});

// ... |> UNPIVOT: fold measures back into (metric, value) rows
test('pipeline unpivot: fold revenue+n into rows; US revenue row = 35', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }, { name: 'n', fn: 'count' }] },
    { stage: 'unpivot', keep: ['country'], columns: ['revenue', 'n'], name_as: 'metric', value_as: 'value' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const usRevenue = r.rows.find((x) => String(x.country) === 'US' && String(x.metric) === 'revenue');
  assert.ok(usRevenue, 'US/revenue row present');
  assert.equal(num(usRevenue.value), 35);
  // every country contributes exactly the two folded metrics
  const usRows = r.rows.filter((x) => String(x.country) === 'US');
  assert.equal(usRows.length, 2);
});
