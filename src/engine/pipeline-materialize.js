// MATERIALIZING A PIPELINE — the draft's steps rendered into a chain of dbt models (SQL, and a python
// model where a stage needs one, each passed through the static gate first), run, and registered as
// the context's pipeline; a failure is answered with what the warehouse said, in the caller's terms.
// Methods of the Engine (src/engine/helpers.js — mixin).

import { ToolError, RESULT_GONE } from '../validate.js';
import { formatDbtError, dbtFailure } from '../dbt/index.js';
import { compilePythonStage, importAllowlist, runAstGate, frameProfile, pythonRunHints } from '../python-model.js';
import { renderPipeline, sqlRunHints } from '../pipeline.js';
import { sqlConfigHeader } from '../sql-header.js';
import { samplingNote } from './helpers.js';

export const pipelineMaterializeMethods = {
  /**
   * The name the NEXT build of this pipeline takes. The counter lives on the CONTEXT, not on the
   * draft: a second draft of the same name in the same context would otherwise start over at the
   * bare name and rebuild the very table an earlier build — possibly one a fork inherited — still
   * stands for. Monotonic, so no name is ever reused.
   */
  _nextPipelineModel(ctx, name, { advance = false } = {}) {
    const seq = (ctx.state.builds || 0) + 1;
    if (advance) { ctx.state.builds = seq; }
    return `pipe_${name}_${ctx.id}${seq > 1 ? `_c${seq}` : ''}`;
  },

  /**
   * The chain a pipeline renders to, as the caller sees it: one entry per dbt model, in build
   * order, each with its input and — for a python model — the compiled code. `pipeline` is the
   * declaration the file headers record.
   */
  _chainModels(chain, pipeline) {
    return chain.map((seg) => (seg.kind === 'sql'
      ? { model: seg.model, kind: 'sql', input: seg.input, stages: seg.stages.map((st) => st.stage), sql: seg.sql, columns: [...seg.columns.keys()] }
      : (() => { const py = this._compilePythonStage(seg.stage, { modelName: seg.model, inputModel: seg.input, pipeline }); return { model: seg.model, kind: 'python', input: seg.input, runtime: py.runtime, packages: py.packages, steps: seg.stage.steps.map((st) => st.call), code: py.code, yml: py.yml, functions: py.functions, bindings: py.bindings, columns: [...seg.columns.keys()] }; })()));
  },

  /**
   * A dbt failure of a PYTHON model is the warehouse runtime's traceback, and the part that says
   * WHERE to look is one class name. Append what that class name is ABOUT on this runtime — a fact
   * about the runtime, not a diagnosis of the code: which line raised it is in the traceback, and
   * nothing here can know what the author meant. Best-effort: the original message is kept intact.
   */
  _pythonRunMessage(stdout, stderr) {
    const message = formatDbtError(stdout, stderr);
    try {
      // Match the RAW output, not `message`: formatDbtError slices from the first dbt marker and
      // truncates, and the runtime's traceback — where the class name is — can fall outside that.
      const raw = `${stderr || ''}\n${stdout || ''}`;
      const hints = [
        ...pythonRunHints(frameProfile(this.catalog.pythonRuntime || {}, this.pythonModelConfig || {}), raw),
        ...this._chainColumnHints(raw),
      ];
      return hints.length ? `${message}\n\n${hints.join('\n')}` : message;
    } catch { return message; }
  },

  /**
   * A CHAIN failure that is neither the runtime's nor the SQL's fault but the declaration's:
   * `output.columns` is a CLAIM about what the last step returns, and the stages after the python
   * model are rendered against it. When the frame returns something else, the failure surfaces as
   * an unknown column in the NEXT model — a message that reads like a typo in a stage.
   *
   * This is the chain's own fact (the engine owns the chain), so the hint lives here rather than in
   * a runtime profile: the same mismatch happens on every python runtime.
   */
  _chainColumnHints(text) {
    const log = String(text || '');
    if (!/unknown column|Unrecognized name|column .* does not exist|no such column|Invalid column/i.test(log)) return [];
    return ['If the failing column is one you declared in a python stage\'s `output.columns`, that declaration is what the SQL stages after it were rendered against — nothing projects the frame for you. The frame decides: make the last step return exactly those columns, or declare exactly what it returns. An estimator\'s output often has its OWN shape (a forecast, score(), PCA components), which is the case semantic_index({ request: { recipe: "bf_ml_output_replaces_frame" } }) works through; the response of a successful build reports the columns the table really has.'];
  },

  /**
   * The same for a SQL build: the warehouse's message, plus the hint when the failure is one whose
   * fix is a different pipeline shape (see sqlRunHints in src/pipeline.js).
   */
  _sqlRunMessage(stdout, stderr) {
    const message = formatDbtError(stdout, stderr);
    try {
      const hints = sqlRunHints(`${stderr || ''}\n${stdout || ''}`);
      return hints.length ? `${message}\n\n${hints.join('\n')}` : message;
    } catch { return message; }
  },

  /** Compile a python stage into its dbt model (structure only — the gate is separate). */
  _compilePythonStage(stage, { modelName, inputModel, pipeline }) {
    try {
      const profile = frameProfile(this.catalog.pythonRuntime, this.pythonModelConfig);
      return compilePythonStage(stage, { modelName, inputModel, allow: importAllowlist(this.catalog.pythonRuntime || process.env, profile), config: this.pythonModelConfig, ymlConfig: this._expiryConfig('python'), pipeline, profile, submission: this.catalog.pythonRuntime?.method || null });
    } catch (e) { throw new ToolError(e.message, { stage: 'validate', field: 'stage' }); }
  },

  /** The static gate over ONE python stage's function bodies (the incremental builder's path). */
  async _gatePythonStage(stage) {
    const compiled = this._compilePythonStage(stage, { modelName: 'm', inputModel: 'm_in', pipeline: null });
    await this._gateCompiled([compiled]);
    return compiled;
  },

  /**
   * The static gate over the bodies of ALREADY-COMPILED python models — every stage of a chain in
   * ONE interpreter run (the gate takes a list, and each function carries its own bindings, so the
   * stages are still checked separately). Re-compiling a stage just to gate it would only repeat
   * work the chain has done, and one interpreter start-up per stage is pure request latency.
   * It checks STRUCTURE only (imports in bodies, private/dunder access, names a body may read):
   * what a given line does on a particular warehouse runtime is the stage rules' business, not a
   * static refusal's — the runtime's own rules are in the stage description.
   */
  async _gateCompiled(units) {
    const functions = units.flatMap((u, i) => (u.functions || []).map((f) => ({ ...f, id: String(i), bindings: u.bindings || [] })));
    if (!functions.length) return;
    // Whether an unordered head()/tail() is fatal is a property of the RUNTIME (dbt's BigFrames
    // wrapper runs with ordering_mode="partial" and raises OrderRequiredError there), so the
    // profile decides and the gate enforces — the author hears it here, not from a traceback in
    // the warehouse's notebook runtime.
    const gate = await runAstGate(this.pythonBin, functions, []);
    if (gate.ok) return;
    const named = units.length > 1;
    const lines = gate.errors.map((e) => {
      const where = named && units[Number(e.id)]?.model ? `${units[Number(e.id)].model}: ` : '';
      return `${where}${e.function} line ${e.line}${e.text ? ` (${e.text})` : ''}: ${e.message}`;
    });
    throw new ToolError(`python stage: functions rejected by the static gate:\n${lines.join('\n')}`, { stage: 'validate', field: 'functions', details: gate.errors });
  },

  async _draftMaterialize(ctx, draft) {
    if (!draft.stages.length) throw new ToolError('draft has no stages to materialize — add_step at least one stage first', { stage: 'validate', field: 'draft_id' });
    if (draft.base && (!this.ctxs.has(draft.base.owner) || !this.ctxs.hasPipelineModel(ctx.id, draft.base.model))) {
      throw new ToolError(`the table this draft starts from (${draft.base.model}, task ${draft.base.task_id}) is gone — its context was dropped. Run that task again and start a new draft from it`, { stage: 'validate', field: 'draft_id', code: RESULT_GONE });
    }
    // A build of THIS draft already in flight is never started twice. A retried call is the same
    // pipeline, and a second run would write the same model files under the first one's feet.
    if (draft.building) {
      throw new ToolError(
        `a build of this draft is already in flight (started ${draft.building.started_at}) — it is the SAME pipeline, so a second run would build nothing new and would write over the first one. `
        + `${draft.building.task_id ? `Read it with query_pipeline_model({ request: { task_id: '${draft.building.task_id}' } })` : 'Read it with query_pipeline_model and the task_id its call returned'}; the result table is ${draft.building.model}.`,
        { stage: 'validate', field: 'draft_id' },
      );
    }
    // Build only what is NOT already a table: with a live checkpoint the run starts from it and
    // only the steps after it are rendered. Each build gets its own model name, so a rebuild never
    // overwrites the very table it is reading (nor one a fork inherited).
    const plan = this._renderPlan(draft, draft.stages, { forBuild: true });
    const retiredNow = this._applyCheckpointPlan(ctx, draft, plan);
    if (plan.checkpoint && !plan.stages.length) {
      throw new ToolError(`nothing to build: steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model} and there is no step after them — add_step first${plan.checkpoint.task_id ? `, or read that build with query_pipeline_model({ request: { task_id: '${plan.checkpoint.task_id}' } })` : ''}`, { stage: 'validate', field: 'draft_id' });
    }
    const modelName = this._nextPipelineModel(ctx, draft.name, { advance: true });
    // What this build computes, fixed now: the draft stays open and may grow while it runs.
    const stages = draft.stages.map((s) => JSON.parse(JSON.stringify(s)));
    // the in-flight marker goes up BEFORE anything awaits, so a second call made meanwhile is refused
    draft.building = { started_at: new Date().toISOString(), model: modelName, task_id: null };
    let columns;
    try {
      columns = this._draftColumns(draft, await this.probe.physicalColumns(draft.source));
    } catch (e) { delete draft.building; throw e; }
    const from = plan.from ? { at: plan.checkpoint ? plan.checkpoint.at : 0, model: plan.from.model, columns: plan.from.columns } : null;
    const taskId = this._startTask(ctx, 'build_pipeline_model', async (id) => {
      let result;
      try {
        result = await this._registerPipeline({
          name: draft.name, context_id: ctx.id, materialized: draft.materialized,
          ...(draft.description ? { description: draft.description } : {}), // the draft's note travels to the model it builds
          pipeline: { source: draft.source, time_range: draft.base ? undefined : (draft.time_range || undefined), stages },
          from_checkpoint: from,
          model_name: modelName,
        }, { taskId: id });
      } finally {
        if (draft.building?.task_id === id) delete draft.building;
      }
      if (!result || result.ok === false) {
        // a failed build is no prefix: the next materialize rebuilds it (the draft stays, to be fixed)
        const notThis = (cp) => cp.task_id !== id;
        draft.checkpoints = (draft.checkpoints || []).filter(notThis);
        if (ctx.state.pipeline_origin) ctx.state.pipeline_origin.checkpoints = (ctx.state.pipeline_origin.checkpoints || []).filter(notThis);
        this.ctxs.touch(ctx.id);
        return result;
      }
      const cp = (draft.checkpoints || []).find((c) => c.task_id === id);
      if (cp) cp.rows = result.row_count ?? null;
      if (plan.checkpoint) {
        result.from_checkpoint = { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at };
        result.steps_recomputed = plan.stages.length;
      }
      // Why a build started from further back than the caller may expect (a failed/lost build, a
      // refreshed value index) — said on the result, not left to be guessed from the timing.
      if (retiredNow.length) result.checkpoints_dropped = retiredNow;
      const carries = this._carriesSource(draft.source, columns);
      result.checkpoint = { at: stages.length, model: modelName, ...(carries ? { carries_source: carries } : {}) };
      // A VIEW is not a computed prefix: reading it re-runs its SQL, so continuing on top of one
      // saves nothing. Say it once, here, where the choice can still be changed.
      if (result.materialized === 'view') {
        (result.warnings ||= []).push(`${modelName} is a VIEW, so the steps you add next re-run its SQL instead of reading a computed prefix — nothing is saved. Start the draft with materialized:'table' when the point of materializing is to stop recomputing.`);
      }
      (result.assumptions ||= []).push(
        `The draft ${ctx.id} stays open and steps 1..${stages.length} are now the table ${modelName}: add_step continues ON TOP of it (that prefix is not recomputed), while editing a step at or before ${stages.length} retires it and the next materialize rebuilds from '${draft.source}'.`
        + (plan.checkpoint ? ` This build recomputed only ${plan.stages.length} step(s), reading ${plan.checkpoint.model} for the first ${plan.checkpoint.at}.` : ''),
      );
      return result;
    }, { input: { action: 'materialize', draft_id: ctx.id, name: draft.name, source: draft.source, ...(draft.time_range ? { time_range: draft.time_range } : {}), stages, ...(from ? { from_checkpoint: { at: from.at, model: from.model } } : {}) } });
    draft.building.task_id = taskId;
    this.jobs.setTable(taskId, modelName); // the table this task leaves behind (paged, drawn, started from)
    // The built table STANDS FOR the first `stages.length` steps from now on: record the checkpoint
    // at once and KEEP the draft open, so the next step reads that table instead of recomputing the
    // prefix. Until the build is done it is a checkpoint that is still building (see _checkpointState).
    const checkpoint = {
      at: stages.length, model: modelName, owner: ctx.id, columns,
      built_at: new Date().toISOString(), index_run_id: this._indexRunId(),
      rows: null, carries_source: this._carriesSource(draft.source, columns), task_id: taskId,
    };
    draft.checkpoints = [...draft.checkpoints.filter((cp) => cp.at < checkpoint.at), checkpoint];
    // Snapshot the built pipeline (with its checkpoints) so it can still be forked after a discard.
    ctx.state.pipeline_origin = { name: draft.name, source: draft.source, materialized: draft.materialized, time_range: draft.time_range || null, ...(draft.base ? { base: JSON.parse(JSON.stringify(draft.base)) } : {}), stages: stages.map((s) => JSON.parse(JSON.stringify(s))), checkpoints: draft.checkpoints.map((cp) => JSON.parse(JSON.stringify(cp))) };
    this.ctxs.touch(ctx.id);
    return this._taskStarted(taskId, { context_id: ctx.id, draft_id: ctx.id, model: modelName });
  },

  /**
   * Register (or rebuild) a general transformation PIPELINE as a dbt model.
   * The pipeline's rows ARE the result: we materialize, build, and read them back.
   * It runs INSIDE a task (_buildPipeline, or a draft's materialize): the build is waited
   * for here, and the caller reads the response with query_pipeline_model({ request: { task_id } }). A later pipeline re-slices
   * the table without recomputing it: build_pipeline_model({ request: { action: 'start', from_task } }).
   */
  async _registerPipeline(input, { ctxId: presetCtxId = null, taskId = null } = {}) {
    const dialect = this.catalog.dialect;
    const source = input.pipeline.source;
    // A pipeline-level time_range is applied as a leading WHERE on the source's time
    // column — one place to bound the window (parity with query_semantic_model).
    // Timezone-aware via _timeRangeConditions (boundaries are wall-clock in tr.timezone).
    let stages = input.pipeline.stages;
    const tr = input.pipeline.time_range;
    // A materialized prefix (checkpoint): the first `at` stages ARE the relation we start from, so
    // only the rest is rendered — and the window they were built under is already baked into it.
    const from = input.from_checkpoint || null;
    if (from) stages = stages.slice(from.at);
    else if (tr && (tr.start || tr.end)) {
      if (!this.catalog.getModel(source).time?.column) throw new ToolError(`time_range given but source '${source}' has no time column`, { stage: 'validate', field: 'time_range' });
      const conditions = this._timeRangeConditions(source, tr);
      if (conditions) stages = [{ stage: 'where', conditions }, ...stages];
    } else if (this.catalog.requireTimeRangeFor(source) && !this._stagesBoundInTime(source, stages)) {
      // Cost guardrail (catalog require_time_range): an unbounded pipeline over the fact
      // would scan the whole history — demand a window unless a stage already bounds it.
      throw new ToolError(
        `this catalog requires a bounded time window (require_time_range): pass pipeline.time_range { start, end } `
        + `or add a leading where on the time/partition column. Unbounded scans over '${this.catalog.getModel(source).dbt_model}' are blocked.`,
        { stage: 'validate', field: 'time_range' },
      );
    }
    // Render ONLY the active warehouse dialect — every response is in the dialect the
    // pipeline actually runs on, never a mix. Grounded to the physical relation so a
    // phantom catalog column is rejected as "unknown column" here, not as a raw
    // warehouse error after the build.
    const physSet = await this.probe.physicalColumns(source);
    // Sampling is a property of the WHOLE declaration, not of the slice this build renders: a
    // `sample` baked into the materialized prefix still makes every number downstream approximate,
    // and dropping the flag would hand back a 1%-sampled figure as if it were exact.
    const sampled = (input.pipeline.stages || []).find((st) => st.stage === 'sample') || null;
    // a declaration that does not render is REFUSED (the caller reads it from the task as a compile error)
    const render = (modelName) => {
      try { return renderPipeline(this.catalog, dialect, source, stages, { physicalCols: physSet, modelName, from: from ? { model: from.model, columns: from.columns } : null }); }
      catch (e) { throw e instanceof ToolError ? e : new ToolError(e?.message || String(e), { stage: 'compile' }); }
    };
    // A pipeline renders as a CHAIN of dbt models: SQL stages until a python stage, that stage as a
    // Python model reading the previous one (or the source), and so on; the last model carries
    // the pipeline's name and is the result. Every python stage's bodies pass the static gate
    // BEFORE anything else happens, so a refused declaration leaves nothing behind.
    if (input.dry_run) {
      const out = render(`pipe_${input.name}`);
      const built = this._chainModels(out.chain, input);
      await this._gateCompiled(built.filter((m) => m.kind === 'python'));
      const models = built.map(({ yml, functions, bindings, ...m }) => m);
      const last = out.chain[out.chain.length - 1];
      const resp = {
        kind: 'pipeline', dry_run: true, model: `pipe_${input.name}`, materialized: last.kind === 'python' ? 'table' : (input.materialized || 'table'), dialect,
        columns: [...out.columns.keys()],
        output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
        model_sql: out.sql,
        ...(models.length > 1 ? { models } : {}),
        ...(models.some((m) => m.kind === 'python') ? { python: models.filter((m) => m.kind === 'python') } : {}),
      };
      // The same per-stage judgements the incremental builder makes: a dry run is exactly where a
      // silently-wrong stage should be pointed out, BEFORE anything is built.
      const dryWarnings = this.advisor.stageWarnings(source, stages, { timeRange: input.pipeline?.time_range || null, startsFromTable: !!from });
      if (dryWarnings.length) resp.warnings = dryWarnings;
      // A5: cheap volume estimate — COUNT(*) over the SOURCE within the window only
      // (no full materialize). Lets the caller size the scan before materializing.
      const est = await this.probe.estimateSourceRows(source, tr);
      if (est != null) resp.estimated_source_rows = est;
      return resp;
    }
    // Everything that can refuse the declaration runs BEFORE a context exists, so a refused one
    // leaves nothing behind. The context id is CHOSEN first (a new one is not created yet), so the
    // chain is laid out ONCE, under its final names, and its python bodies are gated on that very
    // layout — one render, one compile per python stage.
    const existing = input.context_id ? this._ctxToWrite(input.context_id) : null;
    const ctxId = existing ? existing.id : (presetCtxId || this.ctxs.newId());
    // The caller may pass the name: every build of a draft gets its own (`_c2`, `_c3`, …), because
    // a rebuild must never overwrite the table it reads as its checkpoint, nor one a fork
    // inherited. The all-at-once path has no such history and uses the plain name.
    const modelName = input.model_name || `pipe_${input.name}_${ctxId}`;
    const out = render(modelName);
    const models = this._chainModels(out.chain, input);
    await this._gateCompiled(models.filter((m) => m.kind === 'python'));
    const ctx = existing || this.ctxs.create(ctxId);
    const last = models[models.length - 1];
    const hasPython = models.some((m) => m.kind === 'python');
    // The last model takes the requested materialization when it is SQL; a Python model, and every
    // model something else reads, is a table (a Python model reads a relation, a view would re-run
    // the SQL through the runtime).
    const materialized = last.kind === 'python' ? 'table' : (input.materialized || 'table');
    // The header records the WHOLE declaration; when this model only computes the tail, it also
    // says which built relation the earlier steps are, so the file is readable on its own.
    const header = sqlConfigHeader('pipeline_model', { name: input.name, ...(input.description ? { description: input.description } : {}), pipeline: input.pipeline, ...(from ? { continues: { model: from.model, after_step: from.at } } : {}) });
    // A rebuild under the same name must leave no stale model of the previous chain behind: dbt
    // allows one model per name, and a shorter chain would otherwise keep orphaned _sN files.
    this.ctxs.removePipelineFiles(ctx.id, modelName);
    for (const m of models) {
      if (m.kind === 'sql') this.ctxs.writeModel(ctx.id, m.model, `${this._modelConfigLine(m === last ? materialized : 'table', { pipeline: true })}\n${header}${m.sql}\n`);
      else { this.ctxs.writeFile(ctx.id, `${m.model}.py`, m.code); this.ctxs.writeFile(ctx.id, `${m.model}.yml`, m.yml); }
    }
    const pyInfo = hasPython ? models.filter((m) => m.kind === 'python').map(({ yml, functions, bindings, ...m }) => m) : null;
    const chainInfo = models.map((m) => ({ model: m.model, kind: m.kind, input: m.input, materialized: m === last ? materialized : 'table' }));
    ctx.state.engine = 'pipeline';
    ctx.state.model = modelName;
    if (taskId) this.jobs.setTable(taskId, modelName);
    ctx.state.pipeline_model = { model: modelName, materialized, kind: 'pipeline', ...(taskId ? { task_id: taskId } : {}), columns: [...out.columns.keys()], ...(input.description ? { description: input.description } : {}), ...(models.length > 1 ? { chain: chainInfo } : {}), ...(hasPython ? { python: pyInfo.map(({ code, ...m }) => m) } : {}) };
    if (!ctx.state.tasks?.includes(input.name)) (ctx.state.tasks ||= []).push(input.name);
    this.ctxs.touch(ctx.id);
    // `ok` as every step of a build says it (parse, run, show); `executed` says whether the model was
    // actually built and run, or only written to disk (no runner)
    let build = { ok: true, executed: false, reason: 'no runner configured — model written but not built/executed (dry/unit mode)' };
    let rows = []; let columns = [...out.columns.keys()];
    if (this.runner) {
      // Select the chain's OWN models by name (space = dbt's union operator), in ref order — never
      // `+model`, whose ancestor operator would also select the catalog's base tables and REBUILD
      // them. The call that started this build has returned already (it is a task), so a python
      // model's cold start of minutes holds nobody.
      const r = await this.runner.run(this.ctxs.dir(ctx.id), models.length > 1 ? models.map((m) => m.model).join(' ') : modelName);
      if (!r.ok) return { context_id: ctx.id, kind: 'pipeline', ok: false, error: { stage: 'run', message: hasPython ? this._pythonRunMessage(r.stdout, r.stderr) : this._sqlRunMessage(r.stdout, r.stderr) }, ...(models.length > 1 ? { models: chainInfo } : {}), ...(hasPython ? { python: pyInfo } : {}) };
      const show = await this.runner.show(this.ctxs.dir(ctx.id), `SELECT * FROM {{ ref('${modelName}') }}`, 200);
      if (show.ok) { rows = show.rows; columns = show.columns || columns; }
      else return { context_id: ctx.id, kind: 'pipeline', ...dbtFailure('show', show) };
      build = { ok: true, executed: true };
    }
    return {
      context_id: ctx.id, kind: 'pipeline', model: modelName, materialized, dialect,
      columns, output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
      row_count: rows.length, rows, model_sql: out.sql, build,
      ...(models.length > 1 ? { models: chainInfo } : {}),
      ...(hasPython ? { python: pyInfo } : {}),
      // Provenance: a custom pipeline (not a governed metric), its source, and how fresh
      // the underlying data is — so the rows are self-trustable. A sample stage makes the
      // result APPROXIMATE — flag it loudly with the safe/unsafe + how-to-get-exact note.
      provenance: { tier: 'pipeline', source, data_freshness: await this.probe.dataFreshness(source), ...(sampled ? { approximate: true } : {}) },
      ...(sampled ? { sampling: samplingNote(sampled.percent ?? 10) } : {}),
      assumptions: [
        ...(models.length > 1
          ? [`The pipeline built as a chain of ${models.length} dbt models (${chainInfo.map((m) => `${m.model} [${m.kind}]`).join(' → ')}); each python stage is a Python model run by dbt on the warehouse's Python runtime, never here, reading the previous model via dbt.ref. The last, ${modelName}, is the result.${input.materialized === 'view' && last.kind === 'python' ? ' materialized: view was requested, but a Python model is a TABLE.' : ''}`]
          : [`Pipeline materialized as a ${materialized} model (${modelName}); its rows are the result.`]),
        `To re-slice it without recomputing, start a pipeline FROM this build: build_pipeline_model({ request: { action: 'start', name, from_task: '<this task_id>' } }) — its steps read ${modelName}. Page its rows with query_pipeline_model({ request: { task_id, offset, limit } }), or filter / regroup them with query_pipeline_model({ request: { context_id, transform } }).`,
      ],
      warnings: [
        // The same per-stage judgements the incremental builder makes — a pipeline submitted all at
        // once (a recipe payload, a hand-written one) gets them too, or a silently-wrong join
        // reaches the caller as plausible numbers.
        ...this.advisor.stageWarnings(source, stages, { timeRange: input.pipeline?.time_range || null, startsFromTable: !!from }),
        ...((this.runner && rows.length === 0)
          ? [`0 rows — usually a scoping bug, not a real empty result: an over-narrow where, a property that is NULL on the events you kept, or${tr && (tr.start || tr.end) ? ' a time_range that misses the data (a date-only `end` is the whole day, next-day-exclusive)' : ' an event filter that matches nothing'}. Re-check the stages / widen the window.`]
          : []),
      ],
    };
  },
};
