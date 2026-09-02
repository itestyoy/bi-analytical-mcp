// Background-populated index of REAL event-property values (top values by frequency +
// cardinality), surfaced in semantic_index so the AI sees not just property NAMES/types
// but the actual VALUES a property carries. Persistence is delegated to a swappable store
// backend (see store.js) — this class holds NO SQL, just the domain operations. The
// BackgroundIndexer populates it NON-BLOCKING from the warehouse at startup + on a schedule.

import { jsonExtract, jsonArrayLength, arrayLength, recentSince, sinceTimestampMs, approxCountDistinct, approxTopK, parseApproxTopK } from './dialect.js';
import { openStore } from './store.js';
import { rankFuzzy } from './fuzzy.js';

// Cap on the candidate set scanned for a FUZZY value match (the index is small —
// top-N values per property — so this comfortably covers it without unbounded cost).
const VALUE_FUZZY_CAP = 5000;
// Max (event × bundle) cells stored per property for the triple coverage (busiest kept) —
// bounds prop_bundle_event_coverage on a portfolio with many apps × events.
const TRIPLE_CELL_CAP = 4000;
// Complex (array/struct) properties: up to N raw EXAMPLE values (shape, not frequency), each
// capped in length so one giant nested value can't blow up the response.
const COMPLEX_SAMPLE_N = 10;
// Readable "<source>.<property>" for LOG lines and local set lookups. Never a stored key:
// the index keys rows by the (source, property) pair, not by a glued name.
const label = (t) => `${t.source}.${t.property}`;
const COMPLEX_SAMPLE_MAXLEN = 300;

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
  listValues(source, property, { limit = 10, offset = 0, by = 'freq', dir } = {}) {
    const col = by === 'value' ? 'value' : 'freq';
    const direction = (dir === 'asc' || dir === 'desc') ? dir : (col === 'value' ? 'asc' : 'desc');
    return this.store.values.page(source, property, { limit, offset, col, direction });
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

  /** Carry a v1 index (one flat property namespace) into the (source, property) schema; see the
   *  store. `resolve(oldKey)` -> { source, property } | null, supplied by the caller that holds
   *  the catalog. No-op on a fresh database or a non-persistent backend. */
  migrateLegacyKeys(resolve) {
    return this.store.values.migrateLegacyKeys ? this.store.values.migrateLegacyKeys(resolve) : { migrated: 0, dropped: 0 };
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
    const seen = new Set(exact.map((v) => `${v.source} ${v.property} ${v.value}`));
    const ranked = rankFuzzy(query, this.store.values.candidates(VALUE_FUZZY_CAP), {
      fields: (v) => [v.value], threshold: 0.6, tiebreak: (v) => v.value,
    });
    const fuzzyHits = [];
    for (const { item: v, score, match } of ranked) {
      if (match === 'exact' || seen.has(`${v.source} ${v.property} ${v.value}`)) continue; // exact already covered
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
    if (runId == null || !fields.property) return;
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

/**
 * Non-blocking background indexer. ONE INDEPENDENT SCAN PER SOURCE: for every events source its
 * scalar event properties and marked dimensions, for every other model its categorical
 * attributes — each stored under (source, property) with the top values by frequency,
 * cardinality/total, NULL coverage per event and per app. Which events carry a property and
 * which values it takes are MEASURED here; the schema declares neither. Runs an initial pass
 * fire-and-forget at start() and then on an unref'd interval. Per-property errors are swallowed
 * so one bad property never aborts a run or crashes the server.
 */
export class BackgroundIndexer {
  constructor({ catalog, runner, index, baseProjectDir, intervalMs = 21600000, maxValues = 50, windowDays = 0, approxDistinct = true, batchSize = 40, scanTimeout = 0, merge = false, highCardPct = 0, runModels = false, runModelsSelect = null, logger } = {}) {
    this.catalog = catalog;
    this.runner = runner;
    this.index = index;
    this.baseProjectDir = baseProjectDir;
    this.intervalMs = intervalMs;
    this.maxValues = maxValues;
    // Per-scan dbt timeout (ms) for the index queries ONLY — these are heavy full-fact
    // aggregates and were getting SIGTERM-killed at the runner's default 180s. A larger value
    // here lets them finish without raising the timeout for ordinary user queries. 0/undefined
    // → use the runner's own default (show() falls back to it when timeout is undefined).
    this.scanTimeout = Number(scanTimeout) > 0 ? Math.floor(Number(scanTimeout)) : undefined;
    // INCREMENTAL MERGE (opt-in): an anchor event property already indexed once is re-scanned only
    // for rows NEWER than its stored watermark, and the new counts are ADDED to what is stored
    // (top-values freq, per-event/app/cell coverage, totals). distinct becomes a lower bound
    // (max of prior and delta) — safe for the filter guard, which gates hard-rejects on the top-N
    // cap, not on the exact distinct. Off → each property is a full-window replace (previous behaviour).
    this.merge = !!merge;
    // HIGH-CARDINALITY skip: a field whose distinct values are ≥ highCardPct PERCENT of its
    // (non-null) rows is near-unique / ID-like — its top-N is noise, so once indexed it is SKIPPED
    // on later syncs (indexed once, then left alone), a big cost saver on wide facts. Relative to
    // the field's own size, so it adapts to any table. 0/unset → never auto-skip.
    this.highCardRatio = Number(highCardPct) > 0 ? Math.min(1, Number(highCardPct) / 100) : 0;
    // REBUILD-then-index: when on, each sync first rebuilds the catalog's source models via
    // `dbt run` and only THEN indexes them — so the index (and data_freshness) reflect a freshly
    // computed table, not whatever was last built by external orchestration. runModelsSelect
    // overrides the dbt selector (default = all catalog source models). Off → index as-is.
    this.runModels = !!runModels;
    this.runModelsSelect = runModelsSelect || null;
    // Properties indexed together per combined scan: cardinality + coverage are computed for
    // a whole batch in ONE query each (instead of one scan per property). A batch that errors
    // falls back to per-property, so a single bad column never loses the rest. >=1.
    this.batchSize = Number(batchSize) > 0 ? Math.floor(Number(batchSize)) : 40;
    // Optional: bound the indexing scans to the last N days on the anchor time column — the
    // cost lever on a partitioned fact (a full-history scan every refresh is expensive).
    // 0/undefined → no window (scan all history), the default so behaviour is unchanged.
    this.windowDays = Number(windowDays) > 0 ? Math.floor(Number(windowDays)) : 0;
    // Use the dialect's APPROX distinct-count (HLL) for cardinality — cheaper on a large
    // fact (the project's preferred distinct method), at the price of an approximate
    // distinct_count. DEFAULT ON; only applied where the dialect has a native function
    // (postgres & unknown fall back to exact silently), and disableable by the caller.
    this.approxDistinct = approxDistinct !== false;
    // Default to a stderr logger so sync progress/results are ALWAYS visible in the
    // server logs; callers (incl. tests) can pass their own or a no-op to silence it.
    this.logger = logger || ((m) => console.error(`[mcp] ${new Date().toISOString()} value-index ${m}`));
    this._timer = null;
    this._running = false;
  }

  start() {
    // Fire-and-forget the initial pass — startup MUST NOT block on the warehouse.
    this.refresh().catch(() => {});
    if (this.intervalMs > 0) {
      this._timer = setInterval(() => { this.refresh().catch(() => {}); }, this.intervalMs);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Value SQL expression for a property — the catalog's one rule (flat column or JSON extract). */
  _valueExpr(name, _spec, fact) {
    return this.catalog.propertyExpr(fact, name, this.catalog.dialect);
  }

  /**
   * Boolean SQL: a COMPLEX (array / array<struct>) property is "present" on a row = the array
   * exists AND is non-empty. Encoding decides the shape (a native REPEATED column is never NULL —
   * only its LENGTH tells presence; a json-string column can be NULL or the literal '[]'; a blob
   * key uses the dialect's JSON-array length). Used for per-event applicability coverage, so
   * COUNT(CASE WHEN <this> THEN 1 END) never runs COUNT() over an ARRAY (which BigQuery rejects).
   */
  _complexPresence(name, spec, fact) {
    const d = this.catalog.dialect;
    if (spec.column) {
      if (spec.encoding === 'native') return `${arrayLength(d, spec.column)} > 0`;
      return `${spec.column} IS NOT NULL AND ${spec.column} <> '[]'`; // json-encoded string array
    }
    return `${jsonArrayLength(d, this.catalog.eventDataColumn(fact), name)} > 0`; // inside the event_data blob
  }

  /**
   * COVERAGE + EXAMPLES pass for COMPLEX event properties (arrays/structs). They are excluded from
   * the scalar worklist — their values are nested, so there is no top-N-by-frequency or distinct
   * count. Instead, per complex property, we compute:
   *   • per-event/app COVERAGE (which events actually carry a non-empty array) — so applicability is
   *     DATA-DERIVED like scalars, not "unknown → shown on every event"; and
   *   • up to COMPLEX_SAMPLE_N raw EXAMPLE values (LIMIT, not ranked) so the caller sees the real
   *     shape/contents of the array without unnesting.
   * INCREMENTAL like the scalar path: with merge on and a stored watermark, only rows newer than it
   * are scanned and the counts are ADDED to what is stored (examples kept unless the delta yields
   * fresh ones); otherwise a full (windowed) scan replaces. Per-property (there are only a handful).
   */
  async _indexComplexCoverage(runId, fact) {
    const c = this.catalog;
    const names = c.complexEventProps(fact);
    if (!names.length) return { props: 0, values: 0 };
    const bundleCol = c.bundleColumn(fact);
    const ref = `{{ ref('${c.getModel(fact).dbt_model}') }}`;
    const evCol = c.eventNameColumn(fact);
    const timeCol = c.getModel(fact).time?.column;
    const { andWin, whereWin } = this._winClauses(evCol, timeCol);
    const wmOf = (rows) => rows.reduce((mx, r) => { const v = r.wm == null ? null : (Number.isFinite(Number(r.wm)) ? Number(r.wm) : Date.parse(r.wm)); return (v != null && (mx == null || v > mx)) ? v : mx; }, null);
    let done = 0;
    let written = 0; // example value rows stored — counted into the run's values_written
    for (const name of names) {
      const spec = c.eventPropertySpec(name, fact);
      if (!spec) continue;
      const presence = this._complexPresence(name, spec, fact);
      const expr = this._valueExpr(name, spec, fact);
      try {
        const prior = this.index.stats?.(fact, name);
        const since = (this.merge && prior?.dataWatermark != null) ? this._sinceClause(prior.dataWatermark, timeCol) : null;
        const covWhere = since ? ` WHERE ${since}` : whereWin;
        const sampWhere = ` WHERE ${presence}${since ? ` AND ${since}` : andWin}`;
        // per-event[/app] presence coverage + the delta's max event time (for the watermark)
        const sel = [`${evCol} AS ev`];
        if (bundleCol) sel.push(`${bundleCol} AS app`);
        sel.push('COUNT(*) AS row_count', `COUNT(CASE WHEN ${presence} THEN 1 END) AS nn`);
        if (timeCol) sel.push(`MAX(${timeCol}) AS wm`);
        const grp = bundleCol ? `${evCol}, ${bundleCol}` : `${evCol}`;
        const cov = await this.runner.show(this.baseProjectDir, `SELECT ${sel.join(', ')} FROM ${ref}${covWhere} GROUP BY ${grp}`, 5000, this.scanTimeout);
        if (!cov.ok) throw new Error([cov.error, cov.stderr, cov.stdout].filter((s) => s && String(s).trim()).join('\n').trim() || 'not ok');
        const rows = cov.rows || [];
        const deltaMax = wmOf(rows);

        if (since && deltaMax == null) { // delta merge with no new rows → keep what is stored
          done += 1;
          this.logger?.(`sync #${runId} complex-coverage '${fact}.${name}': no new rows since watermark — kept stored`);
          continue;
        }

        const roll = this._coverageFromRows(rows, 'nn', name, runId);
        const total = roll.coverage.reduce((s, e) => s + (e.nonNull || 0), 0);
        const rowsTotal = roll.coverage.reduce((s, e) => s + (e.rowCount || 0), 0);
        // Fresh raw EXAMPLES (LIMIT, unordered) — the shape of the data, not frequencies.
        let examples = [];
        try {
          // NB: no inline LIMIT — the row cap is the show() `limit` arg (same as the scalar
          // top-values scan); an inline LIMIT inside dbt show's query wrapper returns nothing.
          const ex = await this.runner.show(this.baseProjectDir, `SELECT ${expr} AS v FROM ${ref}${sampWhere}`, COMPLEX_SAMPLE_N, this.scanTimeout);
          if (ex.ok) {
            // DEDUP by value — examples show the SHAPE, and the store keys values by (property,value)
            // (duplicates would collide). Distinct shapes are more informative than repeats anyway.
            const seen = new Set();
            examples = (ex.rows || []).map((r) => r.v).filter((v) => v != null).map((v) => String(v).slice(0, COMPLEX_SAMPLE_MAXLEN))
              .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
              .map((v) => ({ value: v, freq: null }));
          }
        } catch { /* examples are best-effort */ }

        if (since) { // INCREMENTAL: add the delta's counts to what is stored
          const stored = this._readStored(fact, name);
          const merged = this._mergeStats({ ...stored, values: [] }, { values: [], coverage: roll.coverage, bundleCoverage: roll.bundleCoverage, cellCoverage: roll.cellCoverage, total, rowsTotal, distinct: null });
          const keepExamples = examples.length ? examples : stored.values; // keep prior examples if the delta had none
          written += keepExamples.length;
          this.index.upsertProperty(fact, name, { values: keepExamples, distinctCount: null, totalCount: merged.total, nullCount: merged.nullCount, coverage: merged.coverage, bundleCoverage: merged.bundleCoverage, cellCoverage: merged.cellCoverage, dataWatermark: Math.max(prior.dataWatermark || 0, deltaMax ?? prior.dataWatermark) });
          this.logger?.(`sync #${runId} complex-coverage '${fact}.${name}': merged delta, ${merged.coverage.length} event(s) carry it`);
        } else { // FULL (or first) scan → replace
          written += examples.length;
          this.index.upsertProperty(fact, name, { values: examples, distinctCount: null, totalCount: total, nullCount: rowsTotal - total, coverage: roll.coverage, bundleCoverage: roll.bundleCoverage, cellCoverage: roll.cellCoverage, ...(deltaMax != null ? { dataWatermark: deltaMax } : {}) });
          this.logger?.(`sync #${runId} complex-coverage '${fact}.${name}': ${roll.coverage.length} event(s) carry it, ${examples.length} example(s)`);
        }
        done += 1;
      } catch (e) {
        const why = e?.message || String(e);
        this.index.recordRunNote?.(runId, `complex-coverage scan failed [${name}]: ${why}`);
        this.logger?.(`sync #${runId} complex-coverage '${fact}.${name}' FAILED: ${why}`);
      }
    }
    return { props: done, values: written };
  }

  /**
   * Indexing worklist: EVERY fact's scalar event properties (with per-event_name coverage)
   * PLUS the categorical dimension columns of every model. Every target names its SOURCE
   * separately from the property, so each source owns its own index space and two events facts
   * may carry the same property name without sharing a row.
   * Each target carries the table-specific bits (ref / event-name column / time column /
   * app column), so a scan never borrows another fact's columns.
   */
  _targets() {
    const c = this.catalog;
    const targets = [];
    for (const fact of c.facts) {
      const m = c.getModel(fact);
      const ref = `{{ ref('${m.dbt_model}') }}`;
      const evCol = c.eventNameColumn(fact);
      const timeCol = m.time?.column || null;
      const bundleCol = c.bundleColumn(fact);
      for (const name of c.scalarEventProps(fact)) {
        const spec = c.eventPropertySpec(name, fact);
        if (spec) targets.push({ source: fact, property: name, ref, expr: this._valueExpr(name, spec, fact), eventCol: evCol, timeCol, bundleCol });
      }
      // Fact categorical DIMENSIONS — the envelope/app columns (media_source, platform,
      // bundle_id, …) physically on every event. Index their REAL values under namespaced
      // '<fact>.<col>' keys so a filter literal can be verified against THIS source's own
      // values (casing can differ from the per-user dim_users copy). Skip the event_name
      // column (already enum-validated) and time dimensions (not an enumerable value set).
      for (const [col, spec] of Object.entries(m.dimensions || {})) {
        if (col === evCol) continue;
        if (spec?.index === false) continue; // opted out of value indexing (an id / free text)
        if (String(spec?.type || '').toLowerCase() === 'time') continue;
        targets.push({ source: fact, property: col, ref, expr: col, eventCol: evCol, timeCol, bundleCol });
      }
    }
    for (const key of c.modelKeys()) {
      if (c.isFact(key)) continue;
      const m = c.getModel(key);
      const ref = `{{ ref('${m.dbt_model}') }}`;
      for (const [col, spec] of Object.entries(m.dimensions || {})) {
        if (spec?.index === false) continue; // opted out of value indexing (an id / free text)
        if (String(spec?.type || '').toLowerCase() === 'time') continue; // dates aren't enumerable value sets
        targets.push({ source: key, property: col, ref, expr: col, eventCol: null, timeCol: null, bundleCol: null });
      }
    }
    return targets;
  }

  /** Per-property recency window predicate (fact scans only), bounded on THAT fact's own
   *  time column, or '' when there is no window / no time axis. */
  _winClauses(eventCol, timeCol) {
    const win = (eventCol && this.windowDays && timeCol) ? recentSince(this.catalog.dialect, timeCol, this.windowDays) : null;
    return { andWin: win ? ` AND ${win}` : '', whereWin: win ? ` WHERE ${win}` : '' };
  }

  /** Top-N values for ONE property via an exact GROUP BY (the per-property fallback path). */
  async _topValuesExact(ref, expr, andWin = '') {
    const top = await this.runner.show(this.baseProjectDir, `SELECT ${expr} AS v, COUNT(*) AS n FROM ${ref} WHERE ${expr} IS NOT NULL${andWin} GROUP BY 1 ORDER BY n DESC`, this.maxValues, this.scanTimeout);
    if (!top.ok) return null;
    return (top.rows || []).filter((r) => r.v != null).map((r) => ({ value: r.v, freq: Number(r.n) }));
  }

  /** Roll grouped coverage rows into per-event / per-bundle marginals + the (event×bundle)
   *  triple cells (capped), reading each row's non-null from `nnKey`. */
  _coverageFromRows(rows, nnKey, name, runId) {
    const evMap = new Map(); const apMap = new Map();
    const add = (m, k) => { const v = m.get(k) || { rowCount: 0, nonNull: 0 }; m.set(k, v); return v; };
    let cells = [];
    for (const r of rows || []) {
      const rc = Number(r.row_count) || 0; const nn = Number(r[nnKey]) || 0;
      if (r.ev != null) { const v = add(evMap, r.ev); v.rowCount += rc; v.nonNull += nn; }
      if (r.app != null) { const v = add(apMap, r.app); v.rowCount += rc; v.nonNull += nn; }
      if (r.ev != null && r.app != null) cells.push({ bundle: r.app, event: r.ev, rowCount: rc, nonNull: nn });
    }
    if (cells.length > TRIPLE_CELL_CAP) {
      cells = cells.sort((a, b) => b.rowCount - a.rowCount).slice(0, TRIPLE_CELL_CAP);
      this.logger?.(`sync #${runId} '${name}': (event×app) cells truncated to ${TRIPLE_CELL_CAP} (busiest kept)`);
    }
    return {
      coverage: [...evMap].map(([event, v]) => ({ event, rowCount: v.rowCount, nonNull: v.nonNull })),
      bundleCoverage: [...apMap].map(([bundle, v]) => ({ bundle, rowCount: v.rowCount, nonNull: v.nonNull })),
      cellCoverage: cells,
    };
  }

  /** One property's full stats via per-property scans (fallback when a batch query fails). */
  async _indexOneExact(t, bundleCol, runId) {
    const c = this.catalog;
    const { andWin, whereWin } = this._winClauses(t.eventCol, t.timeCol);
    const values = (await this._topValuesExact(t.ref, t.expr, andWin)) || [];
    const distinctExpr = (this.approxDistinct && approxCountDistinct(c.dialect, t.expr)) || `COUNT(DISTINCT ${t.expr})`;
    const card = await this.runner.show(this.baseProjectDir, `SELECT ${distinctExpr} AS d, COUNT(${t.expr}) AS t, COUNT(*) AS rows_total FROM ${t.ref}${whereWin}`, 1, this.scanTimeout);
    const stat = card.ok && card.rows?.[0] ? card.rows[0] : {};
    const distinct = stat.d != null ? Number(stat.d) : null;
    const total = stat.t != null ? Number(stat.t) : null;
    const rowsTotal = stat.rows_total != null ? Number(stat.rows_total) : null;
    let cov = { coverage: [], bundleCoverage: [], cellCoverage: [] };
    if (t.eventCol) {
      const sel = bundleCol
        ? `${t.eventCol} AS ev, ${bundleCol} AS app, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`
        : `${t.eventCol} AS ev, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`;
      const grp = bundleCol ? `${t.eventCol}, ${bundleCol}` : `${t.eventCol}`;
      const r = await this.runner.show(this.baseProjectDir, `SELECT ${sel} FROM ${t.ref}${whereWin} GROUP BY ${grp}`, bundleCol ? 5000 : 500, this.scanTimeout);
      if (r.ok) cov = this._coverageFromRows(r.rows, 'non_null', label(t), runId);
    }
    return { values, distinct, total, rowsTotal, nullCount: (rowsTotal != null && total != null) ? rowsTotal - total : null, ...cov };
  }

  /**
   * Index a BATCH of properties (same source) with the FEWEST scans the dialect allows:
   *   • ONE combined cardinality scan (distinct + non-null for every property),
   *   • ONE combined coverage scan (per event×app, every property's non-null) when anchored,
   *   • top-values via ONE combined APPROX_TOP_COUNT scan where supported (BigQuery/Snowflake),
   *     else a per-property GROUP BY (the best Postgres/DuckDB/Redshift have).
   * `where` overrides the scan predicate (null → the windowDays window; '' → whole table; a
   * string → e.g. a delta "time > watermark"). `withWm` also selects MAX(time) so the caller
   * gets the batch's new watermark. Returns { results: Map<property, stats>, maxTime }. Throws
   * if a combined scan fails → caller falls back per-property.
   */
  async _indexBatch(ref, batch, bundleCol, runId, { where = null, withWm = false } = {}) {
    const c = this.catalog;
    const eventCol = batch[0].eventCol;
    const { andWin, whereWin } = where != null
      ? { andWin: where ? ` AND ${where}` : '', whereWin: where ? ` WHERE ${where}` : '' }
      : this._winClauses(eventCol, batch[0].timeCol);
    const timeCol = (withWm && eventCol) ? batch[0].timeCol : null;
    // Return the FULL raw cause verbatim (process-level error + stderr + stdout), no
    // reformatting, no truncation — so the actual reason is visible from ANY level: a
    // process-level failure (timeout/ENOENT/spawn) lives in r.error, a warehouse/dbt failure
    // in stderr/stdout. This feeds the stderr LOGS only (not surfaced through the tools).
    const why = (r) => [r.error, r.stderr, r.stdout].filter((s) => s && String(s).trim()).join('\n').trim() || 'query returned not-ok (no stdout/stderr)';

    // 1) combined cardinality (one row: rows_total + d{j}/t{j} per property, + MAX(time) for merge)
    const cardSel = ['COUNT(*) AS rows_total'];
    batch.forEach((t, j) => {
      const de = (this.approxDistinct && approxCountDistinct(c.dialect, t.expr)) || `COUNT(DISTINCT ${t.expr})`;
      cardSel.push(`${de} AS d${j}`, `COUNT(${t.expr}) AS t${j}`);
    });
    if (timeCol) cardSel.push(`MAX(${timeCol}) AS wm`);
    const card = await this.runner.show(this.baseProjectDir, `SELECT ${cardSel.join(', ')} FROM ${ref}${whereWin}`, 1, this.scanTimeout);
    if (!card.ok) throw new Error(`cardinality scan failed: ${why(card)}`);
    const crow = card.rows?.[0] || {};
    const maxTime = crow.wm != null ? (Number.isFinite(Number(crow.wm)) ? Number(crow.wm) : Date.parse(crow.wm)) : null;

    // 2) combined coverage (anchor only)
    let covRows = null;
    if (eventCol) {
      const covSel = [`${eventCol} AS ev`];
      if (bundleCol) covSel.push(`${bundleCol} AS app`);
      covSel.push('COUNT(*) AS row_count');
      batch.forEach((t, j) => covSel.push(`COUNT(${t.expr}) AS nn${j}`));
      const grp = bundleCol ? `${eventCol}, ${bundleCol}` : `${eventCol}`;
      const cov = await this.runner.show(this.baseProjectDir, `SELECT ${covSel.join(', ')} FROM ${ref}${whereWin} GROUP BY ${grp}`, 5000, this.scanTimeout);
      if (!cov.ok) throw new Error(`coverage scan failed: ${why(cov)}`);
      covRows = cov.rows || [];
    }

    // 3) top values — combined approx-top-k where the dialect supports counts, else per-property.
    // The top-k scan is the fragile part (40 array aggregates in one query → can hit type/
    // resource limits on BigQuery). If it fails, DON'T discard the batch — keep the combined
    // cardinality+coverage that already succeeded and degrade ONLY top-values to per-property.
    let combineTopK = !!approxTopK(c.dialect, 'x', this.maxValues);
    let topRow = null;
    if (combineTopK) {
      const topSel = batch.map((t, j) => `${approxTopK(c.dialect, t.expr, this.maxValues)} AS v${j}`);
      const tk = await this.runner.show(this.baseProjectDir, `SELECT ${topSel.join(', ')} FROM ${ref}${whereWin}`, 1, this.scanTimeout);
      if (tk.ok) { topRow = tk.rows?.[0] || {}; }
      else {
        combineTopK = false; // per-property top-values below; cardinality+coverage stay combined
        const note = `combined top-k scan of ${batch.length} from ${ref} [${batch[0].property}…${batch[batch.length - 1].property}] FAILED → top-values per-property (cardinality+coverage kept combined): ${why(tk)}`;
        this.logger?.(`sync #${runId} ${note}`);
        this.index.recordRunNote?.(runId, note);
      }
    }

    const out = new Map();
    for (let j = 0; j < batch.length; j += 1) {
      const t = batch[j];
      const distinct = crow[`d${j}`] != null ? Number(crow[`d${j}`]) : null;
      const total = crow[`t${j}`] != null ? Number(crow[`t${j}`]) : null;
      const rowsTotal = crow.rows_total != null ? Number(crow.rows_total) : null;
      let values = combineTopK ? parseApproxTopK(topRow[`v${j}`]) : ((await this._topValuesExact(ref, t.expr, andWin)) || []);
      // Self-heal: if combined top-k yielded nothing but the column has data, take the exact path.
      if (combineTopK && !values.length && total) values = (await this._topValuesExact(ref, t.expr, andWin)) || [];
      const cov = covRows ? this._coverageFromRows(covRows, `nn${j}`, label(t), runId) : { coverage: [], bundleCoverage: [], cellCoverage: [] };
      out.set(t, { values, distinct, total, rowsTotal, nullCount: (rowsTotal != null && total != null) ? rowsTotal - total : null, ...cov });
    }
    return { results: out, maxTime };
  }

  // ── incremental merge (opt-in) ───────────────────────────────────────────────
  /** Delta predicate keeping only rows newer than an epoch-ms watermark, or null if the dialect
   *  has no safe expression (→ caller does a full re-scan instead of an unbounded merge). */
  _sinceClause(watermarkMs, timeCol) {
    // The delta predicate is bounded on the TARGET's own time column, passed in by every caller.
    // There is deliberately no default: falling back to another source's time axis would build
    // `WHERE <other fact's column> > …` against this table and fail on every sync.
    if (!timeCol) throw new Error('value index: a delta scan needs the source\'s own time column');
    return sinceTimestampMs(this.catalog.dialect, timeCol, watermarkMs);
  }

  /** Read the CURRENTLY-STORED stats for a property back into the merge shape. */
  _readStored(source, property) {
    const st = this.index.stats(source, property) || {};
    const rowsTotal = (st.totalCount != null && st.nullCount != null) ? st.totalCount + st.nullCount : null;
    return {
      values: this.index.sampleValues(source, property, this.maxValues).map((v) => ({ value: v.value, freq: v.freq })),
      coverage: this.index.coverage(source, property).map((c) => ({ event: c.event_name, rowCount: c.row_count, nonNull: c.non_null })),
      bundleCoverage: this.index.bundleCoverage(source, property).map((c) => ({ bundle: c.bundle, rowCount: c.row_count, nonNull: c.non_null })),
      cellCoverage: this.index.allCells(source, property),
      distinct: st.distinctCount ?? null, total: st.totalCount ?? null, rowsTotal,
    };
  }

  /** Add a delta's counts to the prior stored stats (pure). freq/coverage/totals are additive;
   *  distinct becomes a lower bound (max) — the exact figure needs a full scan, but the filter
   *  guard gates hard-rejects on the top-N cap, not on distinct, so a lower bound is safe. */
  _mergeStats(prior, delta) {
    const N = this.maxValues;
    const vmap = new Map();
    for (const v of [...(prior.values || []), ...(delta.values || [])]) vmap.set(String(v.value), (vmap.get(String(v.value)) || 0) + (Number(v.freq) || 0));
    const values = [...vmap].map(([value, freq]) => ({ value, freq })).sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)).slice(0, N);
    const addBy = (arr, keyFn) => {
      const m = new Map();
      for (const e of arr) { const k = keyFn(e); const v = m.get(k) || { e, rowCount: 0, nonNull: 0 }; v.rowCount += Number(e.rowCount) || 0; v.nonNull += Number(e.nonNull) || 0; m.set(k, v); }
      return m;
    };
    const cov = addBy([...(prior.coverage || []), ...(delta.coverage || [])], (e) => e.event);
    const bun = addBy([...(prior.bundleCoverage || []), ...(delta.bundleCoverage || [])], (e) => e.bundle);
    const cells = addBy([...(prior.cellCoverage || []), ...(delta.cellCoverage || [])], (e) => `${e.bundle} ${e.event}`);
    const total = (prior.total || 0) + (delta.total || 0);
    const rowsTotal = (prior.rowsTotal || 0) + (delta.rowsTotal || 0);
    const distinct = (prior.distinct == null && delta.distinct == null) ? null : Math.max(prior.distinct || 0, delta.distinct || 0);
    return {
      values,
      coverage: [...cov.values()].map((x) => ({ event: x.e.event, rowCount: x.rowCount, nonNull: x.nonNull })),
      bundleCoverage: [...bun.values()].map((x) => ({ bundle: x.e.bundle, rowCount: x.rowCount, nonNull: x.nonNull })),
      cellCoverage: [...cells.values()].map((x) => ({ bundle: x.e.bundle, event: x.e.event, rowCount: x.rowCount, nonNull: x.nonNull })),
      distinct, total, rowsTotal, nullCount: rowsTotal - total,
    };
  }

  /** Full per-property scan for merge mode over an explicit WHERE (`''` = whole table, or a
   *  delta predicate). Same stats as _indexOneExact PLUS maxTime (epoch ms) for the watermark. */
  async _scanProperty(t, bundleCol, runId, where = '') {
    const c = this.catalog;
    const timeCol = t.eventCol ? t.timeCol : null;
    const w = where ? ` WHERE ${where}` : '';
    const andW = where ? ` AND ${where}` : '';
    const values = (await this._topValuesExact(t.ref, t.expr, andW)) || [];
    const distinctExpr = (this.approxDistinct && approxCountDistinct(c.dialect, t.expr)) || `COUNT(DISTINCT ${t.expr})`;
    const wmSel = timeCol ? `, MAX(${timeCol}) AS wm` : '';
    const card = await this.runner.show(this.baseProjectDir, `SELECT ${distinctExpr} AS d, COUNT(${t.expr}) AS t, COUNT(*) AS rows_total${wmSel} FROM ${t.ref}${w}`, 1, this.scanTimeout);
    const stat = card.ok && card.rows?.[0] ? card.rows[0] : {};
    const distinct = stat.d != null ? Number(stat.d) : null;
    const total = stat.t != null ? Number(stat.t) : null;
    const rowsTotal = stat.rows_total != null ? Number(stat.rows_total) : null;
    const maxTime = stat.wm != null ? (Number.isFinite(Number(stat.wm)) ? Number(stat.wm) : Date.parse(stat.wm)) : null;
    let cov = { coverage: [], bundleCoverage: [], cellCoverage: [] };
    if (t.eventCol) {
      const sel = bundleCol
        ? `${t.eventCol} AS ev, ${bundleCol} AS app, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`
        : `${t.eventCol} AS ev, COUNT(*) AS row_count, COUNT(${t.expr}) AS non_null`;
      const grp = bundleCol ? `${t.eventCol}, ${bundleCol}` : `${t.eventCol}`;
      const r = await this.runner.show(this.baseProjectDir, `SELECT ${sel} FROM ${t.ref}${w} GROUP BY ${grp}`, bundleCol ? 5000 : 500, this.scanTimeout);
      if (r.ok) cov = this._coverageFromRows(r.rows, 'non_null', label(t), runId);
    }
    return { values, distinct, total, rowsTotal, nullCount: (rowsTotal != null && total != null) ? rowsTotal - total : null, ...cov, maxTime };
  }

  /** Index one anchor property incrementally: scan only rows since its watermark and MERGE into
   *  the stored stats. Returns { r, watermark } (r=null when there are no new rows → keep stored). */
  async _indexIncremental(t, bundleCol, runId, prior, since) {
    const delta = await this._scanProperty(t, bundleCol, runId, since);
    if (delta.maxTime == null) return { r: null, watermark: prior.dataWatermark }; // no new rows
    const merged = this._mergeStats(this._readStored(t.source, t.property), delta);
    return { r: merged, watermark: Math.max(prior.dataWatermark, delta.maxTime) };
  }

  /** The dbt selector for the catalog's source models (space-separated union), or null. */
  _sourceModelSelect() {
    if (this.runModelsSelect) return this.runModelsSelect;
    const names = [...new Set(this.catalog.modelKeys().map((k) => this.catalog.getModel(k).dbt_model).filter(Boolean))];
    return names.length ? names.join(' ') : null;
  }

  /** Rebuild the catalog's source models (dbt run) BEFORE indexing, so the index reflects a
   *  freshly computed table. Best-effort: a failed build is logged + noted, and indexing still
   *  proceeds over whatever data currently exists. No-op unless runModels is on. */
  async _dbtRunModels(runId) {
    if (!this.runModels || !this.runner?.run) return;
    const select = this._sourceModelSelect();
    if (!select) return;
    this.logger?.(`sync #${runId} rebuilding source models before indexing: dbt run --select ${select}`);
    const t = Date.now();
    const r = await this.runner.run(this.baseProjectDir, select);
    const ms = Date.now() - t;
    if (r.ok) { this.logger?.(`sync #${runId} dbt run ok (${ms}ms) — indexing the rebuilt models`); return; }
    const reason = [r.error, r.stderr, r.stdout].filter((s) => s && String(s).trim()).join('\n').trim() || 'unknown';
    this.logger?.(`sync #${runId} dbt run FAILED (${ms}ms) — indexing existing (possibly stale) data: ${reason}`);
    this.index.recordRunNote?.(runId, `dbt run of source models failed before indexing: ${reason}`);
  }

  /** One resilient pass over the indexable properties/attributes. Skips if already running. */
  async refresh() {
    if (this._running) return;
    if (!this.runner || !this.baseProjectDir) return;
    this._running = true;
    const runId = this.index.startRun?.(); // log the sync run (state for semantic_index)
    const startedAt = Date.now();
    await this._dbtRunModels(runId); // rebuild the models first (opt-in), then index them below
    let props = 0; let values = 0; let errors = 0; let lastError = null;
    const c = this.catalog;
    const allTargets = this._targets();
    // Reconcile the index with the live schema: DROP stored properties whose column is gone
    // (no longer a target) so a removed field does not linger. New fields (a target with nothing
    // stored) are picked up by the scan below and indexed on their own — no full reindex either
    // way. Prune against the FULL target set (not the high-card-filtered one) so a skipped
    // high-cardinality field is kept, not mistaken for a removed column.
    const desired = new Set(allTargets.map(label));
    // complex props are coverage-only targets (indexed by their own pass) — never prune them
    for (const f of c.facts) for (const prop of c.complexEventProps(f)) desired.add(label({ source: f, property: prop }));
    const orphans = (this.index.properties?.() || []).filter((k) => !desired.has(label(k)));
    for (const k of orphans) this.index.removeProperty?.(k.source, k.property);
    if (orphans.length) this.logger?.(`sync #${runId} pruned ${orphans.length} field(s) no longer in the schema: ${orphans.slice(0, 8).map(label).join(', ')}${orphans.length > 8 ? ', …' : ''}`);
    let targets = allTargets;
    // High-cardinality skip: a field already seen to be near-unique (its top-N is noise) is left
    // alone on subsequent syncs — it was indexed once and re-scanning it will not help.
    if (this.highCardRatio > 0) {
      const before = targets.length;
      targets = targets.filter((t) => !(this.index.stats?.(t.source, t.property)?.highCardinality));
      const skipped = before - targets.length;
      if (skipped) this.logger?.(`sync #${runId} skipping ${skipped} high-cardinality field(s) already indexed (distinct ≥ ${Math.round(this.highCardRatio * 100)}% of rows; top-N is noise there)`);
    }
    const nEvent = targets.filter((t) => t.eventCol).length;
    this.logger?.(`sync #${runId} started: indexing ${nEvent} scalar event properties from ${c.facts.map((f) => c.getModel(f).dbt_model).join(' + ')} + ${targets.length - nEvent} dimension attributes`);
    // ONE INDEPENDENT SCAN PER SOURCE. Every events source (and every dimension model) is its own
    // table with its own time axis, event column, app column and watermarks, so the pass is
    // grouped by source and each group is scanned on its own: its batches never mix with another
    // source's, its delta predicates are bound to its own time column, and an error that escapes
    // one source's pass is recorded against that source and the next source still runs.
    const groups = new Map();
    for (const t of targets) { if (!groups.has(t.source)) groups.set(t.source, []); groups.get(t.source).push(t); }
    const timing = (fields) => { try { this.index.recordPropertyTiming?.(runId, fields); } catch { /* run diagnostics never abort indexing */ } };
    try {
      let i = 0;
      for (const [source, groupTargets] of groups) {
        const ref = groupTargets[0].ref;
        const srcStart = Date.now(); const srcProps0 = props; const srcErrors0 = errors;
        try {
        for (let off = 0; off < groupTargets.length; off += this.batchSize) {
          const batch = groupTargets.slice(off, off + this.batchSize);
          const eventCol = batch[0].eventCol;
          const bundleCol = batch[0].bundleCol || null; // the app column OF THIS batch's table
          // Merge (anchor only): scan with ONE combined query bounded to rows since the watermark.
          // The batch is SPLIT so a newly-added field is indexed on its own (full scan) WITHOUT
          // forcing a full re-scan of the already-indexed ones (which only need a cheap delta):
          //   • fresh (have a watermark) → delta scan `time > oldest watermark`, merged;
          //   • newbies (nothing stored) → full scan, replaced.
          // Dimensions and non-merge use the plain windowed batch.
          const merging = this.merge && eventCol;
          const batchResults = new Map(); const deltaProps = new Set();
          let deltaMaxTime = null; let fullMaxTime = null; let batchFailed = false;
          const scanInto = async (subset, whereClause, asDelta) => {
            if (!subset.length) return;
            const res = await this._indexBatch(ref, subset, bundleCol, runId, { where: whereClause, withWm: merging });
            for (const [k, v] of res.results) { batchResults.set(k, v); if (asDelta) deltaProps.add(k); }
            if (asDelta) deltaMaxTime = res.maxTime; else fullMaxTime = res.maxTime;
          };
          try {
            if (merging) {
              const fresh = batch.filter((t) => this.index.stats?.(t.source, t.property)?.dataWatermark != null);
              const newbies = batch.filter((t) => this.index.stats?.(t.source, t.property)?.dataWatermark == null);
              const since = fresh.length ? this._sinceClause(Math.min(...fresh.map((t) => this.index.stats(t.source, t.property).dataWatermark)), batch[0].timeCol) : null;
              if (fresh.length) await scanInto(fresh, since || '', !!since); // delta if the dialect supports it, else full
              if (newbies.length) await scanInto(newbies, '', false);         // NEW fields: full scan, on their own
            } else {
              await scanInto(batch, null, false); // dimensions / non-merge: plain windowed batch
            }
          } catch (e) {
            batchFailed = true;
            const note = `combined batch scan of ${batch.length} propert${batch.length === 1 ? 'y' : 'ies'} from ${ref} [${label(batch[0])}…${label(batch[batch.length - 1])}] FAILED → fell back to per-property: ${e?.message || e}`;
            this.logger?.(`sync #${runId} ${note}`);
            this.index.recordRunNote?.(runId, note); // logged AND surfaced via semantic_index({ status })/({ run }).fallbacks
          }
          for (const t of batch) {
            i += 1;
            const tProp = Date.now();
            try {
              let r; let watermark; let mergedNoNew = false;
              const base = !batchFailed ? batchResults.get(t) : null;
              if (merging && !batchFailed && deltaProps.has(t)) {
                // delta merged into what is stored (no new rows → keep stored, just count the pass)
                if (deltaMaxTime == null) { mergedNoNew = true; watermark = this.index.stats?.(t.source, t.property)?.dataWatermark; }
                else { r = this._mergeStats(this._readStored(t.source, t.property), base); watermark = Math.max(this.index.stats?.(t.source, t.property)?.dataWatermark ?? 0, deltaMaxTime); }
              } else if (merging && !batchFailed) {
                r = base; watermark = fullMaxTime; // full scan (newbie or no since-clause) → records the watermark
              } else if (!batchFailed) {
                r = base; watermark = undefined; // dimensions / non-merge: plain replace, no watermark
              } else if (merging) {
                // batch failed → per-property merge fallback (delta if a watermark exists, else full)
                const prior = this.index.stats?.(t.source, t.property);
                const since = (prior?.dataWatermark != null && t.timeCol) ? this._sinceClause(prior.dataWatermark, t.timeCol) : null;
                if (since) { const inc = await this._indexIncremental(t, t.bundleCol || null, runId, prior, since); r = inc.r; watermark = inc.watermark; mergedNoNew = inc.r === null; }
                else { r = await this._scanProperty(t, t.bundleCol || null, runId, ''); watermark = r.maxTime; }
              } else {
                r = await this._indexOneExact(t, t.bundleCol || null, runId); watermark = undefined; // non-merge fallback
              }
              const ms = Date.now() - tProp;
              if (mergedNoNew) { // delta had no new rows → keep what is stored, just count the pass
                props += 1;
                timing({ source: t.source, property: t.property, ms, valuesWritten: 0, status: 'ok' });
                this.logger?.(`sync #${runId} [${i}/${targets.length}] '${label(t)}': no new rows since watermark — kept stored values (${ms}ms)`);
              } else {
                const highCardinality = this.highCardRatio > 0 && r.total != null && r.total > 0 && r.distinct != null && (r.distinct / r.total) >= this.highCardRatio;
                this.index.upsertProperty(t.source, t.property, { distinctCount: r.distinct, totalCount: r.total, nullCount: r.nullCount, values: r.values, coverage: r.coverage, bundleCoverage: r.bundleCoverage, cellCoverage: r.cellCoverage, highCardinality, ...(watermark !== undefined ? { dataWatermark: watermark } : {}) });
                props += 1; values += r.values.length;
                timing({ source: t.source, property: t.property, ms, valuesWritten: r.values.length, distinctCount: r.distinct, totalCount: r.total, status: 'ok' });
                this.logger?.(`sync #${runId} [${i}/${targets.length}] '${label(t)}': ${r.values.length} values stored, ${r.distinct ?? '?'} distinct / ${r.total ?? '?'} non-null / ${r.nullCount ?? '?'} null of ${r.rowsTotal ?? '?'} rows, ${r.coverage.length} events${r.bundleCoverage.length ? ` / ${r.bundleCoverage.length} apps` : ''} covered${deltaProps.has(t) ? ' (merged delta)' : ''}${highCardinality ? ' [high-cardinality → skipped next sync]' : ''} (${ms}ms)`);
              }
            } catch (e) {
              errors += 1; lastError = e?.message || String(e);
              timing({ source: t.source, property: t.property, ms: Date.now() - tProp, status: 'error', error: lastError });
              this.logger?.(`sync #${runId} [${i}/${targets.length}] '${label(t)}': FAILED — ${lastError}`);
            }
          }
        }
        } catch (e) {
          // Something escaped the per-batch and per-property guards for THIS source. It is that
          // source's failure alone: record it and move on to the next source's scan.
          errors += 1; lastError = e?.message || String(e);
          const note = `scan of source '${source}' (${ref}) aborted: ${lastError}`;
          this.logger?.(`sync #${runId} ${note}`);
          try { this.index.recordRunNote?.(runId, note); } catch { /* diagnostics never abort indexing */ }
        }
        this.logger?.(`sync #${runId} source '${source}': ${props - srcProps0} field(s) indexed, ${errors - srcErrors0} error(s), ${Date.now() - srcStart}ms`);
      }
      // COMPLEX props: per-event coverage only (so applicability is data-derived for them too).
      // Per source, in its own guard — one fact's complex pass failing must not skip another's.
      for (const fact of c.facts) {
        try { const cx = await this._indexComplexCoverage(runId, fact); props += cx.props; values += cx.values; }
        catch (e) { errors += 1; lastError = e?.message || String(e); this.logger?.(`sync #${runId} complex-coverage pass for '${fact}' FAILED — ${lastError}`); }
      }
    } finally {
      this._running = false;
      const status = errors ? (props ? 'partial' : 'error') : 'ok';
      const ms = Date.now() - startedAt;
      try { this.index.finishRun?.(runId, { status, propertiesIndexed: props, valuesWritten: values, errors, error: lastError }); } catch { /* never let logging break the indexer */ }
      this.logger?.(`sync #${runId} done: status=${status}, properties=${props}/${targets.length}, values=${values}, errors=${errors}, duration=${ms}ms`);
    }
  }
}
