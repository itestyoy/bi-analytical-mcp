// TASKS — a call that outlives its request, polled by the host instead of by the model.
//
// Two wire formats over one registry (src/tasks.js):
//   * the Tasks extension (2026-07-28): the SERVER decides — a call that has not finished in its
//     inline window comes back as a task; tasks/get returns the result inline; tasks/cancel is an
//     ack; a client that did not declare the extension never gets a task and is refused tasks/*;
//   * the 2025-11-25 experimental tasks (legacy sessions): the CLIENT asks with `params.task`;
//     tasks/result blocks until the end; tasks/list is scoped to the session that created them.
// And the point of having tasks here at all: a build the engine hands back as a query_id is FOLLOWED
// to its end, so the task's result is the rows, not a job id the model must poll.
//
// The long call is the `time` tool (a pure timer, cancellable); the followed job is a stub engine
// whose job becomes ready after two polls. The data assertion is on the rows that come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TASK_CAPS } from '../helpers/mcp-http.js';
import { runToCompletion } from '../../src/mcp-surface.js';
import { CreateTaskResultSchema, GetTaskResultSchema, CallToolResultSchema, ListTasksResultSchema, CancelTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';

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

test('modern: a quick call answers inline even with tasks declared; a long one becomes a task and completes with its result', async () => {
  const s = await startServer();
  try {
    const quick = await s.modern('tools/call', { name: 'time', arguments: { seconds: 0 } }, { caps: TASK_CAPS });
    assert.equal(quick.body.result.resultType, 'complete');

    const created = await s.modern('tools/call', { name: 'time', arguments: { seconds: 1 } }, { caps: TASK_CAPS });
    const t = created.body.result;
    assert.equal(t.resultType, 'task');
    assert.equal(t.status, 'working');
    assert.match(t.taskId, /^[0-9a-f-]{36}$/, 'an unguessable id');
    assert.ok(t.pollIntervalMs > 0 && t.ttlMs > 0);

    // it exists the moment the CreateTaskResult is sent
    const first = await s.modern('tasks/get', { taskId: t.taskId }, { caps: TASK_CAPS });
    assert.equal(first.body.result.resultType, 'complete');
    const done = await pollUntil(s, t.taskId, (x) => x.status !== 'working');
    assert.equal(done.status, 'completed');
    assert.equal(payload(done.result).waited_seconds, 1, 'the result is what the call returned');
  } finally { await s.stop(); }
});

test('modern: without the extension there is no task — the call answers inline, and tasks/* are -32021', async () => {
  const s = await startServer();
  try {
    const r = await s.modern('tools/call', { name: 'time', arguments: { seconds: 1 } });
    assert.equal(r.body.result.resultType, 'complete');
    assert.equal(payload(r.body.result).waited_seconds, 1);
    const g = await s.modern('tasks/get', { taskId: 'whatever' });
    assert.equal(g.status, 400);
    assert.equal(g.body.error.code, -32021);
    assert.deepEqual(g.body.error.data.requiredCapabilities, { extensions: { 'io.modelcontextprotocol/tasks': {} } });
    const unknown = await s.modern('tasks/get', { taskId: '00000000-0000-4000-8000-000000000000' }, { caps: TASK_CAPS });
    assert.equal(unknown.body.error.code, -32602);
  } finally { await s.stop(); }
});

test('modern: tasks/cancel is an ack, the task ends cancelled, and the work itself stops', async () => {
  const s = await startServer();
  const real = s.engine.time.bind(s.engine);
  let outcome;
  s.engine.time = async (input) => { outcome = await real(input); return outcome; };
  try {
    const t = (await s.modern('tools/call', { name: 'time', arguments: { seconds: 20 } }, { caps: TASK_CAPS })).body.result;
    const ack = await s.modern('tasks/cancel', { taskId: t.taskId }, { caps: TASK_CAPS });
    assert.equal(ack.status, 200);
    assert.deepEqual(Object.keys(ack.body.result).sort(), ['_meta', 'resultType']);
    const after = await pollUntil(s, t.taskId, (x) => x.status !== 'working');
    assert.equal(after.status, 'cancelled');
    const t0 = Date.now();
    while (!outcome && Date.now() - t0 < 5000) await sleep(50);
    assert.equal(outcome?.cancelled, true, 'the timer stopped instead of running its 20 seconds');
    // terminal states never change
    await sleep(200);
    assert.equal((await pollUntil(s, t.taskId, () => true)).status, 'cancelled');
  } finally { s.engine.time = real; await s.stop(); }
});

test('modern: subscriptions/listen acknowledges first, then pushes the task\'s status when it ends', async () => {
  const s = await startServer();
  try {
    const t = (await s.modern('tools/call', { name: 'time', arguments: { seconds: 1 } }, { caps: TASK_CAPS })).body.result;
    const ctl = new AbortController();
    const res = await fetch(s.url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'subscriptions/listen', params: { notifications: { taskIds: [t.taskId], toolsListChanged: true }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': TASK_CAPS } } }),
    });
    const reader = res.body.getReader();
    const seen = [];
    let buf = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !seen.some((m) => m.method === 'notifications/tasks')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) seen.push(JSON.parse(line.slice(6)));
      }
    }
    ctl.abort();
    assert.equal(seen[0].method, 'notifications/subscriptions/acknowledged', 'the acknowledgement comes first');
    assert.equal(seen[0].params._meta['io.modelcontextprotocol/subscriptionId'], 77);
    assert.deepEqual(seen[0].params.notifications.taskIds, [t.taskId]);
    const pushed = seen.find((m) => m.method === 'notifications/tasks');
    assert.equal(pushed.params.taskId, t.taskId);
    assert.equal(pushed.params.status, 'completed');
    assert.equal(payload(pushed.params.result).waited_seconds, 1);
  } finally { await s.stop(); }
});

test('legacy (2025-11-25): params.task creates a task, tasks/result delivers the call\'s result, tasks/list is per session', async () => {
  const s = await startServer();
  const a = await s.legacyClient();
  const b = await s.legacyClient();
  try {
    const created = await a.request({ method: 'tools/call', params: { name: 'time', arguments: { seconds: 1 }, task: { ttl: 60000 } } }, CreateTaskResultSchema);
    assert.equal(created.task.status, 'working');
    assert.equal((await a.request({ method: 'tasks/get', params: { taskId: created.task.taskId } }, GetTaskResultSchema)).taskId, created.task.taskId);
    const result = await a.request({ method: 'tasks/result', params: { taskId: created.task.taskId } }, CallToolResultSchema);
    assert.equal(payload(result).waited_seconds, 1, 'tasks/result blocks until the end and returns the call\'s own result');
    assert.equal((await a.request({ method: 'tasks/list', params: {} }, ListTasksResultSchema)).tasks.length, 1);
    assert.equal((await b.request({ method: 'tasks/list', params: {} }, ListTasksResultSchema)).tasks.length, 0, 'another session does not see it');
    await assert.rejects(() => b.request({ method: 'tasks/get', params: { taskId: created.task.taskId } }, GetTaskResultSchema), /not found/i);

    const long = await a.request({ method: 'tools/call', params: { name: 'time', arguments: { seconds: 20 }, task: {} } }, CreateTaskResultSchema);
    assert.equal((await a.request({ method: 'tasks/cancel', params: { taskId: long.task.taskId } }, CancelTaskResultSchema)).status, 'cancelled');
  } finally { await a.close(); await b.close(); await s.stop(); }
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
      return polls < 3 ? { ok: true, status: 'running', query_id } : { ok: true, status: 'ready', query_id, columns: [{ name: 'day' }, { name: 'dau' }], rows, row_count: 2 };
    },
  };
  const { result, raw } = await runToCompletion(engine, 'query_semantic_model', {}, { pollMs: 10 });
  assert.equal(raw.status, 'ready');
  assert.deepEqual(payload(result).rows, rows);
  assert.equal(polls, 3);
});
