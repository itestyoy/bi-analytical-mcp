// THE STATELESS REVISION (2026-07-28) ON THE SAME ENDPOINT AS THE SESSION ONE.
//
// A modern client sends no initialize and holds no session: each request carries its protocol
// version and capabilities in `_meta`, and mirrors method and target into headers. What the spec
// requires of a server, checked the way a client meets it: server/discover exists; the headers must
// agree with the body (HeaderMismatch -32020, 400); a missing `_meta` field is -32602; an unknown
// version is UnsupportedProtocolVersion -32022 naming the supported ones; an unknown method is 404
// with -32601 (the JSON-RPC body is what tells a modern client this is not a legacy server);
// every result carries resultType and the server's identity; lists carry caching hints; progress
// flows on the request's own SSE stream; closing that stream cancels the call.
//
// Context-lifecycle tests (the non-data kind this project allows): the protocol envelope. The
// payloads of the tools are asserted elsewhere, on data.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, V } from '../helpers/mcp-http.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

test('server/discover: versions of both eras, capabilities with the three extensions, identity, caching', async () => {
  const r = await s.modern('server/discover');
  assert.equal(r.status, 200);
  const res = r.body.result;
  assert.equal(res.resultType, 'complete');
  assert.equal(res.supportedVersions[0], V);
  assert.ok(res.supportedVersions.includes('2025-11-25'), 'a dual-era server names its legacy versions too');
  assert.deepEqual(Object.keys(res.capabilities.extensions).sort(), ['io.modelcontextprotocol/skills', 'io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/ui']);
  assert.ok(res.capabilities.tools && res.capabilities.resources);
  assert.equal(res._meta['io.modelcontextprotocol/serverInfo'].name, 'dbt-semantic-mcp');
  assert.ok(res.ttlMs >= 0 && res.cacheScope === 'public');
  assert.ok(typeof res.instructions === 'string' && res.instructions.length > 0);
});

test('lists carry caching hints and results carry resultType', async () => {
  for (const m of ['tools/list', 'resources/list', 'resources/templates/list', 'skills/list']) {
    const r = await s.modern(m);
    assert.equal(r.status, 200, m);
    assert.equal(r.body.result.resultType, 'complete', m);
    assert.ok(Number.isInteger(r.body.result.ttlMs) && r.body.result.ttlMs >= 0, m);
    assert.ok(['public', 'private'].includes(r.body.result.cacheScope), m);
  }
});

test('headers must agree with the body: HeaderMismatch -32020 with 400', async () => {
  const cases = [
    { headers: { 'mcp-protocol-version': null }, why: 'protocol version header missing' },
    { headers: { 'mcp-method': 'tools/list' }, why: 'Mcp-Method differs from the body' },
    { headers: { 'mcp-method': null }, why: 'Mcp-Method missing' },
    { headers: { 'mcp-name': 'semantic_index' }, why: 'Mcp-Name differs from params.name' },
    { headers: { 'mcp-name': null }, why: 'Mcp-Name missing on tools/call' },
    { headers: { 'mcp-protocol-version': '2025-11-25' }, why: 'header version differs from _meta' },
  ];
  for (const c of cases) {
    const r = await s.modern('tools/call', { name: 'time', arguments: { seconds: 0 } }, { headers: c.headers });
    assert.equal(r.status, 400, c.why);
    assert.equal(r.body.error.code, -32020, `${c.why}: ${r.body.error.message}`);
  }
  // a name outside the plain-ASCII header set travels base64-encoded, and is decoded before comparing
  const enc = `=?base64?${Buffer.from('time').toString('base64')}?=`;
  const ok = await s.modern('tools/call', { name: 'time', arguments: { seconds: 0 } }, { headers: { 'mcp-name': enc } });
  assert.equal(ok.status, 200);
});

test('missing _meta fields are -32602; an unknown version is -32022 naming what is supported', async () => {
  const noCaps = await s.post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V } } }, { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' });
  assert.equal(noCaps.status, 400);
  assert.equal((await noCaps.json()).error.code, -32602);

  const future = await s.post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } } }, { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' });
  assert.equal(future.status, 400);
  const e = (await future.json()).error;
  assert.equal(e.code, -32022);
  assert.equal(e.data.requested, '2099-01-01');
  assert.ok(e.data.supported.includes(V));
});

test('an unknown method is 404 with -32601; a removed one (ping) too', async () => {
  for (const m of ['nope/nothing', 'ping', 'logging/setLevel']) {
    const r = await s.modern(m);
    assert.equal(r.status, 404, m);
    assert.equal(r.body.error.code, -32601, m);
  }
});

test('a notification is 202 with no body; a batch and a null id are invalid requests', async () => {
  const n = await s.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} } } }, { 'mcp-protocol-version': V, 'mcp-method': 'notifications/cancelled' });
  assert.equal(n.status, 202);
  assert.equal(await n.text(), '');
  const nullId = await s.post({ jsonrpc: '2.0', id: null, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {} } } }, { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' });
  assert.equal((await nullId.json()).error.code, -32600);
});

test('a stale Mcp-Session-Id is ignored on a modern request (no sessions in this revision)', async () => {
  const r = await s.modern('tools/list', {}, { headers: { 'mcp-session-id': '00000000-0000-4000-8000-000000000000' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.result.tools.length > 0);
});

test('tools/call: an unknown tool — or a private engine method — is -32602, never a dispatch', async () => {
  for (const name of ['nope', '_draftStart', 'close', 'gc', 'constructor']) {
    const r = await s.modern('tools/call', { name, arguments: {} });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.error.code, -32602, name);
  }
});

test('progress travels on the request\'s own SSE stream, before the final response', async () => {
  const r = await s.modern('tools/call', { name: 'time', arguments: { seconds: 1 } }, { meta: { progressToken: 'p-1' } });
  assert.match(r.type, /text\/event-stream/);
  const progress = r.events.filter((m) => m.method === 'notifications/progress');
  assert.ok(progress.length >= 2, `heartbeats every 200ms over 1s (got ${progress.length})`);
  assert.ok(progress.every((m) => m.params.progressToken === 'p-1'));
  const values = progress.map((m) => m.params.progress);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'progress increases');
  assert.equal(r.events.at(-1).id !== undefined, true, 'the response closes the stream');
  assert.equal(JSON.parse(r.body.result.content[0].text).waited_seconds, 1);
});

test('closing the request stream cancels the call (the transport\'s cancellation signal)', async () => {
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
    assert.ok(outcome, 'the call ended long before its 20 seconds');
    assert.equal(outcome.cancelled, true);
    assert.ok(outcome.waited_seconds < 5, `it stopped when the client left (waited ${outcome.waited_seconds}s)`);
  } finally { s.engine.time = real; }
});
