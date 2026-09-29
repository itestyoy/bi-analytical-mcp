// What a metric can be grouped by is MetricFlow's list (src/group-by-items.js): a caller names an item by
// what it is and where it lives — the chain of semantic models it is reached through — and MetricFlow's
// name for it is found there. A join no chain of models could name is not served, and says how to declare it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonItems, resolveRef, refOf, tokenOf, columnOf, annotateChains, servable } from '../../src/group-by-items.js';

// what MetricFlow lists for a spend metric: its own dimensions, a device model's dimension, an entity,
// and the time axis
const spendItems = [
  { kind: 'dimension', name: 'campaign', dunder_name: 'spend_row__campaign', semantic_model: 'spend', entity_links: ['spend_row'], type: 'categorical' },
  { kind: 'dimension', name: 'day', dunder_name: 'spend_row__day', semantic_model: 'spend', entity_links: ['spend_row'], type: 'time', grain: 'day' },
  { kind: 'dimension', name: 'model', dunder_name: 'device__model', semantic_model: 'devices', entity_links: ['device'], type: 'categorical' },
  { kind: 'entity', name: 'device', semantic_model: 'spend', entity_links: [] },
  { kind: 'dimension', name: 'metric_time', dunder_name: 'metric_time__day', semantic_model: null, entity_links: [], type: 'time', grain: 'day' },
];

test('an item is named by what it is and where it lives: the chain of models, one model for its own or a direct join', () => {
  assert.deepEqual(spendItems.map((i) => refOf(i)), [
    { semantic_model: ['spend'], dimension: 'campaign' },
    { semantic_model: ['spend'], dimension: 'day', grain: 'day' },
    { semantic_model: ['devices'], dimension: 'model' },
    { entity: 'device' },
    { time: 'metric_time', grain: 'day' },
  ]);
});

test('each reference resolves to the item MetricFlow lists for it, with MetricFlow\'s token and the caller\'s column', () => {
  const one = (ref) => resolveRef(spendItems, ref).item;
  assert.equal(tokenOf(one({ semantic_model: ['spend'], dimension: 'campaign' })), 'spend_row__campaign');
  assert.equal(tokenOf(one({ semantic_model: ['spend'], dimension: 'day' }), 'week'), 'spend_row__day__week');
  assert.equal(columnOf(one({ semantic_model: ['spend'], dimension: 'day' }), 'week'), 'spend_day_week');
  assert.equal(tokenOf(one({ semantic_model: ['devices'], dimension: 'model' })), 'device__model');
  assert.equal(tokenOf(one({ entity: 'device' })), 'device');
});

test('what does not name one item is refused with the ways it can be named', () => {
  // another model's dimension named as the context's own: where it does live is said
  assert.match(resolveRef(spendItems, { semantic_model: ['spend'], dimension: 'model' }).error, /not a dimension of spend; it is .*semantic_model: \["devices"\]/);
  assert.match(resolveRef(spendItems, { semantic_model: ['spend'], dimension: 'nope' }).error, /not a dimension this can be grouped by/);
});

test('several metrics are grouped by what MetricFlow lists for every one of them — an entity whichever model lists it', () => {
  const clicks = [
    { kind: 'dimension', name: 'campaign', dunder_name: 'spend_row__campaign', semantic_model: 'spend', entity_links: ['spend_row'], type: 'categorical' },
    { kind: 'entity', name: 'device', semantic_model: 'installs', entity_links: [] },
    { kind: 'dimension', name: 'metric_time', dunder_name: 'metric_time__day', semantic_model: null, entity_links: [], type: 'time', grain: 'day' },
  ];
  const shared = commonItems({ cost: spendItems, clicks }, ['cost', 'clicks']);
  assert.deepEqual(shared.map((i) => refOf(i)), [{ semantic_model: ['spend'], dimension: 'campaign' }, { entity: 'device' }, { time: 'metric_time', grain: 'day' }]);
});

const models = [
  { name: 'spend', entity: 'spend_row', entities: [{ name: 'user', type: 'foreign' }, { name: 'buyer', type: 'foreign' }, { name: 'device', type: 'foreign' }] },
  { name: 'devices', entity: 'device', entities: [{ name: 'device', type: 'primary' }, { name: 'user', type: 'foreign' }] },
  { name: 'users', entity: 'user', entities: [{ name: 'user', type: 'primary' }, { name: 'buyer', type: 'unique' }] },
];

test('a hop of MetricFlow\'s entity path is named by the model it joins onto: a link of several joins is a chain of models', () => {
  const items = [
    { kind: 'dimension', name: 'country', dunder_name: 'user__country', semantic_model: 'users', entity_links: ['user'], type: 'categorical' },
    { kind: 'dimension', name: 'country', dunder_name: 'device__user__country', semantic_model: 'users', entity_links: ['device', 'user'], type: 'categorical' },
  ];
  const { groupBys, blocked } = servable(annotateChains({ cost: items }, models));
  assert.deepEqual(blocked, []);
  assert.deepEqual(groupBys.cost.map((i) => refOf(i)), [
    { semantic_model: ['users'], dimension: 'country' },
    { semantic_model: ['devices', 'users'], dimension: 'country' },
  ]);
  assert.equal(tokenOf(resolveRef(groupBys.cost, { semantic_model: ['devices', 'users'], dimension: 'country' }).item), 'device__user__country');
  assert.equal(tokenOf(resolveRef(groupBys.cost, { semantic_model: ['users'], dimension: 'country' }).item), 'user__country');
});

test('a model joined onto through several keys (a role) is not served: left out, and refused saying how to declare it', () => {
  const items = () => [
    { kind: 'dimension', name: 'country', dunder_name: 'user__country', semantic_model: 'users', entity_links: ['user'], type: 'categorical' },
    { kind: 'dimension', name: 'country', dunder_name: 'buyer__country', semantic_model: 'users', entity_links: ['buyer'], type: 'categorical' },
    { kind: 'dimension', name: 'model', dunder_name: 'device__model', semantic_model: 'devices', entity_links: ['device'], type: 'categorical' },
  ];
  const { groupBys, blocked } = servable(annotateChains({ cost: items(), clicks: items() }, models), { users: 'dim_users' });
  // the role's dimensions are out of every metric's list; the rest is served
  assert.deepEqual(groupBys.cost.map((i) => refOf(i)), [{ semantic_model: ['devices'], dimension: 'model' }]);
  // reported once, for every metric it concerns, with the keys and the dbt model to build each role over
  assert.equal(blocked.length, 1);
  assert.deepEqual({ ...blocked[0], message: undefined, fix: undefined }, { semantic_model: 'users', keys: ['buyer', 'user'], dimensions: ['users.country'], metrics: ['clicks', 'cost'], message: undefined, fix: undefined });
  const r = resolveRef(groupBys.cost, { semantic_model: ['users'], dimension: 'country' }, 'cost', blocked);
  assert.match(r.error, /'users' is joined onto through several keys \('buyer', 'user'\).*not served.*one semantic model per key.*ref\('dim_users'\)/);
});

test('a hop that lands on no single model is not served, and says which key to keep unique where', () => {
  const two = [...models, { name: 'devices_v2', entity: 'device_v2', entities: [{ name: 'device', type: 'unique' }, { name: 'user', type: 'foreign' }] }];
  const items = [{ kind: 'dimension', name: 'country', dunder_name: 'device__user__country', semantic_model: 'users', entity_links: ['device', 'user'], type: 'categorical' }];
  const { groupBys, blocked } = servable(annotateChains({ cost: items }, two));
  assert.deepEqual(groupBys.cost, []);
  assert.deepEqual(blocked[0].semantic_model, ['devices', 'devices_v2']);
  assert.match(resolveRef(groupBys.cost, { semantic_model: ['devices', 'users'], dimension: 'country' }, 'cost', blocked).error, /key 'device'.*'devices', 'devices_v2'.*not served.*keep 'device' primary or unique in one/);
});
