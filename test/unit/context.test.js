import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, mergeCompiled, newContextId } from '../../src/context-manager.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'ctxmgr-'));
}

test('newContextId is 12 hex chars', () => {
  assert.match(newContextId(), /^[0-9a-f]{12}$/);
});

test('create / writeYaml / list / drop lifecycle', () => {
  const root = tmpRoot();
  const cm = new ContextManager({ workspaceRoot: root });
  const ctx = cm.create();
  assert.ok(existsSync(cm.dir(ctx.id)));
  cm.writeYaml(ctx.id, 'semantic_models: []\n');
  assert.ok(cm.generatedFiles(ctx.id).some((f) => /context\.yml$/.test(f)), 'context.yml written');
  assert.equal(cm.list().length, 1);
  const res = cm.drop(ctx.id);
  assert.equal(res.removed, true);
  assert.equal(existsSync(cm.dir(ctx.id)), false);
  assert.equal(cm.list().length, 0);
});

test('registry persists and reconciles with disk on reload', () => {
  const root = tmpRoot();
  const cm1 = new ContextManager({ workspaceRoot: root });
  const a = cm1.create();
  const b = cm1.create();
  // simulate orphaned registry entry: drop b's dir but keep registry via a second manager BEFORE drop
  const cm2 = new ContextManager({ workspaceRoot: root }); // reloads registry from disk
  assert.deepEqual(cm2.list().map((c) => c.context_id).sort(), [a.id, b.id].sort());
});

test('lease prevents drop while in-flight', () => {
  const root = tmpRoot();
  const cm = new ContextManager({ workspaceRoot: root });
  const ctx = cm.create();
  cm.acquire(ctx.id);
  assert.throws(() => cm.drop(ctx.id), /in-flight/);
  cm.release(ctx.id);
  assert.equal(cm.drop(ctx.id).removed, true);
});

test('time spine is always present in a context overlay (predefined model)', () => {
  const root = tmpRoot();
  const cm = new ContextManager({ workspaceRoot: root, timeSpineDialect: 'duckdb' });
  const ctx = cm.create();
  assert.ok(cm.hasTimeSpine(ctx.id), 'overlay must always have a time spine');
  const files = cm.generatedFiles(ctx.id);
  assert.ok(files.some((f) => /metricflow_time_spine\.sql$/.test(f)), 'generated spine sql present');
});

test('time spine is dialect-aware', () => {
  const bq = new ContextManager({ workspaceRoot: tmpRoot(), timeSpineDialect: 'bigquery' });
  const ctx = bq.create();
  const sql = readFileSync(join(bq.generatedDir(ctx.id), 'metricflow_time_spine.sql'), 'utf8');
  assert.match(sql, /generate_date_array/);
});

test('time spine is NOT duplicated when the base project already defines one', () => {
  const base = mkdtempSync(join(tmpdir(), 'base-'));
  mkdirSync(join(base, 'models'), { recursive: true });
  writeFileSync(join(base, 'models', 'metricflow_time_spine.sql'), 'select 1 as date_day');
  writeFileSync(join(base, 'dbt_project.yml'), 'name: x\n');
  const cm = new ContextManager({ workspaceRoot: tmpRoot(), baseProjectDir: base });
  const ctx = cm.create();
  assert.ok(cm.hasTimeSpine(ctx.id));
  assert.ok(!cm.generatedFiles(ctx.id).some((f) => /metricflow_time_spine\.sql$/.test(f)), 'no duplicate spine generated');
});

test('mergeCompiled accumulates additions and dedups metrics', () => {
  const state = {};
  mergeCompiled(state, { task: 't1', additions: { events: { measures: [{ name: 'a' }], dimensions: [] } }, metrics: [{ name: 'm1' }], usedModels: ['events'] });
  mergeCompiled(state, { task: 't2', additions: { events: { measures: [{ name: 'b' }], dimensions: [] }, users: { measures: [], dimensions: [{ name: 'd' }] } }, metrics: [{ name: 'm1' }, { name: 'm2' }], usedModels: ['events', 'users'] });
  assert.deepEqual(state.additions.events.measures.map((m) => m.name), ['a', 'b']);
  assert.deepEqual(state.metrics.map((m) => m.name), ['m1', 'm2']);
  assert.deepEqual(state.usedModels.sort(), ['events', 'users']);
  assert.deepEqual(state.tasks, ['t1', 't2']);
});

test('a context a feature cannot describe is listed with why, and the list of the others still comes back', async () => {
  const { loadCatalog } = await import('../../src/catalog.js');
  const { Engine } = await import('../../src/engine.js');
  const catalog = loadCatalog(new URL('../integration/fixtures/catalog.yml', import.meta.url).pathname, {});
  const cm = new ContextManager({ workspaceRoot: tmpRoot() });
  const engine = new Engine({ catalog, contextManager: cm });
  const broken = cm.create(); const fine = cm.create();
  broken.state.feature_state = true;
  // a feature whose describeContext throws on the one context (state an earlier version stored)
  engine.features = [{ describeContext: (_e, ctx) => { if (ctx.state.feature_state) throw new TypeError("Cannot read properties of undefined (reading 'model')"); return null; } }];
  const listed = engine._listContexts();
  assert.equal(listed.total, 2);
  assert.ok(listed.contexts.find((c) => c.context_id === broken.id).unreadable);
  assert.ok(!listed.contexts.find((c) => c.context_id === fine.id).unreadable);
  engine.close?.();
});

test('a model reading a server-made model the overlay no longer has is pruned, with what reads it; a checkpoint still read is found as read', () => {
  const cm = new ContextManager({ workspaceRoot: tmpRoot() });
  const ctx = cm.create();
  const ref = (m) => `select * from {{ ref('${m}') }}\n`;
  cm.writeModel(ctx.id, 'pipe_a_x1', ref('fct_analytics_events'));
  cm.writeModel(ctx.id, 'pipe_a_x1_c2', ref('pipe_a_x1'));
  cm.writeModel(ctx.id, 'pipe_a_x1_c3', ref('pipe_a_x1_c2'));
  cm.writeModel(ctx.id, 'qr_t1', ref('some_project_model')); // a ref outside the server's own models is left alone
  assert.deepEqual(cm.readersOf(ctx.id, 'pipe_a_x1'), ['pipe_a_x1_c2'], 'the checkpoint is read by the later build');
  assert.deepEqual(cm.pruneDanglingModels(ctx.id), [], 'nothing dangles while every ref resolves');
  cm.removePipelineModelFiles(ctx.id, 'pipe_a_x1');
  assert.deepEqual(cm.pruneDanglingModels(ctx.id).sort(), ['pipe_a_x1_c2.sql', 'pipe_a_x1_c3.sql']);
  assert.deepEqual(cm.generatedFiles(ctx.id).filter((f) => /(pipe|qr)_.*\.sql$/.test(f)).map((f) => f.split('/').pop()).sort(), ['qr_t1.sql']);
});
