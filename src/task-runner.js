// THE TASK RUNTIME — the one shape of work that takes warehouse time, and why starting, reading and
// showing a result are three different calls:
//   * a tool that STARTS work (a build, a query) validates its input inside the call, hands the rest
//     to a task and returns the task's id AT ONCE — it never waits, so no call outlives the client
//     in front of it;
//   * the query tool of its side reads it back: waits for it (within MAX_WAIT_SECONDS) and returns
//     what it produced;
//   * the drawing tool reads it the same way and draws it — once.
// The work runs detached from the call that started it (its cancellation must not reach a build that
// is supposed to go on), with a lease on its context, and tasks on ONE context run one after another
// — a query issued right after its task was declared starts once the declaration is parsed, and two
// builds never write the same files at once. A batch's members run side by side, after what was
// queued before them and before what is queued after.
//
// This module owns the lifecycle — the per-context queue, each task's run, its cancellation and the
// response it finished with — and the words every task answer shares (its id, where to read it). What
// a finished task READS AS (a stored table paged, a card hint) is the engine's; which tool reads which
// side's tasks back is given (`sideOf`, `readers`). The engine and a feature reach it as `engine.tasks`.

import { detached, withSignal, isolatedTarget, currentSignal } from './request-context.js';
import { ToolError, RESULT_GONE } from './validate.js';
import { MAX_WAIT_SECONDS } from './schema.js';
import { isPlainObject } from './engine/helpers.js';

const KEEP_MAX = 200;
const KEEP_TTL_MS = 3600000;


export class TaskRunner {
  /**
   * @param jobs     the job registry (src/jobs.js) — each task's persisted record
   * @param ctxs     the context manager — a task leases its context while it runs
   * @param sideOf   (tool) → the side that tool's tasks belong to (null: none)
   * @param readers  { <side>: the query tool that reads that side's tasks back }
   * @param onFailure (id, tool, ctx, input, error) — a task that ended in an error (the error log)
   */
  constructor({ jobs, ctxs, sideOf, readers, onFailure = () => {} }) {
    this.jobs = jobs;
    this.ctxs = ctxs;
    this.sideOf = sideOf;
    this.readers = readers;
    this.onFailure = onFailure;
    this.queue = new Map(); // context id → the promise the next task on it waits for
    this.runs = new Map(); // task id → its settled promise
    this.controls = new Map(); // task id → its AbortController
    this.results = new Map(); // task id → { at, tool, input, out } — its finished response, for a while
  }

  /** A wait a caller asked for, within [0, MAX_WAIT_SECONDS]. */
  static clampWait(seconds) {
    return Math.min(Math.max(seconds ?? MAX_WAIT_SECONDS, 0), MAX_WAIT_SECONDS);
  }

  /** Start `work(id)` as a task of `tool` on `ctx` (null: no context). Returns the task id. */
  start(ctx, tool, work, { input = null, batch = null } = {}) {
    const id = this.jobs.create({ ...(ctx ? { contextId: ctx.id } : {}), tool });
    if (ctx) this.ctxs.acquire(ctx.id);
    // a member of a batch waits for what was queued before the BATCH, and runs beside the other members
    const before = batch ? batch.before : ctx ? this.queue.get(ctx.id) : null;
    // The task's own cancellation (a query tool's { task_id, cancel: true }): every dbt process its
    // work starts is stopped by it, and one started after it is refused at once (src/dbt/process.js).
    const control = new AbortController();
    this.controls.set(id, control);
    const keep = (out) => {
      if (this.jobs.get(id)?.status === 'cancelled') return; // what the work did after the cancel is not its result
      this.keep(id, { tool, input, out });
      if (isPlainObject(out) && out.ok === false) {
        this.jobs.fail(id, out.error?.message || `the ${tool} task failed`);
        if (out.error?.stage !== 'cancelled') this.onFailure(id, tool, ctx, input, out.error);
      } else this.jobs.ready(id);
    };
    const settled = detached(async () => {
      await null; // the caller records what it needs about the task before any of the work runs
      if (before) await before;
      // A query cancelled while it waited never starts. A cancelled BUILD still runs its work —
      // with its signal already aborted, so no dbt process starts and the work goes down its own
      // failure path (clearing its in-flight marker and its checkpoint).
      if (control.signal.aborted && this.sideOf(tool) && tool.startsWith('query_')) return { ok: false, error: { stage: 'cancelled', code: 'cancelled', message: 'cancelled before it started' } };
      // Members of a batch run at the same time on one context: each dbt process gets its own target/.
      return withSignal(control.signal, () => (batch ? isolatedTarget(() => work(id)) : work(id)));
    }).then(keep, (e) => keep({
      ok: false,
      error: { stage: e?.stage || 'task', message: e?.message || String(e), ...(e?.field ? { field: e.field } : {}), ...(e?.code ? { code: e.code } : {}) },
    })).catch((e) => { this.jobs.fail(id, e?.message || String(e)); this.onFailure(id, tool, ctx, input, { stage: 'task', message: e?.message || String(e), detail: e?.stack }); }).finally(() => {
      this.runs.delete(id);
      this.controls.delete(id);
      if (!ctx) return;
      this.ctxs.release(ctx.id);
      if (this.queue.get(ctx.id) === settled) this.queue.delete(ctx.id);
    });
    if (ctx && !batch) this.queue.set(ctx.id, settled);
    this.runs.set(id, settled);
    return id;
  }

  /**
   * A BATCH of queries on one context: each is checked by `prepare` BEFORE any starts — one mistake
   * refuses the whole batch, naming the query — and each becomes a task of its own (read, paged and
   * drawn like any other). Returns { task_ids, context_id, read_with, next }.
   */
  startBatch(ctx, tool, queries, prepare) {
    const works = queries.map((q, i) => {
      try { return prepare(q); } catch (e) {
        if (e instanceof ToolError) {
          throw new ToolError(`queries[${i}]: ${e.message} — nothing in this batch was started`, { stage: e.stage || 'validate', field: `queries[${i}]${e.field ? `.${e.field}` : ''}`, code: e.code });
        }
        throw e;
      }
    });
    const batch = { before: this.queue.get(ctx.id) || null };
    const ids = works.map((work, i) => this.start(ctx, tool, work, { batch, input: { ...queries[i], context_id: ctx.id } }));
    const all = Promise.allSettled(ids.map((id) => this.runs.get(id))).finally(() => {
      if (this.queue.get(ctx.id) === all) this.queue.delete(ctx.id);
    });
    this.queue.set(ctx.id, all);
    const reader = this.readers[this.sideOf(tool)];
    return {
      task_ids: ids,
      context_id: ctx.id,
      read_with: reader,
      next: `${reader}({ request: { task_ids: [${ids.map((id) => `'${id}'`).join(', ')}] } }) — it waits for them together (up to ${MAX_WAIT_SECONDS}s per call) and returns each one's result, in this order`,
    };
  }

  /** What a tool that started a task answers: the task's id and where to read it — nothing else. */
  started(id, extra = {}) {
    const side = this.sideOf(this.jobs.get(id)?.tool);
    return { task_id: id, ...extra, read_with: this.readers[side], next: `${this.readWith(id)} — it waits for the task (up to ${MAX_WAIT_SECONDS}s per call) and returns its result` };
  }

  /** The call that reads a task back: its side's query tool, with the task_id. */
  readWith(id) {
    return `${this.readers[this.sideOf(this.jobs.get(id)?.tool)]}({ request: { task_id: '${id}' } })`;
  }

  /** Keep a task's finished response for the query tools to read back — the newest few hundred, for an hour. A stored table outlives it. */
  keep(id, entry) {
    const now = Date.now();
    for (const [k, v] of this.results) if (now - v.at > KEEP_TTL_MS) this.results.delete(k);
    this.results.set(id, { at: now, ...entry });
    while (this.results.size > KEEP_MAX) this.results.delete(this.results.keys().next().value);
  }

  /** The response a task finished with, while it is held (null once it is not). */
  held(id) {
    return this.results.get(id)?.out ?? null;
  }

  /** The task behind an id — or the one refusal of an id this server does not know. */
  known(id) {
    const job = this.jobs.get(id);
    if (!job) throw new ToolError(`unknown task_id: ${id} — this server has no such task (one started before a restart is not known any more); start the work again`, { stage: 'validate', field: 'task_id', code: RESULT_GONE });
    return job;
  }

  /** A known task of THIS side — a task of the other side is refused with the tool that reads it. */
  forSide(id, side) {
    const job = this.known(id);
    const own = this.sideOf(job.tool);
    // no side to be read on: a task stored before tasks recorded the tool that started them, or one
    // started by a tool this server does not serve now (a feature switched off)
    if (!own) throw new ToolError(job.tool
      ? `task ${job.id} was started by ${job.tool}, which this server does not serve now (its feature is off), so no tool reads it back`
      : `task ${job.id} records no tool that started it, so neither side can read it back — start the work again`, { stage: 'validate', field: 'task_id', code: RESULT_GONE });
    if (own !== side) throw new ToolError(`task ${job.id} is a ${own} task (${job.tool}) — read it with ${this.readers[own]}({ request: { task_id: '${job.id}' } })`, { stage: 'validate', field: 'task_id' });
    return job;
  }

  /**
   * CANCEL — { task_id, cancel: true } / { task_ids, cancel: true } on the query tool of the task's
   * side: a running task ends at once as `cancelled` (its dbt process is stopped; one still queued
   * behind another task never starts one), and whatever was queued after it goes on. A task that
   * already finished is left as it is, and the answer says so.
   */
  cancel(input, side) {
    const ids = input.task_ids || [input.task_id];
    for (const id of ids) this.forSide(id, side);
    const results = ids.map((id) => {
      const job = this.jobs.get(id);
      if (job.status !== 'running') {
        return { task_id: id, cancelled: false, status: job.status === 'ready' ? 'done' : job.status, note: `already ${job.status === 'ready' ? 'finished' : job.status} — nothing to cancel` };
      }
      const reason = `cancelled by ${this.readers[side]}({ request: { task_id, cancel: true } })`;
      this.controls.get(id)?.abort(new Error(reason));
      this.jobs.cancel(id, reason);
      this.keep(id, { tool: job.tool, input: null, out: { ok: false, error: { stage: 'cancelled', code: 'cancelled', message: reason } } });
      return { task_id: id, cancelled: true, status: 'cancelled' };
    });
    return input.task_ids ? { ok: true, results } : { ok: true, ...results[0] };
  }

  /** Wait until every one of these tasks has settled, `seconds` at most — or until the call is cancelled. Returns the seconds waited. */
  async await(ids, seconds) {
    // a cancelled task is final the moment it is cancelled, whatever its work still does before it stops
    const runs = ids.filter((id) => this.jobs.get(id)?.status === 'running').map((id) => this.runs.get(id)).filter(Boolean);
    if (!runs.length || seconds <= 0) return 0;
    const started = Date.now();
    const signal = currentSignal();
    let timer; let onAbort;
    await Promise.race([
      Promise.all(runs),
      new Promise((resolve) => { timer = setTimeout(resolve, seconds * 1000); }),
      new Promise((resolve) => { onAbort = resolve; signal?.addEventListener?.('abort', onAbort, { once: true }); }),
    ]);
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    return Math.round((Date.now() - started) / 100) / 10;
  }

  /**
   * The head of a task's answer — its id, tool, context and table — and, for one not finished,
   * the whole answer: still running (call again), started by a process that is gone, or cancelled.
   * null `pending` when the task has finished and its result is to be read.
   */
  status(id, waited = 0) {
    const job = this.jobs.get(id);
    const head = { task_id: id, ...(job.tool ? { tool: job.tool } : {}), ...(job.contextId ? { context_id: job.contextId } : {}), ...(job.table ? { table: job.table } : {}) };
    if (job.status === 'running') {
      if (!this.jobs.isLive(id)) return { head, pending: { ok: false, ...head, status: 'error', error: { stage: 'task', message: 'this task was started by a server process that is gone (it restarted), so nothing is running it — start the work again' } } };
      return { head, pending: { ok: true, ...head, status: 'running', waited_seconds: waited, next: `still running — call ${this.readWith(id)} again; it waits up to ${MAX_WAIT_SECONDS}s` } };
    }
    if (job.status === 'cancelled') return { head, pending: { ok: false, ...head, status: 'cancelled', error: { stage: 'cancelled', code: 'cancelled', message: job.error || 'cancelled' } } };
    return { head, pending: null };
  }
}
