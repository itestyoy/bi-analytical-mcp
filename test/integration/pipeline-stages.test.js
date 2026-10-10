// PIPELINE STAGES ON DATA — one fixture warehouse and one engine for every stage of a pipeline: the
// stages themselves, the one condition grammar, match_recognize funnels, checkpoints, complex payload
// types, caller text that stays inert, and the dialect's guarded JSON reads and point-in-time join.
// The files this one absorbed each loaded the same warehouse and built the same engine; here that
// setup is paid once, and every test keeps its title and every assertion its message. Each section
// opens with the comment of the file it was. Data-only assertions throughout (no SQL/YAML text).
// Auto-skips the warehouse tests when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { getDialect } from '../../src/dialects/index.js';
import { Engine } from '../../src/engine.js';
import { renderPipeline } from '../../src/pipeline.js';
import { buildWarehouse, fixtureProject, startWarehouse } from './warehouse-harness.js';
import { settle, readTable } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');
const opts = { timeout: 300000 };
const num = (v) => Number(v);
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

let wh; let engine; let backend;
// the stages run directly (renderPipeline + dbt show) read a catalog of their own, as the engine
// does not touch it: what they render is the catalog as loaded
let stageCatalog;
let seq = 0;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  backend = testDbt({ profilesDir: BASE });
  stageCatalog = loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'stages-')), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog: loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
}, opts);

after(async () => {
  backend?.close?.();
  try { engine?.close(); } catch { /* noop */ }
  if (wh) await wh.stop();
});

/** A stage list over the events source, rendered for DuckDB and run with `dbt show`. */
const show = (stages) => backend.show(BASE, renderPipeline(stageCatalog, 'duckdb', 'events', stages).sql, 1000);

/** The warehouse's own count of rows, read with SQL written here by hand. */
const truth = async (sql) => num((await wh.query(sql)).rows[0].n);

/** A scratch DuckDB database for a dialect check. Opening one points DUCKDB_PATH at it; the engine's dbt keeps reading the fixture warehouse. */
async function scratchWarehouse(t) {
  const keep = process.env.DUCKDB_PATH;
  const opening = startWarehouse(); // sets DUCKDB_PATH before it yields: put it back at once
  if (keep === undefined) delete process.env.DUCKDB_PATH; else process.env.DUCKDB_PATH = keep;
  const db = await opening;
  t.after(() => db.stop());
  return db;
}

const duck = getDialect('duckdb');

// ════════════ PIPELINE STAGES (was pipeline.test.js) ═══════════════════════════════════════════
// The unified pipe-style transformation pipeline (src/pipeline.js), executed on
// DATA: each pipeline is lowered to DuckDB SQL and run via `dbt show` against
// the seed, asserting exact numbers. Covers aggregate (group_by), pivot, and
// unpivot. (BigQuery lowers the same op IR to native pipe syntax; not run here.)

// dim_users is SLOWLY-CHANGING (one row per player per validity window), so every join to it
// is point-in-time: the declared player key AND the event time inside the window. Without the
// window a player with several versions matches all of them and counts inflate.
const AT = (column) => ({ column, from: 'install_time_valid_from', to: 'install_time_valid_until' });

// (where -> compute (an event property) -> join -> aggregate(group_by), IAP revenue by country
// US 35 / GB 25 / BR 25: the first unpivot test reads it off the rows it folds.)

// unnest a FLAT array column stored as a JSON-encoded STRING (mirrors the real
// warehouse: words_selected lands as text like '["cat","dog"]'). meta.mcp.array
// (encoding: json) tells the engine to parse it before exploding — no fake event_data.
test('pipeline unnest: explode words_selected (JSON-string array) and count per word', opts, async (t) => {
  if (skip(t)) return;
  const r = await show([
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
  const r = await show([
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
  const last = await show(stages({ stage: 'compute', name: 'w', expr: { fn: 'array_last', args: [{ column: 'wa' }] } }));
  assert.equal(last.ok, true, JSON.stringify(last));
  const byLast = Object.fromEntries(last.rows.map((x) => [String(x.w), num(x.n)]));
  assert.deepEqual(byLast, { sun: 12, star: 4, tree: 3, x: 6 });
  const first = await show(stages({ stage: 'compute', name: 'w', expr: { fn: 'element_at', args: [{ column: 'wa' }], index: 1 } }));
  const byFirst = Object.fromEntries(first.rows.map((x) => [String(x.w), num(x.n)]));
  assert.deepEqual(byFirst, { cat: 12, moon: 4, tree: 3, x: 6 });
});

// #2: raw SQL escape hatch — verbatim dialect expression when no built-in op fits.
test('pipeline raw: a verbatim SQL expression is evaluated', opts, async (t) => {
  if (skip(t)) return;
  const r = await show([
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
    const r = await show([
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
  const r = await show([...IAP_BY_COUNTRY, { stage: 'pivot', group_by: [], on: 'country', measure: { agg: 'sum', column: 'price' }, values: COUNTRIES }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);            // one pivoted row
  const row = r.rows[0];
  assert.equal(num(row.us), 35);
  assert.equal(num(row.gb), 25);
  assert.equal(num(row.br), 25);
});

test('pipeline pivot: a count per cell is the rows of that value — the aggregate stage\'s count by country, 8 in all', opts, async (t) => {
  if (skip(t)) return;
  const grouped = await show([...IAP_BY_COUNTRY, { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', agg: 'count' }, { name: 'payers', agg: 'count_distinct', column: 'player_id_of_internal' }] }]);
  const pivoted = await show([...IAP_BY_COUNTRY, { stage: 'pivot', on: 'country', measure: { agg: 'count' }, values: COUNTRIES }]);
  const payers = await show([...IAP_BY_COUNTRY, { stage: 'pivot', on: 'country', measure: { agg: 'count_distinct', column: 'player_id_of_internal' }, values: COUNTRIES }]);
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
  const grouped = await show([...base, { stage: 'aggregate', group_by: ['event_name', 'session_number'], measures: [{ name: 'n', agg: 'count' }] }]);
  const pivoted = await show([...base, { stage: 'pivot', group_by: ['event_name'], on: 'session_number', measure: { agg: 'count' }, values: [{ value: 1, name: 's1' }, { value: 2, name: 's2' }, { value: null, name: 'none' }] }]);
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const full = await show([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'sample', share: 1 },
    { stage: 'aggregate', group_by: [], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(num(full.rows[0].n), 8); // 100% keeps every row (random() < 1.0 always true)

  const part = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const r = await show([
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
  const weeks = await show([
    { stage: 'compute', name: 'wk', expr: { fn: 'date_trunc', args: [{ column: 'device_time' }], grain: 'week' } },
    { stage: 'compute', name: 'wk_start', expr: { fn: 'substring', args: [{ fn: 'cast', args: [{ column: 'wk' }], type: 'string' }], start: 1, len: 10 } },
    { stage: 'aggregate', group_by: ['wk_start'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(weeks.ok, true, JSON.stringify(weeks));
  assert.deepEqual(Object.fromEntries(weeks.rows.map((x) => [String(x.wk_start), num(x.n)])), { '2025-12-29': 141, '2026-01-05': 43 });
  const parts = await show([
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
  const r = await show([
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
    const r = await show([scope, { stage: 'order_by', keys: [key, { key: 'event_id' }] }, { stage: 'limit', limit: 1 }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.rows[0].level_id_of_event_data;
  };
  const lowest = await show([scope, { stage: 'aggregate', group_by: [], measures: [{ name: 'lo', agg: 'min', column: 'level_id_of_event_data' }, { name: 'hi', agg: 'max', column: 'level_id_of_event_data' }] }]);
  assert.equal(lowest.ok, true, JSON.stringify(lowest));
  assert.equal(num(await top({ key: 'level_id_of_event_data' })), num(lowest.rows[0].lo));
  assert.equal(num(await top({ key: 'level_id_of_event_data', direction: 'desc' })), num(lowest.rows[0].hi));
  assert.equal(await top({ key: 'level_id_of_event_data', nulls: 'first' }), null);
  assert.equal(await top({ key: 'level_id_of_event_data', direction: 'desc', nulls: 'first' }), null);
  // a window: the first row by level id is a level (a rank and a running count alike), unless NULLs are asked first
  const ranked = await show([
    scope,
    { stage: 'compute', name: 'rn', expr: { fn: 'row_number', over: { order_by: [{ key: 'level_id_of_event_data' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'rn_nulls', expr: { fn: 'row_number', over: { order_by: [{ key: 'level_id_of_event_data', nulls: 'first' }, { key: 'event_id' }] } } },
    { stage: 'compute', name: 'seen', expr: { fn: 'count', args: [{ column: 'level_id_of_event_data' }], over: { order_by: [{ key: 'level_id_of_event_data' }, { key: 'event_id' }], frame: { mode: 'rows' } } } },
    { stage: 'where', conditions: [{ column: 'rn', op: 'eq', value: 1 }] },
  ]);
  assert.equal(ranked.ok, true, JSON.stringify(ranked));
  assert.notEqual(ranked.rows[0].level_id_of_event_data, null);
  assert.equal(num(ranked.rows[0].seen), 1, 'the running count of levels at the first row has the one level it is');
  const nullsFirst = await show([
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
  const nth = (partition) => show([
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
  const r = await show([
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
  const r = await show([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['iap_purchase_completed', 'first_launch'] }] },
    { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } },
    { stage: 'compute', name: 'session', expr: { fn: 'cast', args: [{ column: 'session_number' }], type: 'numeric' } },
    { stage: 'unpivot', keep: ['event_id', 'event_name'], columns: ['price', 'session'], name_column: 'metric', value_column: 'amount' },
  ]);
  const events = await show([
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
  const stats = await show([...perPlayer, {
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
  const rows = await show([...perPlayer,
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

// ════════════ ONE CONDITION GRAMMAR (was condition-grammar.test.js) ════════════════════════════
// ONE CONDITION GRAMMAR (src/schema-kit.js conditionList, src/conditions.js): every `where` is a list
// of conditions that all hold, an item may be { or: [...] } (its items { and: [...] }), and every place
// takes the same operators — the text ones included. Proven on DATA: each count below is the
// warehouse's own count of the same rows, read with SQL written by hand in the test.

/** A pipeline over the events source, materialized; its rows. */
async function condPipe(stages) {
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages });
  const built = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  return { rows: built.rows, context_id: s.context_id };
}

test('a where keeps a row when any condition of an { or } holds, beside the conditions that all hold — and a text operator matches as LIKE does', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where (event_name = 'tutorial' or event_name like '%level%') and session_number <= 2");
  const { rows } = await condPipe([
    { stage: 'where', conditions: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'event_name', op: 'contains', value: 'level' }] }, { column: 'session_number', op: 'lte', value: 2 }] },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.ok(want > 0, 'the fixture has such rows');
  assert.equal(num(rows[0].n), want);
  // an { and } inside an { or }: tutorials of the first session, or any level event
  const both = await truth("select count(*) as n from fct_analytics_events where (event_name = 'tutorial' and session_number = 1) or event_name like 'level%'");
  const nested = await condPipe([
    { stage: 'where', conditions: [{ or: [{ and: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'session_number', op: 'eq', value: 1 }] }, { column: 'event_name', op: 'starts_with', value: 'level' }] }] },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(num(nested.rows[0].n), both);
});

// ONE ungrouped aggregate over events carries what four tests each built a whole-table pipeline for,
// every figure held to the warehouse's own count of the same rows (SQL written here by hand):
//   - a CASE branch takes the same conditions: an { or } in `when` flags the rows either event names;
//   - an aggregate measure takes a where of its own: a conditional count and sum beside the
//     unconditional one, in one pass;
//   - a text column of the warehouse compared with a boolean matches the ways text spells the flag,
//     not run as STRING = BOOL;
//   - a raw expression takes its columns positionally, in args: the server writes each quoted, a
//     reserved word (`order`) too.
// The in-call refusals of the last two (an order on a text flag; a column named in raw text, a
// placeholder with no argument, an argument no placeholder uses) are checked on drafts after it.
test('one ungrouped aggregate over events carrying every condition and expression form: the CASE { or } flag, conditional count/sum, text-vs-boolean yes/no, raw positional args', opts, async (t) => {
  if (skip(t)) return;
  const flagged = await truth("select count(*) as n from fct_analytics_events where event_name in ('tutorial', 'level_started')");
  const all = await truth('select count(*) as n from fct_analytics_events');
  const tutorials = await truth("select count(*) as n from fct_analytics_events where event_name = 'tutorial' or event_name like 'level%'");
  const early = await truth('select sum(session_number) as n from fct_analytics_events where session_number <= 2');
  const filled = await truth('select count(*) as n from fct_analytics_events where bundle_id is not null');
  const truthy = await truth("select count(*) as n from fct_analytics_events where lower(trim(bundle_id)) in ('true', '1', 't')");
  const doubled = await truth('select sum(session_number * 2) as n from fct_analytics_events');
  const { rows } = await condPipe([
    { stage: 'compute', name: 'flag', expr: { fn: 'case', cases: [{ when: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'event_name', op: 'eq', value: 'level_started' }] }], then: { value: 1 } }], else: { value: 0 }, type: 'int' } },
    { stage: 'compute', name: 'order', expr: { column: 'session_number' } },
    { stage: 'compute', name: 'twice', expr: { fn: 'raw', sql: '{1} * 2', args: [{ column: 'order' }], type: 'int' } },
    { stage: 'aggregate', measures: [
      { name: 'flagged', agg: 'sum', column: 'flag' },
      { name: 'n', agg: 'count' },
      { name: 'n_tut', agg: 'count', where: [{ or: [{ column: 'event_name', op: 'eq', value: 'tutorial' }, { column: 'event_name', op: 'starts_with', value: 'level' }] }] },
      { name: 's_early', agg: 'sum', column: 'session_number', where: [{ column: 'session_number', op: 'lte', value: 2 }] },
      { name: 'yes', agg: 'count', where: [{ column: 'bundle_id', op: 'eq', value: true }] },
      { name: 'no', agg: 'count', where: [{ column: 'bundle_id', op: 'neq', value: true }] },
      { name: 'twice_sum', agg: 'sum', column: 'twice' },
    ] },
  ]);
  const row = rows[0];
  // 'a CASE branch takes the same conditions: an { or } in `when` flags the rows either event names'
  assert.equal(num(row.flagged), flagged, '[CASE { or }] the flagged rows');
  // 'an aggregate measure takes a where of its own: a conditional count and sum beside the unconditional one, in one pass'
  assert.ok(tutorials > 0 && tutorials < all, '[measure where] the condition keeps some rows, not all');
  assert.deepEqual([num(row.n), num(row.n_tut), num(row.s_early)], [all, tutorials, early], '[measure where] count, conditional count, conditional sum');
  // 'a text column of the warehouse compared with a boolean matches the ways text spells the flag, not run as STRING = BOOL'
  assert.ok(filled > 0, '[text vs boolean] the fixture has the column filled');
  assert.deepEqual([num(row.yes), num(row.no)], [truthy, filled - truthy], '[text vs boolean] yes / no');
  // 'a raw expression takes its columns positionally, in args: the server writes each quoted, a reserved word too'
  assert.equal(num(row.twice_sum), doubled, '[raw positional args] sum of {1} * 2 over `order`');

  // [text vs boolean] an order compares no flag: refused as the step is added
  const flag = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: flag.context_id, stages: [{ stage: 'where', conditions: [{ column: 'bundle_id', op: 'gt', value: false }] }] }), /text column in the warehouse/);
  // [raw positional args] a column named in its text is refused
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'order', expr: { column: 'session_number' } }] });
  // a column written by name in the text — bare, or in the warehouse's identifier quotes — is refused
  for (const sql of ['order * 2', '"order" * 2']) {
    await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'twice', expr: { fn: 'raw', sql, type: 'int' } }] }), /a column goes in `args`/, sql);
  }
  // a placeholder with no argument, and an argument no placeholder uses, are refused
  await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'twice', expr: { fn: 'raw', sql: '{2} * 2', args: [{ column: 'order' }] } }] }), /has no argument/);
  await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'twice', expr: { fn: 'raw', sql: '2', args: [{ column: 'order' }] } }] }), /not used/);
});

test('a read of a built model filters and keeps groups with the same grammar: where and having take { or }', opts, async (t) => {
  if (skip(t)) return;
  const { context_id } = await condPipe([{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] }]);
  const want = await truth("select count(*) as n from fct_analytics_events where event_name like 'level%' or event_name = 'tutorial'");
  const read = await engine.query_pipeline_model({ context_id, transform: { where: [{ or: [{ column: 'event_name', op: 'starts_with', value: 'level' }, { column: 'event_name', op: 'eq', value: 'tutorial' }] }], measures: [{ agg: 'sum', column: 'n', name: 'n' }] } });
  assert.equal(num(read.rows[0].n), want);
  // the names whose count is the smallest or the largest
  const counts = (await wh.query('select event_name, count(*) as n from fct_analytics_events group by 1')).rows.map((r) => num(r.n));
  const lo = Math.min(...counts); const hi = Math.max(...counts);
  const kept = await engine.query_pipeline_model({ context_id, transform: { group_by: ['event_name'], measures: [{ agg: 'sum', column: 'n', name: 'n' }], having: [{ or: [{ column: 'n', op: 'eq', value: lo }, { column: 'n', op: 'eq', value: hi }] }] } });
  assert.equal(kept.rows.length, counts.filter((n) => n === lo || n === hi).length);
});

// One semantic build serves both sides of the governed grammar (each was a build of its own): a
// measure's where and a metric query's where.
test('a semantic measure\'s where and a metric query\'s where take { or } and the text operators', opts, async (t) => {
  if (skip(t)) return;
  const built = await engine.build_semantic_model({
    name: 'cond_sem',
    semantic_models: [{ from: 'events', dimensions: [{ field: 'event_name' }], measures: [
      { name: 'picked', agg: 'count', where: [{ or: [{ field: 'level_id_of_event_data', op: 'eq', value: 1 }, { field: 'level_id_of_event_data', op: 'gte', value: 3 }] }] },
      { name: 'rows', agg: 'count' },
    ] }],
    metrics: [{ name: 'picked', type: 'simple', measure: 'picked' }, { name: 'rows', type: 'simple', measure: 'rows' }],
  });
  assert.ok(built.context_id, JSON.stringify(built.error || built));

  // 'a measure's where takes an { or }: the count is the rows either condition holds for'
  const picked = await truth('select count(*) as n from fct_analytics_events where level_id_of_event_data = 1 or level_id_of_event_data >= 3');
  assert.ok(picked > 0, '[measure where] the fixture has such rows');
  const r = await engine.query_semantic_model({ context_id: built.context_id, metrics: ['cond_sem_picked'], time_range: { start: '2020-01-01', end: '2030-12-31' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(num(r.rows[0].cond_sem_picked), picked, '[measure where] the rows either condition holds for');

  // 'a metric query's where names its field as group_by does, and takes the text operators and { or } too'
  const named = await truth("select count(*) as n from fct_analytics_events where event_name like '%level%' or event_name = 'tutorial'");
  const w = await engine.query_semantic_model({
    context_id: built.context_id, metrics: ['cond_sem_rows'], time_range: { start: '2020-01-01', end: '2030-12-31' },
    where: [{ or: [{ field: { model: 'events', attribute: 'event_name' }, op: 'contains', value: 'level' }, { field: { model: 'events', attribute: 'event_name' }, op: 'eq', value: 'tutorial' }] }],
  });
  assert.equal(w.ok, true, JSON.stringify(w.error));
  assert.equal(num(w.rows[0].cond_sem_rows), named, '[query where] the rows the { or } of text operators keeps');
});

test('a time window whose bounds carry their own offset is those instants, whatever timezone is named beside them', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where device_time >= '2026-01-02 00:00:00' and device_time <= '2026-01-03 23:59:59'");
  const all = await truth('select count(*) as n from fct_analytics_events');
  // read as Anchorage wall-clock instead, the window would move nine hours later — and hold another count
  const local = await truth("select count(*) as n from fct_analytics_events where device_time >= '2026-01-02 09:00:00' and device_time <= '2026-01-04 08:59:59'");
  assert.ok(want > 0 && want < all && want !== local, 'the fixture tells the readings apart');
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events', time_range: { start: '2026-01-02T00:00:00Z', end: '2026-01-03T23:59:59.000Z', timezone: 'America/Anchorage' } });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }] });
  const built = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  assert.equal(num(built.rows[0].n), want);
});

test('a project stage drops the columns it names and keeps the rest; the next stage still reads them', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth('select count(distinct event_name) as n from fct_analytics_events');
  const { rows } = await condPipe([
    { stage: 'project', drop: ['session_number'] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(rows.length, want);
  // once session_number is dropped the next stage cannot name it — refused as the step is added
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'project', drop: ['session_number'] }, { stage: 'aggregate', measures: [{ name: 's', agg: 'sum', column: 'session_number' }] }] }), (e) => !(e instanceof assert.AssertionError));
});

test('a query over a built model computes a sample stddev, variance, median and percentile, as the warehouse does', opts, async (t) => {
  if (skip(t)) return;
  const sd = await truth('select stddev_samp(session_number) as n from fct_analytics_events');
  const vr = await truth('select var_samp(session_number) as n from fct_analytics_events');
  const { context_id } = await condPipe([{ stage: 'where', conditions: [{ column: 'session_number', op: 'is_not_null' }] }]);
  const md = await truth('select quantile_cont(session_number, 0.5) as n from fct_analytics_events');
  const p9 = await truth('select quantile_cont(session_number, 0.9) as n from fct_analytics_events');
  const read = await engine.query_pipeline_model({ context_id, transform: { measures: [{ agg: 'stddev', column: 'session_number', name: 'sd' }, { agg: 'variance', column: 'session_number', name: 'vr' }, { agg: 'median', column: 'session_number', name: 'md' }, { agg: 'percentile', percentile: 0.9, column: 'session_number', name: 'p9' }] } });
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  assert.ok(sd > 0, 'the fixture has spread');
  assert.ok(Math.abs(num(read.rows[0].sd) - sd) < 1e-9 && Math.abs(num(read.rows[0].vr) - vr) < 1e-9);
  // the measures of a pipeline's aggregate stage: the median and a percentile, as the warehouse computes them
  assert.deepEqual([num(read.rows[0].md), num(read.rows[0].p9)], [md, p9]);
});

test('a query over a built model reads columns named with reserved words (order, group): every name is quoted', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where event_name = 'tutorial'");
  const { context_id } = await condPipe([
    { stage: 'compute', name: 'group', expr: { column: 'event_name' } },
    { stage: 'aggregate', group_by: ['group'], measures: [{ name: 'order', agg: 'count' }] },
  ]);
  const read = await engine.query_pipeline_model({ context_id, transform: { where: [{ column: 'group', op: 'eq', value: 'tutorial' }], group_by: ['group'], measures: [{ agg: 'sum', column: 'order', name: 'select' }], order_by: [{ key: 'select', direction: 'desc' }] } });
  assert.equal(read.status, 'done', JSON.stringify(read.error));
  assert.deepEqual(read.rows.map((r) => [r.group, num(r.select)]), [['tutorial', want]]);
});

test('a text flag stays text after a checkpoint and from a build\'s task, with the constant on either side', opts, async (t) => {
  if (skip(t)) return;
  const all = await truth('select count(*) as n from fct_analytics_events where bundle_id is not null');
  const truthy = await truth("select count(*) as n from fct_analytics_events where lower(trim(bundle_id)) in ('true', '1', 't')");
  const counts = [
    { stage: 'aggregate', measures: [
      { name: 'yes', agg: 'count', where: [{ left: { value: true }, op: 'eq', right: { column: 'bundle_id' } }] },
      { name: 'no', agg: 'count', where: [{ column: 'bundle_id', op: 'neq', value: true }] },
    ] },
  ];
  // the prefix is built first: the counts then read the checkpoint's table, not the source
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events', stages: [{ stage: 'where', conditions: [{ column: 'bundle_id', op: 'is_not_null' }] }] });
  const prefix = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(prefix.build?.ok, true, JSON.stringify(prefix.error || prefix.build));
  const added = await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: counts });
  assert.ok(added.from_checkpoint, 'the counts read the built prefix');
  const after = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(after.build?.ok, true, JSON.stringify(after.error || after.build));
  assert.deepEqual([num(after.rows[0].yes), num(after.rows[0].no)], [truthy, all - truthy]);
  // a draft started from the prefix's task reads the same table, and the same column in it
  const from = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, from_task: prefix.task_id, stages: counts });
  const built = await engine.build_pipeline_model({ action: 'materialize', context_id: from.context_id });
  assert.equal(built.build?.ok, true, JSON.stringify(built.error || built.build));
  assert.deepEqual([num(built.rows[0].yes), num(built.rows[0].no)], [truthy, all - truthy]);
});

test('a joined text column, under the name the join gave it, is compared with a boolean as text too', opts, async (t) => {
  if (skip(t)) return;
  const joined = 'from fct_analytics_events e left join dim_users u on e.player_id_of_internal = u.player_id_of_internal';
  const all = await truth(`select count(*) as n ${joined} where u.country is not null`);
  const truthy = await truth(`select count(*) as n ${joined} where lower(trim(u.country)) in ('true', '1', 't')`);
  const { rows } = await condPipe([
    { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', name: 'activity_test' }] },
    { stage: 'aggregate', measures: [
      { name: 'yes', agg: 'count', where: [{ column: 'activity_test', op: 'eq', value: true }] },
      { name: 'no', agg: 'count', where: [{ column: 'activity_test', op: 'neq', value: true }] },
    ] },
  ]);
  assert.ok(all > 0, 'the fixture joins users to events');
  assert.deepEqual([num(rows[0].yes), num(rows[0].no)], [truthy, all - truthy]);
});

test('preview with validate runs the draft\'s SQL against the warehouse with no data read: a refusal there is said, and nothing is left in the project', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'tutorial' }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
  ] });
  const good = await engine.build_pipeline_model({ action: 'preview', context_id: s.context_id, validate: true });
  assert.equal(good.ok, true, JSON.stringify(good.error));
  assert.equal(good.validated, true);
  // a function the warehouse does not have: only the warehouse can say so
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'compute', name: 'bad', expr: { fn: 'raw', sql: 'no_such_function_xyz({1})', args: [{ column: 'n' }] } }] });
  const bad = await engine.raw.build_pipeline_model({ action: 'preview', context_id: s.context_id, validate: true });
  const read = await engine.raw.query_pipeline_model({ task_ids: [bad.task_id] });
  assert.equal(read.results[0].ok, false, JSON.stringify(read.results[0]));
  assert.ok(!engine.ctxs.generatedFiles(s.context_id).some((f) => /_chk/.test(f)), 'the check left no model behind');
});

test('a time column compared with an expression that yields a moment keeps the rows the warehouse keeps; with a number it is refused as the step is added', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth("select count(*) as n from fct_analytics_events where device_time >= TIMESTAMP '2026-01-03 00:00:00'");
  const all = await truth('select count(*) as n from fct_analytics_events');
  assert.ok(want > 0 && want < all, 'the bound keeps some rows, not all');
  const { rows } = await condPipe([
    { stage: 'where', conditions: [{ column: 'device_time', op: 'gte', right: { fn: 'raw', sql: "DATE '2026-01-03'" } }] },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] },
  ]);
  assert.equal(num(rows[0].n), want);
  const s = await engine.build_pipeline_model({ action: 'start', name: `cond_${seq++}`, source: 'events' });
  await assert.rejects(engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'where', conditions: [{ column: 'device_time', op: 'gte', right: { fn: 'length', args: [{ column: 'event_name' }] } }] }] }), /is a moment/);
});

// ════════════ FUNNELS: match_recognize (was match-recognize.test.js) ═══════════════════════════
// Funnels are PIPELINES: _buildPipeline builds a pipe-syntax pipeline whose
// match_recognize stage produces one row per user, and downstream stages (join,
// aggregate) slice it. The model's rows ARE the result. Data-only assertions on
// the returned rows (the CTE equivalent on DuckDB here; BigQuery MATCH_RECOGNIZE in prod).

let mrCtx;
const tru = (v) => v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const reached = (rows, step) => rows.filter((r) => tru(r[`reached_${step}`])).length;

// Build a funnel/transform pipeline and return the materialized result rows.
async function mrPipe(stages, name) {
  const out = await engine._buildPipeline({ name: name || `fnl_${seq++}`, context_id: mrCtx, pipeline: { source: 'events', stages } });
  assert.equal(out.kind, 'pipeline');
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  mrCtx = out.context_id;
  return out;
}

// The activation funnel as it stands — `mrPipe([matchActivation()])` — is built ONCE and read by
// every case that needs it as it is (declared-joins' chainCache pattern).
let activationBuild;
const activation = () => (activationBuild ||= mrPipe([matchActivation()]));

// The canonical 4-step activation funnel as a single match_recognize stage.
const activationSteps = [
  { name: 'launch', event_name: ['first_launch'] },
  { name: 'tut1', event_name: ['tutorial'], where: [{ column: 'element_of_event_data', op: 'eq', value: 'step_1' }] },
  { name: 'tut2', event_name: ['tutorial'], where: [{ column: 'element_of_event_data', op: 'eq', value: 'step_2' }] },
  { name: 'tut3', event_name: ['tutorial'], where: [{ column: 'element_of_event_data', op: 'eq', value: 'step_3' }] },
];
const matchActivation = (extra = {}) => ({ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: activationSteps, ...extra });

// dim_users is SLOWLY-CHANGING, so a join to it is point-in-time. After match_recognize the
// per-event time is gone — `first_seen_at` (the funnel's first event) survives and is the right
// instant to attribute a funnel to: the user as they were when the funnel started.
const AT_FUNNEL = { column: 'first_seen_at', from: 'install_time_valid_from', to: 'install_time_valid_until' };
// A join placed BEFORE match_recognize — or in a pipeline with no funnel at all — still sees
// one row per EVENT, so the instant to attribute it to is the event's own time.
const AT_EVENT = { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' };

// #9: a pipeline-level time_range bounds the window (applied before the stages).
test('pipeline time_range bounds the window: full 8 purchases vs windowed 6', opts, async (t) => {
  if (skip(t)) return;
  const count = async (time_range) => {
    const out = await engine._buildPipeline({ name: `tr_${seq++}`, context_id: mrCtx, pipeline: { source: 'events', time_range, stages: [
      { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
      { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
    ] } });
    assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
    mrCtx = out.context_id;
    return Number(out.rows[0].n);
  };
  assert.equal(await count(undefined), 8);                                  // all purchases
  assert.equal(await count({ start: '2026-01-01', end: '2026-01-04' }), 6); // 01-01..01-04 inclusive (date-only end = whole day)
});

// The fixture is partitioned by event_date (a day next to device_time), so a window also bounds
// that column. 2026-01-02 in UTC+14 is [01-01 10:00, 01-02 10:00) UTC: 9 of its 39 events lie on
// the PREVIOUS UTC day, and a partition bound not widened past the local date would drop them.
test('time_range with a timezone keeps the events on the other UTC day of a partitioned source: 39 (9 on 01-01)', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine._buildPipeline({ name: `tr_${seq++}`, context_id: mrCtx, pipeline: { source: 'events', time_range: { start: '2026-01-02', end: '2026-01-02', timezone: 'Pacific/Kiritimati' }, stages: [
    { stage: 'compute', name: 'utc_day', expr: { fn: 'date_trunc', args: [{ column: 'device_time' }], grain: 'day' } },
    { stage: 'aggregate', group_by: ['utc_day'], measures: [{ name: 'n', agg: 'count' }] },
  ] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  mrCtx = out.context_id;
  const byDay = Object.fromEntries(out.rows.map((r) => [String(r.utc_day).slice(0, 10), Number(r.n)]));
  assert.deepEqual(byDay, { '2026-01-01': 9, '2026-01-02': 30 });
});

// The partition bound is a pruning aid, never a filter of its own: whatever bounds the time axis —
// a where the caller wrote, before a funnel or not — the rows are exactly the ones the source gives
// when it declares no partition column at all.
test('a where on the time axis, alone or before a funnel, reads the same rows with the partition column declared as without it', opts, async (t) => {
  if (skip(t)) return;
  const model = engine.catalog.getModel('events');
  const declared = model.partition_column;
  const rowsOf = async (stages) => (await mrPipe(stages)).rows.map((r) => JSON.stringify(r)).sort();
  const byDay = [
    { stage: 'where', conditions: [{ column: 'device_time', op: 'gte', value: '2026-01-01 10:00:00' }, { column: 'device_time', op: 'lt', value: '2026-01-02 10:00:00' }] },
    { stage: 'compute', name: 'utc_day', expr: { fn: 'date_trunc', args: [{ column: 'device_time' }], grain: 'day' } },
    { stage: 'aggregate', group_by: ['utc_day'], measures: [{ name: 'n', agg: 'count' }] },
  ];
  const funnel = [{ stage: 'where', conditions: [{ column: 'device_time', op: 'gte', value: '2026-01-01 09:30:00' }, { column: 'device_time', op: 'lt', value: '2026-01-03' }] }, matchActivation({ steps: activationSteps.slice(0, 2) })];
  const pruned = { byDay: await rowsOf(byDay), funnel: await rowsOf(funnel) };
  let plain;
  try {
    model.partition_column = undefined;
    plain = { byDay: await rowsOf(byDay), funnel: await rowsOf(funnel) };
  } finally { model.partition_column = declared; }
  assert.deepEqual(pruned, plain);
  assert.equal(pruned.byDay.length, 2, 'the window spans two UTC days');
  assert.ok(pruned.funnel.length > 0, 'the window before the funnel keeps players');
  // the bound is real: read without the late days, the 5 events of 01-01 10:00 that arrived three
  // days late (filed under 01-04) fall outside the partitions the window reads
  const late = model.partition_late_days;
  let early;
  try { model.partition_late_days = 0; early = await mrPipe(byDay); } finally { model.partition_late_days = late; }
  const n = (rows) => Object.fromEntries(rows.map((r) => [String(r.utc_day).slice(0, 10), Number(r.n)]));
  assert.deepEqual(n(early.rows), { '2026-01-01': 4, '2026-01-02': 30 });
});

// Four former tests over the one build: what each asserted is labelled with its old title.
test('the activation funnel, built once: reached 12/8/5/3, output_columns + its task, furthest_step distribution, launch→tut1 = 8/12', opts, async (t) => {
  if (skip(t)) return;
  const out = await activation();
  // 'funnel: reached per step = 12 / 8 / 5 / 3 (match_recognize stage → per-user rows)'
  assert.equal(reached(out.rows, 'launch'), 12, '[reached per step] launch');
  assert.equal(reached(out.rows, 'tut1'), 8, '[reached per step] tut1');
  assert.equal(reached(out.rows, 'tut2'), 5, '[reached per step] tut2');
  assert.equal(reached(out.rows, 'tut3'), 3, '[reached per step] tut3');
  // 'pipeline response: output_columns (carried partition key) + the task that holds it' (A2/A4: the
  // pipeline response documents its output columns and the task it can be re-read from)
  assert.ok(Array.isArray(out.output_columns), '[pipeline response] output_columns present');
  const names = out.output_columns.map((c) => c.name);
  assert.ok(names.includes('player_id_of_internal'), '[pipeline response] partition key carried through to the output');
  assert.ok(names.includes('reached_launch') && names.includes('completed'), '[pipeline response] funnel columns present');
  assert.equal(out.table, out.model, '[pipeline response] the task left the model as its table');
  assert.match(out.task_id, /^[a-f0-9]{12}$/, '[pipeline response] the task that holds it');
  // 'funnel: furthest_step_name distribution sums to 12; tut3 = 3'
  assert.equal(out.rows.length, 12, '[furthest_step] one row per user who entered (launched)');
  assert.equal(out.rows.filter((r) => String(r.furthest_step_name) === 'tut3').length, 3, '[furthest_step] tut3 = 3');
  // 'funnel: conversion launch→tut1 = 8/12 (computed from per-user reached flags)'
  const cr = reached(out.rows, 'tut1') / reached(out.rows, 'launch');
  assert.ok(Math.abs(cr - 8 / 12) < 1e-9, `[conversion launch→tut1] cr=${cr}`);
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
  const A = completed(await mrPipe(mk('any')));
  const D = completed(await mrPipe(mk(undefined)));
  const G = completed(await mrPipe(mk('gap'))); // builds ok ⇒ the NOT EXISTS gap guard is valid SQL
  assert.equal(A, 5, 'all 5 currency_outcome occurrences reach a later ad_finished');
  assert.equal(D, A, 'explicit between_steps="any" == default (nearest-later) on the local engine');
  assert.ok(G <= A && G >= 0, `gap (${G}) is a subset of any (${A}) — never over-matches`);
});

// A5: dry_run returns a cheap source-volume estimate; a narrower window scans fewer rows.
test('dry_run estimated_source_rows: real count, monotonic in the time window', opts, async (t) => {
  if (skip(t)) return;
  const stages = [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] }];
  const wide = await engine._buildPipeline({ dry_run: true, name: 'est_wide', pipeline: { source: 'events', stages } });
  const narrow = await engine._buildPipeline({ dry_run: true, name: 'est_narrow', pipeline: { source: 'events', time_range: { start: '2026-01-05', end: '2026-01-05' }, stages } });
  assert.ok(Number.isInteger(wide.estimated_source_rows) && wide.estimated_source_rows > 0, 'full source count is a positive integer');
  assert.ok(narrow.estimated_source_rows > 0 && narrow.estimated_source_rows < wide.estimated_source_rows, 'a single day scans fewer rows than the whole fact');
  assert.ok(wide.output_columns.some((c) => c.name === 'event_name'), 'dry_run also reports output_columns');
});

// (Feature C, the incremental build_pipeline_model — start with its columns, add the funnel stage,
// preview, materialize 12/8/5/3 — is end-to-end.test.js 3a; the columns add_steps lists for the
// next stage, the partition key carried, are test/unit/build-pipeline-model.test.js's 'add_steps
// propagates columns'. The materialized rows equal the all-at-once build above. A rejected stage
// leaving the draft untouched, and a dry run returning SQL without building, are unit tests there
// too: neither reads the warehouse.)

// #4a: a column of the rows (session_number — a physical column, not a payload property) is
// usable in a step's where, the grammar of every where.
test('match_recognize takes a column in a step condition', opts, async (t) => {
  if (skip(t)) return;
  const colCond = { column: 'session_number', op: 'gte', value: 2 };
  const base = await activation();
  const stepFiltered = await mrPipe([matchActivation({ steps: [{ ...activationSteps[0], where: [colCond] }, ...activationSteps.slice(1)] })]);
  const truth = (await wh.query("select count(distinct player_id_of_internal) as n from fct_analytics_events where event_name = 'first_launch' and session_number >= 2")).rows[0];
  assert.equal(reached(stepFiltered.rows, 'launch'), num(truth.n));
  assert.ok(reached(stepFiltered.rows, 'launch') <= reached(base.rows, 'launch'));
});

// #5: rows option — one_per_partition (players) vs one_per_match (situations).
test('match_recognize rows: one_per_partition (12 players) vs one_per_match (28 starts)', opts, async (t) => {
  if (skip(t)) return;
  const steps = [{ name: 'start', event_name: ['level_started'] }, { name: 'done', event_name: ['level_completed'] }];
  const players = await mrPipe([{ stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps }]);
  const situations = await mrPipe([{ stage: 'match_recognize', partition_by: ['player_id_of_internal'], rows: 'one_per_match', steps }]);
  assert.equal(players.rows.length, 12);               // one row per user who started a level
  assert.equal(reached(players.rows, 'start'), 12);
  assert.equal(situations.rows.length, 28);            // one row per level_started occurrence
  assert.equal(reached(situations.rows, 'start'), 28);
});

test('funnel flexible partition: a declared relationship and a per-(user,session) composite key', opts, async (t) => {
  if (skip(t)) return;
  // The partition key is caller-chosen. A DECLARED relationship is named as one — { entity } —
  // and its key column is used: same 12 launched as the explicit ["player_id_of_internal"].
  const byEntity = await mrPipe([matchActivation({ partition_by: [{ entity: 'user' }] })]);
  assert.equal(reached(byEntity.rows, 'launch'), 12);
  // …and so does the default, which finds that relationship through the ROLE of the model it
  // points at — nothing here knows the relationship is called 'user'.
  const byDefault = await mrPipe([{ stage: 'match_recognize', steps: activationSteps }]);
  assert.equal(reached(byDefault.rows, 'launch'), 12);
  // A relationship written as a bare word is refused — it is not a column, and the message says so
  await assert.rejects(
    () => mrPipe([matchActivation({ partition_by: ['user'] })]),
    /'user' is a RELATIONSHIP of 'events', not a column — write \{ entity: 'user' \}/,
  );
  // …and one whose key is composite cannot be a partition COLUMN at all
  await assert.rejects(
    () => mrPipe([matchActivation({ partition_by: [{ entity: 'ad_funnel' }] })]),
    /relationship 'ad_funnel' of 'events' is keyed by .* which is an expression, not a column/,
  );
  // A COMPOSITE key matches the sequence independently per (user, session) — one
  // row per matched (user,session); still 12 first_launch partitions (one/user).
  const composite = await mrPipe([matchActivation({ partition_by: ['player_id_of_internal', 'session_number'], steps: activationSteps.slice(0, 2) })]);
  assert.ok('player_id_of_internal' in composite.rows[0] && 'session_number' in composite.rows[0], 'both partition keys exposed');
  assert.equal(reached(composite.rows, 'launch'), 12);
});

test('funnel sliced by a user attribute: join dim_users → reached_tut1 by country sums to 8', opts, async (t) => {
  if (skip(t)) return;
  // The funnel is sliced by joining dim_users AFTER match_recognize — all within
  // the pipeline (no separate semantic layer).
  const out = await mrPipe([matchActivation(), { stage: 'join', with: 'users', via: 'user', between: AT_FUNNEL, attrs: [{ column: 'country' }, { column: 'platform' }] }]);
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
  const out = await mrPipe([
    matchActivation(),
    { stage: 'aggregate', group_by: ['furthest_step_name'], measures: [{ name: 'users', agg: 'count' }] },
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
  const out = await mrPipe([
    { stage: 'join', with: 'users', via: 'user', between: AT_EVENT, attrs: [{ column: 'country' }] },
    { stage: 'where', conditions: [{ column: 'country', op: 'eq', value: 'US' }] },
    { stage: 'match_recognize', partition_by: ['player_id_of_internal'], steps: activationSteps.slice(0, 2) },
  ]);
  assert.equal(reached(out.rows, 'launch'), 4); // exactly the 4 US users
  assert.ok(reached(out.rows, 'tut1') <= 4);
});

test('a wide where before the funnel keeps all data: 12 / 8', opts, async (t) => {
  if (skip(t)) return;
  const out = await mrPipe([{ stage: 'where', conditions: [{ column: 'device_time', op: 'between', value: ['2000-01-01', '2100-01-01'] }] }, matchActivation({ steps: activationSteps.slice(0, 2) })]);
  assert.equal(reached(out.rows, 'launch'), 12);
  assert.equal(reached(out.rows, 'tut1'), 8);
});

// A compute stage runs BEFORE match_recognize; its column is referenceable in a step's where and in
// a capture (array_length's n_words captured at level 1 averages 3 — the plain-named version of
// this case was a test of its own).
test('a funnel whose partition, order and capture columns are SQL keywords (group / order / select) runs: 12 reach level 1, n_words averages 3', opts, async (t) => {
  if (skip(t)) return;
  const out = await mrPipe([
    { stage: 'compute', name: 'group', expr: { column: 'player_id_of_internal' } },
    { stage: 'compute', name: 'order', expr: { column: 'device_time' } },
    { stage: 'compute', name: 'n_words', expr: { fn: 'array_length', property: 'words_collected' } },
    { stage: 'match_recognize', partition_by: ['group'], order_by: 'order',
      steps: [{ name: 'launch', event_name: ['first_launch'] }, { name: 'lvl1', event_name: ['level_completed'], where: [{ column: 'level_id_of_event_data', op: 'eq', value: 1 }] }],
      capture: [{ name: 'select', step: 'lvl1', column: 'n_words' }] },
  ]);
  assert.equal(out.rows.length, 12, 'one row per player');
  assert.equal(new Set(out.rows.map((r) => r.group)).size, 12, 'the partition column carries each player once');
  assert.equal(reached(out.rows, 'lvl1'), 12);
  const vals = out.rows.filter((r) => tru(r.reached_lvl1)).map((r) => num(r.select));
  assert.ok(Math.abs(vals.reduce((s, v) => s + v, 0) / vals.length - 3) < 1e-9, `avg select=${vals}`);
});

test('funnel + prepare compute (array_contains): step filtered by derived boolean reaches 12', opts, async (t) => {
  if (skip(t)) return;
  const out = await mrPipe([
    { stage: 'compute', name: 'has_cat', expr: { fn: 'array_contains', property: 'words_collected', item: 'cat' } },
    { stage: 'match_recognize', partition_by: ['player_id_of_internal'],
      steps: [{ name: 'launch', event_name: ['first_launch'] }, { name: 'cat_lvl', event_name: ['level_completed'], where: [{ column: 'has_cat', op: 'eq', value: true }] }] },
  ]);
  assert.equal(reached(out.rows, 'cat_lvl'), 12); // every user's level-1 completion has 'cat'
});

// (IAP revenue by country through a point-in-time join — US 35 / GB 25 / BR 25 — aggregated and
// pivoted into per-country columns: the pipeline stages section above, the same stages.)

test('_buildPipeline: same name in two contexts → distinct relations', opts, async (t) => {
  if (skip(t)) return;
  const a = await engine._buildPipeline({ name: 'iso', pipeline: { source: 'events', stages: [{ stage: 'limit', limit: 1 }] } });
  const b = await engine._buildPipeline({ name: 'iso', pipeline: { source: 'events', stages: [{ stage: 'limit', limit: 1 }] } });
  assert.notEqual(a.context_id, b.context_id);
  assert.notEqual(a.model, b.model);
  assert.match(a.model, /^pipe_iso_[a-z0-9]{6,}$/);
});

test('semantic_index: overview lists models, then { source } drills into the usable columns', opts, async (t) => {
  if (skip(t)) return;
  const overview = await engine.semantic_index();
  assert.ok(overview.models.find((m) => m.key === 'events'), 'events model present in overview');
  // event_names is keyed BY SOURCE — each events source lists its own vocabulary, never merged.
  assert.ok(overview.event_names.events.length > 0, 'the events source lists its own event names');
  assert.equal(overview.models.find((m) => m.key === 'events').columns, undefined, 'overview does NOT dump columns');
  // drill down for the ONE list of usable columns (grounded to the real relation)
  const events = await engine.semantic_index({ source: 'events' });
  assert.equal(events.physical_columns, undefined, 'no second physical_columns list');
  assert.equal(events.pipeline_columns, undefined, 'no separate pipeline_columns list');
  // #4/#3: the usable columns + the time axis are discoverable
  assert.ok(Array.isArray(events.columns), 'events { source } lists columns');
  const pcNames = events.columns.map((c) => c.name);
  assert.ok(pcNames.includes('device_time') && pcNames.includes('player_id_of_internal'), 'columns include time + key');
  assert.equal(events.time, 'device_time', 'time axis (default window/match_recognize order) is reported');
  // { event } returns only the properties carried by that event
  const ev = await engine.semantic_index({ source: 'events', event: 'iap_purchase_completed' });
  assert.ok(ev.property_count > 0 && ev.properties.some((p) => p.name === 'price_in_usd_of_event_data'), 'event lists its scoped properties');
});

// #2: a date-only time_range bound includes the WHOLE day (not collapsed to midnight).
test('pipeline time_range: single date-only day is not collapsed to a midnight instant', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine._buildPipeline({ name: `day_${seq++}`, context_id: mrCtx, pipeline: { source: 'events', time_range: { start: '2026-01-05', end: '2026-01-05' }, stages: [
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', agg: 'count' }] },
  ] } });
  assert.equal(out.build?.ok, true, JSON.stringify(out.error || out.build));
  mrCtx = out.context_id;
  assert.equal(Number(out.rows[0].n), 2); // u10 + u11 purchased on 2026-01-05 — whole day, not 0
});

// ════════════ CHECKPOINTS (was pipeline-checkpoint.test.js) ════════════════════════════════════
// CHECKPOINTS on DATA: a pipeline continued on top of a materialized prefix must return exactly
// the numbers the same pipeline returns when built in one go — and must actually READ that prefix
// instead of recomputing it. The only honest proof of reuse is with numbers: we change the DATA in
// the checkpoint's table and continue; if the continuation reflects the change, it read the table.
// Data-only assertions (no SQL/YAML text anywhere).

// The pipeline used throughout: completed levels → their score → per-player totals → a filter on
// the totals. Steps 1..3 are the "expensive prefix" a checkpoint stands for; step 4 is the
// continuation. The prefix changes the grain (one row per player), so a checkpoint after it
// carries no event columns — exactly the case worth proving.
const CP_STEPS = [
  { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
  { stage: 'compute', name: 'score', expr: { fn: 'event_property', property: 'daily_level_score_of_event_data', type: 'numeric' } },
  { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'levels', agg: 'count' }, { name: 'total_score', agg: 'sum', column: 'score' }] },
  { stage: 'where', conditions: [{ column: 'levels', op: 'gte', value: 2 }] },
];

const byPlayer = (rows) => Object.fromEntries(rows.map((r) => [String(r.player_id_of_internal), [num(r.levels), num(r.total_score)]]));

/** Build a draft from `steps`, materializing after each index listed in `pointsAt` (1-based). */
async function cpBuild(name, steps, pointsAt = []) {
  const { context_id } = await engine.build_pipeline_model({ action: 'start', name, source: 'events' });
  let last = null;
  for (let i = 0; i < steps.length; i += 1) {
    await engine.build_pipeline_model({ action: 'add_steps', context_id, stages: [steps[i]] });
    if (pointsAt.includes(i + 1)) {
      last = await engine.build_pipeline_model({ action: 'materialize', context_id });
      assert.notEqual(last.ok, false, JSON.stringify(last.error));
    }
  }
  if (!pointsAt.includes(steps.length)) {
    last = await engine.build_pipeline_model({ action: 'materialize', context_id });
    assert.notEqual(last.ok, false, JSON.stringify(last.error));
  }
  return { context_id, result: last };
}

// The draft materialized at 3 and then at 4 IS a pipeline continued on a materialized prefix: before
// its edit it is held to the same pipeline built in one go (that was a test of its own, which built
// a second split draft for it).
test('editing a step AFTER the prefix keeps it: the numbers still match a full recompute', opts, async (t) => {
  if (skip(t)) return;
  // Two checkpoints (after 3 and after 4), then step 4 is edited: only the second is retired.
  const { context_id, result: before } = await cpBuild('cp_edit', CP_STEPS, [3, 4]);
  assert.equal(before.from_checkpoint.at, 3);
  // 'a pipeline continued on a materialized prefix returns the same rows as one built in one go'
  const whole = await cpBuild('cp_whole', CP_STEPS);
  assert.equal(before.steps_recomputed, 1, '[continued = whole] only the step after the prefix was built');
  assert.ok(whole.result.row_count > 0, '[continued = whole] the pipeline returns rows at all');
  assert.deepEqual(byPlayer(before.rows), byPlayer(whole.result.rows), '[continued = whole] the same rows as one built in one go');
  const edited = { stage: 'where', conditions: [{ column: 'levels', op: 'gte', value: 3 }] };
  const ed = await engine.build_pipeline_model({ action: 'edit_step', context_id, index: 4, stage: edited });
  assert.equal(ed.from_checkpoint.at, 3, 'the prefix survived an edit below it');
  const after = await engine.build_pipeline_model({ action: 'materialize', context_id });
  assert.notEqual(after.ok, false, JSON.stringify(after.error));
  assert.equal(after.steps_recomputed, 1);
  const fresh = await cpBuild('cp_edit_ref', [...CP_STEPS.slice(0, 3), edited]);
  assert.deepEqual(byPlayer(after.rows), byPlayer(fresh.result.rows));
});

// ONE materialized prefix serves what two tests each built it for: 'the prefix is READ, not
// recomputed: changing the data in its table changes the continuation' and 'a fork inherits the
// prefix: same numbers as an independent recompute, and the table is only read'. In order: a fork
// against an independent recompute (the data untouched), ONE change to the prefix's own table, then
// the parent's continuation and a second fork both read the changed row.
test('one materialized prefix: a fork of it equals an independent recompute; after its table is tampered (victim 99 / 4242) both the parent\'s continuation and a second fork read the tampered row, and the prefix table is left alone', opts, async (t) => {
  if (skip(t)) return;
  const { context_id, result: built } = await cpBuild('cp_parent', CP_STEPS.slice(0, 3), [3]);
  const before = byPlayer(built.rows);
  const players = Object.keys(before);
  assert.ok(players.length >= 2, 'several players in the prefix');

  // [fork] a fork inherits the prefix: same numbers as an independent recompute
  const fork = await engine.build_pipeline_model({ action: 'fork', context_id, after: 3, name: 'cp_fork' });
  assert.deepEqual(fork.inherited_checkpoints, [{ at: 3, model: built.model, owner: context_id }], '[fork] inherits the checkpoint');
  const tail = { stage: 'where', conditions: [{ column: 'total_score', op: 'gte', value: 1 }] };
  await engine.build_pipeline_model({ action: 'add_steps', context_id: fork.context_id, stages: [tail] });
  const forked = await engine.build_pipeline_model({ action: 'materialize', context_id: fork.context_id });
  assert.notEqual(forked.ok, false, JSON.stringify(forked.error));
  assert.equal(forked.from_checkpoint.model, built.model, "[fork] the fork read the parent's table");
  const independent = await cpBuild('cp_fork_ref', [...CP_STEPS.slice(0, 3), tail]);
  assert.deepEqual(byPlayer(forked.rows), byPlayer(independent.result.rows), '[fork] the same numbers as an independent recompute');

  // Rewrite the prefix's OWN table: one player's totals become unmistakable values. Recomputing
  // from the source would wipe this out; reading the table carries it through.
  const victim = players.sort()[0];
  await wh.query(`UPDATE main.${built.model} SET levels = 99, total_score = 4242 WHERE player_id_of_internal = '${victim}'`);

  // [prefix is read] the parent's continuation reads the changed row
  const cont = await engine.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'levels', op: 'gte', value: 2 }] }] });
  assert.equal(cont.from_checkpoint.at, 3, '[prefix is read] the continuation stands on the checkpoint');
  const out = await engine.build_pipeline_model({ action: 'materialize', context_id });
  assert.notEqual(out.ok, false, JSON.stringify(out.error));
  const rows = byPlayer(out.rows);
  assert.deepEqual(rows[victim], [99, 4242], '[prefix is read] the continuation read the materialized prefix');
  // every other player keeps the real numbers the prefix computed
  for (const p of players.filter((x) => x !== victim && before[x][0] >= 2)) assert.deepEqual(rows[p], before[p], `[prefix is read] ${p} unchanged`);
  // …and the prefix itself was NOT re-materialized: its table still holds exactly what it held
  // before the continuation ran (a recompute would have restored the real totals).
  const prefix = await readTable(engine, context_id, built.model);
  assert.equal(prefix.ok, true, JSON.stringify(prefix.error));
  assert.deepEqual(byPlayer(prefix.rows)[victim], [99, 4242], '[prefix is read] the prefix table was left alone');
  assert.notEqual(out.model, built.model, '[prefix is read] the continuation built its own model');

  // [fork] the inherited model is NOT rebuilt in a fork: a second fork branched over the changed
  // table carries the change into its own result.
  const fork2 = await engine.build_pipeline_model({ action: 'fork', context_id, after: 3, name: 'cp_fork2' });
  assert.deepEqual(fork2.inherited_checkpoints, [{ at: 3, model: built.model, owner: context_id }], '[fork] the second fork inherits the same checkpoint');
  await engine.build_pipeline_model({ action: 'add_steps', context_id: fork2.context_id, stages: [tail] });
  const tampered = await engine.build_pipeline_model({ action: 'materialize', context_id: fork2.context_id });
  assert.notEqual(tampered.ok, false, JSON.stringify(tampered.error));
  assert.equal(byPlayer(tampered.rows)[victim][1], 4242, '[fork] the inherited table was read, never rebuilt');
});

// A prefix that only FILTERED events still carries the source's own columns, so the stages that read
// them — a funnel, a payload read — keep working on top of it. The numbers must be identical to the
// same pipeline computed in one go.
test('a funnel and a payload read run on top of a materialized event slice, with the same numbers', opts, async (t) => {
  if (skip(t)) return;
  const SLICE = { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['level_started', 'level_completed'] }] };
  const FUNNEL = {
    stage: 'match_recognize',
    partition_by: ['player_id_of_internal'],
    steps: [{ name: 'started', event_name: ['level_started'] }, { name: 'completed', event_name: ['level_completed'] }],
  };
  const COUNT = { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'players', agg: 'count' }] };

  const whole = await cpBuild('cp_fn_whole', [SLICE, FUNNEL, COUNT]);
  const split = await cpBuild('cp_fn_split', [SLICE, FUNNEL, COUNT], [1]); // the slice is the prefix
  assert.equal(split.result.from_checkpoint.at, 1);
  assert.equal(split.result.steps_recomputed, 2);
  const tally = (r) => Object.fromEntries(r.rows.map((x) => [String(x.completed), num(x.players)]));
  assert.ok(Object.keys(tally(whole.result)).length > 0, 'the funnel returns rows at all');
  assert.deepEqual(tally(split.result), tally(whole.result));

  // The payload column survived the slice too, so an event_property read on top of the prefix reads it.
  const wholeScore = await cpBuild('cp_pl_whole', [SLICE, CP_STEPS[1], { stage: 'aggregate', group_by: [], measures: [{ name: 'total', agg: 'sum', column: 'score' }] }]);
  const splitScore = await cpBuild('cp_pl_split', [SLICE, CP_STEPS[1], { stage: 'aggregate', group_by: [], measures: [{ name: 'total', agg: 'sum', column: 'score' }] }], [1]);
  assert.equal(splitScore.result.from_checkpoint.at, 1);
  assert.equal(num(splitScore.result.rows[0].total), num(wholeScore.result.rows[0].total));
  assert.ok(num(wholeScore.result.rows[0].total) > 0, 'the payload actually carried values');
});

// ════════════ COMPLEX PAYLOAD TYPES (was crashlytics-complex-types.test.js) ════════════════════
// COMPLEX PAYLOAD TYPES ON THE CRASH SOURCE — ARRAYS, ARRAYS OF STRUCTS, JSON OBJECTS.
//
// A crash report's payload is not flat: a breadcrumb TRAIL, an exception STACK of frames, and
// whatever CUSTOM KEYS the app attached. In this warehouse all three arrive FLATTENED — one
// real column each, holding JSON — which is the shape a modelled warehouse produces and the
// shape that has no raw payload blob to key into. Every stage that touches complex data has to
// work on that shape, not only on a JSON blob.
//
// The three columns (see SEED_DATA §14):
//   breadcrumbs_of_event_data   JSON array of strings   — on every crash row
//   stack_frames_of_event_data  JSON array of { file, line, in_app } — fatal_crash / non_fatal
//                               only; NULL on anr, so those reports DROP OUT of an unnest
//   custom_keys_of_event_data   JSON object { level, coins, network } — on every crash row
//
// Every assertion is a number or a set of values the warehouse returned, from a pipeline built
// and materialized like any other. Auto-skips when dbt/mf are not installed.

const numOrNaN = (v) => Number(v === '' || v == null ? NaN : v);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), numOrNaN(r[valCol])]));
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(numOrNaN(r[col])) ? numOrNaN(r[col]) : 0), 0);

/** Build and materialize a pipeline over the crash source; return its rows. */
async function pipeRows(...stages) {
  const s = await engine.build_pipeline_model({ action: 'start', name: `cx_${seq++}`, source: 'crashlytics' });
  for (const stage of stages) {
    const r = await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [stage] });
    assert.ok(!r.error, `add_steps ${stage.stage}: ${JSON.stringify(r.error)}`);
  }
  const c = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

// ═══════════ A. an array of scalars ═══════════

// 1. Exploding the trail gives one row per breadcrumb: 20 across the 13 reports.
test('1. unnest a JSON string array: 20 breadcrumbs, level_start 4 / net_retry 4 / gc_pause 3', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', property: 'breadcrumbs_of_event_data', name: 'crumb', type: 'string' },
    { stage: 'aggregate', group_by: ['crumb'], measures: [{ name: 'n', agg: 'count' }, { name: 'crashes', agg: 'count_distinct', column: 'crash_id' }] },
  );
  const by = mapCol(rows, 'crumb', 'n');
  assert.deepEqual(by, { level_start: 4, ad_shown: 2, shop_open: 2, iap_start: 1, net_retry: 4, decode: 1, ui_freeze: 3, gc_pause: 3 });
  assert.equal(sumCol(rows, 'n'), 20);
  // net_retry appears 4 times but on only 3 reports — k8 logged it twice.
  assert.equal(mapCol(rows, 'crumb', 'crashes').net_retry, 3);
});

// 2. The same array read WITHOUT exploding: its length per report, on the flattened column.
//    This is the path that used to build SQL against a payload blob the crash table has not
//    got — the row count stays 13 because the grain is untouched.
test('2. array_length on the flattened array: 13 rows, 20 elements, longest 3', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'n_crumbs', expr: { fn: 'array_length', property: 'breadcrumbs_of_event_data' } },
    { stage: 'project', keep: ['crash_id', 'n_crumbs'] },
  );
  assert.equal(rows.length, 13, 'array_length does not change the grain');
  const by = mapCol(rows, 'crash_id', 'n_crumbs');
  assert.deepEqual(by, { k1: 2, k2: 1, k3: 2, k4: 2, k5: 1, k6: 1, k7: 1, k8: 2, k9: 1, k10: 1, k11: 2, k12: 1, k13: 3 });
  assert.equal(sumCol(rows, 'n_crumbs'), 20, 'and they sum to what the unnest produced');
});

// 3. Membership: `contains` answers "which REPORTS have this breadcrumb", which is not the same
//    number as how many times it occurs. One build, the flag per report: the reports it holds
//    for and the ones it does not are both read off the same 13 rows. (A where on a derived
//    array_contains flag is the same condition writer as the funnels section's array_contains
//    step.)
test('3. array_contains: 3 reports carry net_retry (though it occurs 4 times)', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'retried', expr: { fn: 'array_contains', property: 'breadcrumbs_of_event_data', item: 'net_retry' } },
    { stage: 'project', keep: ['crash_id', 'retried'] },
  );
  assert.equal(rows.length, 13, 'one row per report');
  const flagged = (v) => rows.filter((r) => String(r.retried) === v);
  // the flag's split: 3 reports carry it, the other 10 read false (none NULL)
  assert.equal(flagged('true').length, 3, '[by flag] true');
  assert.equal(flagged('false').length, 10, '[by flag] false');
  // …and the reports it holds for are exactly those
  assert.deepEqual(new Set(flagged('true').map((r) => String(r.crash_id))), new Set(['k7', 'k8', 'k9']), '[the reports] k7, k8, k9');
});

// ═══════════ B. an array of structs ═══════════

// 4. One struct FIELD per row: the stack, exploded into frames, counted per file.
test('4. unnest an array of structs by field: 16 frames over 6 files, Game.cs 5', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', property: 'stack_frames_of_event_data', name: 'file', field: 'file' },
    { stage: 'aggregate', group_by: ['file'], measures: [{ name: 'n', agg: 'count' }, { name: 'crashes', agg: 'count_distinct', column: 'crash_id' }] },
  );
  const by = mapCol(rows, 'file', 'n');
  assert.deepEqual(by, { 'Game.cs': 5, 'Engine.cs': 3, 'Shop.cs': 2, 'Ads.cs': 1, 'Net.cs': 4, 'Decode.cs': 1 });
  assert.equal(rows.length, 6, 'six distinct files');
  assert.equal(sumCol(rows, 'n'), 16);
  assert.equal(mapCol(rows, 'file', 'crashes')['Net.cs'], 3, 'Net.cs appears twice in k8, so 4 frames on 3 reports');
});

// 5. The WHOLE struct bound as one column, then several fields pulled off it — the only way to
//    keep file, line and in_app on the same row. One build of the 16 frames, every figure read
//    off its rows (the totals, the in_app split and the deepest frame were three builds).
test('5. unnest a struct then json_field x3: sum(line) 922, max 250, in_app 13 / 3', opts, async (t) => {
  if (skip(t)) return;
  const frames = await pipeRows(
    { stage: 'unnest', property: 'stack_frames_of_event_data', name: 'frame' },
    { stage: 'compute', name: 'file', expr: { fn: 'json_field', args: [{ column: 'frame' }], field: 'file' } },
    { stage: 'compute', name: 'line', expr: { fn: 'json_field', args: [{ column: 'frame' }], field: 'line', type: 'int' } },
    { stage: 'compute', name: 'in_app', expr: { fn: 'json_field', args: [{ column: 'frame' }], field: 'in_app' } },
    { stage: 'project', keep: ['crash_id', 'file', 'line', 'in_app'] },
  );
  assert.equal(frames.length, 16, '[totals] 16 frames');
  assert.ok(frames.every((r) => typeof r.line === 'number'), `[totals] the line numbers came through as NUMBERS, not text: ${JSON.stringify(frames.map((r) => r.line))}`);
  assert.equal(frames.reduce((s, r) => s + r.line, 0), 922, '[totals] sum(line)');
  assert.equal(Math.max(...frames.map((r) => r.line)), 250, '[totals] the deepest line');
  assert.equal(new Set(frames.map((r) => String(r.file))).size, 6, '[totals] distinct files');

  // the boolean field of the struct splits app code from engine code
  const inApp = (v) => frames.filter((r) => String(r.in_app) === v).length;
  assert.equal(inApp('true'), 13, '[in_app split] true');
  assert.equal(inApp('false'), 3, '[in_app split] the three Engine.cs frames');

  // and file + line together identify a frame: the deepest one is Engine.cs:250 in k6
  const deepest = frames.filter((r) => r.line === 250);
  assert.equal(deepest.length, 1, '[deepest frame] one frame at line 250');
  assert.equal(String(deepest[0].crash_id), 'k6', '[deepest frame] crash');
  assert.equal(String(deepest[0].file), 'Engine.cs', '[deepest frame] file');
});

// 6. An array-of-structs also answers non-exploding questions: how deep was each stack.
test('6. array_length over the struct array: 16 frames on 10 reports, ANRs read NULL', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'depth', expr: { fn: 'array_length', property: 'stack_frames_of_event_data' } },
    { stage: 'project', keep: ['crash_id', 'event_name', 'depth'] },
  );
  assert.equal(rows.length, 13, 'every report is still here');
  const by = Object.fromEntries(rows.map((r) => [String(r.crash_id), r.depth == null || r.depth === '' ? null : numOrNaN(r.depth)]));
  assert.deepEqual(by, { k1: 2, k2: 1, k3: 3, k4: 2, k5: 1, k6: 2, k7: 1, k8: 2, k9: 1, k10: 1, k11: null, k12: null, k13: null });
  assert.equal(sumCol(rows, 'depth'), 16);
  // the three NULLs are exactly the ANRs — a blocked main thread has no exception stack.
  const anr = rows.filter((r) => String(r.event_name) === 'anr');
  assert.equal(anr.length, 3);
  assert.ok(anr.every((r) => r.depth == null || r.depth === ''), JSON.stringify(anr));
});

// 7. …and that is the difference between the two readings: an unnest DROPS the reports with no
//    stack, while a length keeps them. Same data, two grains, both correct. (The length's side —
//    13 reports, 10 of them with a depth — is 6's rows; a count over a column skipping its NULLs
//    is model-results.test.js's count(column) read.)
test('7. unnest drops the stackless reports (10 of 13), a length keeps all 13', opts, async (t) => {
  if (skip(t)) return;
  const exploded = await pipeRows(
    { stage: 'unnest', property: 'stack_frames_of_event_data', name: 'file', field: 'file' },
    { stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }, { name: 'crashes', agg: 'count_distinct', column: 'crash_id' }] },
  );
  assert.equal(numOrNaN(exploded[0].n), 16);
  assert.equal(numOrNaN(exploded[0].crashes), 10, 'k11..k13 have no stack, so they are simply not there');
});

// ═══════════ C. a JSON object (not an array) ═══════════

// 8. Custom keys are an OBJECT: one field read out of it becomes a groupable attribute.
test('8. event_property with a field of a JSON object: wifi 8 / cellular 5', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'network', expr: { fn: 'event_property', property: 'custom_keys_of_event_data', field: 'network' } },
    { stage: 'aggregate', group_by: ['network'], measures: [{ name: 'n', agg: 'count' }] },
  );
  assert.deepEqual(mapCol(rows, 'network', 'n'), { wifi: 8, cellular: 5 });
});

// 9. …and a NUMERIC field of the object is a number once asked for as one: it sums and maxes.
test('9. json_field with a cast over the object column: coins 5205, top level 31', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'coins', expr: { fn: 'json_field', args: [{ column: 'custom_keys_of_event_data' }], field: 'coins', type: 'int' } },
    { stage: 'compute', name: 'level', expr: { fn: 'json_field', args: [{ column: 'custom_keys_of_event_data' }], field: 'level', type: 'int' } },
    { stage: 'aggregate', measures: [
      { name: 'n', agg: 'count' },
      { name: 'coins', agg: 'sum', column: 'coins' },
      { name: 'levels', agg: 'sum', column: 'level' },
      { name: 'top_level', agg: 'max', column: 'level' },
      { name: 'median_level', agg: 'median', column: 'level' },
    ] },
  );
  assert.equal(numOrNaN(rows[0].n), 13);
  assert.equal(numOrNaN(rows[0].coins), 5205);
  assert.equal(numOrNaN(rows[0].levels), 163);
  assert.equal(numOrNaN(rows[0].top_level), 31);
  assert.equal(numOrNaN(rows[0].median_level), 12, 'a statistical aggregate over a JSON-extracted number');
});

// ═══════════ D. an array turned into a native one, then indexed ═══════════

// 10. Parsing the JSON string into a real array makes positional access possible: the FIRST
//     breadcrumb is where the session was, the LAST is what happened just before the crash.
test('10. json_parse_array then element_at / array_last: first vs last breadcrumb', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'trail', expr: { fn: 'json_parse_array', args: [{ column: 'breadcrumbs_of_event_data' }] } },
    { stage: 'compute', name: 'entered', expr: { fn: 'element_at', args: [{ column: 'trail' }], index: 1 } },
    { stage: 'compute', name: 'died_at', expr: { fn: 'array_last', args: [{ column: 'trail' }] } },
    { stage: 'project', keep: ['crash_id', 'entered', 'died_at'] },
  );
  assert.equal(rows.length, 13);
  const pair = Object.fromEntries(rows.map((r) => [String(r.crash_id), `${r.entered}>${r.died_at}`]));
  assert.equal(pair.k1, 'level_start>ad_shown');
  assert.equal(pair.k3, 'shop_open>iap_start');
  assert.equal(pair.k11, 'ui_freeze>gc_pause');
  assert.equal(pair.k13, 'gc_pause>gc_pause', 'the trail starts and ends on the same step');
  assert.equal(pair.k2, 'level_start>level_start', 'a one-element trail: first and last coincide');
  // what the app was doing at the moment it died, across all reports — counted over the same 13
  // per-report rows
  const last = {};
  for (const r of rows) last[String(r.died_at)] = (last[String(r.died_at)] || 0) + 1;
  assert.equal(Object.values(last).reduce((a, b) => a + b, 0), 13, '[died_at] every report');
  assert.deepEqual(last, { ad_shown: 2, iap_start: 1, level_start: 2, shop_open: 1, net_retry: 3, decode: 1, gc_pause: 2, ui_freeze: 1 }, '[died_at] by the last breadcrumb');
});

// ═══════════ E. complex data across a join ═══════════

// 11. An exploded array survives a point-in-time join: breadcrumbs by the install country
//     valid at the moment of the crash.
test('11. unnest then a point-in-time join: 20 breadcrumbs as GB 10 / US 6 / DE 3 / BR 1', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', property: 'breadcrumbs_of_event_data', name: 'crumb', type: 'string' },
    { stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', attrs: [{ column: 'country' }] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', agg: 'count' }, { name: 'crashes', agg: 'count_distinct', column: 'crash_id' }] },
  );
  assert.deepEqual(mapCol(rows, 'country', 'n'), { GB: 10, US: 6, DE: 3, BR: 1 });
  assert.equal(sumCol(rows, 'n'), 20, 'the join added no duplicates: still 20 elements');
  assert.equal(sumCol(rows, 'crashes'), 13);
});

// 12. …and across a chain: the stack frames of the crash, alongside the ad funnel that was
//     running when it happened. 6 reports have both a stack and a rewarded funnel; their
//     10 frames each pair with the funnel's 2 events.
test('12. stack frames x the rewarded ad funnel: 20 rows, 6 reports, 5 files', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', property: 'stack_frames_of_event_data', name: 'file', field: 'file' },
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: [{ column: 'event_id' }] },
    { stage: 'aggregate', measures: [
      { name: 'n', agg: 'count' },
      { name: 'crashes', agg: 'count_distinct', column: 'crash_id' },
      { name: 'files', agg: 'count_distinct', column: 'file' },
      { name: 'events', agg: 'count_distinct', column: 'event_id' },
    ] },
  );
  assert.equal(numOrNaN(rows[0].n), 20);
  assert.equal(numOrNaN(rows[0].crashes), 6, 'k13 carries a funnel but no stack, so it drops out');
  assert.equal(numOrNaN(rows[0].files), 5, 'Ads.cs is only in k4, which has no rewarded funnel');
  assert.equal(numOrNaN(rows[0].events), 6, 'three funnels: fnl_01, fnl_04, fnl_06');
});

// 13. Two complex columns of the SAME report in one pipeline: the trail exploded, the object
//     read for a segment. The trail multiplies rows; the object field does not.
test('13. an array and an object together: 20 breadcrumbs split wifi 13 / cellular 7', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'network', expr: { fn: 'event_property', property: 'custom_keys_of_event_data', field: 'network' } },
    { stage: 'unnest', property: 'breadcrumbs_of_event_data', name: 'crumb', type: 'string' },
    { stage: 'aggregate', group_by: ['network'], measures: [{ name: 'n', agg: 'count' }, { name: 'crashes', agg: 'count_distinct', column: 'crash_id' }] },
  );
  assert.deepEqual(mapCol(rows, 'network', 'n'), { wifi: 13, cellular: 7 });
  assert.equal(sumCol(rows, 'n'), 20);
  assert.deepEqual(mapCol(rows, 'network', 'crashes'), { wifi: 8, cellular: 5 }, 'the object field did not change the report count');
});

// ═══════════ F. guards (input validation) ═══════════

// (14. A complex op on a column that is not complex is refused, naming what the column IS — four
// add_steps refusals driven by the catalog's declared shapes, no warehouse read:
// test/unit/build-pipeline-model.test.js.)

// 15. The catalog SURFACES the shape, so a caller knows what to reach for: which properties
//     are complex, and whether an element is a scalar or a struct.
test('15. the complex properties are discoverable with their declared shape', opts, async (t) => {
  if (skip(t)) return;
  const view = await engine.semantic_index({ source: 'crashlytics', event: 'fatal_crash' });
  const props = Object.fromEntries((view.properties || []).map((p) => [p.name, p]));

  const trail = props.breadcrumbs_of_event_data;
  assert.ok(trail, 'the trail is listed');
  assert.equal(trail.type, 'array');
  assert.equal(trail.complex, true);

  const stack = props.stack_frames_of_event_data;
  assert.ok(stack, 'so is the stack');
  assert.equal(stack.type, 'array<struct>', 'and it is marked as an array of STRUCTS, not of scalars');
  assert.equal(stack.complex, true);

  // The custom keys hold a JSON object rather than an array, so the index types the column as
  // the scalar it physically is; what it contains is stated in its description, which is what a
  // caller reads before reaching for json_field.
  const keys = props.custom_keys_of_event_data;
  assert.ok(keys, 'the custom keys are listed');
  assert.ok(!keys.complex, 'an object column is not an array');
  assert.match(keys.description, /JSON object/);

  // the model view lists all three as real columns of the source, so a pipeline can name them
  const model = await engine.semantic_index({ source: 'crashlytics' });
  const cols = new Set((model.columns || []).map((c) => String(c.name ?? c)));
  for (const n of ['breadcrumbs_of_event_data', 'stack_frames_of_event_data', 'custom_keys_of_event_data']) {
    assert.ok(cols.has(n), `${n} is a referenceable column (got: ${[...cols].join(', ')})`);
  }
});

// ════════════ CALLER TEXT IS NEVER JINJA (was jinja-inert.test.js) ═════════════════════════════
// A caller's text lands in files dbt renders as Jinja — every generated .sql model (its header
// comment records the whole declaration, and filter values are string literals in its body) and
// the prose of the YAML it writes. dbt evaluates `{{ … }}` / `{% … %}` wherever they appear, so
// such text must reach the warehouse as the plain characters the caller typed, never as template.
//
// Asserted on DATA against DuckDB: the same pipeline is built with a normal filter value and with
// one that is a Jinja expression evaluating to that value. Were the template evaluated, both would
// count the 12 first_launch events (SEED_DATA §11); inert, the second compares the literal text and
// counts none. The control draft's description carries a `run_query` that would fail the build if
// it ran, and an unbalanced `{%` that would fail compilation — the build must succeed regardless.

async function countWhere(name, condition, description) {
  const s = await engine.build_pipeline_model({ action: 'start', name, source: 'events', ...(description ? { description } : {}) });
  assert.ok(s.context_id, JSON.stringify(s));
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'where', conditions: [{ column: 'event_name', ...condition }] }] });
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, stages: [{ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }] });
  const c = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return Number(c.rows[0].n);
}

// Two builds carry the three checks: the control's declaration is the Jinja header (its 12 proves
// the header neither ran nor broke the build), and both Jinja values sit in one `in` filter.
test('a filter value that is a Jinja expression is compared as the literal text, never evaluated', opts, async (t) => {
  if (skip(t)) return;
  const header = "{{ run_query('select 1/0') }} and an unbalanced {% if";
  assert.equal(await countWhere('jinja_plain', { op: 'eq', value: 'first_launch' }, header), 12,
    '[the control, declared with a Jinja header] 12 first_launch events: the header neither ran nor broke the build');
  // evaluated, the first value would have matched the same 12; read as Jinja, the second (an
  // unbalanced opener) would have failed compilation
  assert.equal(await countWhere('jinja_expr', { op: 'in', value: ['{{ "first_launch" }}', 'a {% b {# c'] }), 0,
    '[Jinja filter values] compared as the literal text: no event is named either');
});

// The governed path writes the same caller text into context.yml (a measure's filter literal inside
// its expr, a label) and MetricFlow renders its own filters as Jinja too. SEED_DATA: 8 distinct
// players reached tutorial step_1.
test('governed path: a Jinja filter value is literal, a Jinja label neither runs nor breaks dbt parse', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_semantic_model({
    name: 'jtut',
    semantic_models: [{ from: 'events', measures: [{ name: 's1', agg: 'count_distinct', field: 'player_id_of_internal', where: [{ field: 'event_name', op: 'eq', value: 'tutorial' }, { field: 'element_of_event_data', op: 'eq', value: 'step_1' }], label: '{{ run_query(\'select 1/0\') }} {% if' }, { name: 'sj', agg: 'count_distinct', field: 'player_id_of_internal', where: [{ field: 'event_name', op: 'eq', value: 'tutorial' }, { field: 'element_of_event_data', op: 'eq', value: '{{ "step_1" }}' }] }] }],
    metrics: [{ name: 's1', type: 'simple', measure: 's1' }, { name: 'sj', type: 'simple', measure: 'sj' }],
  });
  assert.equal(out.parse?.ok, true, JSON.stringify(out.parse || out.error));
  const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['jtut_s1', 'jtut_sj'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(Number(r.rows[0].jtut_s1), 8, 'the control: 8 players at step_1');
  assert.equal(Number(r.rows[0].jtut_sj ?? 0), 0, 'evaluated, the Jinja value would have counted the same 8');
});

// ════════════ GUARDED JSON READS (was duckdb-json-guard.test.js) ═══════════════════════════════
// A TEXT column holding JSON is read through DuckDB's JSON functions, and they RAISE on a row whose
// text is not JSON — one such row fails the WHOLE statement. Every read must therefore guard the
// read, or a single malformed row turns a working query into an error.
//
// This asserts DATA: the expressions run against a real DuckDB database over a table that holds
// one good row and one malformed one, and the test reads the VALUES that come back. It does not
// look at the SQL text.

test('duckdb JSON reads: a malformed row yields NULL instead of failing the query', async (t) => {
  const db = await scratchWarehouse(t);

  await db.exec(`
    CREATE TABLE payloads (id int, tags text, obj text);
    INSERT INTO payloads VALUES
      (1, '["rewarded","banner"]', '{"mode":"a","n":"7"}'),
      (2, 'not json at all',       'also not json'),
      (3, '{"not":"an array"}',    '{"mode":"b","n":"9"}');
  `);

  // array length: good row counts, malformed and wrong-shape rows read as absent
  const len = await db.query(`SELECT id, ${duck.jsonColumnArrayLength('tags')} AS n FROM payloads ORDER BY id`);
  assert.deepEqual(len.rows.map((r) => [r.id, r.n]), [[1, 2], [2, null], [3, null]]);

  // array containment: true on the good row, NULL (not an error) on the others
  const has = await db.query(`SELECT id, ${duck.jsonColumnArrayContains('tags', 'banner')} AS hit FROM payloads ORDER BY id`);
  assert.deepEqual(has.rows.map((r) => [r.id, r.hit]), [[1, true], [2, null], [3, null]]);
  const missing = await db.query(`SELECT id, ${duck.jsonColumnArrayContains('tags', 'nope')} AS hit FROM payloads WHERE id = 1`);
  assert.equal(missing.rows[0].hit, false, 'a value that is not in the array is false, not NULL');

  // struct field: the field on the good rows, NULL on the malformed one
  const field = await db.query(`SELECT id, ${duck.jsonColumnStructField('obj', 'mode')} AS mode FROM payloads ORDER BY id`);
  assert.deepEqual(field.rows.map((r) => [r.id, r.mode]), [[1, 'a'], [2, null], [3, 'b']]);

  // …and a typed read casts only what parsed
  const typed = await db.query(`SELECT id, ${duck.jsonColumnStructField('obj', 'n', 'numeric')} AS n FROM payloads ORDER BY id`);
  assert.deepEqual(typed.rows.map((r) => [r.id, r.n == null ? null : Number(r.n)]), [[1, 7], [2, null], [3, 9]]);

  // the whole point: every one of those statements returned ROWS rather than raising
  const count = await db.query('SELECT count(*)::int AS n FROM payloads');
  assert.equal(count.rows[0].n, 3);
});

// The JSON was valid, the VALUE was not a number: a plain CAST of a word aborts the whole statement
// on DuckDB, while BigQuery's SAFE_CAST returns NULL for that row and results for the rest. Both
// dialects must answer the same question the same way, so every typed read goes through the safe
// cast. Asserted on the values that come back (and on the aggregate over them).
test('duckdb typed reads: a non-numeric value reads as NULL and the query still returns rows', async (t) => {
  const db = await scratchWarehouse(t);
  await db.exec(`
    CREATE TABLE amounts (id int, blob json, flat text, arr text);
    INSERT INTO amounts VALUES
      (1, '{"amount":"12.5"}', '{"amount":"12.5"}', '["1","2"]'),
      (2, '{"amount":"n/a"}',  '{"amount":"n/a"}',  '["3","x"]');
  `);

  // a blob property read as a number: the word becomes NULL, 12.5 still arrives
  const blob = await db.query(`SELECT id, ${duck.jsonExtract('blob', 'amount', 'numeric')} AS v FROM amounts ORDER BY id`);
  assert.deepEqual(blob.rows.map((r) => [r.id, r.v == null ? null : Number(r.v)]), [[1, 12.5], [2, null]]);

  // the same through a FLATTENED text column holding JSON
  const flat = await db.query(`SELECT id, ${duck.jsonColumnStructField('flat', 'amount', 'numeric')} AS v FROM amounts ORDER BY id`);
  assert.deepEqual(flat.rows.map((r) => [r.id, r.v == null ? null : Number(r.v)]), [[1, 12.5], [2, null]]);

  // and through an unnested array of strings read as numbers
  const un = duck.arrayUnnest('a', 'arr', null, 'el', null, 'int', 'json');
  const arr = await db.query(`SELECT a.id, ${un.element} AS v FROM amounts a ${un.join} ORDER BY a.id, v NULLS LAST`);
  assert.deepEqual(arr.rows.map((r) => [r.id, r.v == null ? null : Number(r.v)]), [[1, 1], [1, 2], [2, 3], [2, null]]);

  // an aggregate over the mixed column still works — that is what a pipeline actually does
  const sum = await db.query(`SELECT sum(${duck.jsonExtract('blob', 'amount', 'numeric')}) AS total FROM amounts`);
  assert.equal(Number(sum.rows[0].total), 12.5);
});

// ════════════ AN OPEN-ENDED VALIDITY WINDOW (was scd-open-window.test.js) ══════════════════════
// A point-in-time join reads the version of a slowly-changing row that was valid at the event's
// time. The CURRENT version usually has NO END yet — dbt's own snapshots write NULL into
// `dbt_valid_to` — and `BETWEEN from AND NULL` is never true, so the plain form dropped exactly
// the rows a "what is it now" question is about: every recent event lost its attributes silently.
//
// Asserted on DATA: the join runs against a real DuckDB database over a dimension whose latest
// version is open-ended, and the test reads the VALUES that come back per event.

const AT_SCD = { column: 'event_time', from: 'valid_from', to: 'valid_until' };

test('a point-in-time join keeps the open-ended current version, and still picks the right one per event', async (t) => {
  const db = await scratchWarehouse(t);

  await db.exec(`
    CREATE TABLE ev (id int, player_id text, event_time timestamp, amount numeric);
    INSERT INTO ev VALUES
      (1, 'u1', '2026-01-01 10:00:00', 10),
      (2, 'u1', '2026-01-05 10:00:00', 20),
      (3, 'u2', '2026-01-05 10:00:00', 30);
    CREATE TABLE dim (player_id text, country text, valid_from timestamp, valid_until timestamp);
    INSERT INTO dim VALUES
      ('u1', 'US', '2026-01-01 00:00:00', '2026-01-02 23:59:59'),  -- closed: the old version
      ('u1', 'GB', '2026-01-03 00:00:00', NULL),                   -- CURRENT: no end yet
      ('u2', 'BR', '2026-01-01 00:00:00', NULL);
  `);

  const op = { on: ['player_id'], attrs: [{ column: 'country', as: 'country' }], relation: 'dim', between: AT_SCD };
  const sql = duck.joinCte('ev', op);
  const r = await db.query(`SELECT id, country, amount FROM (${sql}) x ORDER BY id`);

  // every event kept its row, and each got the country valid AT ITS OWN TIME
  assert.deepEqual(r.rows.map((x) => [x.id, x.country]), [[1, 'US'], [2, 'GB'], [3, 'BR']]);
  // …so the per-country totals are the real ones, not a hole where the current version should be
  const sums = await db.query(`SELECT country, sum(amount)::int AS total FROM (${sql}) x GROUP BY country ORDER BY country`);
  assert.deepEqual(sums.rows.map((x) => [x.country, x.total]), [['BR', 30], ['GB', 20], ['US', 10]]);

  // and the window still EXCLUDES a version that had already ended: no event matches two versions
  const fanout = await db.query(`SELECT count(*)::int AS n FROM (${sql}) x`);
  assert.equal(fanout.rows[0].n, 3, 'one row per event — the key alone would have matched both u1 versions');
});
