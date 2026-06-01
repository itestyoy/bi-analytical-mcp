import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const catalog = loadCatalog(new URL('../../config/catalog.yml', import.meta.url).pathname, { dialect: 'postgres' });
const engine = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'ab-')) }) });

test('experiments role is a joinable model with its dimensions + time columns', () => {
  assert.ok(catalog.joinableModelKeys().includes('experiments'), 'experiments is joinable');
  const dims = catalog.modelDimensionColumns('experiments');
  for (const c of ['experiment_name', 'variant_group', 'assigned_at', 'ended_at']) assert.ok(dims.includes(c), `dim ${c}`);
  assert.equal(catalog.anchor, 'events'); // unchanged: events is still the fact
});

test('ab_test proportion: control vs two variants, per-variant verdicts', () => {
  const r = engine.ab_test({
    metric: 'proportion',
    control: { label: 'control', n: 1000, conversions: 200 },
    variants: [
      { label: 'B', n: 1000, conversions: 250 }, // clearly up
      { label: 'C', n: 1000, conversions: 205 }, // ~flat
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.control, 'control');
  assert.equal(r.results.length, 2);
  const b = r.results.find((x) => x.variant === 'B');
  assert.ok(Math.abs(b.relative_lift - 0.25) < 1e-9);
  assert.equal(b.significant, true);
  const c = r.results.find((x) => x.variant === 'C');
  assert.equal(c.significant, false);
});

test('ab_test mean: Welch t-test path', () => {
  const r = engine.ab_test({
    metric: 'mean',
    control: { n: 500, mean: 10, stddev: 2 },
    variants: [{ label: 'B', n: 500, mean: 12, stddev: 2 }],
  });
  assert.equal(r.results[0].significant, true);
  assert.ok('t' in r.results[0] && 'df' in r.results[0]);
});

test('ab_test ratio: delta-method path over per-user sums', () => {
  const r = engine.ab_test({
    metric: 'ratio',
    control: { label: 'control', n: 5, sumNum: 15, sumDen: 5, sumNum2: 55, sumDen2: 5, sumNumDen: 15 },
    variants: [{ label: 'B', n: 5, sumNum: 20, sumDen: 5, sumNum2: 90, sumDen2: 5, sumNumDen: 20 }],
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.results[0].control_ratio - 3) < 1e-9 && Math.abs(r.results[0].variant_ratio - 4) < 1e-9);
});

test('ab_test correction: adjusted p-values across the variant family', () => {
  const r = engine.ab_test({
    metric: 'proportion',
    correction: 'holm',
    control: { n: 1000, conversions: 200 },
    variants: [{ label: 'B', n: 1000, conversions: 250 }, { label: 'C', n: 1000, conversions: 205 }],
  });
  assert.equal(r.correction, 'holm');
  for (const v of r.results) assert.ok('p_value_adjusted' in v && v.p_value_adjusted >= v.p_value);
});

// ── structural schema guards: each metric config rejects fields it does not use ──
test('ab_test schema: missing conversions for proportion is rejected', () => {
  assert.throws(() => engine.ab_test({ metric: 'proportion', control: { n: 100 }, variants: [{ n: 100 }] }), /invalid input/);
});

test('ab_test schema: a proportion arm cannot carry a mean field', () => {
  assert.throws(() => engine.ab_test({ metric: 'proportion', control: { n: 100, conversions: 10, mean: 1 }, variants: [{ n: 100, conversions: 12 }] }), /invalid input/);
});

test('ab_test schema: mean requires both mean and stddev', () => {
  assert.throws(() => engine.ab_test({ metric: 'mean', control: { n: 100, mean: 1 }, variants: [{ n: 100, mean: 2 }] }), /invalid input/);
});

test('ab_test schema: ratio requires all five per-user sums and a positive denominator', () => {
  assert.throws(() => engine.ab_test({ metric: 'ratio', control: { n: 5, sumNum: 1, sumDen: 1, sumNum2: 1, sumDen2: 1 }, variants: [{ n: 5, sumNum: 1, sumDen: 1, sumNum2: 1, sumDen2: 1, sumNumDen: 1 }] }), /invalid input/);
  assert.throws(() => engine.ab_test({ metric: 'ratio', control: { n: 5, sumNum: 1, sumDen: 0, sumNum2: 1, sumDen2: 1, sumNumDen: 1 }, variants: [{ n: 5, sumNum: 1, sumDen: 1, sumNum2: 1, sumDen2: 1, sumNumDen: 1 }] }), /invalid input/);
});

test('ab_test schema: a cuped arm cannot carry conversions; unknown metric is rejected', () => {
  assert.throws(() => engine.ab_test({ metric: 'cuped', control: { n: 5, sumY: 1, sumY2: 1, sumX: 1, sumX2: 1, sumXY: 1, conversions: 3 }, variants: [{ n: 5, sumY: 1, sumY2: 1, sumX: 1, sumX2: 1, sumXY: 1 }] }), /invalid input/);
  assert.throws(() => engine.ab_test({ metric: 'bogus', control: { n: 5, conversions: 1 }, variants: [{ n: 5, conversions: 1 }] }), /invalid input/);
});

test('sample_size schema: needs exactly one of mde/n and the metric-matched dispersion field', () => {
  assert.equal(engine.sample_size({ metric: 'proportion', baseline: 0.2, mde: 0.05 }).ok, true);
  assert.equal(engine.sample_size({ metric: 'mean', stddev: 5, n: 400 }).ok, true);
  assert.throws(() => engine.sample_size({ metric: 'proportion', baseline: 0.2, mde: 0.05, n: 400 }), /invalid input/); // both
  assert.throws(() => engine.sample_size({ metric: 'proportion', baseline: 0.2 }), /invalid input/); // neither
  assert.throws(() => engine.sample_size({ metric: 'proportion', stddev: 5, mde: 0.05 }), /invalid input/); // wrong dispersion field
  assert.throws(() => engine.sample_size({ metric: 'mean', mde: 1 }), /invalid input/); // missing stddev
});

test('srm_check: detects a broken split, passes a balanced one', () => {
  assert.equal(engine.srm_check({ groups: [{ label: 'a', n: 500 }, { label: 'b', n: 500 }] }).srm_detected, false);
  assert.equal(engine.srm_check({ groups: [{ label: 'a', n: 600 }, { label: 'b', n: 400 }] }).srm_detected, true);
});
