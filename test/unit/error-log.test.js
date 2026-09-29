// THE ERROR LOG (src/error-log.js) and explore_errors: every failure is kept in the store — a call
// refused (with its arguments), a task that ended in an error, what a start could not serve — and read
// back newest first, filtered, one in full. Lifecycle checks on the store; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine } from '../helpers/mcp-http.js';
import { runTool } from '../../src/mcp-surface.js';
import { openStore } from '../../src/store.js';
import { ErrorLog } from '../../src/error-log.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const payload = (r) => JSON.parse(r.result.content[0].text);

test('a refused call is kept with its arguments, and explore_errors reads it back — newest first, filtered, one in full', async () => {
  const engine = makeEngine({ recipes: false });
  const bad = { context_id: 'ctx_nope', metrics: ['x'] };
  assert.equal((await runTool(engine, 'query_semantic_model', bad)).result.isError, true);
  assert.equal((await runTool(engine, 'no_such_tool', { a: 1 })).result.isError, true);
  await runTool(engine, 'time', { seconds: 0 }); // a call that works is not an error
  const page = payload(await runTool(engine, 'explore_errors', {}));
  assert.equal(page.total, 2);
  assert.deepEqual(page.errors.map((e) => e.tool), ['no_such_tool', 'query_semantic_model']);
  assert.equal(page.errors[1].context_id, 'ctx_nope');
  assert.deepEqual(page.by_source.map((g) => [g.source, g.tool, g.count]).sort(), [['tool', 'no_such_tool', 1], ['tool', 'query_semantic_model', 1]]);
  // one in full: the call's arguments as they were given
  const one = payload(await runTool(engine, 'explore_errors', { id: page.errors[1].id }));
  assert.deepEqual(one.error.args, bad);
  // narrowed by tool, by text, by time
  assert.equal(payload(await runTool(engine, 'explore_errors', { tool: 'no_such_tool' })).total, 1);
  assert.equal(payload(await runTool(engine, 'explore_errors', { text: 'CTX_NOPE' })).total, 1);
  assert.equal(payload(await runTool(engine, 'explore_errors', { until: '2000-01-01' })).total, 0);
  // paged
  const first = payload(await runTool(engine, 'explore_errors', { limit: 1 }));
  assert.equal(first.next_offset, 1);
  assert.equal(payload(await runTool(engine, 'explore_errors', { limit: 1, offset: 1 })).errors[0].tool, 'query_semantic_model');
  // reading the log is not itself an error
  assert.equal(payload(await runTool(engine, 'explore_errors', {})).total, 2);
});

test('bad input to explore_errors is refused, and that refusal is kept too', async () => {
  const engine = makeEngine({ recipes: false });
  assert.equal((await runTool(engine, 'explore_errors', { since: 'yesterday' })).result.isError, true);
  assert.equal((await runTool(engine, 'explore_errors', { id: 999 })).result.isError, true);
  assert.equal((await runTool(engine, 'explore_errors', { source: 'nope' })).result.isError, true);
  assert.equal(payload(await runTool(engine, 'explore_errors', { tool: 'explore_errors' })).total, 3);
});

test('what a start could not serve is the first thing in the log, and the log outlives a restart', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'errlog-')), 'mcp.sqlite');
  const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'), {});
  const start = () => new Engine({ catalog, dbPath, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'errlog-ws-')) }), project: { error: 'the project did not parse' } });
  const a = start();
  assert.deepEqual(a.explore_errors({ source: 'startup' }).errors.map((e) => e.stage), ['project_semantic_layer']);
  a.close?.();
  // a second start adds its own, and the first one's is still there — even with MCP_DB_RESET
  const b = new Engine({ catalog, dbPath, resetDb: true, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'errlog-ws-')) }), project: { error: 'the project did not parse' } });
  assert.equal(b.explore_errors({ source: 'startup' }).total, 2);
  b.close?.();
});

test('the log is bounded by age and by count', () => {
  for (const store of [openStore({}), openStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'errlog-')), 'x.sqlite') })]) {
    const log = new ErrorLog({ store, retentionDays: 0, maxRows: 3 });
    for (let i = 0; i < 5; i += 1) log.record({ source: 'tool', tool: 't', message: `m${i}` });
    log.prune();
    assert.deepEqual(log.list({}).rows.map((r) => r.message), ['m4', 'm3', 'm2'], store.kind);
    store.errors.add({ at: Date.now() - 40 * 86400000, source: 'tool', message: 'old' });
    new ErrorLog({ store, retentionDays: 30, maxRows: 0 });
    assert.equal(log.list({ text: 'old' }).total, 0, store.kind);
  }
});

test('a task that ends in an error is kept once, with its input — its reads are not kept again', async () => {
  const engine = makeEngine({ recipes: false });
  const id = engine._startTask(null, 'query_pipeline_model', async () => ({ ok: false, error: { stage: 'query', message: 'Catalog Error: Table x does not exist' } }), { input: { transform: { limit: 1 } } });
  const thrown = engine._startTask(null, 'query_pipeline_model', async () => { throw new Error('the sidecar exited'); });
  await engine._awaitTasks([id, thrown], 5);
  const tasks = engine.explore_errors({ source: 'task' });
  assert.deepEqual(tasks.errors.map((e) => e.task_id).sort(), [id, thrown].sort());
  assert.deepEqual(engine.explore_errors({ task_id: id, detail: true }).errors[0].args, { transform: { limit: 1 } });
  await runTool(engine, 'query_pipeline_model', { task_id: id });
  assert.equal(engine.explore_errors({}).total, 2);
});
