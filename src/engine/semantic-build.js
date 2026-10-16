// BUILD_SEMANTIC_MODEL — a declaration compiled into a semantic layer (src/compile.js → yaml-render),
// parsed by dbt in the context's own project, and updated or dropped; a native dbt model registered
// into a context. Methods of the Engine (src/engine/helpers.js — mixin).

import { ToolError } from '../validate.js';
import { compileDeclaration, measureRefs } from '../compile.js';
import { renderContext, slowlyChangingNoMeasures } from '../yaml-render.js';
import { mergeCompiled } from '../context-manager.js';
import { formatDbtError } from '../dbt/index.js';
import { refText, wants } from './semantic-query.js';
import { declarationOf, joinKeysOf } from '../pipeline/semantic-stage.js';
import { builtModel, catalogWith } from '../catalog/built-model.js';

/** What a semantic declaration keeps in a context's state — all a new semantic_model step replaces. */
const SEMANTIC_STATE = ['additions', 'metrics', 'usedModels', 'tasks', 'task_notes'];

/**
 * How `model` is loaded into a context for its columns: a join of its semantic_model step, where a model
 * of the catalog carries a key it owns — or, where none does, a measure of it (`source`), whose own
 * columns then group that measure.
 */
export const loadModelCall = (contextId, model, catalog = null) => {
  const joinable = !catalog || (catalog.joinContract(model) && Object.keys(catalog.entitiesOf(model)).some((r) => catalog.joinTargetFor(r) === model && catalog.modelKeys().some((m) => m !== model && catalog.entityKey(m, r)?.length)));
  const edit = `build_model({ request: { action: 'edit_step', context_id: '${contextId}', index, step } }), then materialize`;
  return joinable
    ? `join it in the build's semantic_model step — { source: '${model}', on: { … } } in its join (${edit})`
    : `nothing of the catalog points at a key '${model}' owns, so it is no join — a measure of the build's semantic_model step with source: '${model}' loads it, and its own columns group that measure (${edit})`;
};

/**
 * A declaration whose every metric would be left out of the layer (each reads a measure declared on a
 * slowly-changing model, which takes none) is refused in the call, with the way out — a build that
 * answered "done" with no metric to query left the caller nothing. When some of its metrics remain,
 * the others are left out with a warning (renderContext).
 */
function refuseIfNoMetricLeft(catalog, compiled, render) {
  const asked = (compiled.metrics || []).map((m) => m.name);
  if (!asked.length || asked.some((n) => render.metricNames.includes(n))) return;
  throw new ToolError(`no metric of this declaration can be queried — ${asked.map((n) => `'${n}'`).join(', ')} ${asked.length > 1 ? 'read measures' : 'reads a measure'} declared on ${render.droppedFrom.map((m) => `'${m}'`).join(', ')}. ${slowlyChangingNoMeasures(catalog, render.droppedFrom)}`, { stage: 'validate', field: 'semantic_models' });
}

export const semanticBuildMethods = {
  /** Compile, converting bad-reference errors into a clearly-staged ToolError. */
  _compile(input, options, catalog = this.catalog) {
    try {
      return compileDeclaration(catalog, input, options);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      // compile.js attaches the offending INPUT FIELD to the error — surface it so the
      // caller knows exactly which part of the declaration to fix.
      throw new ToolError(e.message, { stage: 'compile', ...(e.field ? { field: e.field } : {}) });
    }
  },

  /**
   * The model a reference resolves onto must be LOADED in this context: a task built from one
   * source does not load another's semantic model, so MetricFlow would reject the entity. The
   * model is taken from the reference the caller wrote — the compiled path is not read back; `said`
   * is how the reference is shown (users.country), `at` where it stands (steps[1] group_by[0]).
   */
  _checkModelLoaded(ctx, model, said, field = 'group_by', at = null) {
    if (!model || !this._catalogOf(ctx).models[model]) return; // already refused
    if (ctx.state.usedModels?.includes(model)) return;
    throw new ToolError(
      `${at ? `${at}: ` : ''}'${said}' needs model '${model}', which this context does not read. `
        + `Load it: ${loadModelCall(ctx.id, model, this._catalogOf(ctx))}.`,
      { stage: 'validate', field },
    );
  },

  /**
   * Register a derived dbt model from a declarative PIPELINE (source + ordered
   * stages, optionally ending in a match_recognize funnel). The pipeline's rows
   * ARE the result. Funnels are just pipelines: match_recognize is a stage, and
   * downstream join/aggregate slice it by user attributes — no separate engine.
   */
  async _buildPipeline(input) {
    this._validate('build_model.pipeline', input);
    // a build is a task: the id now, the rows from query_model({ request: { task_ids } })
    const existing = input.context_id ? this._ctxToWrite(input.context_id) : null;
    const ctxId = existing ? existing.id : this.ctxs.newId();
    const taskId = this._startTask(existing, 'build_pipeline_model', (id) => this._registerPipeline(input, { ctxId, taskId: id }), { input });
    return this._taskStarted(taskId, { context_id: ctxId });
  },

  /** Delete a pipeline model: remove its files + state and re-parse. */
  async _deletePipelineModel(input) {
    this._validate('delete_context.pipeline_model', input);
    const ctx = this._ctxToWrite(input.context_id);
    if (ctx.state.engine !== 'pipeline') return { context_id: ctx.id, removed: false, reason: 'no pipeline model registered in this context' };
    const model = ctx.state.model;
    // a pipeline is a CHAIN of files (.sql / .py / .yml, plus `_sN` steps) — all of them go, and so
    // do the models of its earlier builds (`_cN`): the base name owns the whole family.
    const consumers = this._checkpointConsumers(ctx.id); // forks reading a table built here
    const removedFiles = this.ctxs.removePipelineFiles(ctx.id, model.replace(/_c\d+$/, ''));
    delete ctx.state.engine; delete ctx.state.model; delete ctx.state.pipeline_model;
    if (ctx.state.draft) ctx.state.draft.checkpoints = []; // their tables are gone with the files
    delete ctx.state.checkpoint_consumers;
    for (const c of consumers) { // a fork that read one of these prefixes has to recompute it now
      const st = this.ctxs.get(c.consumer).state;
      if (st.draft) st.draft.checkpoints = (st.draft.checkpoints || []).filter((cp) => cp.model !== c.model);
      this.ctxs.touch(c.consumer);
    }
    ctx.state.metrics ||= []; ctx.state.additions ||= {}; ctx.state.usedModels ||= []; // core-safe after delete
    this.ctxs.touch(ctx.id);
    const parse = this.runner ? await this.runner.parse(this.ctxs.dir(ctx.id)) : { ok: true, executed: false, reason: 'no runner configured — not parsed (dry/unit mode)' };
    return { context_id: ctx.id, removed: true, model, removed_files: removedFiles, ...(consumers.length ? { consumers_recomputing: consumers } : {}), parse: parse.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(parse.stdout, parse.stderr) } }, note: "model definition removed; the stored view may persist until the context is dropped (delete_context({ request: { context_id } })) or the store cleans ephemeral objects" };
  },

  /**
   * THE SEMANTIC LAYER A BUILD'S LAST STEP DECLARES (src/pipeline/semantic-stage.js) — compiled and
   * rendered on a copy, nothing written: { decl, compiled, render, catalog, layerModel? }. Over the build's
   * source when the step is its only one; over the table the steps before it built otherwise — that table a
   * model of the context's catalog (src/catalog/built-model.js: its time axis the step's `time`, its foreign
   * keys its joins'), `table` the dbt model that holds it (the next build's name where none is known yet).
   * Every mistake refused, naming the part of the step it is in.
   */
  async _semanticLayerOf(ctx, draft, st, { table = null } = {}) {
    const say = (e) => new ToolError(`semantic_model: ${e.message}`, { stage: 'validate', field: e.field ? `semantic_model.${e.field}` : 'semantic_model' });
    let catalog = this.catalog;
    let layerModel = null;
    let source = draft.source;
    if (draft.stages.length || draft.base) {
      const key = draft.name;
      const c = this.catalog;
      if (c.models[key] || c.primaryByEntity[key] || c.joinEntityNames().includes(key)) throw say(Object.assign(new Error(`the build's name '${key}' is a model or a key of the catalog, and its table is a model of the context under that name — name the build apart from them`), { field: 'name' }));
      if (st.time === undefined) throw say(Object.assign(new Error('time: name the column of the table the steps before this one built that is its time axis (metric_time) — a column of the time type'), { field: 'time' }));
      const columns = this._draftColumns(draft, await this.probe.grounding(draft.source, draft.stages));
      const axis = columns.find((x) => x.name === st.time);
      if (!axis) throw say(Object.assign(new Error(`time: '${st.time}' is no column of the table the steps before this one built — its columns: ${columns.map((x) => x.name).join(', ')}`), { field: 'time' }));
      if (!['time', 'unknown'].includes(axis.type)) throw say(Object.assign(new Error(`time: '${st.time}' is ${axis.type}, not a moment — the time axis is a moment the steps before this one carry: a time column, or one made of it (min / max of it in an aggregate, date_trunc of it)`), { field: 'time' }));
      let keys;
      try { keys = joinKeysOf(c, st.join || [], columns.map((x) => x.name)); } catch (e) { throw say(e); }
      const model = builtModel({ key, dbtModel: table || this._nextPipelineModel(ctx, draft.name), columns, time: st.time, keys, description: draft.description });
      catalog = catalogWith(c, key, model);
      layerModel = { key, model };
      source = key;
    }
    let decl;
    try { decl = declarationOf(catalog, { name: draft.name, description: draft.description, source }, st); } catch (e) { throw say(e); }
    const compiled = this._compile(decl, undefined, catalog);
    const layer = { tasks: [], additions: {}, metrics: [], usedModels: [] };
    mergeCompiled(layer, compiled);
    const render = renderContext(catalog, layer, { spec: this._semanticSpec() });
    refuseIfNoMetricLeft(catalog, compiled, render);
    return { decl, compiled, render, catalog, layerModel };
  },

  /**
   * The semantic layer of a build, made the context's: its declaration replaces the one the context held,
   * taken in the call — so a query issued right after it validates against these metrics — and parsed by
   * dbt in a task (a query on the context waits for it: tasks on one context run in order). Over the table
   * its steps build, that build goes first — or the table that already stands for them, a checkpoint or a
   * task's — and the layer is written once it stands.
   */
  async _materializeLayer(ctx, draft) {
    let table = null;
    let built = null; // the build of the steps before the step, when they are no table yet
    if (draft.stages.length || draft.base) {
      const plan = draft.stages.length ? this._renderPlan(draft, draft.stages, { forBuild: true }) : null;
      if (!draft.stages.length) table = draft.base.model;
      else if (plan.checkpoint && !plan.stages.length) table = plan.checkpoint.model;
      else {
        built = await this._draftMaterialize(ctx, draft, { stagesOnly: true });
        table = built.model;
      }
    }
    const { decl, compiled, render, layerModel } = await this._semanticLayerOf(ctx, draft, draft.semantic, { table });
    for (const k of SEMANTIC_STATE) delete ctx.state[k];
    Object.assign(ctx.state, { tasks: [], additions: {}, metrics: [], usedModels: [] });
    if (layerModel) ctx.state.layer_model = layerModel; else delete ctx.state.layer_model;
    mergeCompiled(ctx.state, compiled);
    this.ctxs.touch(ctx.id);
    const write = () => this.ctxs.writeSemanticYaml(ctx.id, render);
    const input = { action: 'materialize', context_id: ctx.id, name: draft.name, source: draft.source, steps: [...draft.stages, draft.semantic] };
    if (!built) {
      const file = write();
      const taskId = this._startTask(ctx, 'build_semantic_model', () => this._declared(ctx, decl, compiled, render, file), { input });
      return this._taskStarted(taskId, { context_id: ctx.id });
    }
    // the layer is written once its table stands: the build runs first on the context
    const taskId = this._startTask(ctx, 'build_semantic_model', async () => {
      const job = this.jobs.get(built.task_id);
      if (job?.status !== 'ready') {
        const why = job?.error || `its build ended ${job?.status || 'unknown'}`;
        return { ok: false, status: 'error', context_id: ctx.id, error: { stage: 'build', message: `the table the semantic layer stands on (${table}, task ${built.task_id}) did not build: ${why}` } };
      }
      return this._declared(ctx, decl, compiled, render, write());
    }, { input });
    return this._taskStarted(taskId, { context_id: ctx.id, model: table });
  },

  /** The finished answer of a declared task: parsed, with what it can be grouped by and the next call. */
  async _declared(ctx, input, compiled, render, file) {
    const parse = await this._parse(ctx.id);
    const { now: groupable, afterLoading } = this._groupableSplit(ctx);
    // the example must be a call that RUNS in this context, so it comes from what is loaded
    const exRef = groupable[0];
    const exText = exRef ? refText(exRef) : "{ time: 'metric_time', grain: 'day' }";
    return {
      context_id: ctx.id,
      task: compiled.task,
      files: [file],
      ...(wants(input, 'yaml') ? { yaml: render.yaml } : {}),
      semantic_models: render.semanticModels,
      joined_models: ctx.state.usedModels,
      metrics: render.metricNames,
      groupable,
      ...(afterLoading.length ? {
        groupable_after_loading: afterLoading,
        groupable_after_loading_note: `These columns are reachable in the catalog but this context does not read their model — load it before naming them in a group_by or a where: ${loadModelCall(ctx.id, afterLoading[0].source, this.catalog)}.`,
      } : {}),
      parse,
      assumptions: this._assumptions(ctx),
      warnings: render.warnings || [],
      // Never a dead end: name the exact next call with real metric/path names.
      next: render.metricNames.length
        ? `Query it: query_model({ request: { context_id: '${ctx.id}', steps: [{ stage: 'metrics', metrics: [${render.metricNames.slice(0, 3).map((m) => `'${m}'`).join(', ')}], group_by: [${exText}] }], time_range: { start, end } } }).`
        : `This context has no metric to query yet: add one to its semantic_model step (build_model({ request: { action: 'edit_step', context_id: '${ctx.id}', index, step } })) and materialize.`,
      recommendations: [
        `Bound every query with time_range. Group by a ref from \`groupable\` (the metrics step's group_by), or filter by one in a where step before the metrics step, as it is written there — a model's column { source, column } (e.g. ${exText}), a declared event property { source, property }, a computed dimension { semantic_model: [<its source>], dimension } — or by { time: 'metric_time', grain }.`,
        `Change it later by editing its semantic_model step (build_model({ request: { action: 'edit_step', context_id: '${ctx.id}', index, step } })) and materializing again; inspect it anytime with context({ request: { action: 'describe', context_id: '${ctx.id}' } }).`,
      ],
    };
  },

  async _deleteSemanticModel(input) {
    this._validate('delete_context.semantic_model', input);
    const ctx = this._ctxToWrite(input.context_id);
    const modelKey = input.semantic_model;
    const add = ctx.state.additions[modelKey];
    if (!add) return { context_id: ctx.id, removed: false, reason: 'no task additions for this model' };
    const taskMeasureNames = new Set(add.measures.map((m) => m.name));
    const dependents = ctx.state.metrics.filter((m) => [...measureRefs(m, ctx.state.metrics)].some((mm) => taskMeasureNames.has(mm)));
    if (dependents.length && !input.cascade) {
      throw new ToolError(`metrics depend on this model's measures: ${dependents.map((d) => d.name).join(', ')}`, { stage: 'validate' });
    }
    ctx.state.metrics = ctx.state.metrics.filter((m) => !dependents.includes(m));
    delete ctx.state.additions[modelKey];
    const render = renderContext(this._catalogOf(ctx), ctx.state, { spec: this._semanticSpec() });
    this.ctxs.writeSemanticYaml(ctx.id, render);
    this.ctxs.touch(ctx.id);
    const parse = await this._parse(ctx.id);
    return { context_id: ctx.id, semantic_model: modelKey, removed: true, metrics: render.metricNames, parse };
  },
};
