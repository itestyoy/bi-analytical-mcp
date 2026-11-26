// A SCHEDULED MODEL — a build whose table is computed again every day, kept with what it means.
//
// build_model({ action: "schedule", context_id, grain, columns }) turns a context's draft into one:
//   * its steps are FIXED as they are (nothing is added to, edited in or rebuilt from it after — a change is
//     a fork, scheduled anew, and this one deleted);
//   * its table is a dbt model of a name of its own (`pipe_<name>_<context>_sched`), with no expiry, built
//     from where the draft starts — the source, or the table of another SCHEDULED model (a table computed
//     once would be recomputed the same every day) — never from a checkpoint;
//   * what it means is required: the build's description and question (said at its start), what one row is
//     (`grain`) and what every column means (`columns`: a description, a unit where it has one — a column
//     taken unchanged from the source or the scheduled model it starts from may leave it to the one it
//     has there). Where each column comes from (`computed`: the step that made it and its expression) is
//     read off the steps, never written by hand. The descriptions are written onto the table too
//     (persist_docs, where the warehouse keeps them), so whoever reads the table reads them;
//   * it is refreshed DAILY after the value index's sync (src/scheduled-models.js), at most once a UTC day,
//     the run beside the queries of its context (they read the table as it stands until the new one
//     replaces it);
//   * a model nobody has queried for MCP_SCHEDULED_IDLE_DAYS is put to sleep — not refreshed — and the
//     next query wakes it: that query answers from the table as it is, saying so, and a refresh starts.
//
// Its context id is its key, as every context's: whoever holds it reads (query_model), describes and
// deletes it. Deleting it drops its table from the warehouse.

import yaml from 'js-yaml';
import { ToolError } from '../validate.js';
import { getDialect } from '../dialects/index.js';
import { formatDbtError } from '../dbt/index.js';
import { MAX_WAIT_SECONDS } from '../schema.js';

const plain = (x) => JSON.parse(JSON.stringify(x));

/** Where a column a step makes comes from, as data: the step, its stage, and what it says of that column. */
function stepOrigin(st, name, step) {
  const at = { step, stage: st.stage };
  switch (st.stage) {
    case 'compute': return { ...at, expr: plain(st.expr) };
    case 'aggregate': {
      const m = (st.measures || []).find((x) => x.name === name);
      return m ? { ...at, expr: plain(m.expr), ...(st.group_by?.length ? { group_by: plain(st.group_by) } : {}) } : at;
    }
    case 'pivot': return { ...at, on: plain(st.on), measure: plain(st.measure), ...(st.group_by?.length ? { group_by: plain(st.group_by) } : {}) };
    case 'unpivot': return { ...at, columns: plain(st.columns) };
    case 'unnest': return { ...at, expr: plain(st.expr), ...(st.field ? { field: st.field } : {}) };
    case 'join': return { ...at, source: st.source };
    default: return at;
  }
}

/** The columns a step keeps under their name while it re-derives the rows (its grouping keys). */
const keysOf = (st) => (['aggregate', 'pivot'].includes(st.stage) ? (st.group_by || []).filter((k) => typeof k === 'string') : st.stage === 'unpivot' ? (st.keep || []).filter((k) => typeof k === 'string') : []);

export const scheduledMethods = {
  /** The dbt model a scheduled build's table is — a name no build of the draft takes. */
  _scheduledModelName(ctx, draft) {
    return `pipe_${draft.name}_${ctx.id}_sched`;
  },

  /** The refusal of a change to a scheduled model: its steps are fixed. */
  _scheduledFixed(ctx) {
    return new ToolError(
      `context ${ctx.id} is a scheduled model: its steps are fixed as they were scheduled — nothing is added to, changed in or rebuilt from it. `
      + `To change it, fork it (build_model({ request: { action: "fork", context_id: "${ctx.id}", name, description, question } }) — a new draft with its steps), change and schedule the fork, and delete this one (context({ request: { action: "delete", context_id: "${ctx.id}" } }))`,
      { stage: 'validate', field: 'context_id' },
    );
  },

  /**
   * Each column of the draft's table → where it comes from: the source's column ({ from: 'source',
   * source, column }), the scheduled table the draft starts from ({ from: 'base', column }), or the step
   * that last made it (stepOrigin). A grouping key keeps where it came from.
   */
  _columnOrigins(draft, physSet, last) {
    const first = draft.base ? draft.base.columns.map((c) => c.name) : this._groundedDeclared(draft.source, physSet).cols.map((c) => c.name);
    let origins = new Map(first.map((n) => [n, draft.base ? { from: 'base', column: n } : { from: 'source', source: draft.source, column: n }]));
    const spelled = this._draftSpelling(draft, physSet);
    draft.stages.forEach((raw, i) => {
      const st = spelled.get(raw) ?? raw;
      const after = this._columnsAfter(draft, physSet, i + 1, last).map((c) => c.name);
      const kept = keysOf(st);
      const rederives = ['aggregate', 'pivot', 'unpivot'].includes(st.stage);
      const next = new Map();
      for (const n of after) {
        const carried = origins.has(n) && (rederives ? kept.includes(n) : true);
        next.set(n, carried ? origins.get(n) : stepOrigin(st, n, i + 1));
      }
      origins = next;
    });
    return origins;
  },

  /** The description a column taken unchanged has where it comes from: the catalog's, or the scheduled base's. */
  _inheritedDescription(draft, origin, base) {
    if (origin?.from === 'source') {
      const d = this.catalog.columnDescriptions(origin.source)?.[origin.column];
      return d ? { description: d, from: 'catalog' } : null;
    }
    if (origin?.from === 'base' && base) {
      const owner = this.ctxs.has(base.context_id) ? this.ctxs.get(base.context_id).state.scheduled : null;
      const c = owner?.columns?.find((x) => x.name === origin.column);
      return c?.description ? { description: c.description, ...(c.unit ? { unit: c.unit } : {}), from: 'base' } : null;
    }
    return null;
  },

  /**
   * build_model({ action: "schedule" }): the draft becomes a scheduled model — checked in the call (its
   * steps, where it starts, every column's meaning), then its first build started as a task; the answer is
   * that task's, as a materialize's is.
   */
  async _scheduleDraft(ctx, draft, input) {
    if (ctx.state.scheduled) throw new ToolError(`context ${ctx.id} is a scheduled model already — context({ request: { action: "describe", context_id: "${ctx.id}" } }) shows it`, { stage: 'validate', field: 'context_id' });
    if (draft.building) throw new ToolError(`a build of this draft is running (started ${draft.building.started_at}) — schedule it once that build is done`, { stage: 'validate', field: 'context_id' });
    if (!draft.stages.length) {
      throw new ToolError(`nothing to compute again: this build has no steps${draft.semantic ? ' before its semantic_model step' : ''}, so it reads ${draft.base ? `task ${draft.base.task_id}'s table` : `'${draft.source}'`} as it is and is as fresh as that. A scheduled model is the table its steps compute — add them first`, { stage: 'validate', field: 'context_id' });
    }
    let base = null;
    if (draft.base) {
      const owner = this.ctxs.has(draft.base.owner) ? this.ctxs.get(draft.base.owner) : null;
      if (owner?.state?.scheduled?.model !== draft.base.model) {
        throw new ToolError(
          `this build starts from task ${draft.base.task_id}'s table, which was computed once and is not computed again — scheduled, it would compute the same rows every day. `
          + 'Schedule the build that table comes from, and start this one from a task of that scheduled model (its first build, or a refresh: context describe of it names them)',
          { stage: 'validate', field: 'context_id' },
        );
      }
      base = { context_id: owner.id, model: draft.base.model };
    } else if (this._unboundedInTime(draft.source, draft.time_range, draft.stages)) {
      throw this._unboundedPipelineError(draft.source);
    }

    // what every column means: given, or — taken unchanged — the description it has where it comes from
    const physSet = await this.probe.grounding(draft.source, draft.stages);
    const columns = this._draftColumns(draft, physSet);
    const origins = this._columnOrigins(draft, physSet, columns);
    const given = new Map((input.columns || []).map((c) => [c.name, c]));
    const unknown = [...given.keys()].filter((n) => !columns.some((c) => c.name === n));
    if (unknown.length) throw new ToolError(`columns: ${unknown.join(', ')} — no column of the table; its columns: ${columns.map((c) => c.name).join(', ')}`, { stage: 'validate', field: 'columns' });
    const missing = [];
    const described = [];
    for (const c of columns) {
      const g = given.get(c.name);
      const origin = origins.get(c.name) || null;
      const inherited = g ? null : this._inheritedDescription(draft, origin, base);
      if (!g && !inherited) { missing.push(c.name); continue; }
      const unit = g ? g.unit : inherited.unit;
      described.push({ name: c.name, type: c.type, description: g ? g.description : inherited.description, ...(unit ? { unit } : {}), ...(inherited ? { description_from: inherited.from } : {}), ...(origin ? { computed: origin } : {}) });
    }
    if (missing.length) {
      throw new ToolError(
        `columns: what every column of a scheduled model means is said, so whoever reads its table can tell — ${missing.length} of them say nothing: ${missing.join(', ')}. `
        + 'Give each in columns: [{ name, description, unit? }] (a column taken unchanged from the source or the scheduled model the build starts from uses the description it has there, where it has one)',
        { stage: 'validate', field: 'columns' },
      );
    }

    const model = this._scheduledModelName(ctx, draft);
    // a layer over the table: checked on a copy now (nothing written), written once the table stands
    if (draft.semantic) await this._semanticLayerOf(ctx, draft, draft.semantic, { table: model });
    const warnings = [];
    if (!draft.base && (draft.time_range?.start || draft.time_range?.end)) {
      warnings.push(`its window is fixed (${draft.time_range.start || '…'} to ${draft.time_range.end || '…'}): every refresh computes that same period again. For a window that moves with the days, fork it with a where step comparing the time column with { now: true } (date_diff) instead of time_range, and schedule the fork.`);
    }
    const now = new Date().toISOString();
    ctx.state.scheduled = {
      name: draft.name, model, models: [model], source: draft.source,
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.question ? { question: draft.question } : {}),
      grain: input.grain, columns: described,
      ...(base ? { base } : {}),
      ...(warnings.length ? { warnings } : {}),
      created_at: now, last_queried_at: now,
    };
    this.ctxs.touch(ctx.id);

    const spelled = this._draftSpelling(draft, physSet);
    const stages = draft.stages.map((s) => plain(spelled.get(s) ?? s));
    const build = () => {
      const taskId = this._startTask(ctx, 'build_pipeline_model', (id) => this._scheduledFirstBuild(ctx, draft, stages, id, warnings), {
        input: { action: 'schedule', context_id: ctx.id, name: draft.name, source: draft.source, grain: input.grain, steps: stages },
      });
      return this._taskStarted(taskId, { context_id: ctx.id, model });
    };
    return draft.semantic ? this._materializeLayer(ctx, draft, { buildTable: build }) : build();
  },

  /** The first build of a scheduled model, in its task: the table, its description, its relation. */
  async _scheduledFirstBuild(ctx, draft, stages, taskId, warnings) {
    const spec = ctx.state.scheduled;
    const startedAt = new Date().toISOString();
    const result = await this._registerPipeline({
      name: draft.name, context_id: ctx.id, materialized: 'table',
      ...(draft.description ? { description: draft.description } : {}),
      pipeline: { source: draft.source, time_range: draft.base ? undefined : (draft.time_range || undefined), stages },
      ...(draft.base ? { from_checkpoint: { at: 0, model: draft.base.model, columns: draft.base.columns } } : {}),
      model_name: spec.model,
      scheduled: spec,
      ...(draft.semantic ? { declared: draft.semantic } : {}),
    }, { taskId });
    if (!result || result.ok === false) {
      // a model whose first build fails is no scheduled model: the draft is open again, to be fixed
      delete ctx.state.scheduled;
      this.ctxs.removePipelineFiles(ctx.id, spec.model);
      this.ctxs.touch(ctx.id);
      return { ...result, scheduled: false, note: 'the first build failed, so nothing is scheduled: the draft is open again — fix it and schedule it again' };
    }
    spec.models = (result.models || []).map((m) => m.model);
    if (!spec.models.length) spec.models = [spec.model];
    spec.table = await this._scheduledRelation(ctx, spec);
    spec.last_run = { task_id: taskId, started_at: startedAt, finished_at: new Date().toISOString(), ok: true, rows: result.page?.total ?? result.row_count ?? null, reason: 'scheduled' };
    spec.refreshed_at = spec.last_run.finished_at;
    this.ctxs.touch(ctx.id);
    return {
      ...result,
      scheduled: this._scheduledView(ctx),
      ...(warnings.length ? { warnings: [...(result.warnings || []), ...warnings] } : {}),
    };
  },

  /** The warehouse relation of a scheduled model's table ("database.schema.table"), best effort. */
  async _scheduledRelation(ctx, spec) {
    if (!this.runner?.execute) return null;
    const r = await this.probe.bestEffort(`scheduled-relation:${ctx.id}`, () => this.runner.execute(this.ctxs.dir(ctx.id), spec.model, ['SELECT 1 AS one']));
    const rel = r?.ok ? r.relation : null;
    return rel ? [rel.database, rel.schema, rel.identifier].filter(Boolean).join('.') : null;
  },

  /**
   * The model's description and its columns', written beside its table's model (the last of its chain):
   * a SQL model gets a YAML entry of its own, a Python model's own YAML takes them — with persist_docs on a
   * warehouse that writes them onto the table.
   */
  _writeScheduledDocs(ctxId, last, spec) {
    const persist = getDialect(this.catalog.dialect).persistsDocs ? { persist_docs: { relation: true, columns: true } } : null;
    const describe = [
      spec.description, spec.question ? `Question: ${spec.question}` : null, `One row: ${spec.grain}.`,
      'A scheduled model: computed again daily after the warehouse\'s own models are.',
    ].filter(Boolean).join('\n');
    const columns = spec.columns.map((c) => ({ name: c.name, description: c.unit ? `${c.description} (${c.unit})` : c.description }));
    const file = `${last.model}.yml`;
    if (last.kind === 'python') {
      const doc = yaml.load(last.yml) || {};
      const entry = (doc.models || []).find((m) => m.name === last.model);
      if (entry) {
        entry.description = describe;
        entry.columns = columns;
        if (persist) entry.config = { ...(entry.config || {}), ...persist };
      }
      this.ctxs.writeFile(ctxId, file, yaml.dump(doc, { lineWidth: -1 }));
      return;
    }
    this.ctxs.writeFile(ctxId, file, yaml.dump({ version: 2, models: [{ name: last.model, description: describe, ...(persist ? { config: persist } : {}), columns }] }, { lineWidth: -1 }));
  },

  /** Whether a scheduled model's refresh is running now. */
  _scheduledRefreshing(spec) {
    const id = spec?.last_run?.task_id;
    return !!(id && !spec.last_run.finished_at && this.jobs.get(id)?.status === 'running');
  },

  /**
   * Compute a scheduled model's table again — its own models of the chain, as they were written when it
   * was scheduled — as a task of the context run BESIDE its queries (they read the table as it stands
   * until the new one replaces it). One at a time. → the task id, or null (nothing to refresh).
   */
  _refreshScheduled(id, reason = 'daily') {
    const ctx = this.ctxs.has(id) ? this.ctxs.get(id) : null;
    const spec = ctx?.state?.scheduled;
    if (!spec?.refreshed_at) return null; // its first build has not stood yet
    if (!this.runner) return null;
    if (this._scheduledRefreshing(spec)) return spec.last_run.task_id;
    const startedAt = new Date().toISOString();
    const dir = this.ctxs.dir(ctx.id);
    const taskId = this._startTask(ctx, 'build_pipeline_model', async (tid) => {
      const r = await this.runner.run(dir, spec.models.join(' '));
      let out;
      if (!r.ok) {
        const message = spec.models.length > 1 ? this._pythonRunMessage(r.stdout, r.stderr) : this._sqlRunMessage(r.stdout, r.stderr);
        out = { ok: false, context_id: ctx.id, kind: 'pipeline', error: { stage: 'run', message: message || formatDbtError(r.stdout, r.stderr) } };
      } else {
        const n = await this.probe.bestEffort(`scheduled-count:${ctx.id}:${tid}`, () => this.runner.execute(dir, spec.model, ['SELECT count(*) AS n FROM __MCP_RELATION__']));
        const rows = n?.ok && n.rows?.[0]?.n != null ? Number(n.rows[0].n) : null;
        out = { ok: true, context_id: ctx.id, kind: 'pipeline', model: spec.model, refreshed: true, reason, row_count: 0, rows: [], ...(rows != null ? { table_rows: rows } : {}) };
      }
      const now = new Date().toISOString();
      if (ctx.state.scheduled === spec) {
        spec.last_run = { task_id: tid, started_at: startedAt, finished_at: now, ok: !!out.ok, ...(out.table_rows != null ? { rows: out.table_rows } : {}), reason, ...(out.ok ? {} : { error: out.error.message.slice(0, 2000) }) };
        if (out.ok) {
          spec.refreshed_at = now;
          if (ctx.state.pipeline_model) ctx.state.pipeline_model.task_id = tid; // a read of the model names its latest build
        }
        this.ctxs.touch(ctx.id);
      }
      return out.ok ? { ...out, scheduled: this._scheduledView(ctx) } : out;
    }, { input: { action: 'refresh', context_id: ctx.id, reason }, batch: { before: null } });
    spec.last_run = { task_id: taskId, started_at: startedAt, reason };
    this.ctxs.touch(ctx.id);
    // its table is what a read of the task pages (it keeps no rows of its own)
    this.jobs.setTable(taskId, spec.model, { contextId: ctx.id, keptRows: 0 });
    return taskId;
  },

  /**
   * A QUERY OF A SCHEDULED MODEL: what its answer says of the model (`scheduled`), and — the model asleep
   * — the wake-up: the query answers from the table as it is, and a refresh starts once it is answered.
   * Returns { wrap(work), after(ids) }: `wrap` adds the note to a query's result, `after` (once the
   * queries are started, their task ids) records the use and wakes the model.
   */
  _scheduledQuery(ctx) {
    const held = { woke: null, refresh: null };
    return {
      wrap: (work) => async (id) => {
        const out = await work(id);
        if (!out || typeof out !== 'object' || out.ok === false) return out;
        return { ...out, scheduled: this._scheduledNote(ctx, held) };
      },
      after: (ids = []) => {
        const spec = ctx.state.scheduled;
        if (!spec) return;
        spec.last_queried_at = new Date().toISOString();
        if (spec.suspended) {
          held.woke = spec.suspended;
          delete spec.suspended;
        }
        this.ctxs.touch(ctx.id);
        if (!held.woke) return;
        // the refresh waits for the queries: they read the table as it was, not the one it writes
        void (async () => {
          while (ids.some((id) => this.jobs.get(id)?.status === 'running')) await this.tasks.await(ids, MAX_WAIT_SECONDS);
          held.refresh = this._refreshScheduled(ctx.id, 'woken by a query');
        })().catch(() => { /* the next sync refreshes it */ });
      },
    };
  },

  /** What a query's answer says of the scheduled model it read. */
  _scheduledNote(ctx, held = {}) {
    const spec = ctx.state.scheduled || {};
    const refreshing = this._scheduledRefreshing(spec);
    const note = held.woke
      ? `This scheduled model had been taken out of its daily refresh on ${held.woke.at}: nobody had queried it for ${held.woke.idle_days} days. This query woke it — these rows are its table as last refreshed${spec.refreshed_at ? ` (${spec.refreshed_at})` : ''}, and a refresh starts as this answer is given; query again in a while for the current data.`
      : refreshing ? `A refresh of this scheduled model is running: these rows are its table as last refreshed${spec.refreshed_at ? ` (${spec.refreshed_at})` : ''}.` : null;
    return {
      refreshed_at: spec.refreshed_at || null,
      ...(refreshing || held.woke ? { refreshing: true } : {}),
      ...(held.woke ? { woken: true, slept_since: held.woke.at, reason: 'unused' } : {}),
      ...(note ? { note } : {}),
    };
  },

  /** A scheduled model as describe shows it: what it is, what it means, how it is kept. */
  _scheduledView(ctx) {
    const s = ctx.state.scheduled;
    if (!s) return null;
    return {
      table: s.table || null,
      refresh: 'daily, after the value index\'s sync (which first builds the warehouse\'s own models), at most once a UTC day',
      ...(s.description ? { description: s.description } : {}),
      ...(s.question ? { question: s.question } : {}),
      grain: s.grain,
      source: s.source,
      ...(s.base ? { starts_from: 'the table of another scheduled model' } : {}),
      columns: s.columns,
      created_at: s.created_at,
      refreshed_at: s.refreshed_at || null,
      ...(s.last_run ? { last_run: s.last_run } : {}),
      ...(this._scheduledRefreshing(s) ? { refreshing: true } : {}),
      last_queried_at: s.last_queried_at || null,
      ...(s.suspended ? { asleep: { since: s.suspended.at, reason: `not queried for ${s.suspended.idle_days} days — the next query wakes it` } } : {}),
      ...(s.warnings?.length ? { warnings: s.warnings } : {}),
      read_with: `query_model({ request: { context_id: "${ctx.id}", name, description, question, steps } })${(ctx.state.metrics || []).length ? ' — a metrics step for its metrics, read steps for its table' : ''}`,
    };
  },

  /** Drop a scheduled model's tables from the warehouse (its chain's models), before its context goes. */
  async _dropScheduledTables(ctx) {
    const spec = ctx.state.scheduled;
    if (!spec || !this.runner?.execute) return [];
    const dropped = [];
    for (const model of [...(spec.models || [spec.model])].reverse()) {
      const r = await this.runner.execute(this.ctxs.dir(ctx.id), model, ['DROP TABLE IF EXISTS __MCP_RELATION__']).catch(() => null);
      if (r?.ok) dropped.push(model);
    }
    return dropped;
  },
};
