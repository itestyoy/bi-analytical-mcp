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
  assert.equal((await runTool(engine, 'query_semantic_model', { request: bad })).result.isError, true);
  assert.equal((await runTool(engine, 'no_such_tool', { request: { a: 1 } })).result.isError, true);
  await runTool(engine, 'time', { request: { seconds: 0 } }); // a call that works is not an error
  const page = payload(await runTool(engine, 'explore_errors', { request: {} }));
  assert.equal(page.total, 2);
  assert.deepEqual(page.errors.map((e) => e.tool), ['no_such_tool', 'query_semantic_model']);
  assert.equal(page.errors[1].context_id, 'ctx_nope');
  assert.deepEqual(page.by_source.map((g) => [g.source, g.tool, g.count]).sort(), [['tool', 'no_such_tool', 1], ['tool', 'query_semantic_model', 1]]);
  // one in full: the call's arguments as they were given
  const one = payload(await runTool(engine, 'explore_errors', { request: { id: page.errors[1].id } }));
  assert.deepEqual(one.error.args, { request: bad }, 'as the call gave them — replaying them repeats it');
  // narrowed by tool, by text, by time
  assert.equal(payload(await runTool(engine, 'explore_errors', { request: { tool: 'no_such_tool' } })).total, 1);
  assert.equal(payload(await runTool(engine, 'explore_errors', { request: { text: 'CTX_NOPE' } })).total, 1);
  assert.equal(payload(await runTool(engine, 'explore_errors', { request: { until: '2000-01-01' } })).total, 0);
  // paged
  const first = payload(await runTool(engine, 'explore_errors', { request: { limit: 1 } }));
  assert.equal(first.next_offset, 1);
  assert.equal(payload(await runTool(engine, 'explore_errors', { request: { limit: 1, offset: 1 } })).errors[0].tool, 'query_semantic_model');
  // reading the log is not itself an error
  assert.equal(payload(await runTool(engine, 'explore_errors', { request: {} })).total, 2);
});

test('bad input to explore_errors is refused, and that refusal is kept too', async () => {
  const engine = makeEngine({ recipes: false });
  assert.equal((await runTool(engine, 'explore_errors', { request: { since: 'yesterday' } })).result.isError, true);
  assert.equal((await runTool(engine, 'explore_errors', { request: { id: 999 } })).result.isError, true);
  assert.equal((await runTool(engine, 'explore_errors', { request: { source: 'nope' } })).result.isError, true);
  assert.equal(payload(await runTool(engine, 'explore_errors', { request: { tool: 'explore_errors' } })).total, 3);
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
  await runTool(engine, 'query_pipeline_model', { request: { task_id: id } });
  assert.equal(engine.explore_errors({}).total, 2);
});

test('an error carries what reproduces it: the draft a refused step was added to, the code of the model a task failed on, the runtime', async () => {
  const engine = makeEngine({ recipes: false });
  const source = engine.catalog.facts[0];
  const s = await engine.build_pipeline_model({ action: 'start', name: 'repro', source });
  const col = engine.catalog.modelColumns(source)[0].name;
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ column: col, op: 'is_not_null' }] } });
  // a step naming a column that is not there is refused — and the draft it was added to is kept with it
  const refused = await runTool(engine, 'build_pipeline_model', { request: { action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ column: 'no_such_col', op: 'is_null' }] } } });
  assert.equal(refused.result.isError, true);
  const [row] = engine.explore_errors({ tool: 'build_pipeline_model' }).errors;
  const full = engine.explore_errors({ id: row.id }).error;
  assert.equal(full.context_id, s.draft_id);
  assert.deepEqual(full.context.state.draft.stages.map((st) => st.stage), ['where']);
  assert.equal(full.context.state.draft.source, source);
  assert.equal(full.args.request.stage.conditions[0].column, 'no_such_col');
  assert.equal(full.runtime.node, process.version);
  assert.equal(full.runtime.dialect, engine.catalog.dialect);
  // a task that failed on a generated model keeps that model's code, as the message names it
  const ctx = engine.ctxs.get(s.draft_id);
  engine.ctxs.writeModel(ctx.id, 'pipe_repro_x', 'select 1 as a\n');
  const id = engine._startTask(ctx, 'build_pipeline_model', async () => ({ ok: false, error: { stage: 'run', message: 'Database Error in model pipe_repro_x (models/generated/pipe_repro_x.sql)' } }), { input: { action: 'materialize', draft_id: ctx.id } });
  await engine._awaitTasks([id], 5);
  const task = engine.explore_errors({ id: engine.explore_errors({ task_id: id }).errors[0].id }).error;
  assert.equal(task.files['generated/pipe_repro_x.sql'], 'select 1 as a\n');
  assert.deepEqual(task.context.state.draft.stages.length, 1);
  assert.equal(task.args.action, 'materialize');
});

test('a call refused for leaving out the envelope is kept with the ids it carried at the top', async () => {
  const engine = makeEngine({ recipes: false });
  const r = await runTool(engine, 'query_semantic_model', { task_id: 'abcdef123456' });
  assert.equal(r.result.isError, true);
  const page = payload(await runTool(engine, 'explore_errors', { request: { task_id: 'abcdef123456' } }));
  assert.equal(page.total, 1, 'found by the task it named');
  assert.equal(page.errors[0].field, 'request');
});

test('an old name of a tool still takes the call as its clients learned it, before the envelope; the listed name does not', async () => {
  const engine = makeEngine({ recipes: false });
  const flat = { action: 'analyze', metric: 'proportion', control: { n: 1000, conversions: 100 }, variants: [{ label: 'b', n: 1000, conversions: 130 }] };
  const listed = await runTool(engine, 'experiment', flat);
  assert.equal(listed.result.isError, true, 'the listed name takes the envelope only');
  const old = await runTool(engine, 'ab_test', { metric: flat.metric, control: flat.control, variants: flat.variants });
  assert.equal(old.result.isError, undefined, JSON.stringify(old.result));
  assert.equal(payload(old).results[0].variant, 'b');
  // and the envelope under the old name as well
  assert.equal((await runTool(engine, 'ab_test', { request: { metric: flat.metric, control: flat.control, variants: flat.variants } })).result.isError, undefined);
});
