import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { formatDbtError } from '../../src/dbt-runner.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));
const fakeRunner = { async parse() { return { ok: true, manifest: true }; }, async query() { return { ok: true, columns: [], rows: [] }; } };
const makeEngine = () => new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'err-')) }), runner: fakeRunner });
const ESC = String.fromCharCode(27);

test('formatDbtError strips ANSI + log timestamps and surfaces the marker', () => {
  const stdout = [
    `${ESC}[0m16:21:43  Running with dbt=1.11.11`,
    `${ESC}[0m16:21:43  Encountered an error:`,
    'Parsing Error',
    '  Invalid name `lvl_econ__revenue` - cannot contain dunders',
  ].join('\n');
  const msg = formatDbtError(stdout, '');
  assert.ok(!msg.includes(ESC) && !msg.includes('[0m'), `no ANSI escapes: ${JSON.stringify(msg)}`);
  assert.ok(!/\d{2}:\d{2}:\d{2}/.test(msg), 'no timestamps');
  assert.ok(msg.startsWith('Encountered an error'), `surfaces marker: ${msg}`);
  assert.ok(msg.includes('Parsing Error') && msg.includes('dunders'));
});

test('formatDbtError surfaces Database Error from mf stdout', () => {
  const stdout = 'Initiating query...\nERROR: Database Error\n  column customers_src.customer does not exist';
  const msg = formatDbtError(stdout, '');
  assert.ok(msg.includes('Database Error'));
  assert.ok(msg.includes('does not exist'));
});

test('compile errors are returned with stage "compile" and name the bad reference', async () => {
  const eng = makeEngine();
  await assert.rejects(
    () => eng.create_semantic_model({
      name: 'bad', semantic_models: [{ from: 'events', measures: [{ name: 'r', agg: 'sum', field: 'revenue' }] }],
      metrics: [{ name: 'm', type: 'simple', measure: { name: 'ghost_measure' } }],
    }),
    (e) => { assert.equal(e.stage, 'compile'); assert.match(e.message, /ghost_measure/); return true; },
  );
});

test('query gives an actionable error when a path needs an unloaded model', async () => {
  const eng = makeEngine();
  const out = await eng.create_semantic_model({
    name: 'nousers', semantic_models: [{ from: 'events', event_scope: { event_name: ['purchase'] }, measures: [{ name: 'revenue', agg: 'sum', field: 'revenue' }] }],
    metrics: [{ name: 'revenue', type: 'simple', measure: { name: 'revenue' } }],
  });
  await assert.rejects(
    () => eng.query_semantic_model({ context_id: out.context_id, metrics: ['nousers_revenue'], group_by: ['user__country'] }),
    (e) => { assert.equal(e.stage, 'validate'); assert.match(e.message, /use_base_models/); assert.match(e.message, /users/); return true; },
  );
});

test('query gives a clear error for an unknown metric', async () => {
  const eng = makeEngine();
  const out = await eng.create_semantic_model({
    name: 'task1', semantic_models: [{ from: 'events', measures: [{ name: 'c', agg: 'count', field: '*' }] }],
    metrics: [{ name: 'c', type: 'simple', measure: { name: 'c' } }],
  });
  await assert.rejects(
    () => eng.query_semantic_model({ context_id: out.context_id, metrics: ['does_not_exist'] }),
    (e) => { assert.equal(e.stage, 'validate'); assert.match(e.message, /does_not_exist/); return true; },
  );
});
