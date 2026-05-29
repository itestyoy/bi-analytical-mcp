// Tool engine: validates inputs against catalog-derived schemas, compiles
// declarations, renders YAML, drives dbt/mf within isolated contexts.

import { buildSchemas } from './schema.js';
import { makeValidators, validateInput, ToolError } from './validate.js';
import { compileDeclaration } from './compile.js';
import { renderContext } from './yaml-render.js';
import { ContextManager, mergeCompiled } from './context-manager.js';
import { renderWhereClauses } from './predicate.js';
import { formatDbtError } from './dbt-runner.js';
import { renderPerUserModelPostgres, renderPerUserModelBigQuery, sequenceSemanticModel, dumpSequenceYaml } from './match-recognize.js';
import { JobManager } from './jobs.js';
import { buildProjection } from './projection.js';

export class Engine {
  constructor({ catalog, contextManager, runner, recipes, sqlRunner, queryTimeoutMs, jobsDbPath }) {
    this.catalog = catalog;
    this.recipes = recipes; // optional Recipes instance
    this.sqlRunner = sqlRunner; // optional async (sql) => { columns, rows } — for match_recognize
    this.jobs = new JobManager({ dbPath: jobsDbPath }); // persisted (SQLite) if path given
    this.queryTimeoutMs = queryTimeoutMs ?? 60000; // materialize -> background after this
    this.schemas = buildSchemas(catalog);
    if (recipes) {
      this.schemas.list_recipes = { type: 'object', additionalProperties: false, properties: {} };
      this.schemas.get_recipe = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', enum: recipes.ids() } } };
    }
    this.validators = makeValidators(this.schemas);
    this.ctxs = contextManager || new ContextManager({});
    this.runner = runner; // optional; required for non-dry_run parse/query
  }

  list_recipes() {
    if (!this.recipes) return { recipes: [] };
    return { recipes: this.recipes.summary() };
  }

  get_recipe(input) {
    this._validate('get_recipe', input);
    return this.recipes.get(input.id);
  }

  _validate(tool, input) {
    const res = validateInput(this.validators[tool], input || {});
    if (!res.ok) throw new ToolError(`invalid input: ${res.errors.join('; ')}`, { stage: 'validate' });
  }

  /** Map of task-local dimension name -> entity-qualified path (e.g. event__mon_product_id). */
  _taskDimMap(ctx) {
    const map = new Map();
    for (const [modelKey, add] of Object.entries(ctx.state.additions || {})) {
      const pe = this.catalog.primaryEntityName(modelKey);
      for (const d of add.dimensions || []) map.set(d.name, pe ? `${pe}__${d.name}` : d.name);
    }
    return map;
  }

  /** All group-by/where dimension paths allowed for a context (bare + qualified). */
  _allowedPaths(ctx) {
    const set = new Set(this.catalog.reachableGroupByPaths());
    for (const [bare, qualified] of this._taskDimMap(ctx)) { set.add(bare); set.add(qualified); }
    return set;
  }

  /** Resolve a bare task-dim name to its entity-qualified MetricFlow path. */
  _resolvePath(ctx, path) {
    return this._taskDimMap(ctx).get(path) || path;
  }

  describe_catalog() {
    const c = this.catalog;
    return {
      dialect: c.dialect,
      models: c.modelKeys().map((k) => {
        const m = c.getModel(k);
        return {
          key: k,
          dbt_model: m.dbt_model,
          role: m.role,
          dimensions: k === c.anchor ? undefined : Object.keys(m.dimensions || {}),
          measures: Object.keys(m.measures || {}),
        };
      }),
      event_names: c.eventNames(),
      event_properties: c.eventProps(),
      event_numeric_properties: c.eventNumericProps(),
      groupable_paths: c.reachableGroupByPaths(),
      enums: {
        agg: ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'],
        metric_type: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'],
        time_granularity: c.timeGranularities(),
      },
    };
  }

  /** Compile, converting bad-reference errors into a clearly-staged ToolError. */
  _compile(input) {
    try {
      return compileDeclaration(this.catalog, input);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(e.message, { stage: 'compile' });
    }
  }

  /** Check that a group-by/where path's entity hops map to models loaded in the context. */
  _checkPathLoaded(ctx, path) {
    if (typeof path !== 'string' || !path.includes('__')) return; // local task dim or metric_time
    const segs = path.split('__');
    for (const entity of segs.slice(0, -1)) {
      const model = this.catalog.primaryByEntity[entity];
      if (!model) continue; // already pruned/validated elsewhere
      if (model === this.catalog.anchor) continue;
      if (!ctx.state.usedModels.includes(model)) {
        throw new ToolError(
          `path '${path}' needs model '${model}', which is not loaded in this context. ` +
            `Recreate/update the task with use_base_models including '${model}'.`,
          { stage: 'validate', field: path },
        );
      }
    }
  }

  /**
   * Register a derived dbt model (e.g. a MATCH_RECOGNIZE sequence VIEW) and a
   * semantic model on top of it. Kept SEPARATE from create_semantic_model so the
   * row-pattern SQL and MetricFlow are not mixed. After registration the model's
   * metrics/dimensions are queryable via query_semantic_model like any other.
   */
  /** Generate the view SQL + semantic model for a sequence spec. */
  _nativeArtifacts(input) {
    const modelName = `seq_${input.name}`;
    const dialect = this.catalog.dialect;
    const eventsModel = this.catalog.getModel(this.catalog.anchor).dbt_model;
    const usersModel = this.catalog.models.users?.dbt_model;
    const seqSpec = { ...input.sequence, relation: `{{ ref('${eventsModel}') }}`, ...(usersModel ? { usersRelation: `{{ ref('${usersModel}') }}` } : {}) };
    const modelSql = dialect === 'bigquery' ? renderPerUserModelBigQuery(this.catalog, seqSpec) : renderPerUserModelPostgres(this.catalog, seqSpec);
    const bqSql = dialect === 'bigquery' ? modelSql : renderPerUserModelBigQuery(this.catalog, seqSpec);
    const sem = sequenceSemanticModel(this.catalog, seqSpec, modelName);
    return { modelName, dialect, modelSql, bqSql, sem };
  }

  /** Write the view + semantic model into the context overlay, build + parse. */
  async _materializeNative(input, ctx, art) {
    const materialized = input.materialized || 'view';
    ctx.state.engine = 'match_recognize';
    ctx.state.model = art.modelName;
    ctx.state.seqMetrics = art.sem.metricNames;
    ctx.state.seqGroupable = art.sem.dimensionNames;
    if (!ctx.state.tasks?.includes(input.name)) (ctx.state.tasks ||= []).push(input.name);
    this.ctxs.writeModel(ctx.id, art.modelName, `{{ config(materialized='${materialized}') }}\n${art.modelSql}\n`);
    this.ctxs.writeYaml(ctx.id, dumpSequenceYaml(art.sem));
    this.ctxs.touch(ctx.id);
    let build = { ok: true, skipped: 'no runner' };
    if (this.runner) {
      const r = await this.runner.run(this.ctxs.dir(ctx.id), art.modelName);
      if (!r.ok) return { ok: false, build: { ok: false, error: { stage: 'run', message: formatDbtError(r.stdout, r.stderr) } } };
      const p = await this.runner.parse(this.ctxs.dir(ctx.id));
      build = p.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(p.stdout, p.stderr) } };
    }
    return { ok: build.ok !== false, build, materialized };
  }

  async register_native_model(input) {
    this._validate('register_native_model', input);
    const art = this._nativeArtifacts(input);
    if (input.dry_run) {
      return { kind: 'match_recognize', dry_run: true, model: art.modelName, materialized: input.materialized || 'view', dialect: art.dialect, model_sql: art.modelSql, model_sql_bigquery: art.bqSql, semantic_yaml: dumpSequenceYaml(art.sem), metrics: art.sem.metricNames, dimensions: art.sem.dimensionNames };
    }
    const ctx = input.context_id ? this.ctxs.get(input.context_id) : this.ctxs.create();
    const m = await this._materializeNative(input, ctx, art);
    if (!m.ok) return { context_id: ctx.id, kind: 'match_recognize', ok: false, error: m.build.error };
    return {
      context_id: ctx.id,
      kind: 'match_recognize',
      model: art.modelName,
      materialized: m.materialized,
      dialect: art.dialect,
      registered: { model: art.modelName, metrics: art.sem.metricNames, dimensions: art.sem.dimensionNames },
      metrics: art.sem.metricNames,
      groupable: art.sem.dimensionNames,
      model_sql_bigquery: art.bqSql,
      build: m.build,
      assumptions: [
        `MATCH_RECOGNIZE registered as a ${m.materialized} model (${art.modelName}); a semantic model is built on it.`,
        'It now behaves like a base model: query its metrics/dimensions via query_semantic_model.',
      ],
      warnings: [],
    };
  }

  /** Update a registered native model in place (re-generate + rebuild the view). */
  async update_native_model(input) {
    this._validate('update_native_model', input);
    const ctx = this.ctxs.get(input.context_id);
    const art = this._nativeArtifacts(input);
    const m = await this._materializeNative(input, ctx, art);
    if (!m.ok) return { context_id: ctx.id, kind: 'match_recognize', ok: false, error: m.build.error };
    return { context_id: ctx.id, kind: 'match_recognize', model: art.modelName, materialized: m.materialized, metrics: art.sem.metricNames, groupable: art.sem.dimensionNames, build: m.build, warnings: [] };
  }

  /** Delete a registered native model: remove its files + state and re-parse. */
  async delete_native_model(input) {
    this._validate('delete_native_model', input);
    const ctx = this.ctxs.get(input.context_id);
    if (ctx.state.engine !== 'match_recognize') return { context_id: ctx.id, removed: false, reason: 'no native model registered in this context' };
    const model = ctx.state.model;
    this.ctxs.removeGeneratedFile(ctx.id, `${model}.sql`);
    this.ctxs.removeGeneratedFile(ctx.id, 'context.yml');
    delete ctx.state.engine; delete ctx.state.model; delete ctx.state.seqMetrics; delete ctx.state.seqGroupable;
    ctx.state.metrics ||= []; ctx.state.additions ||= {}; ctx.state.usedModels ||= []; // core-safe after delete
    this.ctxs.touch(ctx.id);
    const parse = this.runner ? await this.runner.parse(this.ctxs.dir(ctx.id)) : { ok: true, skipped: 'no runner' };
    return { context_id: ctx.id, removed: true, model, parse: parse.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(parse.stdout, parse.stderr) } }, note: 'model definition removed; the warehouse view may persist until the context is dropped (drop_context) or the warehouse cleans ephemeral objects' };
  }

  async create_semantic_model(input) {
    this._validate('create_semantic_model', input);
    const compiled = this._compile(input);

    if (input.dry_run) {
      const draft = { tasks: [], additions: {}, metrics: [], usedModels: [] };
      if (input.context_id && this.ctxs.has(input.context_id)) {
        const cur = this.ctxs.get(input.context_id).state;
        mergeCompiled(draft, { additions: clone(cur.additions), metrics: clone(cur.metrics), usedModels: [...cur.usedModels], task: null });
      }
      mergeCompiled(draft, compiled);
      const render = renderContext(this.catalog, draft);
      return { context_id: input.context_id || null, task: compiled.task, dry_run: true, yaml: render.yaml, semantic_models: render.semanticModels, metrics: render.metricNames };
    }

    const ctx = input.context_id ? this.ctxs.get(input.context_id) : this.ctxs.create();
    mergeCompiled(ctx.state, compiled);
    const render = renderContext(this.catalog, ctx.state);
    const file = this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);

    const parse = await this._parse(ctx.id);
    return {
      context_id: ctx.id,
      task: compiled.task,
      files: [file],
      yaml: render.yaml,
      semantic_models: render.semanticModels,
      joined_models: ctx.state.usedModels,
      metrics: render.metricNames,
      groupable: [...this._allowedPaths(ctx)],
      parse,
      assumptions: this._assumptions(ctx),
      warnings: [],
    };
  }

  async update_semantic_model(input) {
    this._validate('update_semantic_model', input);
    const ctx = this.ctxs.get(input.context_id);
    const modelKey = input.semantic_model;
    const add = (ctx.state.additions[modelKey] ||= { measures: [], dimensions: [] });

    // synthesize a declaration fragment for the add_* parts and compile it
    const task = input.task || ctx.state.tasks[0] || 'task';
    const frag = { name: task, semantic_models: [{ from: modelKey, dimensions: input.add_dimensions || [], measures: input.add_measures || [] }], metrics: input.add_metrics || [] };
    const compiled = this._compile(frag);

    // removals (with dependency checks for measures)
    if (input.remove_metrics) ctx.state.metrics = ctx.state.metrics.filter((m) => !input.remove_metrics.includes(m.name));
    if (input.remove_measures) {
      for (const rm of input.remove_measures) {
        const dependents = ctx.state.metrics.filter((m) => metricUsesMeasure(m, rm));
        if (dependents.length && !input.cascade) {
          throw new ToolError(`cannot remove measure '${rm}'; metrics depend on it: ${dependents.map((d) => d.name).join(', ')}`, { stage: 'validate', field: rm });
        }
      }
      add.measures = add.measures.filter((m) => !input.remove_measures.includes(m.name));
    }
    if (input.remove_dimensions) add.dimensions = add.dimensions.filter((d) => !input.remove_dimensions.includes(d.name));

    mergeCompiled(ctx.state, compiled);
    const render = renderContext(this.catalog, ctx.state);
    const file = this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);
    const parse = input.dry_run ? undefined : await this._parse(ctx.id);
    return { context_id: ctx.id, semantic_model: modelKey, files: [file], yaml: render.yaml, metrics: render.metricNames, groupable: [...this._allowedPaths(ctx)], parse, warnings: [] };
  }

  async delete_semantic_model(input) {
    this._validate('delete_semantic_model', input);
    const ctx = this.ctxs.get(input.context_id);
    const modelKey = input.semantic_model;
    const add = ctx.state.additions[modelKey];
    if (!add) return { context_id: ctx.id, removed: false, reason: 'no task additions for this model' };
    const taskMeasureNames = new Set(add.measures.map((m) => m.name));
    const dependents = ctx.state.metrics.filter((m) => [...taskMeasureNames].some((mm) => metricUsesMeasure(m, mm)));
    if (dependents.length && !input.cascade) {
      throw new ToolError(`metrics depend on this model's measures: ${dependents.map((d) => d.name).join(', ')}`, { stage: 'validate' });
    }
    ctx.state.metrics = ctx.state.metrics.filter((m) => !dependents.includes(m));
    delete ctx.state.additions[modelKey];
    const render = renderContext(this.catalog, ctx.state);
    this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);
    const parse = await this._parse(ctx.id);
    return { context_id: ctx.id, semantic_model: modelKey, removed: true, metrics: render.metricNames, parse };
  }

  drop_context(input) {
    this._validate('drop_context', input);
    return this.ctxs.drop(input.context_id);
  }

  list_contexts() {
    return { contexts: this.ctxs.list() };
  }

  describe_context(input) {
    this._validate('describe_context', input);
    const ctx = this.ctxs.get(input.context_id);
    return {
      context_id: ctx.id,
      tasks: ctx.state.tasks,
      semantic_models: Object.keys(ctx.state.additions),
      measures: Object.values(ctx.state.additions).flatMap((a) => a.measures.map((m) => m.name)),
      metrics: ctx.state.metrics.map((m) => m.name),
      groupable: [...this._allowedPaths(ctx)],
      files: this.ctxs.generatedFiles(ctx.id),
    };
  }

  async query_semantic_model(input) {
    this._validate('query_semantic_model', input);
    const ctx = this.ctxs.get(input.context_id);

    // match_recognize contexts are a core semantic model OVER a generated VIEW;
    // query them through MetricFlow (full metric/join power).
    if (ctx.state.engine === 'match_recognize') {
      const known = new Set(ctx.state.seqMetrics);
      for (const m of input.metrics || []) if (!known.has(m)) throw new ToolError(`unknown metric in context: ${m}`, { stage: 'validate', field: m });
      const reachable = new Set(ctx.state.seqGroupable);
      const groupBy = [];
      for (const g of input.group_by || []) {
        if (typeof g === 'object' && g.time === 'metric_time') groupBy.push(`metric_time__${g.grain || 'day'}`);
        else if (typeof g === 'string') {
          if (!reachable.has(g)) throw new ToolError(`group_by not available on this view: ${g}. Available: ${[...reachable].join(', ')}`, { stage: 'validate', field: g });
          // all are local dims on the seq SM (primary entity 'user') -> user__<dim>
          groupBy.push(`user__${g}`);
        }
      }
      if (!this.runner) throw new ToolError('no dbt runner configured', { stage: 'query' });
      const qopts = { metrics: input.metrics, groupBy, startTime: input.time_range?.start, endTime: input.time_range?.end, limit: (input.limit ?? 1000) };
      if (input.materialize) return this._materialize(ctx, qopts, input);
      const res = await this.runner.query(this.ctxs.dir(ctx.id), { ...qopts, explain: !!input.dry_run });
      if (!res.ok) return { ok: false, engine: 'match_recognize', command: res.command, error: { stage: 'query', message: formatDbtError(res.stdout, res.stderr) } };
      if (input.dry_run) return { ok: true, engine: 'match_recognize', dry_run: true, sql: res.sql };
      return { ok: true, engine: 'match_recognize', command: res.command, columns: res.columns, rows: res.rows, row_count: res.rows.length };
    }

    if (!input.metrics?.length) throw new ToolError('metrics is required for core (MetricFlow) queries', { stage: 'validate' });
    const known = new Set(ctx.state.metrics.map((m) => m.name));
    for (const m of input.metrics) if (!known.has(m)) throw new ToolError(`unknown metric in context: ${m}`, { stage: 'validate', field: m });

    const allowed = this._allowedPaths(ctx);
    const groupBy = [];
    for (const g of input.group_by || []) {
      if (typeof g === 'object' && g.time === 'metric_time') groupBy.push(`metric_time__${g.grain || 'day'}`);
      else if (typeof g === 'string') {
        if (g !== 'metric_time' && !allowed.has(g)) throw new ToolError(`group_by path not reachable in context: ${g}. Known paths: ${[...allowed].slice(0, 30).join(', ')}`, { stage: 'validate', field: g });
        const resolved = this._resolvePath(ctx, g);
        this._checkPathLoaded(ctx, resolved);
        groupBy.push(resolved);
      }
    }
    let where = [];
    if (input.where) {
      const translated = clone(input.where);
      walkPredicates(translated, (p) => {
        if (p.field?.kind === 'dimension') {
          if (!allowed.has(p.field.path)) throw new ToolError(`where path not reachable in context: ${p.field.path}`, { stage: 'validate', field: p.field.path });
          p.field.path = this._resolvePath(ctx, p.field.path); // bare task dim -> entity-qualified
          this._checkPathLoaded(ctx, p.field.path);
        }
      });
      where = renderWhereClauses(translated);
    }
    const orderBy = (input.order_by || []).map((o) => `${o.direction === 'desc' ? '-' : ''}${o.key}`);

    if (!this.runner) throw new ToolError('no dbt runner configured', { stage: 'query' });

    const limit = input.limit ?? 1000;
    const offset = input.offset ?? 0;
    const qopts = { metrics: input.metrics, groupBy, where, orderBy, startTime: input.time_range?.start, endTime: input.time_range?.end, limit: limit + offset };
    if (input.materialize) return this._materialize(ctx, qopts, input);
    const res = await this.runner.query(this.ctxs.dir(ctx.id), { ...qopts, explain: !!input.dry_run });
    this.ctxs.touch(ctx.id);

    if (!res.ok) return { ok: false, command: res.command, error: { stage: 'query', message: formatDbtError(res.stdout, res.stderr) } };
    if (input.dry_run) return { ok: true, dry_run: true, command: res.command, sql: res.sql };

    const pageRows = res.rows.slice(offset, offset + limit);
    return {
      ok: true,
      command: res.command,
      columns: res.columns,
      rows: pageRows,
      row_count: pageRows.length,
      page: { limit, offset, has_more: res.rows.length > offset + limit },
      warnings: [],
    };
  }

  /**
   * Materialization mode: compile the query to SQL, write it as a
   * materialized='table' dbt model, build it (dbt run), and read rows back from
   * that table (dbt show). Results live in the warehouse — re-fetchable and
   * crash-resilient. If the build exceeds queryTimeoutMs, it continues in the
   * BACKGROUND and a query_id is returned; poll get_query_result.
   */
  async _materialize(ctx, qopts, input) {
    if (!this.runner) throw new ToolError('no dbt runner configured', { stage: 'query' });
    const dir = this.ctxs.dir(ctx.id);
    const explain = await this.runner.query(dir, { ...qopts, explain: true });
    if (!explain.ok) return { ok: false, error: { stage: 'query', message: formatDbtError(explain.stdout, explain.stderr) } };

    const id = this.jobs.create({ contextId: ctx.id });
    const table = `qr_${id}`;
    this.jobs.setTable(id, table);
    this.ctxs.writeModel(ctx.id, table, `{{ config(materialized='table') }}\n${explain.sql}\n`);

    const build = (async () => {
      const r = await this.runner.run(dir, table);
      if (!r.ok) this.jobs.fail(id, formatDbtError(r.stdout, r.stderr));
      else this.jobs.ready(id);
    })();
    const timed = new Promise((res) => setTimeout(() => res('timeout'), this.queryTimeoutMs));
    const winner = await Promise.race([build.then(() => 'done'), timed]);
    if (winner === 'timeout') {
      return { ok: true, status: 'running', query_id: id, table, message: `materializing in background (> ${this.queryTimeoutMs / 1000}s); poll get_query_result with query_id` };
    }
    const job = this.jobs.get(id);
    if (job.status === 'error') return { ok: false, status: 'error', query_id: id, table, error: { stage: 'materialize', message: job.error } };
    return this._fetchResult(id, input.limit ?? 1000);
  }

  /** Read rows back from a materialized result table (resilient: no recompute). */
  async _fetchResult(id, limit, transform) {
    const job = this.jobs.get(id);
    return this._readTable(this.ctxs.dir(job.contextId), job.table, limit, transform, { query_id: id });
  }

  /** Run a (optionally projected) read over a materialized result table. */
  async _readTable(dir, table, limit, transform, extra = {}) {
    const sql = transform
      ? buildProjection(`{{ ref('${table}') }}`, transform)
      : `select * from {{ ref('${table}') }}`;
    const res = await this.runner.show(dir, sql, limit);
    if (!res.ok) return { ok: false, status: 'error', table, ...extra, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
    return { ok: true, status: 'ready', table, ...extra, columns: res.columns, rows: res.rows, row_count: res.rows.length, ...(transform ? { projected: true } : {}) };
  }

  /**
   * Poll a background (materialized) query: status + results from the table.
   * Optional `transform` (where/group_by/aggregations/having/order_by/limit)
   * runs a safe read-only projection over the materialized table — compress or
   * re-slice the stored results without recomputing the analytics query.
   */
  async get_query_result(input) {
    this._validate('get_query_result', input);
    if (!this.runner) throw new ToolError('no dbt runner configured', { stage: 'query' });
    const limit = input.limit ?? 1000;
    // direct fetch by table (crash-resilient: works even if the job is gone)
    if (input.table) {
      return this._readTable(this.ctxs.dir(input.context_id), input.table, limit, input.transform);
    }
    const job = this.jobs.get(input.query_id);
    if (!job) throw new ToolError(`unknown query_id: ${input.query_id} (pass {context_id, table} to fetch a known table directly)`, { stage: 'validate', field: 'query_id' });
    if (job.status === 'running') return { ok: true, status: 'running', query_id: job.id, table: job.table };
    if (job.status === 'error') return { ok: false, status: 'error', query_id: job.id, table: job.table, error: { stage: 'materialize', message: job.error } };
    return this._fetchResult(job.id, limit, input.transform);
  }

  list_query_jobs() {
    return { jobs: this.jobs.list() };
  }

  async _parse(ctxId) {
    if (!this.runner) return { ok: true, skipped: 'no runner (unit mode)' };
    const r = await this.runner.parse(this.ctxs.dir(ctxId));
    if (!r.ok) return { ok: false, error: { stage: 'parse', message: formatDbtError(r.stdout, r.stderr) } };
    return { ok: true, manifest: r.manifest };
  }

  _assumptions(ctx) {
    const a = [`one semantic model per table in context ${ctx.id} (C3)`];
    if (ctx.state.additions[this.catalog.anchor]) a.push('event_scope baked into measure expr (M3)');
    a.push('metric_time/cumulative/conversion require a materialized time spine in the base project (C2)');
    return a;
  }
}

function metricUsesMeasure(metric, measureName) {
  const tp = metric.type_params || {};
  const refs = [tp.measure?.name];
  if (tp.conversion_type_params) refs.push(tp.conversion_type_params.base_measure?.name, tp.conversion_type_params.conversion_measure?.name);
  return refs.includes(measureName);
}

function walkPredicates(group, fn) {
  for (const c of group.conditions || []) {
    if (c.conditions) walkPredicates(c, fn);
    else fn(c);
  }
}

function clone(x) {
  return JSON.parse(JSON.stringify(x ?? null));
}
