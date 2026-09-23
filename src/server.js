// Streamable-HTTP MCP server exposing the declarative dbt Semantic Layer tools.
//
// DUAL-ERA on one endpoint (/mcp): a legacy client opens a session with `initialize` and is served
// by the SDK's Server (protocol 2025-11-25 and earlier); a modern client sends stateless requests
// that carry their protocol version in `_meta` and is served by src/mcp-modern.js (2026-07-28).
// What the server offers — tools, resources, skills, the Apps view, tasks — is one surface
// (src/mcp-surface.js) that both eras project.

import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema, McpError, ErrorCode, isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync } from 'node:fs';
import { loadCatalog, validateDbtProject, groundCatalogToPhysical } from './catalog.js';
import { loadRecipes } from './recipes.js';
import { assetPath } from './runtime-assets.js';
import { frameProfile } from './python-model.js';
import { ContextManager } from './context-manager.js';
import { DbtRunner } from './dbt-runner.js';
import { Engine } from './engine.js';
import { BackgroundIndexer } from './value-index.js';
import { createEmbedder } from './embeddings.js';
import { buildToolDefs, runTool, runToCompletion, isCallableTool, clientSupportsUi, servicesFor, SERVER_INFO, logLine } from './mcp-surface.js';
import { releasableSignal } from './request-context.js';
import { UI_EXTENSION, APP_MIME } from './apps.js';
import { SKILLS_EXTENSION } from './skills.js';
import { isModernRequest, modernHandler } from './mcp-modern.js';

export { buildToolDefs };

// skills/list and skills/get on a LEGACY session: the extension defines them for every revision
// (2026-07-28 only adds caching hints), and the SDK dispatches a custom method by its schema.
const SkillsListRequestSchema = z.object({ method: z.literal('skills/list'), params: z.object({ cursor: z.string().optional() }).passthrough().optional() });
const SkillsGetRequestSchema = z.object({ method: z.literal('skills/get'), params: z.object({ uri: z.string() }).passthrough() });

/**
 * The LEGACY (session) server for one connection. Everything it answers comes from the shared
 * services; what is legacy-specific is only the wire: `initialize` capabilities, the 2025-11-25
 * experimental tasks (`params.task`, tasks/result — the SDK serves those over our registry),
 * resource-not-found as -32002.
 */
export function makeMcpServer(engine, services = servicesFor(engine)) {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
      tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      extensions: {
        [UI_EXTENSION]: { mimeTypes: [APP_MIME] },
        ...(services.skills ? { [SKILLS_EXTENSION]: {} } : {}),
      },
    },
    instructions: services.instructions,
    taskStore: services.tasks.legacyStore(),
  });
  const ui = () => clientSupportsUi(server.getClientCapabilities());

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = buildToolDefs(engine, { ui: ui(), legacyTasks: true });
    logLine('list_tools', `→ ${tools.length} tools`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args, task } = req.params;
    const structured = ui();
    // 2025-11-25 experimental tasks: the CLIENT asked for a task — the call runs to its end in the
    // background and the SDK's tasks/get / tasks/result / tasks/cancel read it from the registry
    if (task && isCallableTool(engine, name)) {
      const t = services.tasks.create({
        owner: extra.sessionId || null,
        ttlMs: task.ttl,
        run: (signal) => runToCompletion(engine, name, args, { signal, structured, pollMs: services.tasks.pollIntervalMs }).then((r) => r.result),
      });
      logLine(name, `↪ task ${t.taskId}`);
      return { task: services.tasks.legacy(t) };
    }
    // The call's cancellation reaches its dbt processes only while the call is in flight: a build
    // handed back as a query_id is meant to outlive the call, and a later abort (the session being
    // torn down) must not reach it.
    const cancel = releasableSignal(extra.signal);
    const token = extra._meta?.progressToken;
    try {
      const { result } = await runTool(engine, name, args, {
        signal: cancel.signal,
        structured,
        onProgress: token !== undefined ? (p) => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, ...p } }) : undefined,
        progressEveryMs: services.progressEveryMs,
      });
      return result;
    } finally {
      cancel.release();
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: services.resources() }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: services.templates() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const contents = services.read(req.params.uri);
    // -32002 is this era's resource-not-found (2026-07-28 moved it to -32602)
    if (!contents) throw new McpError(-32002, `Resource not found: ${req.params.uri}`, { uri: req.params.uri });
    return { contents };
  });
  if (services.skills) {
    server.setRequestHandler(SkillsListRequestSchema, async () => ({ skills: services.skills.list() }));
    server.setRequestHandler(SkillsGetRequestSchema, async (req) => {
      const s = services.skills.get(req.params.uri);
      if (!s) throw new McpError(ErrorCode.InvalidParams, `Not a skill this server serves: ${req.params.uri}`);
      return { skill: s };
    });
  }

  return server;
}

// THE CEILING ON WHAT A DEPLOYMENT MAY CONFIGURE. Both grace windows (how long an SQL build and how
// long a Python build may hold the tool call before handing back a query_id) are bounded by a
// timeout this server does not own: the client that made the call gives up on its own schedule,
// reports the server as unresponsive, and the build it started runs on unseen. So a value above the
// ceiling is not honoured — it is capped, out loud, and the operator sees why.
//
// The cap lives HERE, on the environment, and not in the Engine constructor: the Engine is a
// library, and a caller that embeds it can legitimately hand a long window to a LOCAL build
// (test/integration/python-stage.test.js gives a DuckDB Python build 600s, where waiting for rows
// beats polling for a job). Capping in the constructor would make those builds asynchronous.
export const MAX_BUILD_GRACE_SECONDS = 30;

/**
 * Seconds from the environment → ms, capped at MAX_BUILD_GRACE_SECONDS. An unset, empty or
 * unparseable value falls back to `fallbackSeconds`; a fallback of null means "unset" (the runtime
 * decides), which is what the Python grace needs.
 */
export function graceMsFromEnv(raw, fallbackSeconds, name = 'grace') {
  const asked = Number(raw);
  if (raw === undefined || raw === null || String(raw).trim() === '' || !Number.isFinite(asked) || asked <= 0) {
    return fallbackSeconds == null ? undefined : fallbackSeconds * 1000;
  }
  if (asked > MAX_BUILD_GRACE_SECONDS) {
    console.error(`[mcp] ${name}=${raw}s is above the ceiling — using ${MAX_BUILD_GRACE_SECONDS}s: a longer wait inside one tool call outlives the calling client's own timeout, which this server cannot raise. The build still finishes in the background; poll it with get_query_result.`);
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
  const runner = opts.runner !== undefined
    ? opts.runner
    : baseProjectDir
      ? new DbtRunner({ dbtBin: process.env.DBT_BIN || 'dbt', mfBin: process.env.MF_BIN || 'mf', profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir, timeout: (Number(process.env.DBT_TIMEOUT_SECONDS) || 600) * 1000 })
      : null;
  const queryTimeoutMs = graceMsFromEnv(process.env.QUERY_TIMEOUT_SECONDS, 20, 'QUERY_TIMEOUT_SECONDS');
  // A build that includes a PYTHON model may hand back its query_id much sooner — how soon is the
  // RUNTIME's own property (a remote one cold-starts for minutes and must not hold the caller's
  // client; a local one finishes in seconds and should just return the rows). This env var is the
  // operator's override of that, and stays UNSET unless they set it.
  const pythonBuildGraceMs = graceMsFromEnv(process.env.PYTHON_BUILD_GRACE_SECONDS, null, 'PYTHON_BUILD_GRACE_SECONDS');
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
  const engine = new Engine({ catalog, contextManager: ctxs, runner, recipes, queryTimeoutMs, pythonBuildGraceMs, dbPath, resetDb, embedder, memoryDbPath });
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

// ── what the HTTP endpoint accepts before anything reaches the protocol ────────────────────

/** "a, b ,c" → ['a','b','c'] (empty → []). */
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The Origin rule (Streamable HTTP, both eras: "Servers MUST validate the Origin header … If the
 * Origin header is present and invalid, servers MUST respond with HTTP 403"). A request without an
 * Origin is not a browser page and passes — that is every native client and every hosted connector
 * calling from its own backend. A browser page passes only from a loopback origin (the MCP
 * Inspector, a local tool) or an origin the operator listed in MCP_ALLOWED_ORIGINS. "Same origin as
 * the Host header" is deliberately NOT a rule: under DNS rebinding the attacker's page and the Host
 * header agree, which is exactly the attack.
 */
export function originAllowed(origin, allowed = []) {
  if (origin === undefined || origin === null || origin === '') return true;
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch { return false; }
}

export function createApp(engine, opts = {}) {
  const services = opts.services || servicesFor(engine);
  const allowedOrigins = opts.allowedOrigins ?? csv(process.env.MCP_ALLOWED_ORIGINS);
  // Optional second fence against DNS rebinding: the Host header must be one the operator named.
  // Off by default — behind a proxy the Host is whatever the proxy forwards.
  const allowedHosts = opts.allowedHosts ?? csv(process.env.MCP_ALLOWED_HOSTS);
  const sessionIdleMs = opts.sessionIdleMs ?? (Number(process.env.MCP_SESSION_IDLE_SECONDS) || 3600) * 1000;
  const maxSessions = opts.maxSessions ?? (Number(process.env.MCP_MAX_SESSIONS) || 500);

  const app = express();
  const rpcError = (res, status, code, message, data) => res.status(status).json({ jsonrpc: '2.0', error: { code, message, ...(data !== undefined ? { data } : {}) }, id: null });

  // The fences come BEFORE the body is parsed: a refused request costs nothing.
  app.use('/mcp', (req, res, next) => {
    if (!originAllowed(req.headers.origin, allowedOrigins)) {
      return rpcError(res, 403, -32000, `Forbidden: Origin '${req.headers.origin}' is not allowed. A browser page may call this server only from a loopback origin or one listed in MCP_ALLOWED_ORIGINS.`);
    }
    if (allowedHosts.length && !allowedHosts.includes(String(req.headers.host || '').toLowerCase())) {
      return rpcError(res, 403, -32000, `Forbidden: Host '${req.headers.host}' is not allowed (MCP_ALLOWED_HOSTS).`);
    }
    return next();
  });
  app.use(express.json({ limit: '4mb' }));
  // No authentication: run behind your own network boundary / proxy as needed.

  // ── LEGACY sessions (2025-11-25 and earlier) ──
  // THE SESSIONS LIVE IN THIS PROCESS, so every deploy invalidates the ids already in clients'
  // hands — and what the client does about that is decided by the STATUS CODE. The spec is exact:
  // an unknown session id is 404, and only a 404 makes a client start a new session ("When a
  // client receives HTTP 404 in response to a request containing an Mcp-Session-Id, it MUST start
  // a new session by sending a new InitializeRequest without a session ID attached"). A 400 says
  // "your request was malformed", which the client can only answer by retrying the same request —
  // which is how one user spent 16 minutes getting an error on every call after a restart, with a
  // healthy server, until the connector was re-added by hand.
  //
  // A session nobody uses is closed after MCP_SESSION_IDLE_SECONDS, and at most MCP_MAX_SESSIONS
  // are held (the least recently used goes first): a client that re-initializes without DELETE —
  // most of them, after a network blip — would otherwise leave a server and a transport behind
  // for the life of the process. A client whose session was reclaimed gets the same 404 and
  // re-initializes; the spec lets a server end a session at any time.
  const sessions = new Map(); // sessionId -> { transport, lastSeen }
  const gone = (res) => rpcError(res, 404, -32001, 'Session not found: this server restarted or the session expired. Start a new session by sending initialize (the Mcp-Session-Id header is ignored on initialize).');
  const noSession = (res) => rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required — send initialize first (or send stateless 2026-07-28 requests with the protocol version in params._meta).');
  const isInit = (body) => (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body));
  const closeSession = async (sid) => {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    try { await s.transport.close(); } catch { /* closing is the point; a failed close is not the caller's problem */ }
  };
  const live = (sid) => {
    const s = sid ? sessions.get(sid) : undefined;
    if (s) s.lastSeen = Date.now();
    return s?.transport;
  };
  const sweep = setInterval(() => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const [sid, s] of sessions) if (s.lastSeen < cutoff) closeSession(sid);
  }, Math.max(1000, Math.min(sessionIdleMs, 60000)));
  sweep.unref?.();

  const modern = modernHandler(services);

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'];

    // INITIALIZATION IS OUTSIDE THE SESSION RULES ("Servers that require a session ID SHOULD
    // respond to requests without an Mcp-Session-Id header (other than initialization) with 400"),
    // so a stale header never blocks a client from getting a new session. It is ignored even when
    // it names a LIVE session: re-initializing replaces that session (the old transport is closed
    // rather than left behind), which is one more way out of the trap and costs nothing.
    if (isInit(req.body)) {
      if (sid && sessions.has(sid)) await closeSession(sid);
      if (sessions.size >= maxSessions) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (oldest) await closeSession(oldest[0]);
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { transport, lastSeen: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId && sessions.get(transport.sessionId)?.transport === transport) sessions.delete(transport.sessionId); };
      const server = makeMcpServer(engine, services);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = live(sid);
    if (transport) { await transport.handleRequest(req, res, req.body); return; }
    // ── MODERN (2026-07-28): stateless, no session. A stale Mcp-Session-Id is ignored, as that
    // revision tells a server to. ──
    if (isModernRequest(req)) { await modern(req, res); return; }
    (sid ? gone : noSession)(res);
  });

  // The stream (GET) and the explicit teardown (DELETE) answer the same way: an id this process
  // does not know is 404 — never the Express default HTML page, which a client cannot parse.
  const sessionEndpoint = async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const transport = live(sid);
    if (!transport) { (sid ? gone : noSession)(res); return; }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', sessionEndpoint);
  app.delete('/mcp', sessionEndpoint);
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // EVERY failure on the MCP endpoint is a JSON-RPC error a client can parse — including the ones
  // raised before the protocol sees the request: a body that is not JSON (-32700, the JSON-RPC
  // parse error), a body over the size limit, and anything a handler throws. Express' default is
  // an HTML page, the same trap as a 400 for a dead session.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) { res.end(); return; }
    if (err?.type === 'entity.parse.failed') return rpcError(res, 400, -32700, `Parse error: the body is not valid JSON (${err.message})`);
    if (err?.type === 'entity.too.large') return rpcError(res, 413, -32600, `Invalid Request: the body is larger than the ${err.limit ? `${Math.round(err.limit / 1024 / 1024)} MB` : 'configured'} limit`);
    logLine('http', `✗ ${req.method} ${req.path}: ${err?.stack || err}`);
    return rpcError(res, err?.status && err.status < 500 ? err.status : 500, -32603, `Internal error: ${err?.message || err}`);
  });

  app.locals.close = () => { clearInterval(sweep); for (const sid of [...sessions.keys()]) closeSession(sid); };
  app.locals.sessions = sessions;
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
  // Optional cost lever: bound indexing scans to the last N days on the anchor time column
  // (0/unset → scan all history, the default). Set on a large partitioned fact to cut cost.
  const windowDays = Number(process.env.MCP_INDEX_WINDOW_DAYS) || 0;
  // Approximate (HLL) distinct counts during indexing — cheaper on a large fact, and the
  // project's preferred distinct-count method. DEFAULT ON; dialect-gated (bigquery/snowflake/
  // duckdb/redshift use APPROX_COUNT_DISTINCT, postgres & unknown fall back to EXACT). Disable
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
