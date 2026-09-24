// TASKS — a tool call that outlives its request, tracked by an id the client polls.
//
// This server has the idea at the tool level too: a query or a build returns a task_id at once, and
// the query tool of its side reads it back with { task_id }, waiting up to MAX_WAIT_SECONDS per call.
// A PROTOCOL task is what a call that waits becomes when it outlasts services.taskAfterMs: the HOST
// polls instead of holding the request, and the call is run TO ITS END (src/mcp-surface.js
// runToCompletion waits on the engine task, then answers), so its result is exactly the
// CallToolResult the call would have returned had the work finished in time.
//
// The protocol form is the Tasks extension `io.modelcontextprotocol/tasks` (SEP-2663, protocol
// 2026-07-28): the SERVER decides per call; a client that declared the extension may get a
// CreateTaskResult instead of the result; tasks/get returns the result inline, tasks/update carries
// input, tasks/cancel is an ack; there is no list. (The 2025-11-25 "experimental tasks" were a
// different, wire-incompatible design; the extension replaces them and is what this serves.)
//
// What a task promises: the id is unguessable (a random UUID — it is the bearer of the
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
   * Create a task and start `run(signal)` → Promise<CallToolResult>. The id is the only handle:
   * the protocol carries no caller identity, so an unguessable id is what keeps one caller's task
   * from another (and there is deliberately no list).
   */
  create({ ttlMs, run, ctl: given }) {
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

  /** The task, or null when unknown or expired. */
  get(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    if (this._expired(t)) { this.tasks.delete(taskId); return null; }
    return t;
  }

  /** Ask the work to stop. Cooperative: the status becomes `cancelled` unless it already ended. */
  cancel(taskId, reason = 'Cancelled by the client.') {
    const t = this.get(taskId);
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
      // every way out removes every hook, so a long wait loop leaves no listener behind
      const done = () => { clearTimeout(timer); t.waiters.delete(done); signal?.removeEventListener?.('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      t.waiters.add(done);
      signal?.addEventListener?.('abort', done, { once: true });
    });
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

  /** The Tasks extension's DetailedTask (SEP-2663): result/error inline on terminal states. */
  detailed(t) {
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
}
