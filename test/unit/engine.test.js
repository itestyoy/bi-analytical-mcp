import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));

function fakeRunner() {
  const calls = [];
  return {
    calls,
    async parse() { return { ok: true, manifest: true }; },
    async query(dir, opts) {
      calls.push(opts);
      return {
        ok: true,
        command: 'mf query (fake)',
        sql: 'SELECT 1',
        columns: [{ name: 'metric_time__day' }, { name: 'user__country' }, { name: 'lvl_econ_revenue' }],
        rows: [
          { metric_time__day: '2026-01-01', user__country: 'US', lvl_econ_revenue: '100' },
          { metric_time__day: '2026-01-02', user__country: 'US', lvl_econ_revenue: '120' },
        ],
      };
    },
  };
}

function makeEngine(runner) {
  const ctxs = new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'eng-')) });
  return new Engine({ catalog, contextManager: ctxs, runner });
}

const DECL = {
  name: 'lvl_econ',
  use_base_models: ['users', 'campaigns'],
  semantic_models: [{
    from: 'events', event_scope: { event_name: ['purchase'] },
    dimensions: [{ source: 'event_property', property: 'product_id' }],
    measures: [{ name: 'revenue', agg: 'sum', field: 'revenue' }, { name: 'payers', agg: 'count_distinct', field: 'user_id' }],
  }],
  metrics: [
    { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
    { name: 'arppu', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'payers' } },
  ],
};

test('dry_run create returns yaml and no context is created', async () => {
  const eng = makeEngine(fakeRunner());
  const out = await eng.create_semantic_model({ ...DECL, dry_run: true });
  assert.equal(out.dry_run, true);
  assert.match(out.yaml, /name: events/);
  assert.equal(eng.list_contexts().contexts.length, 0);
});

test('create allocates context, parses, lists metrics + reachable groupable', async () => {
  const eng = makeEngine(fakeRunner());
  const out = await eng.create_semantic_model(DECL);
  assert.match(out.context_id, /^[0-9a-f]{12}$/);
  assert.equal(out.parse.ok, true);
  assert.ok(out.metrics.includes('lvl_econ_arppu'));
  assert.ok(out.groupable.includes('user__campaign__channel'));
  assert.ok(out.groupable.includes('lvl_econ_product_id')); // task dim is groupable
});

test('query builds group-by tokens, validates names, returns paginated rows', async () => {
  const runner = fakeRunner();
  const eng = makeEngine(runner);
  const { context_id } = await eng.create_semantic_model(DECL);
  const res = await eng.query_semantic_model({
    context_id,
    metrics: ['lvl_econ_revenue', 'lvl_econ_arppu'],
    group_by: [{ time: 'metric_time', grain: 'day' }, 'user__country'],
    where: { op: 'and', conditions: [{ field: { kind: 'dimension', path: 'user__acquisition_type' }, op: 'eq', value: 'paid' }] },
    order_by: [{ key: 'metric_time__day', direction: 'desc' }],
    limit: 1, offset: 0,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(runner.calls[0].groupBy, ['metric_time__day', 'user__country']);
  assert.deepEqual(runner.calls[0].where, ["{{ Dimension('user__acquisition_type') }} = 'paid'"]);
  assert.deepEqual(runner.calls[0].orderBy, ['-metric_time__day']);
  assert.equal(res.rows.length, 1); // limit applied
  assert.equal(res.page.has_more, true);
});

test('query rejects unknown metric and unreachable path', async () => {
  const eng = makeEngine(fakeRunner());
  const { context_id } = await eng.create_semantic_model(DECL);
  await assert.rejects(() => eng.query_semantic_model({ context_id, metrics: ['ghost'] }), /unknown metric/);
  await assert.rejects(() => eng.query_semantic_model({ context_id, metrics: ['lvl_econ_revenue'], group_by: ['user__nonsense'] }), /not reachable/);
});

test('query dry_run returns SQL via --explain', async () => {
  const eng = makeEngine(fakeRunner());
  const { context_id } = await eng.create_semantic_model(DECL);
  const res = await eng.query_semantic_model({ context_id, metrics: ['lvl_econ_revenue'], dry_run: true });
  assert.equal(res.dry_run, true);
  assert.equal(res.sql, 'SELECT 1');
});

test('update adds a measure+metric in the same context', async () => {
  const eng = makeEngine(fakeRunner());
  const { context_id } = await eng.create_semantic_model(DECL);
  const out = await eng.update_semantic_model({
    context_id, semantic_model: 'events', task: 'lvl_econ',
    add_measures: [{ name: 'avg_rev', agg: 'average', field: 'revenue' }],
    add_metrics: [{ name: 'avg_rev_metric', type: 'simple', measure: { name: 'avg_rev' } }],
  });
  assert.ok(out.metrics.includes('lvl_econ_avg_rev_metric'));
});

test('delete cascade removes model task additions and dependent metrics', async () => {
  const eng = makeEngine(fakeRunner());
  const { context_id } = await eng.create_semantic_model(DECL);
  const out = await eng.delete_semantic_model({ context_id, semantic_model: 'events', cascade: true });
  assert.equal(out.removed, true);
  const desc = eng.describe_context({ context_id });
  assert.ok(!desc.semantic_models.includes('events'));
});

test('drop_context tears down', async () => {
  const eng = makeEngine(fakeRunner());
  const { context_id } = await eng.create_semantic_model(DECL);
  assert.equal(eng.drop_context({ context_id }).removed, true);
  assert.equal(eng.list_contexts().contexts.length, 0);
});
