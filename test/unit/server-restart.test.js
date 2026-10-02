// A RESTART LOSES NOTHING A CLIENT HOLDS.
//
// A 2025 client's initialize opens a session (src/legacy-sessions.js): its cancellation and its GET
// stream live there. A session id the new process never issued is served statelessly, so a client
// connected before the restart keeps calling after it with no new handshake — the failure this
// guards against was a client stuck on 400/404 answers for such an id, until the connector was
// re-added by hand. Without a live session the 2025 session operations (GET, DELETE) are 405.
//
// Context-lifecycle tests: what survives a restart, and the status codes around sessions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { makeEngine } from '../helpers/mcp-http.js';
import { createApp } from '../../src/server.js';
import { createServices } from '../../src/mcp-surface.js';

async function serveOn(port) {
  const engine = makeEngine();
  const services = createServices(engine);
  const app = createApp(engine, { services });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    engine,
    port: server.address().port,
    async stop() { await app.locals.close(); await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); services.close(); engine.close?.(); },
  };
}

test('a client connected before a restart keeps working after it, with no new handshake', async () => {
  const first = await serveOn(0);
  const url = new URL(`http://127.0.0.1:${first.port}/mcp`);
  const client = new Client({ name: 'survivor', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  assert.equal(JSON.parse((await client.callTool({ name: 'time', arguments: { request: { seconds: 0 } } })).content[0].text).ok, true);

  await first.stop(); // the deploy
  // (the old process closed its sockets; give the client's connection pool the moment it takes to
  // see that, as it has in any real restart — this is transport, not session, state)
  await new Promise((r) => setTimeout(r, 200));
  const second = await serveOn(first.port);
  try {
    const after = await client.callTool({ name: 'experiment', arguments: { request: { action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 } } });
    assert.equal(JSON.parse(after.content[0].text).n_per_group, 3841, 'the same client, the next call, a real answer');
  } finally { await client.close().catch(() => {}); await second.stop(); }
});

test('an initialize opens a session — a stale id with it is dropped; without a live session GET and DELETE are 405', async () => {
  const srv = await serveOn(0);
  const url = `http://127.0.0.1:${srv.port}/mcp`;
  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  try {
    const init = await fetch(url, {
      method: 'POST',
      headers: { ...H, 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    await init.text();
    assert.equal(init.status, 200);
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid && sid !== '00000000-0000-4000-8000-000000000000', 'a new session is minted');
    for (const method of ['GET', 'DELETE']) assert.equal((await fetch(url, { method, headers: { accept: 'text/event-stream' } })).status, 405, `${method} without a session`);
    // the session's own GET stream, then DELETE ends it; its id is then a stale one, served as any
    const ctl = new AbortController();
    const stream = await fetch(url, { signal: ctl.signal, headers: { accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    ctl.abort();
    assert.equal((await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' } })).status, 200);
    const after = await fetch(url, { method: 'POST', headers: { ...H, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(after.status, 200, 'a closed session id is not a 404');
    assert.ok((await after.text()).includes('"tools"'));
  } finally { await srv.stop(); }
});

test('in a 2025 session the client\'s cancel stops the call, and no extension is offered', async () => {
  const srv = await serveOn(0);
  const client = new Client({ name: 'canceller', version: '0' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
    assert.ok(!/RESULT CARDS/.test(client.getInstructions() || ''), 'the Apps extension is 2026-07-28\'s');
    const real = srv.engine.time.bind(srv.engine);
    let outcome;
    srv.engine.time = async (input) => { outcome = await real(input); return outcome; };
    const ctl = new AbortController();
    const call = client.callTool({ name: 'time', arguments: { request: { seconds: 6 } } }, { signal: ctl.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    ctl.abort();
    await call;
    const t0 = Date.now();
    while (!outcome && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(outcome?.cancelled, true, 'notifications/cancelled reached the call in its session');
    assert.ok(outcome.waited_seconds < 5, `the work stopped (waited ${outcome.waited_seconds}s)`);
  } finally { await client.close().catch(() => {}); await srv.stop(); }
});
