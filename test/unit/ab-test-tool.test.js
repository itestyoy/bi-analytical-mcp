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

test('ab_test validation: missing conversions for proportion is rejected', () => {
  assert.throws(() => engine.ab_test({ metric: 'proportion', control: { n: 100 }, variants: [{ n: 100 }] }), /missing 'conversions'/);
});
