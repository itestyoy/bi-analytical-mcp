// Background-populated index of REAL event-property values (top values by frequency +
// cardinality), surfaced in semantic_index so the AI sees not just property NAMES/types
// but the actual VALUES a property carries. Persistence is delegated to a swappable store
// backend (see store.js) — this file holds NO SQL, just the domain operations. The
// BackgroundIndexer (src/value-indexer.js) populates it NON-BLOCKING from the warehouse at
// startup + on a schedule.

import { openStore } from './store.js';
import { rankFuzzy } from './fuzzy.js';

// Cap on the candidate set scanned for a FUZZY value match (the index is small —
// top-N values per property — so this comfortably covers it without unbounded cost).
const VALUE_FUZZY_CAP = 5000;

export class ValueIndex {
  constructor({ dbPath, store } = {}) {
    // Injected (shared) store, else open one (in-memory backend when no path/sqlite).
    this.store = store || openStore({ dbPath });
    this._ownsStore = !store; // only close what we opened
    this.store.runs.reconcile(); // a run left 'running' across a restart → 'interrupted'
  }

  /** Whether values survive a restart (persistent backend) vs in-memory only. */
  get persistent() { return this.store.persistent; }

  /** Replace the stored values + stats for one property (cap = top N the caller already trimmed). */
  upsertProperty(source, property, spec = {}) {
    this.store.values.replaceProperty(source, property, spec);
  }

  /** Per-event_name coverage for a property OF `source`: [{ event_name, row_count, non_null, null_count }]. */
  coverage(source, property) {
    return this.store.values.coverage ? this.store.values.coverage(source, property) : [];
  }

  /**
   * DATA-DERIVED applicability: the events on which `property` is actually populated (non-null on
   * >= 1 row), read from the latest scan's per-event coverage. Replaces the declared
   * meta.mcp.events list. Returns null when the property has no coverage yet (not indexed) so the
   * caller can say "unknown" instead of fabricating an applies-to set.
   */
  appliesEvents(source, property) {
    const cov = this.coverage(source, property);
    if (!cov || !cov.length) return null;
    return cov.filter((e) => (e.non_null || 0) > 0).map((e) => e.event_name);
  }

  /** { property -> observed events } for a list of `source`'s properties (see appliesEvents).
   *  Cached per value-index sync generation so the per-property coverage reads are paid once per
   *  scan, not per call. The cache is per SOURCE and INCREMENTAL: each source asks about its own
   *  properties, and a source asking later has them resolved and added rather than being answered
   *  from another source's map — otherwise they would look uncovered and be reported as
   *  "applies to every event". */
  appliesMap(source, properties) {
    const gen = this.syncGeneration ? this.syncGeneration() : 0;
    if (!this._appliesCache || this._appliesCache.gen !== gen) this._appliesCache = { gen, bySource: new Map() };
    let entry = this._appliesCache.bySource.get(source);
    if (!entry) { entry = { map: {}, resolved: new Set() }; this._appliesCache.bySource.set(source, entry); }
    for (const p of properties) {
      if (entry.resolved.has(p)) continue; // already read this scan (either covered, or known to have none)
      entry.resolved.add(p);
      const evs = this.appliesEvents(source, p);
      if (evs) entry.map[p] = evs;
    }
    return entry.map;
  }

  /** Per-bundle (app) coverage for a property: [{ bundle, row_count, non_null, null_count }]. */
  bundleCoverage(source, property) {
    return this.store.values.bundleCoverage ? this.store.values.bundleCoverage(source, property) : [];
  }

  /** Apps seen during indexing, per SOURCE: [{ source, bundle, row_count }]. Optional filter. */
  bundles(source) {
    return this.store.values.bundles(source);
  }

  /** One app's per-property fill, per SOURCE (`source` null = every source). */
  bundlePropertyCoverage(source, bundle) {
    return this.store.values.bundlePropertyCoverage(source, bundle);
  }

  /** Triple cell: fill of `property` at one (bundle × event) combo, or null if not indexed. */
  cellCoverage(source, property, sel) {
    return this.store.values.cellCoverage ? this.store.values.cellCoverage(source, property, sel) : null;
  }

  /** All stored (bundle × event) cells for a property — the incremental merge reads these back. */
  allCells(source, property) {
    return this.store.values.allCells ? this.store.values.allCells(source, property) : [];
  }

  /** Top `limit` values for a property, ordered by freq desc (value-ASC tiebreak). */
  sampleValues(source, property, limit = 10) {
    return this.store.values.top(source, property, limit);
  }

  /**
   * Pageable + orderable view of a property's stored values: order by 'freq' (default)
   * or 'value', asc/desc, with limit/offset. `by`/`dir` are normalised to a closed set
   * here, so the backend never sees raw input in an ORDER BY position.
   */
  listValues(source, property, { limit = 10, offset = 0, by = 'freq', dir, tie = 'asc' } = {}) {
    const col = by === 'value' ? 'value' : 'freq';
    const direction = (dir === 'asc' || dir === 'desc') ? dir : (col === 'value' ? 'asc' : 'desc');
    return this.store.values.page(source, property, { limit, offset, col, direction, tie: tie === 'desc' ? 'desc' : 'asc' });
  }

  /** { distinctCount, totalCount, indexedAt } | null. */
  stats(source, property) {
    return this.store.values.stats(source, property);
  }

  /** How many values are STORED for a property (the indexer keeps only the top-N). */
  valueCount(source, property) {
    return this.store.values.valueCount ? this.store.values.valueCount(source, property) : null;
  }

  /** Every key currently in the index as { source, property } — for reconciling against the schema. */
  properties() {
    return this.store.values.properties ? this.store.values.properties() : [];
  }

  /** Drop everything stored for one property (a column that left the table) — no full reindex. */
  removeProperty(source, property) {
    return this.store.values.removeProperty ? this.store.values.removeProperty(source, property) : false;
  }

  /**
   * [{ source, property, value, freq, score, match }] for stored values matching `query`.
   * Tier 1: EXACT substring (fast SQL, score 1, match 'exact'). When fuzzy is on and
   * exact leaves room, tier 2 fills the rest with typo-tolerant matches (Levenshtein/
   * subsequence over a bounded candidate scan) — so 'germny' still finds 'Germany'.
   */
  searchValues(query, limit = 20, { fuzzy = true } = {}) {
    const exact = this.store.values.search(query, limit).map((v) => ({ ...v, score: 1, match: 'exact' }));
    if (!fuzzy || exact.length >= limit || String(query).trim().length < 3) return exact;
    const seen = new Set(exact.map((v) => `${v.source}\u0000${v.property}\u0000${v.value}`));
    const ranked = rankFuzzy(query, this.store.values.candidates(VALUE_FUZZY_CAP), {
      fields: (v) => [v.value], threshold: 0.6, tiebreak: (v) => v.value,
    });
    const fuzzyHits = [];
    for (const { item: v, score, match } of ranked) {
      if (match === 'exact' || seen.has(`${v.source}\u0000${v.property}\u0000${v.value}`)) continue; // exact already covered
      fuzzyHits.push({ source: v.source, property: v.property, value: v.value, freq: v.freq, score, match: 'fuzzy' });
      if (exact.length + fuzzyHits.length >= limit) break;
    }
    return [...exact, ...fuzzyHits];
  }

  close() {
    if (this._ownsStore) { try { this.store.close(); } catch { /* already closed */ } }
  }

  // ── sync-run log (consumed by semantic_index) ──────────────────────────────
  /** Record the start of a refresh pass; returns a run id to pass to finishRun. */
  startRun() { return this.store.runs.start(); }

  /** Mark a run terminal with its outcome. status: 'ok' | 'partial' | 'error'. */
  finishRun(runId, fields = {}) {
    if (runId == null) return;
    this.store.runs.finish(runId, { status: 'ok', propertiesIndexed: null, valuesWritten: null, errors: null, error: null, ...fields });
    this._syncGen = (this._syncGen || 0) + 1; // bumps once per completed scan → freshness re-queries
  }

  /** Monotonic counter of COMPLETED index scans — callers key caches on it to refresh per scan. */
  syncGeneration() { return this._syncGen || 0; }

  /** Record how long ONE property took within a run (+ what it produced). */
  recordPropertyTiming(runId, fields = {}) {
    // Diagnostics are best-effort: a row that cannot be keyed (no run, or no source+property) is
    // skipped rather than failing the scan it is only describing.
    if (runId == null || !fields.property || !fields.source) return;
    this.store.runs.recordProperty(runId, fields);
  }

  /** Per-property timing/coverage for a run (slowest first). */
  runProperties(runId, opts = {}) { return this.store.runs.properties(runId, opts); }

  /** A single run's header row, or null. */
  runById(runId) { return this.store.runs.get(runId); }

  /** Record a run-level event (e.g. a batch fell back to per-property + the reason). */
  recordRunNote(runId, note) { if (runId != null && this.store.runs.addNote) this.store.runs.addNote(runId, note); }

  /** Run-level notes [{ note, at }] (batch fallbacks etc.) for the { status }/{ run } views. */
  runNotes(runId) { return this.store.runs.notes ? this.store.runs.notes(runId) : []; }

  /** Per-run timing history for one property (most recent first). */
  propertyHistory(source, property, opts = {}) { return this.store.runs.propertyHistory(source, property, opts); }

  /** Snapshot of the indexing state: coverage counts + the run history. */
  syncStatus({ recent = 10 } = {}) {
    const runs = this.store.runs.all();
    const fmt = (r) => (r ? { id: r.id, started_at: r.started_at, finished_at: r.finished_at, status: r.status, properties_indexed: r.properties_indexed, values_written: r.values_written, errors: r.errors, error: r.error, duration_ms: (r.finished_at != null && r.started_at != null) ? r.finished_at - r.started_at : null } : null);
    const lastFinished = runs.find((r) => r.finished_at != null) || null;
    const { properties, values } = this.store.values.counts();
    return {
      persisted: this.store.persistent,
      running: runs.some((r) => r.status === 'running'),
      indexed_properties: properties,
      total_values: values,
      total_runs: runs.length,
      last_run: fmt(runs[0]),
      last_successful_run: fmt(lastFinished && lastFinished.status !== 'error' ? lastFinished : runs.find((r) => r.status === 'ok')) || null,
      recent_runs: runs.slice(0, recent).map(fmt),
    };
  }
}
