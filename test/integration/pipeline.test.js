// The unified pipe-style transformation pipeline (src/pipeline.js), executed on
// DATA: each pipeline is lowered to DuckDB SQL and run via `dbt show` against
// the seed, asserting exact numbers. Covers aggregate (group_by), pivot, and
// unpivot. (BigQuery lowers the same op IR to native pipe syntax; not run here.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { createDbt } from '../../src/dbt/index.js';
import { renderPipeline } from '../../src/pipeline.js';
import { startWarehouse } from './warehouse-harness.js';
import { DBT_BIN, MF_BIN, PY_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let wh; let runner; let catalog;
const run = (stages) => runner.show(BASE, renderPipeline(catalog, 'duckdb', 'events', stages).sql, 1000);

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  runner = createDbt({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
}, opts);

after(async () => { if (wh) await wh.stop(); });
// dim_users is SLOWLY-CHANGING (one row per player per validity window), so every join to it
// is point-in-time: the declared player key AND the event time inside the window. Without the
// window a player with several versions matches all of them and counts inflate.
const AT = (value) => ({ value, from: 'install_time_valid_from', to: 'install_time_valid_until' });

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// where -> derive -> join -> aggregate(group_by)
test('pipeline aggregate: IAP revenue by country = US35 / GB25 / BR25', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.country), num(x.revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  assert.equal(r.rows.reduce((s, x) => s + num(x.revenue), 0), 85);
});

// unnest a FLAT array column stored as a JSON-encoded STRING (mirrors the real
// warehouse: words_selected lands as text like '["cat","dog"]'). meta.mcp.array
// (encoding: json) tells the engine to parse it before exploding — no fake event_data.
test('pipeline unnest: explode words_selected (JSON-string array) and count per word', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'unnest', source: 'words_selected_of_event_data', as: 'word' },
    { stage: 'aggregate', group_by: ['word'], measures: [{ name: 'n', fn: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.word), num(x.n)]));
  assert.equal(by.cat, 12); assert.equal(by.dog, 12); assert.equal(by.sun, 12);
  assert.equal(by.moon, 4); assert.equal(by.star, 4); assert.equal(by.tree, 3); assert.equal(by.x, 6);
  assert.equal(r.rows.reduce((s, x) => s + num(x.n), 0), 53); // total word occurrences across level_completed
  assert.equal(r.rows.length, 7);                              // distinct words
});

// #4 + json_parse_array: the flat payload column is referenceable directly in the
// pipeline (no users-join), compute json_parse_array turns the JSON STRING into a
// native array, and unnest explodes that derived column.
test('pipeline json_parse_array + unnest: parse a flat JSON-string column then explode', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'compute', name: 'words_arr', op: 'json_parse_array', column: 'words_selected_of_event_data' },
    { stage: 'unnest', source: 'words_arr', as: 'word' },
    { stage: 'aggregate', group_by: ['word'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.word), num(x.n)]));
  assert.equal(by.cat, 12); assert.equal(by.x, 6);
  assert.equal(r.rows.reduce((s, x) => s + num(x.n), 0), 53);
});

// #2: array primitives — last element ("последнее слово") and indexed element.
test('pipeline array_last / element_at: last & first word per completed level', opts, async (t) => {
  if (skip(t)) return;
  const stages = (pick) => [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'compute', name: 'wa', op: 'json_parse_array', column: 'words_selected_of_event_data' },
    pick,
    { stage: 'where', conditions: [{ column: 'w', op: 'is_not_null' }] },
    { stage: 'aggregate', group_by: ['w'], measures: [{ name: 'n', fn: 'count' }] },
  ];
  const last = await run(stages({ stage: 'compute', name: 'w', op: 'array_last', column: 'wa' }));
  assert.equal(last.ok, true, JSON.stringify(last));
  const byLast = Object.fromEntries(last.rows.map((x) => [String(x.w), num(x.n)]));
  assert.deepEqual(byLast, { sun: 12, star: 4, tree: 3, x: 6 });
  const first = await run(stages({ stage: 'compute', name: 'w', op: 'element_at', column: 'wa', index: 1 }));
  const byFirst = Object.fromEntries(first.rows.map((x) => [String(x.w), num(x.n)]));
  assert.deepEqual(byFirst, { cat: 12, moon: 4, tree: 3, x: 6 });
});

// #2: raw SQL escape hatch — verbatim dialect expression when no built-in op fits.
test('pipeline raw: a verbatim SQL expression is evaluated', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'compute', name: 'ev', op: 'raw', sql: 'upper(event_name)' },
    { stage: 'aggregate', group_by: ['ev'], measures: [{ name: 'n', fn: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);
  assert.equal(String(r.rows[0].ev), 'LEVEL_COMPLETED');
});

// #8: string matching in where (starts_with / contains / like) — find by prefix/substring.
test('pipeline where starts_with / contains: iap_purchase_* events', opts, async (t) => {
  if (skip(t)) return;
  const agg = async (cond) => {
    const r = await run([
      { stage: 'where', conditions: [cond] },
      { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] },
    ]);
    assert.equal(r.ok, true, JSON.stringify(r));
    return Object.fromEntries(r.rows.map((x) => [String(x.event_name), num(x.n)]));
  };
  const byPrefix = await agg({ column: 'event_name', op: 'starts_with', value: 'iap_purchase_' });
  assert.deepEqual(byPrefix, { iap_purchase_completed: 8, iap_purchase_failed: 3 });
  const byContains = await agg({ column: 'event_name', op: 'contains', value: 'purchase' });
  assert.deepEqual(byContains, { iap_purchase_completed: 8, iap_purchase_failed: 3 });
});

// ... |> PIVOT: country values become columns
test('pipeline pivot: revenue pivoted into per-country columns (US=35, GB=25, BR=25)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: ['country'] },
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
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
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

// compute elapsed_days: whole 24-HOUR buckets between two timestamps (retention-day), NOT
// calendar days. Deterministic via LITERAL endpoints so it does not depend on seed offsets:
// 25h→1, 47h59m→1, 48h→2, and a negative (pre-`from`) span clamped to 0.
test('pipeline elapsed_days: 24h buckets (25h=1, 47h59m=1, 48h=2, negative→0)', opts, async (t) => {
  if (skip(t)) return;
  const ed = (name, from, to, extra = {}) => ({ stage: 'compute', name, op: 'elapsed_days', from: { value: from }, to: { value: to }, ...extra });
  const r = await run([
    ed('d25h', '2026-01-01 23:00:00', '2026-01-03 00:00:00'),   // 25h → 1
    ed('d47h', '2026-01-01 00:00:00', '2026-01-02 23:59:00'),   // 47h59m → 1 (calendar would be 2)
    ed('d48h', '2026-01-01 00:00:00', '2026-01-03 00:00:00'),   // 48h → 2
    ed('dneg', '2026-01-03 00:00:00', '2026-01-01 00:00:00'),   // −48h → clamped to 0
    ed('draw', '2026-01-03 00:00:00', '2026-01-01 00:00:00', { clamp_zero: false }), // raw signed → −2
    { stage: 'limit', n: 1 },
    { stage: 'project', columns: ['d25h', 'd47h', 'd48h', 'dneg', 'draw'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = r.rows[0];
  assert.equal(num(row.d25h), 1);
  assert.equal(num(row.d47h), 1);
  assert.equal(num(row.d48h), 2);
  assert.equal(num(row.dneg), 0);
  assert.equal(num(row.draw), -2);
});

// compute: scalar arithmetic over a derived column
test('pipeline compute arithmetic: sum(price*2) = 170 (= 2 × total revenue 85)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
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
    { stage: 'compute', name: 'pseq', op: 'window', fn: 'row_number', partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time', direction: 'asc' }] },
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
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
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
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
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
    { stage: 'where', conditions: [{ column: 'player_id_of_internal', op: 'eq', value: 'u1' }, { column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'compute', name: 'day', op: 'unix_date', column: 'device_time' },
    { stage: 'compute', name: 'roll', op: 'window', fn: 'sum', column: 'price', partition_by: ['player_id_of_internal'], order_by: [{ key: 'day' }], frame: { mode: 'range', preceding: 1, following: 0 } },
    { stage: 'order_by', keys: [{ key: 'day', direction: 'asc' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rolls = r.rows.map((x) => num(x.roll));
  // u1: 01-01 price 5 → window [day-1,day] = 5; 01-02 price 10 → [day-1,day] = 5+10 = 15
  assert.deepEqual(rolls, [5, 15]);
});

// approx_count_distinct (HLL++): BigQuery APPROX_COUNT_DISTINCT; DuckDB exact
test('pipeline approx_count_distinct: distinct payers = 7 (exact on DuckDB)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'payers', fn: 'approx_count_distinct', column: 'player_id_of_internal' }, { name: 'exact', fn: 'count_distinct', column: 'player_id_of_internal' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].payers), 7); // u1,u3,u5,u7,u9,u10,u11
  assert.equal(num(r.rows[0].exact), 7); // exact fallback agrees on this small set
});

// HLL sketches are ADDITIVE: per-product sketches MERGE to the true distinct count
// (deduping the overlap), whereas summing per-product distinct counts double-counts.
test('pipeline HLL hll_init→hll_merge: merged distinct buyers = 7 (naive sum = 8)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'pid', op: 'extract', source: 'product_id_of_event_data', type: 'string' },
    { stage: 'aggregate', group_by: ['pid'], measures: [{ name: 'sk', fn: 'hll_init', column: 'player_id_of_internal' }, { name: 'n', fn: 'count_distinct', column: 'player_id_of_internal' }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'merged', fn: 'hll_merge', column: 'sk' }, { name: 'naive', fn: 'sum', column: 'n' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].merged), 7); // distinct buyers across products (u1 counted once)
  assert.equal(num(r.rows[0].naive), 8); // 3 + 3 + 2 — double-counts u1 (proves merge is additive/dedup)
});

// hll_merge_partial keeps additivity as a coarser sketch; hll_extract reads cardinality
test('pipeline HLL hll_merge_partial→hll_extract: staged merge then extract = 7', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'pid', op: 'extract', source: 'product_id_of_event_data', type: 'string' },
    { stage: 'aggregate', group_by: ['pid'], measures: [{ name: 'sk', fn: 'hll_init', column: 'player_id_of_internal' }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'merged', fn: 'hll_merge_partial', column: 'sk' }] },
    { stage: 'compute', name: 'total', op: 'hll_extract', column: 'merged' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].total), 7);
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
    { stage: 'derive', name: 'pid', op: 'extract', source: 'product_id_of_event_data', type: 'string' },
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
    { stage: 'where', conditions: [{ column: 'player_id_of_internal', op: 'eq', value: 'u1' }, { column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: ['install_date'] },
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
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: ['country'] },
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

// THE TWO-PASS LADDER that replaces a global analytic window. Pass 1 collapses the table to ONE row
// of statistics (an aggregate with no group_by — no window, no ordering, nothing held in a single
// worker's memory). Pass 2 puts those numbers back on the rows as LITERALS: `least` clamps at the
// threshold and sub/div give the z-score. Both passes are asserted on the seed's real numbers.
//
// The shape matters because the alternative fails in production: AVG/STDDEV/PERCENTILE_CONT over
// `OVER ()` keeps every row and attaches the value to each, which exhausted a query's memory on
// ~6.3M rows ("Resources exceeded during query execution") even after the exact percentile was
// removed.
test('a table-wide statistic is ONE row, and its numbers scale the rows as literals', opts, async (t) => {
  if (skip(t)) return;
  const perPlayer = [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' },
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
  ];

  // PASS 1 — one row: the count, the mean, the max. No group_by, no window.
  const stats = await run([...perPlayer, {
    stage: 'aggregate',
    measures: [
      { name: 'players', fn: 'count' },
      { name: 'revenue_avg', fn: 'avg', column: 'revenue' },
      { name: 'revenue_max', fn: 'max', column: 'revenue' },
      { name: 'revenue_median', fn: 'median', column: 'revenue' },
    ],
  }]);
  assert.equal(stats.ok, true, JSON.stringify(stats));
  assert.equal(stats.rows.length, 1, 'a table-wide statistic is exactly one row');
  const players = num(stats.rows[0].players);
  const mean = num(stats.rows[0].revenue_avg);
  const max = num(stats.rows[0].revenue_max);
  // the seed: total IAP revenue is US 35 + GB 25 + BR 25 = 85, spread over the paying players
  assert.ok(players >= 2, `expected several payers, got ${players}`);
  assert.ok(Math.abs(mean * players - 85) < 1e-6, `the mean times the count is the total: ${mean} * ${players}`);

  // PASS 2 — those numbers as literals: clamp at a threshold, then centre and scale. The clamp is
  // set BELOW the maximum on purpose, so the winsorizing is visible in the numbers.
  const cap = max - 1;
  const rows = await run([...perPlayer,
    { stage: 'compute', name: 'revenue_capped', op: 'least', parts: [{ column: 'revenue' }, { value: cap }] },
    { stage: 'compute', name: 'revenue_floored', op: 'greatest', parts: [{ column: 'revenue_capped' }, { value: 1 }] },
    { stage: 'compute', name: 'centered', op: 'sub', left: { column: 'revenue_capped' }, right: { value: mean } },
    { stage: 'compute', name: 'revenue_z', op: 'div', left: { column: 'centered' }, right: { value: 10 } },
  ]);
  assert.equal(rows.ok, true, JSON.stringify(rows));
  assert.equal(rows.rows.length, players, 'pass 2 keeps one row per player');
  for (const row of rows.rows) {
    const revenue = num(row.revenue);
    assert.equal(num(row.revenue_capped), Math.min(revenue, cap), `least(revenue, ${cap}) on ${revenue}`);
    assert.equal(num(row.revenue_floored), Math.max(Math.min(revenue, cap), 1));
    assert.ok(Math.abs(num(row.revenue_z) - (Math.min(revenue, cap) - mean) / 10) < 1e-6, `z of ${revenue}`);
  }
  assert.ok(rows.rows.some((row) => num(row.revenue_capped) < num(row.revenue)), 'at least one row was actually clamped');
});
