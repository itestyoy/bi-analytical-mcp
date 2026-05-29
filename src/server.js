// Streamable-HTTP MCP server exposing the declarative dbt Semantic Layer tools.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadCatalog } from './catalog.js';
import { ContextManager } from './context-manager.js';
import { DbtRunner } from './dbt-runner.js';
import { Engine } from './engine.js';

const TOOL_DESCRIPTIONS = {
  describe_catalog: 'Return the registry: models, events, event properties (with types), join-reachable group-by paths, and allowed enums. Call BEFORE creating a model.',
  create_semantic_model: 'Declaratively create/augment semantic models for a task (one SM per table) and metrics, in an isolated context. Omit context_id for a new task; pass it to extend the same context. Renders YAML + dbt parse.',
  query_semantic_model: 'Run a query (mf query, dbt Core) against a context. metrics + group_by + where are validated against the context.',
  update_semantic_model: 'Add/remove task measures, dimensions or metrics for a table SM within a context; re-parses.',
  delete_semantic_model: 'Remove a table SM task additions (and dependent metrics with cascade) from a context.',
  drop_context: 'Tear down an entire isolated context (files + artifacts).',
  list_contexts: 'List active contexts.',
  describe_context: 'Describe a context: tasks, SMs, measures, metrics, reachable group-by paths.',
};

const ASYNC_TOOLS = new Set(['create_semantic_model', 'query_semantic_model', 'update_semantic_model', 'delete_semantic_model']);

export function buildToolDefs(engine) {
  return Object.entries(engine.schemas).map(([name, inputSchema]) => ({
    name,
    description: TOOL_DESCRIPTIONS[name] || name,
    inputSchema,
  }));
}

export function makeMcpServer(engine) {
  const server = new Server(
    { name: 'dbt-semantic-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolDefs(engine) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (typeof engine[name] !== 'function') {
      return errorResult(`unknown tool: ${name}`);
    }
    try {
      const result = ASYNC_TOOLS.has(name) ? await engine[name](args || {}) : engine[name](args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResult(err?.message || String(err), err?.stage, err?.field);
    }
  });

  return server;
}

function errorResult(message, stage, field) {
  const payload = { ok: false, error: { stage: stage || 'error', message, ...(field ? { field } : {}) } };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function makeEngine(opts = {}) {
  const catalogPath = opts.catalogPath || process.env.CATALOG_PATH || join(process.cwd(), 'config', 'catalog.json');
  const catalog = loadCatalog(catalogPath);
  const baseProjectDir = opts.baseProjectDir || process.env.DBT_BASE_PROJECT;
  const ctxs = new ContextManager({
    baseProjectDir,
    workspaceRoot: opts.workspaceRoot || process.env.MCP_WORKSPACE,
  });
  const runner = opts.runner !== undefined
    ? opts.runner
    : baseProjectDir
      ? new DbtRunner({ dbtBin: process.env.DBT_BIN || 'dbt', mfBin: process.env.MF_BIN || 'mf', profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir })
      : null;
  return new Engine({ catalog, contextManager: ctxs, runner });
}

export function createApp(engine) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const transports = {}; // sessionId -> transport

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? transports[sid] : undefined;
    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send initialize first.' }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; },
      });
      transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
      const server = makeMcpServer(engine);
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionEndpoint = async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const transport = sid && transports[sid];
    if (!transport) { res.status(400).send('Invalid or missing session id'); return; }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', sessionEndpoint);
  app.delete('/mcp', sessionEndpoint);
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return app;
}

// Entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const engine = makeEngine();
  const app = createApp(engine);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`dbt-semantic-mcp streamable-HTTP on :${port}/mcp`));
}
