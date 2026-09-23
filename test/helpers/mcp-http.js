// A real HTTP server around a real Engine, for the protocol tests: both eras on one endpoint, the
// way a client meets them. No warehouse — the tools these tests call (time, experiment,
// semantic_index) compute in-process.

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { loadRecipes } from '../../src/recipes.js';
import { assetPath } from '../../src/runtime-assets.js';
import { createApp } from '../../src/server.js';
import { createServices } from '../../src/mcp-surface.js';

export const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
export const V = '2026-07-28';
export const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
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

  /** A 2026-07-28 request, with the headers a conforming client sends (override any; null drops one). */
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
    for (const k of Object.keys(all)) if (all[k] === null) delete all[k]; // null = send without it
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

  /** A legacy (initialize + session) client through the SDK. */
  async function legacyClient(capabilities = {}) {
    const client = new Client({ name: 'legacy-test', version: '0' }, { capabilities });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }

  return {
    url, engine, services, app, modern, post, legacyClient,
    async stop() { await new Promise((resolve) => server.close(resolve)); app.locals.close(); services.close(); engine.close?.(); },
  };
}
