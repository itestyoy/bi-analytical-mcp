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
//   values.bundleCoverage(prop)       -> [{bundle, row_count, non_null, null_count}] (row_count desc)
//   values.bundles()                  -> [{bundle, row_count}] (distinct apps; max events per app)
//   values.bundlePropertyCoverage(b)  -> [{property, row_count, non_null, null_count}] (non_null desc)
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
//   memory.vectorPut(id, vec, model)  (store/mirror a note's embedding for semantic search)
//   memory.vectorIds(model)           -> Set<id> (notes already embedded for this model)
//   memory.vectorSearch(qvec, { limit, model }) -> [{ id, score }] (cosine; KNN via sqlite-vec)
//   close()

import { createRequire } from 'node:module';
import { cosineSimilarity } from './embeddings.js';

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
    const vectors = new Map(); // id -> { vec:number[], model } (semantic memory search)
    let runSeq = 0;

    this.jobs = {
      init: () => [], // nothing persisted; JobManager keeps the working set in its own Map
      upsert: () => {},
    };

    this.values = {
      replaceProperty: (property, { distinctCount, totalCount, nullCount, values = [], coverage = [], bundleCoverage = [] } = {}) => {
        props.set(property, {
          distinctCount: distinctCount ?? null,
          totalCount: totalCount ?? null,
          nullCount: nullCount ?? null,
          indexedAt: Date.now(),
          values: values.map((v) => ({ value: String(v.value), freq: Number(v.freq) || 0 })).sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)),
          coverage: coverage.map((e) => ({ event_name: String(e.event), row_count: Number(e.rowCount) || 0, non_null: Number(e.nonNull) || 0 }))
            .sort((a, b) => b.row_count - a.row_count || a.event_name.localeCompare(b.event_name)),
          bundleCoverage: bundleCoverage.map((e) => ({ bundle: String(e.bundle), row_count: Number(e.rowCount) || 0, non_null: Number(e.nonNull) || 0 }))
            .sort((a, b) => b.row_count - a.row_count || a.bundle.localeCompare(b.bundle)),
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
      // ── per-bundle (app) coverage of a property: which apps populate it vs leave it empty ──
      bundleCoverage: (property) => {
        const e = props.get(property);
        return e ? (e.bundleCoverage || []).map((c) => ({ bundle: c.bundle, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null })) : [];
      },
      // Distinct apps seen (max events per app across properties) — the catalogue of bundles.
      bundles: () => {
        const agg = new Map();
        for (const e of props.values()) for (const c of e.bundleCoverage || []) agg.set(c.bundle, Math.max(agg.get(c.bundle) ?? 0, c.row_count));
        return [...agg.entries()].map(([bundle, row_count]) => ({ bundle, row_count })).sort((a, b) => b.row_count - a.row_count || a.bundle.localeCompare(b.bundle));
      },
      // For one app: each property's coverage (non_null=0 → empty for this app).
      bundlePropertyCoverage: (bundle) => {
        const out = [];
        for (const [property, e] of props) for (const c of e.bundleCoverage || []) if (c.bundle === bundle) out.push({ property, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null });
        return out.sort((a, b) => b.non_null - a.non_null || a.property.localeCompare(b.property));
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
      add: (e) => { memory.set(e.id, { id: e.id, note: String(e.note), question: e.question ?? null, targets: [...(e.targets || [])], aliases: [...(e.aliases || [])], links: [...(e.links || [])], created_at: e.created_at ?? Date.now() }); return e.id; },
      get: (id) => { const e = memory.get(id); return e ? { ...e, targets: [...e.targets], aliases: [...e.aliases], links: [...e.links] } : null; },
      remove: (id) => { vectors.delete(id); return memory.delete(id); },
      all: ({ limit = 200 } = {}) => [...memory.values()].sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(a.id)).slice(0, limit).map((e) => ({ ...e, targets: [...e.targets], aliases: [...e.aliases], links: [...e.links] })),
      counts: () => ({ notes: memory.size }),
      // ── semantic (vector) search: JS cosine over stored embeddings (no native dep) ──
      vectorPut: (id, vec, model) => { if (memory.has(id)) vectors.set(id, { vec: Array.from(vec), model }); },
      vectorIds: (model) => new Set([...vectors.entries()].filter(([, v]) => v.model === model).map(([id]) => id)),
      vectorSearch: (qvec, { limit = 20, model } = {}) => [...vectors.entries()]
        .filter(([, v]) => v.model === model)
        .map(([id, v]) => ({ id, score: cosineSimilarity(qvec, v.vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit),
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
    // Per-property × bundle (app) coverage: row_count vs non_null per app, so a property that
    // is empty for one app but populated for another is visible (the { bundle } index view).
    db.exec('CREATE TABLE IF NOT EXISTS prop_bundle_coverage (property TEXT, bundle TEXT, row_count INTEGER, non_null INTEGER, PRIMARY KEY(property, bundle))');
    db.exec('CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, finished_at INTEGER, status TEXT, properties_indexed INTEGER, values_written INTEGER, errors INTEGER, error TEXT)');
    // Per-property timing within a run — detailed stats drilled into via semantic_index.
    db.exec('CREATE TABLE IF NOT EXISTS index_run_props (run_id INTEGER, property TEXT, ms INTEGER, values_written INTEGER, distinct_count INTEGER, total_count INTEGER, status TEXT, error TEXT, PRIMARY KEY(run_id, property))');
    // Analyst memory: durable curated findings. targets/aliases/links are JSON arrays.
    db.exec('CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, note TEXT, question TEXT, targets TEXT, aliases TEXT, links TEXT, created_at INTEGER, embedding TEXT, embedding_model TEXT)');
    // columns added later; bring an older DB up to schema (SQLite has no ADD COLUMN IF NOT EXISTS).
    for (const col of ['question TEXT', 'embedding TEXT', 'embedding_model TEXT']) { try { db.exec(`ALTER TABLE memory ADD COLUMN ${col}`); } catch { /* already present */ } }
    // Optional sqlite-vec extension → a vec0 virtual table gives true KNN (semantic memory
    // search). Best-effort: if it cannot load, vectorSearch falls back to in-SQL cosine.
    this._vec = false;
    try { require('sqlite-vec').load(db); this._vec = true; } catch { /* extension unavailable */ }
    // Track the vec0 table's fixed dimensionality/model; a change rebuilds it.
    db.exec('CREATE TABLE IF NOT EXISTS memory_vec_meta (only_row INTEGER PRIMARY KEY CHECK (only_row = 1), dims INTEGER, model TEXT)');
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
      replaceProperty(property, { distinctCount, totalCount, nullCount, values = [], coverage = [], bundleCoverage = [] } = {}) {
        s._tx(() => {
          s._run('DELETE FROM prop_values WHERE property = ?', property);
          for (const v of values) s._run('INSERT INTO prop_values (property, value, freq) VALUES (?, ?, ?)', property, String(v.value), Number(v.freq) || 0);
          s._run('DELETE FROM prop_coverage WHERE property = ?', property);
          for (const e of coverage) s._run('INSERT INTO prop_coverage (property, event_name, row_count, non_null) VALUES (?, ?, ?, ?)', property, String(e.event), Number(e.rowCount) || 0, Number(e.nonNull) || 0);
          s._run('DELETE FROM prop_bundle_coverage WHERE property = ?', property);
          for (const e of bundleCoverage) s._run('INSERT INTO prop_bundle_coverage (property, bundle, row_count, non_null) VALUES (?, ?, ?, ?)', property, String(e.bundle), Number(e.rowCount) || 0, Number(e.nonNull) || 0);
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
      // ── per-bundle (app) coverage: which apps populate a property vs leave it empty ──
      bundleCoverage(property) {
        return s._all('SELECT bundle, row_count, non_null FROM prop_bundle_coverage WHERE property = ? ORDER BY row_count DESC, bundle ASC', property)
          .map((r) => ({ bundle: r.bundle, row_count: Number(r.row_count), non_null: Number(r.non_null), null_count: Number(r.row_count) - Number(r.non_null) }));
      },
      bundles() {
        return s._all('SELECT bundle, MAX(row_count) AS row_count FROM prop_bundle_coverage GROUP BY bundle ORDER BY row_count DESC, bundle ASC')
          .map((r) => ({ bundle: r.bundle, row_count: Number(r.row_count) }));
      },
      bundlePropertyCoverage(bundle) {
        return s._all('SELECT property, row_count, non_null FROM prop_bundle_coverage WHERE bundle = ? ORDER BY non_null DESC, property ASC', bundle)
          .map((r) => ({ property: r.property, row_count: Number(r.row_count), non_null: Number(r.non_null), null_count: Number(r.row_count) - Number(r.non_null) }));
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
    const memRow = (r) => (r ? { id: r.id, note: r.note, question: r.question ?? null, targets: parseArr(r.targets), aliases: parseArr(r.aliases), links: parseArr(r.links), created_at: Number(r.created_at) } : null);
    this.memory = {
      add(e) { s._run('INSERT INTO memory (id, note, question, targets, aliases, links, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', e.id, String(e.note), e.question ?? null, JSON.stringify(e.targets || []), JSON.stringify(e.aliases || []), JSON.stringify(e.links || []), e.created_at ?? Date.now()); return e.id; },
      get(id) { return memRow(s._get('SELECT * FROM memory WHERE id = ?', id)); },
      remove(id) { if (s._vec) try { s._run('DELETE FROM memory_vec WHERE id = ?', id); } catch { /* no vec table */ } return s._run('DELETE FROM memory WHERE id = ?', id).changes > 0; },
      all({ limit = 200 } = {}) { return s._all('SELECT id, note, question, targets, aliases, links, created_at FROM memory ORDER BY created_at DESC, id DESC LIMIT ?', limit).map(memRow); },
      counts() { return { notes: Number(s._get('SELECT COUNT(*) AS n FROM memory').n) }; },

      // ── semantic (vector) search ──────────────────────────────────────────────
      // Store the vector on the note (source of truth) and mirror it into the vec0
      // index when sqlite-vec is loaded. The vec0 table has a FIXED dim/model; a change
      // rebuilds it (rows get re-embedded by the caller's backfill on the next search).
      vectorPut(id, vec, model) {
        const arr = Array.from(vec);
        s._run('UPDATE memory SET embedding = ?, embedding_model = ? WHERE id = ?', JSON.stringify(arr), model, id);
        if (!s._vec) return;
        const meta = s._get('SELECT dims, model FROM memory_vec_meta WHERE only_row = 1');
        if (!meta) {
          s._ensureVecTable(arr.length);
          s._run('INSERT INTO memory_vec_meta (only_row, dims, model) VALUES (1, ?, ?)', arr.length, model);
        } else if (meta.dims !== arr.length || meta.model !== model) {
          s._run('DROP TABLE IF EXISTS memory_vec');
          s._ensureVecTable(arr.length);
          s._run('UPDATE memory_vec_meta SET dims = ?, model = ? WHERE only_row = 1', arr.length, model);
        }
        // vec0 virtual tables do not support UPSERT → delete-then-insert to re-put a vector.
        s._run('DELETE FROM memory_vec WHERE id = ?', id);
        s._run('INSERT INTO memory_vec (id, embedding) VALUES (?, ?)', id, JSON.stringify(arr));
      },
      vectorIds(model) {
        return new Set(s._all('SELECT id FROM memory WHERE embedding IS NOT NULL AND embedding_model = ?', model).map((r) => r.id));
      },
      vectorSearch(qvec, { limit = 20, model } = {}) {
        const q = JSON.stringify(Array.from(qvec));
        const meta = s._vec ? s._get('SELECT dims, model FROM memory_vec_meta WHERE only_row = 1') : null;
        if (s._vec && meta && meta.model === model && Array.from(qvec).length === meta.dims) {
          // True KNN via sqlite-vec (cosine distance → similarity = 1 - distance).
          try { return s._all('SELECT id, distance FROM memory_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance', q, limit).map((r) => ({ id: r.id, score: 1 - Number(r.distance) })); }
          catch { /* fall through to in-SQL cosine */ }
        }
        // Fallback: JS cosine over the stored JSON vectors (extension absent / model mismatch).
        const qv = Array.from(qvec);
        return s._all('SELECT id, embedding FROM memory WHERE embedding IS NOT NULL AND embedding_model = ?', model)
          .map((r) => { try { return { id: r.id, score: cosineSimilarity(qv, JSON.parse(r.embedding)) }; } catch { return { id: r.id, score: 0 }; } })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
    };
  }

  /** Create the vec0 KNN table for a fixed dimensionality (cosine metric). */
  _ensureVecTable(dims) {
    this._db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${Number(dims)}] distance_metric=cosine)`);
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
      for (const t of ['jobs', 'prop_values', 'prop_stats', 'prop_coverage', 'prop_bundle_coverage', 'index_runs', 'index_run_props']) this._run(`DELETE FROM ${t}`);
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
    // allowExtension lets us load sqlite-vec for vector (semantic memory) search; harmless
    // when the extension is absent (the backend falls back to in-SQL cosine).
    return new SqliteBackend(new DatabaseSync(dbPath, { allowExtension: true }));
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
