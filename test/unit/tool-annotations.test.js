// WHAT EACH TOOL DECLARES ABOUT ITS EFFECTS, AND WHAT A TOOL NAME MAY DISPATCH TO.
//
// ToolAnnotations are what a client reads to decide whether to ask the user before a call
// (readOnlyHint / destructiveHint / idempotentHint / openWorldHint). They must be present on every
// advertised tool and must be honest: a tool that can remove something is destructive, one that
// writes nothing is read-only. And a tool name is looked up among the tools — never as a free
// method name on the engine, which has private methods (`_draftStart`, `close`, `gc`).
//
// Lifecycle checks on the tool surface; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, startServer } from '../helpers/mcp-http.js';
import { buildToolDefs } from '../../src/mcp-surface.js';

test('every advertised tool declares its behaviour', () => {
  const tools = buildToolDefs(makeEngine());
  for (const t of tools) {
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    assert.equal(t.annotations.openWorldHint, false, `${t.name}: the warehouse is a closed domain`);
    assert.equal(t.annotations.title, t.title);
    if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, 'boolean', t.name);
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  for (const ro of ['semantic_index', 'get_query_result', 'experiment', 'time']) assert.equal(by[ro].readOnlyHint, true, ro);
  for (const d of ['context', 'memory']) assert.equal(by[d].destructiveHint, true, `${d} can remove what it holds`);
  for (const w of ['create_semantic_model', 'build_native_model', 'query_semantic_model']) assert.equal(by[w].readOnlyHint, false, `${w} writes into its context`);
});

test('a legacy tools/call of a private engine method is an unknown-tool error, not a dispatch', async () => {
  const s = await startServer();
  const client = await s.legacyClient();
  let closed = false;
  const realClose = s.engine.close?.bind(s.engine);
  s.engine.close = () => { closed = true; };
  try {
    for (const name of ['close', 'gc', '_draftStart', 'constructor']) {
      const r = await client.callTool({ name, arguments: {} });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /unknown tool/, name);
    }
    assert.equal(closed, false, 'engine.close was never reached');
  } finally { s.engine.close = realClose || (() => {}); await client.close(); await s.stop(); }
});
