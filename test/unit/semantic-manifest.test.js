// The layer a parsed semantic manifest describes (src/semantic-manifest.js): what a metric can be
// grouped by and what its time axis is, read from manifests shaped as dbt writes them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestLayer } from '../../src/semantic-manifest.js';

const dim = (name, type = 'categorical', grain) => ({ name, type, expr: name, ...(grain ? { type_params: { time_granularity: grain } } : {}) });
const simple = (name, semantic_model, agg_time_dimension) => ({ name, type: 'simple', type_params: { metric_aggregation_params: { semantic_model, agg: 'sum', agg_time_dimension }, expr: name } });

test('a semantic model addresses its dimensions through its primary entity, whatever order its entities are declared in', () => {
  const layer = manifestLayer({
    semantic_models: [{ name: 'players', entities: [{ name: 'device', type: 'unique' }, { name: 'user', type: 'primary' }], dimensions: [dim('country'), dim('seen_at', 'time', 'day')] }],
    metrics: [simple('n', 'players', 'seen_at')],
  });
  assert.equal(layer.semantic_models[0].entity, 'user');
  assert.deepEqual(layer.reach('n').map((d) => d.path).sort(), ['user__country', 'user__seen_at']);
});

test('a join reaches another semantic model through any entity it is unique on, not only the one it addresses its own dimensions by', () => {
  const layer = manifestLayer({
    semantic_models: [
      { name: 'spend', entities: [{ name: 'row', type: 'primary' }, { name: 'device', type: 'foreign' }], dimensions: [dim('day', 'time', 'day')] },
      { name: 'devices', entities: [{ name: 'owner', type: 'primary' }, { name: 'device', type: 'unique' }], dimensions: [dim('model')] },
    ],
    metrics: [simple('cost', 'spend', 'day')],
  });
  const reach = layer.reach('cost');
  assert.deepEqual(reach.find((d) => d.semantic_model === 'devices'), { semantic_model: 'devices', dimension: 'model', type: 'categorical', entity: 'device', path: 'device__model' });
});

test('a ratio or a derived metric has the time axis its inputs share, at the coarsest of their grains', () => {
  const layer = manifestLayer({
    semantic_models: [
      { name: 'a', primary_entity: 'a_row', entities: [], dimensions: [dim('d', 'time', 'day')] },
      { name: 'b', primary_entity: 'b_row', entities: [], dimensions: [dim('w', 'time', 'week')] },
      { name: 'c', primary_entity: 'c_row', entities: [], dimensions: [dim('label')] },
    ],
    metrics: [
      simple('x', 'a', 'd'), simple('y', 'b', 'w'), simple('z', 'c'),
      { name: 'x_per_y', type: 'ratio', type_params: { numerator: { name: 'x' }, denominator: { name: 'y' } } },
      { name: 'x_twice', type: 'derived', type_params: { expr: 'x + x', metrics: [{ name: 'x' }] } },
      { name: 'x_per_z', type: 'ratio', type_params: { numerator: { name: 'x' }, denominator: { name: 'z' } } },
    ],
  });
  assert.deepEqual(layer.timeAxis('x'), { dimension: 'd', grain: 'day' });
  assert.deepEqual(layer.timeAxis('x_twice'), { dimension: 'd', grain: 'day' });
  assert.deepEqual(layer.timeAxis('x_per_y'), { grain: 'week' });
  // an input with no time axis leaves the metric without one
  assert.equal(layer.timeAxis('x_per_z'), null);
});
