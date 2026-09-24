// TASKS — a call that outlives its request, polled by the host instead of by the model.
//
// The Tasks extension (io.modelcontextprotocol/tasks, SEP-2663, protocol 2026-07-28): the SERVER
// decides — for a client that declared the extension, a call that has not finished within its
// inline window comes back as a task (`resultType: "task"`); tasks/get returns the result inline;
// tasks/cancel is an ack; a client that did not declare it never gets a task and is refused
// tasks/*. And the point of having tasks here at all: a build the engine hands back as a query_id
// is FOLLOWED to its end, so the task's result is the rows, not a job id the model must poll.
//
// The long call is the `time` tool (a pure timer, cancellable); the followed job is a stub engine
// whose job becomes ready after two polls. The data assertions are on what comes back.

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

test('a task follows a build the engine handed back as a query_id, and returns the rows', async () => {
  // a stub engine: the call detaches (as a materialize past its grace does); the job is ready on the third poll
  let polls = 0;
  const rows = [{ day: '2024-01-01', dau: 42 }, { day: '2024-01-02', dau: 57 }];
  const engine = {
    schemas: { query_semantic_model: {} },
    async query_semantic_model() { return { ok: true, status: 'running', query_id: 'q-1', table: 't' }; },
    async get_query_result({ query_id }) {
      polls += 1;
      // the query remembers the card declaration it was issued with, and its result carries it
      return polls < 3 ? { ok: true, status: 'running', query_id } : { ok: true, status: 'ready', query_id, columns: [{ name: 'day' }, { name: 'dau' }], rows, row_count: 2, display: { kind: 'line', x: 'day', y: ['dau'] } };
    },
  };
  const { result, raw } = await runToCompletion(engine, 'query_semantic_model', {}, { pollMs: 10 });
  assert.equal(raw.status, 'ready');
  assert.deepEqual(payload(result).rows, rows);
  assert.deepEqual(result.structuredContent.rows, rows, 'the card asked for is drawn from the followed rows');
  assert.equal(polls, 3);
});

test('a followed build that FAILS is a tool error, not a completed success', async () => {
  const engine = {
    schemas: { query_semantic_model: {} },
    async query_semantic_model() { return { ok: true, status: 'running', query_id: 'q-2', table: 't' }; },
    async get_query_result({ query_id }) { return { ok: false, status: 'error', query_id, error: { stage: 'materialize', message: 'dbt run failed' } }; },
  };
  const { result } = await runToCompletion(engine, 'query_semantic_model', {}, { pollMs: 5 });
  assert.equal(result.isError, true);
  assert.equal(payload(result).error.message, 'dbt run failed');
});

test('a poll that THROWS while following a build is a tool error the caller reads', async () => {
  const engine = {
    schemas: { query_semantic_model: {} },
    async query_semantic_model() { return { ok: true, status: 'running', query_id: 'q-3', table: 't' }; },
    async get_query_result() { throw Object.assign(new Error('relation "qr_x" does not exist'), { stage: 'query' }); },
  };
  const { result, raw } = await runToCompletion(engine, 'query_semantic_model', {}, { pollMs: 5 });
  assert.equal(raw, null);
  assert.equal(result.isError, true);
  assert.equal(payload(result).error.stage, 'query');
  assert.match(payload(result).error.message, /does not exist/);
});

test('following a long build leaves no abort listener behind on the task\'s signal', async () => {
  let polls = 0;
  const engine = {
    schemas: { query_semantic_model: {} },
    async query_semantic_model() { return { ok: true, status: 'running', query_id: 'q-4', table: 't' }; },
    async get_query_result({ query_id }) { polls += 1; return polls < 40 ? { ok: true, status: 'running', query_id } : { ok: true, status: 'ready', query_id, rows: [] }; },
  };
  const ctl = new AbortController();
  let live = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const remove = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = (type, fn, o) => { if (type === 'abort') live += 1; add(type, fn, o); };
  ctl.signal.removeEventListener = (type, fn, o) => { if (type === 'abort') live -= 1; remove(type, fn, o); };
  await runToCompletion(engine, 'query_semantic_model', {}, { pollMs: 1, signal: ctl.signal });
  assert.equal(polls, 40);
  assert.ok(live <= 1, `listeners still attached after 40 polls: ${live}`);
});
