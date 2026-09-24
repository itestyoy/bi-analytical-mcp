// THE SERVER AS BOTH KINDS OF CLIENT MEET IT — through the official SDK client.
//
// One endpoint, one server factory, and the SDK (@modelcontextprotocol/server v2) decides per
// request how the client speaks: the 2025 `initialize` handshake that today's hosts use, or
// protocol 2026-07-28 (server/discover, a `_meta` envelope on every request). What this file checks
// is that the SAME server answers both the same way: same tools, same capabilities (the three
// extensions), same errors, progress and cancellation in each.
//
// Context-lifecycle tests (the non-data kind this project allows): the protocol envelope. The
// payloads of the tools are asserted elsewhere, on data.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, V } from '../helpers/mcp-http.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const EXTENSIONS = ['io.modelcontextprotocol/skills', 'io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/ui'];

test('both eras connect and see the same server: capabilities with the three extensions, instructions, tools', async () => {
  const legacy = await s.client({ era: 'legacy' });
  const modern = await s.client({ era: 'modern' });
  assert.equal(legacy.getProtocolEra(), 'legacy');
  assert.equal(modern.getProtocolEra(), 'modern');
  for (const c of [legacy, modern]) {
    assert.deepEqual(Object.keys(c.getServerCapabilities().extensions).sort(), EXTENSIONS);
    assert.ok(c.getInstructions().length > 0);
  }
  const names = async (c) => (await c.listTools()).tools.map((t) => t.name);
  assert.deepEqual(await names(legacy), await names(modern), 'one tool list for every client');
});

test('2026-07-28 on the wire: discover and lists carry caching hints, the result carries resultType', async () => {
  const d = await s.modern('server/discover');
  assert.equal(d.status, 200);
  assert.ok(d.body.result.supportedVersions.includes(V));
  assert.equal(d.body.result.resultType, 'complete');
  assert.equal(d.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'dbt-semantic-mcp');
  // a short lifetime: a deploy that changes them reaches the client within a minute (src/surface-change.js)
  for (const m of ['server/discover', 'tools/list', 'resources/list']) {
    const r = await s.modern(m);
    assert.equal(r.body.result.ttlMs, 60000, m);
    assert.equal(r.body.result.cacheScope, 'private', m);
  }
});

test('the SDK enforces the 2026-07-28 request rules: header/body mismatch is -32020, an unknown method 404', async () => {
  const mismatch = await s.modern('tools/call', { name: 'time', arguments: { seconds: 0 } }, { headers: { 'mcp-name': 'semantic_index' } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, -32020);
  const unknown = await s.modern('nope/nothing');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, -32601);
  const stale = await s.modern('tools/list', {}, { headers: { 'mcp-session-id': '00000000-0000-4000-8000-000000000000' } });
  assert.equal(stale.status, 200, 'a stale session header is ignored — there are no sessions');
});

test('an unknown tool — or a private engine method — is -32602 in both eras, never a dispatch', async () => {
  let closed = false;
  const realClose = s.engine.close;
  s.engine.close = () => { closed = true; };
  try {
    for (const c of [await s.client({ era: 'legacy' }), await s.client({ era: 'modern' })]) {
      for (const name of ['nope', '_draftStart', 'close', 'gc', 'constructor']) {
        await assert.rejects(() => c.callTool({ name, arguments: {} }), (e) => e.code === -32602, `${c.getProtocolEra()} ${name}`);
      }
    }
    assert.equal(closed, false, 'engine.close was never reached');
  } finally { s.engine.close = realClose; }
});

test('progress reaches a client that asked for it, in both eras', async () => {
  for (const era of ['legacy', 'modern']) {
    const c = await s.client({ era });
    const seen = [];
    const r = await c.callTool({ name: 'time', arguments: { seconds: 1 } }, { onprogress: (p) => seen.push(p) });
    assert.ok(seen.length >= 2, `${era}: heartbeats every 200ms over 1s (got ${seen.length})`);
    assert.deepEqual(seen.map((p) => p.progress), [...seen.map((p) => p.progress)].sort((a, b) => a - b), `${era}: progress increases`);
    assert.equal(JSON.parse(r.content[0].text).waited_seconds, 1);
  }
});

test('closing the request cancels the call — the work stops, not just the response', async () => {
  const real = s.engine.time.bind(s.engine);
  let outcome;
  s.engine.time = async (input) => { outcome = await real(input); return outcome; };
  try {
    const ctl = new AbortController();
    const p = s.modern('tools/call', { name: 'time', arguments: { seconds: 20 } }, { signal: ctl.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    ctl.abort();
    await p;
    const t0 = Date.now();
    while (!outcome && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(outcome?.cancelled, true);
    assert.ok(outcome.waited_seconds < 5, `it stopped when the client left (waited ${outcome.waited_seconds}s)`);
  } finally { s.engine.time = real; }
});
