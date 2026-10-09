// The unified pipe-style transformation pipeline (src/pipeline.js), executed on
// DATA: each pipeline is lowered to DuckDB SQL and run via `dbt show` against
// the seed, asserting exact numbers. Covers aggregate (group_by), pivot, and
// unpivot. (BigQuery lowers the same op IR to native pipe syntax; not run here.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { createDbt } from '../../src/dbt/index.js';
import { renderPipeline } from '../../src/pipeline.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { DBT_BIN, MF_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
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
const AT = (column) => ({ column, from: 'install_time_valid_from', to: 'install_time_valid_until' });

const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// (where -> compute (an event property) -> join -> aggregate(group_by), IAP revenue by country
// US 35 / GB 25 / BR 25: the first unpivot test reads it off the rows it folds.)

// unnest a FLAT array column stored as a JSON-encoded STRING (mirrors the real
// warehouse: words_selected lands as text like '["cat","dog"]'). meta.mcp.array
// (encoding: json) tells the engine to parse it before exploding — no fake event_data.
test('pipeline unnest: explode words_selected (JSON-string array) and count per word', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'unnest', property: 'words_selected_of_event_data', name: 'word' },
    { stage: 'aggregate', group_by: ['word'], measures: [{ name: 'n', agg: 'count' }] },
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
    { stage: 'compute', name: 'words_arr', expr: { fn: 'json_parse_array', args: [{ column: 'words_selected_of_event_data' }] } },
    { stage: 'unnest', column: 'words_arr', name: 'word' },
    { stage: 'aggregate', group_by: ['word'], measures: [{ name: 'n', agg: 'count' }] },
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
    { stage: 'compute', name: 'wa', expr: { fn: 'json_parse_array', args: [{ column: 'words_selected_of_event_data' }] } },
    pick,
    { stage: 'where', conditions: [{ column: 'w', op: 'is_not_null' }] },
    { stage: 'aggregate', group_by: ['w'], measures: [{ name: 'n', agg: 'count' }] },
  ];
  const last = await run(stages({ stage: 'compute', name: 'w', expr: { fn: 'array_last', args: [{ column: 'wa' }] } }));
  assert.equal(last.ok, true, JSON.stringify(last));
  const byLast = Object.fromEntries(last.rows.map((x) => [String(x.w), num(x.n)]));
  assert.deepEqual(byLast, { sun: 12, star: 4, tree: 3, x: 6 });
  const first = await run(stages({ stage: 'compute', name: 'w', expr: { fn: 'element_at', args: [{ column: 'wa' }], index: 1 } }));
  const byFirst = Object.fromEntries(first.rows.map((x) => [String(x.w), num(x.n)]));
  assert.deepEqual(byFirst, { cat: 12, moon: 4, tree: 3, x: 6 });
});

// #2: raw SQL escape hatch — verbatim dialect expression when no built-in op fits.
test('pipeline raw: a verbatim SQL expression is evaluated', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
    { stage: 'compute', name: 'ev', expr: { fn: 'raw', sql: 'upper({1})', args: [{ column: 'event_name' }] } },
    { stage: 'aggregate', group_by: ['ev'], measures: [{ name: 'n', agg: 'count' }] },
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
      { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
    ]);
    assert.equal(r.ok, true, JSON.stringify(r));
    return Object.fromEntries(r.rows.map((x) => [String(x.event_name), num(x.n)]));
  };
  const byPrefix = await agg({ column: 'event_name', op: 'starts_with', value: 'iap_purchase_' });
  assert.deepEqual(byPrefix, { iap_purchase_completed: 8, iap_purchase_failed: 3 });
  const byContains = await agg({ column: 'event_name', op: 'contains', value: 'purchase' });
  assert.deepEqual(byContains, { iap_purchase_completed: 8, iap_purchase_failed: 3 });
});

// pivot: each listed value of `on` a column of its own, holding the measure over that value's rows —
// the aggregate stage's conditional measures, so a count counts rows (not cells) on every warehouse
const IAP_BY_COUNTRY = [
  { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
  { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
  { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: [{ column: 'country' }] },
];
const COUNTRIES = [{ value: 'US', name: 'us' }, { value: 'GB', name: 'gb' }, { value: 'BR', name: 'br' }];
test('pipeline pivot: revenue pivoted into per-country columns (US=35, GB=25, BR=25)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([...IAP_BY_COUNTRY, { stage: 'pivot', group_by: [], on: 'country', measure: { agg: 'sum', column: 'price' }, values: COUNTRIES }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);            // one pivoted row
  const row = r.rows[0];
  assert.equal(num(row.us), 35);
  assert.equal(num(row.gb), 25);
  assert.equal(num(row.br), 25);
});

test('pipeline pivot: a count per cell is the rows of that value — the aggregate stage\'s count by country, 8 in all', opts, async (t) => {
  if (skip(t)) return;
  const grouped = await run([...IAP_BY_COUNTRY, { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', agg: 'count' }, { name: 'payers', agg: 'count_distinct', column: 'player_id_of_internal' }] }]);
  const pivoted = await run([...IAP_BY_COUNTRY, { stage: 'pivot', on: 'country', measure: { agg: 'count' }, values: COUNTRIES }]);
  const payers = await run([...IAP_BY_COUNTRY, { stage: 'pivot', on: 'country', measure: { agg: 'count_distinct', column: 'player_id_of_internal' }, values: COUNTRIES }]);
  assert.equal(grouped.ok && pivoted.ok && payers.ok, true, JSON.stringify([grouped, pivoted, payers].find((x) => !x.ok)));
  const by = Object.fromEntries(grouped.rows.map((x) => [String(x.country), x]));
  for (const { value, name } of COUNTRIES) {
    assert.equal(num(pivoted.rows[0][name]), num(by[value].n), `${value}: rows`);
    assert.equal(num(payers.rows[0][name]), num(by[value].payers), `${value}: payers`);
  }
  assert.equal(COUNTRIES.reduce((a, c) => a + num(pivoted.rows[0][c.name]), 0), 8); // the 8 purchases, one cell each
  assert.ok(COUNTRIES.some((c) => num(pivoted.rows[0][c.name]) > 1), 'a cell holds more than one row — a count of cells would read 1');
});

test('pipeline pivot: a numeric column pivots by number, a missing value is a column too, per group', opts, async (t) => {
  if (skip(t)) return;
  // the session number of every event, per event name: sessions 1 and 2 as numbers, and the rows with none
  const base = [{ stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['first_launch', 'new_session'] }] }];
  const grouped = await run([...base, { stage: 'aggregate', group_by: ['event_name', 'session_number'], measures: [{ name: 'n', agg: 'count' }] }]);
  const pivoted = await run([...base, { stage: 'pivot', group_by: ['event_name'], on: 'session_number', measure: { agg: 'count' }, values: [{ value: 1, name: 's1' }, { value: 2, name: 's2' }, { value: null, name: 'none' }] }]);
  assert.equal(grouped.ok && pivoted.ok, true, JSON.stringify([grouped, pivoted].find((x) => !x.ok)));
  const cell = (ev, s) => num(grouped.rows.find((x) => String(x.event_name) === ev && (s === null ? x.session_number == null : num(x.session_number) === s))?.n ?? 0);
  assert.equal(pivoted.rows.length, 2);
  for (const row of pivoted.rows) {
    const ev = String(row.event_name);
    assert.equal(num(row.s1), cell(ev, 1), `${ev}: session 1`);
    assert.equal(num(row.s2), cell(ev, 2), `${ev}: session 2`);
    assert.equal(num(row.none), cell(ev, null), `${ev}: no session`);
  }
  assert.ok(pivoted.rows.some((row) => num(row.s1) > 0), 'session 1 is counted');
});

// ONE ungrouped aggregate over the 8 IAP prices [5,5,5,10,10,10,20,20] carries what were four
// tests: the statistical aggregates, compute arithmetic, a constant column, and approx_count_distinct
// (HLL++: BigQuery APPROX_COUNT_DISTINCT; DuckDB exact).
test('pipeline: one ungrouped aggregate over the 8 IAP rows — median / stddev / p90 / p25, sum(price*2) = 170 and sum(price) = 85, a constant column summing to 8, approx and exact distinct payers 7', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    // compute: scalar arithmetic over a derived column
    { stage: 'compute', name: 'double_price', expr: { fn: 'mul', args: [{ column: 'price' }, { value: 2 }] } },
    // compute const: a literal numeric column
    { stage: 'compute', name: 'one', expr: { value: 1 } },
    { stage: 'aggregate', group_by: [], measures: [
      { name: 'n', agg: 'count' },
      { name: 'med', agg: 'median', column: 'price' },
      { name: 'sd', agg: 'stddev', column: 'price' },
      { name: 'p90', agg: 'percentile', column: 'price', percentile: 0.9 },
      { name: 'p25', agg: 'percentile', column: 'price', percentile: 0.25 },
      { name: 'd', agg: 'sum', column: 'double_price' },
      { name: 's', agg: 'sum', column: 'price' },
      { name: 'rows', agg: 'sum', column: 'one' },
      { name: 'payers', agg: 'approx_count_distinct', column: 'player_id_of_internal' },
      { name: 'exact', agg: 'count_distinct', column: 'player_id_of_internal' },
    ] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = r.rows[0];
  // 'pipeline statistical aggregates: median=10, stddev≈6.2317, p90=20, p25=5'
  assert.equal(num(row.n), 8, '[statistical aggregates] n');
  assert.equal(num(row.med), 10, '[statistical aggregates] median');
  assert.ok(Math.abs(num(row.sd) - 6.23176) < 1e-3, `[statistical aggregates] stddev=${row.sd}`);
  assert.equal(num(row.p90), 20, '[statistical aggregates] p90');
  assert.equal(num(row.p25), 5, '[statistical aggregates] p25');
  // 'pipeline compute arithmetic: sum(price*2) = 170 (= 2 × total revenue 85)'
  assert.equal(num(row.d), 170, '[compute arithmetic] sum(price*2)');
  assert.equal(num(row.s), 85, '[compute arithmetic] sum(price)');
  // 'pipeline compute const: a numeric constant column sums to the row count (8 IAP rows)'
  assert.equal(num(row.rows), 8, '[compute const] the constant column sums to the row count');
  // 'pipeline approx_count_distinct: distinct payers = 7 (exact on DuckDB)': u1,u3,u5,u7,u9,u10,u11
  assert.equal(num(row.payers), 7, '[approx_count_distinct] distinct payers');
  assert.equal(num(row.exact), 7, '[approx_count_distinct] the exact count agrees on this small set');
});

// compute elapsed_days: whole 24-HOUR buckets between two timestamps (retention-day), NOT
// calendar days. Deterministic via LITERAL endpoints so it does not depend on seed offsets:
// 25h→1, 47h59m→1, 48h→2, and a negative (pre-`from`) span clamped to 0.
test('pipeline elapsed_days: 24h buckets (25h=1, 47h59m=1, 48h=2, negative→0)', opts, async (t) => {
  if (skip(t)) return;
  const ed = (name, from, to, extra = {}) => ({ stage: 'compute', name, expr: { fn: 'elapsed_days', args: [{ value: from }, { value: to }], ...extra } });
  const r = await run([
    ed('d25h', '2026-01-01 23:00:00', '2026-01-03 00:00:00'),   // 25h → 1
    ed('d47h', '2026-01-01 00:00:00', '2026-01-02 23:59:00'),   // 47h59m → 1 (calendar would be 2)
    ed('d48h', '2026-01-01 00:00:00', '2026-01-03 00:00:00'),   // 48h → 2
    ed('dneg', '2026-01-03 00:00:00', '2026-01-01 00:00:00'),   // −48h → clamped to 0
    ed('draw', '2026-01-03 00:00:00', '2026-01-01 00:00:00', { clamp_zero: false }), // raw signed → −2
    { stage: 'limit', limit: 1 },
    { stage: 'project', keep: ['d25h', 'd47h', 'd48h', 'dneg', 'draw'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = r.rows[0];
  assert.equal(num(row.d25h), 1);
  assert.equal(num(row.d47h), 1);
  assert.equal(num(row.d48h), 2);
  assert.equal(num(row.dneg), 0);
  assert.equal(num(row.draw), -2);
});

// compute window: row_number per user to find repeat purchasers
test('pipeline compute window: row_number per user → exactly 1 user has a 2nd purchase (u1)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'pseq', expr: { fn: 'row_number', over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time', direction: 'asc' }] } } },
    { stage: 'where', conditions: [{ column: 'pseq', op: 'eq', value: 2 }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'repeat_buyers', agg: 'count' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(num(r.rows[0].repeat_buyers), 1); // only u1 purchased twice
});

// compute case: bucket prices into tiers
test('pipeline compute case: price tiers low(<10)=3 rows, high(>=10)=5 rows', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'compute', name: 'tier', expr: { fn: 'case', cases: [{ when: [{ column: 'price', op: 'lt', value: 10 }], then: { value: 'low' } }], else: { value: 'high' } } },
    { stage: 'aggregate', group_by: ['tier'], measures: [{ name: 'n', agg: 'count' }] },
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
    { stage: 'sample', share: 1 },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(num(full.rows[0].n), 8); // 100% keeps every row (random() < 1.0 always true)

  const part = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'sample', share: 0.1 },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(part.ok, true, JSON.stringify(part));
  const n = num(part.rows[0].n);
  assert.ok(n >= 0 && n <= 8, `sampled count ${n} out of bounds`); // random subset
});

// where with a constant and an expression: column-vs-constant + column-vs-now (in past)
test('pipeline where operands: price>=10 (a constant) and device_time<now → 5 rows summing 70', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'where', conditions: [
      { column: 'event_name', op: 'eq', value: 'iap_purchase_completed' },
      { column: 'price', op: 'gte', value: 10 }, // column vs constant
      { column: 'device_time', op: 'lt', right: { now: true } }, // column vs now
    ] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', agg: 'count' }, { name: 's', agg: 'sum', column: 'price' }] },
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
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'compute', name: 'day', expr: { fn: 'unix_date', args: [{ column: 'device_time' }] } },
    { stage: 'compute', name: 'roll', expr: { fn: 'sum', args: [{ column: 'price' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'day' }], frame: { mode: 'range', preceding: 1, following: 0 } } } },
    { stage: 'order_by', keys: [{ key: 'day', direction: 'asc' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rolls = r.rows.map((x) => num(x.roll));
  // u1: 01-01 price 5 → window [day-1,day] = 5; 01-02 price 10 → [day-1,day] = 5+10 = 15
  assert.deepEqual(rolls, [5, 15]);
});

// HLL sketches are ADDITIVE: per-product sketches MERGE to the true distinct count
// (deduping the overlap), whereas summing per-product distinct counts double-counts.
test('pipeline HLL hll_init→hll_merge: merged distinct buyers = 7 (naive sum = 8)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'pid', expr: { fn: 'event_property', property: 'product_id_of_event_data', type: 'string' } },
    { stage: 'aggregate', group_by: ['pid'], measures: [{ name: 'sk', agg: 'hll_init', column: 'player_id_of_internal' }, { name: 'n', agg: 'count_distinct', column: 'player_id_of_internal' }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'merged', agg: 'hll_merge', column: 'sk' }, { name: 'naive', agg: 'sum', column: 'n' }] },
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
    { stage: 'compute', name: 'pid', expr: { fn: 'event_property', property: 'product_id_of_event_data', type: 'string' } },
    { stage: 'aggregate', group_by: ['pid'], measures: [{ name: 'sk', agg: 'hll_init', column: 'player_id_of_internal' }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'merged', agg: 'hll_merge_partial', column: 'sk' }] },
    { stage: 'compute', name: 'total', expr: { fn: 'hll_extract', args: [{ column: 'merged' }] } },
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
    { stage: 'unnest', property: 'rewards', name: 'rw' },
    { stage: 'compute', name: 'item', expr: { fn: 'json_field', args: [{ column: 'rw' }], field: 'item', type: 'string' } },
    { stage: 'compute', name: 'qty', expr: { fn: 'json_field', args: [{ column: 'rw' }], field: 'qty', type: 'int' } },
    { stage: 'aggregate', group_by: ['item'], measures: [{ name: 'grants', agg: 'count' }, { name: 'total_qty', agg: 'sum', column: 'qty' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const grants = Object.fromEntries(r.rows.map((x) => [String(x.item), num(x.grants)]));
  const qty = Object.fromEntries(r.rows.map((x) => [String(x.item), num(x.total_qty)]));
  assert.equal(grants.coin, 25); // every level_completed row grants a coin
  assert.ok(grants.gem >= 1 && grants.gem < 25); // gem only on level-1 completions
  assert.equal(qty.gem, 2 * grants.gem); // each gem reward qty = 2 → qty extracted correctly
  assert.equal(qty.coin, 125 + 5 * grants.gem); // level-1 coin=10, others=5: 5*25 + 5*gemCount
});

// compute string ops: concat a product_id with a string constant, upper-cased
test('pipeline compute string/const: concat + upper labels group correctly (P1=3, P2=3, P3=2)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'pid', expr: { fn: 'event_property', property: 'product_id_of_event_data', type: 'string' } },
    { stage: 'compute', name: 'label', expr: { fn: 'concat', args: [{ column: 'pid' }, { value: '_iap' }] } },
    { stage: 'compute', name: 'up', expr: { fn: 'upper', args: [{ column: 'label' }] } },
    { stage: 'aggregate', group_by: ['up'], measures: [{ name: 'n', agg: 'count' }] },
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
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: [{ column: 'install_date' }] },
    { stage: 'compute', name: 'dsi', expr: { fn: 'date_diff', args: [{ column: 'install_date' }, { column: 'device_time' }], unit: 'day' } },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'total_dsi', agg: 'sum', column: 'dsi' }, { name: 'max_dsi', agg: 'max', column: 'dsi' }, { name: 'n', agg: 'count' }] },
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
    { stage: 'compute', name: 'mon', expr: { fn: 'date_trunc', args: [{ column: 'device_time' }], grain: 'month' } },
    { stage: 'aggregate', group_by: ['mon'], measures: [{ name: 'n', agg: 'count' }] },
    { stage: 'order_by', keys: [{ key: 'mon', direction: 'asc' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);
  assert.equal(num(r.rows[0].n), 8);
});

// A WEEK IS THE ISO WEEK on every warehouse (Monday start — MetricFlow's week): the seed's events fall on
// Thu 01-01 (33), Fri 01-02 (42), Sat 01-03 (27), Sun 01-04 (39), Mon 01-05 (37), Thu 01-08 (4), Fri 01-09 (2).
// A Sunday-start week would split them 102 / 82; the ISO weeks are Mon 2025-12-29 (141) and Mon 2026-01-05 (43).
test('pipeline date_trunc week / date_part dow, week: the ISO week (Monday 1 … Sunday 7)', opts, async (t) => {
  if (skip(t)) return;
  const weeks = await run([
    { stage: 'compute', name: 'wk', expr: { fn: 'date_trunc', args: [{ column: 'device_time' }], grain: 'week' } },
    { stage: 'compute', name: 'wk_start', expr: { fn: 'substring', args: [{ fn: 'cast', args: [{ column: 'wk' }], type: 'string' }], start: 1, len: 10 } },
    { stage: 'aggregate', group_by: ['wk_start'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(weeks.ok, true, JSON.stringify(weeks));
  assert.deepEqual(Object.fromEntries(weeks.rows.map((x) => [String(x.wk_start), num(x.n)])), { '2025-12-29': 141, '2026-01-05': 43 });
  const parts = await run([
    { stage: 'compute', name: 'dow', expr: { fn: 'date_part', args: [{ column: 'device_time' }], part: 'dow' } },
    { stage: 'compute', name: 'wk', expr: { fn: 'date_part', args: [{ column: 'device_time' }], part: 'week' } },
    { stage: 'aggregate', group_by: ['dow', 'wk'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(parts.ok, true, JSON.stringify(parts));
  const by = Object.fromEntries(parts.rows.map((x) => [`${num(x.dow)}/${num(x.wk)}`, num(x.n)]));
  // Thu 4, Fri 5, Sat 6, Sun 7 of ISO week 1; Mon 1, Thu 4, Fri 5 of week 2
  assert.deepEqual(by, { '4/1': 33, '5/1': 42, '6/1': 27, '7/1': 39, '1/2': 37, '4/2': 4, '5/2': 2 });
});

// date_diff counts WHOLE units elapsed, truncated toward zero, as an integer (TIMESTAMP_DIFF's count):
// from the moments below to e1's time, 2026-01-01 08:00:00
test('pipeline date_diff: whole units elapsed, truncated toward zero, integers', opts, async (t) => {
  if (skip(t)) return;
  const dd = (name, from, unit, to = { column: 'device_time' }) => ({ stage: 'compute', name, expr: { fn: 'date_diff', args: [{ value: from }, to], unit } });
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_id', op: 'eq', value: 'e1' }] },
    dd('h_half', '2026-01-01 07:30:00', 'hour'),       // 30 min → 0 hours (not 0.5)
    dd('h_neg', '2026-01-01 09:30:00', 'hour'),        // −1 h 30 min → −1 (toward zero, not −2)
    dd('m_secs', '2026-01-01 07:59:30', 'minute'),     // 30 s → 0 minutes
    dd('m_back', '2026-01-01 07:58:59', 'minute'),     // 1 min 1 s → 1
    dd('s_back', '2026-01-01 07:58:59', 'second'),     // 61
    dd('d_span', '2025-12-30 23:00:00', 'day'),        // 1 day 9 h → 1 (calendar days would be 2)
    dd('d_neg', '2026-01-03 07:00:00', 'day'),         // −1 day 23 h → −1
    { stage: 'project', keep: ['h_half', 'h_neg', 'm_secs', 'm_back', 's_back', 'd_span', 'd_neg'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.rows[0], { h_half: 0, h_neg: -1, m_secs: 0, m_back: 1, s_back: 61, d_span: 1, d_neg: -1 });
});

// NULLS GO LAST unless a sort key says first — written explicitly by every warehouse (BigQuery would put
// them first in an ascending sort): the order_by stage, a window's order and a read alike. The level id
// is NULL on every event that is no level event.
test('pipeline sort keys: NULLs last by default, first when asked — the order_by stage and a window', opts, async (t) => {
  if (skip(t)) return;
  const scope = { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['first_launch', 'level_completed'] }] };
  const top = async (key) => {
    const r = await run([scope, { stage: 'order_by', keys: [key, { key: 'event_id' }] }, { stage: 'limit', limit: 1 }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.rows[0].level_id_of_event_data;
  };
  const lowest = await run([scope, { stage: 'aggregate', group_by: [], measures: [{ name: 'lo', agg: 'min', column: 'level_id_of_event_data' }, { name: 'hi', agg: 'max', column: 'level_id_of_event_data' }] }]);
  assert.equal(lowest.ok, true, JSON.stringify(lowest));
  assert.equal(num(await top({ key: 'level_id_of_event_data' })), num(lowest.rows[0].lo));
  assert.equal(num(await top({ key: 'level_id_of_event_data', direction: 'desc' })), num(lowest.rows[0].hi));
  assert.equal(await top({ key: 'level_id_of_event_data', nulls: 'first' }), null);
  assert.equal(await top({ key: 'level_id_of_event_data', direction: 'desc', nulls: 'first' }), null);
  // a window: the first row by level id is a level (a rank and a running count alike), unless NULLs are asked first
  const ranked = await run([
    scope,
    { stage: 'compute', name: 'rn', expr: { fn: 'row_number', over: { order_by: [{ key: 'level_id_of_event_data' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'rn_nulls', expr: { fn: 'row_number', over: { order_by: [{ key: 'level_id_of_event_data', nulls: 'first' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'seen', expr: { fn: 'count', args: [{ column: 'level_id_of_event_data' }], over: { order_by: [{ key: 'level_id_of_event_data' }, { key: 'event_id' }], frame: { mode: 'rows' } } } },
    { stage: 'where', conditions: [{ column: 'rn', op: 'eq', value: 1 }] },
  ]);
  assert.equal(ranked.ok, true, JSON.stringify(ranked));
  assert.notEqual(ranked.rows[0].level_id_of_event_data, null);
  assert.equal(num(ranked.rows[0].seen), 1, 'the running count of levels at the first row has the one level it is');
  const nullsFirst = await run([
    scope,
    { stage: 'compute', name: 'rn', expr: { fn: 'row_number', over: { order_by: [{ key: 'level_id_of_event_data', nulls: 'first' }, { key: 'event_id' }] } } },
    { stage: 'where', conditions: [{ column: 'rn', op: 'eq', value: 1 }] },
  ]);
  assert.equal(nullsFirst.ok, true, JSON.stringify(nullsFirst));
  assert.equal(nullsFirst.rows[0].level_id_of_event_data, null);
});

// a window restarts per a declared relationship as it does per its key column
test('pipeline window partition_by { entity }: the same rows as the key column', opts, async (t) => {
  if (skip(t)) return;
  const nth = (partition) => run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'pseq', expr: { fn: 'row_number', over: { partition_by: [partition], order_by: [{ key: 'device_time' }, { key: 'event_id' }] } } },
    { stage: 'aggregate', group_by: ['pseq'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  const byEntity = await nth({ entity: 'user' });
  const byColumn = await nth('player_id_of_internal');
  assert.equal(byEntity.ok && byColumn.ok, true, JSON.stringify([byEntity, byColumn].find((x) => !x.ok)));
  const counts = (r) => Object.fromEntries(r.rows.map((x) => [num(x.pseq), num(x.n)]));
  assert.deepEqual(counts(byEntity), counts(byColumn));
  assert.deepEqual(counts(byEntity), { 1: 7, 2: 1 }); // 7 payers, one of them (u1) twice
});

// ... |> UNPIVOT: fold measures back into (metric, value) rows. The stages before the unpivot are
// where -> compute (an event property) -> join -> aggregate(group_by): the IAP revenue by country,
// read off the folded 'revenue' rows (it was a test of its own, 'pipeline aggregate: IAP revenue by
// country = US35 / GB25 / BR25').
test('pipeline unpivot: fold revenue+n into rows; US revenue row = 35; IAP revenue by country = US35 / GB25 / BR25', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'join', with: 'users', via: 'user', between: AT('device_time'), attrs: [{ column: 'country' }] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', agg: 'sum', column: 'price' }, { name: 'n', agg: 'count' }] },
    { stage: 'unpivot', keep: ['country'], columns: ['revenue', 'n'], name_column: 'metric', value_column: 'value' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const usRevenue = r.rows.find((x) => String(x.country) === 'US' && String(x.metric) === 'revenue');
  assert.ok(usRevenue, 'US/revenue row present');
  assert.equal(num(usRevenue.value), 35);
  // every country contributes exactly the two folded metrics
  const usRows = r.rows.filter((x) => String(x.country) === 'US');
  assert.equal(usRows.length, 2);
  // 'pipeline aggregate: IAP revenue by country = US35 / GB25 / BR25'
  const revenue = r.rows.filter((x) => String(x.metric) === 'revenue');
  const by = Object.fromEntries(revenue.map((x) => [String(x.country), num(x.value)]));
  assert.equal(by.US, 35, '[aggregate by country] US');
  assert.equal(by.GB, 25, '[aggregate by country] GB');
  assert.equal(by.BR, 25, '[aggregate by country] BR');
  assert.equal(revenue.reduce((s, x) => s + num(x.value), 0), 85, '[aggregate by country] sums to 85');
});

// unpivot returns exactly `keep` + the two columns it makes, and a row for every folded value — a
// NULL one too (BigQuery's UNPIVOT is told INCLUDE NULLS, selects the kept and folded columns first,
// and puts the name column before the value after it, as the stage declares)
test('pipeline unpivot: exactly keep + name/value columns, one row per value — NULL values kept', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['iap_purchase_completed', 'first_launch'] }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'compute', name: 'session', expr: { fn: 'cast', args: [{ column: 'session_number' }], type: 'numeric' } },
    { stage: 'unpivot', keep: ['event_id', 'event_name'], columns: ['price', 'session'], name_column: 'metric', value_column: 'amount' },
  ]);
  const events = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['iap_purchase_completed', 'first_launch'] }] },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(r.ok && events.ok, true, JSON.stringify([r, events].find((x) => !x.ok)));
  assert.deepEqual(r.columns.map((c) => c.name).sort(), ['amount', 'event_id', 'event_name', 'metric']);
  assert.equal(r.rows.length, 2 * num(events.rows[0].n)); // two rows per event, the NULL prices of first_launch too
  const launchPrices = r.rows.filter((x) => String(x.event_name) === 'first_launch' && String(x.metric) === 'price');
  assert.ok(launchPrices.length > 0 && launchPrices.every((x) => x.amount == null), 'a NULL value is a row, its value NULL');
  assert.equal(r.rows.filter((x) => String(x.metric) === 'price').reduce((a, x) => a + (x.amount == null ? 0 : num(x.amount)), 0), 85);
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
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', agg: 'sum', column: 'price' }] },
  ];

  // PASS 1 — one row: the count, the mean, the max. No group_by, no window.
  const stats = await run([...perPlayer, {
    stage: 'aggregate',
    measures: [
      { name: 'players', agg: 'count' },
      { name: 'revenue_avg', agg: 'average', column: 'revenue' },
      { name: 'revenue_max', agg: 'max', column: 'revenue' },
      { name: 'revenue_median', agg: 'median', column: 'revenue' },
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
    { stage: 'compute', name: 'revenue_capped', expr: { fn: 'least', args: [{ column: 'revenue' }, { value: cap }] } },
    { stage: 'compute', name: 'revenue_floored', expr: { fn: 'greatest', args: [{ column: 'revenue_capped' }, { value: 1 }] } },
    { stage: 'compute', name: 'centered', expr: { fn: 'sub', args: [{ column: 'revenue_capped' }, { value: mean }] } },
    { stage: 'compute', name: 'revenue_z', expr: { fn: 'div', args: [{ column: 'centered' }, { value: 10 }] } },
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
