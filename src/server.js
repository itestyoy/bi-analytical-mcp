// Streamable-HTTP MCP server exposing the declarative dbt Semantic Layer tools.
//
// Built on the official MCP SDK v2 (@modelcontextprotocol/server), which implements protocol
// revision 2026-07-28 and serves every earlier revision from the same factory: `createMcpHandler`
// builds a fresh server per request (src/mcp-server.js) and decides by itself how the request is
// spoken — there is no second code path here for an older client, and no session state to lose on
// a restart.

import { join, dirname } from 'node:path';
import { createMcpHandler, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import express from 'express';
import { mkdirSync } from 'node:fs';
import { loadCatalog, validateDbtProject, groundCatalogToPhysical, gatePythonRuntime } from './catalog.js';
import { loadRecipes } from './recipes.js';
import { assetPath } from './runtime-assets.js';
import { frameProfile } from './python-model.js';
import { ContextManager } from './context-manager.js';
import { createDbt, DEFAULT_ENV } from './dbt/index.js';
import { Engine } from './engine.js';
import { BackgroundIndexer } from './value-index.js';
import { createEmbedder } from './embeddings.js';
import { buildToolDefs, servicesFor, logLine } from './mcp-surface.js';
import { createMcpServer } from './mcp-server.js';
import { answerTaskRequest } from './mcp-tasks.js';
import { withClientCapabilities, envelopeCapabilities } from './client-extensions.js';

export { buildToolDefs };

/** One MCP server over this engine — what the HTTP handler builds per request, and what an
 *  in-process client (the tests) connects to directly. */
export function makeMcpServer(engine, services = servicesFor(engine), { era, offer } = {}) {
  return createMcpServer(services, { era, offer });
}

// THE CEILING ON WHAT A DEPLOYMENT MAY CONFIGURE. The enrichment window (how long a best-effort
// warehouse read may hold an interactive call — QUERY_TIMEOUT_SECONDS) is bounded by a timeout
// this server does not own: the client that made the call gives up on its own schedule and reports
// the server as unresponsive. So a value above the ceiling is not honoured — it is capped, out
// loud, and the operator sees why. (A query or a build never holds a call: it is a task.)
//
// The cap lives HERE, on the environment, and not in the Engine constructor: the Engine is a
// library, and a caller that embeds it may hand a long window to a local warehouse.
export const MAX_BUILD_GRACE_SECONDS = 30;

/**
 * Seconds from the environment → ms, capped at MAX_BUILD_GRACE_SECONDS. An unset, empty or
 * unparseable value falls back to `fallbackSeconds` (null: unset).
 */
export function graceMsFromEnv(raw, fallbackSeconds, name = 'grace') {
  const asked = Number(raw);
  if (raw === undefined || raw === null || String(raw).trim() === '' || !Number.isFinite(asked) || asked <= 0) {
    return fallbackSeconds == null ? undefined : fallbackSeconds * 1000;
  }
  if (asked > MAX_BUILD_GRACE_SECONDS) {
    console.error(`[mcp] ${name}=${raw}s is above the ceiling — using ${MAX_BUILD_GRACE_SECONDS}s: a longer wait inside one tool call outlives the calling client's own timeout, which this server cannot raise. The read still finishes in the background and primes the cache for the next call.`);
    return MAX_BUILD_GRACE_SECONDS * 1000;
  }
  return asked * 1000;
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
  const runner = opts.runner !== undefined
    ? opts.runner
    : baseProjectDir
      // dbt runs ONLY in one of this tool's environments (a venv under DBT_ENVS_DIR built from its
      // lock — DBT_ENV, else `dbt-v2`; MetricFlow's is `metricflow`); anything else is refused. The
      // client reads its version from the binary (DBT_VERSION pins it).
      ? createDbt({ version: process.env.DBT_VERSION || 'auto', environment: process.env.DBT_ENV || DEFAULT_ENV, profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir, timeout: (Number(process.env.DBT_TIMEOUT_SECONDS) || 600) * 1000 })
      : null;
  // what the installed dbt can run decides what is offered (dbt v2 runs no Python models on DuckDB)
  gatePythonRuntime(catalog, runner);
  // Recipes come in TWO LAYERS, merged: the system file that ships with the server (technical and
  // universal) and the deployment's own file(s) — RECIPES_PATH, comma-separated for several — with
  // the deployment winning an id collision. Before this, RECIPES_PATH REPLACED the system set, so a
  // deployment with its own recipes silently lost every shipped one.
  const systemRecipes = assetPath('systemRecipes');
  const deploymentRecipes = opts.recipesPath || process.env.RECIPES_PATH || '';
  const recipes = (systemRecipes || deploymentRecipes)
    ? loadRecipes(systemRecipes, deploymentRecipes, {
      dialect: catalog.dialect,
      python: !!catalog.pythonRuntime?.available,
      runtime: frameProfile(catalog.pythonRuntime, catalog.pythonRuntime?.config || {}).key,
    })
    : undefined;
  const ctxs = new ContextManager({
    baseProjectDir,
    workspaceRoot: opts.workspaceRoot || process.env.MCP_WORKSPACE,
    timeSpineDialect: catalog.dialect,
  });
  const queryTimeoutMs = graceMsFromEnv(process.env.QUERY_TIMEOUT_SECONDS, 20, 'QUERY_TIMEOUT_SECONDS');
  // ONE shared db file (jobs + value index live in it as separate tables). Defaults to
  // <workspaceRoot>/mcp.sqlite; pin it elsewhere (e.g. a persistent volume) via MCP_DB.
  const dbPath = opts.dbPath || process.env.MCP_DB || join(ctxs.workspaceRoot, 'mcp.sqlite');
  // Ensure the parent dir exists so a custom path persists (a missing dir would make the
  // open fail and silently fall back to an in-memory store).
  try { mkdirSync(dirname(dbPath), { recursive: true }); } catch { /* best effort */ }
  // MCP_DB_RESET wipes the store (jobs + value index) on startup. DEFAULT OFF so state
  // (the value index, job history) SURVIVES a restart — opt IN to a clean slate with
  // MCP_DB_RESET=1/true. (Persistence still needs the DB on a durable volume + Node >= 22.5.)
  const resetDb = /^(1|true|yes|on)$/i.test(String(process.env.MCP_DB_RESET ?? 'false').trim());
  if (resetDb) console.error(`[mcp] ${new Date().toISOString()} MCP_DB_RESET on — clearing the store on startup (state will NOT survive this restart)`);
  // GROUND the catalog to the physical warehouse BEFORE building the engine (its tool
  // schemas + value index derive from the catalog): a column the dbt schema declares but
  // the physical table lacks is pruned, so it never appears in any tool. Best-effort and
  // opt-out via MCP_GROUND_CATALOG=0 (e.g. offline/catalog-only dev).
  if (runner && baseProjectDir && !/^(0|false|no|off)$/i.test(String(process.env.MCP_GROUND_CATALOG ?? 'true').trim())) {
    try {
      const { pruned, unavailable } = await groundCatalogToPhysical(catalog, runner, baseProjectDir, (m) => console.error(`[mcp] ${new Date().toISOString()} ${m}`));
      // The report lists columns the table lacks, plus anything that had to go with them —
      // a join key built on a missing column, or a validity window that is no longer one.
      for (const [k, names] of Object.entries(pruned)) console.error(`[mcp] ${new Date().toISOString()} catalog grounding: '${k}' — dropped ${names.length} declaration(s) the physical table does not back: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`);
      // A model whose STRUCTURAL column (event name, event time, payload blob, identity key) or
      // whole table is missing is excluded from every tool, with the reason — like a contradictory
      // declaration is refused at load.
      for (const [k, u] of Object.entries(unavailable || {})) console.error(`[mcp] ${new Date().toISOString()} catalog grounding: '${k}' (${u.dbt_model}) is UNAVAILABLE — ${u.reason}`);
    } catch (e) {
      // No events source left (or introspection itself broke): the server cannot serve a catalog
      // with nothing to query — fail loudly rather than start half-blind.
      if (/no events source is available/.test(String(e?.message))) throw e;
      console.error(`[mcp] ${new Date().toISOString()} catalog grounding skipped: ${e?.message || e}`);
    }
  }
  // Optional semantic memory search: an embedder is built ONLY when MEMORY_EMBEDDINGS is
  // configured (+ a key); otherwise null and memory({ search }) stays purely fuzzy.
  const embedder = createEmbedder();
  // Durability for the memory tool: by default findings share the store (and survive
  // MCP_DB_RESET), but the store lives on the container FS — point MCP_MEMORY_DB at a
  // PERSISTENT volume to retain findings across container restarts.
  const memoryDbPath = opts.memoryDbPath || process.env.MCP_MEMORY_DB || undefined;
  if (memoryDbPath) {
    try { mkdirSync(dirname(memoryDbPath), { recursive: true }); } catch { /* best effort */ }
    console.error(`[mcp] ${new Date().toISOString()} memory: persisting findings to ${memoryDbPath} (dedicated, never reset)`);
  } else {
    console.error(`[mcp] ${new Date().toISOString()} memory: findings live in the shared store at ${dbPath} — set MCP_MEMORY_DB to a persistent volume to retain them across container restarts`);
  }
  const engine = new Engine({ catalog, contextManager: ctxs, runner, recipes, queryTimeoutMs, dbPath, resetDb, embedder, memoryDbPath });
  // Persistence surfaces as semantic_index({ status }).value_index.persisted. If a DB path was
  // configured but the store is in-memory, node:sqlite is unavailable (Node < 22.5) — say so
  // loudly, because otherwise the index silently rebuilds from scratch on every restart.
  if (dbPath && !engine.valueIndex.persistent) {
    console.error(`[mcp] ${new Date().toISOString()} WARNING: store is IN-MEMORY (persisted:false) despite MCP_DB=${dbPath} — node:sqlite is unavailable (needs Node >= 22.5). Nothing survives a restart. Upgrade Node (the image is node:22-slim) or set MCP_DB_BACKEND to a persistent backend.`);
  } else if (dbPath) {
    console.error(`[mcp] ${new Date().toISOString()} store persisted at ${dbPath} (survives restart when the path is on a durable volume; MCP_DB_RESET is ${resetDb ? 'ON — wiped this start' : 'off'})`);
  }
  return engine;
}

// ── the HTTP endpoint ──────────────────────────────────────────────────────────────────────

/** "a, b ,c" → ['a','b','c'] (empty → []). */
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// Hostnames a browser page may call from without being listed: the loopback names (the MCP
// Inspector, a local tool). The SDK's Express app validates Origin by hostname.
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The Express app: `createMcpExpressApp` (the SDK's app factory — JSON body parsing, Host/Origin
 * validation) with `createMcpHandler` mounted on /mcp.
 *
 * Origin is ALWAYS validated ("Servers MUST validate the Origin header"): a request without one —
 * every native client, every hosted connector calling from its backend — passes; a browser page
 * passes from a loopback origin or one listed in MCP_ALLOWED_ORIGINS; anything else is 403. (The
 * SDK arms that check by itself only for a loopback bind, and a container binds 0.0.0.0 — so the
 * list is passed explicitly.) MCP_ALLOWED_HOSTS adds the Host check.
 */
/**
 * One line for every request the endpoint REFUSED or failed (status >= 400) — including the ones the
 * SDK's Host/Origin fences reject before any handler runs, which otherwise leave no trace: a client
 * that "cannot reach" the server is then one log line away from its reason (a browser-based host
 * sending an Origin that is not in MCP_ALLOWED_ORIGINS, a wrong Host, a protocol version the
 * server does not speak). Only request metadata is logged, never a body or a credential.
 */
export function logRefusals(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    const h = req.headers;
    const method = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.method : undefined;
    const bits = [
      `${res.statusCode} ${req.method} ${req.path}`,
      method ? `rpc=${method}` : null,
      h.origin ? `origin=${h.origin}` : null,
      h.host ? `host=${h.host}` : null,
      h['mcp-protocol-version'] ? `protocol=${h['mcp-protocol-version']}` : null,
      h['user-agent'] ? `ua=${String(h['user-agent']).slice(0, 120)}` : null,
    ].filter(Boolean);
    logLine('http', `✗ refused ${bits.join(' ')}${res.statusCode === 403 && h.origin ? ' — if this client is legitimate, add its origin hostname to MCP_ALLOWED_ORIGINS' : ''}`);
  });
  next();
}

/**
 * One line per request on the endpoint — what a host asks for, and whether it declared the Apps
 * extension on it — so what a host does when it re-opens a conversation (and what it is refused)
 * is readable from the log. Request metadata only: the JSON-RPC method, the tool or resource name,
 * the protocol version, the origin and user agent — never a body, an argument or a credential.
 */
function logRequest(req, res) {
  const msg = Array.isArray(req.body) ? req.body[0] : req.body;
  const method = msg && typeof msg === 'object' ? msg.method : undefined;
  if (!method || method === 'tools/call') return; // tool calls are logged by runTool, with their outcome
  const h = req.headers;
  const caps = envelopeCapabilities(req.body, CLIENT_CAPABILITIES_META_KEY);
  const target = msg.params?.uri || msg.params?.name;
  const bits = [
    `${req.method} rpc=${method}`,
    target ? `target=${String(target).slice(0, 120)}` : null,
    h['mcp-protocol-version'] ? `protocol=${h['mcp-protocol-version']}` : null,
    h['mcp-session-id'] ? 'session-id=yes' : null,
    `declares=${caps?.extensions ? Object.keys(caps.extensions).join('+') || 'none' : 'none'}`,
    h.origin ? `origin=${h.origin}` : null,
    h['user-agent'] ? `ua=${String(h['user-agent']).slice(0, 80)}` : null,
  ].filter(Boolean);
  res.on('finish', () => logLine('http', `${bits.join(' ')} → ${res.statusCode}`));
}

export function createApp(engine, opts = {}) {
  const services = opts.services || servicesFor(engine);
  const allowedOrigins = [...LOOPBACK, ...(opts.allowedOrigins ?? csv(process.env.MCP_ALLOWED_ORIGINS))];
  const allowedHosts = opts.allowedHosts ?? csv(process.env.MCP_ALLOWED_HOSTS);
  const app = createMcpExpressApp({
    host: opts.host ?? process.env.HOST ?? '127.0.0.1',
    allowedOrigins,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    jsonLimit: '4mb',
  });
  const handler = createMcpHandler(({ era }) => createMcpServer(services, { era }), {
    onerror: (e) => logLine('mcp', `✗ ${e?.message || e}`),
    // subscriptions/listen streams subscribe here; a start that changed the surface announces it
    bus: services.bus,
  });
  const node = toNodeHandler(handler);
  app.all('/mcp', (req, res) => {
    logRequest(req, res);
    if (answerTaskRequest(services.tasks, req, res)) return;
    // what THIS request's client declares (its envelope's capabilities) decides which extensions
    // the server built for it offers (src/client-extensions.js)
    void withClientCapabilities(envelopeCapabilities(req.body, CLIENT_CAPABILITIES_META_KEY), () => node(req, res, req.body));
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // EVERY failure on the endpoint is a JSON-RPC error a client can parse, including the ones raised
  // before the protocol sees the request: a body that is not JSON (-32700, the JSON-RPC parse
  // error), a body over the size limit. Express' default is an HTML page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) { res.end(); return; }
    const reply = (status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
    if (err?.type === 'entity.parse.failed') return reply(400, -32700, `Parse error: the body is not valid JSON (${err.message})`);
    if (err?.type === 'entity.too.large') return reply(413, -32600, 'Invalid Request: the body is larger than the 4 MB limit');
    logLine('http', `✗ ${req.method} ${req.path}: ${err?.stack || err}`);
    return reply(err?.status && err.status < 500 ? err.status : 500, -32603, `Internal error: ${err?.message || err}`);
  });

  // the refusal log wraps the SDK's app, so it also sees what that app's Host/Origin fences reject
  const outer = express();
  outer.disable('x-powered-by');
  outer.use(logRefusals);
  outer.use(app);
  outer.locals.close = () => handler.close();
  return outer;
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
  // Optional cost lever: bound indexing scans to the last N days on the anchor time column
  // (0/unset → scan all history, the default). Set on a large partitioned fact to cut cost.
  const windowDays = Number(process.env.MCP_INDEX_WINDOW_DAYS) || 0;
  // Approximate (HLL) distinct counts during indexing — cheaper on a large fact, and the
  // project's preferred distinct-count method. DEFAULT ON; dialect-gated (bigquery/snowflake/
  // duckdb/redshift use APPROX_COUNT_DISTINCT, unknown fall back to EXACT). Disable
  // with MCP_INDEX_APPROX_DISTINCT=false/0/no/off to force exact everywhere.
  const approxDistinct = !/^(0|false|no|off)$/i.test(String(process.env.MCP_INDEX_APPROX_DISTINCT ?? 'true').trim());
  // Properties indexed per combined scan (cardinality + coverage in one query each); a failed
  // batch degrades to per-property. Tune down on very wide facts / strict column limits.
  const batchSize = Number(process.env.MCP_INDEX_BATCH) || 40;
  // Dedicated timeout (seconds) for the heavy index scans — a combined top-k over the full
  // fact can exceed the runner's default 180s and get SIGTERM-killed. Generous default (600s)
  // so indexing finishes; ordinary user queries keep the smaller runner timeout. Tune via
  // MCP_INDEX_TIMEOUT_SECONDS (or pair with MCP_INDEX_WINDOW_DAYS to bound the scan instead).
  // Dedicated timeout for the heavy value-index scans — default 2 HOURS (7200s): a combined
  // scan over a large full events fact genuinely needs it, and it is separate from the general
  // dbt runner timeout (which stays short so ordinary user queries never hang). Pair with the
  // incremental knobs below to shorten individual runs.
  const scanTimeout = (Number(process.env.MCP_INDEX_TIMEOUT_SECONDS) || 7200) * 1000;
  // Incremental MERGE (default ON): re-scan an already-indexed anchor property only for rows
  // NEWER than its watermark and ADD the counts to what is stored — each cycle scans a small
  // delta, not the whole history. Disable with MCP_INDEX_MERGE=false. It is mutually exclusive
  // with a rolling MCP_INDEX_WINDOW_DAYS (merge accumulates all-time; the window ages data out),
  // so a configured window turns merge OFF and takes precedence.
  const mergeOn = !/^(0|false|no|off)$/i.test(String(process.env.MCP_INDEX_MERGE ?? 'true').trim());
  const merge = mergeOn && !windowDays;
  if (mergeOn && windowDays) console.error(`[mcp] ${new Date().toISOString()} value-index: MCP_INDEX_WINDOW_DAYS=${windowDays} set — incremental merge disabled (rolling window takes precedence)`);
  // Auto-skip near-unique (ID-like) fields once indexed: distinct ≥ this PERCENT of the field's
  // (non-null) rows → its top-N is noise, so it is not re-scanned on later syncs. Relative to the
  // field's own size (adapts to any table). Default 90%; set MCP_INDEX_HIGH_CARD_PCT=0 to disable.
  const highCardPct = process.env.MCP_INDEX_HIGH_CARD_PCT !== undefined ? Number(process.env.MCP_INDEX_HIGH_CARD_PCT) : 90;
  // Rebuild-then-index (DEFAULT ON): each sync `dbt run`s the catalog's source models BEFORE
  // indexing, so the index + data_freshness reflect a freshly computed table (not the last
  // externally-built one). Disable with MCP_INDEX_DBT_RUN=false if an external scheduler
  // (Airflow/dbt Cloud) already builds the models. MCP_INDEX_DBT_RUN_SELECT overrides the selector.
  const runModels = !/^(0|false|no|off)$/i.test(String(process.env.MCP_INDEX_DBT_RUN ?? 'true').trim());
  const runModelsSelect = process.env.MCP_INDEX_DBT_RUN_SELECT || null;
  const indexer = new BackgroundIndexer({ catalog: engine.catalog, runner: engine.runner, index: engine.valueIndex, baseProjectDir: engine.ctxs.baseProjectDir, intervalMs, maxValues, windowDays, approxDistinct, batchSize, scanTimeout, merge, highCardPct, runModels, runModelsSelect, logger: (m) => console.error(`[mcp] ${new Date().toISOString()} value-index ${m}`) });
  indexer.start();

  // Graceful shutdown: stop accepting, close the warm sidecar + SQLite handle.
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${sig}, shutting down`);
    if (gcTimer) clearInterval(gcTimer);
    indexer.stop();
    try { app.locals.close(); servicesFor(engine).close(); } catch { /* noop */ }
    httpServer.close(() => {});
    try { engine.close(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 200).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
