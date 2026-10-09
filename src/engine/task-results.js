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
import { DRILL_ROWS, PIVOT_LEVEL_ROWS, buildViewModel, drillView, pivotTransform } from '../apps/result-view-model.js';
import { resultColumns, displayProblems, drillFirstRead } from '../display-check.js';
import { isPlainObject, samplingNote, pageBlock } from './helpers.js';
import { READ_PAGE, KEPT_ROWS } from '../schema/fields.js';

export const taskResultMethods = {
  /**
   * Materialization mode (inside the query's task): compile the query to SQL, write it as a
   * materialized='table' dbt model named after the task (`qr_<task_id>`), build it, and keep its first
   * `limit` rows as the task's answer (what a plain card draws — the count is kept with the task, for a
   * card drawn once the answer is gone). The table is the durable result: a read
   * (query_semantic_model({ request: { task_ids, offset, limit } })) pages it to its last row, after the
   * in-memory answer is gone too, a card drills into it, and a pipeline can start from it (from_task).
   */
  async _materialize(ctx, qopts, input, rename, id, speak = this._callerSpelling(rename)) {
    const dir = this.ctxs.dir(ctx.id);
    // The TABLE is the deliverable here, so it holds the whole result. `limit` is how many of its rows
    // the task keeps as its answer, read back below; baking it into the query would persist only those
    // and let every later total be read off them as if they were the full answer.
    const { limit: _page, ...full } = qopts;
    const explain = await this.runner.query(dir, { ...full, explain: true });
    if (!explain.ok) return { ok: false, error: { stage: 'query', message: speak(formatDbtError(explain.stdout, explain.stderr)) } };
    // The stored table's columns get the caller-facing names (`<model>_<attribute>`,
    // `metric_time_<grain>`), never `__` — they are what a card and a pipeline address.
    const projected = rename.size
      ? `select ${[...(full.groupBy || []).map((g) => (rename.has(g) ? `${g} as ${rename.get(g)}` : g)), ...full.metrics].join(', ')} from (\n${explain.sql}\n) _q`
      : explain.sql;
    const table = `${RESULT_MODEL_PREFIX}${id}`;
    const kept = input.limit ?? KEPT_ROWS;
    this.jobs.setTable(id, table, { keptRows: kept });
    const header = sqlConfigHeader('materialized_query', { context_id: ctx.id, metrics: input.metrics, group_by: input.group_by, where: input.where, order_by: input.order_by, time_range: input.time_range });
    this.ctxs.writeModel(ctx.id, table, `${this._modelConfigLine('table')}\n${header}${projected}\n`);
    const r = await this.runner.run(dir, table);
    if (!r.ok) return { ok: false, table, error: { stage: 'materialize', message: speak(this._sqlRunMessage(r.stdout, r.stderr)) } };
    return this._readTable(dir, table, kept);
  },

  /** Run a (optionally projected) read over a materialized result table: `limit` rows from row `offset`.
   *  `ordered` is what a read with no transform knows of its rows' order (false: none). */
  async _readTable(dir, table, limit, transform, { ordered } = {}, offset = 0, sample = false, samplePercent = 10) {
    const ref = `{{ ref('${table}') }}`;
    const d = getDialect(this.catalog.dialect);
    const base = transform ? buildProjection(ref, transform, d) : `select * from ${ref}`;
    if (sample) {
      // A REPRESENTATIVE random subset rather than the first rows by physical order, the
      // dialect's way (src/dialects). Paging doesn't apply.
      const sql = getDialect(this.catalog.dialect).sampleQuery(ref, samplePercent, (rel) => (transform ? buildProjection(rel, transform, d) : `select * from ${rel}`));
      const res = await this.runner.show(dir, sql, limit);
      if (!res.ok) return { ok: false, status: 'error', table, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
      return { ok: true, status: 'ready', table, sampled: true, sampling: samplingNote(samplePercent / 100), columns: res.columns, rows: res.rows, row_count: res.rows.length, ...(transform ? { projected: true } : {}) };
    }
    // Page in JS over a single read (over-fetch by 1 for has_more) rather than a
    // SQL OFFSET with no ORDER BY (which was non-deterministic across calls — H2).
    const res = await this.runner.show(dir, base, limit + offset + 1);
    if (!res.ok) return { ok: false, status: 'error', table, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
    const pageRows = res.rows.slice(offset, offset + limit);
    // the read reached the end of the table when it fetched no row past the page: then every row is
    // counted (a page that starts past the end too)
    const more = res.rows.length > offset + limit;
    return { ok: true, status: 'ready', table, columns: res.columns, rows: pageRows, row_count: pageRows.length, page: pageBlock({ offset, limit, returned: pageRows.length, has_more: more, total: more ? null : res.rows.length, ordered: transform ? !!transform.order_by?.length : ordered }), ...(transform ? { projected: true } : {}) };
  },

  /** The side a task belongs to (semantic | pipeline), from the tool that started it (persisted with the task). */
  _taskSide(job) {
    return this._sides[job?.tool] || null;
  },

  /** How to have rows past what a task keeps — said in the terms of the tool that ran it. */
  _pageHint(job) {
    if (job.tool === 'query_pipeline_model') return 'query the model again with a larger limit — query_pipeline_model({ request: { context_id, transform, limit } }) — or read the build\'s own task, whose stored table a read ({ task_ids, offset, limit }) pages to its last row';
    if (this._taskSide(job) === 'pipeline') return 'build it again — a pipeline build stores its table, which a read then pages to its last row';
    return 'run the query again with a larger limit, or with materialize: true to store every row as a table that a read ({ task_ids, offset, limit }) pages to its last row';
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
    // a read hands the model a PAGE of each task's result (READ_PAGE rows from `offset` unless it asks for
    // another number): the task keeps what it keeps — what a card draws — and the rest is a next_offset away
    for (const id of ids) results.push(await this._taskResult(id, { waited, offset: input.offset, limit: input.limit, pageSize: READ_PAGE }));
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
   * with a query ({ context_id, transform?, limit? }) it STARTS a task that reads the context's built
   * model, optionally filtered / grouped / aggregated (a read-only projection over the stored table,
   * nothing upstream recomputed), keeps its first `limit` rows and returns its task_id at once; with
   * { task_ids } it waits for pipeline tasks (a build, or such a query) and returns a page of each.
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
      const out = await this._readTable(this.ctxs.dir(ctx.id), table, input.limit ?? KEPT_ROWS, input.transform);
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

  /**
   * What a finished task reads as. A READ PAGES ITS RESULT BY ROW NUMBER: `offset` is a row of the
   * task's result (0 its first, wherever the rows are) and `limit` how many from there — `pageSize` (a
   * query tool's READ_PAGE) when it names none. The rows the task KEPT answer a page that lies within
   * them; a task that STORED a table (a materialized query, a pipeline build) reads a page past them
   * from the table, so it pages to its last row. A read that names no page and no pageSize (a card's,
   * display_model_result) takes the answer as kept.
   */
  async _taskResult(id, { waited = 0, offset, limit, pageSize = null } = {}) {
    const job = this.jobs.get(id);
    const { head, pending } = this.tasks.status(id, waited);
    if (pending) return pending;
    const paging = offset != null || limit != null;
    const kept = this.tasks.results.get(id);
    const stored = job.status === 'ready' && !!job.table;
    // the rows the task's answer holds: the first of its result (none of a failure or an answer without rows)
    const held = kept && isPlainObject(kept.out) && kept.out.ok !== false && Array.isArray(kept.out.rows) ? kept.out : null;
    const page = paging || pageSize ? { offset: offset ?? 0, limit: limit ?? pageSize ?? KEPT_ROWS } : null;
    // whether the result has rows past the ones held (a stored table has them all)
    const more = !!held?.page?.has_more;
    // A STORED RESULT IS ITS TABLE: a read of one whose table is gone says so — a page and a card's read
    // alike (the rows still held are not the result any more: nothing reads past them, draws or starts
    // from them)
    if (stored && (!this.ctxs.has(job.contextId) || !this.ctxs.hasPipelineModel(job.contextId, job.table))) {
      return { ok: false, ...head, status: 'error', table: job.table, error: { stage: 'fetch', code: RESULT_GONE, message: `the result table ${job.table} was deleted (its context or model is gone) — run it again to rebuild it` } };
    }
    if (held && page && (!stored || !more || page.offset + page.limit <= held.rows.length)) return { ...head, ...this._heldPage(job, held, page, stored), ...this._showHint(id, held) };
    if (kept && !paging && !(held && page)) {
      const out = kept.out;
      const failed = isPlainObject(out) && out.ok === false;
      return { ...head, ...(isPlainObject(out) ? out : { result: out }), status: failed ? 'error' : 'done', ...(failed ? {} : this._showHint(id, out)) };
    }
    if (stored) {
      // a stored table: a page past the rows held is read from it, whether or not the answer is still
      // held — with what the answer said of the rows' order, and of where they come from (its build's
      // SQL, assumptions and warnings were said once, with its first page). A read that names no page
      // (a card's, once the answer is gone) reads the rows the task kept.
      if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
      const read = await this._readTable(this.ctxs.dir(job.contextId), job.table, page?.limit ?? job.keptRows ?? KEPT_ROWS, undefined, { ordered: held?.page?.ordered }, page?.offset ?? 0);
      if (read.ok === false) return { ...head, ...read, status: 'error' };
      return { ...head, ...identityOf(held), ...read, status: 'done', ...this._showHint(id, read) };
    }
    // a task that FAILED answers with its failure — paged or not: it has no rows to page, and telling
    // the caller to build again hides why the build did not stand
    if (job.status === 'error') return { ok: false, ...head, status: 'error', error: { stage: 'task', message: job.error, see: `explore_errors({ request: { task_id: '${id}' } }) — the failure in full: what it ran and what the warehouse said` } };
    if (paging) throw new ToolError(`offset/limit page a stored table or a result still held in memory, and this task has neither — ${this._pageHint(job)}`, { stage: 'validate', field: offset != null ? 'offset' : 'limit' });
    return { ok: false, ...head, status: 'error', error: { stage: 'task', code: RESULT_GONE, message: 'this task\'s result was held in memory and is gone (the server restarted, or it is over an hour old) — run it again; materialize:true keeps a query\'s result as a table that survives restarts.' } };
  },

  /**
   * One page of the rows a task's answer holds — its result's rows `page.offset`.. by their row
   * numbers. Past the rows held, a result that was not stored has nothing more: the page says how many
   * there are, and how to have the rest.
   */
  _heldPage(job, held, page, stored) {
    const { offset, limit } = page;
    const rows = held.rows.slice(offset, offset + limit);
    const count = held.rows.length;
    const more = !!held.page?.has_more; // the result goes on past the rows held
    const end = offset + rows.length;
    // a page that reaches the end of what a result held in memory kept, when the result went on
    const cut = !stored && more && offset + limit >= count;
    const block = pageBlock({ offset, limit, returned: rows.length, has_more: end < count || more, total: more ? null : count, ordered: held.page?.ordered === false ? false : undefined });
    if (cut) delete block.next_offset; // its next rows were not kept: no row number reads them
    return {
      ...held, ok: true, rows, row_count: rows.length, status: 'done',
      page: stored ? block : { ...block, held_rows: count },
      ...(cut ? { warnings: [...(held.warnings || []), `the task keeps the first ${count} row(s) of its result — rows past them were not kept: ${this._pageHint(job)}`] } : {}),
    };
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
      if (drawn) { this._displayed.set(id, 'drawn'); this.jobs.markDrawn(id, input.display || null); }
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
    const out = await this._readTable(this.ctxs.dir(job.contextId), job.table, input.limit ?? (job.display?.kind === 'pivot' ? PIVOT_LEVEL_ROWS : DRILL_ROWS), drillRead(job, input));
    return { task_id: job.id, ...out };
  },
};

/** What a page read from a stored table carries of the task's answer, when it is still held: where the
 *  rows come from (the model, the provenance, a sample's note) — not what was said once with its first
 *  page (a build's SQL, assumptions and warnings). */
function identityOf(held) {
  return held ? Object.fromEntries(['model', 'provenance', 'sampling'].filter((k) => held[k] !== undefined).map((k) => [k, held[k]])) : {};
}

/**
 * The read of one view of a drawn card: the path taken and the level opened, made into the view by the
 * view model's one definition of it (pivotTransform / drillView) over the display the card was DRAWN
 * with — so a card reads only the views of what it drew, along the levels it declared.
 */
function drillRead(job, input) {
  const d = job.display;
  const path = input.path || [];
  if (!d) throw new ToolError(`task ${job.id} was drawn before its card's display was kept — draw a new query to drill into it`, { stage: 'validate', field: 'task_id' });
  if (d.kind === 'pivot') {
    if (input.level !== undefined || input.mode !== undefined) throw new ToolError('a pivot opens the next level of the row taken: give its path alone', { stage: 'validate', field: 'level' });
    if (path.length >= d.levels.length) throw new ToolError(`the pivot has ${d.levels.length} level(s): a path of ${path.length} opens none`, { stage: 'validate', field: 'path' });
    path.forEach((p, i) => { if (p.column !== d.levels[i].column) throw new ToolError(`path[${i}]: the pivot's level ${i + 1} is '${d.levels[i].column}', not '${p.column}'`, { stage: 'validate', field: 'path' }); });
    return pivotTransform(d, path.map((p) => p.value));
  }
  const levels = (d.drill?.levels || []).map((l) => l.column);
  if (!levels.length) throw new ToolError(`task ${job.id}'s card was drawn without a drill-down`, { stage: 'validate', field: 'task_id' });
  const along = new Set([d.x, d.series_column, d.label_column, ...levels].filter(Boolean));
  for (const p of path) if (!along.has(p.column)) throw new ToolError(`path: '${p.column}' is not a column this card was drawn or drills along (${[...along].join(', ')})`, { stage: 'validate', field: 'path' });
  if (input.level !== undefined && !levels.includes(input.level)) throw new ToolError(`level: '${input.level}' is not one of the card's drill levels (${levels.join(', ')})`, { stage: 'validate', field: 'level' });
  return drillView(d, path, input.level !== undefined ? { level: { column: input.level }, mode: input.mode || 'breakdown' } : null).transform;
}
