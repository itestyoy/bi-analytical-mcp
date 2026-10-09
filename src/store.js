// One embedded database shared by all subsystems (the job registry, the value index and its runs,
// the analyst memory, the error log, the server's own facts),
// behind a REPOSITORY abstraction. The managers call domain methods (store.jobs.*,
// store.values.*, store.runs.*) and contain NO SQL — every query lives inside a backend.
// Swapping databases = implement these repositories for a new backend and register it;
// select it via MCP_DB_BACKEND. The in-memory store is just another backend, so there is
// no separate fallback code path in the managers. A single DB holds every table.
//
// Repository contract (all backends implement it):
//   jobs.init()                       -> rows[]  (ensure schema, reconcile running→error)
//   jobs.upsert(job)
//   meta.get(key) -> string | null;  meta.set(key, value)   (small server facts kept across restarts)
//   Every values.* row is keyed by (SOURCE, property): each catalog source owns its own index
//   space, so two events sources may carry the same property name without sharing a row. The
//   source is always the FIRST argument (null/undefined = every source, where a method allows it).
//   values.replaceProperty(source, property, { distinctCount, totalCount, nullCount, values:[{value,freq}], coverage:[{event,rowCount,nonNull}], bundleCoverage:[{bundle,…}], cellCoverage:[{bundle,event,rowCount,nonNull}], highCardinality, dataWatermark })
//   values.cellCoverage(source, property, { bundle, event }) -> { row_count, non_null, null_count } | null  (triple)
//   values.top(source, property, limit)   -> [{value,freq}]  (freq desc, value asc)
//   values.page(source, property, { limit, offset, col:'freq'|'value', direction:'asc'|'desc', tie:'asc'|'desc' })
//   values.stats(source, property)        -> { distinctCount, totalCount, nullCount, indexedAt, highCardinality, dataWatermark } | null
//   values.coverage(source, property)     -> [{event_name, row_count, non_null, null_count}] (row_count desc)
//   values.bundleCoverage(source, property) -> [{bundle, row_count, non_null, null_count}] (row_count desc)
//   values.bundles(source?)               -> [{source, bundle, row_count}] (apps PER SOURCE; never merged)
//   values.bundlePropertyCoverage(source?, bundle) -> [{source, property, row_count, non_null, null_count}] (per source)
//   values.search(query, limit)           -> [{source, property, value, freq}] (substring, freq desc)
//   values.candidates(cap)                -> [{source, property, value, freq}] (top-freq pool for JS fuzzy rank)
//   values.allCells(source, property)  -> [{bundle, event_name, row_count, non_null, null_count}]
//   values.counts()                   -> { properties, values }
//   values.valueCount(source, property) -> int (values STORED; vs distinct_count → capped?)
//   values.properties()               -> [{source, property}] (every indexed pair)
//   values.removeProperty(source, property)
//   runs.reconcile()                  (mark running→interrupted)
//   runs.start()                      -> id
//   runs.finish(id, { status, propertiesIndexed, valuesWritten, errors, error })
//   runs.all()                        -> rows[] (desc by id)
//   runs.get(id)                      -> row | null
//   runs.recordProperty(runId, { source, property, ms, valuesWritten, distinctCount, totalCount, status, error })
//   runs.properties(runId, { limit }) -> rows[] (slowest first)
//   runs.propertyHistory(source, property, { limit }) -> rows[] (newest run first)
//   runs.addNote(runId, note);  runs.notes(runId) -> [{ note, at }]
//   memory.add({ id, note, targets, aliases, links, created_at }) -> id
//   memory.get(id)                    -> { id, note, targets:[], aliases:[], links:[], created_at } | null
//   memory.remove(id)                 -> bool (a row existed)
//   memory.all({ limit, offset })     -> rows[] (most recent first)
//   memory.counts()                   -> { notes }
//   memory.vectorPut(id, vec, model)  (store/mirror a note's embedding for semantic search)
//   memory.vectorIds(model)           -> Set<id> (notes already embedded for this model)
//   memory.vectorSearch(qvec, { limit, model }) -> [{ id, score }] (cosine; KNN via sqlite-vec)
//   errors.add({ at, source, severity, tool, stage, field, code, context_id, task_id, message, args, detail, context, files, runtime }) -> id
//   errors.list({ since, until, source, severity, tool, stage, context_id, task_id, search, limit, offset }) -> { total, rows[] } (newest first)
//   errors.get(id)                    -> row | null   (args and detail in full)
//   errors.summary(filter)            -> [{ source, tool, stage, count, last_at }] (the same filter, grouped)
//   errors.prune({ before, keep })    -> removed count (older than `before`, beyond the newest `keep`)
//   reset()                           (wipe every table but memory and the error log — MCP_DB_RESET)
//   close()

import { createRequire } from 'node:module';
import { cosineSimilarity } from './embeddings.js';
import { setting } from './settings.js';

const require = createRequire(import.meta.url);

// ───────────────────────── in-memory backend (no persistence) ─────────────────────────
// The universal fallback when no persistent backend is available. Mirrors the SQLite
// ordering semantics exactly (freq desc, value-ASC tiebreak) so behaviour is identical.
export class MemoryBackend {
  constructor() {
    this.kind = 'memory';
    this.persistent = false;
    // source -> property -> { distinctCount, totalCount, nullCount, indexedAt, values:[{value,freq}],
    // coverage:[{event_name,row_count,non_null}], ... }. Each SOURCE owns its own index space, so
    // two events facts can carry the same property name without sharing a row.
    const bySource = new Map();
    const entryOf = (source, property) => bySource.get(source)?.get(property) || null;
    const putEntry = (source, property, e) => {
      let m = bySource.get(source);
      if (!m) { m = new Map(); bySource.set(source, m); }
      m.set(property, e);
    };
    function* allEntries() {
      for (const [source, m] of bySource) for (const [property, e] of m) yield { source, property, e };
    }
    const runs = [];
    const runProps = []; // { run_id, source, property, ms, values_written, distinct_count, total_count, status, error, started_at }
    const runNotes = []; // { run_id, note, at } — run-level events (e.g. a batch fell back to per-property)
    const memory = new Map(); // id -> { id, note, targets:[], aliases:[], links:[], created_at }
    const vectors = new Map(); // id -> { vec:number[], model } (semantic memory search)
    let runSeq = 0;

    this.jobs = {
      init: () => [], // nothing persisted; JobManager keeps the working set in its own Map
      upsert: () => {},
    };

    const meta = new Map();
    this.meta = {
      get: (key) => (meta.has(key) ? meta.get(key) : null),
      set: (key, value) => { meta.set(key, String(value)); },
    };

    this.values = {
      replaceProperty: (source, property, { distinctCount, totalCount, nullCount, values = [], coverage = [], bundleCoverage = [], cellCoverage = [], highCardinality = false, dataWatermark = null } = {}) => {
        putEntry(source, property, {
          distinctCount: distinctCount ?? null,
          totalCount: totalCount ?? null,
          nullCount: nullCount ?? null,
          indexedAt: Date.now(),
          highCardinality: !!highCardinality,
          dataWatermark: dataWatermark ?? null,
          values: values.map((v) => ({ value: String(v.value), freq: Number(v.freq) || 0 })).sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)),
          coverage: coverage.map((e) => ({ event_name: String(e.event), row_count: Number(e.rowCount) || 0, non_null: Number(e.nonNull) || 0 }))
            .sort((a, b) => b.row_count - a.row_count || a.event_name.localeCompare(b.event_name)),
          bundleCoverage: bundleCoverage.map((e) => ({ bundle: String(e.bundle), row_count: Number(e.rowCount) || 0, non_null: Number(e.nonNull) || 0 }))
            .sort((a, b) => b.row_count - a.row_count || a.bundle.localeCompare(b.bundle)),
          // Per (bundle × event) cell: keyed for O(1) lookup of the field's fill at a triple.
          cellCoverage: new Map(cellCoverage.map((e) => [`${e.bundle} ${e.event}`, { bundle: String(e.bundle), event_name: String(e.event), row_count: Number(e.rowCount) || 0, non_null: Number(e.nonNull) || 0 }])),
        });
      },
      top: (source, property, limit) => {
        const e = entryOf(source, property);
        return e ? e.values.slice(0, limit).map((v) => ({ value: v.value, freq: v.freq })) : [];
      },
      page: (source, property, { limit, offset, col, direction, tie = 'asc' }) => {
        const e = entryOf(source, property);
        if (!e) return [];
        // primary key honours direction; ties break on the value, ascending unless `tie` says desc.
        const sign = direction === 'desc' ? -1 : 1;
        const tieSign = tie === 'desc' ? -1 : 1;
        const arr = [...e.values].sort((a, b) => {
          const primary = col === 'value' ? String(a.value).localeCompare(String(b.value)) : a.freq - b.freq;
          return primary !== 0 ? sign * primary : tieSign * String(a.value).localeCompare(String(b.value));
        });
        return arr.slice(offset, offset + limit).map((v) => ({ value: v.value, freq: v.freq }));
      },
      stats: (source, property) => {
        const e = entryOf(source, property);
        return e ? { distinctCount: e.distinctCount, totalCount: e.totalCount, nullCount: e.nullCount, indexedAt: e.indexedAt, highCardinality: !!e.highCardinality, dataWatermark: e.dataWatermark ?? null } : null;
      },
      // All triple (bundle × event) cells for a property — used to MERGE a delta into what is stored.
      allCells: (source, property) => {
        const e = entryOf(source, property);
        return e && e.cellCoverage ? [...e.cellCoverage.values()].map((c) => ({ bundle: c.bundle, event: c.event_name, rowCount: c.row_count, nonNull: c.non_null })) : [];
      },
      coverage: (source, property) => {
        const e = entryOf(source, property);
        return e ? e.coverage.map((c) => ({ event_name: c.event_name, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null })) : [];
      },
      // ── per-bundle (app) coverage of a property: which apps populate it vs leave it empty ──
      bundleCoverage: (source, property) => {
        const e = entryOf(source, property);
        return e ? (e.bundleCoverage || []).map((c) => ({ bundle: c.bundle, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null })) : [];
      },
      // Apps seen during indexing, PER SOURCE: the same bundle id emits events into every source
      // that carries it, with a different row count in each, so an app is a (source, bundle) pair
      // and is never summed or maxed across sources. `source` filters to one source.
      bundles: (source) => {
        const agg = new Map();
        for (const { source: src, e } of allEntries()) {
          if (source && src !== source) continue;
          for (const c of e.bundleCoverage || []) { const k = `${src}\u0000${c.bundle}`; agg.set(k, { source: src, bundle: c.bundle, row_count: Math.max(agg.get(k)?.row_count ?? 0, c.row_count) }); }
        }
        return [...agg.values()].sort((a, b) => a.source.localeCompare(b.source) || b.row_count - a.row_count || a.bundle.localeCompare(b.bundle));
      },
      // For one app: each property's coverage (non_null=0 → empty for this app), per source.
      bundlePropertyCoverage: (source, bundle) => {
        const out = [];
        for (const { source: src, property, e } of allEntries()) {
          if (source && src !== source) continue;
          for (const c of e.bundleCoverage || []) if (c.bundle === bundle) out.push({ source: src, property, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null });
        }
        return out.sort((a, b) => a.source.localeCompare(b.source) || b.non_null - a.non_null || a.property.localeCompare(b.property));
      },
      // ── triple (property × bundle × event) cell: is the field filled at this exact combo? ──
      cellCoverage: (source, property, { bundle, event } = {}) => {
        const e = entryOf(source, property); if (!e || !e.cellCoverage) return null;
        const c = e.cellCoverage.get(`${bundle} ${event}`);
        return c ? { bundle: c.bundle, event_name: c.event_name, row_count: c.row_count, non_null: c.non_null, null_count: c.row_count - c.non_null } : null;
      },
      search: (query, limit) => {
        const q = String(query).toLowerCase();
        const out = [];
        for (const { source, property, e } of allEntries()) for (const v of e.values) if (v.value.toLowerCase().includes(q)) out.push({ source, property, value: v.value, freq: v.freq });
        return out.sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)).slice(0, limit);
      },
      // Bounded candidate pool for a fuzzy (typo-tolerant) value match, ranked in JS by
      // the caller. Highest-frequency values first so the cap keeps the most relevant.
      candidates: (cap = 5000) => {
        const out = [];
        for (const { source, property, e } of allEntries()) for (const v of e.values) out.push({ source, property, value: v.value, freq: v.freq });
        return out.sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)).slice(0, cap);
      },
      counts: () => {
        let properties = 0; let values = 0;
        for (const { e } of allEntries()) { properties += 1; values += e.values.length; }
        return { properties, values };
      },
      // How many values are actually STORED for a property (the indexer caps at top-N) —
      // compared to distinct_count it reveals whether rare values were left out of the index.
      valueCount: (source, property) => { const e = entryOf(source, property); return e ? e.values.length : 0; },
      // Every indexed key as { source, property } — used to reconcile the index against the live schema.
      properties: () => [...allEntries()].map(({ source, property }) => ({ source, property })),
      // Drop everything stored for one property (a column gone from the table) — no full reindex.
      removeProperty: (source, property) => !!bySource.get(source)?.delete(property),
    };

    // Analyst memory: durable, curated findings (see memory.js). Kept as plain objects
    // (targets/aliases/links are arrays here — the SQLite backend JSON-encodes them).
    this.memory = {
      add: (e) => { memory.set(e.id, { id: e.id, note: String(e.note), question: e.question ?? null, targets: [...(e.targets || [])], aliases: [...(e.aliases || [])], links: [...(e.links || [])], created_at: e.created_at ?? Date.now() }); return e.id; },
      get: (id) => { const e = memory.get(id); return e ? { ...e, targets: [...e.targets], aliases: [...e.aliases], links: [...e.links] } : null; },
      remove: (id) => { vectors.delete(id); return memory.delete(id); },
      all: ({ limit = 200, offset = 0 } = {}) => [...memory.values()].sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(a.id)).slice(offset, offset + limit).map((e) => ({ ...e, targets: [...e.targets], aliases: [...e.aliases], links: [...e.links] })),
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

    // The error log (src/error-log.js): what failed, where — kept for debugging, newest first.
    const errors = [];
    let errorSeq = 0;
    const errorMatch = (f = {}) => (e) => (f.since == null || e.at >= f.since) && (f.until == null || e.at <= f.until)
      && ['source', 'severity', 'tool', 'stage', 'context_id', 'task_id'].every((k) => f[k] == null || e[k] === f[k])
      && (f.search == null || `${e.message || ''} ${e.detail || ''}`.toLowerCase().includes(String(f.search).toLowerCase()));
    this.errors = {
      add: (e) => { const id = ++errorSeq; errors.push({ id, ...e }); return id; },
      list: ({ limit = 20, offset = 0, ...f } = {}) => {
        const hit = errors.filter(errorMatch(f)).sort((a, b) => b.id - a.id);
        return { total: hit.length, rows: hit.slice(offset, offset + limit).map((e) => ({ ...e })) };
      },
      get: (id) => { const e = errors.find((x) => x.id === Number(id)); return e ? { ...e } : null; },
      summary: (f = {}) => {
        const by = new Map();
        for (const e of errors.filter(errorMatch(f))) {
          const k = `${e.source}\u0000${e.tool}\u0000${e.stage}`;
          const g = by.get(k) || { source: e.source, tool: e.tool ?? null, stage: e.stage ?? null, count: 0, last_at: 0 };
          g.count += 1; g.last_at = Math.max(g.last_at, e.at);
          by.set(k, g);
        }
        return [...by.values()].sort((a, b) => b.count - a.count || b.last_at - a.last_at);
      },
      prune: ({ before = null, keep = null } = {}) => {
        const n = errors.length;
        const newest = [...errors].sort((a, b) => b.id - a.id);
        const kept = new Set(newest.filter((e, i) => (before == null || e.at >= before) && (keep == null || i < keep)).map((e) => e.id));
        for (let i = errors.length - 1; i >= 0; i -= 1) if (!kept.has(errors[i].id)) errors.splice(i, 1);
        return n - errors.length;
      },
    };

    // Wipe state (used by MCP_DB_RESET on startup). Memory is curated knowledge that is
    // NOT re-derivable (unlike the value index, which the background indexer repopulates),
    // so a routine clean-slate reset deliberately PRESERVES it.
    this.reset = () => { bySource.clear(); runs.length = 0; runProps.length = 0; runNotes.length = 0; runSeq = 0; };

    this.runs = {
      reconcile: () => {},
      start: () => { const id = ++runSeq; runs.push({ id, started_at: Date.now(), finished_at: null, status: 'running', properties_indexed: null, values_written: null, errors: null, error: null }); return id; },
      finish: (id, f = {}) => { const r = runs.find((x) => x.id === id); if (r) Object.assign(r, { finished_at: Date.now(), status: f.status, properties_indexed: f.propertiesIndexed ?? null, values_written: f.valuesWritten ?? null, errors: f.errors ?? null, error: f.error ?? null }); },
      all: () => [...runs].sort((a, b) => b.id - a.id),
      get: (id) => runs.find((x) => x.id === id) || null,
      recordProperty: (runId, p = {}) => {
        if (!p.source || !p.property) throw new Error('recordProperty needs both source and property — a run row is keyed by (run, source, property)');
        const row = { run_id: runId, source: p.source, property: p.property, ms: p.ms ?? null, values_written: p.valuesWritten ?? null, distinct_count: p.distinctCount ?? null, total_count: p.totalCount ?? null, status: p.status ?? null, error: p.error ?? null, started_at: runs.find((x) => x.id === runId)?.started_at ?? null };
        const i = runProps.findIndex((x) => x.run_id === runId && x.source === row.source && x.property === p.property);
        if (i >= 0) runProps[i] = row; else runProps.push(row);
      },
      properties: (runId, { limit = 1000 } = {}) => runProps.filter((x) => x.run_id === runId).sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || String(a.property).localeCompare(b.property)).slice(0, limit),
      propertyHistory: (source, property, { limit = 20 } = {}) => runProps.filter((x) => x.source === source && x.property === property).sort((a, b) => b.run_id - a.run_id).slice(0, limit),
      addNote: (runId, note) => { runNotes.push({ run_id: runId, note: String(note), at: Date.now() }); },
      notes: (runId) => runNotes.filter((x) => x.run_id === runId).map((x) => ({ note: x.note, at: x.at })),
    };
  }

  close() { /* nothing to release */ }
}

// ───────────────────────── SQLite backend (node:sqlite) ─────────────────────────
// The store's tables, each declared ONCE: its columns, its key, whether it is a CACHE the server
// rebuilds on its own (the value index and its runs, which the background scan repopulates), and
// whether it is KEPT by MCP_DB_RESET (curated memory and the error log are not re-derivable).
const TABLES = [
  // `tool`: the tool that started a task, which says which query tool reads it back;
  // `drawn`: the task's one card was drawn — a card still open after a restart reads its own result;
  // `kept_rows`: how many of a stored result's rows the task's answer holds — what a card draws of it
  // after a restart too
  { name: 'jobs', key: ['id'], columns: ['id TEXT', 'context_id TEXT', 'table_name TEXT', 'status TEXT', 'error TEXT', 'started_at INTEGER', 'ready_at INTEGER', 'tool TEXT', 'drawn INTEGER', 'display TEXT', 'kept_rows INTEGER'] },
  // Every index table is keyed by (SOURCE, property): each catalog source — an events fact, the users
  // dimension — owns its own index space, so two facts may carry the same property name.
  { name: 'prop_values', cache: true, key: ['source', 'property', 'value'], columns: ['source TEXT', 'property TEXT', 'value TEXT', 'freq INTEGER'] },
  //  null_count       — nulls per property.
  //  high_cardinality — 1 when the field is near-unique (distinct ≥ threshold): its top-N is noise,
  //                     so subsequent syncs SKIP it (indexed once, then left alone).
  //  data_watermark   — max event-time (epoch ms) indexed so far; the incremental-merge path scans
  //                     only rows newer than this and ADDS the new counts to what is stored.
  { name: 'prop_stats', cache: true, key: ['source', 'property'], columns: ['source TEXT', 'property TEXT', 'distinct_count INTEGER', 'total_count INTEGER', 'null_count INTEGER', 'high_cardinality INTEGER', 'data_watermark INTEGER', 'indexed_at INTEGER'] },
  // Per-property × event_name coverage: row_count vs non_null per event, so a field that is
  // NULL on events it does not apply to (expected) is distinguishable from genuine gaps.
  { name: 'prop_coverage', cache: true, key: ['source', 'property', 'event_name'], columns: ['source TEXT', 'property TEXT', 'event_name TEXT', 'row_count INTEGER', 'non_null INTEGER'] },
  // Per-property × bundle (app) coverage: row_count vs non_null per app, so a property that
  // is empty for one app but populated for another is visible (the { bundle } index view).
  { name: 'prop_bundle_coverage', cache: true, key: ['source', 'property', 'bundle'], columns: ['source TEXT', 'property TEXT', 'bundle TEXT', 'row_count INTEGER', 'non_null INTEGER'] },
  // Per-property × bundle × event TRIPLE coverage: the exact fill of a field at one app+event
  // combo — so a pipeline-model step scoped to a concrete bundle_id AND event_name can warn the
  // field is always NULL there (the marginals above can miss a cell that is empty only jointly).
  { name: 'prop_bundle_event_coverage', cache: true, key: ['source', 'property', 'bundle', 'event_name'], columns: ['source TEXT', 'property TEXT', 'bundle TEXT', 'event_name TEXT', 'row_count INTEGER', 'non_null INTEGER'] },
  { name: 'index_runs', cache: true, key: ['id'], columns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'started_at INTEGER', 'finished_at INTEGER', 'status TEXT', 'properties_indexed INTEGER', 'values_written INTEGER', 'errors INTEGER', 'error TEXT'] },
  // Per-property timing within a run — detailed stats drilled into via semantic_index.
  // Per-property run rows are keyed by (run, SOURCE, property) like every other index table.
  { name: 'index_run_props', cache: true, key: ['run_id', 'source', 'property'], columns: ['run_id INTEGER', 'source TEXT', 'property TEXT', 'ms INTEGER', 'values_written INTEGER', 'distinct_count INTEGER', 'total_count INTEGER', 'status TEXT', 'error TEXT'] },
  // Run-level events surfaced in semantic_index({ request: { status } })/({ run }), e.g. "a batch fell
  // back to per-property because the combined scan failed: <reason>".
  { name: 'index_run_notes', cache: true, key: [], columns: ['run_id INTEGER', 'note TEXT', 'at INTEGER'] },
  // Analyst memory: durable curated findings. targets/aliases/links are JSON arrays.
  { name: 'memory', kept: true, key: ['id'], columns: ['id TEXT', 'note TEXT', 'question TEXT', 'targets TEXT', 'aliases TEXT', 'links TEXT', 'created_at INTEGER', 'embedding TEXT', 'embedding_model TEXT'] },
  // Track the vec0 table's fixed dimensionality/model; a change rebuilds it.
  { name: 'memory_vec_meta', kept: true, key: ['only_row'], columns: ['only_row INTEGER PRIMARY KEY CHECK (only_row = 1)', 'dims INTEGER', 'model TEXT'] },
  { name: 'server_meta', kept: true, key: ['key'], columns: ['key TEXT', 'value TEXT'] },
  // with what reproduces an error: the context's state, the code of the model that failed, the runtime
  { name: 'errors', kept: true, key: ['id'], columns: ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'at INTEGER', 'source TEXT', 'severity TEXT', 'tool TEXT', 'stage TEXT', 'field TEXT', 'code TEXT', 'context_id TEXT', 'task_id TEXT', 'message TEXT', 'args TEXT', 'detail TEXT', 'context TEXT', 'files TEXT', 'runtime TEXT'] },
];

/**
 * A database is brought to the declared tables, whichever version of the server wrote it: a missing
 * table is created and a missing column added (SQLite has no ADD COLUMN IF NOT EXISTS, so only what
 * the table lacks — a failure to add it is the error it is). A table keyed otherwise cannot be
 * widened in place (every ON CONFLICT on the declared key would be rejected): a cache is dropped and
 * recreated — its rows are rebuilt — as is a table MCP_DB_RESET wipes when the store is opened with
 * `reset`; a table it keeps is refused, naming both keys.
 */
function bringToSchema(db, { name, key, columns, cache = false, kept = false }, { reset = false } = {}) {
  const have = db.prepare(`PRAGMA table_info(${name})`).all();
  if (have.length) {
    const keyed = have.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name); // pk: 1-based position in the key
    if (keyed.join() !== key.join()) {
      if (!cache && (kept || !reset)) throw new Error(`store: table ${name} is keyed by (${keyed.join(', ')}), this server keys it by (${key.join(', ')}) — it cannot be changed in place${kept ? '' : '; MCP_DB_RESET=1 clears it'}`);
      db.exec(`DROP TABLE ${name}`);
    } else {
      const names = new Set(have.map((c) => c.name));
      for (const def of columns) if (!names.has(def.split(' ')[0])) db.exec(`ALTER TABLE ${name} ADD COLUMN ${def}`);
    }
  }
  const inline = columns.some((d) => /PRIMARY KEY/.test(d));
  db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns.join(', ')}${key.length && !inline ? `, PRIMARY KEY(${key.join(', ')})` : ''})`);
}

// All SQL is encapsulated here. Prepared statements are cached per SQL string.
export class SqliteBackend {
  constructor(db, { reset = false } = {}) {
    this.kind = 'sqlite';
    this.persistent = true;
    this._db = db;
    this._stmts = new Map();
    for (const table of TABLES) bringToSchema(db, table, { reset });
    // Optional sqlite-vec extension → a vec0 virtual table gives true KNN (semantic memory
    // search). Best-effort: if it cannot load, vectorSearch falls back to in-SQL cosine.
    this._vec = false;
    try { require('sqlite-vec').load(db); this._vec = true; } catch { /* extension unavailable */ }
    db.exec('CREATE INDEX IF NOT EXISTS errors_at ON errors (at)');
    const s = this;
    // every row a table holds for one (source, property), replaced by `rows` — each row the values of
    // `columns`, after the source and the property (the table names are this file's own)
    const replaceRows = (table, source, property, columns, rows) => {
      s._run(`DELETE FROM ${table} WHERE source = ? AND property = ?`, source, property);
      const insert = `INSERT INTO ${table} (source, property, ${columns.join(', ')}) VALUES (${['?', '?', ...columns.map(() => '?')].join(', ')})`;
      for (const row of rows) s._run(insert, source, property, ...row);
    };
    // a coverage row as the value index reads it: the rows, the ones that carry the property, the NULLs
    const fill = (r) => ({ row_count: Number(r.row_count), non_null: Number(r.non_null), null_count: Number(r.row_count) - Number(r.non_null) });

    this.meta = {
      get(key) { return s._all('SELECT value FROM server_meta WHERE key = ?', key)[0]?.value ?? null; },
      set(key, value) { s._run('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)); },
    };

    // The error log (src/error-log.js). A filter is built from fixed column names only; every value
    // is a bound parameter.
    const ERROR_COLS = ['source', 'severity', 'tool', 'stage', 'context_id', 'task_id'];
    const errorWhere = (f = {}) => {
      const w = []; const p = [];
      if (f.since != null) { w.push('at >= ?'); p.push(f.since); }
      if (f.until != null) { w.push('at <= ?'); p.push(f.until); }
      for (const k of ERROR_COLS) if (f[k] != null) { w.push(`${k} = ?`); p.push(f[k]); }
      if (f.search != null) { w.push("lower(coalesce(message, '') || ' ' || coalesce(detail, '')) LIKE ? ESCAPE '\\'"); p.push(`%${String(f.search).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
      return { sql: w.length ? ` WHERE ${w.join(' AND ')}` : '', params: p };
    };
    this.errors = {
      add(e) {
        return Number(s._run('INSERT INTO errors (at, source, severity, tool, stage, field, code, context_id, task_id, message, args, detail, context, files, runtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          e.at, e.source ?? null, e.severity ?? null, e.tool ?? null, e.stage ?? null, e.field ?? null, e.code ?? null, e.context_id ?? null, e.task_id ?? null, e.message ?? null, e.args ?? null, e.detail ?? null, e.context ?? null, e.files ?? null, e.runtime ?? null).lastInsertRowid);
      },
      list({ limit = 20, offset = 0, ...f } = {}) {
        const { sql, params } = errorWhere(f);
        const total = Number(s._get(`SELECT count(*) AS n FROM errors${sql}`, ...params).n);
        return { total, rows: s._all(`SELECT * FROM errors${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset) };
      },
      get(id) { return s._get('SELECT * FROM errors WHERE id = ?', Number(id)) || null; },
      summary(f = {}) {
        const { sql, params } = errorWhere(f);
        return s._all(`SELECT source, tool, stage, count(*) AS count, max(at) AS last_at FROM errors${sql} GROUP BY source, tool, stage ORDER BY count DESC, last_at DESC`, ...params).map((r) => ({ ...r, count: Number(r.count) }));
      },
      prune({ before = null, keep = null } = {}) {
        let n = 0;
        if (before != null) n += Number(s._run('DELETE FROM errors WHERE at < ?', before).changes);
        if (keep != null) n += Number(s._run('DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT ?)', keep).changes);
        return n;
      },
    };

    this.jobs = {
      init() {
        // a job left 'running' across a restart can never complete -> terminal error.
        s._run("UPDATE jobs SET status='error', error='interrupted by server restart; re-issue the query' WHERE status='running'");
        return s._all('SELECT * FROM jobs').map((r) => ({ id: r.id, contextId: r.context_id, table: r.table_name, status: r.status, error: r.error, startedAt: r.started_at, readyAt: r.ready_at, tool: r.tool, ...(r.kept_rows != null ? { keptRows: Number(r.kept_rows) } : {}), ...(r.drawn ? { drawn: true } : {}), ...(r.display ? { display: (() => { try { return JSON.parse(r.display); } catch { return undefined; } })() } : {}) }));
      },
      upsert(j) {
        s._run('INSERT INTO jobs (id, context_id, table_name, status, error, started_at, ready_at, tool, drawn, display, kept_rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id, table_name=excluded.table_name, status=excluded.status, error=excluded.error, ready_at=excluded.ready_at, tool=excluded.tool, drawn=excluded.drawn, display=excluded.display, kept_rows=excluded.kept_rows', j.id, j.contextId ?? null, j.table ?? null, j.status, j.error ?? null, j.startedAt, j.readyAt ?? null, j.tool ?? null, j.drawn ? 1 : null, j.display ? JSON.stringify(j.display) : null, j.keptRows ?? null);
      },
    };

    this.values = {
      replaceProperty(source, property, { distinctCount, totalCount, nullCount, values = [], coverage = [], bundleCoverage = [], cellCoverage = [], highCardinality = false, dataWatermark = null } = {}) {
        s._tx(() => {
          const counts = (e) => [Number(e.rowCount) || 0, Number(e.nonNull) || 0];
          replaceRows('prop_values', source, property, ['value', 'freq'], values.map((v) => [String(v.value), Number(v.freq) || 0]));
          replaceRows('prop_coverage', source, property, ['event_name', 'row_count', 'non_null'], coverage.map((e) => [String(e.event), ...counts(e)]));
          replaceRows('prop_bundle_coverage', source, property, ['bundle', 'row_count', 'non_null'], bundleCoverage.map((e) => [String(e.bundle), ...counts(e)]));
          replaceRows('prop_bundle_event_coverage', source, property, ['bundle', 'event_name', 'row_count', 'non_null'], cellCoverage.map((e) => [String(e.bundle), String(e.event), ...counts(e)]));
          s._run('INSERT INTO prop_stats (source, property, distinct_count, total_count, null_count, indexed_at, high_cardinality, data_watermark) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, property) DO UPDATE SET distinct_count=excluded.distinct_count, total_count=excluded.total_count, null_count=excluded.null_count, indexed_at=excluded.indexed_at, high_cardinality=excluded.high_cardinality, data_watermark=excluded.data_watermark', source, property, distinctCount ?? null, totalCount ?? null, nullCount ?? null, Date.now(), highCardinality ? 1 : 0, dataWatermark ?? null);
        });
      },
      // value ASC tiebreak → deterministic on ties (value is unique per property via the PK).
      top(source, property, limit) {
        return s._all('SELECT value, freq FROM prop_values WHERE source = ? AND property = ? ORDER BY freq DESC, value ASC LIMIT ?', source, property, limit).map((r) => ({ value: r.value, freq: Number(r.freq) }));
      },
      page(source, property, { limit, offset, col, direction, tie = 'asc' }) {
        // col ∈ {freq,value} and direction/tie ∈ {asc,desc} are a closed set (normalised by the
        // caller), safe to interpolate; the value tiebreak keeps paging stable.
        const c = col === 'value' ? 'value' : 'freq';
        const d = direction === 'desc' ? 'DESC' : 'ASC';
        const t = tie === 'desc' ? 'DESC' : 'ASC';
        return s._all(`SELECT value, freq FROM prop_values WHERE source = ? AND property = ? ORDER BY ${c} ${d}, value ${t} LIMIT ? OFFSET ?`, source, property, limit, offset).map((r) => ({ value: r.value, freq: Number(r.freq) }));
      },
      stats(source, property) {
        const r = s._get('SELECT distinct_count, total_count, null_count, indexed_at, high_cardinality, data_watermark FROM prop_stats WHERE source = ? AND property = ?', source, property);
        return r ? { distinctCount: r.distinct_count, totalCount: r.total_count, nullCount: r.null_count, indexedAt: r.indexed_at, highCardinality: !!r.high_cardinality, dataWatermark: r.data_watermark ?? null } : null;
      },
      // All triple (bundle × event) cells for a property — used to MERGE a delta into what is stored.
      allCells(source, property) {
        return s._all('SELECT bundle, event_name, row_count, non_null FROM prop_bundle_event_coverage WHERE source = ? AND property = ?', source, property)
          .map((r) => ({ bundle: r.bundle, event: r.event_name, rowCount: Number(r.row_count), nonNull: Number(r.non_null) }));
      },
      coverage(source, property) {
        return s._all('SELECT event_name, row_count, non_null FROM prop_coverage WHERE source = ? AND property = ? ORDER BY row_count DESC, event_name ASC', source, property)
          .map((r) => ({ event_name: r.event_name, ...fill(r) }));
      },
      // ── per-bundle (app) coverage: which apps populate a property vs leave it empty ──
      bundleCoverage(source, property) {
        return s._all('SELECT bundle, row_count, non_null FROM prop_bundle_coverage WHERE source = ? AND property = ? ORDER BY row_count DESC, bundle ASC', source, property)
          .map((r) => ({ bundle: r.bundle, ...fill(r) }));
      },
      // An app is a (source, bundle) pair — never aggregated across sources (see the memory backend).
      bundles(source) {
        const rows = source
          ? s._all('SELECT source, bundle, MAX(row_count) AS row_count FROM prop_bundle_coverage WHERE source = ? GROUP BY source, bundle ORDER BY source ASC, row_count DESC, bundle ASC', source)
          : s._all('SELECT source, bundle, MAX(row_count) AS row_count FROM prop_bundle_coverage GROUP BY source, bundle ORDER BY source ASC, row_count DESC, bundle ASC');
        return rows.map((r) => ({ source: r.source, bundle: r.bundle, row_count: Number(r.row_count) }));
      },
      bundlePropertyCoverage(source, bundle) {
        const rows = source
          ? s._all('SELECT source, property, row_count, non_null FROM prop_bundle_coverage WHERE bundle = ? AND source = ? ORDER BY source ASC, non_null DESC, property ASC', bundle, source)
          : s._all('SELECT source, property, row_count, non_null FROM prop_bundle_coverage WHERE bundle = ? ORDER BY source ASC, non_null DESC, property ASC', bundle);
        return rows.map((r) => ({ source: r.source, property: r.property, ...fill(r) }));
      },
      // ── triple (property × bundle × event) cell lookup: the field's fill at one combo ──
      cellCoverage(source, property, { bundle, event } = {}) {
        const r = s._get('SELECT row_count, non_null FROM prop_bundle_event_coverage WHERE source = ? AND property = ? AND bundle = ? AND event_name = ?', source, property, String(bundle), String(event));
        return r ? { bundle, event_name: event, ...fill(r) } : null;
      },
      search(query, limit) {
        const q = String(query).toLowerCase();
        return s._all('SELECT source, property, value, freq FROM prop_values WHERE instr(lower(value), ?) > 0 ORDER BY freq DESC, value ASC LIMIT ?', q, limit).map((r) => ({ source: r.source, property: r.property, value: r.value, freq: Number(r.freq) }));
      },
      // Bounded candidate pool for a fuzzy (typo-tolerant) value match, ranked in JS by
      // the caller. Highest-frequency values first so the cap keeps the most relevant.
      candidates(cap = 5000) {
        return s._all('SELECT source, property, value, freq FROM prop_values ORDER BY freq DESC, value ASC LIMIT ?', cap).map((r) => ({ source: r.source, property: r.property, value: r.value, freq: Number(r.freq) }));
      },
      valueCount(source, property) {
        return Number(s._get('SELECT COUNT(*) AS n FROM prop_values WHERE source = ? AND property = ?', source, property).n);
      },
      counts() {
        return { properties: Number(s._get('SELECT COUNT(*) AS n FROM prop_stats').n), values: Number(s._get('SELECT COUNT(*) AS n FROM prop_values').n) };
      },
      // All indexed property keys — used to reconcile the index against the live schema.
      properties() {
        return s._all('SELECT source, property FROM prop_stats').map((r) => ({ source: r.source, property: r.property }));
      },
      // Drop EVERYTHING stored for one property (a column gone from the table) — no full reindex.
      removeProperty(source, property) {
        s._tx(() => {
          for (const tbl of ['prop_values', 'prop_coverage', 'prop_bundle_coverage', 'prop_bundle_event_coverage', 'prop_stats']) {
            s._run(`DELETE FROM ${tbl} WHERE source = ? AND property = ?`, source, property);
          }
        });
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
        // (run, source, property) is this table's PRIMARY KEY, and SQLite lets NULL into it without
        // ever conflicting: a row missing its source would be inserted afresh on every write.
        if (!p.source || !p.property) throw new Error('recordProperty needs both source and property — a run row is keyed by (run, source, property)');
        s._run('INSERT INTO index_run_props (run_id, source, property, ms, values_written, distinct_count, total_count, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, source, property) DO UPDATE SET ms=excluded.ms, values_written=excluded.values_written, distinct_count=excluded.distinct_count, total_count=excluded.total_count, status=excluded.status, error=excluded.error', runId, p.source, p.property, p.ms ?? null, p.valuesWritten ?? null, p.distinctCount ?? null, p.totalCount ?? null, p.status ?? null, p.error ?? null);
      },
      properties(runId, { limit = 1000 } = {}) { return s._all('SELECT * FROM index_run_props WHERE run_id = ? ORDER BY ms DESC, property ASC LIMIT ?', runId, limit); },
      propertyHistory(source, property, { limit = 20 } = {}) { return s._all('SELECT p.*, r.started_at FROM index_run_props p JOIN index_runs r ON r.id = p.run_id WHERE p.source = ? AND p.property = ? ORDER BY p.run_id DESC LIMIT ?', source, property, limit); },
      addNote(runId, note) { s._run('INSERT INTO index_run_notes (run_id, note, at) VALUES (?, ?, ?)', runId, String(note), Date.now()); },
      notes(runId) { return s._all('SELECT note, at FROM index_run_notes WHERE run_id = ? ORDER BY at ASC', runId).map((r) => ({ note: r.note, at: Number(r.at) })); },
    };

    // Analyst memory (curated findings). JSON columns are decoded back to arrays on read.
    const parseArr = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
    const memRow = (r) => (r ? { id: r.id, note: r.note, question: r.question ?? null, targets: parseArr(r.targets), aliases: parseArr(r.aliases), links: parseArr(r.links), created_at: Number(r.created_at) } : null);
    this.memory = {
      add(e) { s._run('INSERT INTO memory (id, note, question, targets, aliases, links, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', e.id, String(e.note), e.question ?? null, JSON.stringify(e.targets || []), JSON.stringify(e.aliases || []), JSON.stringify(e.links || []), e.created_at ?? Date.now()); return e.id; },
      get(id) { return memRow(s._get('SELECT * FROM memory WHERE id = ?', id)); },
      remove(id) { if (s._vec) try { s._run('DELETE FROM memory_vec WHERE id = ?', id); } catch { /* no vec table */ } return s._run('DELETE FROM memory WHERE id = ?', id).changes > 0; },
      all({ limit = 200, offset = 0 } = {}) { return s._all('SELECT id, note, question, targets, aliases, links, created_at FROM memory ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', limit, offset).map(memRow); },
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
      for (const t of TABLES) if (!t.kept) this._run(`DELETE FROM ${t.name}`);
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

// Built-in backend: node:sqlite (zero external deps, synchronous). Returns null when no path is set
// or this Node has no node:sqlite — then openStore uses the in-memory backend. A database that cannot
// be opened or brought to the declared tables is the error it is, never a silent in-memory store.
registerStoreBackend('sqlite', ({ dbPath, reset = false }) => {
  if (!dbPath) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  // allowExtension lets us load sqlite-vec for vector (semantic memory) search; harmless
  // when the extension is absent (the backend falls back to in-SQL cosine)
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try { return new SqliteBackend(db, { reset }); } catch (e) { db.close(); throw e; }
});

/**
 * Open the shared store. The backend is selectable (default 'sqlite', override via
 * MCP_DB_BACKEND or the `backend` arg) — the single switch point for changing databases.
 * ALWAYS returns a backend: the in-memory one when the selected backend declines (no path, no
 * node:sqlite), so callers never branch on null; a database that fails to open throws.
 */
export function openStore({ dbPath, backend, reset = false } = {}) {
  const name = backend || setting('MCP_DB_BACKEND');
  const factory = BACKENDS.get(name);
  if (!factory) throw new Error(`unknown store backend '${name}'. Registered: ${storeBackends().join(', ')}`);
  const store = factory({ dbPath, reset }) || new MemoryBackend();
  if (reset) store.reset?.(); // wipe all state BEFORE any manager reads it (MCP_DB_RESET)
  return store;
}
