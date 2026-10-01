// WHAT THIS SERVER OFFERS: the tool definitions, how one call runs, and the services behind the
// MCP surface (tasks, skills, the Apps view). src/mcp-server.js registers it on the official SDK's
// Server; the SDK owns the protocol — both revisions a client may speak, the wire format, the
// envelope and header rules — so nothing here knows which revision a request came in.

import { setting } from './settings.js';
import { RESEARCH_ROUTE, RESEARCH_SCOPE } from './research-guides.js';
import { MAX_WAIT_SECONDS } from './schema.js';
import { withSignal } from './request-context.js';
import { appsSurface, viewMeta } from './apps.js';
import { wireSchema } from './schema/transport.js';
import { isPlainObject } from './engine/helpers.js';
import { buildViewModel } from './apps/result-view-model.js';
import { toolRegistry } from './tools/define.js';
import { CORE_TOOLS } from './tools/core.js';

import { buildSkills } from './skills.js';
import { surfaceFingerprint, surfaceChange, SurfaceChangeBus, CHANGE_WINDOW_MS } from './surface-change.js';
import { TaskRegistry } from './tasks.js';

// Told only to a client that renders MCP Apps (src/apps.js): the rest of the instructions hold for everyone.
const RESULT_CARDS = `RESULT CARDS
In a host that renders MCP Apps, a result can be drawn for the person as a card. A model result — a chart, KPI tiles, a funnel, a sankey, a drill-down pivot — is drawn by one tool, display_model_result({ request: { task_id, display } }); starting work and reading tasks never draws. The flow: start the work (it returns a task_id), read it with its query tool — query_semantic_model({ request: { task_ids } }) or query_pipeline_model({ request: { task_ids } }) — as often as your analysis needs (reads draw nothing), then call display_model_result once, for the result the person should see, before summarising it. The card is the chart, so there is no need to draw your own chart of the same rows. An experiment is a separate process — statistics over the per-group numbers you bring, with no task: experiment returns them at once and draws its own card — the A/B test (analyze) only — when you pass card: true; the split check and the plan are answered in words. In \`display\`, pick the \`kind\` whose description in the schema matches the question — each kind lists the fields it needs — and the card draws exactly that, in the declared order. It names result columns and changes no numbers; a column that is not in the result is refused with the list of those that are. A pivot, or a chart with drill, reads a stored result: run the query with materialize:true (a pipeline build is stored already).`;

/**
 * THE FIRST THING A CLIENT READS, and in some the only thing. `instructions` (InitializeResult in
 * the 2025 revisions, DiscoverResult in 2026-07-28) is a hint a client MAY put in the model's system
 * prompt, and each client cuts it differently: ChatGPT and Codex ask for the first 512 characters to
 * stand alone, Claude Code keeps 2,048, and some clients (the OpenAI Agents SDK, API connectors)
 * read none of it. So the OPENING paragraph says, within 512 characters, what the server is for and
 * how a question flows; the core block adds, within 2,048, the rules that span several tools; what
 * follows is for a client that reads on. Nothing a single call needs lives only here — every tool
 * description stands on its own, and the spec asks instructions not to repeat them.
 */
function coreInstructions({ apps = false, skillUris = [], featureLines = [] } = {}) {
  return [
    'Semantic layer for product analytics over a fixed data catalog: you declare metrics and derived tables and query them by name; the server writes and runs the SQL. Flow: semantic_index (find what exists) → build_semantic_model (reusable named metrics) or build_pipeline_model (a one-off table: funnels, sessions, pivots) → query_semantic_model / query_pipeline_model. Warehouse work returns a task_id at once; read it back with the same side\'s query tool.',
    '',
    'Every tool takes its input under one field: tool({ request: { … } }); a bare shape below, like { task_ids }, is the request\'s content.',
    `semantic_index({ request: {} }) gives the catalog overview — its sources and models; { guide: true } the analyst workflow and which tool fits which question. A read ({ task_ids }) waits up to ${MAX_WAIT_SECONDS}s per call.`,
    '',
    'Name the events source in every call: sources are independent and never mixed. User attributes live on the users model ({ model: "users", attribute }), not on the events, and joins follow the relationships the catalog declares — you never state join columns.',
    `For ${RESEARCH_SCOPE}, first read ${RESEARCH_ROUTE}.`,
    'Answer as soon as a result answers the question; query again when the numbers look wrong or the question needs another cut, not to re-confirm a result you already have.',
    ...featureLines,
    ...(apps ? ['Show the result the person should see as a card, once, with display_model_result (see RESULT CARDS below).'] : []),
    ...(skillUris.length ? [`The same procedure is served as Agent Skills: ${skillUris.join(', ')}.`] : []),
    '',
    'The sections below describe the data model and how its sources join.',
  ].join('\n');
}

// The rules that span several tools — what the sources are and how they join — which no single tool
// description carries; the per-tool detail lives in the tool descriptions and the schema, the long
// procedures behind semantic_index ({ guide }, { recipe }) and the skills.
const SERVER_DESCRIPTION = `DATA MODEL (fixed roles)
- events source: one row per event — a user id, a session id, an event timestamp (the time axis), an event_name and typed event-data properties. Only per-event columns live here. A catalog may declare several events sources (e.g. product analytics events and crash reports). They are independent and equal: each owns its event vocabulary, its payload properties and its own indexed values, none is a default, and they are never mixed. The semantic_index overview lists them under "facts" with each one's own event_names. Name the source you mean in every call — semantic_index({ request: { source, event } }) / ({ source, property }), build_pipeline_model({ request: { source } }), build_semantic_model({ request: { semantic_models: [{ from: <source> }] } }) — so a name always has one owner. Within a source, event and property names are used as-is. Choose the source that records what the question is about.
- users dimension: one row per user — attributes (country, platform, media_source, acquisition_type, install_date, ...). It is reached by a join: group or filter by { model: 'users', attribute } in metric queries (declare use_base_models: ['users']), or add a join stage in pipelines. User attributes are not columns of the fact.
- experiments: one row per user×experiment (experiment_name, variant_group, assigned_at, ended_at) — join to events by the user entity, window to the assignment period, aggregate per group, then experiment({ request: { action: check_split | analyze } }).
- measures sources (optional): a non-events fact whose columns are amounts rather than events (e.g. acquisition spend at one row per player x day). It has no event_name; it declares its own time axis, and the catalog marks which of its fields are amounts — semantic_index({ request: { model } }) lists them under "aggregatable" with their unit and meaning. No aggregation is fixed: name the field in a measure's "field" and choose "agg" (sum / average / max / median / percentile / count_distinct) per question. It carries the user entity, so { model: 'users', attribute } segments it too. In a pipeline it joins an events source by the player key alone (via the declared relationship): one player has many events and several dated rows, so that pairing is many-to-many by design — use it to carry an attribute (channel, campaign) onto events, and aggregate the source itself to total an amount, since totals over the many-to-many join would be inflated.

JOINS BETWEEN SOURCES
Relationships are declared in the catalog: each has a name, and its key columns live in the schema. Group by { model: '<the model that carries the attribute>', attribute } in a metric query (with that model in use_base_models; add via when several relationships lead to it), or join with via: '<relationship>' in a pipeline. A key may span several columns and the two sides may name their columns differently — only the relationship name and the number of key parts have to agree. A relationship that no model owns has no governed path (MetricFlow joins only onto a unique key) and is a pipeline join; that is correct rather than a limitation. semantic_index({ request: { model } }) lists a model's relationships, their key columns and what each points at. Two events sources are joined the same way — in a pipeline, since a row-to-row match between two event streams is many-to-many. When a source carries several alternative key columns for one relationship (one tracking id per ad format), each is listed as its own relationship <name>_<variant>; pick the one the question is about. The users dimension may be slowly-changing (several versions per player, each with a validity window): joining it on the player key alone matches every version and inflates counts, so a pipeline join adds between: { value: <this source's time column>, from: <validity start>, to: <validity end> }. A metric query needs nothing — MetricFlow applies the window itself.
Funnels and sequences are built from events (a step = an event + an event_data property value) and run over one source, since a row-pattern match scans one table. Metrics from different sources can still be compared side by side when grouped by metric_time.

WHERE THE DETAIL IS
- semantic_index({ request: { guide: true } }): the analyst workflow, which tool fits which question, the recipe families.
- semantic_index({ request: { recipe: "<id>" } }): one warehouse-proven payload in full; the overview lists the ids, and a real question usually combines two or three.
- semantic_index({ request: { guide: "python" } }): the frame rules for a python stage, where the overview's python_models says it is available; the SQL stages before it prepare the table it reads.
- memory: record a vague phrase you tracked down to a real field, or a gotcha, linked to the catalog entities it concerns; it resurfaces on their semantic_index views and in semantic_index({ request: { search } }).
- context({ request: { action } }): list or describe a workspace (context_id) and the models in it; delete_context removes one.`;


// Short one-paragraph summary for serverInfo.description (UI/catalog contexts).
const SERVER_SUMMARY = 'Declarative semantic layer for product analytics: declare virtual semantic models — measures, dimensions, metrics, and multi-step funnels — over fixed, catalog-enumerated data sources (one or more events facts + a user-attributes dimension + experiment assignments) and query them by name; you never write SQL. Start with semantic_index, then build_semantic_model / build_pipeline_model, then query_semantic_model / query_pipeline_model.';

// WHAT A TOOL IS — its title, description, annotations, the task side it starts
// and reads, whether it draws — is its definition (src/tools/define.js): the core's in
// src/tools/core.js, a feature's in its module, all in the engine's one registry (`engine.tools`).
// The surface below reads nothing else. Without an engine (a card's result checked on its own) it
// reads the core's.
const CORE_REGISTRY = toolRegistry(CORE_TOOLS);
const toolsOf = (engine) => engine?.tools || CORE_REGISTRY;

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
  return toolsOf(engine).values().map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: wireSchema(engine.schemas[def.name]),
    ...(def.output ? { outputSchema: def.output } : {}),
    annotations: { openWorldHint: false, ...def.annotations },
    _meta: viewMeta(def),
  }));
}

/** What a call to a name that is not a tool is told. */
export function unknownToolMessage(name) {
  return `unknown tool: ${name}`;
}

/** Every name that dispatches: the tools the registry defines — and nothing else. The engine is an
 *  object with private methods (`_draftStart`, `close`, `gc`); a tool name is never a free method lookup. */
export function isCallableTool(engine, name) {
  return typeof name === 'string' && toolsOf(engine).has(name);
}

/**
 * The input of a call: the value of its one field, `request`. A call written some other way — its
 * fields at the top, or nothing at all — is refused with the shape to use, the fields it gave moved
 * where they belong, so the next call is right.
 */
export function requestOf(name, args) {
  const given = isPlainObject(args) ? args : {};
  const keys = Object.keys(given);
  if (keys.length === 1 && keys[0] === 'request' && isPlainObject(given.request)) return { request: given.request };
  const others = keys.filter((k) => k !== 'request');
  const call = others.length
    ? `${name}({ request: { ${others.join(', ')} } }) — ${others.length === 1 ? `the field '${others[0]}' goes` : `the fields ${others.map((k) => `'${k}'`).join(', ')} go`} inside request`
    : `${name}({ request: { … } }) — request holds the fields the tool's schema lists ({ request: {} } when it needs none)`;
  const bad = keys.includes('request') && !isPlainObject(given.request) ? ' (request must be an object)' : '';
  return { error: `${name} takes its input under one field, request: call ${call}${bad}` };
}

/** A tool's return value as an MCP CallToolResult: the JSON as text (what the model reads) and the
 *  same value as `structuredContent` (what a program — the Apps view — reads; the spec asks for
 *  both, and a host that uses the structured copy does not add it to the model's context). */
export function toCallToolResult(result, name, args, engine = null) {
  // STRUCTURED OUTPUT FOR A CARD THAT IS DRAWN, AND FOR AN ANSWER OF A DECLARED SHAPE: display_model_result's
  // answer when the engine drew it (the task's one card), or experiment's when the call asked for its card
  // (`card: true`) — and only when the same view model the card runs finds something to draw (a feature's
  // drawing tool follows the same rule with its own view model); and every successful answer of a tool
  // that declares its outputSchema (src/schema/outputs.js — tools with no view, so nothing is drawn).
  // Anything else — every other tool, a refusal, a failure — is the text alone.
  const def = toolsOf(engine).get(name);
  const asked = def?.cardField ? args?.[def.cardField] === true : isPlainObject(result) && result.drawn === true;
  // the view model the card runs: the result view's, or the feature view's own
  const viewModel = def?.view === 'result' ? (r, a) => buildViewModel(name, r, a) : def?.view?.viewModel;
  // a tool that declares the shape of its answer (outputSchema) carries it on every success
  const declared = !!def?.output && isPlainObject(result) && result.ok !== false;
  const structured = declared || (!!viewModel && asked && isPlainObject(result) && viewModel(result, args).kind !== 'none');
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
const PROGRESS_EVERY_MS = setting('MCP_PROGRESS_INTERVAL_MS'); // 0: no heartbeat

/**
 * Run one tool call. Never throws for a tool's own failure — that is a CallToolResult with
 * isError (a Tool Execution Error the model can correct, per spec) — only for a name that is not a
 * tool. `signal` stops the processes the call started; `onProgress(params)` receives heartbeats.
 * Returns { result: CallToolResult, raw } — `raw` is the engine's value (null on error).
 */
export async function runTool(engine, name, args, { signal, onProgress, progressEveryMs = PROGRESS_EVERY_MS, renders = true } = {}) {
  const started = Date.now();
  logLine(name, `▶ call ${summarizeArgs(args)}`);
  // every failure of a call is kept in the error log (src/error-log.js), with the call's arguments
  // (the arguments are kept as they came, so a failure is replayed by the same call)
  // (a call refused for not using the envelope still carried its ids — at the top)
  const inner = isPlainObject(args?.request) ? args.request : isPlainObject(args) ? args : {};
  const failed = (tool, message, { stage, field, code, detail } = {}) => engine?.errors?.record?.({ source: 'tool', tool, stage: stage || 'error', field, code, message, args, detail, context_id: typeof inner.context_id === 'string' ? inner.context_id : typeof inner.draft_id === 'string' ? inner.draft_id : null, task_id: typeof inner.task_id === 'string' ? inner.task_id : typeof inner.task_ids?.[0] === 'string' ? inner.task_ids[0] : null });
  if (!isCallableTool(engine, name)) {
    logLine(name, '✗ unknown tool');
    failed(name, unknownToolMessage(name), { stage: 'validate' });
    return { result: errorResult(unknownToolMessage(name), 'validate'), raw: null, unknown: true };
  }
  const def = toolsOf(engine).get(name);
  // every tool takes its input under `request` (src/schema/transport.js wireSchema); the rest of the
  // call sees that input and nothing else
  const call = requestOf(name, args);
  if (call.error) {
    logLine(name, '✗ not under request');
    failed(name, call.error, { stage: 'validate', field: 'request' });
    return { result: errorResult(call.error, 'validate', 'request'), raw: null };
  }
  const input = call.request;
  // a card for a client that renders none: the tool is not offered to it, so not accepted. The
  // card's own read (drill_result) is the exception: the HOST makes that call on behalf of a card
  // this server drew, and the proof it may read is the drawn task — not the envelope the host puts
  // on a proxied request, which the host decides and this server cannot vouch for.
  if (!renders && def.appsOnly && !def.appCallable) {
    logLine(name, '✗ from a client without the Apps extension');
    failed(name, `${name} is not available: this client does not declare the MCP Apps extension`, { stage: 'validate' });
    return { result: errorResult(`${name} is not available: this client does not declare the MCP Apps extension (io.modelcontextprotocol/ui), so nothing is drawn — read results with query_semantic_model / query_pipeline_model ({ task_ids })`, 'validate'), raw: null };
  }
  const cardField = def.cardField;
  if (!renders && cardField && input[cardField] !== undefined) {
    logLine(name, `✗ ${cardField} from a client without the Apps extension`);
    failed(name, `${cardField} is not available: this client does not declare the MCP Apps extension`, { stage: 'validate', field: cardField });
    return { result: errorResult(`${cardField} is not available: this client does not declare the MCP Apps extension (io.modelcontextprotocol/ui), so no card is drawn — drop the ${cardField} field`, 'validate', cardField), raw: null };
  }
  let beat;
  if (onProgress && progressEveryMs > 0) {
    let n = 0;
    beat = setInterval(() => {
      n += 1;
      try { onProgress({ progress: n, message: `${name}: still working (${Math.round((Date.now() - started) / 1000)}s)` }); } catch { /* a closed stream is not the call's failure */ }
    }, progressEveryMs);
  }
  try {
    // a tool that answers synchronously still answers through the promise, so a throw is its rejection
    let raw = await withSignal(signal, () => Promise.resolve().then(() => def.run(engine, input)));
    // the hint to show a result as a card means nothing to a client that draws none
    // (a read answers each task under `results`, each with its own hint)
    if (!renders && isPlainObject(raw)) {
      const unhinted = (r) => { if (!isPlainObject(r) || !('show_to_user' in r)) return r; const { show_to_user: _hint, ...rest } = r; return rest; };
      raw = unhinted(raw);
      if (Array.isArray(raw.results)) raw = { ...raw, results: raw.results.map(unhinted) };
    }
    logLine(name, `✓ ok in ${Date.now() - started}ms${summarizeResult(raw)}`);
    // a failure the engine RETURNED ({ ok: false }) is kept too — except a read of tasks that failed
    // (their results), whose failure each task itself recorded when it ended
    if (isPlainObject(raw) && raw.ok === false && !raw.task_id && !raw.task_ids && !Array.isArray(raw.results)) failed(name, raw.error?.message || (typeof raw.error === 'string' ? raw.error : 'the call failed'), { stage: raw.error?.stage, field: raw.error?.field, code: raw.error?.code, detail: raw.error });
    return { result: toCallToolResult(raw, name, input, engine), raw };
  } catch (err) {
    const cancelled = !!signal?.aborted;
    logLine(name, `✗ ${cancelled ? 'cancelled' : 'error'} in ${Date.now() - started}ms: ${err?.message || String(err)}${err?.field ? ` (field: ${err.field})` : ''}`);
    if (!cancelled) failed(name, err?.message || String(err), { stage: err?.stage, field: err?.field, code: err?.code, detail: err?.name === 'ToolError' ? null : err?.stack });
    return { result: errorResult(cancelled ? `cancelled: ${err?.message || 'the call was cancelled'}` : (err?.message || String(err)), cancelled ? 'cancelled' : err?.stage, err?.field, cancelled ? undefined : err?.code), raw: null };
  } finally {
    if (beat) clearInterval(beat);
  }
}

/**
 * Run a tool call TO ITS END — what a protocol task runs. A call that waits on an engine task
 * (a query tool with { task_ids }, display_model_result) keeps waiting while the task runs, then
 * answers as it would have had the task been done: the host polls the protocol task instead of
 * the model calling again. A call that STARTS work returns its task_id at once, as always — it is
 * never held.
 */
export async function runToCompletion(engine, name, args, { signal, renders = true } = {}) {
  const def = toolsOf(engine).get(name);
  // what the call asks, read as runTool reads it — a call it refuses is refused at once, never after a wait
  const call = def ? requestOf(name, args) : { error: 'unknown tool' };
  if (call.error) return runTool(engine, name, args, { signal, renders });
  const input = call.request;
  // the tasks the call reads (a query tool's task_ids, a drawing tool's task_id) — followed until every one is done
  const ids = typeof input.task_id === 'string' ? [input.task_id] : Array.isArray(input.task_ids) ? input.task_ids.filter((id) => typeof id === 'string') : [];
  // (a cancel is answered at once: it never waits for the task it stops)
  // a call that WAITS on an engine task — a query tool's read half ({ task_ids }), a drawing tool — is
  // run to its end under a protocol task
  let waits = !!def?.waits && !input.cancel && ids.length > 0 && ids.every((id) => engine.jobs?.get?.(id));
  // what the call would refuse — bad arguments, a task of the other side, a card already drawn — is
  // refused NOW, not after sitting through the whole task
  if (waits && engine.host) {
    try { engine.host.precheckWait(name, input); } catch { waits = false; }
  }
  if (waits) {
    // Following the task has the same contract as the call itself: a failure while waiting is a
    // TOOL error the caller reads, never a protocol fault or a 'completed' success.
    try {
      const running = () => ids.filter((id) => engine.jobs.get(id)?.status === 'running' && engine.jobs.isLive?.(id));
      for (let left = running(); left.length; left = running()) {
        if (signal?.aborted) throw signal.reason || new Error('cancelled');
        await withSignal(signal, () => engine.tasks.await(left, MAX_WAIT_SECONDS));
      }
    } catch (err) {
      const cancelled = !!signal?.aborted;
      logLine(name, `✗ ${cancelled ? 'cancelled' : 'error'} while waiting for task ${ids.join(', ')}: ${err?.message || String(err)}`);
      if (!cancelled) engine?.errors?.record?.({ source: 'tool', tool: name, stage: err?.stage || 'task', message: `while waiting for task ${ids.join(', ')}: ${err?.message || String(err)}`, args, task_id: ids[0] ?? null });
      return { result: errorResult(cancelled ? `cancelled: ${err?.message || 'the call was cancelled'}` : (err?.message || String(err)), cancelled ? 'cancelled' : (err?.stage || 'task'), err?.field, cancelled ? undefined : err?.code), raw: null };
    }
  }
  return runTool(engine, name, args, { signal, renders });
}

export { SERVER_DESCRIPTION, SERVER_SUMMARY, coreInstructions };
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
export function createServices(engine, { taskTtlMs, taskPollMs, progressEveryMs = PROGRESS_EVERY_MS, taskAfterMs = setting('MCP_TASK_AFTER_MS') } = {}) {
  const apps = appsSurface(engine.features || []);
  const featureLines = (engine.features || []).map((f) => f.instructions).filter(Boolean);
  let skills = null;
  try { skills = buildSkills(engine); } catch (e) { logLine('skills', `✗ not served: ${e?.message || e}`); }
  const tasks = new TaskRegistry({
    ttlMs: taskTtlMs ?? setting('MCP_TASK_TTL_SECONDS') * 1000,
    pollIntervalMs: taskPollMs ?? 2000,
  });
  const shutdownHooks = new Set();
  const skillUris = skills?.skills.map((s) => s.uri) ?? [];
  const skillPointer = skillUris.length
    ? `\n\nSKILLS\nThis procedure is also served as Agent Skills (skills/list, or read by URI): ${skillUris.join(', ')}.`
    : '';
  // the core block first (within the budget a client may cut to), the detail after it
  const instructionsFor = (offer = {}) => [
    coreInstructions({ apps: !!offer.apps, skillUris: offer.skills ? skillUris : [], featureLines }),
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
  // every error kept from now on says which server surface it happened on
  if (engine.errors?.runtime) engine.errors.runtime.server = `${SERVER_INFO.version}+${fingerprint}`;
  logLine('surface', `${fingerprint}${surface.changed ? ` — changed since the last start (${surface.previous || 'none recorded'}): open subscriptions are told for the next ${Math.round(CHANGE_WINDOW_MS / 60000)} min` : ' — unchanged'}`);
  return {
    engine,
    apps,
    skills,
    tasks,
    // one list for every client (see buildToolDefs)
    toolDefs: defs,
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
          description: 'One recipe of this skill in full — payload, example queries, the reusable technique. The same entry as semantic_index({ request: { recipe } }).',
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
