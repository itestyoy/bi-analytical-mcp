// READING A TASK BACK, AND SHOWING IT — what a finished task reads as (a stored table paged, the rows
// held in memory, a card hint), the query tools' read and cancel, query_pipeline_model's start, and the
// one tool that draws a model result (display_model_result) with its drill-down reads. The lifecycle
// itself is src/task-runner.js. Methods of the Engine (src/engine/helpers.js — mixin).

import { ToolError, RESULT_GONE } from '../validate.js';
import { TaskRunner } from '../task-runner.js';
import { RESULT_MODEL_PREFIX } from '../context-manager.js';
import { formatDbtError } from '../dbt/index.js';
import { buildProjection, projectionProblems } from '../projection.js';
import { getDialect } from '../dialects/index.js';
import { sqlConfigHeader } from '../sql-header.js';
import { DRILL_ROWS, buildViewModel } from '../apps/result-view-model.js';
import { resultColumns, displayProblems, drillFirstRead } from '../display-check.js';
import { isPlainObject, samplingNote } from './helpers.js';

export const taskResultMethods = {
  /**
   * Materialization mode (inside the query's task): compile the query to SQL, write it as a
   * materialized='table' dbt model named after the task (`qr_<task_id>`), build it, and read the
   * first page back. The table is the durable result: query_semantic_model({ request: { task_ids } }) pages it after the in-memory
   * response is gone, a card drills into it, and a pipeline can start from it (from_task).
   */
  async _materialize(ctx, qopts, input, rename, id, speak = this._callerSpelling(rename)) {
    const dir = this.ctxs.dir(ctx.id);
    // The TABLE is the deliverable here, so it holds the whole result. `limit` is the caller's page
    // size for reading rows back below; baking it into the query would persist one page and let
    // every later total be read off it as if it were the full answer.
    const { limit: _page, ...full } = qopts;
    const explain = await this.runner.query(dir, { ...full, explain: true });
    if (!explain.ok) return { ok: false, error: { stage: 'query', message: speak(formatDbtError(explain.stdout, explain.stderr)) } };
    // The stored table's columns get the caller-facing names (`<model>_<attribute>`,
    // `metric_time_<grain>`), never `__` — they are what a card and a pipeline address.
    const projected = rename.size
      ? `select ${[...(full.groupBy || []).map((g) => (rename.has(g) ? `${g} as ${rename.get(g)}` : g)), ...full.metrics].join(', ')} from (\n${explain.sql}\n) _q`
      : explain.sql;
    const table = `${RESULT_MODEL_PREFIX}${id}`;
    this.jobs.setTable(id, table);
    const header = sqlConfigHeader('materialized_query', { context_id: ctx.id, metrics: input.metrics, group_by: input.group_by, where: input.where, order_by: input.order_by, time_range: input.time_range });
    this.ctxs.writeModel(ctx.id, table, `${this._modelConfigLine('table')}\n${header}${projected}\n`);
    const r = await this.runner.run(dir, table);
    if (!r.ok) return { ok: false, table, error: { stage: 'materialize', message: speak(this._sqlRunMessage(r.stdout, r.stderr)) } };
    return this._readTable(dir, table, input.limit ?? 1000, undefined, {}, input.offset ?? 0);
  },

  /** Run a (optionally projected) read over a materialized result table. */
  async _readTable(dir, table, limit, transform, extra = {}, offset = 0, sample = false, samplePercent = 10) {
    const ref = `{{ ref('${table}') }}`;
    const base = transform ? buildProjection(ref, transform) : `select * from ${ref}`;
    if (sample) {
      // A REPRESENTATIVE random subset rather than the first rows by physical order, the
      // dialect's way (src/dialects). Paging doesn't apply.
      const sql = getDialect(this.catalog.dialect).sampleQuery(ref, samplePercent, (rel) => (transform ? buildProjection(rel, transform) : `select * from ${rel}`));
      const res = await this.runner.show(dir, sql, limit);
      if (!res.ok) return { ok: false, status: 'error', table, ...extra, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
      return { ok: true, status: 'ready', table, ...extra, sampled: true, sampling: samplingNote(samplePercent), columns: res.columns, rows: res.rows, row_count: res.rows.length, ...(transform ? { projected: true } : {}) };
    }
    // Page in JS over a single read (over-fetch by 1 for has_more) rather than a
    // SQL OFFSET with no ORDER BY (which was non-deterministic across calls — H2).
    const res = await this.runner.show(dir, base, limit + offset + 1);
    if (!res.ok) return { ok: false, status: 'error', table, ...extra, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
    const pageRows = res.rows.slice(offset, offset + limit);
    return { ok: true, status: 'ready', table, ...extra, columns: res.columns, rows: pageRows, row_count: pageRows.length, page: { limit, offset, has_more: res.rows.length > offset + limit }, ...(transform ? { projected: true } : {}) };
  },

  /** The side a task belongs to (semantic | pipeline), from the tool that started it (persisted with the task). */
  _taskSide(job) {
    return this._sides[job?.tool] || null;
  },

  /** How to get rows past what a task holds — said in the terms of the tool that ran it. */
  _pageHint(job) {
    if (job.tool === 'query_pipeline_model') return 'query the model again with the offset/limit you want — query_pipeline_model({ request: { context_id, transform, limit, offset } }) — or page the build\'s own task, whose table is stored';
    if (this._taskSide(job) === 'pipeline') return 'build it again — a pipeline build stores its table, which then pages';
    return 'run the query again with the offset/limit you want, or with materialize:true to store the whole result as a table that pages';
  },

  /** The call that reads a task back: its side's query tool, with the task_id. */
  _readWith(id) {
    return this.tasks.readWith(id);
  },

  /**
   * THE READ HALF OF A QUERY TOOL — query_semantic_model({ request: { task_ids } }) / query_pipeline_model({ request: {
   * task_id } }): wait for a task of THAT side (at most `wait_seconds`, capped at MAX_WAIT_SECONDS,
   * returning the moment it is done) and return its finished response — the rows of a query or a
   * build, a parsed model, or the error it ended in. Still running → `status: 'running'`: call
   * again. A task that stored a table (a materialized query, a pipeline build) can be PAGED with
   * offset/limit, and is still readable after its in-memory response is gone. It never draws:
   * showing a result is display_model_result. A task of the other side is refused with the tool
   * that reads it.
   */
  _cancelTasks(input, side) {
    return this.tasks.cancel(input, side);
  },

  /**
   * THE READ HALF, FOR SEVERAL TASKS — { task_ids }: every id is checked first (known, of this
   * side), then it waits until ALL of them are done (at most `wait_seconds`, capped at
   * MAX_WAIT_SECONDS) and returns each one's result in the order asked — the same answer
   * { task_id } gives for it. Those still running come back as running, and `next` names just them.
   */
  async _pollTasks(input, side) {
    const ids = input.task_ids;
    for (const id of ids) this._taskForSide(id, side);
    const waited = await this.tasks.await(ids, TaskRunner.clampWait(input.wait_seconds));
    const results = [];
    for (const id of ids) results.push(await this._taskResult(id, { waited, offset: input.offset, limit: input.limit }));
    return TaskRunner.readAnswer(results, this._readers[side], { waited_seconds: waited });
  },

  _knownTask(id) {
    return this.tasks.known(id);
  },

  _taskForSide(id, side) {
    return this.tasks.forSide(id, side);
  },

  /**
   * Everything a call that WAITS on a task (a query tool's read, display_model_result) would refuse,
   * checked before any waiting — so a protocol task that follows the call (src/mcp-surface.js
   * runToCompletion) never sits through a build only to be refused at the end.
   */
  _precheckWait(tool, args) {
    this._validate(tool, args);
    this.tools.get(tool)?.precheck?.(this, args);
  },

  /** A task drawn once is not drawn again: its card is in the conversation already. */
  _refuseDrawnAgain(id) {
    this._knownTask(id);
    if (this._displayed?.get(id) === 'drawn' || this.jobs.get(id)?.drawn) throw new ToolError(`task ${id} is shown already — its card is in the conversation above`, { stage: 'validate', field: 'task_id' });
  },

  /** Wait for a task (within the cap) and read what it produced — the one read the query tools and display_model_result share. */
  async _awaitRead(id, { wait_seconds: wait, offset, limit } = {}) {
    this._knownTask(id);
    const waited = await this.tasks.await([id], TaskRunner.clampWait(wait));
    return this._taskResult(id, { waited, offset, limit });
  },

  /**
   * QUERY A BUILT PIPELINE MODEL — the pipeline side's twin of query_semantic_model. Two modes:
   * with a query ({ context_id, transform?, limit?, offset? }) it STARTS a task that reads the
   * context's built model, optionally filtered / grouped / aggregated (a read-only projection over
   * the stored table, nothing upstream recomputed) and returns its task_id at once; with { task_id }
   * it waits for a pipeline task (a build, or such a query) and returns its rows.
   */
  async query_pipeline_model(input) {
    this._validate('query_pipeline_model', input);
    if (input.cancel) return this._cancelTasks(input, 'pipeline');
    if (input.task_ids) return this._pollTasks(input, 'pipeline');
    const ctx = this._ctx(input.context_id);
    if (input.queries) return this._startBatch(ctx, 'query_pipeline_model', input.queries, (q) => this._pipelineQueryWork(ctx, q));
    return this._taskStarted(this._startTask(ctx, 'query_pipeline_model', this._pipelineQueryWork(ctx, input), { input }), { context_id: ctx.id });
  },

  /** One query over a context's built pipeline model, checked against its columns; returns the work its task runs. */
  _pipelineQueryWork(ctx, input) {
    // A build in flight is the model this query is about: tasks on a context run in order, so the
    // query runs once that build is done — against ITS columns and ITS table, not the previous one.
    const building = ctx.state.draft?.building?.task_id ? ctx.state.draft.building : null;
    // (an edit during the build may have retired its checkpoint: then the model standing is what is known)
    const buildingCp = building ? (ctx.state.draft.checkpoints || []).find((cp) => cp.task_id === building.task_id) : null;
    const standing = ctx.state.engine === 'pipeline' && ctx.state.model ? ctx.state.pipeline_model?.columns || [] : null;
    const columns = buildingCp ? buildingCp.columns.map((c) => c.name) : building ? (standing || []) : standing;
    if (!columns) {
      throw new ToolError(`context ${ctx.id} holds no built pipeline model — build one with build_pipeline_model (… materialize)${(ctx.state.metrics || []).length ? '; the metrics it declares are queried with query_semantic_model' : ''}`, { stage: 'validate', field: 'context_id' });
    }
    // the transform is checked HERE, against the model's columns: a mistake is refused in the call
    if (input.transform) {
      // (columns are unknown only while a first build whose plan was edited away runs: shape alone then)
      const problems = projectionProblems(input.transform, columns.length ? columns : null);
      if (problems.length) throw new ToolError(`transform: ${problems.join('; ')}. The model's columns: ${columns.join(', ')}`, { stage: 'validate', field: 'transform' });
    }
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    return async () => {
      const table = ctx.state.model; // resolved when the query runs: after any build queued before it
      if (!table || !this.ctxs.hasPipelineModel(ctx.id, table)) return { ok: false, error: { stage: 'fetch', code: RESULT_GONE, message: `the pipeline model ${table || ''} is not there (its build failed, or it was deleted) — build it again` } };
      const out = await this._readTable(this.ctxs.dir(ctx.id), table, input.limit ?? 1000, input.transform, {}, input.offset ?? 0);
      return out.ok === false ? out : { ...out, model: table, provenance: { tier: 'pipeline', model: table } };
    };
  },

  /** Wait for tasks to settle, `seconds` at most (src/task-runner.js). Returns the seconds waited. */
  async _awaitTask(id, seconds) {
    return this.tasks.await([id], seconds);
  },

  async _awaitTasks(ids, seconds) {
    return this.tasks.await(ids, seconds);
  },

  async _taskResult(id, { waited = 0, offset, limit } = {}) {
    const job = this.jobs.get(id);
    const { head, pending } = this.tasks.status(id, waited);
    if (pending) return pending;
    const paging = offset != null || limit != null;
    const kept = this.tasks.results.get(id);
    const stored = job.status === 'ready' && !!job.table;
    if (kept && paging && !stored && isPlainObject(kept.out) && Array.isArray(kept.out.rows)) {
      // a result held in memory is the page the query returned: offset/limit page WITHIN it
      const out = kept.out;
      const off = offset ?? 0; const lim = limit ?? out.rows.length;
      const rows = out.rows.slice(off, off + lim);
      const beyond = off + lim > out.rows.length && !!out.page?.has_more;
      return {
        ...head, ...out, rows, row_count: rows.length, status: 'done',
        page: { limit: lim, offset: off, held_rows: out.rows.length, has_more: off + lim < out.rows.length || beyond },
        ...(beyond ? { warnings: [...(out.warnings || []), `the task holds the ${out.rows.length} row(s) its query returned — rows past them were not kept: ${this._pageHint(job)}`] } : {}),
      };
    }
    if (kept && !paging) {
      const out = kept.out;
      const failed = isPlainObject(out) && out.ok === false;
      return { ...head, ...(isPlainObject(out) ? out : { result: out }), status: failed ? 'error' : 'done', ...(failed ? {} : this._showHint(id, out)) };
    }
    if (job.status === 'ready' && job.table) {
      // a stored table: the rows are read from it (paged), whether or not the response is still held
      if (!this.ctxs.has(job.contextId) || !this.ctxs.hasPipelineModel(job.contextId, job.table)) {
        return { ok: false, ...head, status: 'error', table: job.table, error: { stage: 'fetch', code: RESULT_GONE, message: `the result table ${job.table} was deleted (its context or model is gone) — run it again to rebuild it` } };
      }
      if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
      const page = await this._readTable(this.ctxs.dir(job.contextId), job.table, limit ?? 1000, undefined, {}, offset ?? 0);
      return { ...head, ...page, status: page.ok === false ? 'error' : 'done', ...(page.ok === false ? {} : this._showHint(id, page)) };
    }
    if (paging) throw new ToolError(`offset/limit page a stored table or a result still held in memory, and this task has neither — ${this._pageHint(job)}`, { stage: 'validate', field: offset != null ? 'offset' : 'limit' });
    if (job.status === 'error') return { ok: false, ...head, status: 'error', error: { stage: 'task', message: job.error } };
    return { ok: false, ...head, status: 'error', error: { stage: 'task', code: RESULT_GONE, message: 'this task\'s result was held in memory and is gone (the server restarted, or it is over an hour old) — run it again; materialize:true keeps a query\'s result as a table that survives restarts.' } };
  },

  /** How a finished result with rows can be shown to the person — once: the `display` the caller
   *  declares (a chart, KPI tiles, a funnel, a pivot…) says how the card draws its rows. */
  _showHint(id, out) {
    const drawable = isPlainObject(out) && Array.isArray(out.rows) && out.rows.length > 0;
    if (!drawable || this._displayed?.has(id)) return {};
    return { show_to_user: { tool: 'display_model_result', arguments: { request: { task_id: id } }, why: `in a host that renders MCP Apps this draws the result as a card for the person — add \`display\` with the kind that fits the question (a chart, KPI tiles, a funnel, a pivot…), over these columns. Once per result, and only for what the person should see — not for the intermediate reads you make to work something out.` } };
  },

  /**
   * DRAW A FINISHED RESULT AS A CARD — the only tool that does, and it reads the result the only
   * way the query tools read one (_awaitRead). It draws each task at most ONCE: a second call for the same
   * task is refused, so one question gets one card by construction. A task still running after
   * that read's wait, or a failed one, is REFUSED (a tool error, no card): waiting is the query tools'. `display` says how rows are drawn
   * — checked against the result's columns; without it the card follows the rows' shape. It draws
   * MODEL results only: an experiment is its own process and draws its own card (experiment with
   * card: true). A drill-down (a pivot, a
   * chart with drill) shows its first view, and the card reads the views below from the task's
   * stored table (drill_result).
   */
  async display_model_result(input) {
    this._validate('display_model_result', input);
    const id = input.task_id;
    this._displayed ||= new Map();
    if (this.jobs.get(id)?.drawn) this._displayed.set(id, 'drawn'); // drawn before a restart
    if (this._displayed.has(id)) {
      throw new ToolError(this._displayed.get(id) === 'drawn'
        ? `task ${id} is shown already — its card is in the conversation above. One result, one card: say in words what else to notice, or run a new query for different data.`
        : `task ${id} is being shown by another call right now — one result, one card.`, { stage: 'validate', field: 'task_id' });
    }
    this._displayed.set(id, 'pending');
    let drawn = false;
    try {
      const got = await this._awaitRead(id); // the one read — the same one the query tools make
      if (got.status === 'running') throw new ToolError(`task ${id} is still running — nothing is drawn. Wait for it with ${this._readWith(id)} (it draws nothing), then show it once`, { stage: 'validate', field: 'task_id' });
      if (got.status !== 'done') return got; // failed: nothing to draw, and the reply says why
      const { show_to_user: _hint, ...result } = got;
      const kept = this.tasks.results.get(id);
      const tool = result.tool || kept?.tool || null;
      let out;
      {
        const cols = resultColumns(result);
        if (!cols) throw new ToolError(`task ${id} (${tool || 'a task'}) returned no rows to draw — display_model_result draws the rows of a model: a semantic query or a pipeline`, { stage: 'validate', field: 'task_id' });
        const d = input.display || null;
        const first = drillFirstRead(d);
        const job = this.jobs.get(id);
        if (first && !job?.table) throw new ToolError(`a ${d.kind === 'pivot' ? 'pivot' : 'drill-down'} reads the STORED result view by view, and this task holds none — ${job?.tool === 'query_pipeline_model' ? 'show the pipeline BUILD\'s task instead (its table is stored)' : 'run the query with materialize:true, then show that task'}`, { stage: 'validate', field: 'display' });
        if (d) {
          // a drill-down's columns are the stored table's, not one view's: its row shape is not checked
          const problems = displayProblems(d, cols, first ? null : result.rows);
          if (problems.length) throw new ToolError(`display: ${problems.join('; ')}. This result's columns: ${cols.join(', ')}`, { stage: 'validate', field: 'display' });
        }
        if (first) {
          const view = await this._readTable(this.ctxs.dir(job.contextId), job.table, first.limit, first.transform);
          if (view.ok === false) return { task_id: id, ...view };
          out = { task_id: id, tool, context_id: job.contextId, ...view, status: 'done', display: d, drill_source: { task_id: id } };
        } else out = { ...result, ...(d ? { display: d } : {}) };
        out.drawn_from = { tool };
      }
      const view = buildViewModel('display_model_result', out, input);
      if (view.kind === 'none') return { ...out, drawn: false, warnings: [...(out.warnings || []), `nothing was drawn (${view.reason}) — declare \`display\` with the kind that fits the rows`] };
      drawn = true;
      return { ...out, drawn: true };
    } finally {
      if (drawn) { this._displayed.set(id, 'drawn'); this.jobs.markDrawn(id); }
      else this._displayed.delete(id);
    }
  },

  /**
   * THE CARD'S READ OF ITS OWN RESULT (visible to the view only, never to the model): one view of a
   * drill-down — the task's stored table filtered to the path taken and grouped by the level chosen,
   * built by the view model's one definition of a view (pivotTransform / drillView). Only a task
   * that was drawn, and only its table.
   */
  async drill_result(input) {
    this._validate('drill_result', input);
    const job = this.jobs.get(input.task_id);
    if (!job) throw new ToolError(`unknown task_id: ${input.task_id}`, { stage: 'validate', field: 'task_id', code: RESULT_GONE });
    if (!job.drawn && this._displayed?.get(job.id) !== 'drawn') throw new ToolError(`task ${job.id} was not drawn as a card — only a card reads its own result`, { stage: 'validate', field: 'task_id' });
    if (job.status !== 'ready' || !job.table) throw new ToolError(`task ${job.id} holds no stored table to drill into`, { stage: 'validate', field: 'task_id' });
    if (!this.ctxs.has(job.contextId) || !this.ctxs.hasPipelineModel(job.contextId, job.table)) {
      return { ok: false, task_id: job.id, status: 'error', error: { stage: 'fetch', code: RESULT_GONE, message: `the result table ${job.table} was deleted (its context or model is gone)` } };
    }
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    const out = await this._readTable(this.ctxs.dir(job.contextId), job.table, input.limit ?? DRILL_ROWS, input.transform);
    return { task_id: job.id, ...out };
  },
};
