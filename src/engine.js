// Tool engine: validates inputs against catalog-derived schemas, compiles
// declarations, renders YAML, drives dbt/mf within isolated contexts.
//
// ONE object, its methods in one file per concern (mixed in at the end — src/engine/helpers.js):
//   this file                     the constructor, contexts, the task delegates (src/task-runner.js),
//                                 the small tools (context, time, experiment, explore_errors), the time spine
//   engine/semantic-index.js      semantic_index and its views, recipes
//   engine/memory.js              the memory tool
//   engine/semantic-build.js      build / update / delete a semantic model, a native model
//   engine/semantic-query.js      query_semantic_model: references, the metric-query shell
//   engine/semantic-preview.js    preview_semantic_model
//   engine/pipeline-draft.js      build_pipeline_model's draft: steps, checkpoints, preview
//   engine/pipeline-materialize.js  the draft run as a chain of dbt models
//   engine/pipeline-warnings.js   what a step is told as it is added
//   engine/warehouse-probe.js     best-effort warehouse reads (columns, freshness, row estimates)
//   engine/task-results.js        reading a task back, query_pipeline_model, display_model_result

import { buildSchemas, transportSchema, MAX_WAIT_SECONDS } from './schema.js';
import { assertSchemaSound } from './schema-kit.js';
import { makeValidators, validateInput, ToolError, RESULT_GONE } from './validate.js';
import { abTest, srmCheck, sampleSize } from './experiment.js';
import { TaskRunner } from './task-runner.js';
import { PARTITION_DIM } from './yaml-render.js';
import { gatePythonRuntime } from './catalog.js';
import { ContextManager } from './context-manager.js';
import { renderPredicate } from './predicate.js';
import { PROJECT_STORE } from './project-semantics.js';
import { formatDbtError } from './dbt/index.js';
import './match-recognize.js'; // registers the match_recognize pipeline stage
import './python-model.js'; // registers the python pipeline stage
import { partitionConditions, timeRangeConditions, isValidTimezone } from './time-range.js';
import { CatalogSearch } from './search.js';
import { featureTools } from './features.js';
import { JobManager } from './jobs.js';
import { ValueIndex } from './value-index.js';
import { MemoryStore } from './memory.js';
import { openStore } from './store.js';
import { ErrorLog, readGenerated } from './error-log.js';
import { getDialect } from './dialects/index.js';
import { currentSignal } from './request-context.js';
import { semanticIndexMethods } from './engine/semantic-index.js';
import { warehouseProbeMethods } from './engine/warehouse-probe.js';
import { pipelineWarningMethods } from './engine/pipeline-warnings.js';
import { pipelineDraftMethods } from './engine/pipeline-draft.js';
import { pipelineMaterializeMethods } from './engine/pipeline-materialize.js';
import { semanticBuildMethods } from './engine/semantic-build.js';
import { semanticQueryMethods } from './engine/semantic-query.js';
import { semanticPreviewMethods } from './engine/semantic-preview.js';
import { taskResultMethods } from './engine/task-results.js';
import { memoryMethods } from './engine/memory.js';
import { mixin, isPlainObject } from './engine/helpers.js';

export class Engine {
  constructor({ catalog, contextManager, runner, recipes, sqlRunner, queryTimeoutMs, dbPath, store, resetDb = false, embedder, memoryDbPath, pythonBin, pythonModelConfig, tableExpirationDays = 30, features = [], featureStatus = [], project = null }) {
    this.catalog = catalog;
    this.recipes = recipes; // optional Recipes instance
    this.sqlRunner = sqlRunner; // optional async (sql) => { columns, rows } — for match_recognize
    // ONE shared store (single db file) for the job registry + value index. resetDb wipes
    // it on open (MCP_DB_RESET) before the managers read it.
    this.store = store || openStore({ dbPath, reset: resetDb });
    this._ownsStore = !store;
    this.jobs = new JobManager({ store: this.store }); // persisted if the store is
    this.valueIndex = new ValueIndex({ store: this.store }); // real event-property values (background-populated)
    // Memory is curated, non-re-derivable knowledge. By default it shares the store (and
    // survives reset). Point MCP_MEMORY_DB at a PERSISTENT volume to keep findings across
    // container restarts — then it lives in its own store, isolated from the value index.
    this._memoryStore = memoryDbPath ? openStore({ dbPath: memoryDbPath }) : null;
    this.memoryStore = new MemoryStore({ store: this._memoryStore || this.store, embedder }); // durable analyst findings, linked to catalog entities (the `memory` tool); embedder → semantic search
    // Target keys written before a target carried its source ('property:ad_type_of_event_data')
    // name an entity no source owns. Attributing one to a source now would be guessing which
    // entity was meant, so each is demoted ONCE to a searchable term instead: the note stays
    // findable, and every stored key that addresses a view is (kind, source, name).
    try {
      const moved = this.memoryStore.retarget((canon) => this._memoryCanonForward(canon));
      if (moved.targets) console.error(`[mcp] memory targets stored structurally: ${moved.targets} target(s) on ${moved.notes} note(s)`);
    } catch (e) { console.error(`[mcp] memory target migration skipped: ${e?.message || e}`); }
    this.catalogSearch = new CatalogSearch({ catalog, recipes, valueIndex: this.valueIndex }); // semantic_index({ search })
    // HOW LONG A BEST-EFFORT WAREHOUSE READ MAY HOLD AN INTERACTIVE CALL (_bestEffort): the extras
    // an answer is enriched with — a physical column set, a freshness mark. Past it the answer goes
    // out without the extra and the read primes the cache for the next call. Work that is the
    // point of a call (a query, a build) never holds it at all: it is a task (_startTask).
    this.queryTimeoutMs = queryTimeoutMs ?? 20000;
    // Literal dbt.config extras the OPERATOR pins for every generated Python model (e.g.
    // {"submission_method":"bigframes"}); the caller never decides where the compute runs. The
    // catalog resolved them from the environment already — an injected value replaces them THERE,
    // before the schemas are built, so the stage schema, its validation and the compiled model all
    // describe the same runtime.
    if (pythonModelConfig) catalog.pythonRuntime = { ...catalog.pythonRuntime, config: pythonModelConfig };
    this.pythonModelConfig = catalog.pythonRuntime?.config || {};
    // Every table this server materializes for a task (a pipeline's models, a stored query result,
    // an eventstream, a python model) expires this many days after it is built, so what nobody
    // reads again does not pile up in the warehouse; 0 keeps them. Where the warehouse has no
    // expiry (DuckDB) nothing is set.
    this.tableExpirationDays = tableExpirationDays;
    // The python stage description INDEXES the worked recipes this deployment ships for it (id +
    // which move each one covers) instead of spelling every form out in prose: a compiling payload
    // per move is worth more than any amount of description text, and the caller has to know the
    // index exists before writing the first function.
    if (recipes) catalog.pythonRecipes = recipes.entriesRequiring('python_models');
    // what the installed dbt can run, before the schemas exist (dbt v2 runs no Python models on DuckDB)
    gatePythonRuntime(catalog, runner);
    // THE PROJECT'S OWN SEMANTIC LAYER (src/project-semantics.js), read at start: its metrics are
    // queried in a context of their own per semantic model (its name), and the schema names them
    this.project = project?.layer ? project : null;
    this.projectError = project?.error || null;
    // THE ERROR LOG (src/error-log.js): every failure, kept in the store for explore_errors — and what
    // this start could not serve is the first of them
    this.errors = new ErrorLog({ store: this.store });
    this.errors.runtime = { node: process.version, dialect: catalog.dialect, ...(runner ? { dbt: { major: runner.major ?? null, environment: runner.environment?.name ?? null } } : {}), started_at: new Date().toISOString() };
    this.errors.contextOf = (id, message, opts) => this._errorContext(id, message, opts);
    if (this.projectError) this.errors.record({ source: 'startup', stage: 'project_semantic_layer', message: `the dbt project's own semantic models could not be read: ${this.projectError}` });
    for (const x of project?.skipped || []) this.errors.record({ source: 'startup', severity: 'warning', stage: 'project_semantic_layer', message: `the semantic model '${x.semantic_model}' is not served: ${x.reason}` });
    for (const b of this.project?.layer.blocked || []) this.errors.record({ source: 'startup', severity: 'warning', stage: 'project_semantic_layer', message: `${b.message}: not served. To serve it, ${b.fix}.`, detail: b });
    for (const st of featureStatus || []) if (st.available === false) this.errors.record({ source: 'startup', severity: 'warning', stage: 'feature', message: `the feature '${st.id}' is not offered: ${st.reason}` });
    this.schemas = buildSchemas(catalog, { project: this.project?.layer || null, projectContexts: this.project?.contexts || [] });
    // THE FEATURES THIS DEPLOYMENT RUNS (src/features.js): each adds its tools — a schema here and a
    // method on this engine — and the task side they start and read. A feature that is off adds
    // nothing, so its tools are neither listed nor callable.
    this.features = features;
    this.featureStatus = featureStatus;
    this._featureTools = featureTools(features);
    for (const [name, { tool }] of this._featureTools) {
      if (Object.prototype.hasOwnProperty.call(this.schemas, name) || typeof this[name] === 'function') throw new Error(`feature tool '${name}' collides with a core tool`);
      this.schemas[name] = transportSchema(tool.schema(catalog));
      this[name] = (input) => tool.run(this, input || {});
    }
    // which side a task belongs to, and which tool reads that side back — the core's two, and each feature's
    this._sides = { ...TASK_SIDE };
    this._readers = { ...SIDE_READER };
    for (const feature of features) Object.assign(this._readers, feature.sides || {});
    for (const [name, { tool }] of this._featureTools) if (tool.side) this._sides[name] = tool.side;
    // Recipes are NOT a standalone tool — they are building blocks surfaced THROUGH
    // semantic_index ({ recipe: id } for one, the overview list + { guide } per task family).
    // Constrain the recipe view to real ids when recipes are configured.
    // The recipe view offers the ids this server actually has — the schema says what exists.
    if (recipes) {
      const si = this.schemas.semantic_index;
      const branch = (si?.anyOf || si?.oneOf || []).find((b) => b.properties?.recipe);
      // The ids are injected AFTER the schemas were built and folded, so the two sites that take
      // a recipe id would each carry the whole list again (~1.4 KB apiece on a real recipe set).
      // They share one definition instead — the same fold the built schemas get, applied here.
      si.$defs = { ...(si.$defs || {}), recipe_ids: { type: 'string', enum: recipes.ids() } };
      const withIds = (prop) => ({ $ref: '#/$defs/recipe_ids', ...(prop.description ? { description: prop.description } : {}) });
      if (branch) branch.properties.recipe = withIds(branch.properties.recipe);
      // …and in the flat root map too, which is what a client that strips the union is left with.
      if (si?.properties?.recipe) si.properties.recipe = withIds(si.properties.recipe);
    }
    // An empty vocabulary (a source with no events yet, a model with no groupable column) renders
    // as `enum: []` / `oneOf: []`, which ajv refuses — and it refuses the WHOLE schema, so the
    // server would not start and the message would point at a branch instead of at the catalog.
    // A key left `undefined` is the other unusable construct: not JSON, and a client that validates
    // the tool list as objects rejects the whole list. schema-kit keeps both from being built; this
    // is the backstop that names the offender if one ever gets in another way.
    for (const [tool, schema] of Object.entries(this.schemas)) {
      const bad = assertSchemaSound(schema, `#/${tool}`);
      if (bad.length) {
        throw new Error(`the catalog produced an unusable tool schema: ${bad.join('; ')}. `
          + `A source with no known events, or a model with nothing groupable, must render as an open field; an optional key is omitted, never set to undefined — see src/schema-kit.js.`);
      }
    }
    this.validators = makeValidators(this.schemas);
    this.ctxs = contextManager || new ContextManager({});
    // the task runtime (src/task-runner.js): the engine's tools and a feature's start and read tasks through it
    this.tasks = new TaskRunner({ jobs: this.jobs, ctxs: this.ctxs, sideOf: (tool) => this._sides[tool] || null, readers: this._readers, onFailure: (...a) => this._recordTaskError(...a) });
    // WHAT A FEATURE MAY USE OF THE ENGINE (src/features.js), besides its task runtime (engine.tasks),
    // the dbt project's contexts (engine.ctxs), the catalog and the job registry: the one surface it
    // is written against, so an engine method can change without reaching into a feature
    this.host = {
      validate: (tool, input) => this._validate(tool, input),
      context: (id) => this._ctx(id),
      timeRangeConditions: (source, tr) => this._timeRangeConditions(source, tr),
      physicalColumns: (source) => this._physicalCols(source),
      modelConfigLine: (materialized) => this._modelConfigLine(materialized),
      expiryConfig: (kind) => this._expiryConfig(kind),
      taskBase: (input) => this._taskBase(input),
      holdTaskBase: (ctx, base) => this._holdTaskBase(ctx, base),
      precheckWait: (tool, args) => this._precheckWait(tool, args),
    };
    this.runner = runner; // optional; required for non-dry_run parse/query
    // The interpreter that runs the static gate over a python stage's functions (a local syntax /
    // safety check; the model itself runs where dbt sends it). The MetricFlow environment's Python —
    // never one found on PATH: an engine given neither refuses the gate (runAstGate says why).
    this.pythonBin = pythonBin || runner?.pythonBin || runner?.environment?.pythonBin || null;
  }

  _validate(tool, input) {
    const res = validateInput(this.validators[tool], input || {});
    if (!res.ok) throw new ToolError(`invalid input: ${res.errors.join('; ')}`, { stage: 'validate' });
  }

  /**
   * A context a call is about to CHANGE. The project's own semantic layer (a pinned context) is read
   * from the project as it is: nothing is built on it, changed in it or deleted from it.
   */
  _ctxToWrite(id, field = 'context_id') {
    const ctx = this._ctx(id);
    if (ctx.state.pinned) throw new ToolError(`context '${id}' is the dbt project's own semantic layer, read from the project as it is — nothing is built on, changed in or deleted from it. Query its metrics with query_semantic_model({ context_id: '${id}', metrics }); a task of your own is built in a context of its own (omit ${field})`, { stage: 'validate', field });
    return ctx;
  }

  /**
   * The context by id, checked against the catalog AS IT IS NOW. A context is a set of declarations
   * over models, and a later grounding pass may have found that the warehouse no longer backs one
   * of them — reported here with the grounding reason, not as a bare 'Unknown model' thrown from
   * inside the renderer.
   */
  _ctx(id) {
    let ctx;
    // the parsed copy the project's own contexts share is internal: its semantic models are the contexts
    const hint = this.projectError ? ` (the dbt project's own semantic models could not be read, so none of them is a context: ${this.projectError})` : '';
    try { ctx = this.ctxs.get(id); } catch (e) { throw new ToolError(`${e.message}${hint}`, { stage: 'validate', field: 'context_id' }); }
    if (ctx.state?.internal) throw new ToolError(`unknown context_id: ${id}${this.project ? ` — the dbt project's own semantic models are contexts of their own, named after them: ${this.project.contexts.join(', ')}` : ''}`, { stage: 'validate', field: 'context_id' });
    const gone = [...new Set([...(ctx.state.usedModels || []), ...Object.keys(ctx.state.additions || {})])].filter((k) => !this.catalog.models[k]);
    if (gone.length) {
      throw new ToolError(`context '${id}' was built over ${gone.map((k) => `'${k}'`).join(', ')}, which the catalog no longer serves${this.catalog.unavailableHint(gone[0])} Start a new context over the sources that are available (semantic_index() lists them).`, { stage: 'validate', field: 'context_id' });
    }
    return ctx;
  }

  /** The dbt config keys that make a table built for a task expire (see tableExpirationDays). */
  _expiryConfig(language = 'sql') {
    return getDialect(this.catalog.dialect).expiryConfig(this.tableExpirationDays, language);
  }

  /** The `{{ config(...) }}` line of a SQL model built for a task: how it is materialized, and when it expires. */
  _modelConfigLine(materialized = 'table', { pipeline = false } = {}) {
    // a pipeline written in a syntax dbt's own parser does not read says so (dbt v2 would warn on it)
    const unparsed = pipeline && getDialect(this.catalog.dialect).writesPipeSyntax ? this.runner?.unparsedSqlConfig?.() || {} : {};
    const cfg = { materialized, ...this._expiryConfig('sql'), ...unparsed };
    return `{{ config(${Object.entries(cfg).map(([k, v]) => `${k}=${typeof v === 'number' ? v : `'${String(v).replace(/'/g, "\\'")}'`}`).join(', ')}) }}`;
  }

  /** The sources whose MEASURES a semantic context reads (a model loaded only to be joined to is
   *  not one of them). */
  _measureSources(ctx) {
    const c = this.catalog;
    const measureSources = Object.entries(ctx.state.additions || {}).filter(([, a]) => (a.measures || []).length).map(([k]) => k);
    const baseOwners = (ctx.state.metrics || []).flatMap((m) => [m?.type_params?.measure?.name].filter(Boolean)).map((ref) => c.modelOwningMeasure(ref)).filter(Boolean);
    return [...new Set([...measureSources, ...baseOwners])].filter((k) => ctx.state.usedModels?.includes(k));
  }

  /**
   * A metric query's window bounds metric_time; a source partitioned by another column is pruned
   * only by a condition on THAT column, which its semantic model carries as PARTITION_DIM. Added
   * when the context's measures come from one source: a where applies to every metric of a query,
   * and a dimension of one source is not reachable from the measures of another.
   */
  _semanticPartitionWhere(ctx, bounds) {
    if (!bounds || !(bounds.start || bounds.end || bounds.endExclusive)) return [];
    const sources = this._measureSources(ctx);
    if (sources.length !== 1) return [];
    const m = this.catalog.getModel(sources[0]);
    const pe = this.catalog.primaryEntityName(sources[0]);
    if (!pe || (m.dimensions || {})[PARTITION_DIM]) return [];
    return partitionConditions(m, { start: bounds.start, endExclusive: bounds.endExclusive, end: bounds.endExclusive ? null : bounds.end })
      .map((cnd) => renderPredicate({ field: { kind: 'dimension', path: `${pe}__${PARTITION_DIM}` }, op: cnd.op, value: cnd.value }));
  }

  /**
   * WHERE conditions for a pipeline-level time_range on the source's time column.
   * Timezone-aware: with tr.timezone the boundaries are wall-clock in that zone,
   * converted to the UTC instants the warehouse stores; a date-only end is the
   * whole (local) day, next-midnight-exclusive.
   */
  _timeRangeConditions(source, tr) {
    if (tr?.timezone && !isValidTimezone(tr.timezone)) throw new ToolError(`unknown timezone '${tr.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
    return timeRangeConditions(this.catalog.getModel(source), tr);
  }

  /** The conditions on a source's partition column for a window on its time axis. */
  _partitionConditions(source, bounds) {
    return partitionConditions(this.catalog.getModel(source), bounds);
  }

  /**
   * A draft that starts FROM A TASK's stored table (a materialized metric query, a pipeline build)
   * instead of a catalog source: its steps re-slice that result without recomputing it. The table
   * is its step 0 — the same mechanism as a materialized prefix: the owner's model definition is
   * copied here so `{{ ref() }}` resolves, and the owner keeps a reference count so it is not dropped
   * under the draft. The SOURCE stays what the steps resolve payload properties and relationships
   * against: the build's own source, else the one the caller names, else the query's single fact.
   */
  _taskBase(input) {
    const job = this.jobs.get(input.from_task);
    if (!job) throw new ToolError(`unknown task_id '${input.from_task}' — start the pipeline from a task this server ran (a materialized query or a pipeline build)`, { stage: 'validate', field: 'from_task', code: RESULT_GONE });
    if (job.status === 'running') throw new ToolError(`task ${job.id} is still running — wait for it with ${this._readWith(job.id)}, then start the pipeline from it`, { stage: 'validate', field: 'from_task' });
    if (job.status !== 'ready' || !job.table) throw new ToolError(`task ${job.id} holds no stored table to start from — ${job.status === 'error' ? 'it failed' : job.tool === 'query_pipeline_model' ? 'a query over a pipeline model is not stored: start from the pipeline BUILD\'s task, or continue that draft' : 'only a query run with materialize:true, or a pipeline build, stores its result as a table'}`, { stage: 'validate', field: 'from_task' });
    if (!this.ctxs.has(job.contextId) || !this.ctxs.hasPipelineModel(job.contextId, job.table)) throw new ToolError(`the table of task ${job.id} (${job.table}) is gone — its context or model was deleted; run it again`, { stage: 'validate', field: 'from_task', code: RESULT_GONE });
    if (input.time_range) throw new ToolError('time_range bounds a catalog source — a task\'s table was computed under its own window already; filter it with a where step instead', { stage: 'validate', field: 'time_range' });
    const kept = this.tasks.held(job.id);
    const owner = this.ctxs.get(job.contextId).state;
    const typed = kept?.output_columns || (Array.isArray(kept?.columns) && kept.columns.every(isPlainObject) ? kept.columns : null);
    const columns = typed ? typed.map((c) => ({ name: c.name, type: c.type || 'unknown' }))
      : owner.native?.model === job.table ? (owner.native.columns || []).map((name) => ({ name, type: 'unknown' })) : null;
    if (!columns?.length) throw new ToolError(`the columns of task ${job.id}'s table are not known here any more (the server restarted since it ran) — run it again, then start from the new task`, { stage: 'validate', field: 'from_task' });
    const fact = (owner.usedModels || []).filter((k) => this.catalog.isFact(k));
    const source = input.source || (owner.draft?.source ?? owner.pipeline_origin?.source) || (fact.length === 1 ? fact[0] : null);
    if (!source) throw new ToolError(`name the source the steps resolve properties and relationships against (source: one of ${this.catalog.modelKeys().join(', ')}) — task ${job.id} read ${fact.length ? fact.join(' and ') : 'no events source'}`, { stage: 'validate', field: 'source' });
    return { base: { task_id: job.id, model: job.table, owner: job.contextId, columns }, source };
  }

  /** Make a task's table readable from this draft's context, and keep its owner from being dropped under it. */
  _holdTaskBase(ctx, base) {
    if (base.owner === ctx.id) return;
    this.ctxs.copyPipelineFiles(base.owner, ctx.id, base.model);
    const consumers = ((this.ctxs.get(base.owner).state.checkpoint_consumers ||= {})[base.model] ||= []);
    if (!consumers.includes(ctx.id)) consumers.push(ctx.id);
    this.ctxs.touch(base.owner);
  }

  /** Start `work` as a task (src/task-runner.js). Returns the task id. */
  _startTask(ctx, tool, work, opts) {
    return this.tasks.start(ctx, tool, work, opts);
  }

  /**
   * What reproduces an error on context `id`: its state as it is (the semantic declaration, a pipeline
   * draft with every step and checkpoint, an eventstream with its steps — JSON the context was built
   * from, internal keys left out) and, with `files`, the code of each generated model the message
   * names: as written, and as dbt compiled it (a warehouse error's line:column points into that one).
   */
  _errorContext(id, message = '', { files = false } = {}) {
    if (!id || !this.ctxs?.has?.(id)) return {};
    const ctx = this.ctxs.get(id);
    const state = JSON.parse(JSON.stringify(ctx.state || {}, (k, v) => (k.startsWith('_') ? undefined : v)));
    const out = { context: { id: ctx.id, ...(ctx.state?.shares ? { shares: ctx.state.shares } : {}), state } };
    if (!files) return out;
    const names = [...new Set([...String(message).matchAll(/\b([A-Za-z0-9_]+\.(?:sql|py))\b/g)].map((m) => m[1]))].slice(0, 4);
    if (!names.length) return out;
    return { ...out, files: readGenerated(this.ctxs.dir(id), this.ctxs.generatedDir(id), names) };
  }

  /** A task that ended in an error, into the error log: what failed, on which context, with its input. */
  _recordTaskError(id, tool, ctx, input, error = {}) {
    const { message, stage, field, code, detail, ...rest } = isPlainObject(error) ? error : { message: String(error) };
    this.errors.record({
      source: 'task', tool, task_id: id, context_id: ctx?.id ?? null, stage: stage || 'task', field, code,
      message: message || `the ${tool} task failed`, args: input, detail: detail ?? (Object.keys(rest).length ? rest : null),
    });
  }

  /** A batch of queries on one context, each a task of its own (src/task-runner.js). */
  _startBatch(ctx, tool, queries, prepare) {
    return this.tasks.startBatch(ctx, tool, queries, prepare);
  }

  /** The semantic YAML the installed dbt reads (its client decides; no runner: the legacy spec). */
  _semanticSpec() {
    return this.runner?.semanticSpec || 'legacy';
  }

  /** What a tool that started a task answers: the task's id and where to read it — nothing else. */
  _taskStarted(id, extra = {}) {
    return this.tasks.started(id, extra);
  }

  _keepTaskResult(id, entry) {
    this.tasks.keep(id, entry);
  }

  /** The finished responses the task runtime holds (a test drops one to read a result as a restart would). */
  get _taskResults() {
    return this.tasks.results;
  }

  /**
   * ONE context-lifecycle tool (action-driven), replacing list_contexts / describe_context /
   * drop_context / delete_native_model / delete_semantic_model. Delegates to the internal
   * handlers (kept private so the all-at-once register path + tests reuse them).
   */
  async context(input) {
    this._validate('context', input);
    switch (input.action) {
      case 'list': return this.list_contexts();
      case 'describe': return this.describe_context({ context_id: input.context_id });
      case 'drop': return this.drop_context({ context_id: input.context_id, ...(input.force ? { force: true } : {}) });
      case 'delete_model': return this.delete_native_model({ context_id: input.context_id });
      case 'delete_semantic_model': return this.delete_semantic_model({ context_id: input.context_id, semantic_model: input.semantic_model, cascade: input.cascade });
      default: throw new ToolError(`unknown context action '${input.action}'`, { stage: 'validate', field: 'action' });
    }
  }

  drop_context(input) {
    this._validate('drop_context', input);
    if (this.ctxs.has(input.context_id) && this.ctxs.get(input.context_id).state?.pinned) throw new ToolError(`context '${input.context_id}' serves a semantic model of the dbt project's own layer for as long as the server runs — it is read from the project at start, not built here, so there is nothing to drop`, { stage: 'validate', field: 'context_id' });
    // A context whose materialized prefix another draft READS cannot just vanish: the fork's
    // `{{ ref() }}` would resolve to a relation that no longer exists. Name the consumers and let
    // the operator decide (drop them first, or force).
    const consumers = this._checkpointConsumers(input.context_id);
    if (consumers.length && !input.force) {
      throw new ToolError(
        `context ${input.context_id} cannot be dropped: ${consumers.map((c) => `draft ${c.consumer} reads ${c.model}`).join('; ')} — that table is built HERE, so dropping this context leaves them with an unresolvable model. `
        + `Drop those drafts first, or pass force: true (they will then have to recompute that prefix from the source).`,
        { stage: 'validate', field: 'context_id' },
      );
    }
    for (const c of consumers) { // forced: the consumers' checkpoints are dead as of now
      const st = this.ctxs.get(c.consumer).state;
      if (st.draft) st.draft.checkpoints = (st.draft.checkpoints || []).filter((cp) => cp.model !== c.model);
      this.ctxs.touch(c.consumer);
    }
    return this.ctxs.drop(input.context_id);
  }

  /**
   * Drafts in OTHER contexts that read a table this context materialized. The LINK is the context
   * manager's (it also keeps the GC off such a context); this narrows it to the consumers whose
   * draft still holds that prefix — a fork that has since edited past it reads it no more.
   */
  _checkpointConsumers(id) {
    // a draft reads a table built here as a materialized prefix, or as its step 0 (started from a task)
    const reads = (draft, model) => draft && ((draft.checkpoints || []).some((cp) => cp.model === model) || draft.base?.model === model);
    return this.ctxs.checkpointConsumers(id).filter(({ consumer, model }) => reads(this.ctxs.get(consumer).state.draft, model));
  }

  list_contexts() {
    return { contexts: this.ctxs.list() };
  }

  /**
   * ONE A/B-experiment lifecycle tool (action-driven), folding in the three stat tools.
   * plan → sample_size (power/MDE), check_split → srm_check (SRM guardrail), analyze →
   * ab_test (significance). Validates the action shape, then delegates to the internal
   * handler which re-validates the exact per-metric contract. The lifecycle order
   * (plan → check_split → analyze) is the recommended sequence.
   */
  experiment(input) {
    this._validate('experiment', input);
    // `card` asks the MCP server for the result's card (src/mcp-surface.js): not a statistic
    const { action, card: _card, ...rest } = input;
    switch (action) {
      case 'plan': return this.sample_size(rest);
      case 'check_split': return this.srm_check(rest);
      case 'analyze': return this.ab_test(rest);
      default: throw new ToolError(`unknown experiment action '${action}'`, { stage: 'validate', field: 'action' });
    }
  }

  /** A/B significance over pre-aggregated per-group stats (src/experiment.js). */
  ab_test(input) {
    this._validate('ab_test', input);
    return abTest(input);
  }

  /** The sample-ratio-mismatch guardrail (src/experiment.js). */
  srm_check(input) {
    this._validate('srm_check', input);
    return srmCheck(input);
  }

  /** Power / sample-size planning (src/experiment.js). */
  sample_size(input) {
    this._validate('sample_size', input);
    return sampleSize(input);
  }

  /**
   * A bounded wait (0–MAX_WAIT_SECONDS). Purely a timer: it touches no data and follows no task —
   * waiting for a task is its side's query tool ({ task_id }), which returns the moment it is done.
   *
   * The ceiling is the same one every other number here answers to: the wait happens INSIDE a tool
   * call, so a caller that asks for a minute gets a dropped connection rather than a minute. The
   * cap is reported back (`cap_seconds`) so the pacing can be planned from the answer instead of
   * from the description.
   */
  async time(input) {
    this._validate('time', input);
    const requested = Number(input.seconds) || 0;
    const seconds = Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS); // clamp to [0, MAX_WAIT_SECONDS]
    const startedAt = new Date().toISOString();
    // a cancelled call (the client gave up, a task was cancelled) stops waiting at once
    const signal = currentSignal();
    let cancelled = false;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, seconds * 1000);
      signal?.addEventListener?.('abort', () => { cancelled = true; clearTimeout(t); resolve(); }, { once: true });
    });
    const waited = cancelled ? Math.round((Date.now() - Date.parse(startedAt)) / 100) / 10 : seconds;
    return { ok: true, waited_seconds: waited, requested_seconds: requested, cap_seconds: MAX_WAIT_SECONDS, clamped: requested > MAX_WAIT_SECONDS, ...(cancelled ? { cancelled: true } : {}), started_at: startedAt, finished_at: new Date().toISOString(), ...(input.reason ? { reason: input.reason } : {}) };
  }

  /**
   * THE ERROR LOG, read (src/error-log.js): the failures kept in the store, newest first — a tool
   * call refused or failed (with its arguments), a task that ended in an error (what dbt or the
   * warehouse said), what start could not serve. { id } → one in full; otherwise a page of them,
   * filtered, with a summary of where they come from.
   */
  explore_errors(input = {}) {
    this._validate('explore_errors', input);
    return this.errors.explore(input);
  }

  async describe_context(input) {
    this._validate('describe_context', input);
    const ctx = this._ctx(input.context_id);
    if (ctx.state.engine === 'project' && this.project) return { engine: 'project', ...this._projectOverview(ctx.id) };
    // A pipeline-registered model is a normal dbt model whose rows are the result.
    // Report its model name and the output columns you can read — its rows come from its build's
    // task. The columns are grounded to the real relation below.
    if (ctx.state.engine === 'pipeline') {
      const n = ctx.state.native || {};
      let columns = n.columns || [];
      if (this.runner && n.model) {
        // Bounded like every other warehouse enrichment: a slow introspection leaves the
        // declared columns standing rather than holding the whole description hostage.
        const cols = await this._bestEffort(`context-columns:${ctx.id}:${n.model}`, () => this.runner.relationColumns(this.ctxs.dir(ctx.id), n.model));
        if (cols?.ok) {
          const names = new Set(cols.columns.map((col) => String(col.name).toLowerCase()));
          const declared = (n.columns || []).filter((col) => names.has(String(col).toLowerCase()));
          columns = declared.length ? declared : cols.columns.map((col) => col.name);
        }
      }
      const draft = ctx.state.draft;
      return {
        context_id: ctx.id,
        engine: 'pipeline',
        tasks: ctx.state.tasks || [],
        models: [{ model: n.model, materialized: n.materialized, ...(n.description ? { description: n.description } : {}), columns }],
        columns,
        // A draft that already materialized something is still OPEN: say which steps are a table
        // already, so continuing it is an informed choice rather than a rediscovery.
        ...(draft ? {
          draft: {
            name: draft.name, source: draft.source, ...(draft.description ? { description: draft.description } : {}), steps: this._draftSteps(draft),
            checkpoints: (draft.checkpoints || []).map((cp) => ({ at: cp.at, model: cp.model, owner: cp.owner, built_at: cp.built_at, ...(cp.carries_source ? { carries_source: cp.carries_source } : {}) })),
          },
        } : {}),
        ...(Object.keys(ctx.state.checkpoint_consumers || {}).length ? { checkpoint_consumers: ctx.state.checkpoint_consumers } : {}),
        ...(n.task_id ? { built_by_task: n.task_id, read_with: `query_pipeline_model({ task_id: '${n.task_id}' }) for its rows, query_pipeline_model({ context_id: '${ctx.id}', transform }) to filter or regroup them; build on them with build_pipeline_model({ action: 'start', name, from_task: '${n.task_id}' })` } : {}),
        files: this.ctxs.generatedFiles(ctx.id),
      };
    }
    const additions = ctx.state.additions || {};
    // An OPEN draft lives here too, before anything is materialized — and it used to be invisible:
    // describe reported the (empty) governed side and said nothing about the pipeline being built.
    // Several drafts are the normal case, so this is what tells them apart.
    const openDraft = ctx.state.draft;
    return {
      context_id: ctx.id,
      engine: 'core',
      tasks: ctx.state.tasks || [],
      ...(openDraft ? {
        draft: {
          name: openDraft.name, source: openDraft.source,
          ...(openDraft.description ? { description: openDraft.description } : {}),
          steps: this._draftSteps(openDraft),
          ...(openDraft.building ? { building: openDraft.building } : {}),
        },
      } : {}),
      // Per task, what its author said it computes — a name namespaces the metrics, it does not
      // explain them.
      ...(Object.keys(ctx.state.task_notes || {}).length ? { task_notes: ctx.state.task_notes } : {}),
      semantic_models: Object.keys(additions),
      measures: Object.values(additions).flatMap((a) => a.measures.map((m) => m.name)),
      metrics: (ctx.state.metrics || []).map((m) => m.name),
      groupable: this._groupableSplit(ctx).now,
      files: this.ctxs.generatedFiles(ctx.id),
    };
  }

  list_query_jobs() {
    return { tasks: this.jobs.list() };
  }

  /** Reclaim idle, lease-free contexts (bounds workspace growth). */
  gc(maxIdleMs) {
    // the project's context is never reclaimed; its stored results age out as any context's do
    if (this.project) this.ctxs.pruneResultModels(PROJECT_STORE, maxIdleMs);
    return this.ctxs.gc(maxIdleMs);
  }

  /** Release process resources (the shared store handle, the runner's). */
  close() {
    // Managers share the store and don't own it; the Engine closes it once.
    try { if (this._ownsStore) this.store?.close?.(); } catch { /* noop */ }
    try { this._memoryStore?.close?.(); } catch { /* noop */ } // separate memory store (MCP_MEMORY_DB)
    try { this.runner?.close?.(); } catch { /* noop */ }
    // what a feature keeps running (a warm process of its own) goes with the engine
    for (const f of this.features || []) { try { f.close?.(); } catch { /* noop */ } }
  }

  /**
   * Materialize the time-spine TABLE the first time a context is queried. MetricFlow needs the
   * spine BUILT (not just configured) for metric_time / cumulative / SCD validity_params joins.
   * Only builds the spine WE generated (a base-provided spine is already built by the base
   * project). Idempotent per context; best-effort (a failure is left to surface on the query).
   */
  async _ensureTimeSpineBuilt(ctxId) {
    if (!this.runner?.run) return;
    const ctx = this.ctxs.get(ctxId);
    if (ctx.state._timeSpineBuilt) return;
    // the queries of a batch run side by side — and contexts that share one directory (the project's
    // own semantic models) query one copy: they share ONE build of the spine, never race to write it
    this._spineBuilds ||= new Map();
    this._spinesBuilt ||= new Set();
    const dir = this.ctxs.dir(ctxId);
    if (this._spinesBuilt.has(dir)) { ctx.state._timeSpineBuilt = true; return; }
    if (!this._spineBuilds.has(dir)) {
      this._spineBuilds.set(dir, this._buildTimeSpine(ctxId, ctx).then(() => { if (ctx.state._timeSpineBuilt) this._spinesBuilt.add(dir); }).finally(() => this._spineBuilds.delete(dir)));
    }
    await this._spineBuilds.get(dir);
    if (this._spinesBuilt.has(dir)) ctx.state._timeSpineBuilt = true;
  }

  async _buildTimeSpine(ctxId, ctx) {
    // Self-heal: make sure the spine files exist even for a reused/persisted context that never
    // went through create()'s ensureTimeSpine — then build the table we generated.
    try { this.ctxs.ensureTimeSpine?.(ctxId); } catch { /* best effort */ }
    if (!this.ctxs.generatedTimeSpine?.(ctxId)) { ctx.state._timeSpineBuilt = true; return; }
    const r = await this.runner.run(this.ctxs.dir(ctxId), 'metricflow_time_spine');
    if (r.ok) { ctx.state._timeSpineBuilt = true; this.ctxs.touch(ctxId); }
  }

  async _parse(ctxId) {
    if (!this.runner) return { ok: true, executed: false, reason: 'no runner configured — not parsed (unit mode)' };
    // Guarantee a time spine is CONFIGURED before parsing. The semantic manifest is invalid
    // without one ("At least one time spine must be configured"), and a REUSED context (passed
    // context_id) or one PERSISTED from before spine generation existed would otherwise fail
    // parse. ensureTimeSpine is idempotent — a no-op once a `time_spine:` config is present.
    try { this.ctxs.ensureTimeSpine?.(ctxId); } catch { /* best effort — parse will surface a real miss */ }
    const r = await this.runner.parse(this.ctxs.dir(ctxId));
    if (!r.ok) return { ok: false, error: { stage: 'parse', message: formatDbtError(r.stdout, r.stderr) } };
    return { ok: true, manifest: r.manifest };
  }

  _assumptions(ctx) {
    const a = [`one semantic model per table in context ${ctx.id}`];
    if (this.catalog.facts.some((f) => ctx.state.additions[f])) a.push('the event scope is applied inside each measure');
    a.push('metric_time / cumulative / conversion metrics require a configured time dimension');
    return a;
  }
}

mixin(Engine, memoryMethods, semanticIndexMethods, warehouseProbeMethods, pipelineWarningMethods, pipelineDraftMethods, pipelineMaterializeMethods, semanticBuildMethods, semanticQueryMethods, semanticPreviewMethods, taskResultMethods);

// WHICH SIDE A TASK BELONGS TO — and so which query tool reads it back. A semantic task (a declared
// model being parsed, a metric query) is read with query_semantic_model({ task_id }); a pipeline
// task (a build, a query over a built model) with query_pipeline_model({ task_id }). An experiment
// is no task at all: its statistics come back with its call.
const TASK_SIDE = {
  build_semantic_model: 'semantic', update_semantic_model: 'semantic', query_semantic_model: 'semantic', preview_semantic_model: 'semantic',
  build_pipeline_model: 'pipeline', register_native_model: 'pipeline', query_pipeline_model: 'pipeline',
};
const SIDE_READER = { semantic: 'query_semantic_model', pipeline: 'query_pipeline_model' };
