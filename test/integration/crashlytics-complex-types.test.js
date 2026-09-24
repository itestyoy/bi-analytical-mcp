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
import { settle } from '../helpers/settle.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const PY_BIN = process.env.PYTHON_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'python');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg; let engine; let backend; let seq = 0;

const num = (v) => Number(v === '' || v == null ? NaN : v);
const mapCol = (rows, keyCol, valCol) => Object.fromEntries(rows.map((r) => [String(r[keyCol]), num(r[valCol])]));
const sumCol = (rows, col) => rows.reduce((s, r) => s + (Number.isFinite(num(r[col])) ? num(r[col]) : 0), 0);
/** The validity window of the install record, per the crash source's own time column. */
const AT = (value) => ({ value, from: 'install_time_valid_from', to: 'install_time_valid_until' });

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed', '--full-refresh'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });

  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'cxtype-')), timeSpineDialect: 'postgres' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close(); if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** Build and materialize a pipeline over the crash source; return its rows. */
async function pipeRows(...stages) {
  const s = await engine.build_pipeline_model({ action: 'start', name: `cx_${seq++}`, source: 'crashlytics' });
  for (const stage of stages) {
    const r = await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage });
    assert.ok(!r.error, `add_step ${stage.stage}: ${JSON.stringify(r.error)}`);
  }
  const c = await engine.build_pipeline_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

/** The add_step response (for rejection assertions). */
async function step(stage) {
  const s = await engine.build_pipeline_model({ action: 'start', name: `cxw_${seq++}`, source: 'crashlytics' });
  return engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage });
}

// ═══════════ A. an array of scalars ═══════════

// 1. Exploding the trail gives one row per breadcrumb: 20 across the 13 reports.
test('1. unnest a JSON string array: 20 breadcrumbs, level_start 4 / net_retry 4 / gc_pause 3', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', source: 'breadcrumbs_of_event_data', as: 'crumb', type: 'string' },
    { stage: 'aggregate', group_by: ['crumb'], measures: [{ name: 'n', fn: 'count' }, { name: 'crashes', fn: 'count_distinct', column: 'crash_id' }] },
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
test('2. derive array_length on the flattened array: 13 rows, 20 elements, longest 3', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'derive', name: 'n_crumbs', op: 'array_length', source: 'breadcrumbs_of_event_data' },
    { stage: 'project', columns: ['crash_id', 'n_crumbs'] },
  );
  assert.equal(rows.length, 13, 'array_length does not change the grain');
  const by = mapCol(rows, 'crash_id', 'n_crumbs');
  assert.deepEqual(by, { k1: 2, k2: 1, k3: 2, k4: 2, k5: 1, k6: 1, k7: 1, k8: 2, k9: 1, k10: 1, k11: 2, k12: 1, k13: 3 });
  assert.equal(sumCol(rows, 'n_crumbs'), 20, 'and they sum to what the unnest produced');
});

// 3. Membership: `contains` answers "which REPORTS have this breadcrumb", which is not the same
//    number as how many times it occurs.
test('3. derive contains: 3 reports carry net_retry (though it occurs 4 times)', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'derive', name: 'retried', op: 'contains', source: 'breadcrumbs_of_event_data', value: 'net_retry' },
    { stage: 'aggregate', group_by: ['retried'], measures: [{ name: 'n', fn: 'count' }] },
  );
  const by = mapCol(rows, 'retried', 'n');
  assert.equal(by.true, 3);
  assert.equal(by.false, 10);
  // …and filtering on it keeps exactly those reports.
  const only = await pipeRows(
    { stage: 'derive', name: 'retried', op: 'contains', source: 'breadcrumbs_of_event_data', value: 'net_retry' },
    { stage: 'where', conditions: [{ column: 'retried', op: 'eq', value: true }] },
    { stage: 'project', columns: ['crash_id'] },
  );
  assert.deepEqual(new Set(only.map((r) => String(r.crash_id))), new Set(['k7', 'k8', 'k9']));
});

// ═══════════ B. an array of structs ═══════════

// 4. One struct FIELD per row: the stack, exploded into frames, counted per file.
test('4. unnest an array of structs by field: 16 frames over 6 files, Game.cs 5', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', source: 'stack_frames_of_event_data', as: 'file', field: 'file' },
    { stage: 'aggregate', group_by: ['file'], measures: [{ name: 'n', fn: 'count' }, { name: 'crashes', fn: 'count_distinct', column: 'crash_id' }] },
  );
  const by = mapCol(rows, 'file', 'n');
  assert.deepEqual(by, { 'Game.cs': 5, 'Engine.cs': 3, 'Shop.cs': 2, 'Ads.cs': 1, 'Net.cs': 4, 'Decode.cs': 1 });
  assert.equal(rows.length, 6, 'six distinct files');
  assert.equal(sumCol(rows, 'n'), 16);
  assert.equal(mapCol(rows, 'file', 'crashes')['Net.cs'], 3, 'Net.cs appears twice in k8, so 4 frames on 3 reports');
});

// 5. The WHOLE struct bound as one column, then several fields pulled off it — the only way to
//    keep file, line and in_app on the same row.
test('5. unnest a struct then json_field x3: sum(line) 922, max 250, in_app 13 / 3', opts, async (t) => {
  if (skip(t)) return;
  const frames = [
    { stage: 'unnest', source: 'stack_frames_of_event_data', as: 'frame' },
    { stage: 'compute', name: 'file', op: 'json_field', column: 'frame', field: 'file' },
    { stage: 'compute', name: 'line', op: 'json_field', column: 'frame', field: 'line', type: 'int' },
    { stage: 'compute', name: 'in_app', op: 'json_field', column: 'frame', field: 'in_app' },
  ];
  const totals = await pipeRows(...frames, {
    stage: 'aggregate',
    measures: [
      { name: 'n', fn: 'count' },
      { name: 'lines', fn: 'sum', column: 'line' },
      { name: 'deepest', fn: 'max', column: 'line' },
      { name: 'files', fn: 'count_distinct', column: 'file' },
    ],
  });
  assert.equal(num(totals[0].n), 16);
  assert.equal(num(totals[0].lines), 922, 'the line numbers came through as NUMBERS, not text');
  assert.equal(num(totals[0].deepest), 250);
  assert.equal(num(totals[0].files), 6);

  // the boolean field of the struct splits app code from engine code
  const split = await pipeRows(...frames, { stage: 'aggregate', group_by: ['in_app'], measures: [{ name: 'n', fn: 'count' }] });
  const by = mapCol(split, 'in_app', 'n');
  assert.equal(by.true, 13);
  assert.equal(by.false, 3, 'the three Engine.cs frames');

  // and file + line together identify a frame: the deepest one is Engine.cs:250 in k6
  const deepest = await pipeRows(...frames,
    { stage: 'where', conditions: [{ column: 'line', op: 'eq', value: 250 }] },
    { stage: 'project', columns: ['crash_id', 'file', 'line'] });
  assert.equal(deepest.length, 1);
  assert.equal(String(deepest[0].crash_id), 'k6');
  assert.equal(String(deepest[0].file), 'Engine.cs');
});

// 6. An array-of-structs also answers non-exploding questions: how deep was each stack.
test('6. array_length over the struct array: 16 frames on 10 reports, ANRs read NULL', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'derive', name: 'depth', op: 'array_length', source: 'stack_frames_of_event_data' },
    { stage: 'project', columns: ['crash_id', 'event_name', 'depth'] },
  );
  assert.equal(rows.length, 13, 'every report is still here');
  const by = Object.fromEntries(rows.map((r) => [String(r.crash_id), r.depth == null || r.depth === '' ? null : num(r.depth)]));
  assert.deepEqual(by, { k1: 2, k2: 1, k3: 3, k4: 2, k5: 1, k6: 2, k7: 1, k8: 2, k9: 1, k10: 1, k11: null, k12: null, k13: null });
  assert.equal(sumCol(rows, 'depth'), 16);
  // the three NULLs are exactly the ANRs — a blocked main thread has no exception stack.
  const anr = rows.filter((r) => String(r.event_name) === 'anr');
  assert.equal(anr.length, 3);
  assert.ok(anr.every((r) => r.depth == null || r.depth === ''), JSON.stringify(anr));
});

// 7. …and that is the difference between the two readings: an unnest DROPS the reports with no
//    stack, while a length keeps them. Same data, two grains, both correct.
test('7. unnest drops the stackless reports (10 of 13), a length keeps all 13', opts, async (t) => {
  if (skip(t)) return;
  const exploded = await pipeRows(
    { stage: 'unnest', source: 'stack_frames_of_event_data', as: 'file', field: 'file' },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }, { name: 'crashes', fn: 'count_distinct', column: 'crash_id' }] },
  );
  assert.equal(num(exploded[0].n), 16);
  assert.equal(num(exploded[0].crashes), 10, 'k11..k13 have no stack, so they are simply not there');
  const kept = await pipeRows(
    { stage: 'derive', name: 'depth', op: 'array_length', source: 'stack_frames_of_event_data' },
    { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }, { name: 'with_stack', fn: 'count', column: 'depth' }] },
  );
  assert.equal(num(kept[0].n), 13);
  assert.equal(num(kept[0].with_stack), 10, 'count over the column skips the NULLs');
});

// ═══════════ C. a JSON object (not an array) ═══════════

// 8. Custom keys are an OBJECT: one field read out of it becomes a groupable attribute.
test('8. derive struct_field on a JSON object: wifi 8 / cellular 5', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'derive', name: 'network', op: 'struct_field', source: 'custom_keys_of_event_data', field: 'network' },
    { stage: 'aggregate', group_by: ['network'], measures: [{ name: 'n', fn: 'count' }] },
  );
  assert.deepEqual(mapCol(rows, 'network', 'n'), { wifi: 8, cellular: 5 });
});

// 9. …and a NUMERIC field of the object is a number once asked for as one: it sums and maxes.
test('9. json_field with a cast over the object column: coins 5205, top level 31', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'coins', op: 'json_field', column: 'custom_keys_of_event_data', field: 'coins', type: 'int' },
    { stage: 'compute', name: 'level', op: 'json_field', column: 'custom_keys_of_event_data', field: 'level', type: 'int' },
    { stage: 'aggregate', measures: [
      { name: 'n', fn: 'count' },
      { name: 'coins', fn: 'sum', column: 'coins' },
      { name: 'levels', fn: 'sum', column: 'level' },
      { name: 'top_level', fn: 'max', column: 'level' },
      { name: 'median_level', fn: 'median', column: 'level' },
    ] },
  );
  assert.equal(num(rows[0].n), 13);
  assert.equal(num(rows[0].coins), 5205);
  assert.equal(num(rows[0].levels), 163);
  assert.equal(num(rows[0].top_level), 31);
  assert.equal(num(rows[0].median_level), 12, 'a statistical aggregate over a JSON-extracted number');
});

// ═══════════ D. an array turned into a native one, then indexed ═══════════

// 10. Parsing the JSON string into a real array makes positional access possible: the FIRST
//     breadcrumb is where the session was, the LAST is what happened just before the crash.
test('10. json_parse_array then element_at / array_last: first vs last breadcrumb', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'trail', op: 'json_parse_array', column: 'breadcrumbs_of_event_data' },
    { stage: 'compute', name: 'entered', op: 'element_at', column: 'trail', index: 1 },
    { stage: 'compute', name: 'died_at', op: 'array_last', column: 'trail' },
    { stage: 'project', columns: ['crash_id', 'entered', 'died_at'] },
  );
  assert.equal(rows.length, 13);
  const pair = Object.fromEntries(rows.map((r) => [String(r.crash_id), `${r.entered}>${r.died_at}`]));
  assert.equal(pair.k1, 'level_start>ad_shown');
  assert.equal(pair.k3, 'shop_open>iap_start');
  assert.equal(pair.k11, 'ui_freeze>gc_pause');
  assert.equal(pair.k13, 'gc_pause>gc_pause', 'the trail starts and ends on the same step');
  assert.equal(pair.k2, 'level_start>level_start', 'a one-element trail: first and last coincide');
  // what the app was doing at the moment it died, across all reports
  const last = await pipeRows(
    { stage: 'compute', name: 'trail', op: 'json_parse_array', column: 'breadcrumbs_of_event_data' },
    { stage: 'compute', name: 'died_at', op: 'array_last', column: 'trail' },
    { stage: 'aggregate', group_by: ['died_at'], measures: [{ name: 'n', fn: 'count' }] });
  assert.equal(sumCol(last, 'n'), 13);
  assert.deepEqual(mapCol(last, 'died_at', 'n'), { ad_shown: 2, iap_start: 1, level_start: 2, shop_open: 1, net_retry: 3, decode: 1, gc_pause: 2, ui_freeze: 1 });
});

// ═══════════ E. complex data across a join ═══════════

// 11. An exploded array survives a point-in-time join: breadcrumbs by the install country
//     valid at the moment of the crash.
test('11. unnest then a point-in-time join: 20 breadcrumbs as GB 10 / US 6 / DE 3 / BR 1', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', source: 'breadcrumbs_of_event_data', as: 'crumb', type: 'string' },
    { stage: 'join', with: 'users', via: 'user', between: AT('event_time'), kind: 'inner', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'n', fn: 'count' }, { name: 'crashes', fn: 'count_distinct', column: 'crash_id' }] },
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
    { stage: 'unnest', source: 'stack_frames_of_event_data', as: 'file', field: 'file' },
    { stage: 'join', with: 'events', via: 'ad_funnel_rewarded', kind: 'inner', attrs: ['event_id'] },
    { stage: 'aggregate', measures: [
      { name: 'n', fn: 'count' },
      { name: 'crashes', fn: 'count_distinct', column: 'crash_id' },
      { name: 'files', fn: 'count_distinct', column: 'file' },
      { name: 'events', fn: 'count_distinct', column: 'event_id' },
    ] },
  );
  assert.equal(num(rows[0].n), 20);
  assert.equal(num(rows[0].crashes), 6, 'k13 carries a funnel but no stack, so it drops out');
  assert.equal(num(rows[0].files), 5, 'Ads.cs is only in k4, which has no rewarded funnel');
  assert.equal(num(rows[0].events), 6, 'three funnels: fnl_01, fnl_04, fnl_06');
});

// 13. Two complex columns of the SAME report in one pipeline: the trail exploded, the object
//     read for a segment. The trail multiplies rows; the object field does not.
test('13. an array and an object together: 20 breadcrumbs split wifi 13 / cellular 7', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'derive', name: 'network', op: 'struct_field', source: 'custom_keys_of_event_data', field: 'network' },
    { stage: 'unnest', source: 'breadcrumbs_of_event_data', as: 'crumb', type: 'string' },
    { stage: 'aggregate', group_by: ['network'], measures: [{ name: 'n', fn: 'count' }, { name: 'crashes', fn: 'count_distinct', column: 'crash_id' }] },
  );
  assert.deepEqual(mapCol(rows, 'network', 'n'), { wifi: 13, cellular: 7 });
  assert.equal(sumCol(rows, 'n'), 20);
  assert.deepEqual(mapCol(rows, 'network', 'crashes'), { wifi: 8, cellular: 5 }, 'the object field did not change the report count');
});

// ═══════════ F. guards (input validation) ═══════════

// 14. A complex op on a column that is not complex is refused, naming what the column IS —
//     rather than building array SQL over text and failing in the warehouse.
test('14. complex ops on a scalar column are refused with what it actually is', opts, async (t) => {
  if (skip(t)) return;
  await assert.rejects(
    () => step({ stage: 'unnest', source: 'issue_title_of_event_data', as: 'x' }),
    /unnest: 'issue_title_of_event_data' is declared as string, not an array/,
  );
  await assert.rejects(
    () => step({ stage: 'derive', name: 'x', op: 'array_length', source: 'issue_title_of_event_data' }),
    /array_length: 'issue_title_of_event_data' is declared as string, not an array/,
  );
  // the custom-keys column holds a JSON OBJECT, so an array op is wrong there too — and the
  // message points at the op that IS right for an object.
  await assert.rejects(
    () => step({ stage: 'derive', name: 'x', op: 'contains', source: 'custom_keys_of_event_data', value: 'wifi' }),
    /contains: 'custom_keys_of_event_data'.*not an array.*op=struct_field.*op=json_field/s,
  );
  // element_at needs a native array, not the raw JSON string.
  await assert.rejects(
    () => step({ stage: 'compute', name: 'x', op: 'element_at', column: 'breadcrumbs_of_event_data', index: 1 }),
    /not an array — produce an array first.*json_parse_array/s,
  );
});

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
  const model = await engine.semantic_index({ model: 'crashlytics' });
  const cols = new Set((model.columns || []).map((c) => String(c.name ?? c)));
  for (const n of ['breadcrumbs_of_event_data', 'stack_frames_of_event_data', 'custom_keys_of_event_data']) {
    assert.ok(cols.has(n), `${n} is a referenceable column (got: ${[...cols].join(', ')})`);
  }
});
