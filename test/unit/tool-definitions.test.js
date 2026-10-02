// ONE DEFINITION PER TOOL (src/tools/define.js): the registry is the only place a tool is described,
// and it holds together — every tool has a schema and every schema a tool, every tool is listed and
// called by its one name, and a definition that leaves something out is refused at start rather than in
// a call.
//
// Lifecycle checks on the tool surface; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../helpers/mcp-http.js';
import { buildToolDefs, isCallableTool } from '../../src/mcp-surface.js';
import { CORE_TOOLS } from '../../src/tools/core.js';
import { defineTool, toolRegistry } from '../../src/tools/define.js';

test('every tool has a schema and every schema a tool, and every tool is what the surface lists', () => {
  const engine = makeEngine();
  const names = engine.tools.names();
  assert.deepEqual([...names].sort(), Object.keys(engine.schemas).sort());
  assert.deepEqual(buildToolDefs(engine).map((d) => d.name), names);
  for (const def of CORE_TOOLS) assert.equal(typeof engine[def.name], 'function', `${def.name} runs on the engine`);
});

test('a tool is called by its one name: an old name, a method contract or a private method does not dispatch', () => {
  const engine = makeEngine();
  for (const name of ['create_semantic_model', 'build_native_model', 'display_result', 'ab_test', 'register_native_model', 'drop_context', 'get_task_result', '_draftStart', 'close', 'gc', 'constructor', 'toString']) {
    assert.equal(isCallableTool(engine, name), false, name);
  }
});

test('a definition that leaves something out, or says what cannot be, is refused', () => {
  const ok = { name: 'x_tool', title: 'X', description: 'does x', annotations: { readOnlyHint: true }, run: () => ({}) };
  assert.equal(defineTool(ok).name, 'x_tool');
  assert.throws(() => defineTool({ ...ok, name: 'X-Tool' }), /snake_case/);
  assert.throws(() => defineTool({ ...ok, description: '' }), /description/);
  assert.throws(() => defineTool({ ...ok, annotations: {} }), /readOnlyHint/);
  assert.throws(() => defineTool({ ...ok, annotations: { readOnlyHint: false } }), /destructive and idempotent/);
  assert.throws(() => defineTool({ ...ok, annotations: { readOnlyHint: true, destructiveHint: true } }), /removes nothing/);
  assert.throws(() => defineTool({ ...ok, precheck: () => {} }), /waits/);
  assert.throws(() => defineTool({ ...ok, cardField: 'card' }), /draw/);
  assert.throws(() => defineTool({ ...ok, behaviour: {} }), /unknown field 'behaviour'/);
  assert.throws(() => toolRegistry([defineTool(ok), defineTool(ok)]), /defined twice/);
  assert.throws(() => defineTool({ ...ok, aliases: ['y_tool'] }), /unknown field 'aliases'/);
  assert.throws(() => defineTool({ ...ok, listed: false }), /unknown field 'listed'/);
});
