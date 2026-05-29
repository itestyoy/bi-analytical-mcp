import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadCatalog } from '../../src/catalog.js';
import { compileDeclaration } from '../../src/compile.js';
import { renderContext } from '../../src/yaml-render.js';
import { mergeCompiled } from '../../src/context-manager.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.json'));

const DECL = {
  name: 'lvl_econ',
  use_base_models: ['users', 'campaigns'],
  semantic_models: [{
    from: 'events',
    event_scope: { event_name: ['iap_purchase_completed'] },
    dimensions: [{ source: 'event_property', property: 'product_id' }, { source: 'event_property', property: 'level_id' }],
    measures: [
      { name: 'revenue', agg: 'sum', field: 'price_in_usd' },
      { name: 'payers', agg: 'count_distinct', field: 'appsflyer_id' },
      { name: 'purchases', agg: 'count', field: '*' },
    ],
  }],
  metrics: [
    { name: 'revenue', type: 'simple', measure: { name: 'revenue' } },
    { name: 'arppu', type: 'ratio', numerator: { name: 'revenue' }, denominator: { name: 'payers' } },
  ],
};

test('compile namespaces measures and bakes event scope into expr (M3)', () => {
  const c = compileDeclaration(catalog, DECL);
  const evMeasures = c.additions.events.measures;
  const rev = evMeasures.find((m) => m.name === 'lvl_econ_revenue');
  assert.equal(rev.agg, 'sum');
  assert.match(rev.expr, /CASE WHEN event_name = 'iap_purchase_completed' THEN \(event_data->>'price_in_usd'\)::numeric END/);
  const payers = evMeasures.find((m) => m.name === 'lvl_econ_payers');
  assert.match(payers.expr, /CASE WHEN event_name = 'iap_purchase_completed' THEN appsflyer_id END/);
  const purch = evMeasures.find((m) => m.name === 'lvl_econ_purchases');
  assert.equal(purch.agg, 'sum');
  assert.match(purch.expr, /CASE WHEN event_name = 'iap_purchase_completed' THEN 1 ELSE 0 END/);
});

test('ratio auto-creates simple metrics referencing metrics (agent-2 fix)', () => {
  const c = compileDeclaration(catalog, DECL);
  const names = c.metrics.map((m) => m.name);
  assert.ok(names.includes('lvl_econ_revenue'));
  assert.ok(names.includes('lvl_econ_payers')); // auto simple for ratio denominator
  const ratio = c.metrics.find((m) => m.type === 'ratio');
  assert.equal(ratio.type_params.numerator.name, 'lvl_econ_revenue');
  assert.equal(ratio.type_params.denominator.name, 'lvl_econ_payers');
});

test('renders exactly one semantic model per table (C3) and valid YAML', () => {
  const c = compileDeclaration(catalog, DECL);
  const state = {};
  mergeCompiled(state, c);
  const render = renderContext(catalog, state);
  const doc = yaml.load(render.yaml);
  const names = doc.semantic_models.map((s) => s.name).sort();
  assert.deepEqual(names, ['campaigns', 'events', 'users']);
  // events SM is single and carries task measures
  const events = doc.semantic_models.filter((s) => s.name === 'events');
  assert.equal(events.length, 1);
  assert.ok(events[0].measures.some((m) => m.name === 'lvl_econ_revenue'));
  assert.equal(events[0].model, "ref('fct_analytics_events')");
});

test('forbids time dimensions from JSON properties (m2)', () => {
  assert.throws(() => compileDeclaration(catalog, {
    name: 'tsk', semantic_models: [{ from: 'events', dimensions: [{ source: 'event_property', property: 'level_id', as_type: 'time' }] }], metrics: [],
  }), /not allowed/);
});

test('rejects metric referencing unknown measure', () => {
  assert.throws(() => compileDeclaration(catalog, {
    name: 'tsk', semantic_models: [{ from: 'events', measures: [{ name: 'r', agg: 'sum', field: 'price_in_usd' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'nonexistent' } }],
  }), /unknown measure/);
});

test('base measure (users_count) is referenceable from a metric', () => {
  const c = compileDeclaration(catalog, {
    name: 'ua', use_base_models: ['users'],
    metrics: [{ name: 'users', type: 'simple', measure: { name: 'users_count' } }],
  });
  const m = c.metrics.find((x) => x.name === 'ua_users');
  assert.equal(m.type_params.measure.name, 'users_count');
});
