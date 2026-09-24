// A RESTART LOSES NOTHING A CLIENT HOLDS.
//
// The server is stateless (the SDK's per-request serving): no session lives in the process, so a
// deploy invalidates nothing. A client connected before the restart keeps calling after it with no
// new handshake — the failure this replaced was a client stuck on 400/404 answers for a session id
// the new process had never issued, until the connector was re-added by hand. A stale
// Mcp-Session-Id is simply ignored, and the 2025 session operations (the GET stream, DELETE) are
// answered 405, which a client reads as "this server keeps no sessions".
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
    port: server.address().port,
    async stop() { await app.locals.close(); await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); services.close(); engine.close?.(); },
  };
}

test('a client connected before a restart keeps working after it, with no new handshake', async () => {
  const first = await serveOn(0);
  const url = new URL(`http://127.0.0.1:${first.port}/mcp`);
  const client = new Client({ name: 'survivor', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  assert.equal(JSON.parse((await client.callTool({ name: 'time', arguments: { seconds: 0 } })).content[0].text).ok, true);

  await first.stop(); // the deploy
  // (the old process closed its sockets; give the client's connection pool the moment it takes to
  // see that, as it has in any real restart — this is transport, not session, state)
  await new Promise((r) => setTimeout(r, 200));
  const second = await serveOn(first.port);
  try {
    const after = await client.callTool({ name: 'experiment', arguments: { action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 } });
    assert.equal(JSON.parse(after.content[0].text).n_per_group, 3841, 'the same client, the next call, a real answer');
  } finally { await client.close().catch(() => {}); await second.stop(); }
});

test('a stale session id is ignored on initialize, and the 2025 session operations are 405', async () => {
  const srv = await serveOn(0);
  const url = `http://127.0.0.1:${srv.port}/mcp`;
  try {
    const init = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('mcp-session-id'), null, 'no session is minted');
    for (const method of ['GET', 'DELETE']) assert.equal((await fetch(url, { method, headers: { accept: 'text/event-stream' } })).status, 405, method);
  } finally { await srv.stop(); }
});
