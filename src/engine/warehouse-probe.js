// WHAT THE WAREHOUSE SAYS, ASKED ON THE WAY — the columns a relation really has, how fresh a source
// is, roughly how many rows a scope reads. Each is best effort: a probe that cannot answer never fails
// the call it serves. A service of its own — `engine.probe` — over the dbt runner, the contexts' base
// project, the catalog and the value index (whose scan generation retires its caches), holding the
// caches and the in-flight reads as its own state.

import { comparison } from '../conditions.js';
import { detached } from '../request-context.js';

/** How far back freshness looks first on a partitioned source (days): late enough data still lands in it. */
const FRESHNESS_LOOKBACK_DAYS = 7;
/** How many tasks' tables keep their columns cached (the oldest read goes first). */
const TABLE_CACHE_MAX = 256;

/** A relation's columns as the dbt client reports them: their names lowercased, with each one's type as
 *  the warehouse has it (`types`) — null when the warehouse did not answer. */
function columnSet(r) {
  if (!r?.ok || !Array.isArray(r.columns)) return null;
  const set = new Set(r.columns.map((c) => String(c.name).toLowerCase()));
  set.types = new Map(r.columns.filter((c) => c.dtype).map((c) => [String(c.name).toLowerCase(), c.dtype]));
  return set;
}

export class WarehouseProbe {
  constructor({ runner, ctxs, catalog, valueIndex, queryTimeoutMs, timeRangeConditions, now = () => Date.now() }) {
    this.now = now; // the clock freshness looks back from
    this.runner = runner;
    this.ctxs = ctxs;
    this.catalog = catalog;
    this.valueIndex = valueIndex;
    this.queryTimeoutMs = queryTimeoutMs;
    this.timeRangeConditions = timeRangeConditions;
    this.inFlight = new Map(); // key → the one read every caller waiting on it shares
    this.columnCache = new Map(); // source → { set, gen }
    this.tableCache = new Map(); // a task's table (owner:model:task) → { set, gen }
    this.freshnessCache = new Map(); // source → { value, gen }
  }

  /** Where dbt reads the warehouse: the server's own copy of the project (ContextManager.warehouseDir) — never the project itself. */
  readDir() {
    return this.ctxs.warehouseDir ? this.ctxs.warehouseDir() : this.ctxs.baseProjectDir;
  }

  /**
   * A BEST-EFFORT WAREHOUSE READ INSIDE AN INTERACTIVE CALL — WITH A DEADLINE OF OUR OWN.
   *
   * Several answers are ENRICHED from the warehouse: the physical column set that grounds a
   * source, the freshness of its time column, a row estimate. Each is an extra — the answer is
   * complete without it — but each is a dbt round trip, and dbt's own timeout is the build
   * timeout (10 minutes by default): long enough that the FIRST such call after a restart, when
   * the dbt process is cold and the warehouse has not been touched yet, outlives the timeout of
   * the client in front of the call. The client then reports a generic tool failure, the caller
   * retries, the retry hits the cache the abandoned call primed, and the difference looks like
   * whatever argument happened to change between the two.
   *
   * So the wait is bounded HERE, by the same grace a build gets (queryTimeoutMs, itself capped
   * below any client's patience): when it expires the caller gets `fallback` — the documented
   * "this could not be known" value every one of these already has a path for — while the read
   * runs on in the background and primes the cache for the next call. Concurrent callers share
   * one in-flight read, so a burst of tool calls cannot spawn a dbt process each.
   */
  async bestEffort(key, work, fallback = null) {
    let p = this.inFlight.get(key);
    if (!p) {
      // detached: this read serves every caller waiting on it, so it must not die with the first
      // one's cancellation (src/request-context.js).
      p = detached(async () => work()).finally(() => { if (this.inFlight.get(key) === p) this.inFlight.delete(key); });
      p.catch(() => {}); // it finishes unobserved after a timeout — never an unhandled rejection
      this.inFlight.set(key, p);
    }
    let timer;
    const expired = Symbol('expired');
    // NOT unref'd: a tool call is in flight, and the process must stay alive to answer it. The
    // timer is cleared the moment the race settles, so it never outlives the call.
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(expired), this.queryTimeoutMs); });
    try {
      const v = await Promise.race([p, deadline]);
      if (v !== expired) return v;
      console.error(`[mcp] warehouse enrichment '${key}' is still running after ${this.queryTimeoutMs / 1000}s — answering without it; it will be cached for the next call`);
      return fallback;
    } catch { return fallback; } finally { clearTimeout(timer); }
  }

  /**
   * Physical column NAMES (lowercased Set) of a source's relation, via the same
   * introspection semantic_index({ request: { source } }) uses — cached per source. null when it
   * cannot be known (no runner / relation not built / introspection failed / slower than
   * the grace), in which case the catalog's declared columns are used as-is (grounding
   * is skipped).
   */
  /**
   * What the warehouse says about a pipeline's columns: the source's physical columns (with their
   * types), and those of every model its joins bring in — a joined column is compared in the type it
   * HAS, as the source's own are (a flag stored as text, renamed by the join, is still text). A fresh
   * set each call: the cached ones are never written on. Null when the source could not be asked.
   */
  async grounding(source, stages = []) {
    const own = await this.physicalColumns(source);
    if (!own) return null; // the warehouse could not be asked: the declared columns stand
    const models = [...new Set((stages || []).filter((st) => st?.stage === 'join' && st.with && this.catalog.models[st.with]).map((st) => st.with))];
    const g = new Set(own);
    if (own.types) g.types = own.types;
    g.joined = new Map();
    for (const k of models) { const set = await this.physicalColumns(k); if (set) g.joined.set(k, set); }
    return g;
  }

  async physicalColumns(source) {
    if (!this.runner || !this.readDir()) return null;
    // a known set is kept; a lookup that could not know (the relation not built yet, the warehouse
    // unreachable) is kept only until the next index scan, so grounding comes back once it can
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    const hit = this.columnCache.get(source);
    if (hit && (hit.set || hit.gen === gen)) return hit.set;
    return this.bestEffort(`columns:${source}:${gen}`, async () => {
      let set = null;
      // …each with its type as the warehouse has it: what a constant compared with it must be
      try { set = columnSet(await this.runner.relationColumns(this.readDir(), this.catalog.getModel(source).dbt_model)); } catch { /* introspection unavailable → grounding skipped */ }
      this.columnCache.set(source, { set, gen });
      return set;
    });
  }

  /**
   * What the warehouse says about the columns of a TABLE A TASK STORED (a pipeline build, a query run
   * with materialize: true), in the shape physicalColumns gives a source's: read from the relation in
   * the context that owns it, whichever tool built it. Cached per task — a task's table is not rebuilt
   * under it; a lookup that could not know is kept only until the next index scan, as a source's is.
   * Null when it cannot be known (no runner, the owner or the relation gone, slower than the grace).
   */
  async tableColumns({ owner, model, task_id: taskId }) {
    if (!this.runner?.relationColumns || !this.ctxs.has?.(owner)) return null;
    const key = `${owner}:${model}:${taskId}`;
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    const hit = this.tableCache.get(key);
    if (hit && (hit.set || hit.gen === gen)) return hit.set;
    return this.bestEffort(`table-columns:${key}:${gen}`, async () => {
      let set = null;
      try { set = columnSet(await this.runner.relationColumns(this.ctxs.dir(owner), model)); } catch { /* introspection unavailable */ }
      this.tableCache.delete(key);
      this.tableCache.set(key, { set, gen });
      if (this.tableCache.size > TABLE_CACHE_MAX) this.tableCache.delete(this.tableCache.keys().next().value);
      return set;
    });
  }

  /**
   * Data FRESHNESS of a source: the LATEST value of its time column, live —
   *   SELECT MAX(<time column>) FROM <the source's model>
   * read first over the last FRESHNESS_LOOKBACK_DAYS only when the source is partitioned — the window
   * a query's time_range would put on it, its partition column included, so the read prunes as a
   * query does. The newest event, when there is one in that window, is the newest of all; only a
   * source with nothing in it is read whole (a source gone quiet, where its age is the news).
   * It is a DATA aggregate (the newest event actually present), NOT a dbt-run/deploy timestamp,
   * partition metadata, or an orchestration mark — and it is scoped to THIS model's relation.
   * Recomputed ONCE PER INDEX SCAN: the cache is keyed on the value-index sync generation, so a
   * completed background scan invalidates it and the next read re-queries MAX(time) — tied to the
   * scan, not a wall-clock timer. Best-effort: null with no runner/time column, if it fails, or if
   * it is slower than the interactive grace (bestEffort) — the next call reads the primed cache.
   */
  async dataFreshness(sourceKey) {
    const base = this.readDir();
    const m = this.catalog.getModel(sourceKey);
    const tcol = m.time?.column;
    if (!this.runner || !base || !tcol) return null;
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    const hit = this.freshnessCache.get(sourceKey);
    if (hit && hit.gen === gen) return hit.value; // re-query only after the next index scan completes
    return this.bestEffort(`freshness:${sourceKey}:${gen}`, async () => {
      let latest = null;
      const maxOver = async (where) => {
        const r = await this.runner.show(base, `SELECT MAX(${tcol}) AS latest FROM {{ ref('${m.dbt_model}') }}${where}`, 1);
        return r.ok && r.rows?.[0]?.latest != null ? String(r.rows[0].latest) : null;
      };
      try {
        const recent = m.partition_column ? this.timeRangeConditions(sourceKey, { start: new Date(this.now() - FRESHNESS_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10) }) : null;
        if (recent) latest = await maxOver(` WHERE ${recent.map((c) => comparison(c.column, c.op, c.value)).join(' AND ')}`);
        if (latest == null) latest = await maxOver('');
      } catch { /* freshness is best-effort */ }
      this.freshnessCache.set(sourceKey, { value: latest, gen });
      return latest;
    });
  }

  /**
   * A5: a cheap pre-run volume estimate — COUNT(*) over a source model within an
   * optional time window (the same window the pipeline will apply). Lets the caller
   * gauge the scan before materializing. Best-effort: returns null when there is no
   * runner / base project, the count fails, or it is slower than the interactive grace.
   */
  async estimateSourceRows(sourceKey, tr) {
    const base = this.readDir();
    if (!this.runner || !base) return null;
    const m = this.catalog.getModel(sourceKey);
    let where = '';
    // the same window the pipeline applies — the time axis, and the partition column that prunes
    const conditions = tr && (tr.start || tr.end) ? this.timeRangeConditions(sourceKey, tr) : null;
    if (conditions) {
      where = ` WHERE ${conditions.map((c) => comparison(c.column, c.op, c.value)).join(' AND ')}`;
    }
    return this.bestEffort(`rows:${sourceKey}:${where}`, async () => {
      try {
        const r = await this.runner.show(base, `SELECT COUNT(*) AS n FROM {{ ref('${m.dbt_model}') }}${where}`, 1);
        if (r.ok && r.rows?.[0]) return Number(r.rows[0].n);
      } catch { /* estimate is best-effort */ }
      return null;
    });
  }
}

