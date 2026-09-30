// BUILD_SEMANTIC_MODEL — a declaration compiled into a semantic layer (src/compile.js → yaml-render),
// parsed by dbt in the context's own project, and updated or dropped; a native dbt model registered
// into a context. Methods of the Engine (src/engine/helpers.js — mixin).

import { ToolError } from '../validate.js';
import { compileDeclaration, measureRefs } from '../compile.js';
import { renderContext } from '../yaml-render.js';
import { mergeCompiled } from '../context-manager.js';
import { formatDbtError } from '../dbt/index.js';
import { clone, declaredAttribute } from './helpers.js';

export const semanticBuildMethods = {
  /** Compile, converting bad-reference errors into a clearly-staged ToolError. */
  _compile(input) {
    try {
      return compileDeclaration(this.catalog, input);
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
   * model is taken from the reference the caller wrote — the compiled path is not read back.
   */
  _checkModelLoaded(ctx, ref) {
    const model = ref?.model;
    if (!model || !this.catalog.models[model]) return; // metric_time, a bare token, or already refused
    if (ctx.state.usedModels?.includes(model)) return;
    throw new ToolError(
      `'${model}.${ref.attribute}' needs model '${model}', which is not loaded in this context. `
        + `Recreate/update the task with use_base_models including '${model}'.`,
      { stage: 'validate', field: 'model' },
    );
  },

  /**
   * Register a derived dbt model from a declarative PIPELINE (source + ordered
   * stages, optionally ending in a match_recognize funnel). The pipeline's rows
   * ARE the result. Funnels are just pipelines: match_recognize is a stage, and
   * downstream join/aggregate slice it by user attributes — no separate engine.
   */
  async register_native_model(input) {
    this._validate('register_native_model', input);
    // a build is a task: the id now, the rows from query_pipeline_model({ task_id })
    const existing = input.context_id ? this._ctxToWrite(input.context_id) : null;
    const ctxId = existing ? existing.id : this.ctxs.newId();
    const taskId = this._startTask(existing, 'register_native_model', (id) => this._registerPipeline(input, { ctxId, taskId: id }), { input });
    return this._taskStarted(taskId, { context_id: ctxId });
  },

  /** Delete a registered native model: remove its files + state and re-parse. */
  async delete_native_model(input) {
    this._validate('delete_native_model', input);
    const ctx = this._ctxToWrite(input.context_id);
    if (ctx.state.engine !== 'pipeline') return { context_id: ctx.id, removed: false, reason: 'no native (pipeline) model registered in this context' };
    const model = ctx.state.model;
    // a pipeline is a CHAIN of files (.sql / .py / .yml, plus `_sN` steps) — all of them go, and so
    // do the models of its earlier builds (`_cN`): the base name owns the whole family.
    const consumers = this._checkpointConsumers(ctx.id); // forks reading a table built here
    const removedFiles = this.ctxs.removePipelineFiles(ctx.id, model.replace(/_c\d+$/, ''));
    delete ctx.state.engine; delete ctx.state.model; delete ctx.state.native;
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
    return { context_id: ctx.id, removed: true, model, removed_files: removedFiles, ...(consumers.length ? { consumers_recomputing: consumers } : {}), parse: parse.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(parse.stdout, parse.stderr) } }, note: "model definition removed; the stored view may persist until the context is dropped (context({ action: 'drop' })) or the store cleans ephemeral objects" };
  },

  async build_semantic_model(input) {
    this._validate('build_semantic_model', input);
    // a context that is read as it is (the project's own semantic models) is refused in every mode —
    // an update, a dry run, a declaration — before anything reads it
    if (input.context_id && this.ctxs.has(input.context_id)) this._ctxToWrite(input.context_id);
    // Two modes, one tool: declaring a task from scratch, and adding to / removing from the task
    // already in a context. They share this schema (and therefore its vocabularies, which is the
    // whole reason they are one tool) but not their bodies.
    if (input.action === 'update') return this._updateSemanticModel(input);
    const compiled = this._compile(input);

    if (input.dry_run) {
      const draft = { tasks: [], additions: {}, metrics: [], usedModels: [] };
      if (input.context_id && this.ctxs.has(input.context_id)) {
        const cur = this._ctx(input.context_id).state;
        mergeCompiled(draft, { additions: clone(cur.additions), metrics: clone(cur.metrics), usedModels: [...cur.usedModels], task: null });
      }
      mergeCompiled(draft, compiled);
      const render = renderContext(this.catalog, draft, { spec: this._semanticSpec() });
      const out = { context_id: input.context_id || null, task: compiled.task, dry_run: true, yaml: render.yaml, semantic_models: render.semanticModels, metrics: render.metricNames, warnings: render.warnings || [] };
      return this._taskStarted(this._startTask(null, 'build_semantic_model', async () => out), input.context_id ? { context_id: input.context_id } : {});
    }

    // The declaration is taken IN THE CALL — compiled, merged, written — so a query issued right
    // after it validates against these metrics; parsing it (dbt) is the task, and a query on this
    // context waits for it (tasks on one context run in order).
    const ctx = input.context_id ? this._ctxToWrite(input.context_id) : this.ctxs.create();
    mergeCompiled(ctx.state, compiled);
    const render = renderContext(this.catalog, ctx.state, { spec: this._semanticSpec() });
    const file = this.ctxs.writeSemanticYaml(ctx.id, render);
    this.ctxs.touch(ctx.id);
    const taskId = this._startTask(ctx, 'build_semantic_model', () => this._declared(ctx, input, compiled, render, file), { input });
    return this._taskStarted(taskId, { context_id: ctx.id });
  },

  /** The finished answer of a declared task: parsed, with what it can be grouped by and the next call. */
  async _declared(ctx, input, compiled, render, file) {
    const parse = await this._parse(ctx.id);
    const { now: groupable, afterLoading } = this._groupableSplit(ctx);
    // the example must be a call that RUNS in this context, so it comes from what is loaded
    const exRef = groupable[0];
    const exText = exRef ? `{ model: '${exRef.model}', attribute: '${exRef.attribute}'${exRef.via ? `, via: '${exRef.via}'` : ''} }` : "{ time: 'metric_time', grain: 'day' }";
    return {
      context_id: ctx.id,
      task: compiled.task,
      files: [file],
      ...(input.include_yaml ? { yaml: render.yaml } : {}),
      semantic_models: render.semanticModels,
      joined_models: ctx.state.usedModels,
      metrics: render.metricNames,
      groupable,
      ...(afterLoading.length ? {
        groupable_after_loading: afterLoading,
        groupable_after_loading_note: `These attributes are reachable in the catalog but their model is not loaded in this context — add it with use_base_models: ['${afterLoading[0].model}'] (create/update) before naming them in group_by/where.`,
      } : {}),
      parse,
      assumptions: this._assumptions(ctx),
      warnings: render.warnings || [],
      // Never a dead end: name the exact next call with real metric/path names.
      next: `Query it: query_semantic_model({ context_id: '${ctx.id}', metrics: [${render.metricNames.slice(0, 3).map((m) => `'${m}'`).join(', ')}], time_range: { start, end }, group_by: [${exText}] }).`,
      recommendations: [
        `Bound every query with time_range. Group or filter by an attribute from \`groupable\`, addressed as { model, attribute } (e.g. ${exText}), or by { time: 'metric_time', grain }.`,
        `Extend this task later with update_semantic_model({ context_id: '${ctx.id}', ... }); inspect it anytime with context({ action: 'describe', context_id: '${ctx.id}' }).`,
      ],
    };
  },

  /**
   * The INCREMENTAL path on an existing task. It is reachable two ways and the body is one: as
   * build_semantic_model({ action: 'update', … }) — the mode the tool listing advertises — and as
   * update_semantic_model({ … }), kept callable for a client that learned that name, but no longer
   * advertised, because the two schemas repeat the same vocabulary and the listing is what every
   * request carries.
   */
  async update_semantic_model(input) {
    this._validate('update_semantic_model', input);
    return this._updateSemanticModel(input);
  },

  async _updateSemanticModel(input) {
    const ctx = this._ctxToWrite(input.context_id);
    const modelKey = input.semantic_model;
    // dry_run must NOT mutate the context (state or files): work on a clone.
    const state = input.dry_run ? clone(ctx.state) : ctx.state;
    const add = (state.additions[modelKey] ||= { measures: [], dimensions: [] });

    // synthesize a declaration fragment for the add_* parts and compile it
    const task = input.task || state.tasks[0] || 'task';
    const frag = { name: task, semantic_models: [{ from: modelKey, dimensions: input.add_dimensions || [], measures: input.add_measures || [] }], metrics: input.add_metrics || [] };
    const compiled = this._compile(frag);

    // removals (with dependency checks for measures)
    if (input.remove_metrics) state.metrics = state.metrics.filter((m) => !input.remove_metrics.includes(m.name));
    if (input.remove_measures) {
      for (const rm of input.remove_measures) {
        const dependents = state.metrics.filter((m) => measureRefs(m, state.metrics).has(rm));
        if (dependents.length && !input.cascade) {
          throw new ToolError(`cannot remove measure '${rm}'; metrics depend on it: ${dependents.map((d) => d.name).join(', ')}`, { stage: 'validate', field: rm });
        }
      }
      add.measures = add.measures.filter((m) => !input.remove_measures.includes(m.name));
    }
    if (input.remove_dimensions) {
      // A dimension is named by its ATTRIBUTE — the name `groupable` offers and `add_dimensions`
      // takes. What is STORED is the task-namespaced copy ('ret_country'), a name the caller is
      // never shown, so matching on it made every removal a silent no-op that still reported
      // success. Match on the attribute the dimension declares, and refuse a name that matches
      // nothing rather than pretending to have removed it.
      const tasks = state.tasks || [];
      const attrOf = (d) => declaredAttribute(d, tasks);
      for (const name of input.remove_dimensions) {
        if (!add.dimensions.some((d) => attrOf(d) === name || d.name === name)) {
          const have = [...new Set(add.dimensions.map(attrOf))];
          throw new ToolError(`cannot remove dimension '${name}': '${modelKey}' carries no such dimension in this context.${have.length ? ` It has: ${have.join(', ')}.` : ' It has none.'}`, { stage: 'validate', field: 'remove_dimensions' });
        }
      }
      add.dimensions = add.dimensions.filter((d) => !input.remove_dimensions.includes(attrOf(d)) && !input.remove_dimensions.includes(d.name));
    }

    mergeCompiled(state, compiled);
    const render = renderContext(this.catalog, state, { spec: this._semanticSpec() });
    if (input.dry_run) {
      const out = { context_id: ctx.id, semantic_model: modelKey, dry_run: true, yaml: render.yaml, metrics: render.metricNames, warnings: render.warnings || [] };
      return this._taskStarted(this._startTask(null, 'build_semantic_model', async () => out), { context_id: ctx.id });
    }
    const file = this.ctxs.writeSemanticYaml(ctx.id, render);
    this.ctxs.touch(ctx.id);
    const taskId = this._startTask(ctx, 'build_semantic_model', async () => {
      const parse = await this._parse(ctx.id);
      return {
        context_id: ctx.id, semantic_model: modelKey, files: [file], ...(input.include_yaml ? { yaml: render.yaml } : {}),
        metrics: render.metricNames, groupable: this._groupableSplit(ctx).now, parse, warnings: render.warnings || [],
        next: `Query the updated task: query_semantic_model({ context_id: '${ctx.id}', metrics: [...] }) — \`metrics\` above is the current full list.`,
      };
    }, { input });
    return this._taskStarted(taskId, { context_id: ctx.id });
  },

  async delete_semantic_model(input) {
    this._validate('delete_semantic_model', input);
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
    const render = renderContext(this.catalog, ctx.state, { spec: this._semanticSpec() });
    this.ctxs.writeSemanticYaml(ctx.id, render);
    this.ctxs.touch(ctx.id);
    const parse = await this._parse(ctx.id);
    return { context_id: ctx.id, semantic_model: modelKey, removed: true, metrics: render.metricNames, parse };
  },
};
