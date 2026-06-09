// Background-populated index of REAL event-property values (top values by frequency +
// cardinality), surfaced in describe_catalog so the AI sees not just property NAMES/types
// but the actual VALUES a property carries. Persistence is delegated to a swappable store
// backend (see store.js) — this class holds NO SQL, just the domain operations. The
// BackgroundIndexer populates it NON-BLOCKING from the warehouse at startup + on a schedule.

import { jsonExtract } from './dialect.js';
import { openStore } from './store.js';

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
  upsertProperty(property, spec = {}) {
    this.store.values.replaceProperty(property, spec);
  }

  /** Per-event_name coverage for a property: [{ event_name, row_count, non_null, null_count }]. */
  coverage(property) {
    return this.store.values.coverage ? this.store.values.coverage(property) : [];
  }

  /** Top `limit` values for a property, ordered by freq desc (value-ASC tiebreak). */
  sampleValues(property, limit = 10) {
    return this.store.values.top(property, limit);
  }

  /**
   * Pageable + orderable view of a property's stored values: order by 'freq' (default)
   * or 'value', asc/desc, with limit/offset. `by`/`dir` are normalised to a closed set
   * here, so the backend never sees raw input in an ORDER BY position.
   */
  listValues(property, { limit = 10, offset = 0, by = 'freq', dir } = {}) {
    const col = by === 'value' ? 'value' : 'freq';
    const direction = (dir === 'asc' || dir === 'desc') ? dir : (col === 'value' ? 'asc' : 'desc');
    return this.store.values.page(property, { limit, offset, col, direction });
  }

  /** { distinctCount, totalCount, indexedAt } | null. */
  stats(property) {
    return this.store.values.stats(property);
  }

  /** [{ property, value, freq }] where value contains `query` (case-insensitive), freq desc. */
  searchValues(query, limit = 20) {
    return this.store.values.search(query, limit);
  }

  close() {
    if (this._ownsStore) { try { this.store.close(); } catch { /* already closed */ } }
  }

  // ── sync-run log (consumed by describe_index) ──────────────────────────────
  /** Record the start of a refresh pass; returns a run id to pass to finishRun. */
  startRun() { return this.store.runs.start(); }

  /** Mark a run terminal with its outcome. status: 'ok' | 'partial' | 'error'. */
  finishRun(runId, fields = {}) {
    if (runId == null) return;
    this.store.runs.finish(runId, { status: 'ok', propertiesIndexed: null, valuesWritten: null, errors: null, error: null, ...fields });
  }

  /** Record how long ONE property took within a run (+ what it produced). */
  recordPropertyTiming(runId, fields = {}) {
    if (runId == null || !fields.property) return;
    this.store.runs.recordProperty(runId, fields);
  }

  /** Per-property timing/coverage for a run (slowest first). */
  runProperties(runId, opts = {}) { return this.store.runs.properties(runId, opts); }

  /** A single run's header row, or null. */
  runById(runId) { return this.store.runs.get(runId); }

  /** Per-run timing history for one property (most recent first). */
  propertyHistory(property, opts = {}) { return this.store.runs.propertyHistory(property, opts); }

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
 * Non-blocking background indexer: walks the SCALAR, non-complex event properties
 * of the anchor (events) model PLUS the categorical dimension attributes of the
 * non-anchor models (users/experiments — under 'users.country'-style keys) and
 * stores, per property, the top values by frequency + cardinality/total. Runs an
 * initial pass fire-and-forget at start() and then on an unref'd interval.
 * Per-property errors are swallowed so one bad property never aborts a run or
 * crashes the server.
 */
export class BackgroundIndexer {
  constructor({ catalog, runner, index, baseProjectDir, intervalMs = 21600000, maxValues = 50, logger } = {}) {
    this.catalog = catalog;
    this.runner = runner;
    this.index = index;
    this.baseProjectDir = baseProjectDir;
    this.intervalMs = intervalMs;
    this.maxValues = maxValues;
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

  /** Value SQL expression for a property: a flat physical column, else a JSON extract. */
  _valueExpr(name, spec) {
    if (spec.column) return spec.column;
    return jsonExtract(this.catalog.dialect, this.catalog.eventDataColumn(), name, spec.type);
  }

  /**
   * Indexing worklist: the anchor's scalar event properties (with per-event_name
   * coverage) PLUS the categorical dimension columns of every non-anchor model
   * (users / experiments), stored under namespaced keys like 'users.country' or
   * 'experiments.experiment_name' — so user-attribute values and experiment names
   * are just as discoverable via describe_catalog search/drill-down as event values.
   */
  _targets() {
    const c = this.catalog;
    const anchorRef = `{{ ref('${c.getModel(c.anchor).dbt_model}') }}`;
    const evCol = c.eventNameColumn();
    const targets = c.scalarEventProps().map((name) => {
      const spec = c.eventPropertySpec(name);
      return spec ? { property: name, ref: anchorRef, expr: this._valueExpr(name, spec), eventCol: evCol } : null;
    }).filter(Boolean);
    for (const key of c.modelKeys()) {
      if (key === c.anchor) continue;
      const m = c.getModel(key);
      const ref = `{{ ref('${m.dbt_model}') }}`;
      for (const [col, spec] of Object.entries(m.dimensions || {})) {
        if (String(spec?.type || '').toLowerCase() === 'time') continue; // dates aren't enumerable value sets
        targets.push({ property: `${key}.${col}`, ref, expr: col, eventCol: null });
      }
    }
    return targets;
  }

  /** One resilient pass over the indexable properties/attributes. Skips if already running. */
  async refresh() {
    if (this._running) return;
    if (!this.runner || !this.baseProjectDir) return;
    this._running = true;
    const runId = this.index.startRun?.(); // log the sync run (state for describe_index)
    const startedAt = Date.now();
    let props = 0; let values = 0; let errors = 0; let lastError = null;
    const c = this.catalog;
    const targets = this._targets();
    const nEvent = targets.filter((t) => t.eventCol).length;
    this.logger?.(`sync #${runId} started: indexing ${nEvent} scalar event properties from ${c.getModel(c.anchor).dbt_model} + ${targets.length - nEvent} dimension attributes (users/experiments)`);
    try {
      let i = 0;
      for (const { property: name, ref, expr, eventCol } of targets) {
        i += 1;
        // Sequential await between properties yields to the event loop, keeping
        // tool calls responsive during a refresh.
        const tProp = Date.now(); // per-property timing (detailed stats for describe_index)
        try {
          // No SQL-level LIMIT: `runner.show` appends its own `limit` clause (dbt
          // show --limit), so a trailing LIMIT here would be invalid SQL. Cap with
          // the show limit (= maxValues) instead — GROUP BY + ORDER BY keep the top N.
          const top = await this.runner.show(this.baseProjectDir, `SELECT ${expr} AS v, COUNT(*) AS n FROM ${ref} WHERE ${expr} IS NOT NULL GROUP BY 1 ORDER BY n DESC`, this.maxValues);
          if (!top.ok) {
            this.index.recordPropertyTiming?.(runId, { property: name, ms: Date.now() - tProp, status: 'skipped' });
            this.logger?.(`sync #${runId} [${i}/${targets.length}] '${name}': skipped (query not ok)`); continue;
          }
          // d=distinct, t=non-null count, rows_total=all rows → null_count = rows_total - t.
          const card = await this.runner.show(this.baseProjectDir, `SELECT COUNT(DISTINCT ${expr}) AS d, COUNT(${expr}) AS t, COUNT(*) AS rows_total FROM ${ref}`, 1);
          const stat = card.ok && card.rows?.[0] ? card.rows[0] : {};
          const vals = (top.rows || []).filter((r) => r.v != null).map((r) => ({ value: r.v, freq: Number(r.n) }));
          const distinct = stat.d != null ? Number(stat.d) : null;
          const total = stat.t != null ? Number(stat.t) : null;
          const rowsTotal = stat.rows_total != null ? Number(stat.rows_total) : null;
          const nullCount = (rowsTotal != null && total != null) ? rowsTotal - total : null;
          // Per-event_name null/coverage (anchor properties only): how many rows of each
          // event carry a value vs NULL. A field is expected to be NULL on events it does
          // not apply to — this lets the caller tell that (normal) from genuine gaps.
          let coverage = [];
          if (eventCol) {
            const cov = await this.runner.show(this.baseProjectDir, `SELECT ${eventCol} AS ev, COUNT(*) AS row_count, COUNT(${expr}) AS non_null FROM ${ref} GROUP BY ${eventCol}`, 500);
            if (cov.ok) coverage = (cov.rows || []).filter((r) => r.ev != null).map((r) => ({ event: r.ev, rowCount: Number(r.row_count), nonNull: Number(r.non_null) }));
          }
          this.index.upsertProperty(name, { distinctCount: distinct, totalCount: total, nullCount, values: vals, coverage });
          const ms = Date.now() - tProp;
          props += 1; values += vals.length;
          this.index.recordPropertyTiming?.(runId, { property: name, ms, valuesWritten: vals.length, distinctCount: distinct, totalCount: total, status: 'ok' });
          this.logger?.(`sync #${runId} [${i}/${targets.length}] '${name}': ${vals.length} values stored, ${distinct ?? '?'} distinct / ${total ?? '?'} non-null / ${nullCount ?? '?'} null of ${rowsTotal ?? '?'} rows, ${coverage.length} events covered (${ms}ms)`);
        } catch (e) {
          errors += 1; lastError = e?.message || String(e);
          this.index.recordPropertyTiming?.(runId, { property: name, ms: Date.now() - tProp, status: 'error', error: lastError });
          this.logger?.(`sync #${runId} [${i}/${targets.length}] '${name}': FAILED — ${lastError}`);
        }
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
