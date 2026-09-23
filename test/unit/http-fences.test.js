// WHAT THE ENDPOINT REFUSES BEFORE THE PROTOCOL SEES A REQUEST — and how it says so.
//
// Streamable HTTP (both eras): "Servers MUST validate the Origin header on all incoming
// connections… If the Origin header is present and invalid, servers MUST respond with HTTP 403."
// Without it a web page can drive a server on the user's machine through DNS rebinding. And every
// refusal on the MCP endpoint is a JSON-RPC error a client can parse — including a body that is not
// JSON, a body over the limit, and a session this process no longer holds (which it may reclaim
// after idling: the client gets the 404 that makes it re-initialize).
//
// Context-lifecycle tests (the non-data kind this project allows): status codes, content types,
// the error codes the spec assigns, and which sessions survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/mcp-http.js';
import { originAllowed } from '../../src/server.js';

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

async function rpcError(res, status) {
  assert.equal(res.status, status);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.jsonrpc, '2.0');
  return body.error;
}

test('the Origin rule: no Origin and loopback origins pass, a foreign page gets 403, a listed one passes', async () => {
  assert.equal(originAllowed(undefined), true, 'a native client sends no Origin');
  for (const o of ['http://localhost:6274', 'http://127.0.0.1:3000', 'http://[::1]:8080']) assert.equal(originAllowed(o), true, o);
  assert.equal(originAllowed('https://evil.example'), false);
  assert.equal(originAllowed('https://evil.example', ['https://evil.example']), true, 'the operator may list an origin');
  assert.equal(originAllowed('not a url'), false);

  const s = await startServer({ app: { allowedOrigins: ['https://console.example'] } });
  try {
    // a foreign page is refused before anything else — even an initialize
    const err = await rpcError(await s.post(INIT, { origin: 'https://evil.example' }), 403);
    assert.match(err.message, /Origin/);
    // …on every verb of the endpoint
    assert.equal((await fetch(s.url, { method: 'GET', headers: { origin: 'https://evil.example' } })).status, 403);
    // a listed origin and a loopback one reach the protocol
    assert.equal((await s.post(INIT, { origin: 'https://console.example' })).status, 200);
    assert.equal((await s.post(INIT, { origin: 'http://localhost:6274' })).status, 200);
  } finally { await s.stop(); }
});

test('the optional Host allowlist refuses a Host the operator did not name', async () => {
  const s = await startServer({ app: { allowedHosts: ['mcp.internal:3000'] } });
  try {
    await rpcError(await s.post(INIT), 403); // fetch sends Host 127.0.0.1:<port>
  } finally { await s.stop(); }
});

test('a body that is not JSON is -32700, an oversized one is 413 — never an HTML page', async () => {
  const s = await startServer();
  try {
    assert.equal((await rpcError(await s.post('{ this is not json'), 400)).code, -32700);
    assert.equal((await rpcError(await s.post({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }), 413)).code, -32600);
  } finally { await s.stop(); }
});

test('an idle session is reclaimed and answers 404, so the client re-initializes', async () => {
  const s = await startServer({ app: { sessionIdleMs: 300 } });
  try {
    const init = await s.post(INIT);
    const sid = init.headers.get('mcp-session-id');
    assert.equal((await s.post(LIST, { 'mcp-session-id': sid })).status, 200, 'alive while used');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await rpcError(await s.post(LIST, { 'mcp-session-id': sid }), 404)).code, -32001);
    assert.equal(s.app.locals.sessions.size, 0, 'and its server and transport are gone');
  } finally { await s.stop(); }
});

test('at most maxSessions are held: the least recently used one goes first', async () => {
  const s = await startServer({ app: { maxSessions: 2 } });
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await s.post(INIT)).headers.get('mcp-session-id'));
      if (i === 1) await s.post(LIST, { 'mcp-session-id': ids[0] }); // the first is used again: the second is now the oldest
    }
    assert.equal(s.app.locals.sessions.size, 2);
    assert.equal((await s.post(LIST, { 'mcp-session-id': ids[0] })).status, 200, 'recently used — kept');
    assert.equal((await s.post(LIST, { 'mcp-session-id': ids[1] })).status, 404, 'least recently used — reclaimed');
    assert.equal((await s.post(LIST, { 'mcp-session-id': ids[2] })).status, 200, 'newest — kept');
  } finally { await s.stop(); }
});
