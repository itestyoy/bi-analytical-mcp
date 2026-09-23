// TASKS — a tool call that outlives its request, tracked by an id the client polls.
//
// This server already had the idea, by hand: a build past its grace comes back as
// { status: 'running', query_id } and the caller polls get_query_result, pacing itself with the
// `time` tool. A task is the same thing made native to the protocol, so the HOST polls and the
// model never sees a query_id: the task runs the call TO ITS END (src/mcp-surface.js
// runToCompletion follows a detached build until it is ready) and its result is exactly the
// CallToolResult the call would have returned had it finished in time.
//
// ONE registry, two wire formats — the protocol has had two incompatible designs:
//   * 2025-11-25 experimental tasks (legacy sessions): the client opts in per call with
//     `params.task`; tasks/get, tasks/result (blocks until terminal), tasks/list, tasks/cancel. The
//     SDK implements those methods over a TaskStore — `legacyStore()` is that store, over this
//     registry.
//   * the Tasks extension `io.modelcontextprotocol/tasks` (SEP-2663, 2026-07-28): the SERVER
//     decides per call; tasks/get returns the result inline, tasks/update carries input, tasks/cancel
//     is an ack; no list. `modern()` is that projection; src/mcp-modern.js serves it.
//
// What a task promises, in both: the id is unguessable (a random UUID — it is the bearer of the
// caller's result); it exists before the CreateTaskResult is sent (it is created synchronously in
// this process); a tool error is a COMPLETED task whose result has isError (only a protocol fault
// is `failed`); a cancellation stops the work it can (the dbt process of the call) and the status
// becomes `cancelled` unless the work had already finished; terminal states never change; and a
// task is kept for its TTL after it ends, then forgotten (tasks/get then says "not found", which
// the spec allows).

import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const isTerminal = (status) => TERMINAL.has(status);

export class TaskRegistry {
  constructor({ ttlMs = 3600000, pollIntervalMs = 2000, maxTasks = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.pollIntervalMs = pollIntervalMs;
    this.maxTasks = maxTasks;
    this.tasks = new Map();
    this._sweep = setInterval(() => this.sweep(), Math.min(ttlMs, 60000));
    this._sweep.unref?.();
  }

  /**
   * Create a task and start `run(signal)` → Promise<CallToolResult>. `owner` scopes listing and
   * access (the legacy session id; modern requests carry no identity beyond the id itself).
   */
  create({ owner = null, ttlMs, run, ctl: given }) {
    this.sweep();
    if (this.tasks.size >= this.maxTasks) throw Object.assign(new Error(`too many tasks in flight (${this.maxTasks}) — wait for some to finish`), { code: -32603 });
    const now = new Date().toISOString();
    // `ctl` — the controller of work that was ALREADY running before it became a task (a call
    // that outgrew its inline window keeps its own cancellation)
    const ctl = given || new AbortController();
    const t = {
      taskId: randomUUID(),
      status: 'working',
      statusMessage: 'The call is running.',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, this.ttlMs) : this.ttlMs,
      pollIntervalMs: this.pollIntervalMs,
      owner,
      ctl,
      result: undefined,
      error: undefined,
      waiters: new Set(),
    };
    this.tasks.set(t.taskId, t);
    Promise.resolve()
      .then(() => run(ctl.signal))
      .then(
        (result) => this._finish(t, 'completed', { result, statusMessage: result?.isError ? 'The call finished with a tool error (see the result).' : 'The call finished.' }),
        (err) => this._finish(t, 'failed', { error: { code: Number.isInteger(err?.code) ? err.code : -32603, message: err?.message || String(err) }, statusMessage: `The call failed: ${err?.message || err}` }),
      );
    return t;
  }

  _finish(t, status, { result, error, statusMessage }) {
    if (isTerminal(t.status)) return; // cancelled first — terminal states never change
    t.status = status;
    t.statusMessage = statusMessage;
    t.lastUpdatedAt = new Date().toISOString();
    if (result !== undefined) t.result = result;
    if (error !== undefined) t.error = error;
    this._wake(t);
  }

  _wake(t) {
    for (const w of t.waiters) w();
    t.waiters.clear();
  }

  /** The task, or null when unknown, expired, or owned by someone else. */
  get(taskId, owner = null) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    if (t.owner && owner !== undefined && owner !== null && t.owner !== owner) return null;
    if (this._expired(t)) { this.tasks.delete(taskId); return null; }
    return t;
  }

  /** Ask the work to stop. Cooperative: the status becomes `cancelled` unless it already ended. */
  cancel(taskId, owner = null, reason = 'Cancelled by the client.') {
    const t = this.get(taskId, owner);
    if (!t) return null;
    if (!isTerminal(t.status)) {
      t.ctl.abort(new Error(reason));
      t.status = 'cancelled';
      t.statusMessage = reason;
      t.lastUpdatedAt = new Date().toISOString();
      this._wake(t);
    }
    return t;
  }

  /** Resolves when the task changes or `ms` passes — what a blocking tasks/result waits on. */
  waitForChange(t, ms, signal) {
    if (isTerminal(t.status)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); t.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      t.waiters.add(done);
      signal?.addEventListener?.('abort', done, { once: true });
    });
  }

  list(owner = null) {
    this.sweep();
    return [...this.tasks.values()].filter((t) => !owner || t.owner === owner);
  }

  _expired(t) {
    // TTL runs from creation (both designs say so); a task still working is never dropped.
    return isTerminal(t.status) && Date.parse(t.createdAt) + t.ttlMs < Date.now();
  }

  sweep() {
    for (const [id, t] of this.tasks) if (this._expired(t)) this.tasks.delete(id);
  }

  close() {
    clearInterval(this._sweep);
    for (const t of this.tasks.values()) if (!isTerminal(t.status)) t.ctl.abort(new Error('server shutting down'));
  }

  // ── projections ──────────────────────────────────────────────────────────────────────────

  /** The Tasks extension's DetailedTask (SEP-2663): result/error inline on terminal states. */
  modern(t) {
    return {
      taskId: t.taskId,
      status: t.status,
      statusMessage: t.statusMessage,
      createdAt: t.createdAt,
      lastUpdatedAt: t.lastUpdatedAt,
      ttlMs: t.ttlMs,
      pollIntervalMs: t.pollIntervalMs,
      ...(t.status === 'completed' ? { result: t.result } : {}),
      ...(t.status === 'failed' ? { error: t.error } : {}),
    };
  }

  /** The 2025-11-25 experimental Task (ttl / pollInterval; the result comes from tasks/result). */
  legacy(t) {
    return {
      taskId: t.taskId,
      status: t.status,
      statusMessage: t.statusMessage,
      createdAt: t.createdAt,
      lastUpdatedAt: t.lastUpdatedAt,
      ttl: t.ttlMs,
      pollInterval: t.pollIntervalMs,
    };
  }

  /**
   * The SDK's TaskStore over this registry — what the SDK's own tasks/get, tasks/result,
   * tasks/list and tasks/cancel handlers read (2025-11-25). Tasks are CREATED by the tools/call
   * handler (it has the work to run), never through `createTask` here.
   */
  legacyStore() {
    const reg = this;
    const need = (id, sid) => { const t = reg.get(id, sid); if (!t) throw new Error(`Task not found: ${id}`); return t; };
    return {
      async createTask() { throw new Error('tasks are created by the tools/call handler'); },
      async getTask(taskId, sessionId) { const t = reg.get(taskId, sessionId); return t ? reg.legacy(t) : null; },
      async storeTaskResult(taskId, status, result, sessionId) { reg._finish(need(taskId, sessionId), status, status === 'completed' ? { result, statusMessage: 'The call finished.' } : { error: result, statusMessage: 'The call failed.' }); },
      async getTaskResult(taskId, sessionId) {
        const t = need(taskId, sessionId);
        if (t.status === 'completed') return t.result;
        if (t.status === 'failed') return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: t.error }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, status: t.status, message: t.statusMessage }) }], isError: true };
      },
      async updateTaskStatus(taskId, status, statusMessage, sessionId) {
        if (status === 'cancelled') { reg.cancel(taskId, sessionId, statusMessage || 'Cancelled by the client.'); return; }
        const t = need(taskId, sessionId);
        if (isTerminal(t.status)) return;
        t.status = status; t.statusMessage = statusMessage || t.statusMessage; t.lastUpdatedAt = new Date().toISOString(); reg._wake(t);
      },
      async listTasks(cursor, sessionId) { return { tasks: reg.list(sessionId || null).map((t) => reg.legacy(t)) }; },
    };
  }
}
