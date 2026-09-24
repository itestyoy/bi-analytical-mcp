// Tracks TASKS (src/engine.js _startTask): the work a tool started and get_task_result reads. A
// task that stores a table (a materialized query, a pipeline build) keeps its result in the
// warehouse — re-readable after a restart. This store tracks status + which context/table to read from,
// persisted in the shared store (one SQLite db, see store.js) so the job registry
// survives restarts. Falls back to in-memory when no persistent store is available.

import { randomBytes } from 'node:crypto';
import { openStore } from './store.js';

export class JobManager {
  constructor({ dbPath, store } = {}) {
    // The working set lives in this Map; the store's `jobs` repository provides durability.
    // Use an injected (shared) store, else open one (in-memory backend when no path/sqlite).
    this.store = store || openStore({ dbPath });
    this._ownsStore = !store; // only close what we opened
    this.jobs = new Map();
    // Jobs THIS process started. A job the store hands back as 'running' was started by a process
    // that is gone — nothing is driving it any more, and whoever waits on it has to know.
    this.live = new Set();
    for (const row of this.store.jobs.init()) this.jobs.set(row.id, row);
  }

  _persist(j) {
    this.store.jobs.upsert(j);
  }

  create(meta = {}) {
    const id = randomBytes(6).toString('hex');
    const j = { id, status: 'running', startedAt: Date.now(), ...meta };
    this.jobs.set(id, j);
    this.live.add(id);
    this._persist(j);
    return id;
  }

  /** True when this process is the one running the job (false for one inherited from the store). */
  isLive(id) {
    return this.live.has(id);
  }

  setTable(id, table) {
    const j = this.jobs.get(id);
    if (j) { j.table = table; this._persist(j); }
  }

  ready(id) {
    const j = this.jobs.get(id);
    if (j) { j.status = 'ready'; j.readyAt = Date.now(); this._persist(j); }
  }

  fail(id, error) {
    const j = this.jobs.get(id);
    if (j) { j.status = 'error'; j.error = error; this._persist(j); }
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].map((j) => ({ task_id: j.id, ...(j.tool ? { tool: j.tool } : {}), status: j.status, table: j.table, context_id: j.contextId, age_ms: Date.now() - j.startedAt }));
  }

  close() {
    if (this._ownsStore) { try { this.store?.close(); } catch { /* already closed */ } }
    this.store = null;
  }
}
