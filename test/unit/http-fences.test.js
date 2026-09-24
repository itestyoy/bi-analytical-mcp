// WHAT THE ENDPOINT REFUSES BEFORE THE PROTOCOL SEES A REQUEST — and how it says so.
//
// Streamable HTTP: "Servers MUST validate the Origin header on all incoming connections… If the
// Origin header is present and invalid, servers MUST respond with HTTP 403." Without it a web page
// can drive a server on the user's machine through DNS rebinding. The SDK's Express app performs
// the check; the server passes it the list explicitly so it applies on any bind (a container binds
// 0.0.0.0, where the SDK would otherwise leave it off). And every refusal is a JSON-RPC error a
// client can parse — including a body that is not JSON and a body over the limit.
//
// Context-lifecycle tests (the non-data kind this project allows): status codes and error codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/mcp-http.js';

const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

async function rpcError(res, status) {
  assert.equal(res.status, status);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.jsonrpc, '2.0');
  return body.error;
}

test('Origin: none and loopback pass, a foreign page gets 403, a listed one passes — on a 0.0.0.0 bind too', async () => {
  const s = await startServer({ app: { host: '0.0.0.0', allowedOrigins: ['console.example'] } });
  try {
    assert.equal((await s.post(LIST, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(s.url, { method: 'GET', headers: { origin: 'https://evil.example' } })).status, 403, 'every verb');
    for (const origin of [undefined, 'http://localhost:6274', 'http://127.0.0.1:3000', 'https://console.example']) {
      assert.equal((await s.post(LIST, origin ? { origin } : {})).status, 200, origin || 'no Origin');
    }
  } finally { await s.stop(); }
});

test('a refusal leaves one log line naming the origin, so "cannot reach the server" has a visible reason', async () => {
  const s = await startServer({ app: { host: '0.0.0.0' } });
  const lines = [];
  const real = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  try {
    await s.post(LIST, { origin: 'https://desktop-host.example' });
    await new Promise((r) => setTimeout(r, 20)); // the line is written when the response finishes
  } finally { console.error = real; await s.stop(); }
  const line = lines.find((l) => l.includes('refused'));
  assert.ok(line, `no refusal line among: ${lines.join(' | ')}`);
  for (const part of ['403', 'origin=https://desktop-host.example', 'MCP_ALLOWED_ORIGINS']) assert.ok(line.includes(part), `${part} missing in: ${line}`);
});

test('the optional Host allowlist refuses a Host the operator did not name', async () => {
  const s = await startServer({ app: { allowedHosts: ['mcp.internal'] } });
  try {
    assert.equal((await s.post(LIST)).status, 403); // fetch sends Host 127.0.0.1:<port>
  } finally { await s.stop(); }
});

test('a body that is not JSON is -32700, an oversized one is 413 — never an HTML page', async () => {
  const s = await startServer();
  try {
    assert.equal((await rpcError(await s.post('{ this is not json'), 400)).code, -32700);
    assert.equal((await rpcError(await s.post({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }), 413)).code, -32600);
  } finally { await s.stop(); }
});
