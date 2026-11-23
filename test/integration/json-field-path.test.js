// A NESTED FIELD OF A JSON ELEMENT, READ BY ITS PATH: json_field, an unnest's `field` and { property, field }
// take a key, or keys joined by '.' — additional_info.arrow reads the arrow inside the element's
// additional_info object, where a top-level read of additional_info gives no text (JSON_VALUE of an object
// is NULL). The shape is a game's action log: each element an action, its position on the board in a
// nested object. Here the crash source's stack frames carry it: rows are added to the fixture warehouse with
// frames { file, action_type, additional_info: { arrow, cell } }, and the custom keys with a nested object.
//
// DATA ONLY: every expectation is the warehouse's own count, read with SQL written here.

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

const BASE = fixtureProject('dbt_project');
const CATALOG = join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml');
const opts = { timeout: 600000 };
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };
let wh; let engine; let backend; let seq = 0;

// four reports with an action log in their frames: wrong taps on arrows up / left, one on the right; the
// custom keys with a nested object on two of them
const LOGS = [
  ['[{"file":"a","action_type":"wrong_tap","additional_info":{"arrow":"up","cell":3}},{"file":"b","action_type":"tap","additional_info":{"arrow":"up","cell":4}},{"file":"c","action_type":"wrong_tap","additional_info":{"arrow":"left","cell":7}}]', '{"level":"5","meta":{"source":"ad","assist":"hint"}}'],
  ['[{"file":"a","action_type":"wrong_tap","additional_info":{"arrow":"up","cell":3}},{"file":"d","action_type":"wrong_tap","additional_info":{"arrow":"up","cell":9}}]', '{"level":"6","meta":{"source":"coins"}}'],
  ['[{"file":"e","action_type":"wrong_tap","additional_info":{"arrow":"right","cell":1}},{"file":"f","action_type":"tap"}]', '{"level":"7"}'],
  ['[{"file":"g","action_type":"tap","additional_info":{"arrow":"left","cell":2}}]', '{"level":"8","meta":{"source":"ad"}}'],
];

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  const rows = LOGS.map(([frames, keys], i) => `SELECT * REPLACE ('${frames}' AS stack_frames_of_event_data, '${keys}' AS custom_keys_of_event_data, 'path_${i}' AS crash_id) FROM (SELECT * FROM fct_crashlytics_events WHERE event_name = 'fatal_crash' ORDER BY event_time LIMIT 1)`);
  await wh.exec(`INSERT INTO fct_crashlytics_events ${rows.join(' UNION ALL ')}`);
  backend = testDbt({ profilesDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('jfp'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog: loadCatalog(CATALOG, { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close?.(); try { engine?.close(); } catch { /* noop */ } if (wh) await wh.stop(); });

/** Build and materialize a pipeline over the crash source; its rows. */
async function pipeRows(...steps) {
  const s = await engine.build_model({ action: 'start', name: `jfp_${seq++}`, description: 'what the test computes', question: 'what the test asks', source: 'crashlytics' });
  const r = await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps });
  assert.ok(!r.error, JSON.stringify(r.error));
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return c.rows;
}

const counts = (rows, key, val = 'n') => Object.fromEntries(rows.map((r) => [String(r[key]), Number(r[val])]));

/** The warehouse's wrong taps per arrow, read with its own JSON functions. */
async function truthWrongTaps() {
  const { rows } = await wh.query(`SELECT json_extract_string(e, '$.additional_info.arrow') AS arrow, count(*) AS n FROM fct_crashlytics_events, unnest(json_extract(stack_frames_of_event_data, '$[*]')) AS t(e) WHERE json_valid(stack_frames_of_event_data) AND json_extract_string(e, '$.action_type') = 'wrong_tap' AND json_extract_string(e, '$.additional_info.arrow') IS NOT NULL GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [String(r.arrow), Number(r.n)]));
}

test('wrong taps per arrow: unnest the log, json_field of the action and of additional_info.arrow, aggregate', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', expr: { property: 'stack_frames_of_event_data' }, name: 'action' },
    { stage: 'compute', name: 'action_type', expr: { fn: 'json_field', args: [{ column: 'action' }], field: 'action_type' } },
    { stage: 'compute', name: 'arrow', expr: { fn: 'json_field', args: [{ column: 'action' }], field: 'additional_info.arrow' } },
    { stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'action_type' }, { value: 'wrong_tap' }] }, { fn: 'is_not_null', args: [{ column: 'arrow' }] }] },
    { stage: 'aggregate', group_by: ['arrow'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
  );
  const truth = await truthWrongTaps();
  assert.deepEqual(truth, { up: 3, left: 1, right: 1 }, 'the fixture holds the taps added above');
  assert.deepEqual(counts(rows, 'arrow'), truth);
});

test('an unnest\'s field reads the nested key straight off each element', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'unnest', expr: { property: 'stack_frames_of_event_data' }, name: 'cell', field: 'additional_info.cell' },
    { stage: 'where', conditions: [{ fn: 'is_not_null', args: [{ column: 'cell' }] }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'cells', expr: { fn: 'sum', args: [{ fn: 'cast', args: [{ column: 'cell' }], type: 'int' }] } }] },
  );
  const { rows: tr } = await wh.query(`SELECT count(*) AS n, sum(CAST(json_extract_string(e, '$.additional_info.cell') AS INTEGER)) AS cells FROM fct_crashlytics_events, unnest(json_extract(stack_frames_of_event_data, '$[*]')) AS t(e) WHERE json_valid(stack_frames_of_event_data) AND json_extract_string(e, '$.additional_info.cell') IS NOT NULL`);
  assert.equal(Number(rows[0].n), Number(tr[0].n));
  assert.equal(Number(rows[0].cells), Number(tr[0].cells));
});

test('{ property, field } reads a nested key of a JSON object property', opts, async (t) => {
  if (skip(t)) return;
  const rows = await pipeRows(
    { stage: 'compute', name: 'src', expr: { property: 'custom_keys_of_event_data', field: 'meta.source' } },
    { stage: 'where', conditions: [{ fn: 'is_not_null', args: [{ column: 'src' }] }] },
    { stage: 'aggregate', group_by: ['src'], measures: [{ name: 'n', expr: { fn: 'count' } }] },
  );
  const { rows: tr } = await wh.query(`SELECT json_extract_string(custom_keys_of_event_data, '$.meta.source') AS src, count(*) AS n FROM fct_crashlytics_events WHERE json_valid(custom_keys_of_event_data) AND json_extract_string(custom_keys_of_event_data, '$.meta.source') IS NOT NULL GROUP BY 1`);
  assert.deepEqual(counts(rows, 'src'), Object.fromEntries(tr.map((r) => [String(r.src), Number(r.n)])));
  assert.deepEqual(counts(rows, 'src'), { ad: 2, coins: 1 });
});

test('a path is keys joined by single dots, each a plain name: anything else is refused', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_model({ action: 'start', name: `jfp_${seq++}`, description: 'what the test computes', question: 'what the test asks', source: 'crashlytics' });
  for (const field of ['additional_info..arrow', '.arrow', "arrow') OR 1=1 --", 'additional info']) {
    await assert.rejects(
      Promise.resolve().then(() => engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'unnest', expr: { property: 'stack_frames_of_event_data' }, name: 'x', field }] })),
      /field/i, field,
    );
  }
});
