// ONE DEFINITION PER TOOL (src/tools/define.js): the registry is the only place a tool is described,
// and it holds together — every tool has a schema and every schema a tool, what is listed is what the
// surface advertises, an old name dispatches to its tool, and a definition that leaves something out
// is refused at start rather than in a call.
//
// Lifecycle checks on the tool surface; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../helpers/mcp-http.js';
import { buildToolDefs, isCallableTool, canonicalTool } from '../../src/mcp-surface.js';
import { CORE_TOOLS } from '../../src/tools/core.js';
import { defineTool, toolRegistry } from '../../src/tools/define.js';

test('every tool has a schema and every schema a tool; the listed ones are what the surface advertises', () => {
  const engine = makeEngine();
  const names = engine.tools.names();
  assert.deepEqual([...names].sort(), Object.keys(engine.schemas).sort());
  assert.deepEqual(buildToolDefs(engine).map((d) => d.name), engine.tools.values().filter((d) => d.listed).map((d) => d.name));
  for (const def of CORE_TOOLS) assert.equal(typeof engine[def.name], 'function', `${def.name} runs on the engine`);
});

test('an old name dispatches to its tool; a name no tool has does not dispatch', () => {
  const engine = makeEngine();
  for (const def of engine.tools.values()) for (const alias of def.aliases) {
    assert.equal(isCallableTool(engine, alias), true, alias);
    assert.equal(canonicalTool(alias, engine), def.name);
  }
  assert.equal(canonicalTool('create_semantic_model', engine), 'build_semantic_model');
  for (const name of ['_draftStart', 'close', 'gc', 'constructor', 'toString']) assert.equal(isCallableTool(engine, name), false, name);
});

test('a definition that leaves something out, or says what cannot be, is refused', () => {
  const ok = { name: 'x_tool', title: 'X', description: 'does x', annotations: { readOnlyHint: true }, run: () => ({}) };
  assert.equal(defineTool(ok).listed, true);
  assert.throws(() => defineTool({ ...ok, name: 'X-Tool' }), /snake_case/);
  assert.throws(() => defineTool({ ...ok, description: '' }), /description/);
  assert.throws(() => defineTool({ ...ok, annotations: {} }), /readOnlyHint/);
  assert.throws(() => defineTool({ ...ok, annotations: { readOnlyHint: false } }), /destructive and idempotent/);
  assert.throws(() => defineTool({ ...ok, annotations: { readOnlyHint: true, destructiveHint: true } }), /removes nothing/);
  assert.throws(() => defineTool({ ...ok, precheck: () => {} }), /waits/);
  assert.throws(() => defineTool({ ...ok, cardField: 'card' }), /draw/);
  assert.throws(() => defineTool({ ...ok, behaviour: {} }), /unknown field 'behaviour'/);
  assert.throws(() => toolRegistry([defineTool(ok), defineTool(ok)]), /defined twice/);
  assert.throws(() => toolRegistry([defineTool({ ...ok, aliases: ['y_tool'] }), defineTool({ ...ok, name: 'y_tool' })]), /taken|defined twice|a tool's name/);
});
