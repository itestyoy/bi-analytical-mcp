// WHEN SCHEDULED MODELS ARE COMPUTED AGAIN (src/scheduled-models.js): after a sync of the value index, once a
// UTC day, a model starting from another scheduled model after that one — and a model nobody queried for
// the idle period put to sleep instead, staying asleep until a query wakes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledModels } from '../../src/scheduled-models.js';

const DAY = 86400000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** A context manager holding these scheduled states, by id. */
function contexts(states) {
  const map = new Map(Object.entries(states).map(([id, scheduled]) => [id, { id, state: { scheduled } }]));
  return { list: () => [...map.keys()].map((context_id) => ({ context_id })), has: (id) => map.has(id), get: (id) => map.get(id), touch: () => {} };
}

function service(states, { idleDays = 7 } = {}) {
  const ctxs = contexts(states);
  const order = [];
  const done = new Set();
  const s = new ScheduledModels({
    ctxs,
    refresh: (id) => { order.push(id); return `t_${id}`; },
    awaitTasks: async (ids) => { for (const id of ids) done.add(id); },
    idleMs: idleDays * DAY,
    logger: () => {},
  });
  return { s, order, done, ctxs };
}

test('after a sync: each model not refreshed today, and none refreshed today already', async () => {
  const { s, order } = service({
    a: { refreshed_at: ago(DAY), last_queried_at: ago(0) },
    b: { refreshed_at: new Date().toISOString(), last_queried_at: ago(0) },
    c: { last_queried_at: ago(0) },
  });
  await s.afterSync();
  assert.deepEqual(order.sort(), ['a', 'c']);
});

test('a model that starts from another scheduled one refreshes after it', async () => {
  const { s, order, done } = service({
    dependent: { refreshed_at: ago(DAY), last_queried_at: ago(0), base: { context_id: 'base' } },
    base: { refreshed_at: ago(DAY), last_queried_at: ago(0) },
  });
  await s.afterSync();
  assert.deepEqual(order, ['base', 'dependent']);
  assert.ok(done.has('t_base'), 'the dependent waited for the base\'s refresh');
});

test('unqueried for the idle period: put to sleep, not refreshed, and a later sync leaves it asleep', async () => {
  const states = { idle: { refreshed_at: ago(DAY), last_queried_at: ago(8 * DAY) }, used: { refreshed_at: ago(DAY), last_queried_at: ago(6 * DAY) } };
  const { s, order } = service(states);
  await s.afterSync();
  assert.deepEqual(order, ['used']);
  assert.equal(states.idle.suspended.reason, 'unused');
  states.used.refreshed_at = new Date().toISOString(); // (the refresh the engine ran)
  states.idle.last_queried_at = ago(0); // (only a query wakes it: the engine clears `suspended` then)
  await s.afterSync();
  assert.deepEqual(order, ['used']);
});

test('idle period 0: never put to sleep', async () => {
  const states = { idle: { refreshed_at: ago(DAY), last_queried_at: ago(400 * DAY) } };
  const { s, order } = service(states, { idleDays: 0 });
  await s.afterSync();
  assert.deepEqual(order, ['idle']);
  assert.equal(states.idle.suspended, undefined);
});

test('a base read by an awake dependent is in use: it stays awake while the dependent is queried', async () => {
  const states = {
    base: { refreshed_at: ago(DAY), last_queried_at: ago(30 * DAY) },
    dependent: { refreshed_at: ago(DAY), last_queried_at: ago(0), base: { context_id: 'base' } },
  };
  const { s, order } = service(states);
  await s.afterSync();
  assert.deepEqual(order, ['base', 'dependent']);
  assert.equal(states.base.suspended, undefined);
});
