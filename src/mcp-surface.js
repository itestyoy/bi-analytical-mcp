// WHAT THIS SERVER OFFERS: the tool definitions, how one call runs, and the services behind the
// MCP surface (tasks, skills, the Apps view). src/mcp-server.js registers it on the official SDK's
// Server; the SDK owns the protocol — both revisions a client may speak, the wire format, the
// envelope and header rules — so nothing here knows which revision a request came in.

import { MAX_WAIT_SECONDS } from './schema.js';
import { withSignal } from './request-context.js';
import { appsSurface, viewMeta, VIEWED_TOOLS, APPS_ONLY_TOOLS } from './apps.js';
import { buildViewModel } from './apps/result-view-model.js';
import { buildSkills } from './skills.js';
import { TaskRegistry } from './tasks.js';

const TOOL_DESCRIPTIONS = {
  semantic_index: 'THE data-exploration entry point — call it FIRST and whenever unsure what a field means. One progressive index over meaning + real values + completeness + freshness. No args → overview (models, event names, event_semantics = which event marks install/session/purchase, group-by paths, value-index freshness, available recipe ids). Exactly one view key to drill: { model } → columns + dimension attributes with real sample values + physical columns + the RELATIONSHIPS it declares (each join name, its key columns and what it points at) + the AMOUNTS it marks aggregatable (with unit and meaning); { source, event } → the properties that event carries; { source, property } → one column\'s full passport (spec/unit, real value distribution — pageable, NULL coverage per event distinguishing expected NULLs from data gaps, indexing history). The SOURCE is always named: each events source owns its own events and payload, and they are never mixed; { search } → FUZZY search over events/properties/attributes/VALUES/recipes (typo- and paraphrase-tolerant: "retenton"→retention recipe, "germny"→Germany value; exact hits first, each scored, fuzzy:false for substring-only); { recipe: id } → one ready-made recipe in full (payload + example_queries + the reusable `hack`); { guide: true } → HOW to approach a question: the analyst workflow + IF/DO routing triggers (which tool when) + per-task recipe families (pass a family name to narrow) — read it first if unsure; { bundle: "<bundle id>" } → for ONE app, which event properties are POPULATED vs EMPTY (skip the empties for that app); the overview lists apps under `bundles`; { status: true } → value-index sync state + background query jobs; { run } → one sync run\'s per-property breakdown.',
  create_semantic_model: 'The GOVERNED path: declaratively create/augment semantic models for a task (one SM per source, SEVERAL sources allowed in the same task — e.g. a spend measure and an event measure side by side) + metrics, in an isolated context. Produces NAMED metrics you then query many ways with query_semantic_model (group_by / time / filters) — reusable & re-sliceable. Use for measurable metrics (DAU, revenue, conversion, retention). Omit context_id for a new task; pass it to extend the same one. To CHANGE a task already in a context — add or remove measures, dimensions, metrics on one model without restating the rest — call the same tool with action:"update" (context_id + semantic_model + the add_*/remove_* fields). RETURNS ONLY { task_id, context_id } and never waits: the declaration is validated in the call, parsing it is the task — get_task_result({ task_id }) returns the parse, the metrics and what they can be grouped by; a query on the context may be issued right away (it waits for the parse). (For a one-off derived table — funnel/sessionization/window/pivot — use build_native_model.)',
  build_native_model: 'The ESCAPE HATCH for a one-off derived TABLE whose rows ARE the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the governed metrics cannot express. Composed INCREMENTALLY (single `action`-driven tool): start a draft, add_step one stage at a time (where/derive/compute/unnest/join/aggregate/pivot/unpivot/window/order_by/limit + match_recognize; a join names the RELATIONSHIP the schema declares (via: <name>) and never its columns, and joins STACK so one pipeline can reach several sources) — each add_step validates the stage and returns the columns then available for the NEXT stage (pure schema, NOTHING materialized until materialize) — optionally preview the SQL, then materialize — which returns ONLY a task_id and never waits: the build is the task, get_task_result({ task_id }) returns its rows (NOT query_semantic_model). start with from_task re-slices the stored table of a finished task (a materialized query, an earlier build) without recomputing it. For REUSABLE named metrics you query many ways, prefer create_semantic_model (the governed path). A `python` stage is a dbt PYTHON model of its own, allowed anywhere in the pipeline and repeatedly (the pipeline becomes a chain of models reading each other via ref, run on the warehouse\'s Python runtime, never here) — and it carries ONLY what SQL cannot say. ITS OWN DESCRIPTION is where the rules are: what belongs in it, what this warehouse\'s frame raises, and the index of worked recipes to study before writing a line. Its table is read with get_task_result like any pipeline.',
  query_semantic_model: 'Start a metric query against a context. metrics + group_by + where are validated in the call (a mistake is refused at once, with the fix). Joins are handled for you: group or filter by an attribute addressed as { model, attribute } and the declared key is applied — including the validity window of a slowly-changing model, so the attribute is the one valid at the time of each row (no window to state). RETURNS ONLY { task_id } and never waits: the query runs as a task, and get_task_result({ task_id }) returns its rows. materialize:true stores the whole result as a table — pageable, drawable as a drill-down, and the start of a pipeline (from_task).',
  get_task_result: `Read what a task produced — the ONE way to wait for work and to read it. It waits for the task (up to ${MAX_WAIT_SECONDS}s, returning the moment it is done) and returns its result: the rows of a query or a build, a parsed task, or the error it ended in; status "running" → call it again. offset/limit page a stored result (a materialized query, a pipeline build). It never draws anything.`,
  display_result: 'SHOW a finished result to the person as a card (in a host that renders MCP Apps) — the ONLY tool that draws. It reads the task through get_task_result and draws it ONCE: a second call for the same task is refused, so one question gets one card. Call it only for what the person should SEE — never for intermediate reads. `display` says how rows are drawn (a chart, KPI tiles, a funnel, a sankey, a drill-down pivot…; its schema lists each kind and the fields it needs), over the result\'s columns; an experiment\'s result draws its own card. A task still running is refused — wait for it with get_task_result first.',
  drill_result: 'The card\'s own read of the next view of a drawn drill-down (a pivot row opened, a chart mark clicked) — called by the card, never by the model.',
  // update_semantic_model is folded into create_semantic_model({ action: 'update' }) and hidden
  // from the listing; the name stays callable, so its description stays here for that caller.
  update_semantic_model: 'Add/remove task measures, dimensions or metrics for a table SM within a context; re-parses.',
  context: 'Manage isolated execution contexts (the workspaces create_semantic_model / build_native_model produce). action: list (all contexts) | describe (one context\'s tasks/models/metrics/group-by paths) | drop (tear the whole context down) | delete_model (remove just the native pipeline model, keep the context) | delete_semantic_model (remove one table\'s task additions, cascade for dependent metrics).',
  memory: 'DURABLE analyst memory — remember what you FOUND OUT so it comes back through semantic_index. After you resolve something non-obvious (a vague request tracked down to a real field, a gotcha, a useful source), record:"action" it: `note` the finding, `question` the ORIGINAL business question it answers (in the stakeholder\'s words — embedded with the note so a future similar question retrieves this insight by meaning), `targets` the catalog entities it is about, each as { source, name } (a property, attribute or event of that source — e.g. { source: "events", name: "ad_type_of_event_data" }, { source: "users", name: "country" }) or { source } for a model, `aliases` the words the user actually used ("ad format") — give them in BOTH the original language and English so search works cross-language, `links` any sources. The note then surfaces inline on the linked semantic_index views ({ model }/{ source, event }/{ source, property }) and in semantic_index({ search }) — so the next fuzzy phrasing resolves straight to the right field instead of re-investigating. RECORD ONE ATOMIC FINDING PER NOTE: when studying a topic or a document, split it into several small single-fact notes (each with its own targets/aliases) rather than dumping a whole topic into one big note — atomic notes link precisely and retrieve far better; an over-long note matches poorly and may fail to index. action: list (all, or one { target }) | search (by word — typo-tolerant fuzzy, and SEMANTIC/meaning-based when embeddings are enabled) | forget (by id).',
  experiment: 'The A/B EXPERIMENT lifecycle in one tool (action-driven): plan → check_split → analyze. action:"plan" = power/sample-size (required users, or the MDE at a given n) BEFORE running. action:"check_split" = Sample-Ratio-Mismatch χ² guardrail; p < 0.001 means randomization/logging is broken and the result is INVALID — run it BEFORE trusting any lift. action:"analyze" = the significance test on PRE-AGGREGATED per-group stats (metric: proportion → two-proportion z-test; mean → Welch t-test; ratio → delta-method; cuped → variance reduction), returning lift (+ relative-lift CI), p-value, CI, significance, and a multiplicity-adjusted p-value per variant; sequential:true adds an always-valid p for live peeking. Compute the per-group aggregates first with a pipeline. Field names are exact: use `baseline` (NOT baseline_rate) and `confidence` (NOT alpha); there is no `allocation` field (use check_split.expected_ratio). For proportion, each group needs `conversions` (0..n; conversions > n is rejected). Examples — plan: {action:"plan",metric:"proportion",baseline:0.1,mde:0.02}; check_split: {action:"check_split",groups:[{label:"control",n:5000},{label:"variant_b",n:5020}]}; analyze: {action:"analyze",metric:"proportion",control:{n:5000,conversions:500},variants:[{label:"variant_b",n:5020,conversions:580}],correction:"holm"}.',
  time: `Wait for \`seconds\` (capped at ${MAX_WAIT_SECONDS}), then return — a timer that touches no data and follows no task. To wait for a task, call get_task_result: it returns the moment the task is done.`,
};

// Human-readable display names for the tools (MCP `title` / annotations.title). The `name` stays
// the stable programmatic id; the title is what a client shows in its UI/picker.
const TOOL_TITLES = {
  semantic_index: 'Explore Semantic Index',
  create_semantic_model: 'Create Semantic Model',
  build_native_model: 'Build Pipeline',
  query_semantic_model: 'Query Semantic Model',
  get_task_result: 'Get Task Result',
  display_result: 'Display Result',
  drill_result: 'Drill Into Result',
  update_semantic_model: 'Update Semantic Model',
  context: 'Manage Contexts',
  memory: 'Use Memory',
  experiment: 'A/B Experiment Toolkit',
  time: 'Timer',
};

// Server-level documentation surfaced to the AI client (serverInfo.description):
// what this MCP is for and how to use it end-to-end.
// Told only to a client that renders MCP Apps (src/apps.js): the rest of the instructions hold for everyone.
const RESULT_CARDS = `RESULT CARDS: in a host that renders MCP Apps, a finished result can be drawn for the person as a card — a chart, KPI tiles, a funnel, a sankey, a drill-down pivot, the A/B test, the split check, the sample-size plan. ONE TOOL DRAWS: display_result({ task_id, display }) — nothing else ever does (not a query, not a build, not get_task_result). It reads the task through get_task_result and draws it ONCE; a second call for the same task is refused. So: start the work (it returns a task_id), read it with get_task_result as often as you need to work something out — that draws nothing — and call display_result once, for the result the person should SEE, before summarising it; do not draw your own chart of the same rows. An experiment returns its statistics at once with a task_id — display_result({ task_id }) draws its card. In \`display\` pick the \`kind\` whose description in the schema matches the question — each kind lists the fields it needs — and the card draws exactly that, in the declared order. It names result columns and changes no numbers; a column that is not in the result is refused with the list. A pivot or a chart with drill reads a STORED result: run the query with materialize:true (a pipeline build is stored already).`;

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
1. semantic_index — discover the catalog PROGRESSIVELY. Call it first with no arguments for an overview (models, event names, group-by paths, event_semantics = which event marks install/session/purchase, value-index freshness), then drill down: semantic_index({ model }) for a model's columns and attributes (with REAL sample values), ({ source, event }) for the properties an event carries, ({ source, property }) for one property or user attribute with its real value distribution, ({ search }) to find events/properties/attributes/values/recipes. The events fact has ~150 event-scoped properties, so they are fetched per event rather than all at once.
2. create_semantic_model — declare measures/dimensions/metrics for a task in an ISOLATED context (returns a context_id). Pass that context_id back to extend the same context.
   - For ordered multi-step funnels/paths (and any custom transform) use build_native_model: compose a PIPELINE one stage at a time (start → add_step* → materialize; each add_step shows the columns available next), building a model whose ROWS are the result — materialize returns a task_id, get_task_result returns the rows (a pipeline context is not queried via query_semantic_model). It accepts a time_range and an internal pre-filter (event subset / user segment). start with from_task instead of a source re-slices a finished task's stored table (a materialized query, an earlier build) without recomputing it.
   - Beyond SQL (a statistical test, clustering, scoring, a forecast), where the overview's python_models says available: add a 'python' stage to a build_native_model pipeline — but ONLY for the part SQL cannot express, with the table it reads prepared by the SQL stages before it. Do not write one from memory: semantic_index({ guide: "python" }) is this warehouse's frame rules and the reasoning behind them, the stage description indexes the worked recipes by the move each covers, and semantic_index({ recipe: "<id>" }) returns one in full. Read the result with get_task_result as usual.
3. query_semantic_model — run metrics with group_by / where / order_by / time_range. Options: dry_run (preview, no run), explain (query plan, no run), materialize (store the whole result as a table), limit/offset.
4. get_task_result — every call that does warehouse work (create_semantic_model, query_semantic_model, build_native_model materialize) returns ONLY a task_id and never waits. get_task_result({ task_id }) waits for the task (up to ${MAX_WAIT_SECONDS}s per call; again while it says running) and returns its result; offset/limit page a stored one. To re-slice a stored result without recomputing it, start a pipeline from it: build_native_model({ action: 'start', name, from_task }).

KEY CONCEPTS
- context_id: an isolated workspace; parallel tasks never collide. Manage via context({ action: list | describe | drop | delete_model | delete_semantic_model }).
- metric types: simple, ratio, cumulative, derived, conversion.
- group_by: { time: "metric_time", grain } for a time series, or { model, attribute } for an attribute addressed by where it lives (e.g. { model: "users", attribute: "country" }). Never a path string.
- recipes: ready-made, warehouse-proven payloads. The ones shipped with the server are per TECHNIQUE, not per business task — metric_types (ratio / derived / cumulative / conversion-window / boolean measure / the agg chosen per question / a governed measure), joins (an attribute of another model, a cohort grid on two time axes, two independent sources, a pipeline join by relationship name, a point-in-time join), pipeline (window lag, episodes by gap, an age axis, an ordered sequence, unnest, reshape, a volume/coverage check), ab_test (proportion, mean, CUPED, ratio, SRM, power) and, where python models run, bigframes (the correct form of one frame operation next to the form that raises, plus one per ml capability — parameters and scaling, a prediction per row, a supervised fit(X, y), an evaluation with a split, dimensionality reduction, categorical features) with GENERATED reference entries carrying the installed library's own signatures and method preconditions. A real question combines two or three. A deployment ADDS its own domain recipes on top (RECIPES_PATH), and those may be per task. The semantic_index overview lists every available id; semantic_index({ recipe: id }) returns one in full, semantic_index({ guide: true }) groups them by family.
- memory: durable findings. When you track a vague request down to a real field (or hit a gotcha, or find a useful source), record it with the memory tool, linked to the catalog entities it concerns — it then resurfaces on those semantic_index views and in semantic_index({ search }), so the next fuzzy phrasing resolves straight to the right field.
- when in doubt which builder: create_semantic_model = reusable named metrics (query many ways); build_native_model = a one-off derived table (funnel/sessionization/window/pivot), rows read via get_task_result.`;

// Short one-paragraph summary for serverInfo.description (UI/catalog contexts).
const SERVER_SUMMARY = 'Declarative semantic layer for product analytics: declare virtual semantic models — measures, dimensions, metrics, and multi-step funnels — over fixed, catalog-enumerated data sources (one or more events facts + a user-attributes dimension + experiment assignments) and query them by name; you never write SQL. Start with semantic_index, then create_semantic_model / build_native_model, then query_semantic_model.';

const ASYNC_TOOLS = new Set(['create_semantic_model', 'register_native_model', 'build_native_model', 'delete_native_model', 'query_semantic_model', 'get_task_result', 'display_result', 'drill_result', 'update_semantic_model', 'delete_semantic_model', 'semantic_index', 'context', 'describe_context', 'memory', 'time']);

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
  // Folded into create_semantic_model({ action: 'update' }) — the two schemas carried the same
  // catalog vocabulary twice in every listing. Still callable by name for a client that learned
  // it; just not advertised.
  'update_semantic_model',
  'list_query_jobs',
  'list_contexts', 'describe_context', 'drop_context', 'delete_native_model', 'delete_semantic_model',
  'ab_test', 'srm_check', 'sample_size', // folded into experiment({ action: analyze | check_split | plan })
]);

// WHAT EACH TOOL DOES TO ITS ENVIRONMENT, for the client deciding whether to ask before calling it
// (MCP ToolAnnotations). The honest reading of each hint:
//   readOnlyHint    — nothing is written anywhere (not even a scratch table);
//   destructiveHint — something that existed can be removed or overwritten;
//   idempotentHint  — the same call again has no further effect;
//   openWorldHint   — it reaches entities outside a closed domain (the web, other people's
//                     systems). The catalog's warehouse is a closed domain: false throughout.
const TOOL_BEHAVIOUR = {
  semantic_index: { readOnlyHint: true, idempotentHint: true },
  get_task_result: { readOnlyHint: true, idempotentHint: true },
  // draws a card, once per task: a second call is refused, not repeated
  display_result: { readOnlyHint: true, idempotentHint: false },
  drill_result: { readOnlyHint: true, idempotentHint: true },
  experiment: { readOnlyHint: true, idempotentHint: true },
  time: { readOnlyHint: true, idempotentHint: true },
  // every call starts a task; materialize:true persists the result into the context — a write, never a removal
  query_semantic_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  create_semantic_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  build_native_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // drop / delete_model / delete_semantic_model remove what a context holds
  context: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  // forget removes a finding
  memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  update_semantic_model: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

// Fallback title from a snake_case name: "get_task_result" → "Get Task Result".
function titleFromName(name) {
  return String(name).split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * The advertised tools, in two variants (src/apps.js). For a client that renders MCP Apps every
 * tool carries `_meta.ui` — its visibility (the model's; drill_result the view's only), and on
 * display_result the view — as the official ext-apps `registerAppTool` does. A client that does
 * not render them gets no `_meta.ui`, and neither display_result nor drill_result: nothing draws.
 */
export function buildToolDefs(engine, { renders = true } = {}) {
  return Object.entries(engine.schemas)
    .filter(([name]) => !HIDDEN_TOOLS.has(name) && (renders || !APPS_ONLY_TOOLS.has(name)))
    .map(([name, schema]) => {
      const title = TOOL_TITLES[name] || titleFromName(name);
      const meta = viewMeta(name, renders);
      const inputSchema = schema;
      // `title` is the MCP display-name field; `annotations.title` mirrors it for clients that
      // read the older annotations location. `name` remains the stable programmatic identifier.
      return {
        name,
        title,
        description: TOOL_DESCRIPTIONS[name] || name,
        inputSchema,
        annotations: { title, openWorldHint: false, ...(TOOL_BEHAVIOUR[name] || {}) },
        ...(meta ? { _meta: meta } : {}),
      };
    });
}

/** Every name that dispatches to the engine: the advertised tools AND the hidden ones kept for
 *  callers that learned them — and nothing else. The engine is an object with private methods
 *  (`_draftStart`, `close`, `gc`); a tool name is never a free method lookup. */
export function isCallableTool(engine, name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(engine.schemas, name) && typeof engine[name] === 'function';
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A tool's return value as an MCP CallToolResult: the JSON as text (what the model reads) and the
 *  same value as `structuredContent` (what a program — the Apps view — reads; the spec asks for
 *  both, and a host that uses the structured copy does not add it to the model's context). */
export function toCallToolResult(result, name, args) {
  // STRUCTURED OUTPUT ONLY FOR A CARD THAT WAS DRAWN: display_result's answer, when the engine drew
  // it (the task's one card), and the same view model the card runs finds something to draw.
  // Anything else — every other tool, a refusal, a failure — is the text alone.
  const structured = VIEWED_TOOLS.has(name) && isPlainObject(result) && result.drawn === true && buildViewModel(name, result, args).kind !== 'none';
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(structured ? { structuredContent: result } : {}),
    // a result the engine RETURNED as a failure ({ ok: false, error }) — a build that failed, a
    // query the warehouse refused — is a tool execution error like a thrown one (spec: isError)
    ...(isPlainObject(result) && result.ok === false ? { isError: true } : {}),
  };
}

// How often a call that carries a progressToken hears that it is still alive. Clients may reset
// their request timeout on progress, so a long build is not abandoned while it is still working.
const PROGRESS_EVERY_MS = Number(process.env.MCP_PROGRESS_INTERVAL_MS) || 5000;

/**
 * Run one tool call. Never throws for a tool's own failure — that is a CallToolResult with
 * isError (a Tool Execution Error the model can correct, per spec) — only for a name that is not a
 * tool. `signal` stops the processes the call started; `onProgress(params)` receives heartbeats.
 * Returns { result: CallToolResult, raw } — `raw` is the engine's value (null on error).
 */
export async function runTool(engine, name, args, { signal, onProgress, progressEveryMs = PROGRESS_EVERY_MS, renders = true } = {}) {
  const started = Date.now();
  logLine(name, `▶ call ${summarizeArgs(args)}`);
  if (!isCallableTool(engine, name)) {
    logLine(name, '✗ unknown tool');
    return { result: errorResult(`unknown tool: ${name}`, 'validate'), raw: null, unknown: true };
  }
  // a card for a client that renders none: the tool is not offered to it, so not accepted
  if (!renders && APPS_ONLY_TOOLS.has(name)) {
    logLine(name, '✗ from a client without the Apps extension');
    return { result: errorResult(`${name} is not available: this client does not declare the MCP Apps extension (io.modelcontextprotocol/ui), so nothing is drawn — read results with get_task_result`, 'validate'), raw: null };
  }
  let beat;
  if (onProgress) {
    let n = 0;
    beat = setInterval(() => {
      n += 1;
      try { onProgress({ progress: n, message: `${name}: still working (${Math.round((Date.now() - started) / 1000)}s)` }); } catch { /* a closed stream is not the call's failure */ }
    }, progressEveryMs);
  }
  try {
    let raw = await withSignal(signal, () => (ASYNC_TOOLS.has(name) ? engine[name](args || {}) : Promise.resolve().then(() => engine[name](args || {}))));
    // the hint to show a result as a card means nothing to a client that draws none
    if (!renders && isPlainObject(raw) && 'show_to_user' in raw) { const { show_to_user: _hint, ...rest } = raw; raw = rest; }
    logLine(name, `✓ ok in ${Date.now() - started}ms${summarizeResult(raw)}`);
    return { result: toCallToolResult(raw, name, args), raw };
  } catch (err) {
    const cancelled = !!signal?.aborted;
    logLine(name, `✗ ${cancelled ? 'cancelled' : 'error'} in ${Date.now() - started}ms: ${err?.message || String(err)}${err?.field ? ` (field: ${err.field})` : ''}`);
    return { result: errorResult(cancelled ? `cancelled: ${err?.message || 'the call was cancelled'}` : (err?.message || String(err)), cancelled ? 'cancelled' : err?.stage, err?.field, cancelled ? undefined : err?.code), raw: null };
  } finally {
    if (beat) clearInterval(beat);
  }
}

// The calls that WAIT on an engine task: under a protocol task they are run to its end.
const WAITS_ON_TASK = new Set(['get_task_result', 'display_result']);

/**
 * Run a tool call TO ITS END — what a protocol task runs. A call that waits on an engine task
 * (get_task_result, display_result) keeps waiting while the task runs, then answers as it would
 * have had the task been done: the host polls the protocol task instead of the model calling
 * again. A call that STARTS work returns its task_id at once, as always — it is never held.
 */
export async function runToCompletion(engine, name, args, { signal, renders = true } = {}) {
  if (WAITS_ON_TASK.has(name) && typeof args?.task_id === 'string' && engine.jobs?.get?.(args.task_id)) {
    // Following the task has the same contract as the call itself: a failure while waiting is a
    // TOOL error the caller reads, never a protocol fault or a 'completed' success.
    try {
      while (engine.jobs.get(args.task_id)?.status === 'running' && engine.jobs.isLive?.(args.task_id)) {
        if (signal?.aborted) throw signal.reason || new Error('cancelled');
        await withSignal(signal, () => engine.get_task_result({ task_id: args.task_id, wait_seconds: MAX_WAIT_SECONDS }));
      }
    } catch (err) {
      const cancelled = !!signal?.aborted;
      logLine(name, `✗ ${cancelled ? 'cancelled' : 'error'} while waiting for task ${args.task_id}: ${err?.message || String(err)}`);
      return { result: errorResult(cancelled ? `cancelled: ${err?.message || 'the call was cancelled'}` : (err?.message || String(err)), cancelled ? 'cancelled' : (err?.stage || 'task'), err?.field, cancelled ? undefined : err?.code), raw: null };
    }
  }
  return runTool(engine, name, args, { signal, renders });
}

export { TOOL_DESCRIPTIONS, TOOL_TITLES, SERVER_DESCRIPTION, SERVER_SUMMARY, HIDDEN_TOOLS };
export const SERVER_INFO = { name: 'dbt-semantic-mcp', version: '0.1.0', description: SERVER_SUMMARY };

// ── console logging (to stderr) so every tool call is visible in the logs ──────
export function logLine(tool, msg) {
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
  if (result.task_id) bits.push(`task_id=${result.task_id}`);
  if (result.status) bits.push(`status=${result.status}`);
  return bits.length ? ` [${bits.join(' ')}]` : '';
}

export function errorResult(message, stage, field, code) {
  const payload = { ok: false, error: { stage: stage || 'error', message, ...(field ? { field } : {}), ...(code ? { code } : {}) } };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * The services behind the MCP server for one engine: the task registry, the skills, the Apps view
 * and the resource space they share. Built once per engine (servicesFor caches it): the SDK builds
 * a server per request, and every one of them must see the same tasks and the same digests.
 */
export function createServices(engine, { taskTtlMs, taskPollMs, progressEveryMs = PROGRESS_EVERY_MS, taskAfterMs = Number(process.env.MCP_TASK_AFTER_MS) || 3000 } = {}) {
  const apps = appsSurface();
  let skills = null;
  try { skills = buildSkills(engine); } catch (e) { logLine('skills', `✗ not served: ${e?.message || e}`); }
  const tasks = new TaskRegistry({
    ttlMs: taskTtlMs ?? (Number(process.env.MCP_TASK_TTL_SECONDS) || 3600) * 1000,
    pollIntervalMs: taskPollMs ?? 2000,
  });
  const shutdownHooks = new Set();
  const skillPointer = skills?.skills.length
    ? `\n\nSKILLS\nThis procedure is also served as Agent Skills (skills/list, or read by URI): ${skills.skills.map((s) => s.uri).join(', ')}.`
    : '';
  return {
    engine,
    apps,
    skills,
    tasks,
    // built once: the SDK builds a server per request, and the definitions never change — in two
    // variants, for a client that renders MCP Apps and for one that does not (src/apps.js)
    toolDefs: { apps: buildToolDefs(engine, { renders: true }), plain: buildToolDefs(engine, { renders: false }) },
    // how often a call with a progressToken hears it is alive; how long a call may run inline
    // before it becomes a task (for a client that declared the Tasks extension)
    progressEveryMs,
    taskAfterMs,
    /** The instructions for what this client is offered: the card and skills paragraphs only for
     *  a client that declared those extensions (src/client-extensions.js). */
    instructionsFor(offer = {}) {
      return [SERVER_DESCRIPTION, offer.apps ? `\n${RESULT_CARDS}` : '', offer.skills ? skillPointer : ''].join('');
    },
    resources(offer = {}) {
      return [
        ...(offer.apps ? apps.resources() : []),
        ...(skills && offer.skills ? skills.skills.map((s) => ({ uri: s.uri, name: s.frontmatter.name, title: `Skill: ${s.frontmatter.name}`, description: s.frontmatter.description, mimeType: 'text/markdown', size: s.resources.find((r) => r.uri === s.uri)?.size })) : []),
      ];
    },
    templates(offer = {}) {
      return skills && offer.skills
        ? skills.skills.filter((s) => s.resources.some((r) => /\/recipes\//.test(r.uri))).map((s) => ({
          uriTemplate: s.uri.replace(/SKILL\.md$/, 'recipes/{recipe}.md'),
          name: `${s.frontmatter.name}-recipe`,
          title: `Recipe (${s.frontmatter.name})`,
          description: 'One recipe of this skill in full — payload, example queries, the reusable technique. The same entry as semantic_index({ recipe }).',
          mimeType: 'text/markdown',
        }))
        : [];
    },
    /** The contents of a resource, or null when this server has no such URI. */
    read(uri, offer = {}) {
      if (typeof uri !== 'string') return null;
      const ui = offer.apps ? apps.read(uri) : null;
      if (ui) return ui;
      const f = offer.skills ? skills?.read(uri) : null;
      return f ? [{ uri: f.uri, mimeType: f.mimeType, text: f.text }] : null;
    },
    onShutdown(fn) { shutdownHooks.add(fn); },
    close() { for (const fn of shutdownHooks) { try { fn(); } catch { /* best effort */ } } tasks.close(); },
  };
}

const servicesCache = new WeakMap();
/** The one services object of this engine. */
export function servicesFor(engine) {
  if (!servicesCache.has(engine)) servicesCache.set(engine, createServices(engine));
  return servicesCache.get(engine);
}
