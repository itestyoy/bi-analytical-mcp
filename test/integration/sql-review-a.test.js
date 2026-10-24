// WHAT THE DIALECTS WRITE, PROVEN ON THE ROWS (DuckDB + dbt; the same requests are the BigQuery checks):
// a text constant is the value it says, a quote and a backslash in it included — in a condition (the
// condition writer's literal) and in a computed value (the dialect's); an array's length is 0 where there
// is no array, in every form; a payload key the catalog declares boolean is read as a flag; elapsed_days
// is the FLOOR of the span in 24h buckets, and the seconds between two moments exact to the microsecond;
// a text is a moment only where BigQuery reads one; a DATE column is a moment to date_trunc / date_part /
// elapsed_days and to a join's validity window. Every expectation is the seed's (SEED_DATA.md) or the
// warehouse's own count of the same rows, read with SQL written by hand here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { getDialect } from '../../src/dialects/index.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');
const opts = { timeout: 300000 };

let wh;
let engine;
let backend;
let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const val = (value) => ({ value });
const col = (column) => ({ column });
const fn = (name, args, extra = {}) => ({ fn: name, args, ...extra });
/** The rows where `cond` holds: a count over a case that yields 1 there and nothing elsewhere. */
const rowsWhere = (cond) => fn('count', [{ fn: 'case', cases: [{ when: [cond], then: val(1) }] }]);

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied
  // the fixture's catalog, with one key of the events payload declared a boolean: the blob's
  // is_reward_received holds 'true' / 'false' on ad_finished (its flattened column stays text)
  const doc = yaml.load(readFileSync(CATALOG, 'utf8'));
  const events = doc.models.find((m) => m.name === 'fct_analytics_events');
  const blob = events.columns.find((c) => c.name === 'event_data');
  blob.config.meta.mcp.properties.is_reward_received = { type: 'boolean', description: 'Whether the ad paid its reward. Events: ad_finished.' };
  const at = join(tempDir('sqlrev-a-cat'), 'catalog.yml');
  writeFileSync(at, yaml.dump(doc));
  const catalog = loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('sqlrev-a'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const truth = async (sql) => (await wh.query(sql)).rows;

/** A pipeline over `source`, its steps added and materialized: its rows. */
async function pipe(source, steps) {
  const s = await engine.build_model({ action: 'start', name: `sqlrev_a_${seq++}`, source });
  const a = await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps });
  assert.ok(!a.error, `add_steps: ${JSON.stringify(a.error)}`);
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

// A1. Every event's name, with a suffix that holds a quote, a backslash and a double quote: the rows a
// condition finds by the whole text are exactly the tutorial's, the others are not, and every row holds
// the suffix — the constant in the computed value and the constants in the conditions are the text written.
test('a text constant holding a quote and a backslash is the value it says, in a computed value and in a condition', opts, async (t) => {
  if (skip(t)) return;
  const SUFFIX = `'s \\ "x" \\'`;
  const [want] = await truth("select count(*) as n, count(*) filter (where event_name = 'tutorial') as tutorial from fct_analytics_events");
  assert.ok(num(want.tutorial) > 0, 'the fixture has tutorial events');
  const rows = await pipe('events', [
    { stage: 'compute', name: 'tagged', expr: fn('concat', [col('event_name'), val(SUFFIX)]) },
    { stage: 'where', conditions: [fn('ends_with', [col('tagged'), val(SUFFIX)])] },
    { stage: 'aggregate', measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'hits', expr: rowsWhere(fn('eq', [col('tagged'), val(`tutorial${SUFFIX}`)])) },
      { name: 'misses', expr: rowsWhere(fn('neq', [col('tagged'), val(`tutorial${SUFFIX}`)])) },
      { name: 'listed', expr: rowsWhere(fn('in', [col('tagged'), val(`tutorial${SUFFIX}`), val(`first_launch${SUFFIX}`)])) },
      { name: 'quoted', expr: rowsWhere(fn('contains', [col('tagged'), val("l's \\")])) },
    ] },
  ]);
  const [got] = rows;
  assert.equal(num(got.n), num(want.n), '[ends_with the suffix] every row holds it');
  assert.equal(num(got.hits), num(want.tutorial), '[eq] the tutorial rows');
  assert.equal(num(got.misses), num(want.n) - num(want.tutorial), '[neq] every other row');
  assert.equal(num(got.listed), num(want.tutorial) + 12, '[in] the tutorial rows and the 12 first launches');
  // "l's \" is a name ending in l (the tutorial's) followed by the suffix
  const [ls] = await truth("select count(*) as n from fct_analytics_events where event_name like '%l'");
  assert.equal(num(got.quoted), num(ls.n), '[contains] the names ending in l');
});

// A4. An array's length where there is no array is 0, not missing — a key of the payload absent (or
// holding a scalar: e2's words_collected is the text 'oops-not-an-array'), a JSON column that is NULL (the
// ANRs have no stack), and a parsed JSON array of a NULL text.
test('an array length is 0 where there is no array: a payload key, a JSON column, a parsed JSON array', opts, async (t) => {
  if (skip(t)) return;
  const [want] = await truth(`select count(*) as n,
      count(*) filter (where json_type(event_data, '$.words_collected') = 'ARRAY') as arrays,
      sum(case when json_type(event_data, '$.words_collected') = 'ARRAY' then json_array_length(event_data, '$.words_collected') else 0 end) as words
    from fct_analytics_events`);
  const [ev] = await pipe('events', [
    { stage: 'compute', name: 'n_words', expr: fn('array_length', [{ property: 'words_collected' }]) },
    { stage: 'aggregate', measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'missing', expr: rowsWhere(fn('is_null', [col('n_words')])) },
      { name: 'zero', expr: rowsWhere(fn('eq', [col('n_words'), val(0)])) },
      { name: 'words', expr: fn('sum', [col('n_words')]) },
    ] },
  ]);
  assert.equal(num(ev.missing), 0, '[payload key] no row reads missing');
  assert.equal(num(ev.zero), num(want.n) - num(want.arrays), '[payload key] every row with no array (none is empty) reads 0');
  assert.equal(num(ev.words), num(want.words), '[payload key] the words of the rows that hold them');

  const crashes = await pipe('crashlytics', [
    { stage: 'compute', name: 'depth', expr: fn('array_length', [{ property: 'stack_frames_of_event_data' }]) },
    { stage: 'compute', name: 'parsed', expr: fn('array_length', [fn('json_parse_array', [col('stack_frames_of_event_data')])]) },
    { stage: 'project', keep: ['crash_id', 'depth', 'parsed'] },
  ]);
  // SEED_DATA §10: the stacks' depths; k11..k13 are ANRs, with no stack
  const frames = { k1: 2, k2: 1, k3: 3, k4: 2, k5: 1, k6: 2, k7: 1, k8: 2, k9: 1, k10: 1, k11: 0, k12: 0, k13: 0 };
  assert.deepEqual(Object.fromEntries(crashes.map((r) => [String(r.crash_id), num(r.depth)])), frames, '[JSON column] the ANRs read 0');
  assert.deepEqual(Object.fromEntries(crashes.map((r) => [String(r.crash_id), num(r.parsed)])), frames, '[parsed JSON array] the ANRs read 0');
});

// A6. A payload key the catalog declares boolean is read as a flag: compared with true / false, and
// stored as one — its cast to an integer is 1 / 0, which a text 'true' would not be (missing).
test('a payload key declared boolean is read as a flag: compared with true / false, cast to 1 / 0', opts, async (t) => {
  if (skip(t)) return;
  const [want] = await truth(`select count(*) filter (where is_reward_received_of_event_data = 'true') as yes,
      count(*) filter (where is_reward_received_of_event_data = 'false') as no from fct_analytics_events`);
  assert.ok(num(want.yes) > 0 && num(want.no) > 0, 'the fixture has both');
  const flag = { property: 'is_reward_received' };
  const [got] = await pipe('events', [
    { stage: 'where', conditions: [fn('or', [fn('eq', [flag, val(true)]), fn('eq', [flag, val(false)])])] },
    { stage: 'compute', name: 'paid', expr: flag },
    { stage: 'compute', name: 'paid_int', expr: fn('cast', [col('paid')], { type: 'int' }) },
    { stage: 'aggregate', measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'yes', expr: rowsWhere(fn('eq', [col('paid'), val(true)])) },
      { name: 'no', expr: rowsWhere(fn('eq', [col('paid'), val('false')])) },
      { name: 'ints', expr: fn('sum', [col('paid_int')]) },
      { name: 'cast', expr: fn('count', [col('paid_int')]) },
    ] },
  ]);
  assert.equal(num(got.n), num(want.yes) + num(want.no), '[where eq true / false] the rows that carry the flag');
  assert.equal(num(got.yes), num(want.yes), '[eq true] the rewarded rows');
  assert.equal(num(got.no), num(want.no), "[eq 'false'] the others");
  assert.equal(num(got.ints), num(want.yes), '[cast int] a flag is 1 / 0: the sum is the rewarded rows');
  assert.equal(num(got.cast), num(got.n), '[cast int] no flag reads missing');
});

// A5. elapsed_days is the FLOOR of the span in 24h buckets, signed: a moment before `from` is day -1, not 0
// (truncation would give 0 / -1 / 0 below). The endpoints are constants, so the count is the definition.
test('elapsed_days floors the span: -28h is day -2, -4h day -1, a microsecond before day -1, a microsecond short of a day 0', opts, async (t) => {
  if (skip(t)) return;
  const ed = (name, from, to) => ({ stage: 'compute', name, expr: fn('elapsed_days', [val(from), val(to)], { clamp_zero: false }) });
  const [row] = await pipe('events', [
    ed('neg28h', '2026-01-02 12:00:00', '2026-01-01 08:00:00'),
    ed('neg4h', '2026-01-02 12:00:00', '2026-01-02 08:00:00'),
    ed('neg1us', '2026-01-02 00:00:00.000001', '2026-01-02 00:00:00'),
    ed('short', '2026-01-01 00:00:00', '2026-01-01 23:59:59.999999'),
    { stage: 'limit', limit: 1 },
    { stage: 'project', keep: ['neg28h', 'neg4h', 'neg1us', 'short'] },
  ]);
  assert.deepEqual([num(row.neg28h), num(row.neg4h), num(row.neg1us), num(row.short)], [-2, -1, -1, 0]);
});

// A2. A DATE column is a moment to every time function. event_date is the day an event ARRIVED: e1 (Thu
// 2026-01-01 08:00) on its own day, e108 (2026-01-01 10:00, the late hour) on Sun 2026-01-04 — both in the
// ISO week of Mon 2025-12-29; a date's hour is 0; from e108's arrival day back to its event is -62h, day -3.
test('a DATE column truncates, has its parts and spans days as its midnight: e1 and e108', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipe('events', [
    { stage: 'where', conditions: [fn('in', [col('event_id'), val('e1'), val('e108')])] },
    { stage: 'compute', name: 'wk', expr: fn('date_trunc', [col('event_date')], { grain: 'week' }) },
    { stage: 'compute', name: 'wk_start', expr: fn('substring', [fn('cast', [col('wk')], { type: 'string' })], { start: 1, len: 10 }) },
    { stage: 'compute', name: 'dow', expr: fn('date_part', [col('event_date')], { part: 'dow' }) },
    { stage: 'compute', name: 'hr', expr: fn('date_part', [col('event_date')], { part: 'hour' }) },
    { stage: 'compute', name: 'days', expr: fn('elapsed_days', [col('event_date'), col('device_time')], { clamp_zero: false }) },
    { stage: 'project', keep: ['event_id', 'wk_start', 'dow', 'hr', 'days'] },
  ]);
  const by = Object.fromEntries(rows.map((r) => [String(r.event_id), [String(r.wk_start), num(r.dow), num(r.hr), num(r.days)]]));
  assert.deepEqual(by, { e1: ['2025-12-29', 4, 0, 0], e108: ['2025-12-29', 7, 0, -3] });
});

// A3. A join's validity window compares a DATE with TIMESTAMP bounds as its midnight: u1 is US until
// 2026-01-02 23:59:59 and GB from 2026-01-03, so its events take the version valid at the start of the day
// they arrived — the warehouse's own count of the same match.
test('a join validity window on a DATE column picks the version valid at its midnight: u1 by country', opts, async (t) => {
  if (skip(t)) return;
  const want = await truth(`select u.country, count(*) as n
    from fct_analytics_events e
    left join dim_users u on u.player_id_of_internal = e.player_id_of_internal
      and cast(e.event_date as timestamp) >= u.install_time_valid_from
      and (u.install_time_valid_until is null or cast(e.event_date as timestamp) <= u.install_time_valid_until)
    where e.player_id_of_internal = 'u1' group by 1`);
  assert.equal(want.length, 2, 'the window splits u1 between its two versions');
  const rows = await pipe('events', [
    { stage: 'where', conditions: [fn('eq', [col('player_id_of_internal'), val('u1')])] },
    { stage: 'join', source: 'users', on: { user: 'player_id_of_internal', time: 'event_date' }, attrs: [{ column: 'country' }] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ]);
  const map = (rs) => Object.fromEntries(rs.map((r) => [String(r.country), num(r.n)]));
  assert.deepEqual(map(rows), map(want));
});

// A5. The seconds between two moments are the exact microseconds between them, divided: 1.2 s is 1.2 (two
// epochs in seconds, DOUBLEs, would make it 1.2000000476837158), a microsecond 1e-06, as BigQuery's
// TIMESTAMP_DIFF(…, MICROSECOND) / 1000000 reads them; two DATEs a day of seconds. The dialect's writer of
// a funnel's time between steps, read by the warehouse.
test('the seconds between two moments are exact to the microsecond', opts, async (t) => {
  if (skip(t)) return;
  const d = getDialect('duckdb');
  const ts = (v) => `TIMESTAMP '${v}'`;
  const [r] = await truth(`select
      ${d.secondsBetween(ts('2024-01-01 10:00:00.1'), ts('2024-01-01 10:00:01.3'))} as a,
      ${d.secondsBetween(ts('2024-01-01 00:00:00'), ts('2024-01-01 00:00:12.345678'))} as b,
      ${d.secondsBetween(ts('2024-01-01 00:00:00'), ts('2024-01-01 00:00:00.000001'))} as c,
      ${d.secondsBetween(ts('2024-01-01 10:00:01.3'), ts('2024-01-01 10:00:00.1'))} as neg,
      ${d.secondsBetween("DATE '2024-01-01'", "DATE '2024-01-02'")} as days,
      (${d.secondsBetween(ts('2024-01-01 10:00:00.1'), ts('2024-01-01 10:00:01.3'))} + ${d.secondsBetween(ts('2024-01-01 10:00:00'), ts('2024-01-01 10:00:00.6'))}) / 2 as avg`);
  // (the average is the double arithmetic of the exact spans, as on BigQuery)
  assert.deepEqual([r.a, r.b, r.c, r.neg, r.days, r.avg].map(num), [1.2, 12.345678, 1e-06, -1.2, 86400, (1.2 + 0.6) / 2]);
});

// A6. A text is read as a moment only where it is written as BigQuery reads one (GoogleSQL's canonical
// form): a date, a date-time with its seconds, up to six fractional digits, Z / z, an offset, a zone name —
// and a T or t between them; never '2024/01/05', 'epoch', 'infinity', an hour 24, a time without seconds
// or nine fractional digits (DuckDB's own cast reads each). A flag and a moment are trimmed of the same
// whitespace on both warehouses (a tab, a newline). The dialect's one conversion of a text, read by the
// warehouse over a list of texts.
test('a text is read as a moment only in the form BigQuery reads, and a flag or a moment around tabs and newlines', opts, async (t) => {
  if (skip(t)) return;
  const d = getDialect('duckdb');
  const read = async (texts, type, as) => {
    const rows = texts.map((v, i) => `(${i}, ${d.sqlLiteral(v)})`).join(', ');
    const out = await truth(`select i, ${as(d.fromText('v', type))} as r from (values ${rows}) as t(i, v) order by i`);
    return out.map((x) => (x.r == null ? null : String(x.r)));
  };
  const moment = (sql) => `strftime(${sql}, '%Y-%m-%d %H:%M:%S.%f')`;
  const texts = [
    '2024-01-05 10:00:00', '2024-01-05', '2024-01-05T10:00:00.123456Z', '2024-01-05t10:00:00z',
    '2024-01-05 10:00:00+0530', '2024-01-05 10:00:00-5', '2024-01-05 10:00:00 Asia/Kolkata', '\t2024-01-05 10:00:00\n',
    '2024/01/05', 'epoch', 'infinity', '2024-01-05 24:00:00', '2024-01-05 10:00', '2024-01-05T10:00:00.123456789Z',
  ];
  assert.deepEqual(await read(texts, 'timestamp', moment), [
    '2024-01-05 10:00:00.000000', '2024-01-05 00:00:00.000000', '2024-01-05 10:00:00.123456', '2024-01-05 10:00:00.000000',
    '2024-01-05 04:30:00.000000', '2024-01-05 15:00:00.000000', '2024-01-05 04:30:00.000000', '2024-01-05 10:00:00.000000',
    null, null, null, null, null, null,
  ]);
  const flags = ['\ttrue', 'true\n', ' TRUE ', '\r\nfalse\t', 'yes', '1', 't'];
  assert.deepEqual(await read(flags, 'boolean', (sql) => `CAST(${sql} AS VARCHAR)`), ['true', 'true', 'true', 'false', null, null, null]);
});
