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
