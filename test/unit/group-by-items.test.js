// What a metric can be grouped by is MetricFlow's list (src/group-by-items.js): a reference names one
// item of it exactly, or is refused naming what there is — nothing is chosen for the caller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonItems, resolveRef, refOf, tokenOf, columnOf } from '../../src/group-by-items.js';

// what MetricFlow lists for a spend metric: its own dimensions, a device model's two ways (a path of
// one join, and of two), an entity, and the time axis
const own = 'spend';
const spendItems = [
  { kind: 'dimension', name: 'campaign', dunder_name: 'spend_row__campaign', semantic_model: 'spend', entity_links: ['spend_row'], type: 'categorical' },
  { kind: 'dimension', name: 'day', dunder_name: 'spend_row__day', semantic_model: 'spend', entity_links: ['spend_row'], type: 'time', grain: 'day' },
  { kind: 'dimension', name: 'model', dunder_name: 'device__model', semantic_model: 'devices', entity_links: ['device'], type: 'categorical' },
  { kind: 'dimension', name: 'model', dunder_name: 'user__device__model', semantic_model: 'devices', entity_links: ['user', 'device'], type: 'categorical' },
  { kind: 'entity', name: 'device', semantic_model: 'spend', entity_links: [] },
  { kind: 'dimension', name: 'metric_time', dunder_name: 'metric_time__day', semantic_model: null, entity_links: [], type: 'time', grain: 'day' },
];

test('a dimension of the context\'s own model is { dimension }; any other names its semantic model and the entity path to it', () => {
  assert.deepEqual(refOf(spendItems[0], own), { dimension: 'campaign' });
  assert.deepEqual(refOf(spendItems[1], own), { dimension: 'day', grain: 'day' });
  assert.deepEqual(refOf(spendItems[2], own), { semantic_model: 'devices', dimension: 'model', via: 'device' });
  assert.deepEqual(refOf(spendItems[3], own), { semantic_model: 'devices', dimension: 'model', via: ['user', 'device'] });
  assert.deepEqual(refOf(spendItems[4], own), { entity: 'device' });
  assert.deepEqual(refOf(spendItems[5], own), { time: 'metric_time', grain: 'day' });
});

test('each reference resolves to exactly the item it names, and to MetricFlow\'s token and the caller\'s column', () => {
  const one = (ref) => resolveRef(spendItems, ref, own).item;
  assert.equal(tokenOf(one({ dimension: 'campaign' })), 'spend_row__campaign');
  assert.equal(tokenOf(one({ dimension: 'day' }), 'week'), 'spend_row__day__week');
  assert.equal(columnOf(one({ dimension: 'day' }), 'week'), 'spend_day_week');
  assert.equal(tokenOf(one({ semantic_model: 'devices', dimension: 'model', via: 'device' })), 'device__model');
  assert.equal(tokenOf(one({ semantic_model: 'devices', dimension: 'model', via: ['user', 'device'] })), 'user__device__model');
  assert.equal(tokenOf(one({ entity: 'device' })), 'device');
});

test('what does not name one item is refused with the ways it can be named — no path is chosen for the caller', () => {
  // another model's dimension without the path to it
  assert.match(resolveRef(spendItems, { semantic_model: 'devices', dimension: 'model' }, own).error, /via: "device".*via: \["user","device"\]/);
  // a path MetricFlow does not list
  assert.match(resolveRef(spendItems, { semantic_model: 'devices', dimension: 'model', via: 'user' }, own).error, /named/);
  // a dimension of another model named as if it were the context's own
  assert.match(resolveRef(spendItems, { dimension: 'model' }, own).error, /semantic_model: "devices"/);
  assert.match(resolveRef(spendItems, { dimension: 'nope' }, own).error, /not a dimension this can be grouped by/);
});

test('several metrics are grouped by what MetricFlow lists for every one of them — an entity whichever model lists it', () => {
  const clicks = [
    { kind: 'dimension', name: 'campaign', dunder_name: 'spend_row__campaign', semantic_model: 'spend', entity_links: ['spend_row'], type: 'categorical' },
    { kind: 'entity', name: 'device', semantic_model: 'installs', entity_links: [] },
    { kind: 'dimension', name: 'metric_time', dunder_name: 'metric_time__day', semantic_model: null, entity_links: [], type: 'time', grain: 'day' },
  ];
  const shared = commonItems({ cost: spendItems, clicks }, ['cost', 'clicks']);
  assert.deepEqual(shared.map((i) => refOf(i, own)), [{ dimension: 'campaign' }, { entity: 'device' }, { time: 'metric_time', grain: 'day' }]);
});
