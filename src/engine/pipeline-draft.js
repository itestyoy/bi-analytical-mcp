// BUILD_MODEL, STEP BY STEP — the draft a build is shaped in: start, add or edit a step, fork, preview;
// the checkpoints a materialize leaves and what an edit retires
// of them. Materializing it is src/engine/pipeline-materialize.js. Methods of the Engine
// (src/engine/helpers.js — mixin).

import { ToolError, RESULT_GONE } from '../validate.js';
import { renderPipeline, columnList } from '../pipeline.js';
import { comparisonOf, eachCondition } from '../pipeline/compute.js';
import { currentSpelling } from '../pipeline/earlier.js';
import { isSemanticStep, SEMANTIC_STAGE } from '../pipeline/semantic-stage.js';
import { physicalColumnType } from '../catalog/column-types.js';
import { MAX_WAIT_SECONDS } from '../schema.js';
import { sayOnce } from './pipeline-warnings.js';

/** The comparisons of a column with constants that bound a scan of it (require_time_range). */
const BOUNDING_OPS = ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'in'];

/** What an answer shows beyond what the call changed, as the call's `include` asks: every available
 *  column, every step. */
const included = (input) => ({ columns: !!input.include?.includes('columns'), steps: !!input.include?.includes('steps') });

/** A step as an answer says it back: where it stands, what it is, and the name it makes. */
const stepBrief = (s) => ({ index: s.index, stage: s.stage, ...(s.name !== undefined ? { name: s.name } : {}) });

/** What a change to the steps did, said in the answer of the build it started. */
const said = (action) => ({ edit_step: 'The step is replaced', insert_step: 'The step is put in', delete_step: 'The step is removed' })[action] || 'The steps are added';

export const pipelineDraftMethods = {
  /**
   * Compose a pipeline INCREMENTALLY (single tool, `action`-driven). Each
   * add_steps validates each step and returns the columns now available for the next
   * one — pure schema propagation via renderPipeline, NO warehouse hit until materialize.
   * The all-at-once _buildPipeline path is unchanged. Lifecycle:
   * start → add_steps* → (preview) → materialize | discard.
   */
  async build_model(input) {
    this._validate('build_model', input);
    // start is the default action: a request without one is a start (its forms are the only ones that may omit it)
    if (input.action === undefined || input.action === 'start') return this._draftStart(input);
    if (input.action === 'fork') return this._draftFork(input); // branches a NEW draft (no live draft required)
    const ctx = this._ctx(input.context_id);
    const draft = ctx.state.draft;
    if (!draft) throw new ToolError(`no draft in context '${input.context_id}' — start one with build_model({ request: { action: 'start', name, source } })`, { stage: 'validate', field: 'context_id' });
    this.ctxs.touch(ctx.id);
    const inc = included(input);
    if (input.action === 'add_steps') return this._draftThenBuild(ctx, draft, input, await this._draftAddAll(ctx, draft, input.steps, inc, { building: !!input.materialize }));
    // the semantic_model step is the build's last, one past its stages
    const semanticAt = draft.semantic ? draft.stages.length + 1 : null;
    if (input.action === 'edit_step') {
      const toSemantic = isSemanticStep(input.step);
      if (input.index === semanticAt) {
        if (!toSemantic) throw new ToolError(`step ${semanticAt} is the build's semantic_model step: edit it with another semantic_model step, or fork the build before it (fork, after: ${semanticAt - 1}) and add the step there`, { stage: 'validate', field: 'step' });
        return this._draftThenBuild(ctx, draft, input, this._draftSemanticAnswer(ctx, draft, await this._draftSetSemantic(ctx, draft, input.step), input.action, inc));
      }
      if (toSemantic) throw new ToolError(`a semantic_model step is the build's last step${draft.semantic ? ` — this build's is step ${semanticAt}: edit that one` : ` — add it after step ${draft.stages.length}`}`, { stage: 'validate', field: 'step' });
      // (materialize: true builds right after the edit, as it does after added steps)
      return this._draftThenBuild(ctx, draft, input, await this._draftEditStep(ctx, draft, input.index, input.step, inc.columns, inc.steps));
    }
    if (input.action === 'insert_step' || input.action === 'delete_step') {
      if (semanticAt && input.index >= semanticAt) throw new ToolError(`step ${semanticAt} is the build's semantic_model step, its last: ${input.action === 'insert_step' ? `a step goes before it (index 1..${semanticAt - 1}) — or edit it (edit_step)` : `it is edited (edit_step), or the build forked before it (fork, after: ${semanticAt - 1})`}`, { stage: 'validate', field: 'index' });
      if (input.action === 'insert_step' && isSemanticStep(input.step)) throw new ToolError(`a semantic_model step is the build's last step — ${draft.semantic ? `this build's is step ${semanticAt}: edit that one` : `add it after step ${draft.stages.length} (add_steps)`}`, { stage: 'validate', field: 'step' });
      return this._draftThenBuild(ctx, draft, input, await (input.action === 'insert_step'
        ? this._draftInsertStep(ctx, draft, input.index, input.step, inc.columns, inc.steps)
        : this._draftDeleteStep(ctx, draft, input.index, inc.columns, inc.steps)));
    }
    if (input.action === 'preview') return input.validate ? this._draftValidate(ctx, draft) : this._draftPreview(ctx, draft);
    if (input.action === 'discard') {
      delete ctx.state.draft;
      // (the context stays — it may hold a built model or a layer — and says how it goes too)
      return { context_id: ctx.id, action: 'discard', discarded: true, note: `the draft is gone; context ${ctx.id} stays (delete_context({ request: { context_id: "${ctx.id}" } }) removes it)` };
    }
    return this._draftMaterialize(ctx, draft); // materialize (the final build step)
  },

  /**
   * Add steps — with add_steps, or the first ones with start: the stages, and a semantic_model step after
   * them, the build's last. All or none: a semantic_model step that is refused takes the stages added
   * with it back.
   */
  async _draftAddAll(ctx, draft, steps, inc, { building = false } = {}) {
    if (!Array.isArray(steps) || !steps.length) throw new ToolError('add_steps needs a non-empty `steps` array', { stage: 'validate', field: 'steps' });
    const at = steps.findIndex(isSemanticStep);
    const extra = steps.findIndex((st, i) => i > at && at !== -1 && isSemanticStep(st));
    if (extra !== -1) throw new ToolError(`steps[${extra}]: a build has one semantic_model step`, { stage: 'validate', field: `steps[${extra}]` });
    if (at !== -1 && at !== steps.length - 1) throw new ToolError(`steps[${at}]: a semantic_model step is the build's last — put it after the others`, { stage: 'validate', field: `steps[${at}]` });
    if (draft.semantic) throw new ToolError(`this build ends in its semantic_model step (step ${draft.stages.length + 1}): nothing comes after it — fork the build before it (fork, after: ${draft.stages.length}) to add steps there, or edit it (edit_step)`, { stage: 'validate', field: 'steps' });
    const stages = at === -1 ? steps : steps.slice(0, -1);
    if (at === -1) return this._draftAddSteps(ctx, draft, stages, inc.columns, inc.steps, { building });
    const snapshot = draft.stages.slice();
    const added = stages.length ? await this._draftAddSteps(ctx, draft, stages, inc.columns, inc.steps, { building }) : null;
    let effect;
    try { effect = await this._draftSetSemantic(ctx, draft, steps[at]); } catch (e) {
      draft.stages = snapshot; this.ctxs.touch(ctx.id);
      throw new ToolError(`steps[${at}]: ${e.message}`, { stage: e.stage || 'validate', field: `steps[${at}]${e.field ? `.${e.field}` : ''}`, code: e.code });
    }
    const answer = this._draftSemanticAnswer(ctx, draft, effect, 'add_steps', inc);
    // (the stages added with it, then the step itself: every step this call added)
    return added ? { ...added, ...answer, ...(added.steps_added && answer.steps_added ? { steps_added: [...added.steps_added, ...answer.steps_added] } : {}), step_effects: [...added.step_effects, effect] } : answer;
  },

  /** The semantic_model step, checked as it would be built (its layer compiled and rendered), put in place. */
  async _draftSetSemantic(ctx, draft, st) {
    const { render } = await this._semanticLayerOf(ctx, draft, st);
    draft.semantic = st;
    this.ctxs.touch(ctx.id);
    // (over a catalog source: a measure of an event property carried by several events)
    const overSource = !draft.stages.length && !draft.base;
    const recs = [...(render.warnings || []), ...(overSource ? this.advisor.measureScopeWarnings(draft.source, st.measures) : []), ...this.advisor.ratioMeasureWarnings(overSource ? draft.source : null, st.measures)];
    return {
      step_index: draft.stages.length + 1, stage: SEMANTIC_STAGE,
      semantic_models: render.semanticModels, metrics: render.metricNames,
      ...(recs.length ? { recommendations: recs } : {}),
    };
  },

  /** What a call that put the semantic_model step in place answers. */
  _draftSemanticAnswer(ctx, draft, effect, action, inc) {
    const all = this._draftSteps(draft);
    return {
      context_id: ctx.id, action,
      // (an edit put the step in place, an add appended it: each answers under its own word)
      // (the step is the caller's own, just sent: said by where it stands — step_effects says what it
      // declared; include: ["steps"] gives every step whole)
      ...(inc.steps ? { steps: all } : { [action === 'edit_step' ? 'step_edited' : 'steps_added']: [{ index: all.length, stage: SEMANTIC_STAGE }], steps_count: all.length }),
      step_effects: [effect],
      next: `Materialize — build_model({ request: { action: "materialize", context_id: "${ctx.id}" } }), or materialize: true beside the step — writes the layer and parses it; then query its metrics (${effect.metrics.join(', ')}) with query_model({ request: { context_id: "${ctx.id}", steps: [{ stage: "metrics", metrics: [...] }] } }).`,
    };
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
        next: `${said(input.action)} and the build is started (materialize.task_id): read it with ${this.tasks.readWith(materialize.task_id)} — it waits for the build and returns ${draft.semantic ? 'the semantic layer it declared (its metrics and what they are grouped by; a metric query returns rows)' : 'its rows'}.`,
      };
    } catch (e) {
      const stage = e instanceof ToolError ? (e.stage || 'validate') : 'internal';
      // the call succeeds, its build did not: kept in the error log as a refused call is
      this.errors?.record?.({ source: 'tool', tool: 'build_model', stage, field: 'materialize', code: e.code, message: e.message, args: { request: input }, context_id: ctx.id });
      return {
        ...added,
        materialize: { ok: false, error: { stage, message: e.message, ...(e.code ? { code: e.code } : {}) } },
        next: `${said(input.action)}; the build did not start (materialize.error says why). Materialize with build_model({ request: { action: "materialize", context_id: "${ctx.id}" } }) once that is resolved.`,
      };
    }
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
          + `Wait for it with query_model({ request: { task_ids: ['${st.building}'] } }) and materialize again once it is done; if that build is gone for good (the server restarted), retire it with edit_step at or before step ${list[i].at} — or delete_context({ request: { what: 'pipeline_model' } }) — and materialize again.`,
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
      // retired: `ctx.state.model` still advertises that table and query_model reads it
      // through `{{ ref() }}`, which needs the file. A later build of the same name cleans it.
      if (cp.model === ctx.state.model) continue;
      // Nor one whose build is STILL RUNNING here: the task will hand its table back through
      // query_model, which reads it by ref — removing the definition mid-build would make the
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

  /** The columns right after step `index` (1-based) of the draft — what the step after it reads; the
   *  draft's last columns (`last`) where the step is its last, or its prefix does not render alone. */
  _columnsAfter(draft, physSet, index, last) {
    if (!index || index >= draft.stages.length) return last;
    try { return this._draftColumns({ ...draft, stages: draft.stages.slice(0, index), checkpoints: (draft.checkpoints || []).filter((cp) => cp.at <= index) }, physSet); } catch { return last; }
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
      throw new ToolError(`${step ? `step ${step}: ` : ''}${e.message} — a step this draft already holds; fix it with edit_step${step ? ` (index: ${step})` : ''}`, { stage: 'compile', field: 'steps' });
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

  /**
   * True when some pipeline stage already bounds the source's time/partition column: a where whose own
   * list (all of it holds) compares that column with constants. A condition naming the column inside
   * an or / a not bounds nothing — the other branch reads every row. A kept step is read in this
   * version's spelling, as it is built.
   */
  _stagesBoundInTime(source, stages = []) {
    const m = this.catalog.getModel(source);
    const bounds = new Set([m.time?.column, m.partition_column].filter(Boolean));
    if (!bounds.size) return true; // no time axis — nothing to bound
    return stages.map((s) => currentSpelling(s)).some((s) => s?.stage === 'where' && (s.conditions || []).some((c) => {
      const cmp = comparisonOf(c);
      return !!cmp && bounds.has(cmp.subject.column) && BOUNDING_OPS.includes(cmp.op) && !cmp.values.includes(null);
    }));
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
    const semantic = draft.semantic ? [{ index: draft.stages.length + 1, ...draft.semantic }] : [];
    if (!draft.stages.length) return semantic;
    const current = this._draftSpelling(draft, physSet);
    return [...draft.stages.map((s, i) => ({ index: i + 1, ...(current.get(s) ?? s) })), ...semantic];
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
    if (input.materialize && !input.steps?.length) throw new ToolError('materialize: true builds the steps this start adds — give them in `steps`, or materialize later with build_model({ request: { action: "materialize", context_id } })', { stage: 'validate', field: 'materialize' });
    // a task still running is waited for (up to a read's wait), as a read of it would: the build it
    // starts reads the table it stores, so starting from it is the next thing to do, not a refusal
    if (input.from_task && this.jobs.get(input.from_task)?.status === 'running') await this.tasks.await([input.from_task], MAX_WAIT_SECONDS);
    const found = input.from_task ? this._taskBase(input) : null;
    if (input.context_id) this._ctxToWrite(input.context_id); // refused before the warehouse is asked
    const base = found ? await this._baseWithPhysical(found.base) : null;
    if (!found) this._timeAxisFor(input.source, input.time_range); // refused before a context is made
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
    const buildHint = `When the steps look right, materialize with build_model({ request: { action: "materialize", context_id: "${ctx.id}" } }).`;
    const resp = {
      context_id: ctx.id, action: 'start', name: input.name, source, materializes_as: ctx.state.draft.materialized,
      ...(base ? { from_task: base.task_id, reads: base.model } : {}),
      // (a task that read several models: its rows are its table's — source is only what the steps resolve against)
      ...(base && found.read.length > 1 ? { task_read: found.read, source_note: `the rows are task ${base.task_id}'s table, which read ${found.read.join(', ')}; source '${source}' is what these steps resolve relationships and properties against` } : {}),
      ...(ctx.state.draft.description ? { description: ctx.state.draft.description } : {}),
      steps: [], column_count: cols.length,
      next: `Append steps with build_model({ request: { action: "add_steps", context_id: "${ctx.id}", steps: [...] } }) — a logical chunk at a time; each response shows what each step added or removed (include: ["columns"] or preview for the full list).`,
      recommendations: [
        base
          ? `The table of task ${base.task_id} (${base.model}) has ${cols.length} columns your first step can reference (include: ["columns"] lists them); nothing before it is recomputed.`
          : `The source has ${cols.length} columns your first step can reference; get the full list with build_model({ request: { action: "start", ..., include: ["columns"] } }) or inspect via semantic_index({ request: { source: '${source}' } }).`,
      ],
    };
    // a partitioned source read with no window is read whole: said where the draft starts, while time_range
    // can still be given (a where on the partition column bounds it too)
    // (a build that is only a semantic layer reads nothing: its queries take their own time_range)
    const layerOnly = input.steps?.length && input.steps.every((st) => st?.stage === 'semantic_model');
    const part = !base && !input.time_range && !layerOnly ? this.catalog.getModel(source)?.partition_column : null;
    if (part) resp.warnings = [`No time_range: every build of this draft reads the whole of '${source}' (partitioned by ${part}). Bound it — start again with time_range, or add a where on ${part} as the first step — unless the whole history is the point.`];
    const inc = included(input);
    if (inc.columns) resp.available_columns = cols;
    if (!input.steps?.length) return resp;
    // a draft may start with its first chunk of steps — start + add_steps in one call, and with
    // materialize: true the build after them too
    let added;
    try {
      added = await this._draftAddAll(ctx, ctx.state.draft, input.steps, inc, { building: !!input.materialize });
    } catch (e) {
      // a context this call made for the draft goes with the refused steps: a corrected retry starts
      // afresh, and no empty draft is left behind for every attempt
      if (!input.context_id) {
        try { this.ctxs.drop(ctx.id); } catch { /* held by an operation: left to the gc */ }
        throw new ToolError(`${e.message} — nothing was started: correct the step and start again`, { stage: e.stage || 'compile', field: e.field || 'steps', code: e.code });
      }
      throw new ToolError(`${e.message} — the draft ${ctx.id} is started, with no steps: add them with add_steps (context_id: "${ctx.id}")`, { stage: e.stage || 'compile', field: e.field || 'steps', code: e.code });
    }
    const { context_id: _id, action: _a, ...rest } = added;
    // the steps are what add_steps says they are (steps_added + steps_count, or steps with include: ["steps"]);
    // the start's own hints are for a draft with no steps, so with steps added only the one to build them
    // is still said — and not when this call builds them itself (its `next` says what comes after)
    const { steps: _none, recommendations: _hints, ...head } = resp;
    if (head.warnings && rest.warnings) rest.warnings = [...head.warnings, ...rest.warnings];
    return this._draftThenBuild(ctx, ctx.state.draft, input, { ...head, ...rest, next: added.next || resp.next, ...(input.materialize ? {} : { recommendations: [buildHint] }) });
  },

  /**
   * Append steps — one or several — in one call, applied SEQUENTIALLY. The response folds the per-step
   * effects together — for each step, how it changed the columns (added / removed count) and any
   * warnings — so you see the same "how each application affected the data" detail as adding them
   * one at a time, in a single reply. ATOMIC: if any step fails validation the whole batch is
   * rolled back (nothing applied) and the failing step is named. One step is a list of one: there
   * is no second action for it. `building`: the same call goes on to build them (materialize: true),
   * so a step is not told to materialize when done.
   */
  async _draftAddSteps(ctx, draft, stages, includeColumns = false, includeSteps = false, { building = false } = {}) {
    if (!Array.isArray(stages) || !stages.length) throw new ToolError('add_steps needs a non-empty `steps` array', { stage: 'validate', field: 'steps' });
    const snapshot = draft.stages.slice(); // atomic: restore on any failure so the draft is never half-applied
    const effects = [];
    const said = new Set();
    let last = null; const dropped = [];
    try {
      for (const [i, stage] of stages.entries()) {
        let r;
        // named by its place in `steps`, one step or several (`step` is edit_step's field, not this one's)
        try { r = await this._draftCommit(ctx, draft, [...draft.stages, stage], { changedStage: stage, includeColumns: false, includeSteps: true, action: 'add_steps', building }); }
        catch (e) { throw new ToolError(`steps[${i}]: ${e.message}`, { stage: e.stage || 'compile', field: `steps[${i}]`, code: e.code }); }
        last = r; if (r.checkpoints_dropped) dropped.push(...r.checkpoints_dropped);
        effects.push({
          step_index: r.step_index,
          stage: stage.stage,
          column_count: r.column_count,
          columns_added: r.columns_added,
          columns_removed_count: r.columns_removed_count,
          ...(r.columns_removed ? { columns_removed: r.columns_removed } : {}),
          // per-step warnings/nudges (filter guard, empty-combination, funnel, etc.) — one said by an earlier
          // step of this call is not said again
          ...(() => { const own = sayOnce(r.recommendations, said); return own.length ? { recommendations: own } : {}; })(),
        });
      }
    } catch (e) {
      draft.stages = snapshot; this.ctxs.touch(ctx.id);
      if (stages.length === 1) throw e;
      throw new ToolError(`${e.message} — none of the ${stages.length} steps was added (fix that one and send them again)`, { stage: e.stage || 'compile', field: e.field || 'steps', code: e.code });
    }
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const after = this._draftColumns(draft, physSet);
    // the steps just added — the caller has the earlier ones; the whole list with include: ["steps"] or preview
    const all = this._draftSteps(draft, physSet);
    const resp = {
      context_id: ctx.id, action: 'add_steps',
      // (each said by where it stands and what it is: the caller just sent them — include: ["steps"] gives them whole)
      ...(includeSteps ? { steps: all } : { steps_added: all.slice(-effects.length).map(stepBrief), steps_count: all.length }),
      // what EACH step did to the data, in order: read it top to bottom to see where it narrowed or widened
      step_effects: effects,
      column_count: after.length,
      ...(last.from_checkpoint ? { from_checkpoint: last.from_checkpoint, steps_recomputed: last.steps_recomputed } : {}),
      ...(dropped.length ? { checkpoints_dropped: dropped } : {}),
      next: 'Check step_effects (each step\'s column changes and recommendations), then add the next logical chunk, fix a step (edit_step; fork to go back to step N), or materialize. include: ["columns"] or preview gives the full column list.',
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  },

  /** Where a column a join step before `stage` brought in lives in the value index — the joined model's
   *  attribute — or null (no join brought it, or the model does not index it). */
  _joinedAttribute(stages, stage, name) {
    const at = stages.indexOf(stage);
    for (const st of (at < 0 ? stages : stages.slice(0, at)).slice().reverse()) {
      if (st?.stage !== 'join') continue;
      const a = (st.attrs || []).find((x) => (x.name ?? x.column) === name);
      if (a) return this.catalog.attributeKind(st.source, a.column) ? { source: st.source, property: a.column } : null;
    }
    return null;
  },

  /** Validate `index` (1-based) against the current stage count for an edit op. */
  _stepIndex(draft, index, action) {
    if (!Number.isInteger(index) || index < 1 || index > draft.stages.length) {
      throw new ToolError(`${action} index=${index} out of range — the draft has ${draft.stages.length} step(s); use 1..${draft.stages.length} (see steps[].index)`, { stage: 'validate', field: 'index' });
    }
    return index;
  },

  /** Replace step N in place (then revalidate the whole pipeline end-to-end). */
  async _draftEditStep(ctx, draft, index, stage, includeColumns = false, includeSteps = false) {
    const i = this._stepIndex(draft, index, 'edit_step');
    const next = draft.stages.slice(); next[i - 1] = stage;
    return this._draftCommit(ctx, draft, next, { changedStage: stage, includeColumns, includeSteps, action: 'edit_step', stepIndex: i, dropFrom: i });
  },

  /** Put `stage` in as step N — the step there and those after it move one on — then revalidate. */
  async _draftInsertStep(ctx, draft, index, stage, includeColumns = false, includeSteps = false) {
    if (!Number.isInteger(index) || index < 1 || index > draft.stages.length + 1) {
      throw new ToolError(`insert_step index=${index} out of range — the draft has ${draft.stages.length} step(s): a step goes in at 1..${draft.stages.length + 1} (${draft.stages.length + 1} appends, as add_steps does)`, { stage: 'validate', field: 'index' });
    }
    const next = draft.stages.slice(); next.splice(index - 1, 0, stage);
    return this._draftCommit(ctx, draft, next, { changedStage: stage, includeColumns, includeSteps, action: 'insert_step', stepIndex: index, dropFrom: index });
  },

  /** Remove step N — those after it move one back — then revalidate what follows without it. */
  async _draftDeleteStep(ctx, draft, index, includeColumns = false, includeSteps = false) {
    const i = this._stepIndex(draft, index, 'delete_step');
    const next = draft.stages.slice(); next.splice(i - 1, 1);
    // (the answer names the step removed; step_index is the one now in its place — none where it was the last)
    const r = await this._draftCommit(ctx, draft, next, { includeColumns, includeSteps, action: 'delete_step', stepIndex: i <= next.length ? i : null, dropFrom: i });
    const { step_index: now, step: placed, ...rest } = r;
    return { ...rest, deleted_step: i, ...(i <= next.length ? { step_index: now, ...(placed ? { step: placed } : {}) } : {}) };
  },

  /**
   * Branch a NEW draft from an existing draft (or an already-materialized pipeline) keeping
   * steps 1..after — so you iterate on a variant WITHOUT re-typing the shared prefix and
   * WITHOUT touching the original. after omitted → copy every step. A fork is a draft of its own,
   * under the name the call gives it (required): its builds are told apart from the original's.
   */
  async _draftFork(input) {
    const src = this._ctx(input.context_id);
    const origin = src.state.draft || src.state.pipeline_origin; // live draft, or the snapshot a materialize left behind
    if (!origin) throw new ToolError(`context '${input.context_id}' has no draft or built pipeline to fork — start one, or fork a context whose pipeline was materialized`, { stage: 'validate', field: 'context_id' });
    // the semantic_model step, the build's last, is one past its stages
    const total = origin.stages.length + (origin.semantic ? 1 : 0);
    const after = input.after == null ? total : input.after;
    if (!Number.isInteger(after) || after < 0 || after > total) throw new ToolError(`fork after=${input.after} out of range — the source has ${total} step(s); use 0..${total}`, { stage: 'validate', field: 'after' });
    const ctx = this.ctxs.create();
    const name = input.name;
    // Deep-copy the kept stages so editing the fork can never mutate the source's stages.
    const description = input.description || origin.description;
    ctx.state.draft = { name, source: origin.source, materialized: origin.materialized || 'table', time_range: origin.time_range || null, stages: origin.stages.slice(0, after).map((s) => JSON.parse(JSON.stringify(s))), ...(origin.semantic && after === total ? { semantic: JSON.parse(JSON.stringify(origin.semantic)) } : {}), checkpoints: [], ...(origin.base ? { base: JSON.parse(JSON.stringify(origin.base)) } : {}), ...(description ? { description } : {}) };
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
      materializes_as: ctx.state.draft.materialized, copied_steps: after, step_index: after,
      // the caller has the steps it forked; every one of them with include: ["steps"] (or preview)
      ...(included(input).steps ? { steps: this._draftSteps(ctx.state.draft, physSet) } : { steps_count: after }),
      column_count: cols.length,
      ...(inherited.length ? { inherited_checkpoints: inherited } : {}),
      next: 'Continue editing this NEW draft (add_steps / edit_step); the original is untouched. Materialize when done.',
      recommendations: [
        `Forked ${after} of ${total} step(s) into a new draft ${ctx.id}; the source ${input.context_id} is unchanged — branch variants freely.`,
        ...(broken ? [`The copied steps do not build as they are: ${broken}`] : []),
        ...(inherited.length ? [`Steps 1..${inherited[inherited.length - 1].at} are already materialized (${inherited[inherited.length - 1].model}, built in ${inherited[inherited.length - 1].owner}) and this fork READS that table: only the steps you add here are computed. Keep that context alive while this fork uses it — delete_context on it is refused unless forced.`] : []),
        `Materialize with build_model({ request: { action: "materialize", context_id: "${ctx.id}" } }).`,
      ],
    };
    if (included(input).columns) resp.available_columns = cols;
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
   * the per-step diff (columns added/removed). Powers add_steps AND edit_step: every edit
   * revalidates the ENTIRE downstream, so a change that breaks a
   * later step is reported with that step's index and the draft is left intact to fix. The
   * `changedStage` (the added/edited stage) drives the filter/scope/
   * funnel warnings.
   */
  async _draftCommit(ctx, draft, newStages, { changedStage = null, includeColumns = false, includeSteps = false, action = 'add_steps', stepIndex = null, dropFrom = null, building = false } = {}) {
    const physSet = await this.probe.grounding(draft.source, [...draft.stages, ...newStages]);
    // columns BEFORE the change — none known when the steps held no longer build: the change is what
    // mends them, and the render below validates the whole of it
    let before;
    try { before = this._draftColumns(draft, physSet); } catch { before = []; }
    // (a source's rows as the steps read them — its payload column among them, which the declared list
    // leaves out: the first step is not said to add a column it only passes through)
    if (!draft.stages.length && !draft.base) {
      try { before = [...renderPipeline(this.catalog, this.catalog.dialect, draft.source, [], { physicalCols: physSet }).columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })); } catch { /* the declared list stands */ }
    }
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
      throw new ToolError(step ? `step ${step}: ${e.message}` : e.message, { stage: 'compile', field: 'step' });
    }
    // Verify filter literals on the changed stage against the SOURCE's real values BEFORE persisting
    // — a wrong-cased/non-existent value ('organic' vs 'Organic') is flagged with the correct value.
    let filterWarnings = [];
    // A python stage's bodies pass the static gate BEFORE the draft persists them.
    if (changedStage && changedStage.stage === 'python') await this._gatePythonStage(changedStage);
    if (changedStage && changedStage.stage === 'where' && Array.isArray(changedStage.conditions)) {
      // each comparison of a column or an event property (its own value, not a field of it) with
      // constants, at any depth of and / or / not
      const specs = [];
      eachCondition(changedStage.conditions, (cd) => {
        const cmp = comparisonOf(cd);
        if (!cmp || cmp.subject.field !== undefined) return;
        const name = cmp.subject.column ?? cmp.subject.property;
        // a column a join before this step brought in is checked against the joined model's values
        const joined = cmp.subject.column !== undefined ? this._joinedAttribute(newStages, changedStage, name) : null;
        specs.push({ at: joined ?? this.advisor.valueKeyForColumn(draft.source, name), op: cmp.op, value: cmp.values, where: `where ${name}` });
      });
      filterWarnings = this.advisor.guardFilterValues(specs);
    }
    // a join's select part names a VALUE of the joined model (the experiment it keeps): checked against
    // that column's real values, as a where's constant is
    if (changedStage && changedStage.stage === 'join' && changedStage.source && changedStage.on) {
      const contract = this.catalog.joinContract(changedStage.source);
      const specs = (contract?.select || []).filter((s) => s.column && typeof changedStage.on[s.part] === 'string')
        .map((s) => ({ at: { source: changedStage.source, property: s.column }, op: 'eq', value: changedStage.on[s.part], where: `join ${changedStage.source} on.${s.part}` }));
      if (specs.length) filterWarnings = [...filterWarnings, ...this.advisor.guardFilterValues(specs)];
    }
    // a step an earlier version stored is kept from now on in the spelling it was built in — the
    // render's, resolved against the columns before it (src/pipeline/earlier.js); a step the render
    // did not reach (a materialized prefix) was respelled by the build that made its checkpoint, and is
    // shown as the build renders it (_draftSteps)
    draft.stages = rendered ? newStages.map((st) => rendered.current.get(st) ?? st) : newStages;
    // The edit is accepted: the checkpoints it invalidated (and any that went stale) go now, and
    // the files of the ones nobody else reads go with them.
    const why = `step ${dropFrom} was ${action === 'delete_step' ? 'deleted' : action === 'insert_step' ? 'put in before it' : 'edited'}`;
    const retiredNow = this._applyCheckpointPlan(ctx, draft, plan, why);
    this.ctxs.touch(ctx.id);
    const after = rendered
      ? [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }))
      : this._draftColumns(draft, physSet);
    const beforeNames = new Set(before.map((c) => c.name));
    const afterNames = new Set(after.map((c) => c.name));
    const removed = before.filter((c) => !afterNames.has(c.name)).map((c) => c.name);
    const allSteps = this._draftSteps(draft, physSet);
    // The caller already saw every step in earlier answers, so echoing the whole (growing) list on each
    // call is O(n²) waste across a build. By default: the step this call put in place (an edit's) and
    // steps_count; every step with include: ["steps"]
    // or preview. The retentioneering builder answers the same way.
    // a distinct count grouped by a slowly-changing model's column: said where its columns do change between versions
    const versioned = [];
    for (const g of changedStage ? this.advisor.versionedDistinctGroups(newStages, changedStage, draft.base ? null : draft.source) : []) {
      if (await this.probe.versionsDiffer(g.model, g.columns) !== false) versioned.push(g);
    }
    const leanSteps = !includeSteps;
    const origin = draft.base ? `task ${draft.base.task_id}'s table` : `'${draft.source}'`;
    const resp = {
      context_id: ctx.id, action, step_index: stepIndex ?? draft.stages.length,
      ...(leanSteps
        ? { ...(changedStage ? { step: stepBrief(allSteps.find((s) => s.index === (stepIndex ?? draft.stages.length)) || allSteps[allSteps.length - 1]) } : {}), steps_count: allSteps.length }
        : { steps: allSteps }),
      column_count: after.length,
      columns_added: after.filter((c) => !beforeNames.has(c.name)),
      // Compact by default: a step that drops 200 columns must not reprint 200 names every call.
      // Always give the count; include the full list only when it is short or include asks for the columns.
      columns_removed_count: removed.length,
      ...((includeColumns || removed.length <= 10) ? { columns_removed: removed } : {}),
      ...(plan.checkpoint ? { from_checkpoint: { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at }, steps_recomputed: newStages.length - plan.checkpoint.at } : {}),
      ...(retiredNow.length ? { checkpoints_dropped: retiredNow } : {}),
      next: action === 'add_steps'
        ? 'add_steps the next steps; or fix a prior step with edit_step (fork to go back to step N); or materialize. Pass include: ["columns"] / preview for the full column list.'
        : `Pipeline revalidated end-to-end after the ${action === 'delete_step' ? 'removal' : action === 'insert_step' ? 'insertion' : 'edit'}. Continue editing, preview, or materialize (include: ["columns"] for the full list).`,
      recommendations: [
        ...filterWarnings,
        ...(versioned.length ? [this.advisor.versionedDistinctNote(versioned)] : []),
        // (said once per materialized prefix: the steps after it read it until an edit at or before it)
        ...(plan.checkpoint && draft.told_prefix !== plan.checkpoint.model ? [`Steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model}: this step reads THAT table, so the prefix is not recomputed. Editing a step at or before ${plan.checkpoint.at} retires it and the next materialize rebuilds from ${origin}.`] : []),
        ...(retiredNow.length ? [`Materialized prefix retired (${retiredNow.map((r) => `step ${r.at}: ${r.reason}`).join('; ')}) — the next materialize recomputes from ${plan.checkpoint ? `the prefix still materialized, steps 1..${plan.checkpoint.at} (${plan.checkpoint.model})` : origin}.`] : []),
        ...(changedStage ? [...this.advisor.eventScopeWarnings(draft, changedStage), ...this.advisor.emptyCombinationWarnings(draft, changedStage), ...this.advisor.funnelCompletionWarnings(changedStage), ...this.advisor.pythonPreparationWarnings(changedStage, { source: draft.source, stages: draft.stages, timeRange: draft.time_range, startsFromTable: !!plan.from }, stepIndex != null ? stepIndex - 1 : draft.stages.indexOf(changedStage)), ...this.advisor.globalWindowWarnings(changedStage), ...this.advisor.offsetMaturityWarnings(changedStage), ...this.advisor.stepRecommendations(changedStage, this._columnsAfter(draft, physSet, stepIndex, after), { building })] : []),
      ],
    };
    if (plan.checkpoint) draft.told_prefix = plan.checkpoint.model;
    // what a step's answer said of it is not said again by the build of the draft (the latest few kept)
    draft.said = [...new Set([...(draft.said || []), ...resp.recommendations])].slice(-30);
    // how to preview is said on the draft's first step, not on every one after it
    if (draft.told_preview) resp.recommendations = resp.recommendations.filter((r) => !r.startsWith('Preview the SQL anytime'));
    else if (resp.recommendations.some((r) => r.startsWith('Preview the SQL anytime'))) draft.told_preview = true;
    if (includeColumns) resp.available_columns = after;
    return resp;
  },

  /**
   * THE DRAFT CHECKED BY THE WAREHOUSE, READING NO DATA — preview with validate: a task (read with
   * query_model) that writes the SQL a materialize would build, under names of its own, and
   * runs it with `dbt run --empty`: every ref and source limited to zero rows, so the warehouse
   * compiles and plans the very SQL (a type mismatch, an unknown name, a syntax error is refused as
   * it would be) and reads nothing. The models are removed afterwards whatever the outcome — a
   * failing one left in the project would fail every later build of the context. A python model is
   * not run empty: the check covers the SQL models before the first one.
   */
  async _draftValidate(ctx, draft) {
    if (!draft.stages.length) throw new ToolError('draft has no steps to validate — add_steps first', { stage: 'validate', field: 'context_id' });
    if (!this.runner?.run) throw new ToolError('no warehouse runner configured — nothing to validate against', { stage: 'validate' });
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const plan = this._renderPlan(draft);
    // every step already built: the warehouse ran it whole, which is the check — answered so, not refused
    if (plan.checkpoint && !plan.stages.length) {
      const built = this._startTask(ctx, 'build_pipeline_model', async () => ({ ok: true, validated: true, context_id: ctx.id, checked: [], note: `every step is already materialized as ${plan.checkpoint.model}: the warehouse built it, so there is nothing left to check — query it, or add_steps and validate those` }), { input: { action: 'preview', validate: true, context_id: ctx.id, name: draft.name } });
      return this._taskStarted(built, { context_id: ctx.id });
    }
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
    }, { input: { action: 'preview', validate: true, context_id: ctx.id, name: draft.name, source: draft.source, steps: draft.stages } });
    return this._taskStarted(taskId, { context_id: ctx.id });
  },

  async _draftPreview(ctx, draft) {
    const dialect = this.catalog.dialect;
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const base = { context_id: ctx.id, action: 'preview', name: draft.name, source: draft.source, materializes_as: draft.materialized, dialect, steps: this._draftSteps(draft, physSet) };
    // the semantic_model step: the layer it declares, as it would be written (src/yaml-render.js) — over the
    // source, or beside the SQL of the table it stands on
    const layer = draft.semantic ? await this._semanticLayerOf(ctx, draft, draft.semantic) : null;
    const semantic = layer ? { semantic_models: layer.render.semanticModels, metrics: layer.render.metricNames, yaml: layer.render.yaml, warnings: layer.render.warnings || [] } : {};
    if (draft.semantic && !draft.stages.length) return { ...base, ...semantic };
    if (!draft.stages.length) return { ...base, available_columns: this._groundedDeclared(draft.source, physSet).cols, note: 'No steps yet — add_steps first.' };
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
      ...base, ...semantic, available_columns: [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
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
