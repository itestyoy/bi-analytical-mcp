// Streamable-HTTP MCP server exposing the declarative dbt Semantic Layer tools.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { loadCatalog, validateDbtProject } from './catalog.js';
import { loadRecipes } from './recipes.js';
import { ContextManager } from './context-manager.js';
import { DbtRunner } from './dbt-runner.js';
import { Engine } from './engine.js';

const TOOL_DESCRIPTIONS = {
  describe_catalog: 'Return the registry: models with their REAL physical columns and dbt column descriptions, events, event properties (with types and descriptions), join-reachable group-by paths, and allowed enums. Call BEFORE creating a model.',
  create_semantic_model: 'Declaratively create/augment semantic models for a task (one SM per table) and metrics, in an isolated context. Omit context_id for a new task; pass it to extend the same context. Renders YAML + dbt parse.',
  register_native_model: 'Build a derived dbt model from a sequence spec (MATCH_RECOGNIZE funnel/path, target BigQuery) materialized as a view, and a semantic model on top. Kept separate from the semantic query; after registering, query its metrics/dimensions via query_semantic_model.',
  update_native_model: 'Update a registered native (MATCH_RECOGNIZE) model in place: regenerate the view + semantic model from a new sequence spec and rebuild (dbt run + parse).',
  delete_native_model: 'Delete a registered native model: remove its generated view + semantic model from the context and re-parse.',
  query_semantic_model: 'Run a query (mf query, dbt Core) against a context. metrics + group_by + where are validated against the context. Pass materialize:true to persist the result as a dbt table and read it back (resilient); slow queries return a query_id to poll.',
  get_query_result: 'Poll a background (materialized) query by query_id, or fetch a known result table directly by {context_id, table}. Returns status (running/ready/error) and rows read from the materialized table.',
  list_query_jobs: 'List background query jobs and their status.',
  update_semantic_model: 'Add/remove task measures, dimensions or metrics for a table SM within a context; re-parses.',
  delete_semantic_model: 'Remove a table SM task additions (and dependent metrics with cascade) from a context.',
  drop_context: 'Tear down an entire isolated context (files + artifacts).',
  list_contexts: 'List active contexts.',
  describe_context: 'Describe a context: tasks, SMs, measures, metrics, reachable group-by paths.',
  ab_test: 'Run an A/B significance test on pre-aggregated group stats (compute per-group n/conversions or mean+stddev with a pipeline first). proportion → two-proportion z-test; mean → Welch t-test. Returns lift, p-value, confidence interval and significance per variant vs control.',
  list_recipes: 'List ready-made recipes (templates) for common analytics task types. Each carries a `hack` — the generalizable technique behind it — so you can pick the closest one and adapt its approach even to a novel task.',
  get_recipe: 'Get a recipe by id: a ready payload (create_semantic_model, or a register_native_model pipeline + ab_test mapping) + example queries, plus `notes` and a `hack` (the reusable technique to extrapolate to similar cases).',
};

// Server-level documentation surfaced to the AI client (serverInfo.description):
// what this MCP is for and how to use it end-to-end.
const SERVER_DESCRIPTION = `Declarative semantic layer for product analytics.

WHAT IT DOES
You define "virtual" semantic models — measures, dimensions, and metrics — on the fly over a FIXED set of two data sources, and query them by name. You never write SQL. Everything you can reference (events, properties, user attributes, join paths) is enumerated by the catalog and enforced by schema, so you cannot name a field that does not exist.

DATA MODEL (exactly two sources)
- events fact: one row per analytical event — a user id, a session id, an event timestamp (the time axis), an event_name, and a JSON payload of typed event-data properties.
- users dimension: one row per user — categorical attributes (country, platform, media_source, acquisition_type, campaign_id, install_date, ...).
Funnels/sequences are built ONLY from events (a step = an event + an event_data property value). Segmentation joins user attributes to events by the user entity automatically at query time.

WORKFLOW
1. describe_catalog — discover the models, events, event properties, joinable group-by paths, and the columns of each table (with their dbt descriptions). Call this first.
2. create_semantic_model — declare measures/dimensions/metrics for a task in an ISOLATED context (returns a context_id). Pass that context_id back to extend the same context.
   - For ordered multi-step funnels/paths use register_native_model: it builds a per-user funnel model you can query like any other model, and accepts a pre-filter (time window / event subset / user segment) to narrow the data.
3. query_semantic_model — run metrics with group_by / where / order_by / time_range. Options: dry_run (preview, no run), explain (query plan, no run), materialize (persist the result and read it back; long queries return a query_id to poll), limit/offset.
4. get_query_result — poll a backgrounded query by query_id, or re-read/re-slice a stored result (where/group_by/aggregations/having) WITHOUT recomputing.

KEY CONCEPTS
- context_id: an isolated workspace; parallel tasks never collide. Manage via list_contexts / describe_context / drop_context.
- metric types: simple, ratio, cumulative, derived, conversion.
- group_by: { time: "metric_time", grain } for a time series, or an entity-qualified attribute path (e.g. user__country).
- recipes: list_recipes / get_recipe — ready-made templates for common task families (trends, segmentation, funnels, retention, cohorts, behavioral, conversion, progression, monetization, ads, economy, stickiness).`;

// Short one-paragraph summary for serverInfo.description (UI/catalog contexts).
const SERVER_SUMMARY = 'Declarative semantic layer for product analytics: declare virtual semantic models — measures, dimensions, metrics, and multi-step funnels — over two fixed, catalog-enumerated data sources (an events fact + a user-attributes dimension) and query them by name; you never write SQL. Start with describe_catalog, then create_semantic_model / register_native_model, then query_semantic_model.';

const ASYNC_TOOLS = new Set(['create_semantic_model', 'register_native_model', 'update_native_model', 'delete_native_model', 'query_semantic_model', 'get_query_result', 'update_semantic_model', 'delete_semantic_model', 'describe_catalog', 'describe_context', 'time']);

export function buildToolDefs(engine) {
  return Object.entries(engine.schemas).map(([name, inputSchema]) => ({
    name,
    description: TOOL_DESCRIPTIONS[name] || name,
    inputSchema,
  }));
}

export function makeMcpServer(engine) {
  const server = new Server(
    { name: 'dbt-semantic-mcp', version: '0.1.0', description: SERVER_SUMMARY },
    { capabilities: { tools: {} }, instructions: SERVER_DESCRIPTION },
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
  const baseProjectDir = opts.baseProjectDir || process.env.DBT_BASE_PROJECT;
  // Catalog source precedence: explicit CATALOG_PATH (a standalone catalog file) →
  // the dbt project itself (discover MCP-tagged models from its schema YAMLs) →
  // the bundled sample catalog. Dialect is resolved from env / the dbt profile.
  const catalogSource = opts.catalogPath || process.env.CATALOG_PATH || baseProjectDir || join(process.cwd(), 'config', 'catalog.yml');
  const catalog = loadCatalog(catalogSource, { profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir, projectDir: baseProjectDir });
  // Fail fast if the dbt project doesn't implement the required macro(s) / model
  // nodes the server depends on (unless explicitly skipped, e.g. catalog-only dev).
  if (baseProjectDir && process.env.SKIP_PROJECT_VALIDATION !== '1') validateDbtProject(baseProjectDir, catalog);
  const recipesPath = opts.recipesPath || process.env.RECIPES_PATH || join(process.cwd(), 'config', 'recipes.json');
  const recipes = existsSync(recipesPath) ? loadRecipes(recipesPath) : undefined;
  const ctxs = new ContextManager({
    baseProjectDir,
    workspaceRoot: opts.workspaceRoot || process.env.MCP_WORKSPACE,
    timeSpineDialect: catalog.dialect,
  });
  const runner = opts.runner !== undefined
    ? opts.runner
    : baseProjectDir
      ? new DbtRunner({ dbtBin: process.env.DBT_BIN || 'dbt', mfBin: process.env.MF_BIN || 'mf', profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir })
      : null;
  const queryTimeoutMs = (Number(process.env.QUERY_TIMEOUT_SECONDS) || 60) * 1000;
  const jobsDbPath = opts.jobsDbPath || join(ctxs.workspaceRoot, 'jobs.sqlite');
  return new Engine({ catalog, contextManager: ctxs, runner, recipes, queryTimeoutMs, jobsDbPath });
}

export function createApp(engine) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  // No authentication: run behind your own network boundary / proxy as needed.
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
  const host = process.env.HOST || '127.0.0.1'; // localhost by default; set HOST=0.0.0.0 in containers
  const httpServer = app.listen(port, host, () => console.log(`dbt-semantic-mcp streamable-HTTP on ${host}:${port}/mcp`));

  // Optional periodic reclamation of idle contexts (bounds workspace growth).
  const ttlMs = Number(process.env.CONTEXT_TTL_MS) || 0;
  let gcTimer;
  if (ttlMs > 0) {
    gcTimer = setInterval(() => { try { engine.gc(ttlMs); } catch { /* noop */ } }, Math.min(ttlMs, 300000));
    gcTimer.unref?.();
  }

  // Graceful shutdown: stop accepting, close the warm sidecar + SQLite handle.
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${sig}, shutting down`);
    if (gcTimer) clearInterval(gcTimer);
    httpServer.close(() => {});
    try { engine.close(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 200).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
