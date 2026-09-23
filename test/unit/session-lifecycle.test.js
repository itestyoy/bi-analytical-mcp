// WHAT A CLIENT IS TOLD WHEN ITS SESSION IS GONE — the HTTP contract of the streamable transport.
//
// Sessions live in this process, so every deploy invalidates the ids clients are holding. What the
// client does about that is decided by the status code alone: the spec says an unknown Mcp-Session-Id
// is 404, and a 404 is what makes a client start a new session ("it MUST start a new session by
// sending a new InitializeRequest without a session ID attached"). A 400 carries no such meaning —
// the client can only retry the same doomed request. That was observed in production: one user got
// an error on every call for 16+ minutes after a restart, on a healthy server, until the connector
// was removed and re-added by hand, while everyone else was fine.
//
// The trap had a second jaw: `initialize` sent WITH the stale header was refused too, so even a
// client that tried to recover could not, unless it dropped the header by itself.
//
// Context-lifecycle tests (the non-data kind this project allows): what the transport answers, with
// which status and which content type. No warehouse is involved — none of this reaches a tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { createApp } from '../../src/server.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

/** One server process' worth of state: a fresh app with its own in-memory session table. */
async function startServer() {
  const engine = new Engine({
    catalog: loadCatalog(CATALOG, {}),
    contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'sess-')) }),
  });
  const server = createServer(createApp(engine));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    url,
    async post(body, sessionId) {
      return fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
    },
    async get(sessionId) {
      return fetch(url, { method: 'GET', headers: { accept: 'text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) } });
    },
    async del(sessionId) {
      return fetch(url, { method: 'DELETE', headers: { ...(sessionId ? { 'mcp-session-id': sessionId } : {}) } });
    },
    async stop() { await new Promise((resolve) => server.close(resolve)); engine.close?.(); },
  };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } },
};
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/** The body of a refusal must be a JSON-RPC error, not Express' HTML page — the client parses it. */
async function assertJsonRpcError(res, status) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}`);
  assert.match(res.headers.get('content-type') || '', /application\/json/, 'a client cannot parse an HTML error page');
  const body = await res.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.ok(typeof body.error?.message === 'string' && body.error.message.length > 0, 'the error says what happened');
  return body;
}

test('a session id this process does not know is 404 — the only answer that makes a client re-initialize', async () => {
  const first = await startServer();
  const second = await startServer(); // the same server after a restart: new process, empty session table
  try {
    const init = await first.post(INITIALIZE);
    assert.equal(init.status, 200);
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid, 'initialize hands out a session id');
    // that id works where it was issued…
    assert.equal((await first.post(TOOLS_LIST, sid)).status, 200);

    // …and after a restart it is unknown. 404, with a body that says what to do.
    const stale = await second.post(TOOLS_LIST, sid);
    const body = await assertJsonRpcError(stale, 404);
    assert.match(body.error.message, /initialize/i, 'and it names the way out');
    // the stream and the teardown answer the same way
    await assertJsonRpcError(await second.get(sid), 404);
    await assertJsonRpcError(await second.del(sid), 404);
  } finally { await first.stop(); await second.stop(); }
});

test('initialize ignores the session id header, so a client holding a dead id can always recover', async () => {
  const server = await startServer();
  try {
    // the exact shape that used to trap a client: initialize WITH an id this process never issued
    const res = await server.post(INITIALIZE, '00000000-0000-4000-8000-000000000000');
    assert.equal(res.status, 200, 'a stale header must not block initialization');
    const fresh = res.headers.get('mcp-session-id');
    assert.ok(fresh && fresh !== '00000000-0000-4000-8000-000000000000', 'a NEW session is issued');
    assert.equal((await server.post(TOOLS_LIST, fresh)).status, 200, 'and the new session works');
  } finally { await server.stop(); }
});

test('re-initializing on a LIVE session replaces it instead of failing', async () => {
  const server = await startServer();
  try {
    const first = (await server.post(INITIALIZE)).headers.get('mcp-session-id');
    const again = await server.post(INITIALIZE, first);
    assert.equal(again.status, 200);
    const second = again.headers.get('mcp-session-id');
    assert.ok(second && second !== first, 'the caller gets a new session');
    assert.equal((await server.post(TOOLS_LIST, second)).status, 200);
    // the replaced one is closed and gone — a caller still holding it is told so, and told how to recover
    await assertJsonRpcError(await server.post(TOOLS_LIST, first), 404);
  } finally { await server.stop(); }
});

test('no session id at all (and not initialize) is 400 — a different mistake with a different answer', async () => {
  const server = await startServer();
  try {
    const post = await server.post(TOOLS_LIST);
    const body = await assertJsonRpcError(post, 400);
    assert.match(body.error.message, /Mcp-Session-Id/i);
    await assertJsonRpcError(await server.get(), 400);
  } finally { await server.stop(); }
});
