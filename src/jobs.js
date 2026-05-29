// Tracks background (materialized) query jobs. Results live in the warehouse (a
// materialized table), not in memory — so they survive crashes and are
// re-fetchable. This store tracks status + which context/table to read from,
// persisted in a minimal SQLite db so the job registry survives restarts.

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class JobManager {
  constructor({ dbPath } = {}) {
    this.jobs = new Map();
    this.db = null;
    if (dbPath) this._openDb(dbPath);
  }

  _openDb(dbPath) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(dbPath);
      this.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, context_id TEXT, table_name TEXT, status TEXT, error TEXT, started_at INTEGER, ready_at INTEGER)');
      this._upsert = this.db.prepare('INSERT INTO jobs (id, context_id, table_name, status, error, started_at, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id, table_name=excluded.table_name, status=excluded.status, error=excluded.error, ready_at=excluded.ready_at');
      // a job left 'running' across a restart can never complete (its build
      // promise is gone) -> reconcile to a terminal error so clients stop polling.
      this.db.prepare("UPDATE jobs SET status='error', error='interrupted by server restart; re-issue the query' WHERE status='running'").run();
      for (const row of this.db.prepare('SELECT * FROM jobs').all()) {
        this.jobs.set(row.id, { id: row.id, contextId: row.context_id, table: row.table_name, status: row.status, error: row.error, startedAt: row.started_at, readyAt: row.ready_at });
      }
    } catch {
      this.db = null; // sqlite unavailable -> in-memory only
    }
  }

  _persist(j) {
    if (this._upsert) this._upsert.run(j.id, j.contextId ?? null, j.table ?? null, j.status, j.error ?? null, j.startedAt, j.readyAt ?? null);
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
}
