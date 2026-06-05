// Tracks background (materialized) query jobs. Results live in the warehouse (a
// materialized table), not in memory — so they survive crashes and are
// re-fetchable. This store tracks status + which context/table to read from,
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
    for (const row of this.store.jobs.init()) this.jobs.set(row.id, row);
  }

  _persist(j) {
    this.store.jobs.upsert(j);
  }

  create(meta = {}) {
    const id = randomBytes(6).toString('hex');
    const j = { id, status: 'running', startedAt: Date.now(), ...meta };
    this.jobs.set(id, j);
    this._persist(j);
    return id;
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
    return [...this.jobs.values()].map((j) => ({ query_id: j.id, status: j.status, table: j.table, context_id: j.contextId, age_ms: Date.now() - j.startedAt }));
  }

  close() {
    if (this._ownsStore) { try { this.store?.close(); } catch { /* already closed */ } }
    this.store = null;
  }
}
