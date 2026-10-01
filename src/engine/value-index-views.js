// WHAT THE VALUE INDEX HOLDS, AS semantic_index SHOWS IT — one key's values paged, its NULL coverage
// per event, its indexing history, one sync run's breakdown, and the operational status (the sync state
// and the background tasks). A service of its own over the value index and the job registry —
// `engine.indexViews` — that the catalog views of src/engine/semantic-index.js compose.

import { ToolError } from '../validate.js';

export class ValueIndexViews {
  constructor({ valueIndex, jobs }) {
    this.valueIndex = valueIndex;
    this.jobs = jobs;
  }

  /**
   * Pageable/orderable view of one indexed key's VALUES (limit/offset/order_by/direction)
   * + descriptive stats. Shared by event-property and dimension-attribute drill-downs.
   * Over-fetches by one so has_more is accurate at the boundary (next page non-empty).
   */
  valueListing(source, key, input = {}) {
    const st = this.valueIndex.stats(source, key);
    const dc = st?.distinctCount ?? null;
    const total = st?.totalCount ?? null;
    const orderBy = input.order_by === 'value' ? 'value' : 'freq';
    const dir = (input.direction === 'asc' || input.direction === 'desc') ? input.direction : (orderBy === 'value' ? 'asc' : 'desc');
    const limit = input.limit ?? 10;
    const offset = input.offset ?? 0;
    const fetched = this.valueIndex.listValues(source, key, { limit: limit + 1, offset, by: orderBy, dir });
    const has_more = fetched.length > limit;
    const samples = has_more ? fetched.slice(0, limit) : fetched;
    // top_value is the single most frequent value; share = its fraction of indexed rows.
    const top = this.valueIndex.sampleValues(source, key, 1)[0] || null;
    // The index keeps only the top-N values by frequency. If the column has MORE distinct
    // values than are stored, rare ones are NOT in the index — a search for them will miss,
    // so callers must verify a "not found" with a direct query rather than trust absence.
    const storedValues = this.valueIndex.valueCount(source, key);
    const valuesCapped = !!st && dc != null && storedValues != null && dc > storedValues;
    const value_stats = {
      distinct_count: dc, total_count: total,
      top_value: top ? top.value : null, top_freq: top ? top.freq : null,
      top_share: top && total ? Math.round((top.freq / total) * 1000) / 1000 : null,
      indexed: !!st, indexed_at: st?.indexedAt ?? null,
      // values stored are capped (top-by-frequency); paging past them returns [].
      returned: samples.length, limit, offset, order_by: orderBy, direction: dir,
      has_more,
      indexed_value_count: storedValues, values_capped: valuesCapped,
    };
    return { samples, value_stats };
  }

  /** Compact row for a property's per-run indexing record. */
  propertyRow(r) {
    return { ...(r.source ? { source: r.source } : {}), property: r.property, ms: r.ms, values: r.values_written, distinct_count: r.distinct_count, total_count: r.total_count, status: r.status, ...(r.error ? { error: r.error } : {}) };
  }

  /**
   * NULL coverage of one indexed key (from the latest sync): overall null counts +
   * a per-event_name breakdown. A property is NULL on events it does not apply to —
   * each event is annotated with `applies` (OBSERVED: non-null on at least one of that event's
   * rows) so EXPECTED nulls are distinguishable from real data gaps. Nothing is declared.
   */
  nullCoverage(source, key, { eventScoped = false } = {}) {
    const st = this.valueIndex.stats(source, key);
    const rowCount = (st && st.totalCount != null && st.nullCount != null) ? st.totalCount + st.nullCount : null;
    const frac = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
    const nulls = { non_null_count: st?.totalCount ?? null, null_count: st?.nullCount ?? null, row_count: rowCount, null_fraction: (st?.nullCount != null && rowCount) ? frac(st.nullCount, rowCount) : null };
    // Applicability is DATA-DERIVED: for an event property an event "carries" the field when it is
    // non-null on >= 1 of that event's rows (observed, not a declared meta.mcp.events list). For a
    // non-event key (a dimension attribute) applicability is not event-scoped, so `applies` is true.
    const coverage = this.valueIndex.coverage(source, key).map((e) => ({
      event_name: e.event_name, row_count: e.row_count, non_null: e.non_null, null_count: e.null_count,
      null_fraction: frac(e.null_count, e.row_count), applies: eventScoped ? (e.non_null || 0) > 0 : true,
    }));
    const carries = eventScoped ? coverage.filter((e) => e.applies).map((e) => e.event_name) : [];
    const recs = [];
    if (nulls.null_count != null && nulls.row_count) recs.push(`${nulls.null_count} of ${nulls.row_count} rows are NULL (${nulls.null_fraction != null ? Math.round(nulls.null_fraction * 100) : '?'}%)${carries.length ? `; observed to carry data on event(s): ${carries.join(', ')}` : ''}.`);
    if (eventScoped && carries.length && carries.length < coverage.length) recs.push(`NULLs on the other events are expected — '${key}' is populated only on ${carries.join(', ')} (derived from the indexed data, not a declared list).`);
    return { nulls, coverage, recs };
  }

  /** Per-sync indexing history of one key: { runs, avg_ms, history } (most recent first). */
  history(source, key, recent = 10) {
    const history = this.valueIndex.propertyHistory(source, key, { limit: recent }).map((r) => ({ run_id: r.run_id, started_at: r.started_at, ...this.propertyRow(r) }));
    const timed = history.filter((r) => r.ms != null);
    return { runs: history.length, avg_ms: timed.length ? Math.round(timed.reduce((s, r) => s + r.ms, 0) / timed.length) : null, history };
  }

  /** semantic_index({ request: { run } }): per-property breakdown within one sync run (slowest first). */
  run(input) {
    const run = this.valueIndex.runById(input.run);
    if (!run) throw new ToolError(`unknown index run '${input.run}'. See semantic_index({ request: { status: true } }).value_index.recent_runs[].id`, { stage: 'validate', field: 'run' });
    const props = this.valueIndex.runProperties(input.run).map((r) => this.propertyRow(r));
    const fallbacks = (this.valueIndex.runNotes ? this.valueIndex.runNotes(run.id) : []).map((n) => n.note);
    return {
      run: { id: run.id, started_at: run.started_at, finished_at: run.finished_at, status: run.status, properties_indexed: run.properties_indexed, values_written: run.values_written, errors: run.errors, duration_ms: (run.finished_at != null && run.started_at != null) ? run.finished_at - run.started_at : null },
      property_count: props.length,
      properties: props,
      // Run-level events: each batch whose combined scan failed, with the FULL raw reason
      // (process-level error incl. timeout/signal + warehouse/dbt stderr/stdout, untruncated)
      // and the fact it fell back to per-property. Empty when every batch combined cleanly.
      // NB: per-property `ms` is only meaningful for properties scanned individually (~0 when batched).
      ...(fallbacks.length ? { fallbacks } : {}),
      recommendations: [
        props.length ? `Slowest: ${props.slice(0, 3).map((p) => `${p.property} (${p.ms}ms)`).join(', ')}. Drill into one across syncs with semantic_index({ request: { source: '${props[0].source || '<source>'}', property: '${props[0].property}' } }).` : `No per-property timing recorded for run ${run.id}.`,
        ...(fallbacks.length ? [`${fallbacks.length} batch(es) fell back to per-property — full reason in fallbacks[].`] : []),
      ],
    };
  }

  /**
   * semantic_index({ request: { status: true } }): operational state — the value-index SYNC state
   * (last/recent refresh runs, coverage counts, whether one is in flight) plus the
   * background QUERY jobs and their statuses. Read-only, cheap; touches no warehouse.
   */
  status(input = {}) {
    const recent = input.recent ?? 10;
    const propRow = (r) => this.propertyRow(r);

    const sync = this.valueIndex.syncStatus ? this.valueIndex.syncStatus({ recent }) : { persisted: false, running: false, indexed_properties: 0, total_values: 0, total_runs: 0, last_run: null, last_successful_run: null, recent_runs: [] };
    const last = sync.last_successful_run || sync.last_run;
    const secsSince = last?.finished_at != null ? Math.round((Date.now() - last.finished_at) / 1000) : null;
    // Preview the slowest properties of the last run; full per-property timing via drill-down.
    const slowest = last?.id != null ? this.valueIndex.runProperties(last.id, { limit: 5 }).map(propRow) : [];
    // Batch-fallback events of the last run (combined scan failed → per-property, FULL reason).
    const fallbacks = (last?.id != null && this.valueIndex.runNotes) ? this.valueIndex.runNotes(last.id).map((n) => n.note) : [];

    const jobs = this.jobs.list(); // [{ task_id, tool, status, table, context_id, age_ms }]
    const running = jobs.filter((j) => j.status === 'running');
    const byStatus = jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});

    const recommendations = [];
    if (sync.running) recommendations.push(`A value-index refresh is in progress — values/cardinality in semantic_index may still be filling in.`);
    else if (sync.total_runs === 0) recommendations.push(`The value index has not run yet — semantic_index({ request: { source, property } }) will show no sample_values until the first sync (it runs in the background at startup).`);
    else if (last?.status === 'error') recommendations.push(`The last value-index sync FAILED (${last.error || 'unknown error'}); sample_values may be stale or empty. Check the data source.`);
    else if (secsSince != null) recommendations.push(`Value index is ${sync.indexed_properties} properties / ${sync.total_values} values, last synced ${secsSince}s ago. Inspect a property's values via semantic_index({ request: { source, property } }).`);
    if (running.length) recommendations.push(`${running.length} task(s) running — read one with its side's query tool — query_semantic_model({ request: { task_ids } }) or query_pipeline_model({ request: { task_ids } }); it waits for the task. semantic_index({ request: { status } }) lists them.`);
    if (slowest.length && last?.id != null) recommendations.push(`Per-property timing: semantic_index({ request: { run: ${last.id} } }) for the full breakdown, or semantic_index({ request: { source: '${slowest[0].source}', property: '${slowest[0].property}' } }) for one property across syncs.`);
    if (fallbacks.length) recommendations.push(`${fallbacks.length} batch(es) fell back to per-property — combined scan failed. Full reason in value_index.last_run_fallbacks[] (also semantic_index({ request: { run: ${last.id} } }).fallbacks).`);
    if (!recommendations.length) recommendations.push(`No running tasks and the value index is idle/current.`);

    return {
      value_index: {
        persisted: sync.persisted,
        running: sync.running,
        indexed_properties: sync.indexed_properties,
        total_values: sync.total_values,
        total_runs: sync.total_runs,
        seconds_since_last_sync: secsSince,
        last_run: sync.last_run,
        last_successful_run: sync.last_successful_run,
        slowest_properties: slowest,
        ...(fallbacks.length ? { last_run_fallbacks: fallbacks } : {}),
        recent_runs: sync.recent_runs,
      },
      tasks: {
        total: jobs.length,
        by_status: byStatus,
        running,
        recent: jobs.slice(0, recent),
      },
      recommendations,
    };
  }
}

