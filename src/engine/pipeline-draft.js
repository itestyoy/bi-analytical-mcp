// BUILD_PIPELINE_MODEL, STEP BY STEP — the draft a pipeline is shaped in: start, add / edit / insert /
// delete a step, truncate, fork, preview; the checkpoints a materialize leaves and what an edit retires
// of them. Materializing it is src/engine/pipeline-materialize.js. Methods of the Engine
// (src/engine/helpers.js — mixin).

import { ToolError, RESULT_GONE } from '../validate.js';
import { renderPipeline } from '../pipeline.js';

export const pipelineDraftMethods = {
  /**
   * Compose a native pipeline INCREMENTALLY (single tool, `action`-driven). Each
   * add_step validates the stage and returns the columns now available for the next
   * stage — pure schema propagation via renderPipeline, NO warehouse hit until materialize.
   * The all-at-once register_native_model path is unchanged. Lifecycle:
   * start → add_step* → (preview) → materialize | discard.
   */
  async build_pipeline_model(input) {
    this._validate('build_pipeline_model', input);
    if (input.action === 'start') return this._draftStart(input);
    if (input.action === 'fork') return this._draftFork(input); // branches a NEW draft (no live draft required)
    const ctx = this._ctx(input.draft_id);
    const draft = ctx.state.draft;
    if (!draft) throw new ToolError(`no draft in context '${input.draft_id}' — start one with build_pipeline_model({ request: { action: 'start', name } })`, { stage: 'validate', field: 'draft_id' });
    this.ctxs.touch(ctx.id);
    if (input.action === 'add_step') return this._draftAddStep(ctx, draft, input.stage, input.include_columns, input.include_steps);
    if (input.action === 'add_steps') return this._draftAddSteps(ctx, draft, input.stages, input.include_columns);
    if (input.action === 'edit_step') return this._draftEditStep(ctx, draft, input.index, input.stage, input.include_columns);
    if (input.action === 'insert_step') return this._draftInsertStep(ctx, draft, input.index, input.stage, input.include_columns);
    if (input.action === 'delete_step') return this._draftDeleteStep(ctx, draft, input.index, input.include_columns);
    if (input.action === 'truncate') return this._draftTruncate(ctx, draft, input.after, input.include_columns);
    if (input.action === 'preview') return this._draftPreview(ctx, draft);
    if (input.action === 'discard') { delete ctx.state.draft; return { draft_id: ctx.id, action: 'discard', discarded: true }; }
    return this._draftMaterialize(ctx, draft); // materialize (the final build step)
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
   * render plan asks for it a few times per add_step. A completed scan bumps the generation, which
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
          + `Wait for it with query_pipeline_model({ request: { task_id: '${st.building}' } }) and materialize again once it is done; if that build is gone for good (the server restarted), retire it with truncate/edit_step at or before step ${list[i].at} — or delete_context({ request: { what: 'pipeline_model' } }) — and materialize again.`,
          { stage: 'validate', field: 'draft_id' },
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
   *  grounded to the physical relation (phantom catalog columns excluded). */
  _draftColumns(draft, physSet) {
    if (!draft.stages.length) return draft.base ? draft.base.columns.map((c) => ({ ...c })) : this._groundedDeclared(draft.source, physSet).cols;
    const plan = this._renderPlan(draft);
    const { columns } = renderPipeline(this.catalog, this.catalog.dialect, draft.source, plan.stages, { physicalCols: physSet, from: plan.from });
    return [...columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }));
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

  _draftSteps(draft) {
    return draft.stages.map((s, i) => ({ index: i + 1, ...s }));
  },

  async _draftStart(input) {
    const found = input.from_task ? this._taskBase(input) : null;
    const base = found ? found.base : null;
    const ctx = input.draft_id ? this._ctxToWrite(input.draft_id, 'draft_id') : this.ctxs.create();
    const source = found ? found.source : input.source;
    ctx.state.draft = { name: input.name, source, materialized: input.materialized || 'table', time_range: base ? null : (input.time_range || null), stages: [], checkpoints: [], ...(base ? { base } : {}), ...(input.description ? { description: input.description } : {}) };
    if (base) this._holdTaskBase(ctx, base);
    this.ctxs.touch(ctx.id);
    // The referenceable columns are SILENTLY grounded to the physical relation: a column
    // the catalog declares but the table lacks simply does not appear (a clean internal
    // guard) — never offered, never buildable, not called out. Only real columns exist.
    const physSet = await this.probe.physicalColumns(source);
    const cols = base ? base.columns : this._groundedDeclared(source, physSet).cols;
    const resp = {
      draft_id: ctx.id, action: 'start', name: input.name, source, materialized: ctx.state.draft.materialized,
      ...(base ? { from_task: base.task_id, reads: base.model } : {}),
      ...(ctx.state.draft.description ? { description: ctx.state.draft.description } : {}),
      steps: [], column_count: cols.length,
      next: 'Append stages one at a time with build_pipeline_model({ request: { action: "add_step", draft_id, stage } }); each response shows only the columns that stage added/removed (use include_columns:true or preview for the full list).',
      recommendations: [
        base
          ? `The table of task ${base.task_id} (${base.model}) has ${cols.length} columns your first stage can reference (include_columns:true lists them); nothing before it is recomputed.`
          : `The source has ${cols.length} columns your first stage can reference; get the full list with build_pipeline_model({ request: { action: "start", ..., include_columns: true } }) or inspect via semantic_index({ request: { model: '${source}' } }).`,
        `For an ordered funnel/path, add a match_recognize stage; for a plain transform, start with where/derive then aggregate.`,
        `When the steps look right, materialize with build_pipeline_model({ request: { action: "materialize", draft_id } }).`,
      ],
    };
    if (input.include_columns) resp.available_columns = cols;
    return resp;
  },

  async _draftAddStep(ctx, draft, stage, includeColumns = false, includeSteps = false) {
    return this._draftCommit(ctx, draft, [...draft.stages, stage], { changedStage: stage, includeColumns, includeSteps, action: 'add_step' });
  },

  /**
   * Append SEVERAL stages in one call, applied SEQUENTIALLY. The response folds the per-step
   * effects together — for each stage, how it changed the columns (added / removed count) and any
   * warnings — so you see the same "how each application affected the data" detail as adding them
   * one at a time, in a single reply. ATOMIC: if any stage fails validation the whole batch is
   * rolled back (nothing applied) and the failing step is named. NB: adding many steps blind is
   * discouraged — the response says so.
   */
  async _draftAddSteps(ctx, draft, stages, includeColumns = false) {
    if (!Array.isArray(stages) || !stages.length) throw new ToolError('add_steps needs a non-empty `stages` array', { stage: 'validate', field: 'stages' });
    const snapshot = draft.stages.slice(); // atomic: restore on any failure so the draft is never half-applied
    const effects = [];
    try {
      for (const stage of stages) {
        const r = await this._draftCommit(ctx, draft, [...draft.stages, stage], { changedStage: stage, includeColumns: false, includeSteps: true, action: 'add_step' });
        effects.push({
          step_index: r.step_index,
          stage: stage.stage,
          column_count: r.column_count,
          columns_added: r.columns_added,
          columns_removed_count: r.columns_removed_count,
          ...(r.columns_removed ? { columns_removed: r.columns_removed } : {}),
          notes: r.recommendations, // per-step warnings/nudges (filter guard, empty-combination, funnel, etc.)
        });
      }
    } catch (e) {
      draft.stages = snapshot; this.ctxs.touch(ctx.id);
      throw new ToolError(`${e.message} — NO steps applied (add_steps is atomic; fix that stage and retry, ideally in a smaller chunk)`, { stage: 'compile', field: 'stages' });
    }
    const physSet = await this.probe.physicalColumns(draft.source);
    const after = this._draftColumns(draft, physSet);
    const resp = {
      draft_id: ctx.id, action: 'add_steps', added: effects.length,
      steps: this._draftSteps(draft),
      // The sequential effect of EACH stage, in order — the combined view of what would have been
      // N separate add_step replies. Read it top-to-bottom to see how the data narrowed/expanded.
      step_effects: effects,
      column_count: after.length,
      next: 'Review step_effects (each stage\'s column delta + notes), then add the NEXT logical chunk or materialize.',
      recommendations: [
        'STRONGLY recommended: add stages in small LOGICAL chunks (e.g. scope+derive, THEN the funnel, THEN aggregate) rather than the whole pipeline at once — you see how each chunk changes the data and catch a mistake before it compounds across later steps.',
      ],
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
    const src = this._ctx(input.draft_id);
    const origin = src.state.draft || src.state.pipeline_origin; // live draft, or the snapshot a materialize left behind
    if (!origin) throw new ToolError(`context '${input.draft_id}' has no draft or built pipeline to fork — start one, or fork a context whose pipeline was materialized`, { stage: 'validate', field: 'draft_id' });
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
      if (!this.ctxs.has(origin.base.owner) || !this.ctxs.hasPipelineModel(origin.base.owner, origin.base.model)) throw new ToolError(`the table this draft starts from (${origin.base.model}, task ${origin.base.task_id}) is gone — start a new draft from a task that still exists`, { stage: 'validate', field: 'draft_id', code: RESULT_GONE });
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
    const physSet = await this.probe.physicalColumns(ctx.state.draft.source);
    const cols = this._draftColumns(ctx.state.draft, physSet);
    const resp = {
      draft_id: ctx.id, action: 'fork', forked_from: input.draft_id, name, source: ctx.state.draft.source,
      materialized: ctx.state.draft.materialized, copied_steps: after, step_index: after,
      steps: this._draftSteps(ctx.state.draft), column_count: cols.length,
      ...(inherited.length ? { inherited_checkpoints: inherited } : {}),
      next: 'Continue editing this NEW draft (add_step / edit_step / insert_step / delete_step / truncate); the original is untouched. Materialize when done.',
      recommendations: [
        `Forked ${after} of ${total} step(s) into a new draft ${ctx.id}; the source ${input.draft_id} is unchanged — branch variants freely.`,
        ...(inherited.length ? [`Steps 1..${inherited[inherited.length - 1].at} are already materialized (${inherited[inherited.length - 1].model}, built in ${inherited[inherited.length - 1].owner}) and this fork READS that table: only the steps you add here are computed. Keep that context alive while this fork uses it — delete_context on it is refused unless forced.`] : []),
        `Materialize with build_pipeline_model({ request: { action: "materialize", draft_id: "${ctx.id}" } }).`,
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
   * the per-step diff (columns added/removed). Powers add_step AND the edit ops (edit/insert/
   * delete/truncate): every edit revalidates the ENTIRE downstream, so a change that breaks a
   * later step is reported with that step's index and the draft is left intact to fix. The
   * `changedStage` (the added/edited stage; null for delete/truncate) drives the filter/scope/
   * funnel warnings.
   */
  async _draftCommit(ctx, draft, newStages, { changedStage = null, includeColumns = false, includeSteps = false, action = 'add_step', stepIndex = null, dropFrom = null } = {}) {
    const physSet = await this.probe.physicalColumns(draft.source);
    const before = this._draftColumns(draft, physSet); // columns BEFORE the change
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
    draft.stages = newStages;
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
    const allSteps = this._draftSteps(draft);
    // add_step is APPEND-ONLY: the AI already saw every prior step in earlier responses, so echoing
    // the whole (growing) steps list each call is O(n²) waste across a build. Return only the applied
    // step + a count by default; the full list is available via include_steps:true or preview.
    // edit/insert/delete/truncate DO reshuffle the sequence, so they always return the full list.
    const leanSteps = action === 'add_step' && !includeSteps;
    const resp = {
      draft_id: ctx.id, action, step_index: stepIndex ?? draft.stages.length,
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
      next: action === 'add_step'
        ? 'add_step the next stage; or fix a prior step with edit_step/insert_step/delete_step/truncate; or materialize. Pass include_columns:true / preview for the full column list.'
        : 'Pipeline revalidated end-to-end after the edit. Continue editing, preview, or materialize (include_columns:true for the full list).',
      recommendations: [
        ...filterWarnings,
        ...(plan.checkpoint ? [`Steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model}: this step reads THAT table, so the prefix is not recomputed. Editing a step at or before ${plan.checkpoint.at} retires it and the next materialize rebuilds from '${draft.source}'.`] : []),
        ...(retiredNow.length ? [`Materialized prefix retired (${retiredNow.map((r) => `step ${r.at}: ${r.reason}`).join('; ')}) — the next materialize recomputes from '${draft.source}'.`] : []),
        ...(leanSteps ? [`Only the applied step is echoed (steps_count: ${allSteps.length}) to save tokens — you already have the earlier steps. For the FULL step list, pass include_steps:true or use build_pipeline_model({ request: { action: "preview", draft_id } }).`] : []),
        ...(changedStage ? [...this.advisor.eventScopeWarnings(draft, changedStage), ...this.advisor.emptyCombinationWarnings(draft, changedStage), ...this.advisor.funnelCompletionWarnings(changedStage), ...this.advisor.joinCompletenessWarnings(changedStage, draft), ...this.advisor.pythonPreparationWarnings(changedStage, { source: draft.source, stages: draft.stages, timeRange: draft.time_range, startsFromTable: !!plan.from }, stepIndex != null ? stepIndex - 1 : draft.stages.indexOf(changedStage)), ...this.advisor.globalWindowWarnings(changedStage), ...this.advisor.stepRecommendations(changedStage, after)] : []),
      ],
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  },

  async _draftPreview(ctx, draft) {
    const dialect = this.catalog.dialect;
    const physSet = await this.probe.physicalColumns(draft.source);
    const base = { draft_id: ctx.id, action: 'preview', name: draft.name, source: draft.source, materialized: draft.materialized, dialect, steps: this._draftSteps(draft) };
    if (!draft.stages.length) return { ...base, available_columns: this._groundedDeclared(draft.source, physSet).cols, note: 'No stages yet — add_step first.' };
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
          : `Every step is already materialized as ${plan.checkpoint.model} — add_step before materializing again (the SQL above would just copy that table).`,
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
