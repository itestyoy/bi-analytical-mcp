// WHAT THE CONDITION WRITER AND THE EXPRESSION WRITER MEAN, PROVEN ON THE ROWS (DuckDB + dbt; the same
// requests are the BigQuery checks): a condition whose arguments are conditions finds the rows it says
// (each operand keeps its own precedence); a JSON field is text, so a flag compared with it is its text —
// the rows whose field says true, and none where it holds a word; concat is missing where any argument is,
// each argument read as its text; a payload key the catalog declares boolean, cast to a number, is its
// 1 / 0; a column compared as its constants' kind (the retentioneering filter's) is read by the one
// conversion of a text; and a flattened boolean property is its column's flag. Every expectation is the seed's (SEED_DATA.md) or the warehouse's own count of the
// same rows, read with SQL written by hand here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { getDialect } from '../../src/dialects/index.js';
import { Engine } from '../../src/engine.js';
import { conditionListSql } from '../../src/pipeline/compute.js';
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
  const at = join(tempDir('sqlrev-d-cat'), 'catalog.yml');
  writeFileSync(at, yaml.dump(doc));
  const catalog = loadCatalog(at, { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('sqlrev-d'), timeSpineDialect: 'duckdb' });
  backend = testDbt({ profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
const truth = async (sql) => (await wh.query(sql)).rows;

/** A pipeline over `source`, its steps added and materialized: its rows. */
async function pipe(source, steps) {
  const s = await engine.build_model({ action: 'start', name: `sqlrev_d_${seq++}`, source });
  const a = await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps });
  assert.ok(!a.error, `add_steps: ${JSON.stringify(a.error)}`);
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

// D1. A condition as an argument of a comparison is that condition's value: level > session is true on
// 27 of the 53 rows that carry a level, false on 26, missing on the 131 that carry none (SEED_DATA); and
// "completed" differs from "won" on the 5 lost levels, agrees on the 20 won — a row with no result
// compares a missing value, and holds neither.
test('a condition whose arguments are conditions finds the rows it means', opts, async (t) => {
  if (skip(t)) return;
  const [want] = await truth(`select
      count(*) filter (where level_id_of_event_data > session_number) as gt_true,
      count(*) filter (where level_id_of_event_data <= session_number) as gt_false,
      count(*) filter (where level_id_of_event_data is null or session_number is null) as gt_missing,
      count(*) filter (where (event_name = 'level_completed') <> (result_of_event_data = 'win')) as differ,
      count(*) filter (where (event_name = 'level_completed') = (result_of_event_data = 'win')) as agree
    from fct_analytics_events`);
  assert.deepEqual([want.gt_true, want.gt_false, want.gt_missing, want.differ, want.agree].map(num), [27, 26, 131, 5, 20], 'the seed');
  const gt = fn('gt', [col('level_id_of_event_data'), col('session_number')]);
  const completed = fn('eq', [col('event_name'), val('level_completed')]);
  const won = fn('eq', [col('result_of_event_data'), val('win')]);
  const [got] = await pipe('events', [
    { stage: 'aggregate', measures: [
      { name: 'gt_true', expr: rowsWhere(fn('eq', [gt, val(true)])) },
      { name: 'gt_false', expr: rowsWhere(fn('eq', [gt, val(false)])) },
      { name: 'gt_missing', expr: rowsWhere(fn('is_null', [gt])) },
      { name: 'gt_in_false', expr: rowsWhere(fn('in', [gt, val(false)])) },
      { name: 'differ', expr: rowsWhere(fn('neq', [completed, won])) },
      { name: 'agree', expr: rowsWhere(fn('eq', [completed, won])) },
    ] },
  ]);
  assert.equal(num(got.gt_true), num(want.gt_true), '[eq [gt, true]]');
  assert.equal(num(got.gt_false), num(want.gt_false), '[eq [gt, false]]');
  assert.equal(num(got.gt_missing), num(want.gt_missing), '[is_null [gt]]');
  assert.equal(num(got.gt_in_false), num(want.gt_false), '[in [gt, false]]');
  assert.equal(num(got.differ), num(want.differ), '[neq [eq, eq]] the lost levels');
  assert.equal(num(got.agree), num(want.agree), '[eq [eq, eq]] the won levels');
  // …and in a where stage, the rows it keeps
  const [kept] = await pipe('events', [
    { stage: 'where', conditions: [fn('neq', [completed, won])] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ]);
  assert.equal(num(kept.n), num(want.differ), '[where neq [eq, eq]]');
});

// D2. A field of a JSON object is text, so a flag compared with it is its text: the payload's
// is_reward_received says "true" on 5 ad_finished rows and "false" on 7, its placement holds a word on the
// 24 ad_started / ad_finished rows (never a flag — it equals true on none, and differs from it on every
// one); the crash stacks' in_app is
// a JSON boolean, true on 13 frames and false on 3, and a frame's file is a word on all 16.
test('a JSON field compared with a flag finds the rows whose field says it, and none where it holds a word', opts, async (t) => {
  if (skip(t)) return;
  const [want] = await truth(`select
      count(*) filter (where event_data->>'is_reward_received' = 'true') as yes,
      count(*) filter (where event_data->>'is_reward_received' = 'false') as no,
      count(*) filter (where event_data->>'placement' is not null) as placed
    from fct_analytics_events`);
  assert.deepEqual([want.yes, want.no, want.placed].map(num), [5, 7, 24], 'the seed');
  const field = (name) => fn('json_field', [col('event_data')], { field: name });
  const [got] = await pipe('events', [
    { stage: 'aggregate', measures: [
      { name: 'yes', expr: rowsWhere(fn('eq', [field('is_reward_received'), val(true)])) },
      { name: 'no', expr: rowsWhere(fn('eq', [field('is_reward_received'), val(false)])) },
      { name: 'listed', expr: rowsWhere(fn('in', [field('is_reward_received'), val(true), val(false)])) },
      { name: 'word_true', expr: rowsWhere(fn('eq', [field('placement'), val(true)])) },
      { name: 'word_not_true', expr: rowsWhere(fn('neq', [field('placement'), val(true)])) },
    ] },
  ]);
  assert.equal(num(got.yes), num(want.yes), '[eq true] the rewarded rows');
  assert.equal(num(got.no), num(want.no), '[eq false] the others');
  assert.equal(num(got.listed), num(want.yes) + num(want.no), '[in true, false] every row that carries it');
  assert.equal(num(got.word_true), 0, '[eq true] a word is no flag');
  assert.equal(num(got.word_not_true), num(want.placed), '[neq true] every row with a placement: present and different');

  const [frames] = await pipe('crashlytics', [
    { stage: 'unnest', expr: { property: 'stack_frames_of_event_data' }, name: 'frame' },
    { stage: 'aggregate', measures: [
      { name: 'n', expr: { fn: 'count' } },
      { name: 'in_app', expr: rowsWhere(fn('eq', [fn('json_field', [col('frame')], { field: 'in_app' }), val(true)])) },
      { name: 'engine', expr: rowsWhere(fn('eq', [fn('json_field', [col('frame')], { field: 'in_app' }), val(false)])) },
      { name: 'file_true', expr: rowsWhere(fn('eq', [fn('json_field', [col('frame')], { field: 'file' }), val(true)])) },
    ] },
  ]);
  assert.deepEqual([frames.n, frames.in_app, frames.engine, frames.file_true].map(num), [16, 13, 3, 0], '[a JSON boolean field] SEED_DATA §10: 16 frames, 13 in the app, the 3 Engine.cs frames');
});

// D4. concat is missing where any of its arguments is: a crash report's message is missing on the 7
// non-fatal and ANR reports (k7..k13), so the tag holds on the 6 fatal ones — k1 and k2 alike; an argument
// that is no text is read as its text (the length of the crash id).
test('concat is missing where any argument is, and reads each argument as its text', opts, async (t) => {
  if (skip(t)) return;
  const tag = fn('concat', [col('app_version'), val('-'), col('device_model'), val('-'), col('crash_message_of_event_data')]);
  const [got] = await pipe('crashlytics', [
    { stage: 'compute', name: 'tag', expr: tag },
    { stage: 'aggregate', measures: [
      { name: 'missing', expr: rowsWhere(fn('is_null', [col('tag')])) },
      { name: 'present', expr: rowsWhere(fn('is_not_null', [col('tag')])) },
      { name: 'k1_like', expr: rowsWhere(fn('eq', [col('tag'), val('1.0.0-iphone-npe at level')])) },
    ] },
  ]);
  assert.deepEqual([got.missing, got.present, got.k1_like].map(num), [7, 6, 2], '[missing] k7..k13 carry no message; k1 and k2 are 1.0.0-iphone-npe at level');
  const rows = await pipe('crashlytics', [
    { stage: 'compute', name: 'id_len', expr: fn('concat', [col('crash_id'), val('#'), fn('length', [col('crash_id')])]) },
    { stage: 'project', keep: ['crash_id', 'id_len'] },
  ]);
  const by = Object.fromEntries(rows.map((r) => [String(r.crash_id), String(r.id_len)]));
  assert.equal(by.k1, 'k1#2', '[a number argument] its text');
  assert.equal(by.k13, 'k13#3', '[a number argument] its text');
});

// D5. A payload key the catalog declares boolean, cast to a number, is its 1 / 0 — cast's rule for a
// flag, read straight off the payload: the 5 rewarded rows sum to 5, and none of the 12 that carry it
// reads missing.
test('a payload key declared boolean cast to an integer is 1 / 0', opts, async (t) => {
  if (skip(t)) return;
  const [want] = await truth(`select count(*) filter (where event_data->>'is_reward_received' = 'true') as yes,
      count(*) filter (where event_data->>'is_reward_received' in ('true', 'false')) as carried from fct_analytics_events`);
  const [got] = await pipe('events', [
    { stage: 'compute', name: 'paid_int', expr: fn('cast', [{ property: 'is_reward_received' }], { type: 'int' }) },
    { stage: 'compute', name: 'paid_float', expr: fn('cast', [{ property: 'is_reward_received' }], { type: 'float' }) },
    { stage: 'aggregate', measures: [
      { name: 'ints', expr: fn('sum', [col('paid_int')]) },
      { name: 'cast', expr: fn('count', [col('paid_int')]) },
      { name: 'floats', expr: fn('sum', [col('paid_float')]) },
    ] },
  ]);
  assert.equal(num(got.ints), num(want.yes), '[cast int] the sum is the rewarded rows');
  assert.equal(num(got.cast), num(want.carried), '[cast int] no flag reads missing');
  assert.equal(num(got.floats), num(want.yes), '[cast float] 1.0 / 0.0');
});

// D3. A column compared as its constants' kind (castToConstant: the retentioneering filter, whose
// segments are stored as text) is read by the one conversion of a text: '1_000' is no number (as on
// BigQuery), a number around spaces is one; a flag is its true / false in any case — '1', 't' and 'yes'
// are none. The condition is the writer's; the rows it keeps are counted by the warehouse.
test('a column compared as its constants\' kind is read by the one conversion of a text', opts, async (t) => {
  if (skip(t)) return;
  const d = getDialect('duckdb');
  const kept = async (values, cond) => {
    const [pred] = conditionListSql(d, null, [cond], 'where', { castToConstant: true, place: 'stored_rows' });
    const rows = values.map((v) => `(${v === null ? 'CAST(NULL AS VARCHAR)' : `'${v}'`})`).join(', ');
    const [r] = await truth(`select count(*) as n from (values ${rows}) as t(seg) where ${pred}`);
    return num(r.n);
  };
  const numbers = ['1_000', '1000', ' 2000 ', '5', 'abc', '0x1F', null];
  assert.equal(await kept(numbers, fn('gt', [col('seg'), val(999)])), 2, '[gt 999] 1000 and 2000');
  assert.equal(await kept(numbers, fn('lt', [col('seg'), val(999)])), 1, '[lt 999] 5 alone');
  const flags = ['true', 'TRUE', ' false ', '1', 't', 'yes', null];
  assert.equal(await kept(flags, fn('eq', [col('seg'), val(true)])), 2, '[eq true] true, TRUE');
  assert.equal(await kept(flags, fn('eq', [col('seg'), val(false)])), 1, '[eq false] false');
});

// A flattened event property is its column, read as the column is: the crash reports' is_fatal is a
// BOOLEAN column, so { property } compared with true is that flag — the same rows as { column }, and a
// computed copy of it is stored as the flag it is (the warehouse's own count of the fatal reports; a
// boolean a compute stores is never missing, so the ANRs' missing flag is stored false).
test('a flattened boolean property compared with true is its column\'s flag, read directly and through a computed copy', opts, async (t) => {
  if (skip(t)) return;
  const [want] = await truth(`select count(*) filter (where is_fatal_of_event_data) as yes, count(*) filter (where not is_fatal_of_event_data) as no,
      count(*) filter (where is_fatal_of_event_data is null) as missing from fct_crashlytics_events`);
  assert.ok(num(want.yes) > 0 && num(want.no) > 0, 'the fixture has both');
  const fatal = { property: 'is_fatal_of_event_data' };
  const COUNT = { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] };
  const [byProperty] = await pipe('crashlytics', [{ stage: 'where', conditions: [fn('eq', [fatal, val(true)])] }, COUNT]);
  assert.equal(num(byProperty.n), num(want.yes), '[where eq [property, true]]');
  const [byColumn] = await pipe('crashlytics', [{ stage: 'where', conditions: [fn('eq', [col('is_fatal_of_event_data'), val(true)])] }, COUNT]);
  assert.equal(num(byColumn.n), num(want.yes), '[where eq [column, true]]');
  const [copied] = await pipe('crashlytics', [
    { stage: 'compute', name: 'fatal', expr: fatal },
    { stage: 'aggregate', measures: [
      { name: 'yes', expr: rowsWhere(fn('eq', [col('fatal'), val(true)])) },
      { name: 'no', expr: rowsWhere(fn('eq', [col('fatal'), val('false')])) },
    ] },
  ]);
  assert.deepEqual([num(copied.yes), num(copied.no)], [num(want.yes), num(want.no) + num(want.missing)], '[compute fatal = property] then eq true / "false"');
});
