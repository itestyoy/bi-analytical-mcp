// One embedded database shared by all subsystems (the job registry + the value index),
// behind a REPOSITORY abstraction. The managers call domain methods (store.jobs.*,
// store.values.*, store.runs.*) and contain NO SQL — every query lives inside a backend.
// Swapping databases = implement these repositories for a new backend and register it;
// select it via MCP_DB_BACKEND. The in-memory store is just another backend, so there is
// no separate fallback code path in the managers. A single DB holds every table.
//
// Repository contract (all backends implement it):
//   jobs.init()                       -> rows[]  (ensure schema, reconcile running→error)
//   jobs.upsert(job)
//   values.replaceProperty(prop, { distinctCount, totalCount, nullCount, values:[{value,freq}], coverage:[{event,rowCount,nonNull}] })
//   values.top(prop, limit)           -> [{value,freq}]  (freq desc, value asc)
//   values.page(prop, { limit, offset, col:'freq'|'value', direction:'asc'|'desc' })
//   values.stats(prop)                -> { distinctCount, totalCount, nullCount, indexedAt } | null
//   values.coverage(prop)             -> [{event_name, row_count, non_null, null_count}] (row_count desc)
//   values.search(query, limit)       -> [{property,value,freq}] (substring, freq desc)
//   values.candidates(cap)            -> [{property,value,freq}] (top-freq pool for JS fuzzy rank)
//   values.counts()                   -> { properties, values }
//   runs.reconcile()                  (mark running→interrupted)
//   runs.start()                      -> id
//   runs.finish(id, { status, propertiesIndexed, valuesWritten, errors, error })
//   runs.all()                        -> rows[] (desc by id)
//   memory.add({ id, note, targets, aliases, links, created_at }) -> id
//   memory.get(id)                    -> { id, note, targets:[], aliases:[], links:[], created_at } | null
//   memory.remove(id)                 -> bool (a row existed)
//   memory.all({ limit })             -> rows[] (most recent first)
//   memory.counts()                   -> { notes }
//   close()

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ───────────────────────── in-memory backend (no persistence) ─────────────────────────
// The universal fallback when no persistent backend is available. Mirrors the SQLite
// ordering semantics exactly (freq desc, value-ASC tiebreak) so behaviour is identical.
export class MemoryBackend {
  constructor() {
    this.kind = 'memory';
    this.persistent = false;
    const props = new Map(); // property -> { distinctCount, totalCount, nullCount, indexedAt, values:[{value,freq}], coverage:[{event_name,row_count,non_null}] }
    const runs = [];
    const runProps = []; // { run_id, property, ms, values_written, distinct_count, total_count, status, error, started_at }
    const memory = new Map(); // id -> { id, note, targets:[], aliases:[], links:[], created_at }
    let runSeq = 0;

    this.jobs = {
      init: () => [], // nothing persisted; JobManager keeps the working set in its own Map
      upsert: () => {},
    };

    this.values = {
      replaceProperty: (property, { distinctCount, totalCount, nullCount, values = [], coverage = [] } = {}) => {
        props.set(property, {
          distinctCount: distinctCount ?? null,
          totalCount: totalCount ?? null,
          nullCount: nullCount ?? null,
          indexedAt: Date.now(),
          values: values.map((v) => ({ value: String(v.value), freq: Number(v.freq) || 0 })).sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)),
          coverage: coverage.map((e) => ({ event_name: String(e.event), row_count: Number(e.rowCount) || 0, non_null: Number(e.nonNull) || 0 }))
            .sort((a, b) => b.row_count - a.row_count || a.event_name.localeCompare(b.event_name)),
        });
      },
      top: (property, limit) => {
        const e = props.get(property);
        return e ? e.values.slice(0, limit).map((v) => ({ value: v.value, freq: v.freq })) : [];
      },
      page: (property, { limit, offset, col, direction }) => {
        const e = props.get(property);
        if (!e) return [];
        // primary key honours direction; ties always break on value ASC.
        const sign = direction === 'desc' ? -1 : 1;
        const arr = [...e.values].sort((a, b) => {
          const primary = col === 'value' ? String(a.value).localeCompare(String(b.value)) : a.freq - b.freq;
          return primary !== 0 ? sign * primary : String(a.value).localeCompare(String(b.value));
        });
        return arr.slice(offset, offset + limit).map((v) => ({ value: v.value, freq: v.freq }));
      },
      stats: (property) => {
        const e = props.get(property);
        return e ? { distinctCount: e.distinctCount, totalCount: e.totalCount, nullCount: e.nullCount, indexedAt: e.indexedAt } : null;
      },
      coverage: (property) => {
        const e = props.get(property);
        return e ? e.coverage.map((c) => ({ event_name: c.event_name, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null })) : [];
      },
      search: (query, limit) => {
        const q = String(query).toLowerCase();
        const out = [];
        for (const [property, e] of props) for (const v of e.values) if (v.value.toLowerCase().includes(q)) out.push({ property, value: v.value, freq: v.freq });
        return out.sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)).slice(0, limit);
      },
      // Bounded candidate pool for a fuzzy (typo-tolerant) value match, ranked in JS by
      // the caller. Highest-frequency values first so the cap keeps the most relevant.
      candidates: (cap = 5000) => {
        const out = [];
        for (const [property, e] of props) for (const v of e.values) out.push({ property, value: v.value, freq: v.freq });
        return out.sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)).slice(0, cap);
      },
      counts: () => ({ properties: props.size, values: [...props.values()].reduce((s, e) => s + e.values.length, 0) }),
    };

    // Analyst memory: durable, curated findings (see memory.js). Kept as plain objects
    // (targets/aliases/links are arrays here — the SQLite backend JSON-encodes them).
    this.memory = {
      add: (e) => { memory.set(e.id, { id: e.id, note: String(e.note), targets: [...(e.targets || [])], aliases: [...(e.aliases || [])], links: [...(e.links || [])], created_at: e.created_at ?? Date.now() }); return e.id; },
      get: (id) => { const e = memory.get(id); return e ? { ...e, targets: [...e.targets], aliases: [...e.aliases], links: [...e.links] } : null; },
      remove: (id) => memory.delete(id),
      all: ({ limit = 200 } = {}) => [...memory.values()].sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(a.id)).slice(0, limit).map((e) => ({ ...e, targets: [...e.targets], aliases: [...e.aliases], links: [...e.links] })),
      counts: () => ({ notes: memory.size }),
    };

    // Wipe state (used by MCP_DB_RESET on startup). Memory is curated knowledge that is
    // NOT re-derivable (unlike the value index, which the background indexer repopulates),
    // so a routine clean-slate reset deliberately PRESERVES it.
    this.reset = () => { props.clear(); runs.length = 0; runProps.length = 0; runSeq = 0; };

    this.runs = {
      reconcile: () => {},
      start: () => { const id = ++runSeq; runs.push({ id, started_at: Date.now(), finished_at: null, status: 'running', properties_indexed: null, values_written: null, errors: null, error: null }); return id; },
      finish: (id, f = {}) => { const r = runs.find((x) => x.id === id); if (r) Object.assign(r, { finished_at: Date.now(), status: f.status, properties_indexed: f.propertiesIndexed ?? null, values_written: f.valuesWritten ?? null, errors: f.errors ?? null, error: f.error ?? null }); },
      all: () => [...runs].sort((a, b) => b.id - a.id),
      get: (id) => runs.find((x) => x.id === id) || null,
      recordProperty: (runId, p = {}) => {
        const row = { run_id: runId, property: p.property, ms: p.ms ?? null, values_written: p.valuesWritten ?? null, distinct_count: p.distinctCount ?? null, total_count: p.totalCount ?? null, status: p.status ?? null, error: p.error ?? null, started_at: runs.find((x) => x.id === runId)?.started_at ?? null };
        const i = runProps.findIndex((x) => x.run_id === runId && x.property === p.property);
        if (i >= 0) runProps[i] = row; else runProps.push(row);
      },
      properties: (runId, { limit = 1000 } = {}) => runProps.filter((x) => x.run_id === runId).sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || String(a.property).localeCompare(b.property)).slice(0, limit),
      propertyHistory: (property, { limit = 20 } = {}) => runProps.filter((x) => x.property === property).sort((a, b) => b.run_id - a.run_id).slice(0, limit),
    };
  }

  close() { /* nothing to release */ }
}

// ───────────────────────── SQLite backend (node:sqlite) ─────────────────────────
// All SQL is encapsulated here. Prepared statements are cached per SQL string.
export class SqliteBackend {
  constructor(db) {
    this.kind = 'sqlite';
    this.persistent = true;
    this._db = db;
    this._stmts = new Map();
    db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, context_id TEXT, table_name TEXT, status TEXT, error TEXT, started_at INTEGER, ready_at INTEGER)');
    db.exec('CREATE TABLE IF NOT EXISTS prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
    db.exec('CREATE TABLE IF NOT EXISTS prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, null_count INTEGER, indexed_at INTEGER)');
    // null_count was added later; bring an older DB up to schema (SQLite has no ADD COLUMN IF NOT EXISTS).
    try { db.exec('ALTER TABLE prop_stats ADD COLUMN null_count INTEGER'); } catch { /* column already present */ }
    // Per-property × event_name coverage: row_count vs non_null per event, so a field that is
    // NULL on events it does not apply to (expected) is distinguishable from genuine gaps.
    db.exec('CREATE TABLE IF NOT EXISTS prop_coverage (property TEXT, event_name TEXT, row_count INTEGER, non_null INTEGER, PRIMARY KEY(property, event_name))');
    db.exec('CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, finished_at INTEGER, status TEXT, properties_indexed INTEGER, values_written INTEGER, errors INTEGER, error TEXT)');
    // Per-property timing within a run — detailed stats drilled into via semantic_index.
    db.exec('CREATE TABLE IF NOT EXISTS index_run_props (run_id INTEGER, property TEXT, ms INTEGER, values_written INTEGER, distinct_count INTEGER, total_count INTEGER, status TEXT, error TEXT, PRIMARY KEY(run_id, property))');
    // Analyst memory: durable curated findings. targets/aliases/links are JSON arrays.
    db.exec('CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, note TEXT, targets TEXT, aliases TEXT, links TEXT, created_at INTEGER)');
    const s = this;

    this.jobs = {
      init() {
        // a job left 'running' across a restart can never complete -> terminal error.
        s._run("UPDATE jobs SET status='error', error='interrupted by server restart; re-issue the query' WHERE status='running'");
        return s._all('SELECT * FROM jobs').map((r) => ({ id: r.id, contextId: r.context_id, table: r.table_name, status: r.status, error: r.error, startedAt: r.started_at, readyAt: r.ready_at }));
      },
      upsert(j) {
        s._run('INSERT INTO jobs (id, context_id, table_name, status, error, started_at, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id, table_name=excluded.table_name, status=excluded.status, error=excluded.error, ready_at=excluded.ready_at', j.id, j.contextId ?? null, j.table ?? null, j.status, j.error ?? null, j.startedAt, j.readyAt ?? null);
      },
    };

    this.values = {
      replaceProperty(property, { distinctCount, totalCount, nullCount, values = [], coverage = [] } = {}) {
        s._tx(() => {
          s._run('DELETE FROM prop_values WHERE property = ?', property);
          for (const v of values) s._run('INSERT INTO prop_values (property, value, freq) VALUES (?, ?, ?)', property, String(v.value), Number(v.freq) || 0);
          s._run('DELETE FROM prop_coverage WHERE property = ?', property);
          for (const e of coverage) s._run('INSERT INTO prop_coverage (property, event_name, row_count, non_null) VALUES (?, ?, ?, ?)', property, String(e.event), Number(e.rowCount) || 0, Number(e.nonNull) || 0);
          s._run('INSERT INTO prop_stats (property, distinct_count, total_count, null_count, indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(property) DO UPDATE SET distinct_count=excluded.distinct_count, total_count=excluded.total_count, null_count=excluded.null_count, indexed_at=excluded.indexed_at', property, distinctCount ?? null, totalCount ?? null, nullCount ?? null, Date.now());
        });
      },
      // value ASC tiebreak → deterministic on ties (value is unique per property via the PK).
      top(property, limit) {
        return s._all('SELECT value, freq FROM prop_values WHERE property = ? ORDER BY freq DESC, value ASC LIMIT ?', property, limit).map((r) => ({ value: r.value, freq: Number(r.freq) }));
      },
      page(property, { limit, offset, col, direction }) {
        // col ∈ {freq,value} and direction ∈ {asc,desc} are a closed set (normalised by the
        // caller), safe to interpolate; the value tiebreak keeps paging stable.
        const c = col === 'value' ? 'value' : 'freq';
        const d = direction === 'desc' ? 'DESC' : 'ASC';
        return s._all(`SELECT value, freq FROM prop_values WHERE property = ? ORDER BY ${c} ${d}, value ASC LIMIT ? OFFSET ?`, property, limit, offset).map((r) => ({ value: r.value, freq: Number(r.freq) }));
      },
      stats(property) {
        const r = s._get('SELECT distinct_count, total_count, null_count, indexed_at FROM prop_stats WHERE property = ?', property);
        return r ? { distinctCount: r.distinct_count, totalCount: r.total_count, nullCount: r.null_count, indexedAt: r.indexed_at } : null;
      },
      coverage(property) {
        return s._all('SELECT event_name, row_count, non_null FROM prop_coverage WHERE property = ? ORDER BY row_count DESC, event_name ASC', property)
          .map((r) => ({ event_name: r.event_name, row_count: Number(r.row_count), non_null: Number(r.non_null), null_count: Number(r.row_count) - Number(r.non_null) }));
      },
      search(query, limit) {
        const q = String(query).toLowerCase();
        return s._all('SELECT property, value, freq FROM prop_values WHERE instr(lower(value), ?) > 0 ORDER BY freq DESC, value ASC LIMIT ?', q, limit).map((r) => ({ property: r.property, value: r.value, freq: Number(r.freq) }));
      },
      // Bounded candidate pool for a fuzzy (typo-tolerant) value match, ranked in JS by
      // the caller. Highest-frequency values first so the cap keeps the most relevant.
      candidates(cap = 5000) {
        return s._all('SELECT property, value, freq FROM prop_values ORDER BY freq DESC, value ASC LIMIT ?', cap).map((r) => ({ property: r.property, value: r.value, freq: Number(r.freq) }));
      },
      counts() {
        return { properties: Number(s._get('SELECT COUNT(*) AS n FROM prop_stats').n), values: Number(s._get('SELECT COUNT(*) AS n FROM prop_values').n) };
      },
    };

    this.runs = {
      // a run left 'running' across a restart can never finish -> terminal 'interrupted'.
      reconcile() { s._run("UPDATE index_runs SET status='interrupted', finished_at=started_at WHERE finished_at IS NULL"); },
      start() { return Number(s._run("INSERT INTO index_runs (started_at, status) VALUES (?, 'running')", Date.now()).lastInsertRowid); },
      finish(id, f = {}) { s._run('UPDATE index_runs SET finished_at=?, status=?, properties_indexed=?, values_written=?, errors=?, error=? WHERE id=?', Date.now(), f.status, f.propertiesIndexed ?? null, f.valuesWritten ?? null, f.errors ?? null, f.error ?? null, id); },
      all() { return s._all('SELECT * FROM index_runs ORDER BY id DESC'); },
      get(id) { return s._get('SELECT * FROM index_runs WHERE id = ?', id) || null; },
      // per-property timing/coverage within a run
      recordProperty(runId, p = {}) {
        s._run('INSERT INTO index_run_props (run_id, property, ms, values_written, distinct_count, total_count, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, property) DO UPDATE SET ms=excluded.ms, values_written=excluded.values_written, distinct_count=excluded.distinct_count, total_count=excluded.total_count, status=excluded.status, error=excluded.error', runId, p.property, p.ms ?? null, p.valuesWritten ?? null, p.distinctCount ?? null, p.totalCount ?? null, p.status ?? null, p.error ?? null);
      },
      properties(runId, { limit = 1000 } = {}) { return s._all('SELECT * FROM index_run_props WHERE run_id = ? ORDER BY ms DESC, property ASC LIMIT ?', runId, limit); },
      propertyHistory(property, { limit = 20 } = {}) { return s._all('SELECT p.*, r.started_at FROM index_run_props p JOIN index_runs r ON r.id = p.run_id WHERE p.property = ? ORDER BY p.run_id DESC LIMIT ?', property, limit); },
    };

    // Analyst memory (curated findings). JSON columns are decoded back to arrays on read.
    const parseArr = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
    const memRow = (r) => (r ? { id: r.id, note: r.note, targets: parseArr(r.targets), aliases: parseArr(r.aliases), links: parseArr(r.links), created_at: Number(r.created_at) } : null);
    this.memory = {
      add(e) { s._run('INSERT INTO memory (id, note, targets, aliases, links, created_at) VALUES (?, ?, ?, ?, ?, ?)', e.id, String(e.note), JSON.stringify(e.targets || []), JSON.stringify(e.aliases || []), JSON.stringify(e.links || []), e.created_at ?? Date.now()); return e.id; },
      get(id) { return memRow(s._get('SELECT * FROM memory WHERE id = ?', id)); },
      remove(id) { return s._run('DELETE FROM memory WHERE id = ?', id).changes > 0; },
      all({ limit = 200 } = {}) { return s._all('SELECT * FROM memory ORDER BY created_at DESC, id DESC LIMIT ?', limit).map(memRow); },
      counts() { return { notes: Number(s._get('SELECT COUNT(*) AS n FROM memory').n) }; },
    };
  }

  _prep(sql) {
    let st = this._stmts.get(sql);
    if (!st) { st = this._db.prepare(sql); this._stmts.set(sql, st); }
    return st;
  }

  _run(sql, ...params) { return this._prep(sql).run(...params); }
  _get(sql, ...params) { return this._prep(sql).get(...params); }
  _all(sql, ...params) { return this._prep(sql).all(...params); }

  /**
   * Wipe persisted state (used by MCP_DB_RESET on startup). Keeps the schema. The `memory`
   * table is deliberately PRESERVED — it is curated, non-re-derivable knowledge (unlike the
   * value index, which the background indexer repopulates from the warehouse).
   */
  reset() {
    this._tx(() => {
      for (const t of ['jobs', 'prop_values', 'prop_stats', 'prop_coverage', 'index_runs', 'index_run_props']) this._run(`DELETE FROM ${t}`);
    });
  }

  _tx(fn) {
    this._db.exec('BEGIN');
    try { const r = fn(); this._db.exec('COMMIT'); return r; }
    catch (e) { try { this._db.exec('ROLLBACK'); } catch { /* noop */ } throw e; }
  }

  close() { try { this._db.close(); } catch { /* already closed */ } this._stmts.clear(); }
}

// ───────────────────────── backend registry + factory ─────────────────────────
const BACKENDS = new Map();

/** Register a storage backend factory: ({ dbPath }) => Backend | null (null → use memory). */
export function registerStoreBackend(name, factory) { BACKENDS.set(name, factory); }

/** Names of the registered backends (for diagnostics / discovery). */
export function storeBackends() { return [...BACKENDS.keys()]; }

// Built-in backend: node:sqlite (zero external deps, synchronous). Returns null when
// sqlite or a path is unavailable, so openStore falls back to the in-memory backend.
registerStoreBackend('sqlite', ({ dbPath }) => {
  if (!dbPath) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new SqliteBackend(new DatabaseSync(dbPath));
  } catch {
    return null;
  }
});

/**
 * Open the shared store. The backend is selectable (default 'sqlite', override via
 * MCP_DB_BACKEND or the `backend` arg) — the single switch point for changing databases.
 * ALWAYS returns a backend: falls back to the in-memory backend when no persistent one is
 * available, so callers never branch on null.
 */
export function openStore({ dbPath, backend, reset = false } = {}) {
  const name = backend || process.env.MCP_DB_BACKEND || 'sqlite';
  const factory = BACKENDS.get(name);
  if (!factory) throw new Error(`unknown store backend '${name}'. Registered: ${storeBackends().join(', ')}`);
  const store = factory({ dbPath }) || new MemoryBackend();
  if (reset) store.reset?.(); // wipe all state BEFORE any manager reads it (MCP_DB_RESET)
  return store;
}
