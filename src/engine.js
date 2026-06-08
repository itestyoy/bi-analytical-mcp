// Tool engine: validates inputs against catalog-derived schemas, compiles
// declarations, renders YAML, drives dbt/mf within isolated contexts.

import { buildSchemas } from './schema.js';
import { makeValidators, validateInput, ToolError } from './validate.js';
import { twoProportionZTest, welchTTest, cupedTest, ratioDeltaTest, srmTest, adjustPValues, sampleSizeProportion, mdeProportion, sampleSizeMean, mdeMean } from './stats.js';
import { compileDeclaration } from './compile.js';
import { renderContext } from './yaml-render.js';
import { ContextManager, mergeCompiled } from './context-manager.js';
import { renderWhereClauses } from './predicate.js';
import { formatDbtError } from './dbt-runner.js';
import { dateEndExclusive } from './match-recognize.js'; // registers the match_recognize pipeline stage
import { sqlLiteral } from './dialect.js';
import { renderPipeline } from './pipeline.js';
import { JobManager } from './jobs.js';
import { ValueIndex } from './value-index.js';
import { openStore } from './store.js';
import { buildProjection } from './projection.js';
import { sqlConfigHeader } from './sql-header.js';

export class Engine {
  constructor({ catalog, contextManager, runner, recipes, sqlRunner, queryTimeoutMs, dbPath, store, resetDb = false }) {
    this.catalog = catalog;
    this.recipes = recipes; // optional Recipes instance
    this.sqlRunner = sqlRunner; // optional async (sql) => { columns, rows } — for match_recognize
    // ONE shared store (single db file) for the job registry + value index. resetDb wipes
    // it on open (MCP_DB_RESET) before the managers read it.
    this.store = store || openStore({ dbPath, reset: resetDb });
    this._ownsStore = !store;
    this.jobs = new JobManager({ store: this.store }); // persisted if the store is
    this.valueIndex = new ValueIndex({ store: this.store }); // real event-property values (background-populated)
    this.queryTimeoutMs = queryTimeoutMs ?? 60000; // materialize -> background after this
    this.schemas = buildSchemas(catalog);
    if (recipes) {
      this.schemas.list_recipes = { type: 'object', additionalProperties: false, properties: {} };
      this.schemas.get_recipe = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', enum: recipes.ids() } } };
    }
    this.validators = makeValidators(this.schemas);
    this.ctxs = contextManager || new ContextManager({});
    this.runner = runner; // optional; required for non-dry_run parse/query
  }

  list_recipes() {
    if (!this.recipes) return { recipes: [] };
    return { recipes: this.recipes.summary() };
  }

  get_recipe(input) {
    this._validate('get_recipe', input);
    return this.recipes.get(input.id);
  }

  _validate(tool, input) {
    const res = validateInput(this.validators[tool], input || {});
    if (!res.ok) throw new ToolError(`invalid input: ${res.errors.join('; ')}`, { stage: 'validate' });
  }

  /** Map of task-local dimension name -> entity-qualified path (e.g. event__mon_product_id). */
  _taskDimMap(ctx) {
    const map = new Map();
    for (const [modelKey, add] of Object.entries(ctx.state.additions || {})) {
      const pe = this.catalog.primaryEntityName(modelKey);
      for (const d of add.dimensions || []) map.set(d.name, pe ? `${pe}__${d.name}` : d.name);
    }
    return map;
  }

  /** All group-by/where dimension paths allowed for a context (bare + qualified). */
  _allowedPaths(ctx) {
    const set = new Set(this.catalog.reachableGroupByPaths());
    for (const [bare, qualified] of this._taskDimMap(ctx)) { set.add(bare); set.add(qualified); }
    return set;
  }

  /** Resolve a bare task-dim name to its entity-qualified MetricFlow path. */
  _resolvePath(ctx, path) {
    return this._taskDimMap(ctx).get(path) || path;
  }

  /**
   * Progressive catalog discovery. The events fact carries ~150 event-scoped
   * properties, so dumping everything at once is wasteful. Call with NO arguments
   * for a compact OVERVIEW, then drill down:
   *   { model }    → one model's entities/time/dimensions + REAL physical columns
   *   { event }    → only the properties POPULATED on that event (what you can use)
   *   { property } → one property's full spec (type, applicable events, description)
   *   { search }   → events/properties whose name/description matches a substring
   * Pass at most one drill-down key (precedence model > event > property > search).
   */
  async describe_catalog(input = {}) {
    this._validate('describe_catalog', input);
    const c = this.catalog;
    const AGG = ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'];

    // ── { model }: one model in depth (incl. live warehouse introspection) ──
    if (input.model) {
      const k = input.model;
      if (!c.models[k]) throw new ToolError(`unknown model '${k}'. Known models: ${c.modelKeys().join(', ')}`, { stage: 'validate', field: 'model' });
      const m = c.getModel(k);
      const descs = c.columnDescriptions(k);
      const out = { key: k, role: m.role, dbt_model: m.dbt_model, description: m.description, primary_entity: c.primaryEntityName(k), entities: m.entities, time: m.time?.column, measures: Object.keys(m.measures || {}) };
      // Columns referenceable in a native pipeline over this source (where/compute/
      // group_by/order_by), with their types — `time` above is the default order axis
      // for window/match_recognize stages.
      out.pipeline_columns = c.modelColumns(k);
      if (k === c.anchor) {
        out.event_count = c.eventNames().length;
        out.property_count = c.eventProps().length;
        out.note = 'Events fact: payload fields are event-scoped properties (describe_catalog({ event })). The columns above are referenceable in a native pipeline; order windows/match_recognize by `time` (' + (m.time?.column || '?') + ').';
      } else {
        const dims = m.dimensions || {};
        out.dimensions = Object.keys(dims).map((d) => ({ name: d, type: dims[d].type, description: descs[d] }));
      }
      const base = this.ctxs.baseProjectDir;
      if (this.runner && base) {
        const cols = await this.runner.relationColumns(base, m.dbt_model);
        out.physical_columns = cols.ok ? cols.columns.map((col) => (descs[col.name] ? { ...col, description: descs[col.name] } : col)) : null;
        if (!cols.ok) out.physical_columns_error = 'physical columns unavailable — the underlying table is not built yet';
      }
      out.recommendations = k === c.anchor
        ? [
          `Drill into an event to see the properties it carries: describe_catalog({ event: '${c.eventNames()[0] || '<event_name>'}' }).`,
          `Then inspect a property's real values + frequency distribution: describe_catalog({ property: '<name>' }).`,
          `Recognise a value (an ad format, a status, ...)? Trace which property/event carries it: describe_catalog({ search: '<value>' }).`,
        ]
        : [
          `This model's attributes are listed above; explore the events fact to see what they can describe: describe_catalog({ event: '${c.eventNames()[0] || '<event_name>'}' }).`,
          `Looking for a known attribute value? describe_catalog({ search: '<value>' }) tells you where it occurs.`,
        ];
      return out;
    }

    // ── { event }: the properties populated on this event (NULL on others) ──
    if (input.event) {
      if (!c.eventNames().includes(input.event)) throw new ToolError(`unknown event '${input.event}'. See describe_catalog().event_names`, { stage: 'validate', field: 'event' });
      const numeric = new Set(c.eventNumericProps());
      const applies = c.eventPropertyEvents();
      const descs = c.eventPropertyDescriptions();
      const props = c.eventProps().filter((p) => { const evs = applies[p]; return !evs || evs.includes(input.event); });
      const rows = props.map((p) => {
        // Compact index hint: cardinality + the top 3 real values (null/[] until indexed).
        const st = this.valueIndex.stats(p);
        return { name: p, type: c.eventPropertySpec(p)?.type, numeric: numeric.has(p), complex: c.isComplexEventProp(p), description: descs[p], distinct_count: st?.distinctCount ?? null, sample_values: this.valueIndex.sampleValues(p, 3) };
      });
      // Drill-down guidance: point at properties whose real values are worth inspecting
      // next (prefer ones already indexed so the AI sees data), plus value search.
      const recommendations = [];
      const withValues = rows.filter((r) => !r.complex && r.sample_values.length);
      const pick = (withValues.length ? withValues : rows.filter((r) => !r.complex)).slice(0, 3);
      if (pick.length) recommendations.push(`Drill into a property's real values + full frequency distribution: ${pick.map((r) => `describe_catalog({ property: '${r.name}' })`).join(', ')}.`);
      if (withValues.length) recommendations.push(`Spot a value you recognise in the samples above? Find every property/event it occurs in: describe_catalog({ search: '<value>' }).`);
      if (rows.some((r) => r.complex)) recommendations.push(`Complex (array/struct) properties carry nested values — describe_catalog({ property }) shows the shape before you explore inside them.`);
      if (!recommendations.length) recommendations.push(`Inspect any property's real values with describe_catalog({ property }).`);
      return {
        event: input.event,
        property_count: props.length,
        properties: rows,
        recommendations: recommendations.slice(0, 4),
      };
    }

    // ── { property }: one property's full spec ──
    if (input.property) {
      const spec = c.eventPropertySpec(input.property);
      if (!spec) throw new ToolError(`unknown event property '${input.property}'. Discover properties via describe_catalog({ event }) or ({ search })`, { stage: 'validate', field: 'property' });
      const st = this.valueIndex.stats(input.property);
      const numeric = c.eventNumericProps().includes(input.property);
      const complex = c.isComplexEventProp(input.property);
      const dc = st?.distinctCount ?? null;
      const total = st?.totalCount ?? null;
      const evs = (spec.events && spec.events.length) ? spec.events : null;
      // Pageable/orderable view of the real indexed VALUES (limit/offset/order_by/direction).
      const orderBy = input.order_by === 'value' ? 'value' : 'freq';
      const dir = (input.direction === 'asc' || input.direction === 'desc') ? input.direction : (orderBy === 'value' ? 'asc' : 'desc');
      const limit = input.limit ?? 10;
      const offset = input.offset ?? 0;
      // Over-fetch by one so has_more is accurate at the boundary (next page non-empty).
      const fetched = this.valueIndex.listValues(input.property, { limit: limit + 1, offset, by: orderBy, dir });
      const has_more = fetched.length > limit;
      const samples = has_more ? fetched.slice(0, limit) : fetched;
      // Descriptive stats so the AI sees the distribution at a glance. top_value is the
      // single most frequent value; share = its fraction of indexed (non-null) rows.
      const top = this.valueIndex.sampleValues(input.property, 1)[0] || null;
      const value_stats = {
        distinct_count: dc, total_count: total,
        top_value: top ? top.value : null, top_freq: top ? top.freq : null,
        top_share: top && total ? Math.round((top.freq / total) * 1000) / 1000 : null,
        indexed: !!st, indexed_at: st?.indexedAt ?? null,
        // values stored are capped (top-by-frequency); paging past them returns [].
        returned: samples.length, limit, offset, order_by: orderBy, direction: dir,
        has_more,
      };
      // Drill-down guidance: keep exploring the VALUES — trace them across the catalog,
      // and pivot to the event(s) that carry this property (≤3 concrete next moves).
      const recommendations = [];
      if (samples.length) {
        recommendations.push(`${dc != null ? `${dc} distinct values; ` : ''}top: ${samples.slice(0, 5).map((s) => `'${s.value}' (${s.freq})`).join(', ')}.`);
        if (value_stats.has_more) recommendations.push(`More values exist — page with describe_catalog({ property: '${input.property}', offset: ${offset + limit} }), or re-order with order_by:'value'.`);
        recommendations.push(`Trace any of these values across the catalog (which other properties/events carry it): describe_catalog({ search: '<value>' }).`);
      } else if (complex) {
        recommendations.push(`Complex (${spec.type}) property — its values are nested; explore the carrying event(s) for context.`);
      } else {
        recommendations.push(`No values indexed yet (the background value index may not have run).${dc != null ? ` distinct_count is ${dc}.` : ''}`);
      }
      if (evs) recommendations.push(`Carried by event(s) ${evs.join(', ')} — see everything they carry: describe_catalog({ event: '${evs[0]}' }).`);
      return { property: input.property, type: spec.type, numeric, complex, events: spec.events || null, description: spec.description, sample_values: samples, distinct_count: dc, total_count: total, indexed: !!st, value_stats, recommendations: recommendations.slice(0, 3) };
    }

    // ── { search }: find events/properties by substring ──
    if (input.search) {
      const q = String(input.search).toLowerCase();
      const descs = c.eventPropertyDescriptions();
      const applies = c.eventPropertyEvents(); // property -> [event_name]; absent ⇒ all events
      // EVENT-name matches: keep the name + how many properties that event carries.
      const event_names = c.eventNames().filter((e) => e.toLowerCase().includes(q)).map((e) => {
        const n = c.eventProps().filter((p) => { const evs = applies[p]; return !evs || evs.includes(e); }).length;
        return { event: e, property_count: n };
      });
      // PROPERTY-name matches: the property's type + the events it applies to.
      const property_matches = c.eventProps()
        .filter((p) => p.toLowerCase().includes(q) || (descs[p] || '').toLowerCase().includes(q))
        .map((p) => ({ property: p, type: c.eventPropertySpec(p)?.type ?? null, events: applies[p] || null }));
      // VALUE matches: the matched value + WHERE it lives — its property, that property's
      // type, and the event(s) carrying it (null ⇒ all events). So "rewarded" resolves to
      // property 'ad_type_of_event_data', carried by events ['ad_started','ad_finished'].
      const value_matches = this.valueIndex.searchValues(input.search, input.limit ?? 20).map((v) => ({
        value: v.value,
        freq: v.freq,
        property: v.property,
        type: c.eventPropertySpec(v.property)?.type ?? null,
        events: applies[v.property] || null,
      }));
      // Drill-down guidance: from a match, keep descending — full value distribution of
      // the property, and the event(s) that carry it (concrete next moves, ≤4).
      const recommendations = [];
      if (value_matches.length) {
        const top = value_matches[0];
        recommendations.push(`Value '${top.value}' lives in property '${top.property}'${top.events ? ` (events: ${top.events.join(', ')})` : ''} — see its full value/frequency distribution: describe_catalog({ property: '${top.property}' }).`);
        if (top.events?.[0]) recommendations.push(`See everything event '${top.events[0]}' carries: describe_catalog({ event: '${top.events[0]}' }).`);
      }
      if (property_matches.length) {
        const p = property_matches[0];
        recommendations.push(`Drill into property '${p.property}' for its real values + cardinality: describe_catalog({ property: '${p.property}' }).`);
      }
      if (event_names.length) recommendations.push(`See what event '${event_names[0].event}' carries: describe_catalog({ event: '${event_names[0].event}' }).`);
      if (!recommendations.length) recommendations.push(`No catalog match for '${input.search}'. Try describe_catalog() for the event list, or a broader substring.`);
      return {
        query: input.search,
        event_names,
        property_matches,
        value_matches,
        recommendations: recommendations.slice(0, 4),
      };
    }

    // ── default: compact OVERVIEW (no per-property dump, no warehouse calls) ──
    const models = c.modelKeys().map((k) => {
      const m = c.getModel(k);
      const head = { key: k, role: m.role, dbt_model: m.dbt_model, description: m.description };
      if (k === c.anchor) return { ...head, kind: 'events_fact', entities: Object.keys(m.entities || {}), time: m.time?.column, event_count: c.eventNames().length, property_count: c.eventProps().length };
      return { ...head, kind: 'dimension', dimension_count: Object.keys(m.dimensions || {}).length };
    });
    const exEvent = c.eventNames()[0];
    return {
      dialect: c.dialect,
      models,
      event_names: c.eventNames(),
      groupable_paths: c.reachableGroupByPaths(),
      enums: { agg: AGG, metric_type: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'], time_granularity: c.timeGranularities() },
      next: 'Overview only. Drill down: describe_catalog({ model }) for a model\'s columns + real physical columns; ({ event }) for the properties an event carries (the events fact has ~150 properties, scoped per event); ({ property }) for one property\'s spec; ({ search }) to find events/properties by substring.',
      recommendations: [
        `Start by inspecting an event's properties: describe_catalog({ event: '${exEvent || '<event_name>'}' }) — it lists each property with its real sample values + cardinality.`,
        `Then drill into a property's full value/frequency distribution: describe_catalog({ property: '<name>' }).`,
        `Looking for a known value (e.g. an ad format or status)? describe_catalog({ search: '<value>' }) tells you which property and event(s) carry it.`,
      ],
    };
  }

  /**
   * Operational state, the describe_catalog way: the value-index SYNC state (last/recent
   * refresh runs, coverage counts, whether one is in flight) plus the background QUERY
   * jobs and their statuses. Read-only, cheap (SQLite reads); touches no warehouse.
   */
  describe_index(input = {}) {
    this._validate('describe_index', input);
    const recent = input.recent ?? 10;
    const propRow = (r) => ({ property: r.property, ms: r.ms, values: r.values_written, distinct_count: r.distinct_count, total_count: r.total_count, status: r.status, ...(r.error ? { error: r.error } : {}) });

    // ── drill-down: one property's per-sync timing history ──
    if (input.property) {
      const hist = this.valueIndex.propertyHistory(input.property, { limit: recent }).map((r) => ({ run_id: r.run_id, started_at: r.started_at, ...propRow(r) }));
      const timed = hist.filter((r) => r.ms != null);
      const avg = timed.length ? Math.round(timed.reduce((s, r) => s + r.ms, 0) / timed.length) : null;
      return {
        property: input.property, runs: hist.length, avg_ms: avg, history: hist,
        recommendations: [hist.length ? `'${input.property}' took ${hist[0].ms}ms in the latest sync (${hist[0].values} values, ${hist[0].distinct_count} distinct); avg ${avg}ms over ${timed.length} runs.` : `No per-property timing recorded for '${input.property}' yet.`],
      };
    }

    // ── drill-down: per-property breakdown within one sync run (slowest first) ──
    if (input.run != null) {
      const run = this.valueIndex.runById(input.run);
      if (!run) throw new ToolError(`unknown index run '${input.run}'. See describe_index().value_index.recent_runs[].id`, { stage: 'validate', field: 'run' });
      const props = this.valueIndex.runProperties(input.run).map(propRow);
      return {
        run: { id: run.id, started_at: run.started_at, finished_at: run.finished_at, status: run.status, properties_indexed: run.properties_indexed, values_written: run.values_written, errors: run.errors, duration_ms: (run.finished_at != null && run.started_at != null) ? run.finished_at - run.started_at : null },
        property_count: props.length,
        properties: props,
        recommendations: [props.length ? `Slowest: ${props.slice(0, 3).map((p) => `${p.property} (${p.ms}ms)`).join(', ')}. Drill into one across syncs with describe_index({ property: '${props[0].property}' }).` : `No per-property timing recorded for run ${run.id}.`],
      };
    }

    const sync = this.valueIndex.syncStatus ? this.valueIndex.syncStatus({ recent }) : { persisted: false, running: false, indexed_properties: 0, total_values: 0, total_runs: 0, last_run: null, last_successful_run: null, recent_runs: [] };
    const last = sync.last_successful_run || sync.last_run;
    const secsSince = last?.finished_at != null ? Math.round((Date.now() - last.finished_at) / 1000) : null;
    // Preview the slowest properties of the last run; full per-property timing via drill-down.
    const slowest = last?.id != null ? this.valueIndex.runProperties(last.id, { limit: 5 }).map(propRow) : [];

    const jobs = this.jobs.list(); // [{ query_id, status, table, context_id, age_ms }]
    const running = jobs.filter((j) => j.status === 'running');
    const byStatus = jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});

    const recommendations = [];
    if (sync.running) recommendations.push(`A value-index refresh is in progress — values/cardinality in describe_catalog may still be filling in.`);
    else if (sync.total_runs === 0) recommendations.push(`The value index has not run yet — describe_catalog({ property }) will show no sample_values until the first sync (it runs in the background at startup).`);
    else if (last?.status === 'error') recommendations.push(`The last value-index sync FAILED (${last.error || 'unknown error'}); sample_values may be stale or empty. Check the warehouse/runner.`);
    else if (secsSince != null) recommendations.push(`Value index is ${sync.indexed_properties} properties / ${sync.total_values} values, last synced ${secsSince}s ago. Inspect a property's values via describe_catalog({ property }).`);
    if (running.length) recommendations.push(`${running.length} query job(s) running — poll with get_query_result({ query_id }) or list them with list_query_jobs.`);
    if (slowest.length && last?.id != null) recommendations.push(`Per-property timing: describe_index({ run: ${last.id} }) for the full breakdown, or describe_index({ property: '${slowest[0].property}' }) for one property across syncs.`);
    if (!recommendations.length) recommendations.push(`No active jobs and the value index is idle/current.`);

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
        recent_runs: sync.recent_runs,
      },
      query_jobs: {
        total: jobs.length,
        by_status: byStatus,
        running,
        recent: jobs.slice(0, recent),
      },
      recommendations,
    };
  }

  /** Compile, converting bad-reference errors into a clearly-staged ToolError. */
  _compile(input) {
    try {
      return compileDeclaration(this.catalog, input);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(e.message, { stage: 'compile' });
    }
  }

  /** Check that a group-by/where path's entity hops map to models loaded in the context. */
  _checkPathLoaded(ctx, path) {
    if (typeof path !== 'string' || !path.includes('__')) return; // local task dim or metric_time
    const segs = path.split('__');
    for (const entity of segs.slice(0, -1)) {
      const model = this.catalog.primaryByEntity[entity];
      if (!model) continue; // already pruned/validated elsewhere
      if (model === this.catalog.anchor) continue;
      if (!ctx.state.usedModels.includes(model)) {
        throw new ToolError(
          `path '${path}' needs model '${model}', which is not loaded in this context. ` +
            `Recreate/update the task with use_base_models including '${model}'.`,
          { stage: 'validate', field: path },
        );
      }
    }
  }

  /**
   * Register a derived dbt model from a declarative PIPELINE (source + ordered
   * stages, optionally ending in a match_recognize funnel). The pipeline's rows
   * ARE the result. Funnels are just pipelines: match_recognize is a stage, and
   * downstream join/aggregate slice it by user attributes — no separate engine.
   */
  async register_native_model(input) {
    this._validate('register_native_model', input);
    return this._registerPipeline(input);
  }

  /**
   * Compose a native pipeline INCREMENTALLY (single tool, `action`-driven). Each
   * add_step validates the stage and returns the columns now available for the next
   * stage — pure schema propagation via renderPipeline, NO warehouse hit until commit.
   * The all-at-once register_native_model path is unchanged. Lifecycle:
   * start → add_step* → (preview) → commit | discard.
   */
  async build_native_model(input) {
    this._validate('build_native_model', input);
    if (input.action === 'start') return this._draftStart(input);
    const ctx = this.ctxs.get(input.draft_id);
    const draft = ctx.state.draft;
    if (!draft) throw new ToolError(`no draft in context '${input.draft_id}' — start one with build_native_model({ action: 'start', name })`, { stage: 'validate', field: 'draft_id' });
    this.ctxs.touch(ctx.id);
    if (input.action === 'add_step') return this._draftAddStep(ctx, draft, input.stage, input.include_columns);
    if (input.action === 'preview') return this._draftPreview(ctx, draft);
    if (input.action === 'discard') { delete ctx.state.draft; return { draft_id: ctx.id, action: 'discard', discarded: true }; }
    return this._draftCommit(ctx, draft); // commit
  }

  /** Columns available after a draft's accumulated stages (source columns when empty). */
  _draftColumns(draft) {
    if (!draft.stages.length) return this.catalog.modelColumns(draft.source);
    const { columns } = renderPipeline(this.catalog, this.catalog.dialect, draft.source, draft.stages);
    return [...columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }));
  }

  /** Accumulated stages with the draft's time_range prepended as a leading WHERE (parity with commit). */
  _draftEffectiveStages(draft) {
    const tr = draft.time_range;
    if (!tr || !(tr.start || tr.end)) return draft.stages;
    const timeCol = this.catalog.getModel(draft.source).time?.column;
    if (!timeCol) return draft.stages;
    const conditions = [];
    if (tr.start) conditions.push({ column: timeCol, op: 'gte', value: tr.start });
    if (tr.end) { const ex = dateEndExclusive(tr.end); conditions.push(ex ? { column: timeCol, op: 'lt', value: ex } : { column: timeCol, op: 'lte', value: tr.end }); }
    return [{ stage: 'where', conditions }, ...draft.stages];
  }

  _draftSteps(draft) {
    return draft.stages.map((s, i) => ({ index: i + 1, ...s }));
  }

  _draftStart(input) {
    const ctx = input.draft_id ? this.ctxs.get(input.draft_id) : this.ctxs.create();
    const source = input.source || this.catalog.anchor;
    ctx.state.draft = { name: input.name, source, materialized: input.materialized || 'table', time_range: input.time_range || null, stages: [] };
    this.ctxs.touch(ctx.id);
    const cols = this.catalog.modelColumns(source);
    const resp = {
      draft_id: ctx.id, action: 'start', name: input.name, source, materialized: ctx.state.draft.materialized,
      steps: [], column_count: cols.length,
      next: 'Append stages one at a time with build_native_model({ action: "add_step", draft_id, stage }); each response shows only the columns that stage added/removed (use include_columns:true or preview for the full list).',
      recommendations: [
        `The source has ${cols.length} columns your first stage can reference; get the full list with build_native_model({ action: "start", ..., include_columns: true }) or inspect via describe_catalog({ model: '${source}' }).`,
        `For an ordered funnel/path, add a match_recognize stage; for a plain transform, start with where/derive then aggregate.`,
        `When the steps look right, commit with build_native_model({ action: "commit", draft_id }).`,
      ],
    };
    if (input.include_columns) resp.available_columns = cols;
    return resp;
  }

  async _draftAddStep(ctx, draft, stage, includeColumns = false) {
    const before = this._draftColumns(draft); // columns BEFORE this stage
    const trial = [...draft.stages, stage];
    try {
      renderPipeline(this.catalog, this.catalog.dialect, draft.source, trial); // validates refs/stage against current columns (no warehouse)
    } catch (e) {
      // Reject the step WITHOUT persisting it; the draft is left intact to retry.
      throw new ToolError(e.message, { stage: 'compile', field: 'stage' });
    }
    draft.stages = trial;
    this.ctxs.touch(ctx.id);
    const after = this._draftColumns(draft);
    // Default to a DIFF (what this stage added/removed) instead of dumping the whole
    // schema every step — the full list is noise after the first call. Pass
    // include_columns:true (or use preview) for the complete set.
    const beforeNames = new Set(before.map((c) => c.name));
    const afterNames = new Set(after.map((c) => c.name));
    const resp = {
      draft_id: ctx.id, action: 'add_step', step_index: draft.stages.length,
      steps: this._draftSteps(draft),
      column_count: after.length,
      columns_added: after.filter((c) => !beforeNames.has(c.name)),
      columns_removed: before.filter((c) => !afterNames.has(c.name)).map((c) => c.name),
      next: 'add_step the next stage, commit the draft, or pass include_columns:true / preview for the full column list.',
      recommendations: this._draftStepRecommendations(stage, after),
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  }

  /** Stage-aware next-step hints from the just-added stage + the resulting columns. */
  _draftStepRecommendations(stage, available) {
    const recs = [];
    if (stage.stage === 'match_recognize') {
      recs.push(`The funnel columns (reached_<step>, completed, furthest_step_name, secs_<metric>) plus the carried partition key(s) are now available — join 'users' or aggregate to slice conversion (e.g. by country).`);
    } else if (stage.stage === 'aggregate') {
      recs.push(`Aggregated: the output is now group_by keys + measures (${available.slice(0, 6).map((c) => c.name).join(', ')}${available.length > 6 ? ', …' : ''}); add order_by/limit or commit.`);
    } else if (stage.stage === 'join') {
      recs.push(`Joined columns are now referenceable; add a where to filter on them or an aggregate to roll up.`);
    } else {
      recs.push(`Reference any of available_columns in the next stage (${available.slice(0, 6).map((c) => c.name).join(', ')}${available.length > 6 ? ', …' : ''}).`);
    }
    recs.push(`Preview the SQL anytime with build_native_model({ action: "preview", draft_id }); commit when done.`);
    return recs;
  }

  _draftPreview(ctx, draft) {
    const dialect = this.catalog.dialect;
    const base = { draft_id: ctx.id, action: 'preview', name: draft.name, source: draft.source, materialized: draft.materialized, dialect, steps: this._draftSteps(draft) };
    if (!draft.stages.length) return { ...base, available_columns: this.catalog.modelColumns(draft.source), note: 'No stages yet — add_step first.' };
    const stages = this._draftEffectiveStages(draft);
    // Render ONLY the active warehouse dialect, so every response is consistent with where
    // the pipeline actually runs (bigquery → `|>`, postgres → CTEs).
    const rendered = renderPipeline(this.catalog, dialect, draft.source, stages);
    return { ...base, available_columns: [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })), model_sql: rendered.sql };
  }

  async _draftCommit(ctx, draft) {
    if (!draft.stages.length) throw new ToolError('draft has no stages to commit — add_step at least one stage first', { stage: 'validate', field: 'draft_id' });
    const result = await this._registerPipeline({
      name: draft.name, context_id: ctx.id, materialized: draft.materialized,
      pipeline: { source: draft.source, time_range: draft.time_range || undefined, stages: draft.stages },
    });
    delete ctx.state.draft; // committed — clear the draft so the context holds only the built model
    return result;
  }

  /**
   * Register (or rebuild) a general transformation PIPELINE as a dbt model.
   * The pipeline's rows ARE the result: we materialize, build, and read them back.
   * Re-readable/sliceable later via get_query_result(table, transform).
   */
  async _registerPipeline(input) {
    const dialect = this.catalog.dialect;
    const source = input.pipeline.source || this.catalog.anchor;
    // A pipeline-level time_range is applied as a leading WHERE on the source's time
    // column — one place to bound the window (parity with query_semantic_model).
    let stages = input.pipeline.stages;
    const tr = input.pipeline.time_range;
    if (tr && (tr.start || tr.end)) {
      const timeCol = this.catalog.getModel(source).time?.column;
      if (!timeCol) throw new ToolError(`time_range given but source '${source}' has no time column`, { stage: 'validate', field: 'time_range' });
      const conditions = [];
      if (tr.start) conditions.push({ column: timeCol, op: 'gte', value: tr.start });
      if (tr.end) { const ex = dateEndExclusive(tr.end); conditions.push(ex ? { column: timeCol, op: 'lt', value: ex } : { column: timeCol, op: 'lte', value: tr.end }); }
      stages = [{ stage: 'where', conditions }, ...stages];
    }
    // Render ONLY the active warehouse dialect — every response is in the dialect the
    // pipeline actually runs on, never a mix.
    const render = () => renderPipeline(this.catalog, dialect, source, stages);
    if (input.dry_run) {
      const out = render();
      const resp = {
        kind: 'pipeline', dry_run: true, model: `pipe_${input.name}`, materialized: input.materialized || 'table', dialect,
        columns: [...out.columns.keys()],
        output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
        model_sql: out.sql,
      };
      // A5: cheap volume estimate — COUNT(*) over the SOURCE within the window only
      // (no full materialize). Lets the caller size the scan before committing.
      const est = await this._estimateSourceRows(source, tr);
      if (est != null) resp.estimated_source_rows = est;
      return resp;
    }
    const ctx = input.context_id ? this.ctxs.get(input.context_id) : this.ctxs.create();
    const modelName = `pipe_${input.name}_${ctx.id}`;
    const out = render();
    const materialized = input.materialized || 'table';
    const header = sqlConfigHeader('pipeline_model', { name: input.name, pipeline: input.pipeline });
    this.ctxs.writeModel(ctx.id, modelName, `{{ config(materialized='${materialized}') }}\n${header}${out.sql}\n`);
    ctx.state.engine = 'pipeline';
    ctx.state.model = modelName;
    ctx.state.native = { model: modelName, materialized, kind: 'pipeline', columns: [...out.columns.keys()] };
    if (!ctx.state.tasks?.includes(input.name)) (ctx.state.tasks ||= []).push(input.name);
    this.ctxs.touch(ctx.id);
    // Honest status: `executed` makes it unambiguous whether the model was actually built
    // and run, vs only written to disk (no runner). `ok` stays for backward-compatible checks.
    let build = { ok: true, executed: false, reason: 'no runner configured — model written but not built/executed (dry/unit mode)' };
    let rows = []; let columns = [...out.columns.keys()];
    if (this.runner) {
      const r = await this.runner.run(this.ctxs.dir(ctx.id), modelName);
      if (!r.ok) return { context_id: ctx.id, kind: 'pipeline', ok: false, error: { stage: 'run', message: formatDbtError(r.stdout, r.stderr) } };
      const show = await this.runner.show(this.ctxs.dir(ctx.id), `SELECT * FROM {{ ref('${modelName}') }}`, 200);
      if (show.ok) { rows = show.rows; columns = show.columns || columns; }
      else return { context_id: ctx.id, kind: 'pipeline', ok: false, error: { stage: 'show', message: formatDbtError(show.stdout, show.stderr) } };
      build = { ok: true, executed: true };
    }
    return {
      context_id: ctx.id, kind: 'pipeline', model: modelName, materialized, dialect,
      columns, output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
      row_count: rows.length, rows, model_sql: out.sql, build,
      // A4: how to read this result again — these rows are a pipeline model, re-read
      // with get_query_result (NOT query_semantic_model, which is for metric queries).
      read_with: { tool: 'get_query_result', table: modelName, note: 'optional transform to re-slice; use query_semantic_model only for metric/semantic-layer queries, not for this pipeline model.' },
      assumptions: [
        `Pipeline materialized as a ${materialized} model (${modelName}); its rows are the result.`,
        `Re-read or re-slice it with get_query_result (table: ${modelName}, optional transform).`,
      ],
      warnings: (this.runner && tr && (tr.start || tr.end) && rows.length === 0)
        ? ['time_range produced 0 rows — verify the window. A date-only `end` is treated as inclusive (the whole day, next-day-exclusive); pass a full datetime for finer bounds.']
        : [],
    };
  }

  /**
   * A5: a cheap pre-run volume estimate — COUNT(*) over a source model within an
   * optional time window (the same window the pipeline will apply). Lets the caller
   * gauge the scan before materializing. Best-effort: returns null when there is no
   * runner / base project, or the count fails.
   */
  async _estimateSourceRows(sourceKey, tr) {
    const base = this.ctxs.baseProjectDir;
    if (!this.runner || !base) return null;
    const m = this.catalog.getModel(sourceKey);
    const tcol = m.time?.column;
    let where = '';
    if (tr && (tr.start || tr.end) && tcol) {
      const cl = [];
      if (tr.start) cl.push(`${tcol} >= ${sqlLiteral(tr.start)}`);
      if (tr.end) { const ex = dateEndExclusive(tr.end); cl.push(ex ? `${tcol} < ${sqlLiteral(ex)}` : `${tcol} <= ${sqlLiteral(tr.end)}`); }
      if (cl.length) where = ` WHERE ${cl.join(' AND ')}`;
    }
    try {
      const r = await this.runner.show(base, `SELECT COUNT(*) AS n FROM {{ ref('${m.dbt_model}') }}${where}`, 1);
      if (r.ok && r.rows?.[0]) return Number(r.rows[0].n);
    } catch { /* estimate is best-effort */ }
    return null;
  }

  /** Update a registered native model in place (re-generate + rebuild). */
  async update_native_model(input) {
    this._validate('update_native_model', input);
    return this._registerPipeline(input);
  }

  /** Delete a registered native model: remove its files + state and re-parse. */
  async delete_native_model(input) {
    this._validate('delete_native_model', input);
    const ctx = this.ctxs.get(input.context_id);
    if (ctx.state.engine !== 'pipeline') return { context_id: ctx.id, removed: false, reason: 'no native (pipeline) model registered in this context' };
    const model = ctx.state.model;
    this.ctxs.removeGeneratedFile(ctx.id, `${model}.sql`);
    delete ctx.state.engine; delete ctx.state.model; delete ctx.state.native;
    ctx.state.metrics ||= []; ctx.state.additions ||= {}; ctx.state.usedModels ||= []; // core-safe after delete
    this.ctxs.touch(ctx.id);
    const parse = this.runner ? await this.runner.parse(this.ctxs.dir(ctx.id)) : { ok: true, executed: false, reason: 'no runner configured — not parsed (dry/unit mode)' };
    return { context_id: ctx.id, removed: true, model, parse: parse.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(parse.stdout, parse.stderr) } }, note: 'model definition removed; the warehouse view may persist until the context is dropped (drop_context) or the warehouse cleans ephemeral objects' };
  }

  async create_semantic_model(input) {
    this._validate('create_semantic_model', input);
    const compiled = this._compile(input);

    if (input.dry_run) {
      const draft = { tasks: [], additions: {}, metrics: [], usedModels: [] };
      if (input.context_id && this.ctxs.has(input.context_id)) {
        const cur = this.ctxs.get(input.context_id).state;
        mergeCompiled(draft, { additions: clone(cur.additions), metrics: clone(cur.metrics), usedModels: [...cur.usedModels], task: null });
      }
      mergeCompiled(draft, compiled);
      const render = renderContext(this.catalog, draft);
      return { context_id: input.context_id || null, task: compiled.task, dry_run: true, yaml: render.yaml, semantic_models: render.semanticModels, metrics: render.metricNames };
    }

    const ctx = input.context_id ? this.ctxs.get(input.context_id) : this.ctxs.create();
    mergeCompiled(ctx.state, compiled);
    const render = renderContext(this.catalog, ctx.state);
    const file = this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);

    const parse = await this._parse(ctx.id);
    return {
      context_id: ctx.id,
      task: compiled.task,
      files: [file],
      ...(input.include_yaml ? { yaml: render.yaml } : {}),
      semantic_models: render.semanticModels,
      joined_models: ctx.state.usedModels,
      metrics: render.metricNames,
      groupable: [...this._allowedPaths(ctx)],
      parse,
      assumptions: this._assumptions(ctx),
      warnings: [],
    };
  }

  async update_semantic_model(input) {
    this._validate('update_semantic_model', input);
    const ctx = this.ctxs.get(input.context_id);
    const modelKey = input.semantic_model;
    // dry_run must NOT mutate the context (state or files): work on a clone.
    const state = input.dry_run ? clone(ctx.state) : ctx.state;
    const add = (state.additions[modelKey] ||= { measures: [], dimensions: [] });

    // synthesize a declaration fragment for the add_* parts and compile it
    const task = input.task || state.tasks[0] || 'task';
    const frag = { name: task, semantic_models: [{ from: modelKey, dimensions: input.add_dimensions || [], measures: input.add_measures || [] }], metrics: input.add_metrics || [] };
    const compiled = this._compile(frag);

    // removals (with dependency checks for measures)
    if (input.remove_metrics) state.metrics = state.metrics.filter((m) => !input.remove_metrics.includes(m.name));
    if (input.remove_measures) {
      for (const rm of input.remove_measures) {
        const dependents = state.metrics.filter((m) => metricUsesMeasure(m, rm));
        if (dependents.length && !input.cascade) {
          throw new ToolError(`cannot remove measure '${rm}'; metrics depend on it: ${dependents.map((d) => d.name).join(', ')}`, { stage: 'validate', field: rm });
        }
      }
      add.measures = add.measures.filter((m) => !input.remove_measures.includes(m.name));
    }
    if (input.remove_dimensions) add.dimensions = add.dimensions.filter((d) => !input.remove_dimensions.includes(d.name));

    mergeCompiled(state, compiled);
    const render = renderContext(this.catalog, state);
    if (input.dry_run) {
      return { context_id: ctx.id, semantic_model: modelKey, dry_run: true, yaml: render.yaml, metrics: render.metricNames, warnings: [] };
    }
    const file = this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);
    const parse = await this._parse(ctx.id);
    return { context_id: ctx.id, semantic_model: modelKey, files: [file], ...(input.include_yaml ? { yaml: render.yaml } : {}), metrics: render.metricNames, groupable: [...this._allowedPaths(ctx)], parse, warnings: [] };
  }

  async delete_semantic_model(input) {
    this._validate('delete_semantic_model', input);
    const ctx = this.ctxs.get(input.context_id);
    const modelKey = input.semantic_model;
    const add = ctx.state.additions[modelKey];
    if (!add) return { context_id: ctx.id, removed: false, reason: 'no task additions for this model' };
    const taskMeasureNames = new Set(add.measures.map((m) => m.name));
    const dependents = ctx.state.metrics.filter((m) => [...taskMeasureNames].some((mm) => metricUsesMeasure(m, mm)));
    if (dependents.length && !input.cascade) {
      throw new ToolError(`metrics depend on this model's measures: ${dependents.map((d) => d.name).join(', ')}`, { stage: 'validate' });
    }
    ctx.state.metrics = ctx.state.metrics.filter((m) => !dependents.includes(m));
    delete ctx.state.additions[modelKey];
    const render = renderContext(this.catalog, ctx.state);
    this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);
    const parse = await this._parse(ctx.id);
    return { context_id: ctx.id, semantic_model: modelKey, removed: true, metrics: render.metricNames, parse };
  }

  drop_context(input) {
    this._validate('drop_context', input);
    return this.ctxs.drop(input.context_id);
  }

  list_contexts() {
    return { contexts: this.ctxs.list() };
  }

  /**
   * A/B significance test over PRE-AGGREGATED group stats (computed by a pipeline
   * that joins the experiments source, windows events to the assignment period,
   * and aggregates per group). proportion → two-proportion z-test; mean → Welch
   * t-test; ratio → delta-method test for ratio metrics whose analysis unit is
   * finer than the randomization unit; cuped → CUPED variance reduction (needs a
   * pre-experiment covariate) then Welch. Each variant is compared against control,
   * and p-values are corrected across the variant family. Pure stats, no warehouse.
   */
  ab_test(input) {
    this._validate('ab_test', input);
    const { metric, control } = input;
    const confidence = input.confidence ?? 0.95;
    const alternative = input.alternative || 'two_sided';
    const correction = input.correction || 'holm';
    const labelOf = (g, i) => g.label || (i < 0 ? 'control' : `variant_${i + 1}`);
    const need = (g, fields) => { for (const f of fields) if (g[f] === undefined) throw new ToolError(`ab_test metric=${metric}: group '${g.label || '?'}' is missing '${f}'`, { stage: 'validate', field: f }); };

    let results; const extra = {};
    if (metric === 'cuped') {
      const suff = ['sumY', 'sumY2', 'sumX', 'sumX2', 'sumXY'];
      need(control, suff); for (const v of input.variants) need(v, suff);
      const pick = (g, label) => ({ label, n: g.n, sumY: g.sumY, sumY2: g.sumY2, sumX: g.sumX, sumX2: g.sumX2, sumXY: g.sumXY });
      const groups = [pick(control, labelOf(control, -1)), ...input.variants.map((v, i) => pick(v, labelOf(v, i)))];
      const out = cupedTest({ groups, alternative, confidence });
      extra.theta = out.theta; results = out.results;
    } else if (metric === 'ratio') {
      const suff = ['sumNum', 'sumDen', 'sumNum2', 'sumDen2', 'sumNumDen'];
      need(control, suff); for (const v of input.variants) need(v, suff);
      results = input.variants.map((v, i) => ({ variant: labelOf(v, i), ...ratioDeltaTest({ control, variant: v, alternative, confidence }) }));
    } else {
      results = input.variants.map((v, i) => {
        let r;
        if (metric === 'proportion') {
          need(control, ['conversions']); need(v, ['conversions']);
          r = twoProportionZTest({ controlConversions: control.conversions, controlN: control.n, variantConversions: v.conversions, variantN: v.n, alternative, confidence });
        } else {
          need(control, ['mean', 'stddev']); need(v, ['mean', 'stddev']);
          r = welchTTest({ controlMean: control.mean, controlStddev: control.stddev, controlN: control.n, variantMean: v.mean, variantStddev: v.stddev, variantN: v.n, alternative, confidence });
        }
        return { variant: labelOf(v, i), ...r };
      });
    }

    // Correct the p-values across the variant family (FWER via Holm, or FDR via BH)
    // so several arms don't inflate false positives; raw `significant` is kept too.
    if (correction !== 'none' && results.length > 0) {
      const adj = adjustPValues(results.map((r) => r.p_value), correction);
      results = results.map((r, i) => ({ ...r, p_value_adjusted: adj[i], significant_adjusted: adj[i] < 1 - confidence }));
    }
    return { ok: true, metric, confidence, alternative, correction, control: labelOf(control, -1), ...extra, results };
  }

  /**
   * Sample Ratio Mismatch guardrail: χ² goodness-of-fit that the observed per-group
   * sizes match the intended split. A detected mismatch (p < 0.001) invalidates the
   * experiment regardless of any lift. Compute per-group n with a pipeline first.
   */
  srm_check(input) {
    this._validate('srm_check', input);
    return { ok: true, ...srmTest({ groups: input.groups, ratios: input.expected_ratio }) };
  }

  /**
   * Power / sample-size planning (no warehouse). Given a baseline (proportion) or
   * stddev (mean) plus a target effect, returns the required sample size PER GROUP;
   * given a sample size, returns the minimum detectable effect (MDE). Use it to size
   * a test up front and to tell "no effect" apart from "underpowered".
   */
  sample_size(input) {
    this._validate('sample_size', input);
    const { metric } = input;
    const confidence = input.confidence ?? 0.95;
    const power = input.power ?? 0.8;
    const alternative = input.alternative || 'two_sided';
    const common = { alpha: 1 - confidence, power, alternative };
    const base = { ok: true, metric, power, confidence, alternative };
    if (metric === 'proportion') {
      const { baseline } = input;
      if (baseline === undefined) throw new ToolError('sample_size metric=proportion requires baseline', { stage: 'validate', field: 'baseline' });
      if (input.n !== undefined) { const mde = mdeProportion({ baseline, n: input.n, ...common }); return { ...base, n_per_group: input.n, baseline, mde, relative_mde: mde / baseline }; }
      if (input.mde !== undefined) { const n = sampleSizeProportion({ baseline, mde: input.mde, ...common }); return { ...base, n_per_group: n, total_n: 2 * n, baseline, mde: input.mde, relative_mde: input.mde / baseline }; }
      throw new ToolError('sample_size requires either mde (→ solve n) or n (→ solve MDE)', { stage: 'validate', field: 'mde' });
    }
    const { stddev } = input;
    if (stddev === undefined) throw new ToolError('sample_size metric=mean requires stddev', { stage: 'validate', field: 'stddev' });
    if (input.n !== undefined) { const mde = mdeMean({ stddev, n: input.n, ...common }); return { ...base, n_per_group: input.n, stddev, mde }; }
    if (input.mde !== undefined) { const n = sampleSizeMean({ stddev, mde: input.mde, ...common }); return { ...base, n_per_group: n, total_n: 2 * n, stddev, mde: input.mde }; }
    throw new ToolError('sample_size requires either mde (→ solve n) or n (→ solve MDE)', { stage: 'validate', field: 'mde' });
  }

  /**
   * Bounded wait (0–60s) so the AI can pace background-job polling: wait an
   * interval, then poll get_query_result, repeat until ready. Purely a timer.
   */
  async time(input) {
    this._validate('time', input);
    const requested = Number(input.seconds) || 0;
    const seconds = Math.min(Math.max(requested, 0), 60); // clamp to [0, 60]
    const startedAt = new Date().toISOString();
    await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
    return { ok: true, waited_seconds: seconds, requested_seconds: requested, clamped: requested > 60, started_at: startedAt, finished_at: new Date().toISOString(), ...(input.reason ? { reason: input.reason } : {}) };
  }

  async describe_context(input) {
    this._validate('describe_context', input);
    const ctx = this.ctxs.get(input.context_id);
    // A pipeline-registered model is a normal dbt model whose rows are the result.
    // Report its model name, the pipeline's output columns, and the REAL physical
    // columns of the relation (adapter introspection). Read it via get_query_result.
    if (ctx.state.engine === 'pipeline') {
      const n = ctx.state.native || {};
      let physical = null;
      if (this.runner && n.model) {
        const cols = await this.runner.relationColumns(this.ctxs.dir(ctx.id), n.model);
        physical = cols.ok ? cols.columns : null;
      }
      return {
        context_id: ctx.id,
        engine: 'pipeline',
        tasks: ctx.state.tasks || [],
        models: [{ model: n.model, materialized: n.materialized, columns: n.columns || [], physical_columns: physical }],
        columns: n.columns || [],
        read_with: 'get_query_result',
        files: this.ctxs.generatedFiles(ctx.id),
      };
    }
    const additions = ctx.state.additions || {};
    return {
      context_id: ctx.id,
      engine: 'core',
      tasks: ctx.state.tasks || [],
      semantic_models: Object.keys(additions),
      measures: Object.values(additions).flatMap((a) => a.measures.map((m) => m.name)),
      metrics: (ctx.state.metrics || []).map((m) => m.name),
      groupable: [...this._allowedPaths(ctx)],
      files: this.ctxs.generatedFiles(ctx.id),
    };
  }

  async query_semantic_model(input) {
    this._validate('query_semantic_model', input);
    const ctx = this.ctxs.get(input.context_id);

    // A pipeline-registered model has no MetricFlow semantic model — its rows ARE
    // the result. Read/slice/sample them with get_query_result instead.
    if (ctx.state.engine === 'pipeline') {
      throw new ToolError(`context ${ctx.id} holds a pipeline model (${ctx.state.model}); read its rows with get_query_result (table: ${ctx.state.model}), not query_semantic_model`, { stage: 'validate' });
    }

    if (!input.metrics?.length) throw new ToolError('metrics is required for a metric query', { stage: 'validate' });
    const known = new Set(ctx.state.metrics.map((m) => m.name));
    for (const m of input.metrics) if (!known.has(m)) throw new ToolError(`unknown metric in context: ${m}`, { stage: 'validate', field: m });

    const allowed = this._allowedPaths(ctx);
    const groupBy = [];
    for (const g of input.group_by || []) {
      if (typeof g === 'object' && g.time === 'metric_time') groupBy.push(`metric_time__${g.grain || 'day'}`);
      else if (typeof g === 'string') {
        if (g !== 'metric_time' && !allowed.has(g)) throw new ToolError(`group_by path not reachable in context: ${g}. Known paths: ${[...allowed].slice(0, 30).join(', ')}`, { stage: 'validate', field: g });
        const resolved = this._resolvePath(ctx, g);
        this._checkPathLoaded(ctx, resolved);
        groupBy.push(resolved);
      }
    }
    let where = [];
    if (input.where) {
      const translated = clone(input.where);
      walkPredicates(translated, (p) => {
        if (p.field?.kind === 'dimension') {
          if (!allowed.has(p.field.path)) throw new ToolError(`where path not reachable in context: ${p.field.path}`, { stage: 'validate', field: p.field.path });
          p.field.path = this._resolvePath(ctx, p.field.path); // bare task dim -> entity-qualified
          this._checkPathLoaded(ctx, p.field.path);
        }
      });
      where = renderWhereClauses(translated);
    }
    // order_by keys must be a requested metric or group-by token. `metric_time` is a
    // convenience alias that resolves to the GRAINED token a time group_by actually
    // produces (e.g. metric_time__day), so callers don't have to guess the suffix.
    const orderable = new Set([...input.metrics, ...groupBy]);
    const metricTimeTok = groupBy.find((g) => g.startsWith('metric_time__'));
    const orderBy = (input.order_by || []).map((o) => {
      const key = (o.key === 'metric_time' && metricTimeTok) ? metricTimeTok : o.key;
      if (!orderable.has(key)) throw new ToolError(`order_by key '${o.key}' is not a requested metric or group_by token. Orderable: ${[...orderable].join(', ')}`, { stage: 'validate', field: o.key });
      return `${o.direction === 'desc' ? '-' : ''}${key}`;
    });

    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });

    const limit = input.limit ?? 1000;
    const offset = input.offset ?? 0;
    // Over-fetch one extra row so `has_more` is meaningful (H2): without the +1,
    // res.rows is capped at limit+offset and has_more can never be true.
    const qopts = { metrics: input.metrics, groupBy, where, orderBy, startTime: input.time_range?.start, endTime: input.time_range?.end, limit: limit + offset + 1 };
    const explain = !!(input.dry_run || input.explain);
    if (input.materialize && !explain) return this._materialize(ctx, qopts, input);
    const res = await this.runner.query(this.ctxs.dir(ctx.id), { ...qopts, explain, plan: !!input.explain });
    this.ctxs.touch(ctx.id);

    if (!res.ok) return { ok: false, command: res.command, error: { stage: 'query', message: formatDbtError(res.stdout, res.stderr) } };
    if (explain) {
      const out = { ok: true, command: res.command, sql: res.sql, orderable_keys: [...orderable] };
      if (input.dry_run) out.dry_run = true;
      if (input.explain) { out.explain = true; out.plan = res.plan; }
      return out;
    }

    const pageRows = res.rows.slice(offset, offset + limit);
    return {
      ok: true,
      command: res.command,
      columns: res.columns,
      rows: pageRows,
      row_count: pageRows.length,
      page: { limit, offset, has_more: res.rows.length > offset + limit },
      warnings: [],
    };
  }

  /**
   * Materialization mode: compile the query to SQL, write it as a
   * materialized='table' dbt model, build it (dbt run), and read rows back from
   * that table (dbt show). Results live in the warehouse — re-fetchable and
   * crash-resilient. If the build exceeds queryTimeoutMs, it continues in the
   * BACKGROUND and a query_id is returned; poll get_query_result.
   */
  async _materialize(ctx, qopts, input) {
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    const dir = this.ctxs.dir(ctx.id);
    const explain = await this.runner.query(dir, { ...qopts, explain: true });
    if (!explain.ok) return { ok: false, error: { stage: 'query', message: formatDbtError(explain.stdout, explain.stderr) } };

    const id = this.jobs.create({ contextId: ctx.id });
    const table = `qr_${id}`;
    this.jobs.setTable(id, table);
    const header = sqlConfigHeader('materialized_query', { context_id: ctx.id, metrics: input.metrics, group_by: input.group_by, where: input.where, order_by: input.order_by, time_range: input.time_range });
    this.ctxs.writeModel(ctx.id, table, `{{ config(materialized='table') }}\n${header}${explain.sql}\n`);

    // Hold a lease on the context for the lifetime of the (possibly detached)
    // build so drop_context can't tear down the overlay mid-run (Reliability C1).
    this.ctxs.acquire(ctx.id);
    // Detached build: any thrown error (not just non-ok results) must be
    // captured to the job, never surface as an unhandled rejection (M2).
    const build = (async () => {
      try {
        const r = await this.runner.run(dir, table);
        if (!r.ok) this.jobs.fail(id, formatDbtError(r.stdout, r.stderr));
        else this.jobs.ready(id);
      } catch (e) {
        this.jobs.fail(id, e?.message || String(e));
      } finally {
        this.ctxs.release(ctx.id);
      }
    })().catch(() => {});
    const timed = new Promise((res) => setTimeout(() => res('timeout'), this.queryTimeoutMs));
    const winner = await Promise.race([build.then(() => 'done'), timed]);
    if (winner === 'timeout') {
      return { ok: true, status: 'running', query_id: id, table, message: `materializing in background (> ${this.queryTimeoutMs / 1000}s); poll get_query_result with query_id` };
    }
    const job = this.jobs.get(id);
    if (job.status === 'error') return { ok: false, status: 'error', query_id: id, table, error: { stage: 'materialize', message: job.error } };
    return this._fetchResult(id, input.limit ?? 1000, undefined, input.offset ?? 0);
  }

  /** Read rows back from a materialized result table (resilient: no recompute). */
  async _fetchResult(id, limit, transform, offset = 0, sample = false, samplePercent = 10) {
    const job = this.jobs.get(id);
    return this._readTable(this.ctxs.dir(job.contextId), job.table, limit, transform, { query_id: id }, offset, sample, samplePercent);
  }

  /** Run a (optionally projected) read over a materialized result table. */
  async _readTable(dir, table, limit, transform, extra = {}, offset = 0, sample = false, samplePercent = 10) {
    const ref = `{{ ref('${table}') }}`;
    const base = transform ? buildProjection(ref, transform) : `select * from ${ref}`;
    if (sample) {
      // A REPRESENTATIVE random subset rather than the first rows by physical
      // order. BigQuery uses TABLESAMPLE SYSTEM (block sampling on the table
      // reference); Postgres uses ORDER BY random() (reliable on small result
      // tables, where block sampling can return nothing). Paging doesn't apply.
      let sql;
      if (this.catalog.dialect === 'bigquery') {
        const sampled = `${ref} TABLESAMPLE SYSTEM (${Number(samplePercent)} PERCENT)`;
        sql = transform ? buildProjection(sampled, transform) : `select * from ${sampled}`;
      } else {
        sql = `select * from (${base}) _s order by random()`;
      }
      const res = await this.runner.show(dir, sql, limit);
      if (!res.ok) return { ok: false, status: 'error', table, ...extra, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
      return { ok: true, status: 'ready', table, ...extra, sampled: true, columns: res.columns, rows: res.rows, row_count: res.rows.length, ...(transform ? { projected: true } : {}) };
    }
    // Page in JS over a single read (over-fetch by 1 for has_more) rather than a
    // SQL OFFSET with no ORDER BY (which was non-deterministic across calls — H2).
    const res = await this.runner.show(dir, base, limit + offset + 1);
    if (!res.ok) return { ok: false, status: 'error', table, ...extra, error: { stage: 'fetch', message: formatDbtError(res.stdout, res.stderr) } };
    const pageRows = res.rows.slice(offset, offset + limit);
    return { ok: true, status: 'ready', table, ...extra, columns: res.columns, rows: pageRows, row_count: pageRows.length, page: { limit, offset, has_more: res.rows.length > offset + limit }, ...(transform ? { projected: true } : {}) };
  }

  /**
   * Poll a background (materialized) query: status + results from the table.
   * Optional `transform` (where/group_by/aggregations/having/order_by/limit)
   * runs a safe read-only projection over the materialized table — compress or
   * re-slice the stored results without recomputing the analytics query.
   */
  async get_query_result(input) {
    this._validate('get_query_result', input);
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    const limit = input.limit ?? 1000;
    const offset = input.offset ?? 0;
    const sample = !!input.sample;
    const samplePercent = input.sample_percent ?? 10;
    // direct fetch by table (crash-resilient: works even if the job is gone).
    // Accepts a query-result table (qr_*) or a registered pipeline model (pipe_*).
    if (input.table) {
      this.ctxs.get(input.context_id); // validate the context exists (throws otherwise)
      if (!/^(qr_[a-f0-9]{8,16}|pipe_[a-z][a-z0-9_]{0,80})$/.test(input.table)) throw new ToolError(`invalid result table name: ${input.table}`, { stage: 'validate', field: 'table' });
      return this._readTable(this.ctxs.dir(input.context_id), input.table, limit, input.transform, {}, offset, sample, samplePercent);
    }
    const job = this.jobs.get(input.query_id);
    if (!job) throw new ToolError(`unknown query_id: ${input.query_id} (pass {context_id, table} to fetch a known table directly)`, { stage: 'validate', field: 'query_id' });
    if (job.status === 'running') return { ok: true, status: 'running', query_id: job.id, table: job.table };
    if (job.status === 'error') return { ok: false, status: 'error', query_id: job.id, table: job.table, error: { stage: 'materialize', message: job.error } };
    return this._fetchResult(job.id, limit, input.transform, offset, sample, samplePercent);
  }

  list_query_jobs() {
    return { jobs: this.jobs.list() };
  }

  /** Reclaim idle, lease-free contexts (bounds workspace growth). */
  gc(maxIdleMs) {
    return this.ctxs.gc(maxIdleMs);
  }

  /** Release process resources (shared store handle, warm runner/sidecar). */
  close() {
    // Managers share the store and don't own it; the Engine closes it once.
    try { if (this._ownsStore) this.store?.close?.(); } catch { /* noop */ }
    try { this.runner?.close?.(); } catch { /* noop */ }
  }

  async _parse(ctxId) {
    if (!this.runner) return { ok: true, executed: false, reason: 'no runner configured — not parsed (unit mode)' };
    const r = await this.runner.parse(this.ctxs.dir(ctxId));
    if (!r.ok) return { ok: false, error: { stage: 'parse', message: formatDbtError(r.stdout, r.stderr) } };
    return { ok: true, manifest: r.manifest };
  }

  _assumptions(ctx) {
    const a = [`one semantic model per table in context ${ctx.id}`];
    if (ctx.state.additions[this.catalog.anchor]) a.push('the event scope is applied inside each measure');
    a.push('metric_time / cumulative / conversion metrics require a configured time dimension');
    return a;
  }
}

function metricUsesMeasure(metric, measureName) {
  const tp = metric.type_params || {};
  const refs = [tp.measure?.name];
  if (tp.conversion_type_params) refs.push(tp.conversion_type_params.base_measure?.name, tp.conversion_type_params.conversion_measure?.name);
  return refs.includes(measureName);
}

function walkPredicates(group, fn) {
  for (const c of group.conditions || []) {
    if (c.conditions) walkPredicates(c, fn);
    else fn(c);
  }
}

function clone(x) {
  return JSON.parse(JSON.stringify(x ?? null));
}
