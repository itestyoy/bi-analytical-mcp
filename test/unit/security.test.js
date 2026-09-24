import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { compileDeclaration } from '../../src/compile.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'));
const validators = makeValidators(buildSchemas(catalog));
const v = (tool, input) => validateInput(validators[tool], input);

test('a task is addressed by its id alone — no table name or path reaches a read', () => {
  for (const tool of ['query_semantic_model', 'query_pipeline_model', 'display_model_result']) {
    assert.equal(v(tool, { task_id: "x') }} ; drop table dim_users -- " }).ok, false, `${tool}: a task id is hex`);
    assert.equal(v(tool, { task_id: 'aabbccddeeff', table: 'fct_analytics_events' }).ok, false, `${tool}: no table to name`);
    assert.ok(v(tool, { task_id: 'aabbccddeeff' }).ok);
  }
  assert.equal(v('drill_result', { task_id: 'aabbccddeeff', transform: {}, table: 'qr_aabbccddeeff' }).ok, false);
});
test('context_id is pattern-constrained (no path traversal) on all context tools', () => {
  for (const tool of ['query_semantic_model', 'drop_context', 'describe_context']) {
    const base = tool === 'query_semantic_model' ? { metrics: ['m'] } : {};
    assert.equal(v(tool, { ...base, context_id: '../../../etc/passwd' }).ok, false, `${tool} should reject traversal`);
    assert.equal(v(tool, { ...base, context_id: 'a/b' }).ok, false, `${tool} should reject slashes`);
  }
});

test('derived metric expr is restricted to a safe arithmetic grammar', () => {
  assert.throws(() => compileDeclaration(catalog, {
    name: 'evil',
    semantic_models: [{ from: 'events', measures: [{ name: 'r', agg: 'sum', field: 'price_in_usd_of_event_data' }] }],
    metrics: [
      { name: 'r', type: 'simple', measure: { name: 'r' } },
      { name: 'bad', type: 'derived', expr: "r) as x, (select 1 from creds--", metrics: [{ name: 'r' }] },
    ],
  }), /unknown identifier|illegal characters/);
});
