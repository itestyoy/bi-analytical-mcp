// WHAT THE WAREHOUSE SAYS, ASKED ON THE WAY — the columns a relation really has, how fresh a source
// is, roughly how many rows a scope reads. Each is best effort: a probe that cannot answer never fails
// the call it serves. A service of its own — `engine.probe` — over the dbt runner, the contexts' base
// project, the catalog and the value index (whose scan generation retires its caches), holding the
// caches and the in-flight reads as its own state.

import { comparison } from '../conditions.js';
import { detached } from '../request-context.js';

export class WarehouseProbe {
  constructor({ runner, ctxs, catalog, valueIndex, queryTimeoutMs, timeRangeConditions }) {
    this.runner = runner;
    this.ctxs = ctxs;
    this.catalog = catalog;
    this.valueIndex = valueIndex;
    this.queryTimeoutMs = queryTimeoutMs;
    this.timeRangeConditions = timeRangeConditions;
    this.inFlight = new Map(); // key → the one read every caller waiting on it shares
    this.columnCache = new Map(); // source → { set, gen }
    this.freshnessCache = new Map(); // source → { value, gen }
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
   * introspection semantic_index({ model }) uses — cached per source. null when it
   * cannot be known (no runner / relation not built / introspection failed / slower than
   * the grace), in which case the catalog's declared columns are used as-is (grounding
   * is skipped).
   */
  async physicalColumns(source) {
    if (!this.runner || !this.ctxs.baseProjectDir) return null;
    // a known set is kept; a lookup that could not know (the relation not built yet, the warehouse
    // unreachable) is kept only until the next index scan, so grounding comes back once it can
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    const hit = this.columnCache.get(source);
    if (hit && (hit.set || hit.gen === gen)) return hit.set;
    return this.bestEffort(`columns:${source}:${gen}`, async () => {
      let set = null;
      try {
        const r = await this.runner.relationColumns(this.ctxs.baseProjectDir, this.catalog.getModel(source).dbt_model);
        if (r.ok && Array.isArray(r.columns)) set = new Set(r.columns.map((c) => String(c.name).toLowerCase()));
      } catch { /* introspection unavailable → grounding skipped */ }
      this.columnCache.set(source, { set, gen });
      return set;
    });
  }

  /**
   * Data FRESHNESS of a source: the LATEST value of its time column, live —
   *   SELECT MAX(<time column>) FROM <the source's model>
   * It is a DATA aggregate (the newest event actually present), NOT a dbt-run/deploy timestamp,
   * partition metadata, or an orchestration mark — and it is scoped to THIS model's relation.
   * Recomputed ONCE PER INDEX SCAN: the cache is keyed on the value-index sync generation, so a
   * completed background scan invalidates it and the next read re-queries MAX(time) — tied to the
   * scan, not a wall-clock timer. Best-effort: null with no runner/time column, if it fails, or if
   * it is slower than the interactive grace (bestEffort) — the next call reads the primed cache.
   */
  async dataFreshness(sourceKey) {
    const base = this.ctxs.baseProjectDir;
    const m = this.catalog.getModel(sourceKey);
    const tcol = m.time?.column;
    if (!this.runner || !base || !tcol) return null;
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    const hit = this.freshnessCache.get(sourceKey);
    if (hit && hit.gen === gen) return hit.value; // re-query only after the next index scan completes
    return this.bestEffort(`freshness:${sourceKey}:${gen}`, async () => {
      let latest = null;
      try {
        const r = await this.runner.show(base, `SELECT MAX(${tcol}) AS latest FROM {{ ref('${m.dbt_model}') }}`, 1);
        if (r.ok && r.rows?.[0]?.latest != null) latest = String(r.rows[0].latest);
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
    const base = this.ctxs.baseProjectDir;
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

