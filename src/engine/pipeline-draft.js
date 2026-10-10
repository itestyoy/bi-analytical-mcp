// BUILD_PIPELINE_MODEL, STEP BY STEP — the draft a pipeline is shaped in: start, add / edit / insert /
// delete a step, truncate, fork, preview; the checkpoints a materialize leaves and what an edit retires
// of them. Materializing it is src/engine/pipeline-materialize.js. Methods of the Engine
// (src/engine/helpers.js — mixin).

import { ToolError, RESULT_GONE } from '../validate.js';
import { renderPipeline, columnList } from '../pipeline.js';
import { operandsMisspelled } from '../pipeline/sql.js';
import { physicalColumnType } from '../catalog/column-types.js';

export const pipelineDraftMethods = {
  /**
   * Compose a pipeline INCREMENTALLY (single tool, `action`-driven). Each
   * add_steps validates each stage and returns the columns now available for the next
   * stage — pure schema propagation via renderPipeline, NO warehouse hit until materialize.
   * The all-at-once _buildPipeline path is unchanged. Lifecycle:
   * start → add_steps* → (preview) → materialize | discard.
   */
  async build_pipeline_model(input) {
    this._validate('build_pipeline_model', input);
    this._refuseOperandSpelling({ stages: input.stages, stage: input.stage });
    // start is the default action: a request without one is a start (its forms are the only ones that may omit it)
    if (input.action === undefined || input.action === 'start') return this._draftStart(input);
    if (input.action === 'fork') return this._draftFork(input); // branches a NEW draft (no live draft required)
    const ctx = this._ctx(input.context_id);
    const draft = ctx.state.draft;
    if (!draft) throw new ToolError(`no draft in context '${input.context_id}' — start one with build_pipeline_model({ request: { action: 'start', name, source } })`, { stage: 'validate', field: 'context_id' });
    this.ctxs.touch(ctx.id);
    if (input.action === 'add_steps') return this._draftThenBuild(ctx, draft, input, await this._draftAddSteps(ctx, draft, input.stages, input.include_columns, input.include_steps, { building: !!input.materialize }));
    if (input.action === 'edit_step') return this._draftEditStep(ctx, draft, input.index, input.stage, input.include_columns);
    if (input.action === 'insert_step') return this._draftInsertStep(ctx, draft, input.index, input.stage, input.include_columns);
    if (input.action === 'delete_step') return this._draftDeleteStep(ctx, draft, input.index, input.include_columns);
    if (input.action === 'truncate') return this._draftTruncate(ctx, draft, input.after, input.include_columns);
    if (input.action === 'preview') return input.validate ? this._draftValidate(ctx, draft) : this._draftPreview(ctx, draft);
    if (input.action === 'discard') { delete ctx.state.draft; return { context_id: ctx.id, action: 'discard', discarded: true }; }
    return this._draftMaterialize(ctx, draft); // materialize (the final build step)
  },

  /**
   * Adding steps — with add_steps, or the first ones with start — may build right after them
   * (materialize: true): one call where two would go one after the other. The steps are in the draft
   * by then, so a build that cannot start (one still running, a table gone) is answered beside them
   * under `materialize`, not as a refusal of the call that added them. A build that started is the
   * call's next step — reading it back — so nothing in the answer asks for a materialize again: a
   * second one would only be refused as the same pipeline.
   */
  async _draftThenBuild(ctx, draft, input, added) {
    if (!input.materialize) return added;
    try {
      const materialize = await this._draftMaterialize(ctx, draft);
      return {
        ...added,
        materialize,
        next: `The steps are added and their build is started (materialize.task_id): read it with ${this.tasks.readWith(materialize.task_id)} — it waits for the build and returns its rows.`,
      };
    } catch (e) {
      const stage = e instanceof ToolError ? (e.stage || 'validate') : 'internal';
      // the call succeeds, its build did not: kept in the error log as a refused call is
      this.errors?.record?.({ source: 'tool', tool: 'build_pipeline_model', stage, field: 'materialize', code: e.code, message: e.message, args: { request: input }, context_id: ctx.id });
      return {
        ...added,
        materialize: { ok: false, error: { stage, message: e.message, ...(e.code ? { code: e.code } : {}) } },
        next: `The steps are added; the build did not start (materialize.error says why). Materialize with build_pipeline_model({ request: { action: "materialize", context_id: "${ctx.id}" } }) once that is resolved.`,
      };
    }
  },

  /**
   * A new step's condition written with its column as left: { column }, or its constant as right:
   * { value }, is refused with the spelling this grammar has ({ column }, `value`) — the schema takes
   * either as an expression, and the carry-over of a step a draft kept from an earlier version would
   * otherwise accept it as that step.
   */
  _refuseOperandSpelling(value) {
    const [found] = operandsMisspelled(value);
    if (!found) return;
    const [path, told] = found;
    throw new ToolError(`invalid input: \`${path}\` ${told}`, { stage: 'validate', field: path });
  },

  /** Declared source columns GROUNDED to physical truth: { cols, phantom } where phantom
   *  lists declared-but-not-materialized names (empty when grounding is unavailable). */
  _groundedDeclared(source, physSet) {
    const declared = this.catalog.modelColumns(source);
    if (!physSet) return { cols: declared, phantom: [] };
    const cols = []; const phantom = [];
    for (const c of declared) (physSet.has(c.name.toLowerCase()) ? cols : phantom).push(c);
    return { cols, phantom: phantom.map((c) => c.name) };
  },

  // ---- CHECKPOINTS: a materialized prefix of the draft ---------------------------------------
  // `materialize` no longer ends the draft: the table it built STANDS FOR the first `at` stages, so
  // the steps added after it read that table instead of recomputing the prefix (an expensive
  // aggregate, a python model). Several materializations chain into several checkpoints.
  // The checkpoints live in the draft — the thing we own and edit — so invalidation is POSITIONAL
  // and needs no hashing: editing step i retires every checkpoint whose baked prefix contains i.
  // Freshness is not positional, so it rides on the value index's own run marker: a completed index
  // scan (whatever it found) means the underlying data may have moved, and every checkpoint taken
  // before it is retired.

  /**
   * The value index's current run marker — a checkpoint built under a different one is stale.
   * Cached on the index's own sync generation: reading the marker walks the run history, and the
   * render plan asks for it a few times per added stage. A completed scan bumps the generation, which
   * is exactly when the answer can change.
   */
  _indexRunId() {
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    if (this._runIdCache?.gen === gen) return this._runIdCache.id;
    let id = null;
    try { id = this.valueIndex?.syncStatus?.({ recent: 1 })?.last_successful_run?.id ?? null; }
    catch { id = null; } // no index / unreadable status → nothing to compare against
    this._runIdCache = { gen, id };
    return id;
  },

  /** null when the checkpoint is usable, { retire: why } when it never will be, { building } while its build runs. */
  _checkpointState(cp) {
    if (!this.ctxs.has(cp.owner)) return { retire: `the context that built ${cp.model} (${cp.owner}) is gone` };
    if (cp.task_id) {
      const job = this.jobs.get(cp.task_id);
      if (!job) return { retire: `the build of ${cp.model} left no task record` };
      if (job.status === 'error') return { retire: `the build of ${cp.model} failed` };
      // Still 'running', but only THIS process drives a build: a task inherited from the store is
      // one whose builder is gone, so waiting on it forever is wrong — retire it and rebuild.
      if (job.status !== 'ready') return this.jobs.isLive?.(cp.task_id) ? { building: cp.task_id } : { retire: `the build of ${cp.model} did not finish (its builder is gone)` };
    }
    // (checked after a build in flight: its model files are written once the task gets to them)
    if (!this.ctxs.hasPipelineModel(cp.owner, cp.model)) return { retire: `the model ${cp.model} no longer exists` };
    // A checkpoint built while the index had never completed a scan carries no marker: there is
    // nothing to compare, and the first scan finishing is not evidence that the data moved (it
    // observed the same data the prefix was built from). Only a marker that CHANGED retires it.
    const run = this._indexRunId();
    if (cp.index_run_id != null && cp.index_run_id !== run) return { retire: `the value index was refreshed after ${cp.model} was built, so the source data may have moved` };
    return null;
  },

  /**
   * The last checkpoint of `list` that can still be read from, with the stale ones retired.
   * A checkpoint whose build is still running carries valid COLUMNS (so the draft keeps growing),
   * but nothing can read its table yet — forBuild refuses instead of silently recomputing.
   */
  _useCheckpoint(list = [], { forBuild = false } = {}) {
    const retired = []; let checkpoint = null;
    for (let i = list.length - 1; i >= 0 && !checkpoint; i -= 1) {
      const st = this._checkpointState(list[i]);
      if (st?.retire) { retired.push({ ...list[i], reason: st.retire }); continue; }
      if (st?.building && forBuild) {
        throw new ToolError(
          `steps 1..${list[i].at} are still being materialized as ${list[i].model} — nothing can read that table yet, so a second build would only duplicate the work. `
          + `Wait for it with query_pipeline_model({ request: { task_ids: ['${st.building}'] } }) and materialize again once it is done; if that build is gone for good (the server restarted), retire it with truncate/edit_step at or before step ${list[i].at} — or delete_context({ request: { what: 'pipeline_model' } }) — and materialize again.`,
          { stage: 'validate', field: 'context_id' },
        );
      }
      checkpoint = list[i];
    }
    const gone = new Set(retired.map((r) => r.model));
    return { checkpoint, retired, surviving: list.filter((cp) => !gone.has(cp.model)) };
  },

  /**
   * How the draft renders RIGHT NOW: from the catalog source, or from the last live checkpoint.
   * `dropFrom` retires the checkpoints an edit at that step invalidates BEFORE choosing (they are
   * only written back to the draft once the edit validates). `stepOf` maps a position in the
   * rendered stage list back to the draft's own step numbering, so an error still names the step
   * the caller sees.
   */
  _renderPlan(draft, stages = draft.stages, { dropFrom = null, forBuild = false } = {}) {
    const all = draft.checkpoints || [];
    const dropped = dropFrom == null ? [] : all.filter((cp) => cp.at >= dropFrom);
    const kept = dropped.length ? all.filter((cp) => !dropped.includes(cp)) : all;
    const { checkpoint, retired, surviving } = this._useCheckpoint(kept, { forBuild });
    if (checkpoint) this.ctxs.touch(checkpoint.owner); // a checkpoint in use keeps its owner alive
    if (!checkpoint) {
      const effective = this._draftEffectiveStages({ ...draft, stages });
      const offset = effective.length - stages.length;
      // a draft started FROM A TASK reads that task's table as its step 0
      const from = draft.base ? { model: draft.base.model, columns: draft.base.columns } : null;
      return { from, checkpoint: null, stages: effective, dropped, retired, checkpoints: surviving, stepOf: (i) => i - offset };
    }
    return {
      from: { model: checkpoint.model, columns: checkpoint.columns },
      checkpoint, stages: stages.slice(checkpoint.at), dropped, retired, checkpoints: surviving,
      stepOf: (i) => checkpoint.at + i,
    };
  },

  /**
   * Whether a built relation still carries the SOURCE's own identifying columns (event name, time
   * axis, payload). It decides nothing by itself — every stage validates the columns it reads —
   * but it is what makes "can I still run a funnel on this?" answerable from the checkpoint alone.
   */
  _carriesSource(source, columns) {
    const m = this.catalog.getModel(source);
    const need = [m.event_name?.column, m.time?.column, m.event_data_column].filter(Boolean);
    if (!need.length) return null;
    const have = new Set(columns.map((c) => c.name));
    return need.every((n) => have.has(n)) ? source : null;
  },

  /** Delete the files of checkpoints this context owns and nobody else reads (a fork may). */
  _retireCheckpointFiles(ctx, checkpoints = []) {
    for (const cp of checkpoints) {
      if (cp.owner !== ctx.id) continue; // another context's model: not ours to remove
      // The context's REGISTERED result keeps its definition even when the prefix it stood for is
      // retired: `ctx.state.model` still advertises that table and query_pipeline_model reads it
      // through `{{ ref() }}`, which needs the file. A later build of the same name cleans it.
      if (cp.model === ctx.state.model) continue;
      // Nor one whose build is STILL RUNNING here: the task will hand its table back through
      // query_pipeline_model, which reads it by ref — removing the definition mid-build would make the
      // result unreadable for good.
      if (cp.task_id && this.jobs.isLive?.(cp.task_id) && this.jobs.get(cp.task_id)?.status === 'running') continue;
      if ((ctx.state.checkpoint_consumers?.[cp.model] || []).some((id) => this.ctxs.has(id))) continue;
      // Nor one a model of this very context still reads (an earlier build that continued from it —
      // the registered result, say): removing it would leave that model with a ref nothing defines,
      // and dbt compiles every model of the project before it runs any.
      if (this.ctxs.readersOf(ctx.id, cp.model).length) continue;
      this.ctxs.removePipelineModelFiles(ctx.id, cp.model); // this model only: later builds share its base name

    }
  },

  /**
   * Accept a render plan's verdict on the draft's checkpoints — the ONE place that happens, so
   * every path (an edit, a preview, a build) retires the same things, removes the same files and
   * reports the same list. `reason` describes the positional drop; the stale ones carry their own.
   */
  _applyCheckpointPlan(ctx, draft, plan, reason = null) {
    draft.checkpoints = plan.checkpoints;
    this._retireCheckpointFiles(ctx, [...plan.dropped, ...plan.retired]);
    return [
      ...plan.dropped.map((cp) => ({ at: cp.at, model: cp.model, reason })),
      ...plan.retired.map((cp) => ({ at: cp.at, model: cp.model, reason: cp.reason })),
    ];
  },

  /** Columns available after a draft's accumulated stages (source columns when empty),
   *  grounded to the physical relation (phantom catalog columns excluded). `stored`: the list a
   *  checkpoint keeps, with each column's `physical` mark (columnList) — not what an answer shows. */
  _draftColumns(draft, physSet, { stored = false } = {}) {
    if (!draft.stages.length) return draft.base ? draft.base.columns.map((c) => (stored ? { ...c } : { name: c.name, type: c.type })) : this._groundedDeclared(draft.source, physSet).cols;
    const { columns } = this._draftRender(draft, physSet);
    return stored ? columnList(columns) : [...columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }));
  },

  /** The draft's steps rendered as its build renders them now — from the last live checkpoint, else from
   *  where the draft starts (renderPipeline's { columns, current, … }). */
  _draftRender(draft, physSet) {
    const plan = this._renderPlan(draft);
    try {
      return renderPipeline(this.catalog, this.catalog.dialect, draft.source, plan.stages, { physicalCols: physSet, from: plan.from });
    } catch (e) {
      // the steps the draft HOLDS no longer build (written before a rule changed): refused as an added
      // step is — at compile, naming the step — with how to mend it
      const at = this._failingStepIndex(draft.source, plan.stages, physSet, plan.from);
      const step = at != null ? plan.stepOf(at) : null;
      throw new ToolError(`${step ? `step ${step}: ` : ''}${e.message} — a step this draft already holds; fix it with edit_step${step ? ` (index: ${step})` : ''}`, { stage: 'compile', field: 'stages' });
    }
  },

  /**
   * A task's table as a draft's step 0, its columns in the type the WAREHOUSE gives them (`physical`),
   * as a catalog source's are: a constant is compared with a column of that table as it is stored — a
   * flag stored as text stays text. The table's own relation is asked, whichever tool built it (a
   * pipeline, a query run with materialize: true) and whether or not a checkpoint still records it;
   * where the warehouse cannot be asked, the marks the build's checkpoint recorded stand, and past
   * them the types the task stored. A JSON or array column keeps its type, as a source's does.
   */
  async _baseWithPhysical(base) {
    const phys = await this.probe.tableColumns(base);
    const owner = this.ctxs.has(base.owner) ? this.ctxs.get(base.owner).state : null;
    const cp = [...(owner?.draft?.checkpoints || []), ...(owner?.pipeline_origin?.checkpoints || [])].find((c) => c.task_id === base.task_id);
    const marked = new Map((cp?.columns || []).filter((c) => c.physical).map((c) => [c.name, c.type]));
    if (!phys?.types?.size && !marked.size) return base;
    return {
      ...base,
      columns: base.columns.map((c) => {
        const dtype = c.type === 'json' || c.type === 'array' ? null : phys?.types?.get(c.name.toLowerCase());
        const type = dtype ? physicalColumnType(dtype) : 'unknown';
        if (type !== 'unknown') return { ...c, type, physical: true };
        return marked.get(c.name) === c.type ? { ...c, physical: true } : c;
      }),
    };
  },

  /** True when some pipeline stage already bounds the source's time/partition column. */
  _stagesBoundInTime(source, stages = []) {
    const m = this.catalog.getModel(source);
    const bounds = new Set([m.time?.column, m.partition_column].filter(Boolean));
    if (!bounds.size) return true; // no time axis — nothing to bound
    return stages.some((s) => s.stage === 'where' && (s.conditions || []).some((c) => bounds.has(c.column)));
  },

  /** Accumulated stages with the draft's time_range prepended as a leading WHERE (parity with materialize). */
  _draftEffectiveStages(draft) {
    if (draft.base) return draft.stages; // a task's table was computed under its own window already
    const conditions = this._timeRangeConditions(draft.source, draft.time_range);
    return conditions ? [{ stage: 'where', conditions }, ...draft.stages] : draft.stages;
  },

  /** The draft's steps as an answer shows them: each as its build renders it (_draftSpelling), so a step
   *  copied into edit_step is the step that was built (one kept from an earlier version is shown in this
   *  version's spelling, src/pipeline/earlier.js). `physSet`: the grounding the build renders with. */
  _draftSteps(draft, physSet = null) {
    if (!draft.stages.length) return [];
    const current = this._draftSpelling(draft, physSet);
    return draft.stages.map((s, i) => ({ index: i + 1, ...(current.get(s) ?? s) }));
  },

  /**
   * Each step of the draft (by identity) in the spelling its build renders it in — the render's own
   * (renderPipeline's `current`), from where the draft starts: the steps a checkpoint stands for were
   * rendered by its build, as these are. A step the render does not reach (the first that no longer
   * builds, and those after it) has none: it is shown as stored.
   */
  _draftSpelling(draft, physSet = null) {
    const stages = this._draftEffectiveStages(draft);
    const from = draft.base ? { model: draft.base.model, columns: draft.base.columns } : null;
    const spell = (list) => renderPipeline(this.catalog, this.catalog.dialect, draft.source, list, { physicalCols: physSet, from }).current;
    try { return spell(stages); } catch { /* the steps before the first that no longer builds, below */ }
    const at = this._failingStepIndex(draft.source, stages, physSet, from);
    try { return at > 1 ? spell(stages.slice(0, at - 1)) : new Map(); } catch { return new Map(); }
  },

  async _draftStart(input) {
    // materialize builds the steps the call adds: a start that adds none would build nothing
    if (input.materialize && !input.stages?.length) throw new ToolError('materialize: true builds the steps this start adds — give them in `stages`, or materialize later with build_pipeline_model({ request: { action: "materialize", context_id } })', { stage: 'validate', field: 'materialize' });
    const found = input.from_task ? this._taskBase(input) : null;
    if (input.context_id) this._ctxToWrite(input.context_id); // refused before the warehouse is asked
    const base = found ? await this._baseWithPhysical(found.base) : null;
    const ctx = input.context_id ? this._ctxToWrite(input.context_id) : this.ctxs.create();
    const source = found ? found.source : input.source;
    ctx.state.draft = { name: input.name, source, materialized: input.materialized || 'table', time_range: base ? null : (input.time_range || null), stages: [], checkpoints: [], ...(base ? { base } : {}), ...(input.description ? { description: input.description } : {}) };
    if (base) this._holdTaskBase(ctx, base);
    this.ctxs.touch(ctx.id);
    // The referenceable columns are SILENTLY grounded to the physical relation: a column
    // the catalog declares but the table lacks simply does not appear (a clean internal
    // guard) — never offered, never buildable, not called out. Only real columns exist.
    const physSet = await this.probe.grounding(source);
    const cols = base ? base.columns.map((c) => ({ name: c.name, type: c.type })) : this._groundedDeclared(source, physSet).cols;
    const buildHint = `When the steps look right, materialize with build_pipeline_model({ request: { action: "materialize", context_id: "${ctx.id}" } }).`;
    const resp = {
      context_id: ctx.id, action: 'start', name: input.name, source, materialized: ctx.state.draft.materialized,
      ...(base ? { from_task: base.task_id, reads: base.model } : {}),
      ...(ctx.state.draft.description ? { description: ctx.state.draft.description } : {}),
      steps: [], column_count: cols.length,
      next: `Append stages with build_pipeline_model({ request: { action: "add_steps", context_id: "${ctx.id}", stages: [...] } }) — a logical chunk at a time; each response shows what each stage added or removed (include_columns:true or preview for the full list).`,
      recommendations: [
        base
          ? `The table of task ${base.task_id} (${base.model}) has ${cols.length} columns your first stage can reference (include_columns:true lists them); nothing before it is recomputed.`
          : `The source has ${cols.length} columns your first stage can reference; get the full list with build_pipeline_model({ request: { action: "start", ..., include_columns: true } }) or inspect via semantic_index({ request: { source: '${source}' } }).`,
        `For an ordered funnel/path, add a match_recognize stage; for a plain transform, start with where/compute then aggregate.`,
        buildHint,
      ],
    };
    if (input.include_columns) resp.available_columns = cols;
    if (!input.stages?.length) return resp;
    // a draft may start with its first chunk of steps — start + add_steps in one call, and with
    // materialize: true the build after them too
    let added;
    try {
      added = await this._draftAddSteps(ctx, ctx.state.draft, input.stages, input.include_columns, input.include_steps, { building: !!input.materialize });
    } catch (e) {
      throw new ToolError(`${e.message} — the draft ${ctx.id} is started, with no steps: add them with add_steps (context_id: "${ctx.id}")`, { stage: e.stage || 'compile', field: e.field || 'stages', code: e.code });
    }
    const { context_id: _id, action: _a, ...rest } = added;
    // the steps are what add_steps says they are (steps_added + steps_count, or steps with include_steps);
    // the start's own hints are for a draft with no steps, so with steps added only the one to build them
    // is still said — and not when this call builds them itself (its `next` says what comes after)
    const { steps: _none, recommendations: _hints, ...head } = resp;
    return this._draftThenBuild(ctx, ctx.state.draft, input, { ...head, ...rest, next: added.next || resp.next, ...(input.materialize ? {} : { recommendations: [buildHint] }) });
  },

  /**
   * Append stages — one or several — in one call, applied SEQUENTIALLY. The response folds the per-step
   * effects together — for each stage, how it changed the columns (added / removed count) and any
   * warnings — so you see the same "how each application affected the data" detail as adding them
   * one at a time, in a single reply. ATOMIC: if any stage fails validation the whole batch is
   * rolled back (nothing applied) and the failing step is named. One stage is a list of one: there
   * is no second action for it. `building`: the same call goes on to build them (materialize: true),
   * so a step is not told to materialize when done.
   */
  async _draftAddSteps(ctx, draft, stages, includeColumns = false, includeSteps = false, { building = false } = {}) {
    if (!Array.isArray(stages) || !stages.length) throw new ToolError('add_steps needs a non-empty `stages` array', { stage: 'validate', field: 'stages' });
    const snapshot = draft.stages.slice(); // atomic: restore on any failure so the draft is never half-applied
    const effects = [];
    let last = null; const dropped = [];
    try {
      for (const [i, stage] of stages.entries()) {
        let r;
        // named by its place in `stages`, one stage or several (`stage` is edit_step's field, not this one's)
        try { r = await this._draftCommit(ctx, draft, [...draft.stages, stage], { changedStage: stage, includeColumns: false, includeSteps: true, action: 'add_steps', building }); }
        catch (e) { throw new ToolError(`stages[${i}]: ${e.message}`, { stage: e.stage || 'compile', field: `stages[${i}]`, code: e.code }); }
        last = r; if (r.checkpoints_dropped) dropped.push(...r.checkpoints_dropped);
        effects.push({
          step_index: r.step_index,
          stage: stage.stage,
          column_count: r.column_count,
          columns_added: r.columns_added,
          columns_removed_count: r.columns_removed_count,
          ...(r.columns_removed ? { columns_removed: r.columns_removed } : {}),
          ...(r.recommendations.length ? { recommendations: r.recommendations } : {}), // per-step warnings/nudges (filter guard, empty-combination, funnel, etc.)
        });
      }
    } catch (e) {
      draft.stages = snapshot; this.ctxs.touch(ctx.id);
      if (stages.length === 1) throw e;
      throw new ToolError(`${e.message} — none of the ${stages.length} stages was added (fix that one and send them again)`, { stage: e.stage || 'compile', field: e.field || 'stages', code: e.code });
    }
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const after = this._draftColumns(draft, physSet);
    // the steps just added — the caller has the earlier ones; the whole list with include_steps or preview
    const all = this._draftSteps(draft, physSet);
    const resp = {
      context_id: ctx.id, action: 'add_steps', added: effects.length,
      ...(includeSteps ? { steps: all } : { steps_added: all.slice(-effects.length), steps_count: all.length }),
      // what EACH stage did to the data, in order: read it top to bottom to see where it narrowed or widened
      step_effects: effects,
      column_count: after.length,
      ...(last.from_checkpoint ? { from_checkpoint: last.from_checkpoint, steps_recomputed: last.steps_recomputed } : {}),
      ...(dropped.length ? { checkpoints_dropped: dropped } : {}),
      next: 'Check step_effects (each stage\'s column changes and recommendations), then add the next logical chunk, fix a step (edit_step / insert_step / delete_step / truncate), or materialize. include_columns: true or preview gives the full column list.',
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  },

  /** Validate `index` (1-based) against the current stage count for an edit op. */
  _stepIndex(draft, index, action) {
    if (!Number.isInteger(index) || index < 1 || index > draft.stages.length) {
      throw new ToolError(`${action} index=${index} out of range — the draft has ${draft.stages.length} step(s); use 1..${draft.stages.length} (see steps[].index)`, { stage: 'validate', field: 'index' });
    }
    return index;
  },

  /** Replace step N in place (then revalidate the whole pipeline end-to-end). */
  async _draftEditStep(ctx, draft, index, stage, includeColumns = false) {
    const i = this._stepIndex(draft, index, 'edit_step');
    const next = draft.stages.slice(); next[i - 1] = stage;
    return this._draftCommit(ctx, draft, next, { changedStage: stage, includeColumns, action: 'edit_step', stepIndex: i, dropFrom: i });
  },

  /** Insert a step BEFORE position N (1-based; N = count+1 appends). */
  async _draftInsertStep(ctx, draft, index, stage, includeColumns = false) {
    if (!Number.isInteger(index) || index < 1 || index > draft.stages.length + 1) {
      throw new ToolError(`insert_step index=${index} out of range — use 1..${draft.stages.length + 1} (insert before that step; ${draft.stages.length + 1} appends)`, { stage: 'validate', field: 'index' });
    }
    const next = draft.stages.slice(); next.splice(index - 1, 0, stage);
    return this._draftCommit(ctx, draft, next, { changedStage: stage, includeColumns, action: 'insert_step', stepIndex: index, dropFrom: index });
  },

  /** Delete step N (then revalidate the remaining downstream steps). */
  async _draftDeleteStep(ctx, draft, index, includeColumns = false) {
    const i = this._stepIndex(draft, index, 'delete_step');
    const next = draft.stages.slice(); next.splice(i - 1, 1);
    return this._draftCommit(ctx, draft, next, { changedStage: null, includeColumns, action: 'delete_step', stepIndex: Math.min(i, next.length), dropFrom: i });
  },

  /** Drop every step after position N — the cheap "go back to step N" (after=0 empties the draft). */
  async _draftTruncate(ctx, draft, after, includeColumns = false) {
    if (!Number.isInteger(after) || after < 0 || after > draft.stages.length) {
      throw new ToolError(`truncate after=${after} out of range — the draft has ${draft.stages.length} step(s); use 0..${draft.stages.length}`, { stage: 'validate', field: 'after' });
    }
    return this._draftCommit(ctx, draft, draft.stages.slice(0, after), { changedStage: null, includeColumns, action: 'truncate', stepIndex: after, dropFrom: after + 1 });
  },

  /**
   * Branch a NEW draft from an existing draft (or an already-materialized pipeline) keeping
   * steps 1..after — so you iterate on a variant WITHOUT re-typing the shared prefix and
   * WITHOUT touching the original. after omitted → copy every step.
   */
  async _draftFork(input) {
    const src = this._ctx(input.context_id);
    const origin = src.state.draft || src.state.pipeline_origin; // live draft, or the snapshot a materialize left behind
    if (!origin) throw new ToolError(`context '${input.context_id}' has no draft or built pipeline to fork — start one, or fork a context whose pipeline was materialized`, { stage: 'validate', field: 'context_id' });
    const total = origin.stages.length;
    const after = input.after == null ? total : input.after;
    if (!Number.isInteger(after) || after < 0 || after > total) throw new ToolError(`fork after=${input.after} out of range — the source has ${total} step(s); use 0..${total}`, { stage: 'validate', field: 'after' });
    const ctx = this.ctxs.create();
    const name = input.name || origin.name;
    // Deep-copy the kept stages so editing the fork can never mutate the source's stages.
    const description = input.description || origin.description;
    ctx.state.draft = { name, source: origin.source, materialized: origin.materialized || 'table', time_range: origin.time_range || null, stages: origin.stages.slice(0, after).map((s) => JSON.parse(JSON.stringify(s))), checkpoints: [], ...(origin.base ? { base: JSON.parse(JSON.stringify(origin.base)) } : {}), ...(description ? { description } : {}) };
    // a draft started from a task's table: the fork reads the same table as its step 0
    if (origin.base) {
      if (!this.ctxs.has(origin.base.owner) || !this.ctxs.hasPipelineModel(origin.base.owner, origin.base.model)) throw new ToolError(`the table this draft starts from (${origin.base.model}, task ${origin.base.task_id}) is gone — start a new draft from a task that still exists`, { stage: 'validate', field: 'context_id', code: RESULT_GONE });
      this._holdTaskBase(ctx, ctx.state.draft.base);
    }
    // A materialized prefix the fork KEEPS (at <= after) is inherited: the fork reads the SAME
    // table, so branching a variant on top of an expensive prefix costs only the new steps. The
    // owner's model definition is copied into this overlay so `{{ ref() }}` resolves here (a
    // context is a copy of the BASE project, so it has none of its parent's generated models);
    // nothing rebuilds it — every build selects its own models by name.
    const inherited = [];
    for (const cp of (origin.checkpoints || []).filter((c) => c.at <= after)) {
      const owner = cp.owner;
      if (!this.ctxs.has(owner) || !this.ctxs.hasPipelineModel(owner, cp.model)) continue; // gone → nothing to inherit
      this.ctxs.copyPipelineFiles(owner, ctx.id, cp.model);
      ctx.state.draft.checkpoints.push(JSON.parse(JSON.stringify(cp)));
      // Reference count on the OWNER: dropping it would take the table this fork reads with it.
      const ownerState = this.ctxs.get(owner).state;
      const consumers = ((ownerState.checkpoint_consumers ||= {})[cp.model] ||= []);
      if (!consumers.includes(ctx.id)) consumers.push(ctx.id);
      this.ctxs.touch(owner);
      inherited.push({ at: cp.at, model: cp.model, owner });
    }
    this.ctxs.touch(ctx.id);
    const physSet = await this.probe.grounding(ctx.state.draft.source, ctx.state.draft.stages);
    // a fork of steps that no longer build is made all the same — the fork is where they are mended
    let cols = []; let broken = null;
    try { cols = this._draftColumns(ctx.state.draft, physSet); } catch (e) { broken = e.message; }
    const resp = {
      context_id: ctx.id, action: 'fork', forked_from: input.context_id, name, source: ctx.state.draft.source,
      materialized: ctx.state.draft.materialized, copied_steps: after, step_index: after,
      steps: this._draftSteps(ctx.state.draft, physSet), column_count: cols.length,
      ...(inherited.length ? { inherited_checkpoints: inherited } : {}),
      next: 'Continue editing this NEW draft (add_steps / edit_step / insert_step / delete_step / truncate); the original is untouched. Materialize when done.',
      recommendations: [
        `Forked ${after} of ${total} step(s) into a new draft ${ctx.id}; the source ${input.context_id} is unchanged — branch variants freely.`,
        ...(broken ? [`The copied steps do not build as they are: ${broken}`] : []),
        ...(inherited.length ? [`Steps 1..${inherited[inherited.length - 1].at} are already materialized (${inherited[inherited.length - 1].model}, built in ${inherited[inherited.length - 1].owner}) and this fork READS that table: only the steps you add here are computed. Keep that context alive while this fork uses it — delete_context on it is refused unless forced.`] : []),
        `Materialize with build_pipeline_model({ request: { action: "materialize", context_id: "${ctx.id}" } }).`,
      ],
    };
    if (input.include_columns) resp.available_columns = cols;
    return resp;
  },

  /** Index (1-based) of the first step in `stages` that fails to render — for a pinpointed error. */
  _failingStepIndex(source, stages, physSet, from = null) {
    for (let i = 1; i <= stages.length; i += 1) {
      try { renderPipeline(this.catalog, this.catalog.dialect, source, stages.slice(0, i), { physicalCols: physSet, from }); }
      catch { return i; }
    }
    return null;
  },

  /**
   * Validate `newStages` as a whole and, on success, replace the draft's stages — returning
   * the per-step diff (columns added/removed). Powers add_steps AND the edit ops (edit/insert/
   * delete/truncate): every edit revalidates the ENTIRE downstream, so a change that breaks a
   * later step is reported with that step's index and the draft is left intact to fix. The
   * `changedStage` (the added/edited stage; null for delete/truncate) drives the filter/scope/
   * funnel warnings.
   */
  async _draftCommit(ctx, draft, newStages, { changedStage = null, includeColumns = false, includeSteps = false, action = 'add_steps', stepIndex = null, dropFrom = null, building = false } = {}) {
    const physSet = await this.probe.grounding(draft.source, [...draft.stages, ...newStages]);
    // columns BEFORE the change — none known when the steps held no longer build: the change is what
    // mends them, and the render below validates the whole of it
    let before;
    try { before = this._draftColumns(draft, physSet); } catch { before = []; }
    // Validate what will actually be built: from the last live checkpoint when there is one (the
    // steps it baked are a TABLE now, not stages to re-validate), else from the source with the
    // draft's time_range as the leading where materialize will add. An edit at step i first
    // retires the checkpoints that baked it — but only the draft's acceptance writes that back.
    const plan = this._renderPlan(draft, newStages, { dropFrom });
    let rendered = null;
    try {
      // This render IS the validation and it returns the resulting columns, so the "after" state
      // below reads them from here instead of rendering the same stages a second time.
      if (newStages.length) rendered = renderPipeline(this.catalog, this.catalog.dialect, draft.source, plan.stages, { physicalCols: physSet, from: plan.from });
    } catch (e) {
      // Reject WITHOUT persisting; pinpoint which step broke so an edit in the middle is actionable.
      const at = this._failingStepIndex(draft.source, plan.stages, physSet, plan.from);
      const step = at != null ? plan.stepOf(at) : null;
      throw new ToolError(step ? `step ${step}: ${e.message}` : e.message, { stage: 'compile', field: 'stage' });
    }
    // Verify filter literals on the changed stage against the SOURCE's real values BEFORE persisting
    // — a wrong-cased/non-existent value ('organic' vs 'Organic') is flagged with the correct value.
    let filterWarnings = [];
    // A python stage's bodies pass the static gate BEFORE the draft persists them.
    if (changedStage && changedStage.stage === 'python') await this._gatePythonStage(changedStage);
    if (changedStage && changedStage.stage === 'where' && Array.isArray(changedStage.conditions)) {
      filterWarnings = this.advisor.guardFilterValues(changedStage.conditions
        .filter((cd) => cd && cd.column != null && Object.prototype.hasOwnProperty.call(cd, 'value'))
        .map((cd) => ({ at: this.advisor.valueKeyForColumn(draft.source, cd.column), op: cd.op, value: cd.value, where: `where ${cd.column}` })));
    }
    // a step an earlier version stored is kept from now on in the spelling it was built in — the
    // render's, resolved against the columns before it (src/pipeline/earlier.js); a step the render
    // did not reach (a materialized prefix) was respelled by the build that made its checkpoint, and is
    // shown as the build renders it (_draftSteps)
    draft.stages = rendered ? newStages.map((st) => rendered.current.get(st) ?? st) : newStages;
    // The edit is accepted: the checkpoints it invalidated (and any that went stale) go now, and
    // the files of the ones nobody else reads go with them.
    const why = `step ${dropFrom} was ${action === 'delete_step' ? 'deleted' : action === 'insert_step' ? 'shifted by an insert' : action === 'truncate' ? 'truncated away' : 'edited'}`;
    const retiredNow = this._applyCheckpointPlan(ctx, draft, plan, why);
    this.ctxs.touch(ctx.id);
    const after = rendered
      ? [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }))
      : this._draftColumns(draft, physSet);
    const beforeNames = new Set(before.map((c) => c.name));
    const afterNames = new Set(after.map((c) => c.name));
    const removed = before.filter((c) => !afterNames.has(c.name)).map((c) => c.name);
    const allSteps = this._draftSteps(draft, physSet);
    // add_steps is APPEND-ONLY: the AI already saw every prior step in earlier responses, so echoing
    // the whole (growing) steps list each call is O(n²) waste across a build. Return only the applied
    // step + a count by default; the full list is available via include_steps:true or preview.
    // edit/insert/delete/truncate DO reshuffle the sequence, so they always return the full list.
    const leanSteps = action === 'add_steps' && !includeSteps;
    const resp = {
      context_id: ctx.id, action, step_index: stepIndex ?? draft.stages.length,
      ...(leanSteps
        ? { step: allSteps.find((s) => s.index === (stepIndex ?? draft.stages.length)) || allSteps[allSteps.length - 1], steps_count: allSteps.length }
        : { steps: allSteps }),
      column_count: after.length,
      columns_added: after.filter((c) => !beforeNames.has(c.name)),
      // Compact by default: a step that drops 200 columns must not reprint 200 names every call.
      // Always give the count; include the full list only when it is short or include_columns is set.
      columns_removed_count: removed.length,
      ...((includeColumns || removed.length <= 10) ? { columns_removed: removed } : {}),
      ...(plan.checkpoint ? { from_checkpoint: { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at }, steps_recomputed: newStages.length - plan.checkpoint.at } : {}),
      ...(retiredNow.length ? { checkpoints_dropped: retiredNow } : {}),
      next: action === 'add_steps'
        ? 'add_steps the next stages; or fix a prior step with edit_step/insert_step/delete_step/truncate; or materialize. Pass include_columns:true / preview for the full column list.'
        : 'Pipeline revalidated end-to-end after the edit. Continue editing, preview, or materialize (include_columns:true for the full list).',
      recommendations: [
        ...filterWarnings,
        ...(plan.checkpoint ? [`Steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model}: this step reads THAT table, so the prefix is not recomputed. Editing a step at or before ${plan.checkpoint.at} retires it and the next materialize rebuilds from '${draft.source}'.`] : []),
        ...(retiredNow.length ? [`Materialized prefix retired (${retiredNow.map((r) => `step ${r.at}: ${r.reason}`).join('; ')}) — the next materialize recomputes from '${draft.source}'.`] : []),
        ...(leanSteps ? [`Only the applied step is echoed (steps_count: ${allSteps.length}) to save tokens — you already have the earlier steps. For the FULL step list, pass include_steps:true or use build_pipeline_model({ request: { action: "preview", context_id: "${ctx.id}" } }).`] : []),
        ...(changedStage ? [...this.advisor.eventScopeWarnings(draft, changedStage), ...this.advisor.emptyCombinationWarnings(draft, changedStage), ...this.advisor.funnelCompletionWarnings(changedStage), ...this.advisor.joinCompletenessWarnings(changedStage, draft), ...this.advisor.pythonPreparationWarnings(changedStage, { source: draft.source, stages: draft.stages, timeRange: draft.time_range, startsFromTable: !!plan.from }, stepIndex != null ? stepIndex - 1 : draft.stages.indexOf(changedStage)), ...this.advisor.globalWindowWarnings(changedStage), ...this.advisor.stepRecommendations(changedStage, after, { building })] : []),
      ],
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  },

  /**
   * THE DRAFT CHECKED BY THE WAREHOUSE, READING NO DATA — preview with validate: a task (read with
   * query_pipeline_model) that writes the SQL a materialize would build, under names of its own, and
   * runs it with `dbt run --empty`: every ref and source limited to zero rows, so the warehouse
   * compiles and plans the very SQL (a type mismatch, an unknown name, a syntax error is refused as
   * it would be) and reads nothing. The models are removed afterwards whatever the outcome — a
   * failing one left in the project would fail every later build of the context. A python model is
   * not run empty: the check covers the SQL models before the first one.
   */
  async _draftValidate(ctx, draft) {
    if (!draft.stages.length) throw new ToolError('draft has no stages to validate — add_steps first', { stage: 'validate', field: 'context_id' });
    if (!this.runner?.run) throw new ToolError('no warehouse runner configured — nothing to validate against', { stage: 'validate' });
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const plan = this._renderPlan(draft);
    if (plan.checkpoint && !plan.stages.length) throw new ToolError(`nothing to validate: every step is already materialized as ${plan.checkpoint.model}`, { stage: 'validate', field: 'context_id' });
    // names of its own (pipe_…_chk): the check never writes over a table a build made or reads
    const modelName = `${this._nextPipelineModel(ctx, draft.name)}_chk`;
    const rendered = renderPipeline(this.catalog, this.catalog.dialect, draft.source, plan.stages, { physicalCols: physSet, modelName, from: plan.from });
    const models = this._chainModels(rendered.chain, { name: draft.name, pipeline: { source: draft.source } });
    const firstPython = models.findIndex((m) => m.kind === 'python');
    const sql = firstPython === -1 ? models : models.slice(0, firstPython);
    const taskId = this._startTask(ctx, 'build_pipeline_model', async () => {
      if (!sql.length) return { ok: true, validated: false, context_id: ctx.id, note: 'the draft begins with a python stage, which is not run empty — its SQL is checked by the build itself' };
      try {
        for (const m of sql) this.ctxs.writeModel(ctx.id, m.model, `${this._modelConfigLine('table', { pipeline: true })}\n${m.sql}\n`);
        const r = await this.runner.run(this.ctxs.dir(ctx.id), sql.map((m) => m.model).join(' '), { empty: true });
        if (!r.ok) return { ok: false, context_id: ctx.id, error: { stage: 'validate', message: this._sqlRunMessage(r.stdout, r.stderr), note: 'the warehouse refused the draft\'s SQL with no data read (dbt run --empty) — fix the step it names, then validate or materialize' } };
        return {
          ok: true, validated: true, context_id: ctx.id, checked: sql.map((m) => m.model.replace(/_chk/, '')),
          note: `the warehouse compiled and ran the draft's SQL with every input limited to zero rows (dbt run --empty): nothing was read and nothing kept${firstPython !== -1 ? `; the python model(s) from step ${firstPython + 1} on are checked by the build itself` : ''} — materialize builds it`,
        };
      } finally {
        this.ctxs.removePipelineFiles(ctx.id, modelName);
      }
    }, { input: { action: 'preview', validate: true, context_id: ctx.id, name: draft.name, source: draft.source, stages: draft.stages } });
    return this._taskStarted(taskId, { context_id: ctx.id });
  },

  async _draftPreview(ctx, draft) {
    const dialect = this.catalog.dialect;
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const base = { context_id: ctx.id, action: 'preview', name: draft.name, source: draft.source, materialized: draft.materialized, dialect, steps: this._draftSteps(draft, physSet) };
    if (!draft.stages.length) return { ...base, available_columns: this._groundedDeclared(draft.source, physSet).cols, note: 'No stages yet — add_steps first.' };
    // Preview what materialize would ACTUALLY build: from the last live checkpoint when there is
    // one (the steps it baked are a table, not SQL to re-render), else the whole pipeline.
    const plan = this._renderPlan(draft);
    const dropped = this._applyCheckpointPlan(ctx, draft, plan);
    const modelName = this._nextPipelineModel(ctx, draft.name);
    // Render ONLY the active warehouse dialect, so every response is consistent with where
    // the pipeline actually runs (bigquery → `|>`, duckdb → CTEs). Grounded to physical.
    const rendered = renderPipeline(this.catalog, dialect, draft.source, plan.stages, { physicalCols: physSet, modelName, from: plan.from });
    const models = this._chainModels(rendered.chain, { name: draft.name, pipeline: { source: draft.source } });
    const hasPython = models.some((m) => m.kind === 'python');
    return {
      ...base, available_columns: [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
      // A chain that ends in a python model has no SQL of its own — its code is under `python`
      // below. Reporting `model_sql: null` as THE preview said nothing about what would be built.
      ...(rendered.sql ? { model_sql: rendered.sql } : {}),
      ...(dropped.length ? { checkpoints_dropped: dropped } : {}),
      ...(plan.checkpoint ? {
        from_checkpoint: { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at },
        steps_recomputed: plan.stages.length,
        checkpoint_note: plan.stages.length
          ? `Steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model}; the SQL above is only what runs on top of it (${plan.stages.length} step(s)).`
          : `Every step is already materialized as ${plan.checkpoint.model} — add_steps before materializing again (the SQL above would just copy that table).`,
      } : {}),
      ...(models.length > 1 || hasPython
        ? {
          models: models.map(({ yml, functions, bindings, code, ...m }) => m),
          ...(hasPython ? { python: models.filter((m) => m.kind === 'python').map(({ yml, functions, bindings, ...m }) => m) } : {}),
          note: `The pipeline builds as a chain of ${models.length} dbt model(s) (each python stage is a model of its own, reading the previous one via dbt.ref); ${modelName} — the last — is the result.`,
        }
        : {}),
    };
  },
};
