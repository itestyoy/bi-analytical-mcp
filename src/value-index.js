// Background-populated index of REAL event-property values (top values by
// frequency + cardinality), surfaced in describe_catalog so the AI sees not just
// property NAMES/types but the actual VALUES a property carries. Persisted in a
// minimal SQLite db (graceful in-memory fallback when node:sqlite is unavailable,
// mirroring src/jobs.js). The BackgroundIndexer populates it NON-BLOCKING from the
// warehouse at startup + on a schedule.

import { createRequire } from 'node:module';
import { jsonExtract } from './dialect.js';

const require = createRequire(import.meta.url);

export class ValueIndex {
  constructor({ dbPath } = {}) {
    this.db = null;
    this.mem = new Map(); // property -> { distinctCount, totalCount, indexedAt, values: [{value, freq}] }
    this.memRuns = []; // in-memory fallback for the sync-run log
    this._memRunSeq = 0;
    if (dbPath) this._openDb(dbPath);
  }

  _openDb(dbPath) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(dbPath);
      this.db.exec('CREATE TABLE IF NOT EXISTS prop_values (property TEXT, value TEXT, freq INTEGER, PRIMARY KEY(property, value))');
      this.db.exec('CREATE TABLE IF NOT EXISTS prop_stats (property TEXT PRIMARY KEY, distinct_count INTEGER, total_count INTEGER, indexed_at INTEGER)');
      // Sync-run log: one row per BackgroundIndexer.refresh() — when it ran, its status,
      // and how much it touched. Lets describe_index report the indexing state over time.
      this.db.exec('CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, finished_at INTEGER, status TEXT, properties_indexed INTEGER, values_written INTEGER, errors INTEGER, error TEXT)');
      this._delValues = this.db.prepare('DELETE FROM prop_values WHERE property = ?');
      this._insValue = this.db.prepare('INSERT INTO prop_values (property, value, freq) VALUES (?, ?, ?)');
      this._upStats = this.db.prepare('INSERT INTO prop_stats (property, distinct_count, total_count, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(property) DO UPDATE SET distinct_count=excluded.distinct_count, total_count=excluded.total_count, indexed_at=excluded.indexed_at');
      // value ASC tiebreak keeps ordering deterministic on ties (and identical to the
      // in-memory fallback); value is unique per property (PK), so it fully orders ties.
      this._selValues = this.db.prepare('SELECT value, freq FROM prop_values WHERE property = ? ORDER BY freq DESC, value ASC LIMIT ?');
      this._selStats = this.db.prepare('SELECT distinct_count, total_count, indexed_at FROM prop_stats WHERE property = ?');
      this._searchValues = this.db.prepare("SELECT property, value, freq FROM prop_values WHERE instr(lower(value), ?) > 0 ORDER BY freq DESC, value ASC LIMIT ?");
      this._insRun = this.db.prepare("INSERT INTO index_runs (started_at, status) VALUES (?, 'running')");
      this._finRun = this.db.prepare('UPDATE index_runs SET finished_at=?, status=?, properties_indexed=?, values_written=?, errors=?, error=? WHERE id=?');
      // A run left 'running' across a restart can never finish (its indexer is gone) →
      // reconcile to a terminal 'interrupted' so the state never shows a phantom sync.
      this.db.prepare("UPDATE index_runs SET status='interrupted', finished_at=started_at WHERE finished_at IS NULL").run();
    } catch {
      this.db = null; // sqlite unavailable -> in-memory only
    }
  }

  /** Replace the stored values + stats for one property (cap = top N the caller already trimmed). */
  upsertProperty(property, { distinctCount, totalCount, values = [] } = {}) {
    const at = Date.now();
    if (this.db) {
      this.db.exec('BEGIN');
      try {
        this._delValues.run(property);
        for (const v of values) this._insValue.run(property, String(v.value), Number(v.freq) || 0);
        this._upStats.run(property, distinctCount ?? null, totalCount ?? null, at);
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
      return;
    }
    this.mem.set(property, {
      distinctCount: distinctCount ?? null,
      totalCount: totalCount ?? null,
      indexedAt: at,
      values: values.map((v) => ({ value: String(v.value), freq: Number(v.freq) || 0 })).sort((a, b) => b.freq - a.freq || a.value.localeCompare(b.value)),
    });
  }

  /** Top `limit` values for a property, ordered by freq desc. */
  sampleValues(property, limit = 10) {
    if (this.db) return this._selValues.all(property, limit).map((r) => ({ value: r.value, freq: Number(r.freq) }));
    const e = this.mem.get(property);
    return e ? e.values.slice(0, limit).map((v) => ({ value: v.value, freq: v.freq })) : [];
  }

  /**
   * Pageable + orderable view of a property's stored values: order by 'freq' (default)
   * or 'value', asc/desc, with limit/offset. `by`/`dir` are whitelisted, never raw input.
   */
  listValues(property, { limit = 10, offset = 0, by = 'freq', dir } = {}) {
    const col = by === 'value' ? 'value' : 'freq';
    const direction = (dir === 'asc' || dir === 'desc') ? dir : (col === 'value' ? 'asc' : 'desc');
    if (this.db) {
      // col/direction are from a closed whitelist above (safe to interpolate); value
      // tiebreak keeps paging stable. limit/offset stay bound parameters.
      const stmt = this.db.prepare(`SELECT value, freq FROM prop_values WHERE property = ? ORDER BY ${col} ${direction.toUpperCase()}, value ASC LIMIT ? OFFSET ?`);
      return stmt.all(property, limit, offset).map((r) => ({ value: r.value, freq: Number(r.freq) }));
    }
    const e = this.mem.get(property);
    if (!e) return [];
    // Mirror SQLite's `ORDER BY <col> <dir>, value ASC`: primary key honors direction,
    // ties always break on value ASC (so reversing the whole array is wrong).
    const sign = direction === 'desc' ? -1 : 1;
    const arr = [...e.values].sort((a, b) => {
      const primary = col === 'value' ? String(a.value).localeCompare(String(b.value)) : a.freq - b.freq;
      return primary !== 0 ? sign * primary : String(a.value).localeCompare(String(b.value));
    });
    return arr.slice(offset, offset + limit).map((v) => ({ value: v.value, freq: v.freq }));
  }

  /** { distinctCount, totalCount, indexedAt } | null. */
  stats(property) {
    if (this.db) {
      const r = this._selStats.get(property);
      return r ? { distinctCount: r.distinct_count, totalCount: r.total_count, indexedAt: r.indexed_at } : null;
    }
    const e = this.mem.get(property);
    return e ? { distinctCount: e.distinctCount, totalCount: e.totalCount, indexedAt: e.indexedAt } : null;
  }

  /** [{ property, value, freq }] where value contains `query` (case-insensitive), freq desc. */
  searchValues(query, limit = 20) {
    const q = String(query).toLowerCase();
    if (this.db) return this._searchValues.all(q, limit).map((r) => ({ property: r.property, value: r.value, freq: Number(r.freq) }));
    const out = [];
    for (const [property, e] of this.mem) {
      for (const v of e.values) if (v.value.toLowerCase().includes(q)) out.push({ property, value: v.value, freq: v.freq });
    }
    return out.sort((a, b) => b.freq - a.freq).slice(0, limit);
  }

  close() {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  // ── sync-run log (consumed by describe_index) ──────────────────────────────
  /** Record the start of a refresh pass; returns a run id to pass to finishRun. */
  startRun() {
    const at = Date.now();
    if (this.db) return Number(this._insRun.run(at).lastInsertRowid);
    const id = ++this._memRunSeq;
    this.memRuns.push({ id, started_at: at, finished_at: null, status: 'running', properties_indexed: null, values_written: null, errors: null, error: null });
    return id;
  }

  /** Mark a run terminal with its outcome. status: 'ok' | 'partial' | 'error'. */
  finishRun(runId, { status = 'ok', propertiesIndexed = null, valuesWritten = null, errors = null, error = null } = {}) {
    if (runId == null) return;
    const at = Date.now();
    if (this.db) { this._finRun.run(at, status, propertiesIndexed, valuesWritten, errors, error, runId); return; }
    const r = this.memRuns.find((x) => x.id === runId);
    if (r) Object.assign(r, { finished_at: at, status, properties_indexed: propertiesIndexed, values_written: valuesWritten, errors, error });
  }

  _allRuns() {
    if (this.db) return this.db.prepare('SELECT * FROM index_runs ORDER BY id DESC').all();
    return [...this.memRuns].sort((a, b) => b.id - a.id);
  }

  /** Snapshot of the indexing state: coverage counts + the run history. */
  syncStatus({ recent = 10 } = {}) {
    const runs = this._allRuns();
    const fmt = (r) => (r ? { started_at: r.started_at, finished_at: r.finished_at, status: r.status, properties_indexed: r.properties_indexed, values_written: r.values_written, errors: r.errors, error: r.error, duration_ms: (r.finished_at != null && r.started_at != null) ? r.finished_at - r.started_at : null } : null);
    const lastFinished = runs.find((r) => r.finished_at != null) || null;
    let indexedProps; let totalValues;
    if (this.db) {
      indexedProps = Number(this.db.prepare('SELECT COUNT(*) AS n FROM prop_stats').get().n);
      totalValues = Number(this.db.prepare('SELECT COUNT(*) AS n FROM prop_values').get().n);
    } else {
      indexedProps = this.mem.size;
      totalValues = [...this.mem.values()].reduce((s, e) => s + e.values.length, 0);
    }
    return {
      persisted: !!this.db,
      running: runs.some((r) => r.status === 'running'),
      indexed_properties: indexedProps,
      total_values: totalValues,
      total_runs: runs.length,
      last_run: fmt(runs[0]),
      last_successful_run: fmt(lastFinished && lastFinished.status !== 'error' ? lastFinished : runs.find((r) => r.status === 'ok')) || null,
      recent_runs: runs.slice(0, recent).map(fmt),
    };
  }
}

/**
 * Non-blocking background indexer: walks the SCALAR, non-complex event properties
 * of the anchor (events) model and stores, per property, the top values by
 * frequency + cardinality/total. Runs an initial pass fire-and-forget at start()
 * and then on an unref'd interval. Per-property errors are swallowed so one bad
 * property never aborts a run or crashes the server.
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

  /** One resilient pass over the scalar event properties. Skips if already running. */
  async refresh() {
    if (this._running) return;
    if (!this.runner || !this.baseProjectDir) return;
    this._running = true;
    const runId = this.index.startRun?.(); // log the sync run (state for describe_index)
    const startedAt = Date.now();
    let props = 0; let values = 0; let errors = 0; let lastError = null;
    const c = this.catalog;
    const names = c.scalarEventProps();
    this.logger?.(`sync #${runId} started: indexing ${names.length} scalar event properties from ${c.getModel(c.anchor).dbt_model}`);
    try {
      const ref = `{{ ref('${c.getModel(c.anchor).dbt_model}') }}`;
      let i = 0;
      for (const name of names) {
        i += 1;
        // Sequential await between properties yields to the event loop, keeping
        // tool calls responsive during a refresh.
        try {
          const spec = c.eventPropertySpec(name);
          if (!spec) continue;
          const expr = this._valueExpr(name, spec);
          // No SQL-level LIMIT: `runner.show` appends its own `limit` clause (dbt
          // show --limit), so a trailing LIMIT here would be invalid SQL. Cap with
          // the show limit (= maxValues) instead — GROUP BY + ORDER BY keep the top N.
          const top = await this.runner.show(this.baseProjectDir, `SELECT ${expr} AS v, COUNT(*) AS n FROM ${ref} WHERE ${expr} IS NOT NULL GROUP BY 1 ORDER BY n DESC`, this.maxValues);
          if (!top.ok) { this.logger?.(`sync #${runId} [${i}/${names.length}] '${name}': skipped (query not ok)`); continue; }
          const card = await this.runner.show(this.baseProjectDir, `SELECT COUNT(DISTINCT ${expr}) AS d, COUNT(${expr}) AS t FROM ${ref}`, 1);
          const stat = card.ok && card.rows?.[0] ? card.rows[0] : {};
          const vals = (top.rows || []).filter((r) => r.v != null).map((r) => ({ value: r.v, freq: Number(r.n) }));
          const distinct = stat.d != null ? Number(stat.d) : null;
          const total = stat.t != null ? Number(stat.t) : null;
          this.index.upsertProperty(name, { distinctCount: distinct, totalCount: total, values: vals });
          props += 1; values += vals.length;
          this.logger?.(`sync #${runId} [${i}/${names.length}] '${name}': ${vals.length} values stored, ${distinct ?? '?'} distinct / ${total ?? '?'} total`);
        } catch (e) {
          errors += 1; lastError = e?.message || String(e);
          this.logger?.(`sync #${runId} [${i}/${names.length}] '${name}': FAILED — ${lastError}`);
        }
      }
    } finally {
      this._running = false;
      const status = errors ? (props ? 'partial' : 'error') : 'ok';
      const ms = Date.now() - startedAt;
      try { this.index.finishRun?.(runId, { status, propertiesIndexed: props, valuesWritten: values, errors, error: lastError }); } catch { /* never let logging break the indexer */ }
      this.logger?.(`sync #${runId} done: status=${status}, properties=${props}/${names.length}, values=${values}, errors=${errors}, duration=${ms}ms`);
    }
  }
}
