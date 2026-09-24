// TASKS — a call that outlives its request, polled by the host instead of by the model.
//
// The Tasks extension (io.modelcontextprotocol/tasks, SEP-2663, protocol 2026-07-28): the SERVER
// decides — for a client that declared the extension, a call that has not finished within its
// inline window comes back as a task (`resultType: "task"`); tasks/get returns the result inline;
// tasks/cancel is an ack; a client that did not declare it never gets a task and is refused
// tasks/*. And what a protocol task means for the engine's own tasks: a call that WAITS on one
// (a query tool with { task_id }, display_model_result) is followed to its end, so the protocol task's result is the
// rows, not "still running"; a call that STARTS work returns its task_id at once, as always.
//
// The long call is the `time` tool (a pure timer, cancellable); the followed task is a stub engine
// whose task is done after two waits. The data assertions are on what comes back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TASK_CAPS } from '../helpers/mcp-http.js';
import { runToCompletion } from '../../src/mcp-surface.js';

const payload = (result) => JSON.parse(result.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(s, taskId, done) {
  const t0 = Date.now();
  for (;;) {
    const r = await s.modern('tasks/get', { taskId }, { caps: TASK_CAPS });
    if (done(r.body.result) || Date.now() - t0 > 10000) return r.body.result;
    await sleep(100);
  }
}

test('a quick call answers inline even with tasks declared; a long one becomes a task and completes with its result', async () => {
  const s = await startServer();
  try {
    const quick = await s.modern('tools/call', { name: 'time', arguments: { seconds: 0 } }, { caps: TASK_CAPS });
    assert.equal(quick.body.result.resultType, 'complete');

    const t = (await s.modern('tools/call', { name: 'time', arguments: { seconds: 1 } }, { caps: TASK_CAPS })).body.result;
    assert.equal(t.resultType, 'task');
    assert.equal(t.status, 'working');
    assert.match(t.taskId, /^[0-9a-f-]{36}$/, 'an unguessable id');
    assert.ok(t.pollIntervalMs > 0 && t.ttlMs > 0);

    // it exists the moment the CreateTaskResult is sent
    const first = await s.modern('tasks/get', { taskId: t.taskId }, { caps: TASK_CAPS });
    assert.equal(first.status, 200);
    assert.equal(first.body.result.resultType, 'complete');
    const done = await pollUntil(s, t.taskId, (x) => x.status !== 'working');
    assert.equal(done.status, 'completed');
    assert.equal(payload(done.result).waited_seconds, 1, 'the result is what the call returned');
  } finally { await s.stop(); }
});

test('no task without the extension: the call answers inline, tasks/* are -32021, a legacy client is never given one', async () => {
  const s = await startServer();
  try {
    const r = await s.modern('tools/call', { name: 'time', arguments: { seconds: 1 } });
    assert.equal(r.body.result.resultType, 'complete');
    assert.equal(payload(r.body.result).waited_seconds, 1);
    const legacy = await s.client({ era: 'legacy', capabilities: { extensions: TASK_CAPS.extensions } });
    assert.equal(payload(await legacy.callTool({ name: 'time', arguments: { seconds: 1 } })).waited_seconds, 1, 'the extension is not defined before 2026-07-28');

    const g = await s.modern('tasks/get', { taskId: 'whatever' });
    assert.equal(g.status, 400);
    assert.equal(g.body.error.code, -32021);
    assert.deepEqual(g.body.error.data.requiredCapabilities, { extensions: { 'io.modelcontextprotocol/tasks': {} } });
    const unknown = await s.modern('tasks/get', { taskId: '00000000-0000-4000-8000-000000000000' }, { caps: TASK_CAPS });
    assert.equal(unknown.body.error.code, -32602);
    const misrouted = await s.modern('tasks/get', { taskId: 'abc' }, { caps: TASK_CAPS, headers: { 'mcp-name': 'other' } });
    assert.equal(misrouted.body.error.code, -32020, 'Mcp-Name must be the taskId (SEP-2663 routing header)');
  } finally { await s.stop(); }
});

test('tasks/cancel is an ack, the task ends cancelled, and the work itself stops; tasks/update is an ack', async () => {
  const s = await startServer();
  const real = s.engine.time.bind(s.engine);
  let outcome;
  s.engine.time = async (input) => { outcome = await real(input); return outcome; };
  try {
    const t = (await s.modern('tools/call', { name: 'time', arguments: { seconds: 20 } }, { caps: TASK_CAPS })).body.result;
    const upd = await s.modern('tasks/update', { taskId: t.taskId, inputResponses: {} }, { caps: TASK_CAPS });
    assert.equal(upd.status, 200);
    const ack = await s.modern('tasks/cancel', { taskId: t.taskId }, { caps: TASK_CAPS });
    assert.equal(ack.status, 200);
    assert.deepEqual(Object.keys(ack.body.result).sort(), ['_meta', 'resultType']);
    assert.equal((await pollUntil(s, t.taskId, (x) => x.status !== 'working')).status, 'cancelled');
    const t0 = Date.now();
    while (!outcome && Date.now() - t0 < 5000) await sleep(50);
    assert.equal(outcome?.cancelled, true, 'the timer stopped instead of running its 20 seconds');
    await sleep(200);
    assert.equal((await pollUntil(s, t.taskId, () => true)).status, 'cancelled', 'terminal states never change');
  } finally { s.engine.time = real; await s.stop(); }
});

/** A stub engine whose task `t1` is done after `after` waits, with these rows. */
function stubEngine({ after = 3, rows = [], fail = null, throws = null } = {}) {
  const state = { waits: 0 };
  const done = () => state.waits >= after;
  const result = () => (fail ? { ok: false, task_id: 't1', status: 'error', error: fail } : { ok: true, task_id: 't1', status: 'done', columns: [{ name: 'day' }, { name: 'dau' }], rows, row_count: rows.length });
  const engine = {
    state,
    schemas: { query_pipeline_model: {}, display_model_result: {}, query_semantic_model: {} },
    jobs: { get: (id) => (id === 't1' ? { id, status: done() ? (fail ? 'error' : 'ready') : 'running' } : undefined), isLive: () => true },
    async _awaitTask() {
      if (throws) throw throws;
      state.waits += 1;
    },
    async query_pipeline_model({ task_id }) {
      if (!task_id) return { task_id: 't1', context_id: 'c1', next: 'query_pipeline_model' };
      return done() ? result() : { ok: true, task_id: 't1', status: 'running' };
    },
    async display_model_result({ display }) {
      const r = result();
      return r.ok === false ? r : { ...r, display, drawn_from: { tool: 'query_semantic_model' }, drawn: true };
    },
    async query_semantic_model() { return { task_id: 't1', context_id: 'c1', next: 'query_semantic_model' }; },
  };
  return engine;
}

test('a protocol task follows a query tool\'s read while the engine task runs, and returns its rows — never a card', async () => {
  const rows = [{ day: '2024-01-01', dau: 42 }, { day: '2024-01-02', dau: 57 }];
  const engine = stubEngine({ rows });
  const { result, raw } = await runToCompletion(engine, 'query_pipeline_model', { task_id: 't1' });
  assert.equal(raw.status, 'done');
  assert.deepEqual(payload(result).rows, rows);
  assert.equal(result.structuredContent, undefined, 'reading a result draws nothing');
  assert.ok(engine.state.waits >= 3, 'it waited until the task was done');
});

test('display_model_result under a protocol task waits for the task, then draws its ONE card', async () => {
  const rows = [{ day: '2024-01-01', dau: 42 }, { day: '2024-01-02', dau: 57 }];
  const engine = stubEngine({ rows });
  const { result } = await runToCompletion(engine, 'display_model_result', { task_id: 't1', display: { kind: 'line', x: 'day', y: ['dau'] } });
  assert.deepEqual(result.structuredContent.rows, rows, 'the card is drawn from the finished rows');
});

test('a call that STARTS work is never held by a protocol task: it answers with its task_id', async () => {
  const engine = stubEngine({ after: 1000 });
  const { raw } = await runToCompletion(engine, 'query_semantic_model', {});
  assert.equal(raw.task_id, 't1');
  assert.equal(engine.state.waits, 0, 'nothing waited on the task');
});

test('a followed task that FAILS is a tool error, not a completed success', async () => {
  const engine = stubEngine({ after: 1, fail: { stage: 'materialize', message: 'dbt run failed' } });
  const { result } = await runToCompletion(engine, 'query_pipeline_model', { task_id: 't1' });
  assert.equal(result.isError, true);
  assert.equal(payload(result).error.message, 'dbt run failed');
});

test('a wait that THROWS while following a task is a tool error the caller reads', async () => {
  const engine = stubEngine({ throws: Object.assign(new Error('relation "qr_x" does not exist'), { stage: 'query' }) });
  const { result, raw } = await runToCompletion(engine, 'query_pipeline_model', { task_id: 't1' });
  assert.equal(raw, null);
  assert.equal(result.isError, true);
  assert.equal(payload(result).error.stage, 'query');
  assert.match(payload(result).error.message, /does not exist/);
});

test('following a long task leaves no abort listener behind on the protocol task\'s signal', async () => {
  const engine = stubEngine({ after: 40, rows: [] });
  const ctl = new AbortController();
  let live = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const remove = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = (type, fn, o) => { if (type === 'abort') live += 1; add(type, fn, o); };
  ctl.signal.removeEventListener = (type, fn, o) => { if (type === 'abort') live -= 1; remove(type, fn, o); };
  await runToCompletion(engine, 'query_pipeline_model', { task_id: 't1' }, { signal: ctl.signal });
  assert.ok(engine.state.waits >= 40);
  assert.ok(live <= 1, `listeners still attached after 40 waits: ${live}`);
});
