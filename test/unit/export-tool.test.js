// The export tool exists where the deployment names an export location (EXPORT_URI), and only there; its
// input is refused before anything runs (validation and lifecycle only — what it writes is proven on the
// data in test/integration/export.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { wireSchema } from '../../src/schema/transport.js';
import { tempDir } from '../helpers/temp-dir.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = (extra = {}) => new Engine({ catalog: loadCatalog(CATALOG), contextManager: new ContextManager({ workspaceRoot: tempDir('export-tool') }), ...extra });

test('export is offered only where an export location is named — schema and tool alike', () => {
  const off = engine();
  assert.equal(off.tools.has('export_result'), false);
  assert.equal(off.schemas.export_result, undefined);
  const on = engine({ exportUri: tempDir('export-to') });
  assert.equal(on.tools.has('export_result'), true);
  assert.deepEqual(wireSchema(on.schemas.export_result).required, ['request']);
  // a task it starts is read back by query_model, as every pipeline task is
  assert.equal(on.tasks.sideOf('export_result'), 'pipeline');
});

test('export takes a task id and a file name, nothing else', async () => {
  const e = engine({ exportUri: tempDir('export-to') });
  await assert.rejects(e.export_result({}), /task_id/);
  await assert.rejects(e.export_result({ task_id: 'aaaaaaaaaaaa', name: '../escape' }), /name/);
  await assert.rejects(e.export_result({ task_id: 'aaaaaaaaaaaa', format: 'xlsx' }), /format/);
  await assert.rejects(e.export_result({ task_id: 'aaaaaaaaaaaa' }), (err) => err.field === 'task_id' && /unknown task_id/.test(err.message));
});

test('the export limit is a setting of at most 1000 MB, 500 by default — one BigQuery writes as one file', async () => {
  const { setting } = await import('../../src/settings.js');
  assert.equal(setting('EXPORT_MAX_MB', { env: {} }), 500);
  assert.equal(setting('EXPORT_MAX_MB', { env: { EXPORT_MAX_MB: '200' } }), 200);
  assert.equal(setting('EXPORT_MAX_MB', { env: { EXPORT_MAX_MB: '5000' } }), 500, 'past the one-file limit: the default');
  assert.equal(setting('EXPORT_MAX_MB', { env: { EXPORT_MAX_MB: '0' } }), 500);
});

test('on BigQuery a table bigger than the limit is refused before anything is written, with its size and how to narrow it', async () => {
  const e = engine({ exportUri: 'gs://bucket/exports', exportMaxBytes: 500e6 });
  e.catalog.dialect = 'bigquery';
  const asked = [];
  e.runner = { execute: async () => assert.fail('no statement runs'), extractCsv: async (_dir, table, uri, maxBytes) => { asked.push({ table, uri, maxBytes }); return { ok: false, too_big: true, bytes: 812_345_678 }; } };
  const out = await e._exportWork({ id: 'aaaaaaaaaaaa' }, { table: 'm' }, 'per_event', 'csv');
  assert.equal(out.ok, false);
  assert.equal(out.error.stage, 'validate');
  assert.match(out.error.message, /813 MB, more than the 500 MB/);
  assert.match(out.error.message, /narrow it/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].maxBytes, 500e6, 'the limit is handed to the job, which reads the size first');
  assert.match(asked[0].uri, /^gs:\/\/bucket\/exports\/\d{4}-\d\d-\d\d-[0-9a-f]{16}\/per_event\.csv$/);
});
