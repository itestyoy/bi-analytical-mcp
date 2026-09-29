// What a metric can be grouped by is MetricFlow's list (src/group-by-items.js): a caller names an item by
// what it is and where it lives, and MetricFlow's name for it is found there — a path (via) is asked for
// only where MetricFlow lists several.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonItems, resolveRef, refOf, tokenOf, columnOf, annotateChains } from '../../src/group-by-items.js';

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

test('an item is named by what it is and where it lives; via only where MetricFlow lists several paths to it', () => {
  const ref = (i) => refOf(spendItems[i], own, spendItems);
  assert.deepEqual(ref(0), { dimension: 'campaign' });
  assert.deepEqual(ref(1), { dimension: 'day', grain: 'day' });
  // devices.model is listed through two paths: each is named with its own
  assert.deepEqual(ref(2), { semantic_model: 'devices', dimension: 'model', via: 'device' });
  assert.deepEqual(ref(3), { semantic_model: 'devices', dimension: 'model', via: ['user', 'device'] });
  assert.deepEqual(ref(4), { entity: 'device' });
  assert.deepEqual(ref(5), { time: 'metric_time', grain: 'day' });
  // with one path listed, the same dimension needs none
  assert.deepEqual(refOf(spendItems[2], own, spendItems.filter((i) => i !== spendItems[3])), { semantic_model: 'devices', dimension: 'model' });
});

test('each reference resolves to the item MetricFlow lists for it, with MetricFlow\'s token and the caller\'s column', () => {
  const one = (ref, items = spendItems) => resolveRef(items, ref, own).item;
  assert.equal(tokenOf(one({ dimension: 'campaign' })), 'spend_row__campaign');
  assert.equal(tokenOf(one({ dimension: 'day' }), 'week'), 'spend_row__day__week');
  assert.equal(columnOf(one({ dimension: 'day' }), 'week'), 'spend_day_week');
  assert.equal(tokenOf(one({ semantic_model: 'devices', dimension: 'model', via: 'device' })), 'device__model');
  assert.equal(tokenOf(one({ semantic_model: 'devices', dimension: 'model', via: ['user', 'device'] })), 'user__device__model');
  // one path listed: MetricFlow's name for it is found without via
  assert.equal(tokenOf(one({ semantic_model: 'devices', dimension: 'model' }, spendItems.filter((i) => i !== spendItems[3]))), 'device__model');
  assert.equal(tokenOf(one({ entity: 'device' })), 'device');
});

test('what does not name one item is refused with the ways it can be named', () => {
  // a model named alone is its direct join; a path MetricFlow does not list is refused
  assert.equal(tokenOf(resolveRef(spendItems, { semantic_model: 'devices', dimension: 'model' }, own).item), 'device__model');
  assert.match(resolveRef(spendItems, { semantic_model: 'devices', dimension: 'model', via: 'user' }, own).error, /is reached as/);
  // another model's dimension named as the context's own: where it does live is said
  assert.match(resolveRef(spendItems, { dimension: 'model' }, own).error, /not a dimension of spend; it is .*semantic_model: "devices"/);
  assert.match(resolveRef(spendItems, { dimension: 'nope' }, own).error, /not a dimension this can be grouped by/);
});

test('several metrics are grouped by what MetricFlow lists for every one of them — an entity whichever model lists it', () => {
  const clicks = [
    { kind: 'dimension', name: 'campaign', dunder_name: 'spend_row__campaign', semantic_model: 'spend', entity_links: ['spend_row'], type: 'categorical' },
    { kind: 'entity', name: 'device', semantic_model: 'installs', entity_links: [] },
    { kind: 'dimension', name: 'metric_time', dunder_name: 'metric_time__day', semantic_model: null, entity_links: [], type: 'time', grain: 'day' },
  ];
  const shared = commonItems({ cost: spendItems, clicks }, ['cost', 'clicks']);
  assert.deepEqual(shared.map((i) => refOf(i, own, shared)), [{ dimension: 'campaign' }, { entity: 'device' }, { time: 'metric_time', grain: 'day' }]);
});

test('a hop of MetricFlow\'s entity path is named by the model it joins onto: a link of several joins is a chain of models, and via is left for a role', () => {
  const models = [
    { name: 'spend', entity: 'spend_row', entities: [{ name: 'user', type: 'foreign' }, { name: 'device', type: 'foreign' }] },
    { name: 'devices', entity: 'device', entities: [{ name: 'device', type: 'primary' }, { name: 'user', type: 'foreign' }] },
    { name: 'users', entity: 'user', entities: [{ name: 'user', type: 'primary' }, { name: 'buyer', type: 'unique' }, { name: 'seller', type: 'unique' }] },
  ];
  const items = [
    { kind: 'dimension', name: 'country', dunder_name: 'user__country', semantic_model: 'users', entity_links: ['user'], type: 'categorical' },
    { kind: 'dimension', name: 'country', dunder_name: 'device__user__country', semantic_model: 'users', entity_links: ['device', 'user'], type: 'categorical' },
    { kind: 'dimension', name: 'country', dunder_name: 'buyer__country', semantic_model: 'users', entity_links: ['buyer'], type: 'categorical' },
  ];
  annotateChains({ cost: items }, models);
  assert.deepEqual(items.map((i) => i.chain), [['users'], ['devices', 'users'], ['users']]);
  // the direct join and the chain are told apart by the chain; the two direct ones (a role) by via
  assert.deepEqual(items.map((i) => refOf(i, 'spend', items)), [
    { semantic_model: 'users', dimension: 'country', via: 'user' },
    { semantic_model: ['devices', 'users'], dimension: 'country' },
    { semantic_model: 'users', dimension: 'country', via: 'buyer' },
  ]);
  assert.equal(tokenOf(resolveRef(items, { semantic_model: ['devices', 'users'], dimension: 'country' }, 'spend').item), 'device__user__country');
  assert.equal(tokenOf(resolveRef(items, { semantic_model: 'users', dimension: 'country', via: 'buyer' }, 'spend').item), 'buyer__country');
  // two direct joins, no role named: MetricFlow would not choose either
  assert.match(resolveRef(items, { semantic_model: 'users', dimension: 'country' }, 'spend').error, /several ways.*via: "user".*via: "buyer"/);
});
