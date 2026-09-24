// A real HTTP server around a real Engine, for the protocol tests — served the way production
// serves it (src/server.js createApp: the SDK v2 handler), reached the way a client reaches it:
// through the OFFICIAL client (@modelcontextprotocol/client) in either protocol revision, or with
// raw requests where a test is about the wire itself. No warehouse — the tools these tests call
// (time, experiment, semantic_index) compute in-process.

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { loadRecipes } from '../../src/recipes.js';
import { assetPath } from '../../src/runtime-assets.js';
import { createApp } from '../../src/server.js';
import { createServices } from '../../src/mcp-surface.js';

export const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
export const V = '2026-07-28';
export const TASK_CAPS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

export function makeEngine({ recipes = true } = {}) {
  const catalog = loadCatalog(CATALOG, {});
  return new Engine({
    catalog,
    recipes: recipes ? loadRecipes(assetPath('systemRecipes'), '', { dialect: catalog.dialect, python: false }) : undefined,
    contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mcp-http-')) }),
  });
}

export async function startServer({ engine = makeEngine(), services: serviceOpts = {}, app: appOpts = {} } = {}) {
  const services = createServices(engine, { progressEveryMs: 200, taskAfterMs: 300, taskPollMs: 100, ...serviceOpts });
  const app = createApp(engine, { services, ...appOpts });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let seq = 0;
  const clients = [];

  /**
   * The official client. `era: 'legacy'` — the 2025 initialize handshake (the client's default,
   * what today's hosts speak); `era: 'modern'` — pinned to 2026-07-28 (server/discover, per-request
   * envelope). `capabilities` are the client's own.
   */
  async function client({ era = 'legacy', capabilities = {} } = {}) {
    const c = new Client({ name: `test-${era}`, version: '0' }, { capabilities, ...(era === 'modern' ? { versionNegotiation: { mode: { pin: V } } } : {}) });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(c);
    return c;
  }

  /** A raw 2026-07-28 request with the headers a conforming client sends (null drops one). */
  async function modern(method, params = {}, { caps = {}, headers = {}, meta = {}, signal } = {}) {
    const name = params.name ?? params.uri ?? params.taskId;
    const all = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': V,
      'mcp-method': method,
      ...(name !== undefined ? { 'mcp-name': String(name) } : {}),
      ...headers,
    };
    for (const k of Object.keys(all)) if (all[k] === null) delete all[k];
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: all,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': caps, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' }, ...meta } } }),
    });
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    const events = type.includes('text/event-stream')
      ? text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)))
      : null;
    const body = events ? events.find((m) => m.id !== undefined) : text ? JSON.parse(text) : null;
    return { status: res.status, type, body, events };
  }

  /** A raw POST to the endpoint. */
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  return {
    url, engine, services, app, client, modern, post,
    async stop() {
      for (const c of clients) await c.close().catch(() => {});
      await app.locals.close();
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
      services.close();
      engine.close?.();
    },
  };
}
