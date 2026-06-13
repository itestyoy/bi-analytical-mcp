// Streamable-HTTP MCP server exposing the declarative dbt Semantic Layer tools.

import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdirSync } from 'node:fs';
import { loadCatalog, validateDbtProject, groundCatalogToPhysical } from './catalog.js';
import { loadRecipes } from './recipes.js';
import { ContextManager } from './context-manager.js';
import { DbtRunner } from './dbt-runner.js';
import { Engine } from './engine.js';
import { BackgroundIndexer } from './value-index.js';

const TOOL_DESCRIPTIONS = {
  semantic_index: 'THE data-exploration entry point — call it FIRST and whenever unsure what a field means. One progressive index over meaning + real values + completeness + freshness. No args → overview (models, event names, event_semantics = which event marks install/session/purchase, group-by paths, value-index freshness). Exactly one view key to drill: { model } → columns + dimension attributes with real sample values + physical columns; { event } → the properties that event carries; { property } → one column\'s full passport (spec/unit, real value distribution — pageable, NULL coverage per event distinguishing expected NULLs from data gaps, indexing history; accepts bare event properties and "users.country"-style attributes); { search } → FUZZY search over events/properties/attributes/VALUES/recipes (typo- and paraphrase-tolerant: "retenton"→retention recipe, "germny"→Germany value; exact hits first, each scored, fuzzy:false for substring-only); { status: true } → value-index sync state + background query jobs; { run } → one sync run\'s per-property breakdown.',
  create_semantic_model: 'Declaratively create/augment semantic models for a task (one SM per table) and metrics, in an isolated context. Omit context_id for a new task; pass it to extend the same context. Validated and registered in the context.',
  register_native_model: 'Build a derived dbt model from a declarative PIPELINE (where/derive/compute/unnest/join/aggregate/pivot/unpivot/window/order_by/limit + the match_recognize funnel stage), materialized as a table/view. Its ROWS ARE THE RESULT — returned directly and re-readable/sliceable with get_query_result (NOT query_semantic_model). The pipeline can join catalog sources (users/experiments) and aggregate internally, so it is self-contained; it is NOT re-exposed as a queryable semantic model with metrics/dimensions.',
  build_native_model: 'Build a derived dbt model from a PIPELINE, composed INCREMENTALLY (single `action`-driven tool): start a draft, add_step one stage at a time (where/derive/compute/unnest/join/aggregate/pivot/unpivot/window/order_by/limit + the match_recognize funnel stage) — each add_step validates the stage and returns the exact columns then available for the NEXT stage (pure schema, NOTHING materialized until the materialize step) — optionally preview the SQL, then materialize (the final step that builds + runs the model). The materialized model\'s ROWS ARE THE RESULT — returned directly and re-readable/sliceable with get_query_result (NOT query_semantic_model). Funnels are pipelines too: add a match_recognize stage, then slice it with a downstream join/aggregate (e.g. conversion by country).',
  update_native_model: 'Update a registered native model in place: regenerate it from a new pipeline spec and rebuild.',
  delete_native_model: 'Delete the native model built in a context: remove it and re-parse. Targeted alternative to drop_context (which tears down the whole context).',
  query_semantic_model: 'Run a metric query against a context. metrics + group_by + where are validated against the context. Pass materialize:true to persist the result and read it back (resilient); slow queries return a query_id to poll.',
  get_query_result: 'Poll a background (materialized) query by query_id, or fetch a known result table directly by {context_id, table}. Returns status (running/ready/error) and rows read from the materialized table.',
  list_query_jobs: 'List background query jobs and their status.',
  update_semantic_model: 'Add/remove task measures, dimensions or metrics for a table SM within a context; re-parses.',
  delete_semantic_model: 'Remove a table SM task additions (and dependent metrics with cascade) from a context.',
  drop_context: 'Tear down an entire isolated context (files + artifacts).',
  list_contexts: 'List active contexts.',
  describe_context: 'Describe a context: tasks, SMs, measures, metrics, reachable group-by paths.',
  ab_test: 'Run an A/B significance test on pre-aggregated group stats (compute per-group counts/means/ratio sums with a pipeline first). proportion → two-proportion z-test; mean → Welch t-test; ratio → delta-method test (analysis unit finer than randomization unit); cuped → variance reduction via a pre-experiment covariate. Returns lift (with a relative-lift CI), p-value, CI, significance, and a multiplicity-adjusted p-value per variant vs control.',
  srm_check: 'Sample Ratio Mismatch guardrail: χ² test that the observed per-group sizes match the intended split. p < 0.001 means randomization/logging is broken and the experiment is invalid — check before trusting any lift.',
  sample_size: 'Power / sample-size planning: given a baseline (proportion) or stddev (mean) and a target effect, return the required sample size per group; or given a sample size, return the minimum detectable effect (MDE). Tells a true null apart from an underpowered test.',
  list_recipes: 'List ready-made recipes (templates) for common analytics task types. Each carries a `hack` — the generalizable technique behind it — so you can pick the closest one and adapt its approach even to a novel task.',
  get_recipe: 'Get a recipe by id: a ready payload (create_semantic_model, or a native-model pipeline + ab_test mapping) + example queries, plus `notes` and a `hack` (the reusable technique to extrapolate to similar cases). Feed a pipeline payload through build_native_model (add its stages, then materialize).',
};

// Server-level documentation surfaced to the AI client (serverInfo.description):
// what this MCP is for and how to use it end-to-end.
const SERVER_DESCRIPTION = `Declarative semantic layer for product analytics.

WHAT IT DOES
You define "virtual" semantic models — measures, dimensions, and metrics — on the fly over a FIXED set of catalog data sources, and query them by name. You never write SQL. Everything you can reference (events, properties, user attributes, join paths) is enumerated by the catalog and enforced by schema, so you cannot name a field that does not exist.

DATA MODEL (fixed roles)
- events fact: one row per analytical event — a user id, a session id, an event timestamp (the time axis), an event_name, and typed event-data properties. ONLY per-event columns live here.
- users dimension: one row per user — attributes (country, platform, media_source, acquisition_type, install_date, ...). Reached by JOIN: group/filter via user__<attr> paths in metric queries (declare use_base_models: ['users']), or a join stage in pipelines. User attributes are NEVER columns of the fact.
- experiments: one row per user×experiment (experiment_name, variant_group, assigned_at, ended_at) — join to events by the user entity, window to the assignment period, aggregate per group, then ab_test/srm_check.
Funnels/sequences are built ONLY from events (a step = an event + an event_data property value).

WORKFLOW
1. semantic_index — discover the catalog PROGRESSIVELY. Call it first with no arguments for an overview (models, event names, group-by paths, event_semantics = which event marks install/session/purchase, value-index freshness), then drill down: semantic_index({ model }) for a model's columns and attributes (with REAL sample values), ({ event }) for the properties an event carries, ({ property }) for one property or a "users.country"-style attribute with its real value distribution, ({ search }) to find events/properties/attributes/values/recipes. The events fact has ~150 event-scoped properties, so they are fetched per event rather than all at once.
2. create_semantic_model — declare measures/dimensions/metrics for a task in an ISOLATED context (returns a context_id). Pass that context_id back to extend the same context.
   - For ordered multi-step funnels/paths (and any custom transform) use build_native_model: compose a PIPELINE one stage at a time (start → add_step* → materialize; each add_step shows the columns available next), building a model whose ROWS are the result — read/slice them with get_query_result (a pipeline context is not queried via query_semantic_model). It accepts a time_range and an internal pre-filter (event subset / user segment).
3. query_semantic_model — run metrics with group_by / where / order_by / time_range. Options: dry_run (preview, no run), explain (query plan, no run), materialize (persist the result and read it back; long queries return a query_id to poll), limit/offset.
4. get_query_result — poll a backgrounded query by query_id, or re-read/re-slice a stored result (where/group_by/aggregations/having) WITHOUT recomputing.

KEY CONCEPTS
- context_id: an isolated workspace; parallel tasks never collide. Manage via list_contexts / describe_context / drop_context.
- metric types: simple, ratio, cumulative, derived, conversion.
- group_by: { time: "metric_time", grain } for a time series, or an entity-qualified attribute path (e.g. user__country).
- recipes: list_recipes / get_recipe — ready-made templates for common task families (trends, segmentation, funnels, retention, cohorts, behavioral, conversion, progression, monetization, ads, economy, stickiness).`;

// Short one-paragraph summary for serverInfo.description (UI/catalog contexts).
const SERVER_SUMMARY = 'Declarative semantic layer for product analytics: declare virtual semantic models — measures, dimensions, metrics, and multi-step funnels — over fixed, catalog-enumerated data sources (an events fact + a user-attributes dimension + experiment assignments) and query them by name; you never write SQL. Start with semantic_index, then create_semantic_model / build_native_model, then query_semantic_model.';

const ASYNC_TOOLS = new Set(['create_semantic_model', 'register_native_model', 'build_native_model', 'update_native_model', 'delete_native_model', 'query_semantic_model', 'get_query_result', 'update_semantic_model', 'delete_semantic_model', 'semantic_index', 'describe_context', 'time']);

// Tools that still EXIST (schema + engine method + dispatch) but are no longer
// advertised to the AI — superseded by a newer tool. The code is kept so existing
// callers/recipes keep working and it can be re-exposed by deleting it from this set.
// register_native_model + update_native_model are the all-at-once create/edit path,
// superseded by the incremental build_native_model (to edit, rebuild with the same name).
const HIDDEN_TOOLS = new Set(['register_native_model', 'update_native_model']);

export function buildToolDefs(engine) {
  return Object.entries(engine.schemas)
    .filter(([name]) => !HIDDEN_TOOLS.has(name))
    .map(([name, inputSchema]) => ({
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = buildToolDefs(engine);
    logLine('list_tools', `→ ${tools.length} tools`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const started = Date.now();
    logLine(name, `▶ call ${summarizeArgs(args)}`);
    if (typeof engine[name] !== 'function') {
      logLine(name, '✗ unknown tool');
      return errorResult(`unknown tool: ${name}`);
    }
    try {
      const result = ASYNC_TOOLS.has(name) ? await engine[name](args || {}) : engine[name](args || {});
      logLine(name, `✓ ok in ${Date.now() - started}ms${summarizeResult(result)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      logLine(name, `✗ error in ${Date.now() - started}ms: ${err?.message || String(err)}${err?.field ? ` (field: ${err.field})` : ''}`);
      return errorResult(err?.message || String(err), err?.stage, err?.field);
    }
  });

  return server;
}

// ── console logging (to stderr) so every tool call is visible in the logs ──────
function logLine(tool, msg) {
  console.error(`[mcp] ${new Date().toISOString()} ${tool} ${msg}`);
}

/** Compact, truncated one-line view of the tool arguments. */
function summarizeArgs(args) {
  if (args === undefined || args === null) return '(no args)';
  let s;
  try { s = JSON.stringify(args); } catch { return '(unserializable args)'; }
  return s.length > 800 ? `${s.slice(0, 800)}… (${s.length} chars)` : s;
}

/** A short outcome hint from the result (status, row/result counts) without dumping it. */
function summarizeResult(result) {
  if (!result || typeof result !== 'object') return '';
  const bits = [];
  if ('ok' in result) bits.push(`ok=${result.ok}`);
  if (Array.isArray(result.rows)) bits.push(`rows=${result.rows.length}`);
  if (Array.isArray(result.results)) bits.push(`results=${result.results.length}`);
  if (result.context_id) bits.push(`ctx=${result.context_id}`);
  if (result.query_id) bits.push(`query_id=${result.query_id}`);
  if (result.status) bits.push(`status=${result.status}`);
  return bits.length ? ` [${bits.join(' ')}]` : '';
}

function errorResult(message, stage, field) {
  const payload = { ok: false, error: { stage: stage || 'error', message, ...(field ? { field } : {}) } };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

export async function makeEngine(opts = {}) {
  const baseProjectDir = opts.baseProjectDir || process.env.DBT_BASE_PROJECT;
  // Catalog source precedence: explicit CATALOG_PATH (a standalone catalog file) →
  // the dbt project itself (discover MCP-tagged models from its schema YAMLs) →
  // the bundled sample catalog. Dialect is resolved from env / the dbt profile.
  const catalogSource = opts.catalogPath || process.env.CATALOG_PATH || baseProjectDir || join(process.cwd(), 'config', 'catalog.yml');
  // MCP_REQUIRE_TIME_RANGE=1 (or anchor meta.mcp.require_time_range) blocks unbounded
  // (no time window) queries — the cost guardrail for partitioned warehouses.
  const requireTimeRange = process.env.MCP_REQUIRE_TIME_RANGE != null ? !/^(0|false|no|off)$/i.test(String(process.env.MCP_REQUIRE_TIME_RANGE).trim()) : undefined;
  const catalog = loadCatalog(catalogSource, { profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir, projectDir: baseProjectDir, requireTimeRange });
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
  // ONE shared db file (jobs + value index live in it as separate tables). Defaults to
  // <workspaceRoot>/mcp.sqlite; pin it elsewhere (e.g. a persistent volume) via MCP_DB.
  const dbPath = opts.dbPath || process.env.MCP_DB || join(ctxs.workspaceRoot, 'mcp.sqlite');
  // Ensure the parent dir exists so a custom path persists (a missing dir would make the
  // open fail and silently fall back to an in-memory store).
  try { mkdirSync(dirname(dbPath), { recursive: true }); } catch { /* best effort */ }
  // MCP_DB_RESET wipes the store (jobs + value index) on startup — a clean slate each run.
  // DEFAULT ON: reset unless explicitly disabled (MCP_DB_RESET=false/0/no/off).
  const resetDb = !/^(0|false|no|off)$/i.test(String(process.env.MCP_DB_RESET ?? 'true').trim());
  if (resetDb) console.error(`[mcp] ${new Date().toISOString()} MCP_DB_RESET on (default) — clearing the store on startup; set MCP_DB_RESET=false to keep it`);
  // GROUND the catalog to the physical warehouse BEFORE building the engine (its tool
  // schemas + value index derive from the catalog): a column the dbt schema declares but
  // the physical table lacks is pruned, so it never appears in any tool. Best-effort and
  // opt-out via MCP_GROUND_CATALOG=0 (e.g. offline/catalog-only dev).
  if (runner && baseProjectDir && !/^(0|false|no|off)$/i.test(String(process.env.MCP_GROUND_CATALOG ?? 'true').trim())) {
    try {
      const { pruned } = await groundCatalogToPhysical(catalog, runner, baseProjectDir);
      for (const [k, names] of Object.entries(pruned)) console.error(`[mcp] ${new Date().toISOString()} catalog grounding: '${k}' — excluded ${names.length} declared field(s) absent from the physical table: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`);
    } catch (e) { console.error(`[mcp] ${new Date().toISOString()} catalog grounding skipped: ${e?.message || e}`); }
  }
  return new Engine({ catalog, contextManager: ctxs, runner, recipes, queryTimeoutMs, dbPath, resetDb });
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
  const engine = await makeEngine();
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

  // Background value index: populate REAL event-property values from the warehouse
  // (top values + cardinality) for semantic_index. Initial pass is fire-and-forget
  // (start() does NOT await) so server startup is never blocked; then refreshes on
  // an unref'd interval. VALUE_INDEX_REFRESH_MS=0 → one initial pass, no schedule.
  const intervalMs = process.env.VALUE_INDEX_REFRESH_MS !== undefined ? Number(process.env.VALUE_INDEX_REFRESH_MS) : 21600000;
  const maxValues = Number(process.env.VALUE_INDEX_MAX_VALUES) || 50;
  const indexer = new BackgroundIndexer({ catalog: engine.catalog, runner: engine.runner, index: engine.valueIndex, baseProjectDir: engine.ctxs.baseProjectDir, intervalMs, maxValues, logger: (m) => console.error(`[mcp] ${new Date().toISOString()} value-index ${m}`) });
  indexer.start();

  // Graceful shutdown: stop accepting, close the warm sidecar + SQLite handle.
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${sig}, shutting down`);
    if (gcTimer) clearInterval(gcTimer);
    indexer.stop();
    httpServer.close(() => {});
    try { engine.close(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 200).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
