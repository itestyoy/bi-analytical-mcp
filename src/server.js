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
import { createEmbedder } from './embeddings.js';

const TOOL_DESCRIPTIONS = {
  semantic_index: 'THE data-exploration entry point — call it FIRST and whenever unsure what a field means. One progressive index over meaning + real values + completeness + freshness. No args → overview (models, event names, event_semantics = which event marks install/session/purchase, group-by paths, value-index freshness, available recipe ids). Exactly one view key to drill: { model } → columns + dimension attributes with real sample values + physical columns + the RELATIONSHIPS it declares (each join name, its key columns and what it points at) + the AMOUNTS it marks aggregatable (with unit and meaning); { event } → the properties that event carries; { property } → one column\'s full passport (spec/unit, real value distribution — pageable, NULL coverage per event distinguishing expected NULLs from data gaps, indexing history; accepts bare event properties and "users.country"-style attributes); { search } → FUZZY search over events/properties/attributes/VALUES/recipes (typo- and paraphrase-tolerant: "retenton"→retention recipe, "germny"→Germany value; exact hits first, each scored, fuzzy:false for substring-only); { recipe: id } → one ready-made recipe in full (payload + example_queries + the reusable `hack`); { guide: true } → HOW to approach a question: the analyst workflow + IF/DO routing triggers (which tool when) + per-task recipe families (pass a family name to narrow) — read it first if unsure; { bundle: "<bundle id>" } → for ONE app, which event properties are POPULATED vs EMPTY (skip the empties for that app); the overview lists apps under `bundles`; { status: true } → value-index sync state + background query jobs; { run } → one sync run\'s per-property breakdown.',
  create_semantic_model: 'The GOVERNED path: declaratively create/augment semantic models for a task (one SM per source, SEVERAL sources allowed in the same task — e.g. a spend measure and an event measure side by side) + metrics, in an isolated context. Produces NAMED metrics you then query many ways with query_semantic_model (group_by / time / filters) — reusable & re-sliceable. Use for measurable metrics (DAU, revenue, conversion, retention). Omit context_id for a new task; pass it to extend the same one. (For a one-off derived table — funnel/sessionization/window/pivot — use build_native_model.)',
  build_native_model: 'The ESCAPE HATCH for a one-off derived TABLE whose rows ARE the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the governed metrics cannot express. Composed INCREMENTALLY (single `action`-driven tool): start a draft, add_step one stage at a time (where/derive/compute/unnest/join/aggregate/pivot/unpivot/window/order_by/limit + match_recognize; a join names the RELATIONSHIP the schema declares (via: <name>) and never its columns, and joins STACK so one pipeline can reach several sources) — each add_step validates the stage and returns the columns then available for the NEXT stage (pure schema, NOTHING materialized until materialize) — optionally preview the SQL, then materialize (builds + runs the model). The rows are read back with get_query_result (NOT query_semantic_model). For REUSABLE named metrics you query many ways, prefer create_semantic_model (the governed path). A final `python` stage (imports + your functions + ordered calls over a pandas frame) turns the pipeline into a dbt PYTHON model: the SQL stages land as a table, dbt runs the Python model on the warehouse\'s Python runtime (never here) — for statistics, clustering, scoring; its table is read with get_query_result like any pipeline.',
  query_semantic_model: 'Run a metric query against a context. metrics + group_by + where are validated against the context. Joins are handled for you: group or filter by an attribute addressed as { model, attribute } and the declared key is applied — including the validity window of a slowly-changing model, so the attribute is the one valid at the time of each row (no window to state). Pass materialize:true to persist the result and read it back (resilient); slow queries return a query_id to poll.',
  get_query_result: 'Poll a background (materialized) query by query_id, or fetch a known result table directly by {context_id, table}. Returns status (running/ready/error) and rows read from the materialized table.',
  update_semantic_model: 'Add/remove task measures, dimensions or metrics for a table SM within a context; re-parses.',
  context: 'Manage isolated execution contexts (the workspaces create_semantic_model / build_native_model produce). action: list (all contexts) | describe (one context\'s tasks/models/metrics/group-by paths) | drop (tear the whole context down) | delete_model (remove just the native pipeline model, keep the context) | delete_semantic_model (remove one table\'s task additions, cascade for dependent metrics).',
  memory: 'DURABLE analyst memory — remember what you FOUND OUT so it comes back through semantic_index. After you resolve something non-obvious (a vague request tracked down to a real field, a gotcha, a useful source), record:"action" it: `note` the finding, `question` the ORIGINAL business question it answers (in the stakeholder\'s words — embedded with the note so a future similar question retrieves this insight by meaning), `targets` the catalog entities it is about (a property/attribute/event/model — e.g. "ad_type_of_event_data", "users.country", "ad_finished"), `aliases` the words the user actually used ("ad format") — give them in BOTH the original language and English so search works cross-language, `links` any sources. The note then surfaces inline on the linked semantic_index views ({ model }/{ event }/{ property }) and in semantic_index({ search }) — so the next fuzzy phrasing resolves straight to the right field instead of re-investigating. RECORD ONE ATOMIC FINDING PER NOTE: when studying a topic or a document, split it into several small single-fact notes (each with its own targets/aliases) rather than dumping a whole topic into one big note — atomic notes link precisely and retrieve far better; an over-long note matches poorly and may fail to index. action: list (all, or one { target }) | search (by word — typo-tolerant fuzzy, and SEMANTIC/meaning-based when embeddings are enabled) | forget (by id).',
  experiment: 'The A/B EXPERIMENT lifecycle in one tool (action-driven): plan → check_split → analyze. action:"plan" = power/sample-size (required users, or the MDE at a given n) BEFORE running. action:"check_split" = Sample-Ratio-Mismatch χ² guardrail; p < 0.001 means randomization/logging is broken and the result is INVALID — run it BEFORE trusting any lift. action:"analyze" = the significance test on PRE-AGGREGATED per-group stats (metric: proportion → two-proportion z-test; mean → Welch t-test; ratio → delta-method; cuped → variance reduction), returning lift (+ relative-lift CI), p-value, CI, significance, and a multiplicity-adjusted p-value per variant; sequential:true adds an always-valid p for live peeking. Compute the per-group aggregates first with a pipeline. Field names are exact: use `baseline` (NOT baseline_rate) and `confidence` (NOT alpha); there is no `allocation` field (use check_split.expected_ratio). For proportion, each group needs `conversions` (0..n; conversions > n is rejected). Examples — plan: {action:"plan",metric:"proportion",baseline:0.1,mde:0.02}; check_split: {action:"check_split",groups:[{label:"control",n:5000},{label:"variant_b",n:5020}]}; analyze: {action:"analyze",metric:"proportion",control:{n:5000,conversions:500},variants:[{label:"variant_b",n:5020,conversions:580}],correction:"holm"}.',
  time: 'Wait for `seconds` (capped at 60), then return — a pure timer that touches no data. Use it to PACE polling: after query_semantic_model({ materialize:true }) (or a long build) returns a query_id, call time to wait, then poll get_query_result; repeat until ready.',
};

// Human-readable display names for the tools (MCP `title` / annotations.title). The `name` stays
// the stable programmatic id; the title is what a client shows in its UI/picker.
const TOOL_TITLES = {
  semantic_index: 'Explore Semantic Index',
  create_semantic_model: 'Create Semantic Model',
  build_native_model: 'Build Pipeline',
  query_semantic_model: 'Query Semantic Model',
  get_query_result: 'Fetch Query Result',
  update_semantic_model: 'Update Semantic Model',
  context: 'Manage Contexts',
  memory: 'Use Memory',
  experiment: 'A/B Experiment Toolkit',
  time: 'Timer',
};

// Server-level documentation surfaced to the AI client (serverInfo.description):
// what this MCP is for and how to use it end-to-end.
const SERVER_DESCRIPTION = `Declarative semantic layer for product analytics.

WHAT IT DOES
You define "virtual" semantic models — measures, dimensions, and metrics — on the fly over a FIXED set of catalog data sources, and query them by name. You never write SQL. Everything you can reference (events, properties, user attributes, join paths) is enumerated by the catalog and enforced by schema, so you cannot name a field that does not exist.

DATA MODEL (fixed roles)
- events source: one row per event — a user id, a session id, an event timestamp (the time axis), an event_name, and typed event-data properties. ONLY per-event columns live here. A catalog may declare SEVERAL events sources (e.g. product analytics events and crash reports). They are INDEPENDENT AND EQUAL: each owns its event vocabulary, its payload properties and its own indexed values, and they are never mixed — none is a default. The semantic_index overview lists them under "facts" with each one's own event_names. ALWAYS name the source you mean: semantic_index({ source, event }) / ({ source, property }), build_native_model({ source }), create_semantic_model({ semantic_models: [{ from: <source> }] }). Within a source, event and property names are used as-is. Choose the source that records what the question is about.
- users dimension: one row per user — attributes (country, platform, media_source, acquisition_type, install_date, ...). Reached by JOIN: group/filter by { model: 'users', attribute } in metric queries (declare use_base_models: ['users']), or a join stage in pipelines. User attributes are NEVER columns of the fact.
- experiments: one row per user×experiment (experiment_name, variant_group, assigned_at, ended_at) — join to events by the user entity, window to the assignment period, aggregate per group, then experiment({ action: check_split | analyze }).
- measures sources (optional): a NON-events fact whose columns are amounts rather than events (e.g. acquisition spend at one row per player x day). It has no event_name; it declares its own time axis, and the catalog MARKS which of its fields are amounts — semantic_index({ model }) lists them under "aggregatable" with their unit and meaning. No aggregation is fixed: name the field in a measure's "field" and choose "agg" yourself (sum / average / max / median / percentile / count_distinct), per question. It carries the user entity, so { model: 'users', attribute } segments it too. In a pipeline it joins an events source by the PLAYER key alone (via the declared relationship): one player has many events and several dated rows, so that pairing is MANY-TO-MANY by design — use it to carry an attribute (channel, campaign) onto events, never to total the amounts over it. To total an amount, aggregate the source itself.
JOINS BETWEEN SOURCES are declared in the catalog, never assembled by hand: a relationship has a name and its key columns live in the schema. Group by { model: '<the model that carries the attribute>', attribute } in a metric query (with that model in use_base_models; add via when several relationships lead to it), or join with via: '<relationship>' in a pipeline. A key may span SEVERAL columns and the two sides may name their columns differently — only the relationship name and the NUMBER of key parts have to agree. A relationship that no model OWNS has no governed path (MetricFlow joins only onto a unique key) and is a pipeline join, which is correct rather than a limitation. semantic_index({ model }) lists a model's relationships, their key columns and what each points at. Two events sources are joined the same way — in a pipeline, since a row-to-row match between two event streams is many-to-many. When a source carries several alternative key columns for one relationship (one tracking id per ad format), each is listed as its own relationship <name>_<variant> and you pick the one the question is about. The users dimension may be SLOWLY-CHANGING (several versions per player, each with a validity window): joining it on the player key alone matches every version and inflates counts, so a pipeline join must add between: { value: <this source's time column>, from: <validity start>, to: <validity end> } — a metric query needs nothing, MetricFlow applies the window itself.
Funnels/sequences are built from events (a step = an event + an event_data property value) and run over ONE source — a sequence cannot span two sources. Metrics from different sources CAN be compared side by side when grouped by metric_time.

WORKFLOW
1. semantic_index — discover the catalog PROGRESSIVELY. Call it first with no arguments for an overview (models, event names, group-by paths, event_semantics = which event marks install/session/purchase, value-index freshness), then drill down: semantic_index({ model }) for a model's columns and attributes (with REAL sample values), ({ event }) for the properties an event carries, ({ property }) for one property or a "users.country"-style attribute with its real value distribution, ({ search }) to find events/properties/attributes/values/recipes. The events fact has ~150 event-scoped properties, so they are fetched per event rather than all at once.
2. create_semantic_model — declare measures/dimensions/metrics for a task in an ISOLATED context (returns a context_id). Pass that context_id back to extend the same context.
   - For ordered multi-step funnels/paths (and any custom transform) use build_native_model: compose a PIPELINE one stage at a time (start → add_step* → materialize; each add_step shows the columns available next), building a model whose ROWS are the result — read/slice them with get_query_result (a pipeline context is not queried via query_semantic_model). It accepts a time_range and an internal pre-filter (event subset / user segment).
   - Beyond SQL (z-scores, clustering, scoring, forecasting): add a 'python' stage as the LAST stage of that pipeline — declare allowlisted imports, your own functions (def f(df, …): … return df) and the ordered calls; the server writes the dbt Python model (dbt.ref/dbt.config/return) and dbt runs it on the warehouse's Python runtime. Read the result with get_query_result as usual.
3. query_semantic_model — run metrics with group_by / where / order_by / time_range. Options: dry_run (preview, no run), explain (query plan, no run), materialize (persist the result and read it back; long queries return a query_id to poll), limit/offset.
4. get_query_result — poll a backgrounded query by query_id, or re-read/re-slice a stored result (where/group_by/aggregations/having) WITHOUT recomputing.

KEY CONCEPTS
- context_id: an isolated workspace; parallel tasks never collide. Manage via context({ action: list | describe | drop | delete_model | delete_semantic_model }).
- metric types: simple, ratio, cumulative, derived, conversion.
- group_by: { time: "metric_time", grain } for a time series, or { model, attribute } for an attribute addressed by where it lives (e.g. { model: "users", attribute: "country" }). Never a path string.
- recipes: ready-made templates for common task families (trends, segmentation, funnels, retention, cohorts, behavioral, conversion, progression, monetization, ads, economy, stickiness) — the semantic_index overview lists their ids; semantic_index({ recipe: id }) returns one in full.
- memory: durable findings. When you track a vague request down to a real field (or hit a gotcha, or find a useful source), record it with the memory tool, linked to the catalog entities it concerns — it then resurfaces on those semantic_index views and in semantic_index({ search }), so the next fuzzy phrasing resolves straight to the right field.
- when in doubt which builder: create_semantic_model = reusable named metrics (query many ways); build_native_model = a one-off derived table (funnel/sessionization/window/pivot), rows read via get_query_result.`;

// Short one-paragraph summary for serverInfo.description (UI/catalog contexts).
const SERVER_SUMMARY = 'Declarative semantic layer for product analytics: declare virtual semantic models — measures, dimensions, metrics, and multi-step funnels — over fixed, catalog-enumerated data sources (one or more events facts + a user-attributes dimension + experiment assignments) and query them by name; you never write SQL. Start with semantic_index, then create_semantic_model / build_native_model, then query_semantic_model.';

const ASYNC_TOOLS = new Set(['create_semantic_model', 'register_native_model', 'build_native_model', 'delete_native_model', 'query_semantic_model', 'get_query_result', 'update_semantic_model', 'delete_semantic_model', 'semantic_index', 'context', 'describe_context', 'memory', 'time']);

// Tools that still EXIST (schema + engine method + dispatch) but are no longer
// advertised to the AI — superseded by / folded into a newer tool. Code is kept so the
// new tool can delegate to them and existing callers/recipes/tests keep working.
//   register_native_model        → all-at-once path behind the incremental build_native_model
//   list_query_jobs              → folded into semantic_index({ status })
//   list_recipes / get_recipe    → folded into semantic_index (overview list + { recipe: id })
//   list/describe/drop_context,
//   delete_native/semantic_model → folded into the single context({ action }) tool
const HIDDEN_TOOLS = new Set([
  'register_native_model',
  'list_query_jobs',
  'list_contexts', 'describe_context', 'drop_context', 'delete_native_model', 'delete_semantic_model',
  'ab_test', 'srm_check', 'sample_size', // folded into experiment({ action: analyze | check_split | plan })
]);

// Fallback title from a snake_case name: "get_query_result" → "Get Query Result".
function titleFromName(name) {
  return String(name).split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export function buildToolDefs(engine) {
  return Object.entries(engine.schemas)
    .filter(([name]) => !HIDDEN_TOOLS.has(name))
    .map(([name, inputSchema]) => {
      const title = TOOL_TITLES[name] || titleFromName(name);
      // `title` is the MCP display-name field; `annotations.title` mirrors it for clients that
      // read the older annotations location. `name` remains the stable programmatic identifier.
      return { name, title, description: TOOL_DESCRIPTIONS[name] || name, inputSchema, annotations: { title } };
    });
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
      ? new DbtRunner({ dbtBin: process.env.DBT_BIN || 'dbt', mfBin: process.env.MF_BIN || 'mf', profilesDir: process.env.DBT_PROFILES_DIR || baseProjectDir, timeout: (Number(process.env.DBT_TIMEOUT_SECONDS) || 600) * 1000 })
      : null;
  const queryTimeoutMs = (Number(process.env.QUERY_TIMEOUT_SECONDS) || 60) * 1000;
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
      const { pruned, unavailable } = await groundCatalogToPhysical(catalog, runner, baseProjectDir);
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
    httpServer.close(() => {});
    try { engine.close(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 200).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
