// WHAT EACH TOOL DECLARES ABOUT ITS EFFECTS.
//
// ToolAnnotations are what a client reads to decide whether to ask the user before a call
// (readOnlyHint / destructiveHint / idempotentHint / openWorldHint). They must be present on every
// advertised tool and must be honest: a tool that can remove something is destructive, one that
// writes nothing is read-only. (That a tool name never dispatches to a private engine method is
// checked in mcp-protocol.test.js, through both protocol revisions.)
//
// Lifecycle checks on the tool surface; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../helpers/mcp-http.js';
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
  for (const ro of ['semantic_index', 'query_pipeline_model', 'display_model_result', 'drill_result', 'experiment', 'time']) assert.equal(by[ro].readOnlyHint, true, ro);
  for (const d of ['context', 'memory']) assert.equal(by[d].destructiveHint, true, `${d} can remove what it holds`);
  for (const w of ['build_semantic_model', 'build_pipeline_model', 'query_semantic_model']) assert.equal(by[w].readOnlyHint, false, `${w} writes into its context`);
});
