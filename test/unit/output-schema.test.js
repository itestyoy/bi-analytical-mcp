// A TOOL THAT DECLARES THE SHAPE OF ITS ANSWER (outputSchema, src/schema/outputs.js) carries every
// successful answer as structuredContent too, conforming to it — the spec's rule, which a client's SDK
// checks for itself. Each mode of each such tool is answered here and held to its schema, directly and
// through the official client over both revisions; and a tool with a card declares none.
// (Non-data checks: the surface's contract — what the answer is shaped like — not numbers.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { startServer } from '../helpers/mcp-http.js';
import { runTool } from '../../src/mcp-surface.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const ajv = new Ajv({ allErrors: true, strict: false });

/** Every mode of the tools that declare an answer's shape, as calls. */
async function calls(engine) {
  const draft = await engine.build_pipeline_model({ action: 'start', name: 'outputs', source: engine.catalog.facts[0] });
  return [
    ['time', { seconds: 0, reason: 'a pause' }],
    ['context', { action: 'list' }],
    ['context', { action: 'describe', context_id: draft.draft_id }],
    ['memory', { action: 'record', note: 'a finding', targets: [{ term: 'ad format' }] }],
    ['explore_errors', {}],
    ['build_semantic_model', { name: 'outputs_sem', semantic_models: [{ from: engine.catalog.facts[0], measures: [{ name: 'n', agg: 'count' }] }], metrics: [{ name: 'n', type: 'simple', measure: { name: 'n' } }] }],
    ['delete_context', { context_id: draft.draft_id }],
  ];
}

test('every answer of a tool that declares its shape carries it as structuredContent, and conforms', async () => {
  const engine = s.engine;
  const declared = engine.tools.values().filter((d) => d.output);
  assert.deepEqual(declared.map((d) => d.name).sort(), ['build_semantic_model', 'context', 'delete_context', 'explore_errors', 'memory', 'time']);
  const seen = new Set();
  for (const [name, request] of await calls(engine)) {
    const { result } = await runTool(engine, name, { request });
    assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
    const check = ajv.compile(engine.tools.get(name).output);
    assert.ok(check(result.structuredContent), `${name} ${JSON.stringify(request)}: ${JSON.stringify(check.errors)}`);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text), 'the structured copy is the text');
    seen.add(name);
  }
  // the forget of the note recorded above
  const id = (await engine.semantic_index({ notes: true })).notes[0].id;
  const forgot = (await runTool(engine, 'memory', { request: { action: 'forget', id } })).result;
  assert.ok(ajv.compile(engine.tools.get('memory').output)(forgot.structuredContent));
  // one in full from the error log: a refused call is kept, then read by its id
  await runTool(engine, 'time', { request: { seconds: 'soon' } });
  const errId = (await engine.explore_errors({})).errors[0].id;
  const one = (await runTool(engine, 'explore_errors', { request: { id: errId } })).result;
  assert.ok(ajv.compile(engine.tools.get('explore_errors').output)(one.structuredContent), JSON.stringify(one.structuredContent).slice(0, 300));
  assert.deepEqual([...seen].sort(), declared.map((d) => d.name).sort(), 'every declared tool was answered');
});

test('a refusal of a declared tool is the text alone — the schema is the shape of a success', async () => {
  const { result } = await runTool(s.engine, 'context', { request: { action: 'describe', context_id: 'ffffffffffff' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
});

test('the official client takes every declared answer — it checks structuredContent against outputSchema itself — on both revisions', async () => {
  for (const era of ['legacy', 'modern']) {
    const c = await s.client({ era });
    const listed = (await c.listTools()).tools;
    const withOutput = listed.filter((t) => t.outputSchema).map((t) => t.name).sort();
    assert.deepEqual(withOutput, ['build_semantic_model', 'context', 'delete_context', 'explore_errors', 'memory', 'time'], era);
    // a tool with a card declares none: a host draws a card for every answer that carries structuredContent
    for (const t of listed.filter((x) => x._meta?.ui?.resourceUri)) assert.equal(t.outputSchema, undefined, `${era}: ${t.name}`);
    for (const [name, request] of await calls(s.engine)) {
      const r = await c.callTool({ name, arguments: { request } });
      assert.ok(!r.isError && r.structuredContent, `${era} ${name}`);
    }
  }
});
