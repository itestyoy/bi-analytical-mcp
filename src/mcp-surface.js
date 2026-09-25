// WHAT THIS SERVER OFFERS: the tool definitions, how one call runs, and the services behind the
// MCP surface (tasks, skills, the Apps view). src/mcp-server.js registers it on the official SDK's
// Server; the SDK owns the protocol — both revisions a client may speak, the wire format, the
// envelope and header rules — so nothing here knows which revision a request came in.

import { RESEARCH_DOMAINS, RESEARCH_ROUTE, RESEARCH_SCOPE } from './research-guides.js';
import { MAX_WAIT_SECONDS, MAX_BATCH } from './schema.js';
import { withSignal } from './request-context.js';
import { appsSurface, viewMeta, VIEWED_TOOLS, APPS_ONLY_TOOLS, APP_CALLABLE_TOOLS } from './apps.js';
import { buildViewModel } from './apps/result-view-model.js';

// experiment draws its own card when the call asks for it (`card: true`) — accepted only from a
// client that renders cards, like a call to display_model_result itself.
const CARD_FIELD = { experiment: 'card' };
import { buildSkills } from './skills.js';
import { surfaceFingerprint, surfaceChange, SurfaceChangeBus, CHANGE_WINDOW_MS } from './surface-change.js';
import { TaskRegistry } from './tasks.js';

const TOOL_DESCRIPTIONS = {
  semantic_index: `Explore the catalog: what the data means, its real values, how complete and how fresh it is. Use it before building anything while you do not yet know which events, properties or attributes answer the question, and whenever a field's meaning or values are unclear; fields already established earlier in the conversation need no second look. No arguments → the overview (models, event names, event_semantics — which event marks install / session / purchase, group-by paths, value-index freshness, recipe ids). Exactly one view key drills in: { model } → its columns and attributes with real sample values, the relationships it declares (join name, key columns, target) and the amounts it marks aggregatable (unit, meaning); { source, event } → the properties that event carries; { source, property } → one column's passport (spec/unit, value distribution — pageable, NULL coverage per event telling expected NULLs from data gaps, indexing history). Name the source every time: each events source owns its events and payload, and they are never mixed. { search } → fuzzy search over events, properties, attributes, values and recipes (typos and paraphrases tolerated: "retenton" → the retention recipe, "germny" → Germany; exact hits first, each scored; fuzzy:false for substring only); { recipe: id } → one ready-made recipe in full (payload, example_queries, the reusable \`hack\`); { guide: true } → how to approach a question: the analyst workflow, which tool fits which question, recipe families (pass a family name to narrow); { guide: "research" } → how to run an investigation (with ${RESEARCH_DOMAINS.join(', ')}); { bundle: "<bundle id>" } → which event properties one app populates and which it leaves empty (the overview lists apps under \`bundles\`); { status: true } → value-index sync state and background query jobs; { run } → one sync run's per-property breakdown.`,
  build_semantic_model: 'Declare reusable, named metrics for a task — semantic models (one per source; several sources may sit side by side, e.g. spend next to an event measure) plus metrics — in an isolated context, then query them many ways with query_semantic_model (group_by, time grain, filters). Use it for measurable metrics such as DAU, revenue, conversion or retention; for a one-off derived table whose rows are the answer (a funnel, sessions, a window, a pivot) use build_pipeline_model instead. Omit context_id to start a task; pass it to extend the same one. To change a task already in a context — add or remove measures, dimensions or metrics on one model without restating the rest — call it with action:"update" (context_id, semantic_model, the add_*/remove_* fields). The declaration is validated in the call; parsing it is a task, so the call returns only { task_id, context_id } and does not wait. query_semantic_model({ task_id }) returns the parse, the metrics and what they can be grouped by; a query on the context can be started right away (it waits for the parse).',
  build_pipeline_model: 'Build a one-off derived table whose rows are the answer — funnels (match_recognize), sessionization, window functions, pivots, anything the named metrics of build_semantic_model cannot express; for reusable metrics sliced many ways, use build_semantic_model instead. The pipeline is composed step by step with `action`: start a draft, add_step one stage at a time (where / derive / compute / unnest / join / aggregate / pivot / unpivot / window / order_by / limit / match_recognize), optionally preview the SQL, then materialize. Each add_step validates the stage and returns the columns available to the next one; nothing runs in the warehouse until materialize. A join names the relationship the schema declares (via: <name>) rather than its columns, and joins stack, so one pipeline can reach several sources. materialize returns only a task_id and does not wait: query_pipeline_model({ task_id }) returns the rows, and query_pipeline_model({ context_id, transform }) filters or regroups the built table later (query_semantic_model does not read pipelines). start with from_task re-slices the stored table of a finished task (a materialized query, an earlier build) without recomputing it. A `python` stage is a dbt Python model of its own, run on the warehouse\'s Python runtime; it may appear anywhere in the pipeline, more than once, and carries only what SQL cannot say. Its own description holds the rules — what belongs in it, what this warehouse\'s frame raises, and the recipes to study before writing one. Its table is read with query_pipeline_model like any pipeline.',
  query_semantic_model: `Start a metric query on a context built by build_semantic_model, or read one back. metrics, group_by and where are validated in the call; a mistake is refused at once, with the fix. Joins are applied for you: group or filter by an attribute addressed as { model, attribute } and the declared key is used — including the validity window of a slowly-changing model, so each row gets the attribute valid at its time. Starting a query returns only { task_id } and does not wait. The same tool reads it back: { task_id } waits for a semantic task — this query, or a model build_semantic_model is parsing — for up to ${MAX_WAIT_SECONDS}s and returns the moment it is done; while it says running, call again. materialize:true stores the whole result as a table: pageable ({ task_id, offset, limit }), drawable as a drill-down, and a starting point for a pipeline (from_task). Several independent queries on one context — other metrics, another breakdown, another window — go in one call: { context_id, queries: [ … ] }, up to ${MAX_BATCH}, run side by side; { task_ids } reads them back together, each result as { task_id } would give it (each stays a task of its own: paged, drawn, started from one by one). Stop a task you no longer need with { task_id, cancel: true } (or task_ids).`,
  query_pipeline_model: `Query a table built by build_pipeline_model, or read a pipeline task back — the pipeline side's counterpart of query_semantic_model. { context_id, transform? } starts a read-only projection (where / group_by / aggregations / having / order_by) over the stored table, recomputing nothing upstream, and returns only { task_id }. { task_id } waits for a pipeline task — a build (materialize) or such a query — for up to ${MAX_WAIT_SECONDS}s, returns its rows the moment it is done, and says running otherwise (call again); offset/limit page a build's stored table. Several projections of one model go in one call — { context_id, queries: [{ transform }, …] }, up to ${MAX_BATCH}, run side by side — and are read back together with { task_ids }. Stop a task you no longer need with { task_id, cancel: true } (or task_ids).`,
  display_model_result: 'Show a finished model result — a semantic query or a pipeline — to the person as a card, in a host that renders MCP Apps; it is the only tool that draws a model\'s rows. Use it once, for the result the person should see; reading a task for your own analysis goes through its query tool and needs no card. It reads the task the way the query tools do and draws it once — a second call for the same task is refused, so one question gets one card. `display` says how the rows are drawn (a chart, KPI tiles, a funnel, a sankey, a drill-down pivot…; its schema lists each kind and the fields it needs), over the result\'s columns. A task still running is refused: wait for it with its query tool ({ task_id }) first. An experiment is not a model result: it draws its own card with card: true.',
  drill_result: 'The card\'s own read of the next view of a drawn drill-down (a pivot row opened, a chart mark clicked). The card calls it; the model has no reason to.',
  // update_semantic_model is folded into build_semantic_model({ action: 'update' }) and hidden
  // from the listing; the name stays callable, so its description stays here for that caller.
  update_semantic_model: 'Add/remove task measures, dimensions or metrics for a table SM within a context; re-parses.',
  context: 'Manage the isolated contexts that build_semantic_model and build_pipeline_model create. action: list (all contexts) | describe (one context\'s tasks, models, metrics and group-by paths) | drop (tear the whole context down) | delete_model (remove just the pipeline model, keep the context) | delete_semantic_model (remove one table\'s task additions, with the metrics that depend on them). drop and the deletes cannot be undone.',
  memory: 'Durable analyst memory: record what you found out, so it comes back through semantic_index next time. Use it after you resolve something non-obvious — a vague request tracked down to a real field, a gotcha, a useful source. action:"record" takes `note` (the finding); `question` (the original business question it answers, in the stakeholder\'s words — it is embedded with the note, so a later question with the same meaning retrieves it); `targets` (the catalog entities it is about, each { source, name } — a property, attribute or event of that source, e.g. { source: "events", name: "ad_type_of_event_data" }, { source: "users", name: "country" } — or { source } for a model); `aliases` (the words the user actually used, e.g. "ad format", in the original language and in English so search works across languages); `links` (any sources). The note then appears on the linked semantic_index views ({ model } / { source, event } / { source, property }) and in semantic_index({ search }). Keep one finding per note: when studying a topic or a document, split it into several small notes, each with its own targets and aliases — small notes link precisely and are retrieved far better, while an over-long note matches poorly and may fail to index. Other actions: list (all, or one { target }) | search (by word — typo-tolerant, and by meaning when embeddings are enabled) | forget (by id).',
  experiment: 'The A/B experiment lifecycle in one tool, by action: plan → check_split → analyze. It is statistics over numbers you bring: compute the per-group aggregates first with a pipeline. action:"plan" — power / sample size (the users required, or the MDE at a given n), before the test runs. action:"check_split" — the sample-ratio-mismatch χ² guardrail; p < 0.001 means randomization or logging is broken and the result is invalid, so run it before trusting any lift. action:"analyze" — the significance test on pre-aggregated per-group stats (metric: proportion → two-proportion z-test; mean → Welch t-test; ratio → delta method; cuped → variance reduction), returning lift (with a relative-lift CI), p-value, CI, significance and a multiplicity-adjusted p per variant; sequential:true adds an always-valid p for peeking at a live test. Field names are exact: `baseline` (not baseline_rate) and `confidence` (not alpha); there is no `allocation` field (use check_split.expected_ratio). For proportion, each group needs `conversions` between 0 and n. Examples — plan: {action:"plan",metric:"proportion",baseline:0.1,mde:0.02}; check_split: {action:"check_split",groups:[{label:"control",n:5000},{label:"variant_b",n:5020}]}; analyze: {action:"analyze",metric:"proportion",control:{n:5000,conversions:500},variants:[{label:"variant_b",n:5020,conversions:580}],correction:"holm"}.',
  time: `Wait for \`seconds\` (capped at ${MAX_WAIT_SECONDS}), then return — a timer that touches no data and follows no task. To wait for a task, call its query tool with { task_id } instead (query_semantic_model or query_pipeline_model): it returns the moment the task is done.`,
};

// Human-readable display names for the tools (MCP `title` / annotations.title). The `name` stays
// the stable programmatic id; the title is what a client shows in its UI/picker.
const TOOL_TITLES = {
  semantic_index: 'Explore Semantic Index',
  build_semantic_model: 'Build Semantic Model',
  build_pipeline_model: 'Build Pipeline Model',
  query_semantic_model: 'Query Semantic Model',
  query_pipeline_model: 'Query Pipeline Model',
  display_model_result: 'Display Model Result',
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
const RESULT_CARDS = `RESULT CARDS
In a host that renders MCP Apps, a result can be drawn for the person as a card. A model result — a chart, KPI tiles, a funnel, a sankey, a drill-down pivot — is drawn by one tool, display_model_result({ task_id, display }); starting work and reading tasks never draws. It reads the task the way the query tools do and draws it once; a second call for the same task is refused, so one question gets one card. The flow: start the work (it returns a task_id), read it with its query tool — query_semantic_model({ task_id }) or query_pipeline_model({ task_id }) — as often as your analysis needs (reads draw nothing), then call display_model_result once, for the result the person should see, before summarising it. The card is the chart, so there is no need to draw your own chart of the same rows. An experiment is a separate process — statistics over the per-group numbers you bring, with no task: experiment returns them at once and draws its own card (the A/B test, the split check, the sample-size plan) only when you pass card: true; without it the answer is text only. In \`display\`, pick the \`kind\` whose description in the schema matches the question — each kind lists the fields it needs — and the card draws exactly that, in the declared order. It names result columns and changes no numbers; a column that is not in the result is refused with the list of those that are. A pivot, or a chart with drill, reads a stored result: run the query with materialize:true (a pipeline build is stored already).`;

/**
 * THE FIRST THING A CLIENT READS, and in some the only thing: Claude Code passes the server's
 * instructions on up to 2,048 characters, and a host routes between servers on their opening lines.
 * So this block states, within that budget, what the server is for, how a question flows through
 * it, and when to stop; the detail follows it, for a client that reads on. What the client was
 * offered (cards, skills) gets one line here and its full paragraph below.
 */
function coreInstructions({ apps = false, skillUris = [] } = {}) {
  return [
    'Declarative semantic layer for product analytics: you declare metrics and derived tables over a fixed data catalog and query them by name; the server writes and runs the SQL. Everything you can reference — events sources, a users dimension, experiment assignments, measures sources — is listed by the catalog.',
    '',
    'How a question flows:',
    '1. semantic_index — find the events, properties and attributes the question is about (no arguments: the overview; { guide: true }: the analyst workflow and which tool fits which question).',
    '2. build_semantic_model for reusable named metrics (DAU, revenue, retention, conversion); build_pipeline_model for a one-off table whose rows are the answer (funnels, sessions, windows, pivots, a python analysis).',
    `3. query_semantic_model / query_pipeline_model. A call that runs warehouse work returns a task_id at once; read the result with the same side's query tool ({ task_id }), which waits up to ${MAX_WAIT_SECONDS}s per call.`,
    '',
    'Name the events source in every call: sources are independent and never mixed. User attributes live on the users model ({ model: "users", attribute }), not on the events, and joins follow the relationships the catalog declares — you never state join columns.',
    `For ${RESEARCH_SCOPE}, read ${RESEARCH_ROUTE} first.`,
    'Answer as soon as a result answers the question; query again when the numbers look wrong or the question needs another cut, not to re-confirm a result you already have.',
    ...(apps ? ['Show the result the person should see as a card, once: display_model_result({ task_id, display }) (see RESULT CARDS below).'] : []),
    ...(skillUris.length ? [`The same procedure is served as Agent Skills: ${skillUris.join(', ')}.`] : []),
    '',
    'The sections below give the details.',
  ].join('\n');
}

const SERVER_DESCRIPTION = `WHAT IT DOES
You define "virtual" semantic models — measures, dimensions and metrics — on the fly over a fixed set of catalog data sources, and query them by name. You do not write SQL: everything you can reference (events, properties, user attributes, join paths) is enumerated by the catalog and enforced by the schema, so a field that does not exist cannot be named.

DATA MODEL (fixed roles)
- events source: one row per event — a user id, a session id, an event timestamp (the time axis), an event_name and typed event-data properties. Only per-event columns live here. A catalog may declare several events sources (e.g. product analytics events and crash reports). They are independent and equal: each owns its event vocabulary, its payload properties and its own indexed values, none is a default, and they are never mixed. The semantic_index overview lists them under "facts" with each one's own event_names. Name the source you mean in every call — semantic_index({ source, event }) / ({ source, property }), build_pipeline_model({ source }), build_semantic_model({ semantic_models: [{ from: <source> }] }) — so a name always has one owner. Within a source, event and property names are used as-is. Choose the source that records what the question is about.
- users dimension: one row per user — attributes (country, platform, media_source, acquisition_type, install_date, ...). It is reached by a join: group or filter by { model: 'users', attribute } in metric queries (declare use_base_models: ['users']), or add a join stage in pipelines. User attributes are not columns of the fact.
- experiments: one row per user×experiment (experiment_name, variant_group, assigned_at, ended_at) — join to events by the user entity, window to the assignment period, aggregate per group, then experiment({ action: check_split | analyze }).
- measures sources (optional): a non-events fact whose columns are amounts rather than events (e.g. acquisition spend at one row per player x day). It has no event_name; it declares its own time axis, and the catalog marks which of its fields are amounts — semantic_index({ model }) lists them under "aggregatable" with their unit and meaning. No aggregation is fixed: name the field in a measure's "field" and choose "agg" (sum / average / max / median / percentile / count_distinct) per question. It carries the user entity, so { model: 'users', attribute } segments it too. In a pipeline it joins an events source by the player key alone (via the declared relationship): one player has many events and several dated rows, so that pairing is many-to-many by design — use it to carry an attribute (channel, campaign) onto events, and aggregate the source itself to total an amount, since totals over the many-to-many join would be inflated.

JOINS BETWEEN SOURCES
Relationships are declared in the catalog: each has a name, and its key columns live in the schema. Group by { model: '<the model that carries the attribute>', attribute } in a metric query (with that model in use_base_models; add via when several relationships lead to it), or join with via: '<relationship>' in a pipeline. A key may span several columns and the two sides may name their columns differently — only the relationship name and the number of key parts have to agree. A relationship that no model owns has no governed path (MetricFlow joins only onto a unique key) and is a pipeline join; that is correct rather than a limitation. semantic_index({ model }) lists a model's relationships, their key columns and what each points at. Two events sources are joined the same way — in a pipeline, since a row-to-row match between two event streams is many-to-many. When a source carries several alternative key columns for one relationship (one tracking id per ad format), each is listed as its own relationship <name>_<variant>; pick the one the question is about. The users dimension may be slowly-changing (several versions per player, each with a validity window): joining it on the player key alone matches every version and inflates counts, so a pipeline join adds between: { value: <this source's time column>, from: <validity start>, to: <validity end> }. A metric query needs nothing — MetricFlow applies the window itself.
Funnels and sequences are built from events (a step = an event + an event_data property value) and run over one source, since a row-pattern match scans one table. Metrics from different sources can still be compared side by side when grouped by metric_time.

WORKFLOW
1. semantic_index — discover the catalog progressively. Call it with no arguments for the overview (models, event names, group-by paths, event_semantics = which event marks install/session/purchase, value-index freshness), then drill down: semantic_index({ model }) for a model's columns and attributes (with real sample values), ({ source, event }) for the properties an event carries, ({ source, property }) for one property or user attribute with its real value distribution, ({ search }) to find events/properties/attributes/values/recipes. An events fact can carry ~150 event-scoped properties, so they are fetched per event rather than all at once.
2. build_semantic_model — declare measures/dimensions/metrics for a task in an isolated context (it returns a context_id). Pass that context_id back to extend the same context.
   - For ordered multi-step funnels/paths (and any custom transform) use build_pipeline_model: compose a pipeline one stage at a time (start → add_step* → materialize; each add_step shows the columns available next), building a model whose rows are the result. materialize returns a task_id; query_pipeline_model({ task_id }) returns the rows, and query_pipeline_model({ context_id, transform }) filters or regroups the built model later (query_semantic_model does not read a pipeline context). It accepts a time_range and an internal pre-filter (event subset / user segment). start with from_task instead of a source re-slices a finished task's stored table (a materialized query, an earlier build) without recomputing it.
   - Beyond SQL (a statistical test, clustering, scoring, a forecast), where the overview's python_models says available: add a 'python' stage to a build_pipeline_model pipeline, for the part SQL cannot express only, with the table it reads prepared by the SQL stages before it — SQL runs where the data lives and stays exact and readable. Look up the frame rather than writing it from memory: semantic_index({ guide: "python" }) gives this warehouse's frame rules and the reasoning behind them, the stage description indexes the worked recipes by the move each covers, and semantic_index({ recipe: "<id>" }) returns one in full. Read the result with query_pipeline_model as usual.
3. query_semantic_model — run metrics with group_by / where / order_by / time_range. Options: dry_run (preview, no run), explain (query plan, no run), materialize (store the whole result as a table), limit/offset.
4. Tasks — every call that does warehouse work (build_semantic_model, query_semantic_model, build_pipeline_model materialize, query_pipeline_model) returns only a task_id and does not wait. The query tool of the same side reads it back: query_semantic_model({ task_id }) for the semantic side (a model being parsed, a metric query), query_pipeline_model({ task_id }) for the pipeline side (a build, a query over a built model). It waits up to ${MAX_WAIT_SECONDS}s per call (call again while it says running) and returns the result; offset/limit page a stored one. Independent queries on one context go in one call (queries: up to ${MAX_BATCH}, run side by side) and are read together ({ task_ids }). To build further on a stored result without recomputing it, start a pipeline from it: build_pipeline_model({ action: 'start', name, from_task }).

KEY CONCEPTS
- context_id: an isolated workspace, so parallel tasks do not collide. Manage it with context({ action: list | describe | drop | delete_model | delete_semantic_model }).
- metric types: simple, ratio, cumulative, derived, conversion.
- group_by: { time: "metric_time", grain } for a time series, or { model, attribute } for an attribute addressed by where it lives (e.g. { model: "users", attribute: "country" }) — an object, not a path string.
- recipes: ready-made, warehouse-proven payloads. The ones shipped with the server are per technique, not per business task — metric_types (ratio / derived / cumulative / conversion-window / boolean measure / the agg chosen per question / a governed measure), joins (an attribute of another model, a cohort grid on two time axes, two independent sources, a pipeline join by relationship name, a point-in-time join), pipeline (window lag, episodes by gap, an age axis, an ordered sequence, unnest, reshape, a volume/coverage check), ab_test (proportion, mean, CUPED, ratio, SRM, power) and, where python models run, bigframes (the correct form of one frame operation next to the form that raises, plus one per ml capability — parameters and scaling, a prediction per row, a supervised fit(X, y), an evaluation with a split, dimensionality reduction, categorical features) with generated reference entries carrying the installed library's own signatures and method preconditions. A real question usually combines two or three. A deployment adds its own domain recipes on top (RECIPES_PATH), and those may be per task. The semantic_index overview lists every available id; semantic_index({ recipe: id }) returns one in full, semantic_index({ guide: true }) groups them by family.
- memory: durable findings. When you track a vague request down to a real field (or hit a gotcha, or find a useful source), record it with the memory tool, linked to the catalog entities it concerns — it then resurfaces on those semantic_index views and in semantic_index({ search }), so the next fuzzy phrasing resolves straight to the right field.
- which builder: build_semantic_model for reusable named metrics you query many ways; build_pipeline_model for a one-off derived table (funnel / sessionization / window / pivot), queried with query_pipeline_model.`;


// Short one-paragraph summary for serverInfo.description (UI/catalog contexts).
const SERVER_SUMMARY = 'Declarative semantic layer for product analytics: declare virtual semantic models — measures, dimensions, metrics, and multi-step funnels — over fixed, catalog-enumerated data sources (one or more events facts + a user-attributes dimension + experiment assignments) and query them by name; you never write SQL. Start with semantic_index, then build_semantic_model / build_pipeline_model, then query_semantic_model / query_pipeline_model.';

const ASYNC_TOOLS = new Set(['build_semantic_model', 'register_native_model', 'build_pipeline_model', 'delete_native_model', 'query_semantic_model', 'query_pipeline_model', 'display_model_result', 'drill_result', 'update_semantic_model', 'delete_semantic_model', 'semantic_index', 'context', 'describe_context', 'memory', 'time']);

// Tools that still EXIST (schema + engine method + dispatch) but are no longer
// advertised to the AI — superseded by / folded into a newer tool. Code is kept so the
// new tool can delegate to them and existing callers/recipes/tests keep working.
//   register_native_model        → all-at-once path behind the incremental build_pipeline_model
//   list_query_jobs              → folded into semantic_index({ status })
//   list_recipes / get_recipe    → folded into semantic_index (overview list + { recipe: id })
//   list/describe/drop_context,
//   delete_native/semantic_model → folded into the single context({ action }) tool
const HIDDEN_TOOLS = new Set([
  'register_native_model',
  // Folded into build_semantic_model({ action: 'update' }) — the two schemas carried the same
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
  // draws a card, once per task: a second call is refused, not repeated
  display_model_result: { readOnlyHint: true, idempotentHint: false },
  drill_result: { readOnlyHint: true, idempotentHint: true },
  experiment: { readOnlyHint: true, idempotentHint: true },
  time: { readOnlyHint: true, idempotentHint: true },
  // every call starts a task; materialize:true persists the result into the context — a write, never a removal
  query_semantic_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // every call starts or reads a task; a query over a built model writes nothing to the warehouse
  query_pipeline_model: { readOnlyHint: true, idempotentHint: false },
  build_semantic_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  build_pipeline_model: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // drop / delete_model / delete_semantic_model remove what a context holds
  context: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  // forget removes a finding
  memory: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  update_semantic_model: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

// Fallback title from a snake_case name: "query_pipeline_model" → "Query Pipeline Model".
function titleFromName(name) {
  return String(name).split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * The advertised tools — ONE list, the same for every client, as the official ext-apps
 * `registerAppTool` does: every tool carries `_meta.ui` (its visibility — the model's; drill_result
 * the view's only — and on display_model_result and experiment the view), and a host without the
 * extension ignores it. It is not a per-client list because a host re-draws a card already in a
 * conversation (reopened, or on another device) by finding the tool that drew it, on a listing
 * that need not carry the Apps declaration: a list without display_model_result there made every
 * stored card "Connector not found". What a client WITHOUT the extension does not get is what
 * speaks to its model — the card instructions and the show_to_user hint — and a call that would
 * draw is refused (runTool).
 */
export function buildToolDefs(engine) {
  return Object.entries(engine.schemas)
    .filter(([name]) => !HIDDEN_TOOLS.has(name))
    .map(([name, schema]) => {
      const title = TOOL_TITLES[name] || titleFromName(name);
      const meta = viewMeta(name);
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

// RENAMED TOOLS stay callable under the name a client learned — never advertised, the same call
// under the new name (so a task one started is read back as before). get_task_result is not here:
// it was not renamed but split, each side's query tool reading its own tasks, and a call to it is
// answered with that (see runTool).
export const TOOL_ALIASES = Object.freeze({
  create_semantic_model: 'build_semantic_model',
  build_native_model: 'build_pipeline_model',
  display_result: 'display_model_result',
});
const REMOVED_TOOLS = {
  get_task_result: 'a task is read back by the query tool of its side: query_semantic_model({ task_id }) for a semantic model or a metric query, query_pipeline_model({ task_id }) for a pipeline build or a query over one',
  get_query_result: 'a task is read back by the query tool of its side ({ task_id }); a built pipeline model is queried with query_pipeline_model({ context_id, transform })',
};
/** What a call to a name that is not a tool is told — with the replacement, for a tool that was removed. */
export function unknownToolMessage(name) {
  return REMOVED_TOOLS[name] ? `${name} no longer exists: ${REMOVED_TOOLS[name]}` : `unknown tool: ${name}`;
}
/** The tool a name dispatches to: itself, or the current name of a renamed tool. */
export const canonicalTool = (name) => TOOL_ALIASES[name] || name;

/** Every name that dispatches to the engine: the advertised tools, the hidden ones kept for
 *  callers that learned them and the old names of renamed tools — and nothing else. The engine is
 *  an object with private methods (`_draftStart`, `close`, `gc`); a tool name is never a free
 *  method lookup. */
export function isCallableTool(engine, name) {
  const tool = typeof name === 'string' ? canonicalTool(name) : name;
  return typeof tool === 'string' && Object.prototype.hasOwnProperty.call(engine.schemas, tool) && typeof engine[tool] === 'function';
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A tool's return value as an MCP CallToolResult: the JSON as text (what the model reads) and the
 *  same value as `structuredContent` (what a program — the Apps view — reads; the spec asks for
 *  both, and a host that uses the structured copy does not add it to the model's context). */
export function toCallToolResult(result, name, args) {
  // STRUCTURED OUTPUT ONLY FOR A CARD THAT IS DRAWN: display_model_result's answer when the engine drew
  // it (the task's one card), or experiment's when the call asked for its card (`card: true`) — and
  // only when the same view model the card runs finds something to draw. Anything else — every
  // other tool, a refusal, a failure — is the text alone.
  const asked = name === 'experiment' ? args?.card === true : isPlainObject(result) && result.drawn === true;
  const structured = VIEWED_TOOLS.has(name) && asked && isPlainObject(result) && buildViewModel(name, result, args).kind !== 'none';
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
export async function runTool(engine, calledAs, args, { signal, onProgress, progressEveryMs = PROGRESS_EVERY_MS, renders = true } = {}) {
  const started = Date.now();
  logLine(calledAs, `▶ call ${summarizeArgs(args)}`);
  if (!isCallableTool(engine, calledAs)) {
    logLine(calledAs, '✗ unknown tool');
    return { result: errorResult(unknownToolMessage(calledAs), 'validate'), raw: null, unknown: true };
  }
  const name = canonicalTool(calledAs);
  // a card for a client that renders none: the tool is not offered to it, so not accepted. The
  // card's own read (drill_result) is the exception: the HOST makes that call on behalf of a card
  // this server drew, and the proof it may read is the drawn task — not the envelope the host puts
  // on a proxied request, which the host decides and this server cannot vouch for.
  if (!renders && APPS_ONLY_TOOLS.has(name) && !APP_CALLABLE_TOOLS.includes(name)) {
    logLine(name, '✗ from a client without the Apps extension');
    return { result: errorResult(`${name} is not available: this client does not declare the MCP Apps extension (io.modelcontextprotocol/ui), so nothing is drawn — read results with query_semantic_model / query_pipeline_model ({ task_id })`, 'validate'), raw: null };
  }
  const cardField = CARD_FIELD[name];
  if (!renders && cardField && args?.[cardField] !== undefined) {
    logLine(name, `✗ ${cardField} from a client without the Apps extension`);
    return { result: errorResult(`${cardField} is not available: this client does not declare the MCP Apps extension (io.modelcontextprotocol/ui), so no card is drawn — drop the ${cardField} field`, 'validate', cardField), raw: null };
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

// The calls that WAIT on an engine task — a query tool's read half ({ task_id }) and
// display_model_result: under a protocol task they are run to its end.
const WAITS_ON_TASK = new Set(['query_semantic_model', 'query_pipeline_model', 'display_model_result']);

/**
 * Run a tool call TO ITS END — what a protocol task runs. A call that waits on an engine task
 * (a query tool with { task_id }, display_model_result) keeps waiting while the task runs, then
 * answers as it would have had the task been done: the host polls the protocol task instead of
 * the model calling again. A call that STARTS work returns its task_id at once, as always — it is
 * never held.
 */
export async function runToCompletion(engine, calledAs, args, { signal, renders = true } = {}) {
  const name = canonicalTool(calledAs);
  // the tasks the call reads: one (task_id), or a batch (task_ids) — followed until every one is done
  const ids = typeof args?.task_id === 'string' ? [args.task_id] : Array.isArray(args?.task_ids) ? args.task_ids.filter((id) => typeof id === 'string') : [];
  // (a cancel is answered at once: it never waits for the task it stops)
  let waits = WAITS_ON_TASK.has(name) && !args?.cancel && ids.length > 0 && ids.every((id) => engine.jobs?.get?.(id));
  // what the call would refuse — bad arguments, a task of the other side, a card already drawn — is
  // refused NOW, not after sitting through the whole task
  if (waits && typeof engine._precheckWait === 'function') {
    try { engine._precheckWait(name, args); } catch { waits = false; }
  }
  if (waits) {
    // Following the task has the same contract as the call itself: a failure while waiting is a
    // TOOL error the caller reads, never a protocol fault or a 'completed' success.
    try {
      const running = () => ids.filter((id) => engine.jobs.get(id)?.status === 'running' && engine.jobs.isLive?.(id));
      for (let left = running(); left.length; left = running()) {
        if (signal?.aborted) throw signal.reason || new Error('cancelled');
        await withSignal(signal, () => engine._awaitTasks(left, MAX_WAIT_SECONDS));
      }
    } catch (err) {
      const cancelled = !!signal?.aborted;
      logLine(name, `✗ ${cancelled ? 'cancelled' : 'error'} while waiting for task ${ids.join(', ')}: ${err?.message || String(err)}`);
      return { result: errorResult(cancelled ? `cancelled: ${err?.message || 'the call was cancelled'}` : (err?.message || String(err)), cancelled ? 'cancelled' : (err?.stage || 'task'), err?.field, cancelled ? undefined : err?.code), raw: null };
    }
  }
  return runTool(engine, calledAs, args, { signal, renders });
}

export { TOOL_DESCRIPTIONS, TOOL_TITLES, SERVER_DESCRIPTION, SERVER_SUMMARY, HIDDEN_TOOLS, coreInstructions };
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
  const skillUris = skills?.skills.map((s) => s.uri) ?? [];
  const skillPointer = skillUris.length
    ? `\n\nSKILLS\nThis procedure is also served as Agent Skills (skills/list, or read by URI): ${skillUris.join(', ')}.`
    : '';
  // the core block first (within the budget a client may cut to), the detail after it
  const instructionsFor = (offer = {}) => [
    coreInstructions({ apps: !!offer.apps, skillUris: offer.skills ? skillUris : [] }),
    `\n\n${SERVER_DESCRIPTION}`,
    offer.apps ? `\n\n${RESULT_CARDS}` : '',
    offer.skills ? skillPointer : '',
  ].join('');
  // built once: the SDK builds a server per request, and the definitions never change in a process
  const defs = buildToolDefs(engine);
  // WHAT A CLIENT CACHES ABOUT THIS SERVER, fingerprinted — and compared with what the previous
  // process served, so a change is announced (src/surface-change.js)
  const fingerprint = surfaceFingerprint({
    tools: defs,
    resources: apps.resources(),
    skills: skills?.skills.map((s) => s.resources.map((r) => [r.uri, r.digest ?? r.size])) ?? null,
    instructions: instructionsFor({ apps: true, skills: true }),
  });
  const surface = surfaceChange(engine.store, fingerprint);
  logLine('surface', `${fingerprint}${surface.changed ? ` — changed since the last start (${surface.previous || 'none recorded'}): open subscriptions are told for the next ${Math.round(CHANGE_WINDOW_MS / 60000)} min` : ' — unchanged'}`);
  return {
    engine,
    apps,
    skills,
    tasks,
    // one list for every client (see buildToolDefs); kept under both variants the server asks for
    toolDefs: { apps: defs, plain: defs },
    // the surface's fingerprint rides in serverInfo.version, so a changed surface is a changed version
    surface,
    serverInfo: { ...SERVER_INFO, version: `${SERVER_INFO.version}+${fingerprint}` },
    // the bus subscriptions/listen streams subscribe to: a changed start announces itself on it
    bus: new SurfaceChangeBus(surface, { onerror: (e) => logLine('surface', `✗ listener: ${e?.message || e}`) }),
    // how often a call with a progressToken hears it is alive; how long a call may run inline
    // before it becomes a task (for a client that declared the Tasks extension)
    progressEveryMs,
    taskAfterMs,
    /** The instructions for what this client is offered: the card and skills paragraphs only for
     *  a client that declared those extensions (src/client-extensions.js). */
    instructionsFor,
    resources(offer = {}) {
      return [
        ...apps.resources(), // the view page: listed and read for every client, like the tools that draw into it
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
      // The view page is served to ANY request that asks for it by its URI. A card already in a
      // conversation is re-drawn by the host when the chat is reopened — on this device or another
      // — and that fetch need not carry the Apps declaration; refusing it broke every stored card
      // ("Connector not found"). It is a static page that draws only the result the host hands it:
      // reading it offers nothing. What is OFFERED — the listing, the tools that draw, the
      // instructions — stays for a client that declares the extension.
      const ui = apps.read(uri);
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
