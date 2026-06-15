// Tool engine: validates inputs against catalog-derived schemas, compiles
// declarations, renders YAML, drives dbt/mf within isolated contexts.

import { buildSchemas } from './schema.js';
import { makeValidators, validateInput, ToolError } from './validate.js';
import { twoProportionZTest, welchTTest, cupedTest, ratioDeltaTest, srmTest, adjustPValues, alwaysValidP, sampleSizeProportion, mdeProportion, sampleSizeMean, mdeMean } from './stats.js';
import { compileDeclaration } from './compile.js';
import { renderContext } from './yaml-render.js';
import { ContextManager, mergeCompiled } from './context-manager.js';
import { renderWhereClauses } from './predicate.js';
import { formatDbtError } from './dbt-runner.js';
import './match-recognize.js'; // registers the match_recognize pipeline stage
import { resolveTimeRange, timeRangeWarnings, isValidTimezone } from './time-range.js';
import { sqlLiteral } from './dialect.js';
import { renderPipeline } from './pipeline.js';
import { CatalogSearch } from './search.js';
import { buildGuide } from './guide.js';
import { JobManager } from './jobs.js';
import { ValueIndex } from './value-index.js';
import { MemoryStore } from './memory.js';
import { openStore } from './store.js';
import { buildProjection } from './projection.js';
import { sqlConfigHeader } from './sql-header.js';

export class Engine {
  constructor({ catalog, contextManager, runner, recipes, sqlRunner, queryTimeoutMs, dbPath, store, resetDb = false, embedder }) {
    this.catalog = catalog;
    this.recipes = recipes; // optional Recipes instance
    this.sqlRunner = sqlRunner; // optional async (sql) => { columns, rows } — for match_recognize
    // ONE shared store (single db file) for the job registry + value index. resetDb wipes
    // it on open (MCP_DB_RESET) before the managers read it.
    this.store = store || openStore({ dbPath, reset: resetDb });
    this._ownsStore = !store;
    this.jobs = new JobManager({ store: this.store }); // persisted if the store is
    this.valueIndex = new ValueIndex({ store: this.store }); // real event-property values (background-populated)
    this.memoryStore = new MemoryStore({ store: this.store, embedder }); // durable analyst findings, linked to catalog entities (the `memory` tool); embedder → semantic search
    this.catalogSearch = new CatalogSearch({ catalog, recipes, valueIndex: this.valueIndex }); // semantic_index({ search })
    this.queryTimeoutMs = queryTimeoutMs ?? 60000; // materialize -> background after this
    this.schemas = buildSchemas(catalog);
    // Recipes are NOT a standalone tool — they are building blocks surfaced THROUGH
    // semantic_index ({ recipe: id } for one, the overview list + { guide } per task family).
    // Constrain the recipe view to real ids when recipes are configured.
    if (recipes && this.schemas.semantic_index?.properties?.recipe) this.schemas.semantic_index.properties.recipe.enum = recipes.ids();
    this.validators = makeValidators(this.schemas);
    this.ctxs = contextManager || new ContextManager({});
    this.runner = runner; // optional; required for non-dry_run parse/query
  }

  // Internal helpers (no longer standalone tools — reached via semantic_index({ recipe })
  // / overview / { guide }). Kept for the recipe view + the recipe-driven tests.
  list_recipes() {
    if (!this.recipes) return { recipes: [], note: 'Recipes are not configured on this server.' };
    return { recipes: this.recipes.summary() };
  }

  get_recipe(input) {
    if (!this.recipes) throw new ToolError('recipes are not configured on this server', { stage: 'validate', field: 'recipe' });
    const r = this.recipes.get(input.id);
    // A recipe is a reusable BUILDING BLOCK: a ready payload for a task family PLUS `hack`
    // — the generalizable technique to adapt it to a novel question.
    return {
      ...r,
      naming_note: 'Metric/measure names are namespaced by the task name: query them as <task>_<metric> (the example_queries already use the full names).',
      building_block: 'This is a reusable template: take its `hack` (the technique) and adapt the payload to your exact question; feed a pipeline payload through build_native_model, a create_payload through create_semantic_model.',
    };
  }

  _validate(tool, input) {
    const res = validateInput(this.validators[tool], input || {});
    if (!res.ok) throw new ToolError(`invalid input: ${res.errors.join('; ')}`, { stage: 'validate' });
  }

  /**
   * Resolve a memory TARGET string to a canonical, typed key so a saved finding links to a
   * real semantic_index view. A '<model>.<column>' attribute or a known model/event/event-
   * property resolves to that entity; anything else is kept as a free `term` (the user's
   * fuzzy phrasing) so it is still searchable and can map back to whatever it describes.
   */
  _resolveMemoryTarget(t) {
    const c = this.catalog;
    const s = String(t).trim();
    const dot = s.indexOf('.');
    if (dot > 0) {
      const mk = s.slice(0, dot); const col = s.slice(dot + 1);
      if (mk !== c.anchor && c.models[mk] && (c.getModel(mk).dimensions || {})[col]) return { kind: 'property', key: `${mk}.${col}`, canon: `property:${mk}.${col}` };
    }
    if (c.models[s]) return { kind: 'model', key: s, canon: `model:${s}` };
    if (c.eventNames().includes(s)) return { kind: 'event', key: s, canon: `event:${s}` };
    if (c.eventProps().includes(s)) return { kind: 'property', key: s, canon: `property:${s}` };
    return { kind: 'term', key: s, canon: `term:${s.toLowerCase()}` };
  }

  /** Where a resolved target's findings surface in semantic_index (a ready call to copy). */
  _memorySurfaceHint({ kind, key }) {
    if (kind === 'property') return `semantic_index({ property: '${key}' })`;
    if (kind === 'event') return `semantic_index({ event: '${key}' })`;
    if (kind === 'model') return `semantic_index({ model: '${key}' })`;
    return `semantic_index({ search: '${key}' })`; // term
  }

  /** Compact notes linked to any of `canonKeys`, for attaching to a semantic_index view. */
  _memoryFor(canonKeys) {
    return this.memoryStore.forTargets(canonKeys).map(memoryView);
  }

  /**
   * THE analyst memory tool. Save a FINDING the AI made (a vague phrasing tracked down to a
   * real field, a non-obvious gotcha, an associated source/link) and LINK it to the catalog
   * entities it concerns, so it surfaces back THROUGH semantic_index (the linked { model }/
   * { event }/{ property } views and { search }) next time the same word/field comes up.
   *   action:'record' → save a note (+ targets it is about, + aliases the user used, + links)
   *   action:'list'   → all notes, or those linked to one { target }
   *   action:'search' → notes matching a word (text / alias / target)
   *   action:'forget' → delete one note by id
   */
  async memory(input = {}) {
    this._validate('memory', input);
    const action = input.action;

    if (action === 'record') {
      const note = String(input.note ?? '').trim();
      if (!note) throw new ToolError('note is required and must be a non-empty finding', { stage: 'validate', field: 'note' });
      const question = input.question ? String(input.question).trim() : null;
      const resolved = (input.targets || []).map((t) => this._resolveMemoryTarget(t));
      const aliases = [...new Set((input.aliases || []).map((a) => String(a).trim()).filter(Boolean))];
      const links = (input.links || []).map((l) => (typeof l === 'string' ? { url: l } : { url: String(l.url), ...(l.title ? { title: String(l.title) } : {}) }));
      const entry = this.memoryStore.record({ note, question, targets: resolved.map((r) => r.canon), aliases, links });
      return {
        saved: true,
        id: entry.id,
        note: entry.note,
        ...(question ? { question } : {}),
        linked_to: resolved.map((r) => ({ kind: r.kind, target: r.key, surfaces_in: this._memorySurfaceHint(r) })),
        ...(resolved.some((r) => r.kind === 'term') ? { unresolved_terms: resolved.filter((r) => r.kind === 'term').map((r) => r.key) } : {}),
        aliases, links,
        next: 'Saved. This finding now surfaces in semantic_index on the linked entities and via semantic_index({ search }) (and memory({ action: "search" })) — including the aliases/words above.',
      };
    }

    if (action === 'list') {
      if (input.target !== undefined) {
        const r = this._resolveMemoryTarget(input.target);
        return { target: r.key, kind: r.kind, notes: this.memoryStore.forTargets([r.canon]).map(memoryView) };
      }
      return { total: this.memoryStore.counts().notes, notes: this.memoryStore.all({ limit: input.limit ?? 50 }).map(memoryView) };
    }

    if (action === 'search') {
      const r = await this.memoryStore.search(input.query, { limit: input.limit ?? 20, fuzzy: input.fuzzy !== false });
      return { query: input.query, semantic: r.semantic, ...(r.semantic_error ? { semantic_error: r.semantic_error } : {}), notes: r.notes.map(memoryView) };
    }

    if (action === 'forget') {
      if (!this.memoryStore.forget(input.id)) throw new ToolError(`no memory note with id '${input.id}'`, { stage: 'validate', field: 'id' });
      return { forgotten: true, id: input.id };
    }

    throw new ToolError(`unknown action '${action}'`, { stage: 'validate', field: 'action' });
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
   * THE semantic index: one progressive view over everything the data means AND how
   * well it is indexed. The events fact carries ~150 event-scoped properties, so
   * dumping everything at once is wasteful. Call with NO arguments for a compact
   * OVERVIEW, then drill down:
   *   { model }    → one model's entities/time/dimensions (with real values) + physical columns
   *   { event }    → only the properties POPULATED on that event (what you can use)
   *   { property } → one property/attribute: spec + real value distribution + NULL
   *                  coverage per event + indexing history (one page per column)
   *   { search }   → events/properties/attributes/VALUES/recipes matching a substring
   *   { recipe }   → one ready-made recipe by id (payload + example_queries + hack)
   *   { guide }    → the analyst procedure + IF/DO routing (how to approach a question)
   *   { status }   → operational state: value-index sync runs + background query jobs
   *   { run }      → one sync run's per-property breakdown (slowest first)
   *   { bundle }   → for one app (bundle id): which event properties are populated vs EMPTY
   *                  (skip the empty ones for that app)
   * Pass at most one drill-down key (mutually exclusive views).
   */
  async semantic_index(input = {}) {
    this._validate('semantic_index', input);
    // STRICT view contract (nothing is ever silently ignored): at most ONE view key,
    // and paging/ordering/recency params only on the views they apply to.
    const views = ['run', 'status', 'guide', 'model', 'event', 'property', 'search', 'recipe', 'bundle'].filter((k) => input[k] !== undefined && input[k] !== false);
    if (views.length > 1) {
      throw new ToolError(`pass at most ONE view key (got: ${views.join(', ')}). Views: {} overview | { model } | { event } | { property } | { search } | { recipe } | { guide } | { bundle } | { status: true } | { run }`, { stage: 'validate', field: views[1] });
    }
    if (input.limit !== undefined && !(input.property || input.search)) throw new ToolError('limit only applies to the { property } and { search } views', { stage: 'validate', field: 'limit' });
    for (const k of ['offset', 'order_by', 'direction']) {
      if (input[k] !== undefined && !input.property) throw new ToolError(`${k} only applies to the { property } view`, { stage: 'validate', field: k });
    }
    if (input.recent !== undefined && !(input.status || input.run != null || input.property)) throw new ToolError('recent only applies to the { status }, { run } and { property } views', { stage: 'validate', field: 'recent' });
    if (input.fuzzy !== undefined && !input.search) throw new ToolError('fuzzy only applies to the { search } view', { stage: 'validate', field: 'fuzzy' });

    const c = this.catalog;
    const AGG = ['count', 'count_distinct', 'sum', 'average', 'median', 'min', 'max', 'percentile', 'sum_boolean'];

    // ── operational views (sync state / one run) ──
    if (input.run != null) return this._indexRun(input);
    if (input.status) return this._indexStatus(input);

    // ── { guide }: the analyst procedure + routing (workflow, IF/DO triggers, per-task
    // recipes) — the generic skill knowledge served through the MCP, single-sourced. ──
    if (input.guide !== undefined && input.guide !== false) {
      return buildGuide(this.catalog, this.recipes, { task: typeof input.guide === 'string' ? input.guide : undefined });
    }

    // ── { recipe }: one ready-made recipe by id (folded in from the old get_recipe tool) ──
    if (input.recipe) {
      if (!this.recipes) throw new ToolError('recipes are not configured on this server', { stage: 'validate', field: 'recipe' });
      return this.get_recipe({ id: input.recipe });
    }

    // ── { model }: one model in depth (incl. live warehouse introspection) ──
    if (input.model) {
      const k = input.model;
      if (!c.models[k]) throw new ToolError(`unknown model '${k}'. Known models: ${c.modelKeys().join(', ')}`, { stage: 'validate', field: 'model' });
      const m = c.getModel(k);
      const descs = c.columnDescriptions(k);
      const out = { key: k, role: m.role, dbt_model: m.dbt_model, description: m.description, primary_entity: c.primaryEntityName(k), entities: m.entities, time: m.time?.column, measures: Object.keys(m.measures || {}) };
      // The ONE list of columns you can work with on this source (reference in where/
      // compute/group_by/order_by/match_recognize). `time` above is the default order axis.
      // It is silently grounded to the physical table below — only real columns appear.
      out.columns = c.modelColumns(k);
      if (k === c.anchor) {
        out.event_count = c.eventNames().length;
        out.property_count = c.eventProps().length;
        if (m.event_semantics) out.event_semantics = m.event_semantics;
        // Static cost hint (no live runner needed): always constrain the partition
        // column / time axis, or the warehouse scans the whole fact.
        if (m.partition_column) {
          out.partition_column = m.partition_column;
          out.cost_hint = `The physical table is partitioned by ${m.partition_column} — ALWAYS bound queries with time_range (or a where on ${m.partition_column}/${m.time?.column || 'the time column'}) to avoid a full scan.`;
        }
        out.note = 'Events fact: payload fields are event-scoped properties (semantic_index({ event })). The `columns` above are what you can reference in a native pipeline; order windows/match_recognize by `time` (' + (m.time?.column || '?') + ').';
      } else {
        // Dimension attributes WITH their real indexed values (cardinality + top 3) — the
        // index stores them under namespaced '<model>.<column>' keys (e.g. 'users.country').
        const dims = m.dimensions || {};
        out.dimensions = Object.keys(dims).map((d) => {
          const st = this.valueIndex.stats(`${k}.${d}`);
          return { name: d, type: dims[d].type, description: descs[d], distinct_count: st?.distinctCount ?? null, sample_values: this.valueIndex.sampleValues(`${k}.${d}`, 3) };
        });
      }
      const base = this.ctxs.baseProjectDir;
      if (this.runner && base) {
        const cols = await this.runner.relationColumns(base, m.dbt_model);
        // Silent internal guard: keep ONLY columns that physically exist, so a name that
        // is not really in the table never surfaces anywhere. One list, grounded to truth.
        // Best-effort — if introspection fails (table not built yet) keep the declared set.
        if (cols.ok) {
          const physSet = new Set(cols.columns.map((col) => String(col.name).toLowerCase()));
          out.columns = out.columns.filter((col) => physSet.has(col.name.toLowerCase()));
        }
        // Data freshness: latest value of the time column (how up-to-date the data is).
        if (m.time?.column) { const fresh = await this._dataFreshness(k); if (fresh) out.data_freshness = fresh; }
      }
      out.recommendations = k === c.anchor
        ? [
          `Drill into an event to see the properties it carries: semantic_index({ event: '${c.eventNames()[0] || '<event_name>'}' }).`,
          `Then inspect a property's real values + frequency distribution: semantic_index({ property: '<name>' }).`,
          `Recognise a value (an ad format, a status, ...)? Trace which property/event carries it: semantic_index({ search: '<value>' }).`,
        ]
        : [
          `Drill into an attribute's full value/frequency distribution: semantic_index({ property: '${k}.${Object.keys(m.dimensions || {})[0] || '<column>'}' }).`,
          `Looking for a known attribute value? semantic_index({ search: '<value>' }) tells you where it occurs.`,
        ];
      // Saved findings about this model (memory tool) — surface them where they belong.
      const mem = this._memoryFor([`model:${k}`]);
      if (mem.length) out.memory = mem;
      return out;
    }

    // ── { event }: the properties populated on this event (NULL on others) ──
    if (input.event) {
      if (!c.eventNames().includes(input.event)) throw new ToolError(`unknown event '${input.event}'. See semantic_index().event_names`, { stage: 'validate', field: 'event' });
      const numeric = new Set(c.eventNumericProps());
      const applies = c.eventPropertyEvents();
      const descs = c.eventPropertyDescriptions();
      const props = c.eventProps().filter((p) => { const evs = applies[p]; return !evs || evs.includes(input.event); });
      const rows = props.map((p) => {
        // Compact index hint: cardinality + the top 3 real values (null/[] until indexed).
        const st = this.valueIndex.stats(p);
        const spec = c.eventPropertySpec(p) || {};
        return { name: p, type: spec.type, ...(spec.unit ? { unit: spec.unit } : {}), numeric: numeric.has(p), complex: c.isComplexEventProp(p), description: descs[p], distinct_count: st?.distinctCount ?? null, sample_values: this.valueIndex.sampleValues(p, 3) };
      });
      // Drill-down guidance: point at properties whose real values are worth inspecting
      // next (prefer ones already indexed so the AI sees data), plus value search.
      const recommendations = [];
      const withValues = rows.filter((r) => !r.complex && r.sample_values.length);
      const pick = (withValues.length ? withValues : rows.filter((r) => !r.complex)).slice(0, 3);
      if (pick.length) recommendations.push(`Drill into a property's real values + full frequency distribution: ${pick.map((r) => `semantic_index({ property: '${r.name}' })`).join(', ')}.`);
      if (withValues.length) recommendations.push(`Spot a value you recognise in the samples above? Find every property/event it occurs in: semantic_index({ search: '<value>' }).`);
      if (rows.some((r) => r.complex)) recommendations.push(`Complex (array/struct) properties carry nested values — semantic_index({ property }) shows the shape before you explore inside them.`);
      if (!props.length) {
        // No payload at all (e.g. first_launch) is NOT a dead end: the event's value is
        // its OCCURRENCE — say what it is good for instead of returning an empty page.
        const sem = c.getModel(c.anchor).event_semantics || {};
        const role = Object.entries(sem).find(([, ev]) => ev === input.event)?.[0];
        recommendations.push(`'${input.event}' carries no event-specific payload — its value is the occurrence itself${role ? ` (it is the ${role.replace(/_/g, ' ')})` : ''}: use it as a measure base (count / count_distinct of the user key, event_name: ['${input.event}']) for retention, conversion or funnel metrics.`);
      }
      if (!recommendations.length) recommendations.push(`Inspect any property's real values with semantic_index({ property }).`);
      const mem = this._memoryFor([`event:${input.event}`]);
      return {
        event: input.event,
        property_count: props.length,
        properties: rows,
        ...(mem.length ? { memory: mem } : {}),
        recommendations: recommendations.slice(0, 4),
      };
    }

    // ── { property }: one property's full spec ──
    if (input.property) {
      const p = String(input.property);
      // Namespaced '<model>.<column>' (e.g. 'users.country', 'experiments.experiment_name'):
      // a dimension ATTRIBUTE of a non-anchor model — same indexed value listing as an
      // event property, plus how to reach it in queries (join path).
      const dot = p.indexOf('.');
      if (dot > 0) {
        const mk = p.slice(0, dot); const col = p.slice(dot + 1);
        const dim = (mk !== c.anchor && c.models[mk]) ? (c.getModel(mk).dimensions || {})[col] : undefined;
        if (!dim) throw new ToolError(`unknown attribute '${p}'. Dimension attributes are '<model>.<column>' — see semantic_index({ model: '${c.models[mk] ? mk : 'users'}' }) for the list; bare names are event properties`, { stage: 'validate', field: 'property' });
        const dDescs = c.columnDescriptions(mk);
        const { samples, value_stats } = this._valueListing(p, input);
        // NULL coverage + indexing freshness make this ONE page the full truth about the
        // column: meaning, values, completeness, and how recently it was profiled.
        // (event_coverage is [] here — attributes live on the dimension model, not on
        // events — but the SHAPE matches the event-property page exactly.)
        const { nulls, coverage: attrCoverage, recs: nullRecs } = this._nullCoverage(p, null);
        Object.assign(value_stats, nulls);
        const ent = c.primaryEntityName(mk);
        const recommendations = [];
        if (samples.length) recommendations.push(`${value_stats.distinct_count != null ? `${value_stats.distinct_count} distinct values; ` : ''}top: ${samples.slice(0, 5).map((s) => `'${s.value}' (${s.freq})`).join(', ')}.`);
        else recommendations.push(`No values indexed yet (the background value index may not have run).${dim.values ? ` Declared values: ${dim.values.join(', ')}.` : ''}`);
        recommendations.push(...nullRecs);
        recommendations.push(ent
          ? `Group/filter by it in metric queries via '${ent}__${col}', or reference '${col}' after a pipeline join with:'${mk}'.`
          : `Reference '${col}' after a pipeline join with:'${mk}' (build_native_model join stage).`);
        const mem = this._memoryFor([`property:${p}`]);
        return {
          property: p, model: mk, column: col, type: dim.type,
          ...(dim.values ? { declared_values: dim.values } : {}),
          description: dDescs[col],
          sample_values: samples, distinct_count: value_stats.distinct_count, total_count: value_stats.total_count,
          indexed: value_stats.indexed, value_stats, event_coverage: attrCoverage,
          indexing: this._indexHistory(p, input.recent ?? 10),
          ...(mem.length ? { memory: mem } : {}),
          recommendations: recommendations.slice(0, 3),
        };
      }
      const spec = c.eventPropertySpec(p);
      if (!spec) throw new ToolError(`unknown event property '${p}'. Discover properties via semantic_index({ event }) or ({ search }); user/experiment attributes are namespaced ('users.country')`, { stage: 'validate', field: 'property' });
      const numeric = c.eventNumericProps().includes(p);
      const complex = c.isComplexEventProp(p);
      const evs = (spec.events && spec.events.length) ? spec.events : null;
      // Pageable/orderable view of the real indexed VALUES (limit/offset/order_by/direction)
      // + NULL coverage per event + indexing freshness: ONE page = the full truth about the
      // column (meaning, values, completeness, profiling recency).
      const { samples, value_stats } = this._valueListing(p, input);
      const { nulls, coverage, recs: nullRecs } = this._nullCoverage(p, evs);
      Object.assign(value_stats, nulls);
      const dc = value_stats.distinct_count;
      // Drill-down guidance: keep exploring the VALUES — trace them across the catalog,
      // and pivot to the event(s) that carry this property (≤4 concrete next moves).
      const recommendations = [];
      if (samples.length) {
        recommendations.push(`${dc != null ? `${dc} distinct values; ` : ''}top: ${samples.slice(0, 5).map((s) => `'${s.value}' (${s.freq})`).join(', ')}.`);
        if (value_stats.has_more) recommendations.push(`More values exist — page with semantic_index({ property: '${p}', offset: ${(input.offset ?? 0) + (input.limit ?? 10)} }), or re-order with order_by:'value'.`);
        recommendations.push(`Trace any of these values across the catalog (which other properties/events carry it): semantic_index({ search: '<value>' }).`);
      } else if (complex) {
        recommendations.push(`Complex (${spec.type}) property — its values are nested; explore the carrying event(s) for context.`);
      } else {
        recommendations.push(`No values indexed yet (the background value index may not have run).${dc != null ? ` distinct_count is ${dc}.` : ''}`);
      }
      recommendations.push(...nullRecs);
      if (evs) recommendations.push(`Carried by event(s) ${evs.join(', ')} — see everything they carry: semantic_index({ event: '${evs[0]}' }).`);
      // Unit-aware cast hint: a numeric-in-meaning value (declared unit) physically typed
      // string must be cast before aggregation — say so HERE, before a query mixes units
      // or averages a string.
      const out = {
        property: p, type: spec.type, ...(spec.unit ? { unit: spec.unit } : {}), numeric, complex,
        events: spec.events || null, description: spec.description,
        sample_values: samples, distinct_count: dc, total_count: value_stats.total_count,
        indexed: value_stats.indexed, value_stats, event_coverage: coverage,
        indexing: this._indexHistory(p, input.recent ?? 10),
        recommendations: recommendations.slice(0, 4),
      };
      if (spec.unit && spec.type === 'string') {
        out.cast_hint = 'numeric';
        out.recommendations = [...out.recommendations.slice(0, 3), `Values are ${spec.unit} but physically typed string — add "cast":"numeric" (semantic measures) or a compute cast (pipelines) before sum/avg.`];
      }
      // Per-app split: which apps populate this property vs leave it empty (non_null=0).
      // Surfaced so the AI sees a property is app-specific before using it cross-app.
      if (c.bundleColumn()) {
        const bcov = this.valueIndex.bundleCoverage(p);
        if (bcov.length) {
          out.bundle_coverage = bcov.map((b) => ({ bundle: b.bundle, non_null: b.non_null, row_count: b.row_count }));
          const emptyApps = bcov.filter((b) => b.non_null === 0).map((b) => b.bundle);
          if (emptyApps.length && emptyApps.length < bcov.length) out.recommendations = [...out.recommendations.slice(0, 3), `EMPTY (always NULL) for app(s): ${emptyApps.join(', ')} — populated for the rest. See semantic_index({ bundle }) for an app's full populated/empty split.`];
        }
      }
      const mem = this._memoryFor([`property:${p}`]);
      if (mem.length) out.memory = mem;
      return out;
    }

    // ── { bundle }: per-app coverage — which event properties are POPULATED vs EMPTY for
    // one app (bundle id). Lets the AI skip properties that carry no data for the chosen app
    // instead of querying them blindly. Requires the anchor to designate a bundle column
    // (meta.mcp.dimension:{bundle:true}) AND the value index to have run. ──
    if (input.bundle !== undefined && input.bundle !== false) {
      if (!c.bundleColumn()) throw new ToolError('this catalog has no app/bundle dimension — mark the app column on the events fact with meta.mcp.dimension:{ bundle: true } to enable per-app coverage', { stage: 'validate', field: 'bundle' });
      const bundleId = String(input.bundle);
      const known = this.valueIndex.bundles();
      if (!known.length) {
        return { bundle: bundleId, note: 'No per-app coverage indexed yet (the background value index may not have run).', bundles: [] };
      }
      const hit = known.find((b) => b.bundle === bundleId);
      if (!hit) throw new ToolError(`unknown app '${bundleId}'. Indexed apps: ${known.map((b) => b.bundle).join(', ')}`, { stage: 'validate', field: 'bundle' });
      const cov = this.valueIndex.bundlePropertyCoverage(bundleId);
      const populated = cov.filter((r) => r.non_null > 0).map((r) => ({ property: r.property, non_null: r.non_null }));
      const empty = cov.filter((r) => r.non_null === 0).map((r) => r.property);
      return {
        bundle: bundleId,
        event_rows: hit.row_count,
        property_count: cov.length,
        populated_count: populated.length,
        empty_count: empty.length,
        // The properties that carry data for THIS app (use these); each with its non-null count.
        populated,
        // Properties that are ALWAYS NULL for this app — do NOT query them here (other apps may populate them).
        empty,
        recommendations: [
          empty.length
            ? `${empty.length} of ${cov.length} properties are EMPTY for '${bundleId}' (always NULL) — do not use them for this app: ${empty.slice(0, 8).join(', ')}${empty.length > 8 ? ', …' : ''}.`
            : `Every indexed property carries data for '${bundleId}'.`,
          `Use the ${populated.length} populated properties; drill one with semantic_index({ property: '${(populated[0] || {}).property || '<name>'}' }) (its per-app split is under bundle_coverage).`,
          known.length > 1 ? `Other apps: ${known.filter((b) => b.bundle !== bundleId).map((b) => b.bundle).slice(0, 6).join(', ')} — a property empty here may be populated there.` : `Only one app is indexed.`,
        ],
      };
    }

    // ── { search }: fuzzy discovery across events/properties/attributes/values/recipes ──
    // Owned by the CatalogSearch subsystem (src/search.js): exact substring hits first,
    // then typo/approximate matches by similarity; each carries { score, match }.
    // fuzzy:false restricts to exact substring.
    if (input.search) {
      const res = this.catalogSearch.run({ search: input.search, fuzzy: input.fuzzy !== false, limit: input.limit ?? 20 });
      // Saved findings (memory tool) matching the same word — so a fuzzy term the user once
      // used, recorded as an alias, resolves straight back to the real field it described.
      const mem = await this.memoryStore.search(input.search, { limit: 10, fuzzy: input.fuzzy !== false });
      const memHits = mem.notes.map(memoryView);
      if (memHits.length) res.memory_matches = memHits;
      // Surface a semantic-search failure here too (don't hide it just because this path
      // also returns catalog hits) — otherwise a broken embedder looks like "no memory".
      if (mem.semantic_error) res.memory_semantic_error = mem.semantic_error;
      return res;
    }

    // ── default: compact OVERVIEW (no per-property dump, no warehouse calls) ──
    const models = c.modelKeys().map((k) => {
      const m = c.getModel(k);
      const head = { key: k, role: m.role, dbt_model: m.dbt_model, description: m.description };
      if (k === c.anchor) {
        return {
          ...head, kind: 'events_fact', entities: Object.keys(m.entities || {}), time: m.time?.column,
          event_count: c.eventNames().length, property_count: c.eventProps().length,
          // Business meaning of the key events (which event = install / session / purchase),
          // so retention/conversion metrics are anchored on the RIGHT events, not a guess.
          ...(m.event_semantics ? { event_semantics: m.event_semantics } : {}),
          ...(m.partition_column ? { partition_column: m.partition_column } : {}),
        };
      }
      return { ...head, kind: 'dimension', dimension_count: Object.keys(m.dimensions || {}).length };
    });
    const exEvent = c.eventNames()[0];
    // Freshness of the value index (sample_values/cardinality across responses): lets
    // the AI distinguish "no values exist" from "the index has not run yet".
    const sync = this.valueIndex.syncStatus ? this.valueIndex.syncStatus({ recent: 1 }) : null;
    const lastSync = sync?.last_successful_run || sync?.last_run || null;
    const userModel = c.modelKeys().find((k) => c.getModel(k).role === 'users');
    const exAttr = userModel ? Object.keys(c.getModel(userModel).dimensions || {})[0] : null;
    const memCount = this.memoryStore.counts().notes;
    // Apps (bundle ids) seen during indexing — drill one with { bundle } to see which
    // properties are populated vs empty for it (skip the empties for that app).
    const bundleList = c.bundleColumn() ? this.valueIndex.bundles() : [];
    return {
      dialect: c.dialect,
      models,
      event_names: c.eventNames(),
      groupable_paths: c.reachableGroupByPaths(),
      // Saved analyst findings (the memory tool): how many are stored + how to reach them.
      // They also surface inline on the entity views/{ search } they were linked to.
      ...(memCount ? { memory: { notes: memCount, note: 'Saved findings (resolved vague terms, gotchas, sources). They surface on the linked semantic_index views and via { search }; list/manage with the memory tool.' } } : {}),
      // How attributes are REACHED: entity-qualified paths in metric queries (semantic
      // layer auto-joins), or an explicit join stage in native pipelines. The fact holds
      // only per-event columns — user/experiment attributes always come via their model.
      join_note: userModel
        ? `Paths like '${c.primaryEntityName(userModel) || 'user'}__${exAttr || 'country'}' join the '${userModel}' model by the user entity at query time (declare use_base_models: ['${userModel}'] in create_semantic_model). In native pipelines, reach the same attributes with a join stage (with: '${userModel}').`
        : null,
      value_index_status: sync ? {
        ready: (sync.indexed_properties || 0) > 0,
        indexed_properties: sync.indexed_properties,
        running: sync.running,
        seconds_since_last_sync: lastSync?.finished_at != null ? Math.round((Date.now() - lastSync.finished_at) / 1000) : null,
      } : null,
      // Apps in the data (by bundle id). Different apps populate different properties, so
      // drill one with semantic_index({ bundle }) to see what carries data for that app.
      ...(bundleList.length ? { bundles: bundleList.map((b) => ({ bundle: b.bundle, event_rows: b.row_count })) } : {}),
      enums: { agg: AGG, metric_type: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'], time_granularity: c.timeGranularities() },
      // Ready-made task templates, fetched in full via semantic_index({ recipe: id }).
      ...(this.recipes ? { recipes: this.recipes.summary().map((r) => ({ id: r.id, task_type: r.task_type, title: r.title })) } : {}),
      // The analyst PROCEDURE + IF/DO routing live behind { guide } — read it to know HOW
      // to approach a question (which tool, in what order, with what guardrails).
      guide: 'semantic_index({ guide: true }) → the analyst procedure (workflow), IF/DO routing triggers, and per-task recipes. Read it before building a query.',
      next: 'Overview only. Drill down: semantic_index({ model }) → a model\'s columns, dimension attributes (with real sample values) + physical columns; ({ event }) → the properties an event carries; ({ property }) → one property/attribute with its real value distribution (also "users.country"-style attributes); ({ search }) → events, properties, attributes, VALUES and recipes by substring; ({ recipe }) → a ready-made recipe by id; ({ guide }) → how to approach a question (workflow + routing).',
      recommendations: [
        `New to this dataset or unsure how to approach the question? semantic_index({ guide: true }) gives the workflow + IF/DO routing (which tool, in what order, with guardrails).`,
        `Start by inspecting an event's properties: semantic_index({ event: '${exEvent || '<event_name>'}' }) — it lists each property with its real sample values + cardinality.`,
        `Segmentation attributes live on the dimension models: semantic_index({ model: '${userModel || 'users'}' }) shows them with real values; drill one via semantic_index({ property: '${userModel || 'users'}.${exAttr || 'country'}' }).`,
        `Looking for a known value (a country code, an experiment name, an ad format)? semantic_index({ search: '<value>' }) tells you exactly where it lives.`,
      ],
    };
  }

  /**
   * Pageable/orderable view of one indexed key's VALUES (limit/offset/order_by/direction)
   * + descriptive stats. Shared by event-property and dimension-attribute drill-downs.
   * Over-fetches by one so has_more is accurate at the boundary (next page non-empty).
   */
  _valueListing(key, input = {}) {
    const st = this.valueIndex.stats(key);
    const dc = st?.distinctCount ?? null;
    const total = st?.totalCount ?? null;
    const orderBy = input.order_by === 'value' ? 'value' : 'freq';
    const dir = (input.direction === 'asc' || input.direction === 'desc') ? input.direction : (orderBy === 'value' ? 'asc' : 'desc');
    const limit = input.limit ?? 10;
    const offset = input.offset ?? 0;
    const fetched = this.valueIndex.listValues(key, { limit: limit + 1, offset, by: orderBy, dir });
    const has_more = fetched.length > limit;
    const samples = has_more ? fetched.slice(0, limit) : fetched;
    // top_value is the single most frequent value; share = its fraction of indexed rows.
    const top = this.valueIndex.sampleValues(key, 1)[0] || null;
    const value_stats = {
      distinct_count: dc, total_count: total,
      top_value: top ? top.value : null, top_freq: top ? top.freq : null,
      top_share: top && total ? Math.round((top.freq / total) * 1000) / 1000 : null,
      indexed: !!st, indexed_at: st?.indexedAt ?? null,
      // values stored are capped (top-by-frequency); paging past them returns [].
      returned: samples.length, limit, offset, order_by: orderBy, direction: dir,
      has_more,
    };
    return { samples, value_stats };
  }

  /** Compact row for a property's per-run indexing record. */
  _indexPropRow(r) {
    return { property: r.property, ms: r.ms, values: r.values_written, distinct_count: r.distinct_count, total_count: r.total_count, status: r.status, ...(r.error ? { error: r.error } : {}) };
  }

  /**
   * NULL coverage of one indexed key (from the latest sync): overall null counts +
   * a per-event_name breakdown. A property is NULL on events it does not apply to —
   * each event is annotated with `applies` (from meta.mcp.events) so EXPECTED nulls
   * are distinguishable from real data gaps. Returns null fields when not indexed.
   */
  _nullCoverage(key, declared) {
    const st = this.valueIndex.stats(key);
    const rowCount = (st && st.totalCount != null && st.nullCount != null) ? st.totalCount + st.nullCount : null;
    const frac = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
    const nulls = { non_null_count: st?.totalCount ?? null, null_count: st?.nullCount ?? null, row_count: rowCount, null_fraction: (st?.nullCount != null && rowCount) ? frac(st.nullCount, rowCount) : null };
    const declaredSet = declared ? new Set(declared) : null;
    const coverage = this.valueIndex.coverage(key).map((e) => ({
      event_name: e.event_name, row_count: e.row_count, non_null: e.non_null, null_count: e.null_count,
      null_fraction: frac(e.null_count, e.row_count), applies: declaredSet ? declaredSet.has(e.event_name) : true,
    }));
    const gaps = coverage.filter((e) => e.applies && e.null_count > 0);
    const recs = [];
    if (nulls.null_count != null && nulls.row_count) recs.push(`${nulls.null_count} of ${nulls.row_count} rows are NULL (${nulls.null_fraction != null ? Math.round(nulls.null_fraction * 100) : '?'}%)${declared ? `; the property applies to events: ${declared.join(', ')}` : ''}.`);
    if (gaps.length) recs.push(`Possible data gaps: ${gaps.slice(0, 5).map((g) => `${g.event_name} (${g.null_count}/${g.row_count} NULL)`).join(', ')} — these events SHOULD carry '${key}' but have NULLs.`);
    else if (declaredSet && coverage.length) recs.push(`NULLs outside the applicable events are expected (the property is only populated on ${declared.join(', ')}).`);
    return { nulls, coverage, recs };
  }

  /** Per-sync indexing history of one key: { runs, avg_ms, history } (most recent first). */
  _indexHistory(key, recent = 10) {
    const history = this.valueIndex.propertyHistory(key, { limit: recent }).map((r) => ({ run_id: r.run_id, started_at: r.started_at, ...this._indexPropRow(r) }));
    const timed = history.filter((r) => r.ms != null);
    return { runs: history.length, avg_ms: timed.length ? Math.round(timed.reduce((s, r) => s + r.ms, 0) / timed.length) : null, history };
  }

  /** semantic_index({ run }): per-property breakdown within one sync run (slowest first). */
  _indexRun(input) {
    const run = this.valueIndex.runById(input.run);
    if (!run) throw new ToolError(`unknown index run '${input.run}'. See semantic_index({ status: true }).value_index.recent_runs[].id`, { stage: 'validate', field: 'run' });
    const props = this.valueIndex.runProperties(input.run).map((r) => this._indexPropRow(r));
    return {
      run: { id: run.id, started_at: run.started_at, finished_at: run.finished_at, status: run.status, properties_indexed: run.properties_indexed, values_written: run.values_written, errors: run.errors, duration_ms: (run.finished_at != null && run.started_at != null) ? run.finished_at - run.started_at : null },
      property_count: props.length,
      properties: props,
      recommendations: [props.length ? `Slowest: ${props.slice(0, 3).map((p) => `${p.property} (${p.ms}ms)`).join(', ')}. Drill into one across syncs with semantic_index({ property: '${props[0].property}' }).` : `No per-property timing recorded for run ${run.id}.`],
    };
  }

  /**
   * semantic_index({ status: true }): operational state — the value-index SYNC state
   * (last/recent refresh runs, coverage counts, whether one is in flight) plus the
   * background QUERY jobs and their statuses. Read-only, cheap; touches no warehouse.
   */
  _indexStatus(input = {}) {
    const recent = input.recent ?? 10;
    const propRow = (r) => this._indexPropRow(r);

    const sync = this.valueIndex.syncStatus ? this.valueIndex.syncStatus({ recent }) : { persisted: false, running: false, indexed_properties: 0, total_values: 0, total_runs: 0, last_run: null, last_successful_run: null, recent_runs: [] };
    const last = sync.last_successful_run || sync.last_run;
    const secsSince = last?.finished_at != null ? Math.round((Date.now() - last.finished_at) / 1000) : null;
    // Preview the slowest properties of the last run; full per-property timing via drill-down.
    const slowest = last?.id != null ? this.valueIndex.runProperties(last.id, { limit: 5 }).map(propRow) : [];

    const jobs = this.jobs.list(); // [{ query_id, status, table, context_id, age_ms }]
    const running = jobs.filter((j) => j.status === 'running');
    const byStatus = jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});

    const recommendations = [];
    if (sync.running) recommendations.push(`A value-index refresh is in progress — values/cardinality in semantic_index may still be filling in.`);
    else if (sync.total_runs === 0) recommendations.push(`The value index has not run yet — semantic_index({ property }) will show no sample_values until the first sync (it runs in the background at startup).`);
    else if (last?.status === 'error') recommendations.push(`The last value-index sync FAILED (${last.error || 'unknown error'}); sample_values may be stale or empty. Check the data source.`);
    else if (secsSince != null) recommendations.push(`Value index is ${sync.indexed_properties} properties / ${sync.total_values} values, last synced ${secsSince}s ago. Inspect a property's values via semantic_index({ property }).`);
    if (running.length) recommendations.push(`${running.length} query job(s) running — poll with get_query_result({ query_id }); semantic_index({ status }) lists them.`);
    if (slowest.length && last?.id != null) recommendations.push(`Per-property timing: semantic_index({ run: ${last.id} }) for the full breakdown, or semantic_index({ property: '${slowest[0].property}' }) for one property across syncs.`);
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
      // compile.js attaches the offending INPUT FIELD to the error — surface it so the
      // caller knows exactly which part of the declaration to fix.
      throw new ToolError(e.message, { stage: 'compile', ...(e.field ? { field: e.field } : {}) });
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
   * stage — pure schema propagation via renderPipeline, NO warehouse hit until materialize.
   * The all-at-once register_native_model path is unchanged. Lifecycle:
   * start → add_step* → (preview) → materialize | discard.
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
    return this._draftMaterialize(ctx, draft); // materialize (the final build step)
  }

  /**
   * Physical column NAMES (lowercased Set) of a source's relation, via the same
   * introspection semantic_index({ model }) uses — cached per source. null when it
   * cannot be known (no runner / relation not built / introspection failed), in which
   * case the catalog's declared columns are used as-is (grounding is skipped).
   */
  async _physicalCols(source) {
    if (!this.runner || !this.ctxs.baseProjectDir) return null;
    this._physColCache ??= new Map();
    if (this._physColCache.has(source)) return this._physColCache.get(source);
    let set = null;
    try {
      const r = await this.runner.relationColumns(this.ctxs.baseProjectDir, this.catalog.getModel(source).dbt_model);
      if (r.ok && Array.isArray(r.columns)) set = new Set(r.columns.map((c) => String(c.name).toLowerCase()));
    } catch { /* introspection unavailable → grounding skipped */ }
    this._physColCache.set(source, set);
    return set;
  }

  /** Declared source columns GROUNDED to physical truth: { cols, phantom } where phantom
   *  lists declared-but-not-materialized names (empty when grounding is unavailable). */
  _groundedDeclared(source, physSet) {
    const declared = this.catalog.modelColumns(source);
    if (!physSet) return { cols: declared, phantom: [] };
    const cols = []; const phantom = [];
    for (const c of declared) (physSet.has(c.name.toLowerCase()) ? cols : phantom).push(c);
    return { cols, phantom: phantom.map((c) => c.name) };
  }

  /** Columns available after a draft's accumulated stages (source columns when empty),
   *  grounded to the physical relation (phantom catalog columns excluded). */
  _draftColumns(draft, physSet) {
    if (!draft.stages.length) return this._groundedDeclared(draft.source, physSet).cols;
    const { columns } = renderPipeline(this.catalog, this.catalog.dialect, draft.source, draft.stages, { physicalCols: physSet });
    return [...columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }));
  }

  /**
   * WHERE conditions for a pipeline-level time_range on the source's time column.
   * Timezone-aware: with tr.timezone the boundaries are wall-clock in that zone,
   * converted to the UTC instants the warehouse stores; a date-only end is the
   * whole (local) day, next-midnight-exclusive.
   */
  _timeRangeConditions(source, tr) {
    if (!tr || !(tr.start || tr.end)) return null;
    const timeCol = this.catalog.getModel(source).time?.column;
    if (!timeCol) return null;
    if (tr.timezone && !isValidTimezone(tr.timezone)) throw new ToolError(`unknown timezone '${tr.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
    const r = resolveTimeRange(tr);
    const conditions = [];
    if (r.start) conditions.push({ column: timeCol, op: 'gte', value: r.start });
    if (r.endExclusive) conditions.push({ column: timeCol, op: 'lt', value: r.endExclusive });
    else if (r.end) conditions.push({ column: timeCol, op: 'lte', value: r.end });
    return conditions.length ? conditions : null;
  }

  /** True when some pipeline stage already bounds the source's time/partition column. */
  _stagesBoundInTime(source, stages = []) {
    const m = this.catalog.getModel(source);
    const bounds = new Set([m.time?.column, m.partition_column].filter(Boolean));
    if (!bounds.size) return true; // no time axis — nothing to bound
    return stages.some((s) => s.stage === 'where' && (s.conditions || []).some((c) => bounds.has(c.column)));
  }

  /** Accumulated stages with the draft's time_range prepended as a leading WHERE (parity with materialize). */
  _draftEffectiveStages(draft) {
    const conditions = this._timeRangeConditions(draft.source, draft.time_range);
    return conditions ? [{ stage: 'where', conditions }, ...draft.stages] : draft.stages;
  }

  _draftSteps(draft) {
    return draft.stages.map((s, i) => ({ index: i + 1, ...s }));
  }

  async _draftStart(input) {
    const ctx = input.draft_id ? this.ctxs.get(input.draft_id) : this.ctxs.create();
    const source = input.source || this.catalog.anchor;
    ctx.state.draft = { name: input.name, source, materialized: input.materialized || 'table', time_range: input.time_range || null, stages: [] };
    this.ctxs.touch(ctx.id);
    // The referenceable columns are SILENTLY grounded to the physical relation: a column
    // the catalog declares but the table lacks simply does not appear (a clean internal
    // guard) — never offered, never buildable, not called out. Only real columns exist.
    const physSet = await this._physicalCols(source);
    const { cols } = this._groundedDeclared(source, physSet);
    const resp = {
      draft_id: ctx.id, action: 'start', name: input.name, source, materialized: ctx.state.draft.materialized,
      steps: [], column_count: cols.length,
      next: 'Append stages one at a time with build_native_model({ action: "add_step", draft_id, stage }); each response shows only the columns that stage added/removed (use include_columns:true or preview for the full list).',
      recommendations: [
        `The source has ${cols.length} columns your first stage can reference; get the full list with build_native_model({ action: "start", ..., include_columns: true }) or inspect via semantic_index({ model: '${source}' }).`,
        `For an ordered funnel/path, add a match_recognize stage; for a plain transform, start with where/derive then aggregate.`,
        `When the steps look right, materialize with build_native_model({ action: "materialize", draft_id }).`,
      ],
    };
    if (input.include_columns) resp.available_columns = cols;
    return resp;
  }

  async _draftAddStep(ctx, draft, stage, includeColumns = false) {
    const physSet = await this._physicalCols(draft.source);
    const before = this._draftColumns(draft, physSet); // columns BEFORE this stage
    const trial = [...draft.stages, stage];
    try {
      renderPipeline(this.catalog, this.catalog.dialect, draft.source, trial, { physicalCols: physSet }); // validates refs/stage against PHYSICAL columns (no warehouse)
    } catch (e) {
      // Reject the step WITHOUT persisting it; the draft is left intact to retry.
      throw new ToolError(e.message, { stage: 'compile', field: 'stage' });
    }
    draft.stages = trial;
    this.ctxs.touch(ctx.id);
    const after = this._draftColumns(draft, physSet);
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
      next: 'add_step the next stage, materialize the draft, or pass include_columns:true / preview for the full column list.',
      recommendations: [...this._eventScopeWarnings(draft, stage), ...this._draftStepRecommendations(stage, after)],
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  }

  /** #3 gotcha: the just-added stage references an event-specific property whose event(s)
   *  are not scoped by an upstream where on event_name → it reads NULL elsewhere. */
  _eventScopeWarnings(draft, stage) {
    const applies = this.catalog.eventPropertyEvents(); // prop -> [event_name]
    const s = JSON.stringify(stage);
    const referenced = Object.keys(applies).filter((p) => s.includes(`"${p}"`));
    if (!referenced.length) return [];
    const evCol = this.catalog.eventNameColumn();
    const scoped = new Set(); let hasScope = false;
    for (const st of draft.stages) if (st.stage === 'where') for (const c of st.conditions || []) if (c.column === evCol) { hasScope = true; (Array.isArray(c.value) ? c.value : [c.value]).forEach((v) => scoped.add(v)); }
    const risky = referenced.filter((p) => { const evs = applies[p]; return !evs || !evs.every((e) => scoped.has(e)); });
    if (!risky.length) return [];
    const p = risky[0]; const evs = applies[p] || [];
    return [`'${p}' is populated only on event(s) ${evs.join(', ')} — ${hasScope ? 'your event_name scope does not cover all of them' : 'add an earlier where on event_name to those'}, or it reads NULL on the other rows (see semantic_index({ property: '${p}' }).event_coverage).`];
  }

  /** Stage-aware next-step hints from the just-added stage + the resulting columns. */
  _draftStepRecommendations(stage, available) {
    const recs = [];
    if (stage.stage === 'match_recognize') {
      recs.push(`The funnel columns (reached_<step>, completed, furthest_step_name, secs_<metric>) plus the carried partition key(s) are now available — join 'users' or aggregate to slice conversion (e.g. by country).`);
    } else if (stage.stage === 'aggregate') {
      recs.push(`Aggregated: the output is now group_by keys + measures (${available.slice(0, 6).map((c) => c.name).join(', ')}${available.length > 6 ? ', …' : ''}); add order_by/limit or materialize.`);
    } else if (stage.stage === 'join') {
      recs.push(`Joined columns are now referenceable; add a where to filter on them or an aggregate to roll up.`);
    } else {
      recs.push(`Reference any of available_columns in the next stage (${available.slice(0, 6).map((c) => c.name).join(', ')}${available.length > 6 ? ', …' : ''}).`);
    }
    recs.push(`Preview the SQL anytime with build_native_model({ action: "preview", draft_id }); materialize when done.`);
    return recs;
  }

  async _draftPreview(ctx, draft) {
    const dialect = this.catalog.dialect;
    const physSet = await this._physicalCols(draft.source);
    const base = { draft_id: ctx.id, action: 'preview', name: draft.name, source: draft.source, materialized: draft.materialized, dialect, steps: this._draftSteps(draft) };
    if (!draft.stages.length) return { ...base, available_columns: this._groundedDeclared(draft.source, physSet).cols, note: 'No stages yet — add_step first.' };
    const stages = this._draftEffectiveStages(draft);
    // Render ONLY the active warehouse dialect, so every response is consistent with where
    // the pipeline actually runs (bigquery → `|>`, postgres → CTEs). Grounded to physical.
    const rendered = renderPipeline(this.catalog, dialect, draft.source, stages, { physicalCols: physSet });
    return { ...base, available_columns: [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })), model_sql: rendered.sql };
  }

  async _draftMaterialize(ctx, draft) {
    if (!draft.stages.length) throw new ToolError('draft has no stages to materialize — add_step at least one stage first', { stage: 'validate', field: 'draft_id' });
    const result = await this._registerPipeline({
      name: draft.name, context_id: ctx.id, materialized: draft.materialized,
      pipeline: { source: draft.source, time_range: draft.time_range || undefined, stages: draft.stages },
    });
    delete ctx.state.draft; // materialized — clear the draft so the context holds only the built model
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
    // Timezone-aware via _timeRangeConditions (boundaries are wall-clock in tr.timezone).
    let stages = input.pipeline.stages;
    const tr = input.pipeline.time_range;
    if (tr && (tr.start || tr.end)) {
      if (!this.catalog.getModel(source).time?.column) throw new ToolError(`time_range given but source '${source}' has no time column`, { stage: 'validate', field: 'time_range' });
      const conditions = this._timeRangeConditions(source, tr);
      if (conditions) stages = [{ stage: 'where', conditions }, ...stages];
    } else if (this.catalog.requireTimeRange && !this._stagesBoundInTime(source, stages)) {
      // Cost guardrail (catalog require_time_range): an unbounded pipeline over the fact
      // would scan the whole history — demand a window unless a stage already bounds it.
      throw new ToolError(
        `this catalog requires a bounded time window (require_time_range): pass pipeline.time_range { start, end } `
        + `or add a leading where on the time/partition column. Unbounded scans over '${this.catalog.getModel(source).dbt_model}' are blocked.`,
        { stage: 'validate', field: 'time_range' },
      );
    }
    // Render ONLY the active warehouse dialect — every response is in the dialect the
    // pipeline actually runs on, never a mix. Grounded to the physical relation so a
    // phantom catalog column is rejected as "unknown column" here, not as a raw
    // warehouse error after the build.
    const physSet = await this._physicalCols(source);
    const render = () => renderPipeline(this.catalog, dialect, source, stages, { physicalCols: physSet });
    if (input.dry_run) {
      const out = render();
      const resp = {
        kind: 'pipeline', dry_run: true, model: `pipe_${input.name}`, materialized: input.materialized || 'table', dialect,
        columns: [...out.columns.keys()],
        output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
        model_sql: out.sql,
      };
      // A5: cheap volume estimate — COUNT(*) over the SOURCE within the window only
      // (no full materialize). Lets the caller size the scan before materializing.
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
      // Provenance: a custom pipeline (not a governed metric), its source, and how fresh
      // the underlying data is — so the rows are self-trustable. A sample stage makes the
      // result APPROXIMATE — flag it loudly with the safe/unsafe + how-to-get-exact note.
      provenance: { tier: 'pipeline', source, data_freshness: await this._dataFreshness(source), ...(stages.some((s) => s.stage === 'sample') ? { approximate: true } : {}) },
      ...(stages.some((s) => s.stage === 'sample') ? { sampling: samplingNote(stages.find((s) => s.stage === 'sample').percent ?? 10) } : {}),
      // A4: how to read this result again — these rows are a pipeline model, re-read
      // with get_query_result (NOT query_semantic_model, which is for metric queries).
      read_with: { tool: 'get_query_result', table: modelName, note: 'optional transform to re-slice; use query_semantic_model only for metric/semantic-layer queries, not for this pipeline model.' },
      assumptions: [
        `Pipeline materialized as a ${materialized} model (${modelName}); its rows are the result.`,
        `Re-read or re-slice it with get_query_result (table: ${modelName}, optional transform).`,
      ],
      warnings: (this.runner && rows.length === 0)
        ? [`0 rows — usually a scoping bug, not a real empty result: an over-narrow where, a property that is NULL on the events you kept, or${tr && (tr.start || tr.end) ? ' a time_range that misses the data (a date-only `end` is the whole day, next-day-exclusive)' : ' an event filter that matches nothing'}. Re-check the stages / widen the window.`]
        : [],
    };
  }

  /**
   * Data FRESHNESS of a source: the latest value of its time column (MAX), i.e. how
   * up-to-date the underlying data is — a trust signal distinct from value-index
   * freshness. Cached per source for the engine's life (best-effort; null when there
   * is no runner / time column / the query fails).
   */
  async _dataFreshness(sourceKey) {
    const base = this.ctxs.baseProjectDir;
    const m = this.catalog.getModel(sourceKey);
    const tcol = m.time?.column;
    if (!this.runner || !base || !tcol) return null;
    this._freshCache ??= new Map();
    if (this._freshCache.has(sourceKey)) return this._freshCache.get(sourceKey);
    let latest = null;
    try {
      const r = await this.runner.show(base, `SELECT MAX(${tcol}) AS latest FROM {{ ref('${m.dbt_model}') }}`, 1);
      if (r.ok && r.rows?.[0]?.latest != null) latest = String(r.rows[0].latest);
    } catch { /* freshness is best-effort */ }
    this._freshCache.set(sourceKey, latest);
    return latest;
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
      const r = resolveTimeRange(tr); // timezone-aware (same window the pipeline applies)
      const cl = [];
      if (r.start) cl.push(`${tcol} >= ${sqlLiteral(r.start)}`);
      if (r.endExclusive) cl.push(`${tcol} < ${sqlLiteral(r.endExclusive)}`);
      else if (r.end) cl.push(`${tcol} <= ${sqlLiteral(r.end)}`);
      if (cl.length) where = ` WHERE ${cl.join(' AND ')}`;
    }
    try {
      const r = await this.runner.show(base, `SELECT COUNT(*) AS n FROM {{ ref('${m.dbt_model}') }}${where}`, 1);
      if (r.ok && r.rows?.[0]) return Number(r.rows[0].n);
    } catch { /* estimate is best-effort */ }
    return null;
  }

  /**
   * ONE context-lifecycle tool (action-driven), replacing list_contexts / describe_context /
   * drop_context / delete_native_model / delete_semantic_model. Delegates to the internal
   * handlers (kept private so the all-at-once register path + tests reuse them).
   */
  async context(input) {
    this._validate('context', input);
    switch (input.action) {
      case 'list': return this.list_contexts();
      case 'describe': return this.describe_context({ context_id: input.context_id });
      case 'drop': return this.drop_context({ context_id: input.context_id });
      case 'delete_model': return this.delete_native_model({ context_id: input.context_id });
      case 'delete_semantic_model': return this.delete_semantic_model({ context_id: input.context_id, semantic_model: input.semantic_model, cascade: input.cascade });
      default: throw new ToolError(`unknown context action '${input.action}'`, { stage: 'validate', field: 'action' });
    }
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
    return { context_id: ctx.id, removed: true, model, parse: parse.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(parse.stdout, parse.stderr) } }, note: "model definition removed; the stored view may persist until the context is dropped (context({ action: 'drop' })) or the store cleans ephemeral objects" };
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
    const groupable = [...this._allowedPaths(ctx)];
    return {
      context_id: ctx.id,
      task: compiled.task,
      files: [file],
      ...(input.include_yaml ? { yaml: render.yaml } : {}),
      semantic_models: render.semanticModels,
      joined_models: ctx.state.usedModels,
      metrics: render.metricNames,
      groupable,
      parse,
      assumptions: this._assumptions(ctx),
      warnings: [],
      // Never a dead end: name the exact next call with real metric/path names.
      next: `Query it: query_semantic_model({ context_id: '${ctx.id}', metrics: [${render.metricNames.slice(0, 3).map((m) => `'${m}'`).join(', ')}], time_range: { start, end } }) — optionally group_by one of: ${groupable.slice(0, 5).join(', ')}${groupable.length > 5 ? ', …' : ''}.`,
      recommendations: [
        `Bound every query with time_range and group by a path from \`groupable\` (e.g. ${groupable.find((g) => g.includes('__')) || groupable[0] || 'metric_time'}).`,
        `Extend this task later with update_semantic_model({ context_id: '${ctx.id}', ... }); inspect it anytime with context({ action: 'describe', context_id: '${ctx.id}' }).`,
      ],
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
    return {
      context_id: ctx.id, semantic_model: modelKey, files: [file], ...(input.include_yaml ? { yaml: render.yaml } : {}),
      metrics: render.metricNames, groupable: [...this._allowedPaths(ctx)], parse, warnings: [],
      next: `Query the updated task: query_semantic_model({ context_id: '${ctx.id}', metrics: [...] }) — \`metrics\` above is the current full list.`,
    };
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
   * ONE A/B-experiment lifecycle tool (action-driven), folding in the three stat tools.
   * plan → sample_size (power/MDE), check_split → srm_check (SRM guardrail), analyze →
   * ab_test (significance). Validates the action shape, then delegates to the internal
   * handler which re-validates the exact per-metric contract. The lifecycle order
   * (plan → check_split → analyze) is the recommended sequence.
   */
  experiment(input) {
    this._validate('experiment', input);
    const { action, ...rest } = input;
    switch (action) {
      case 'plan': return this.sample_size(rest);
      case 'check_split': return this.srm_check(rest);
      case 'analyze': return this.ab_test(rest);
      default: throw new ToolError(`unknown experiment action '${action}'`, { stage: 'validate', field: 'action' });
    }
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

    // Cross-field guard the schema cannot express: for a proportion, a group's success
    // count cannot exceed its sample size (a rate > 100% is impossible). Reject it instead
    // of silently returning control_rate > 1 and a meaningless lift.
    if (metric === 'proportion') {
      for (const g of [control, ...(input.variants || [])]) {
        if (g && g.conversions != null && g.conversions > g.n) {
          throw new ToolError(`metric=proportion: conversions (${g.conversions}) cannot exceed n (${g.n}) for group '${g.label || '?'}' — a rate cannot exceed 100%`, { stage: 'validate', field: 'conversions' });
        }
      }
    }

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
        let r; let delta; let variance;
        if (metric === 'proportion') {
          need(control, ['conversions']); need(v, ['conversions']);
          r = twoProportionZTest({ controlConversions: control.conversions, controlN: control.n, variantConversions: v.conversions, variantN: v.n, alternative, confidence });
          const p1 = control.conversions / control.n; const p2 = v.conversions / v.n;
          delta = p2 - p1; variance = p1 * (1 - p1) / control.n + p2 * (1 - p2) / v.n;
        } else {
          need(control, ['mean', 'stddev']); need(v, ['mean', 'stddev']);
          r = welchTTest({ controlMean: control.mean, controlStddev: control.stddev, controlN: control.n, variantMean: v.mean, variantStddev: v.stddev, variantN: v.n, alternative, confidence });
          delta = v.mean - control.mean; variance = (control.stddev ** 2) / control.n + (v.stddev ** 2) / v.n;
        }
        // sequential: an ALWAYS-VALID p (mixture SPRT) that stays honest when the
        // experiment is checked repeatedly while running — use it for live peeking;
        // the fixed-horizon p remains the readout at the planned end.
        if (input.sequential) {
          const tau2 = input.expected_effect ? input.expected_effect ** 2 : undefined;
          const pSeq = alwaysValidP({ delta, variance, tau2 });
          r = { ...r, p_value_sequential: pSeq, significant_sequential: pSeq < 1 - confidence };
        }
        return { variant: labelOf(v, i), ...r };
      });
    }

    // Correct the p-values across the variant family (FWER via Holm, or FDR via BH)
    // so several arms don't inflate false positives; raw `significant` is kept too.
    // family_p_values: p-values of OTHER metrics in the same experiment readout —
    // included in the family so a 10-metric scorecard doesn't fish significance.
    const familyExtra = (input.family_p_values || []).filter((p) => Number.isFinite(p));
    if (correction !== 'none' && results.length > 0) {
      const adj = adjustPValues([...results.map((r) => r.p_value), ...familyExtra], correction);
      results = results.map((r, i) => ({ ...r, p_value_adjusted: adj[i], significant_adjusted: adj[i] < 1 - confidence }));
    }
    const anySig = results.some((r) => (r.significant_adjusted ?? r.significant));
    const recommendations = [
      `Trust significant_adjusted (multiplicity-corrected${familyExtra.length ? `, family includes ${familyExtra.length} other metric(s)` : ''}) over raw significant.`,
      ...(input.sequential ? ['p_value_sequential is valid under repeated peeking; the fixed-horizon p_value is only valid at the planned sample size.'] : ['Peeking at a RUNNING experiment with fixed-horizon p-values inflates false positives — pass sequential:true for an always-valid p.']),
      ...(anySig ? [] : ['No significant lift: check power with experiment({ action: "plan", ... }) before calling it a true null — and verify the split with experiment({ action: "check_split", ... }) if you have not.']),
    ];
    return { ok: true, metric, confidence, alternative, correction, control: labelOf(control, -1), ...extra, results, recommendations };
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
    // Report its model name and the output columns you can read. Read it via
    // get_query_result. The columns are grounded to the real relation below.
    if (ctx.state.engine === 'pipeline') {
      const n = ctx.state.native || {};
      let columns = n.columns || [];
      if (this.runner && n.model) {
        const cols = await this.runner.relationColumns(this.ctxs.dir(ctx.id), n.model);
        if (cols.ok) {
          const names = new Set(cols.columns.map((col) => String(col.name).toLowerCase()));
          const declared = (n.columns || []).filter((col) => names.has(String(col).toLowerCase()));
          columns = declared.length ? declared : cols.columns.map((col) => col.name);
        }
      }
      return {
        context_id: ctx.id,
        engine: 'pipeline',
        tasks: ctx.state.tasks || [],
        models: [{ model: n.model, materialized: n.materialized, columns }],
        columns,
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

    const known = new Set(ctx.state.metrics.map((m) => m.name));
    if (!input.metrics?.length) throw new ToolError(`metrics is required for a metric query. This context defines: ${[...known].join(', ') || '(none — create metrics first)'}`, { stage: 'validate', field: 'metrics' });
    for (const m of input.metrics) if (!known.has(m)) throw new ToolError(`unknown metric in context: '${m}'. Available: ${[...known].join(', ') || '(none)'}`, { stage: 'validate', field: m });

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

    // Cost guardrail (catalog require_time_range): block unbounded scans over the fact.
    if (this.catalog.requireTimeRange && !input.time_range?.start) {
      throw new ToolError('this catalog requires a bounded time window (require_time_range): pass time_range { start, end } to prune partitions', { stage: 'validate', field: 'time_range' });
    }
    // Timezone-aware boundaries: time_range.timezone reads start/end as wall-clock in
    // that IANA zone and converts them to the UTC instants the warehouse stores.
    if (input.time_range?.timezone && !isValidTimezone(input.time_range.timezone)) {
      throw new ToolError(`unknown timezone '${input.time_range.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
    }
    const bounds = resolveTimeRange(input.time_range) || {};
    // Window honesty: warn when unbounded or when the window reaches into today
    // (the trailing bucket is incomplete) — so partial periods are never reported silently.
    const windowWarnings = timeRangeWarnings(input.time_range);

    const limit = input.limit ?? 1000;
    const offset = input.offset ?? 0;
    // Over-fetch one extra row so `has_more` is meaningful (H2): without the +1,
    // res.rows is capped at limit+offset and has_more can never be true.
    const qopts = { metrics: input.metrics, groupBy, where, orderBy, startTime: bounds.start ?? undefined, endTime: bounds.end ?? undefined, limit: limit + offset + 1 };
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
    const page = { limit, offset, has_more: res.rows.length > offset + limit };
    const fresh = await this._dataFreshness(this.catalog.anchor);
    // Situational recommendations: surface a risk ONLY when it is actually present.
    const recs = [];
    // #1 STALENESS/incompleteness: the window reaches past the latest data → empty/partial tail.
    if (fresh) {
      const freshDay = String(fresh).slice(0, 10);
      const endDay = input.time_range?.end ? String(input.time_range.end).slice(0, 10) : null;
      if (!endDay || endDay > freshDay) recs.push(`Data is current only through ${freshDay} (latest event time)${endDay ? `, but your window ends ${endDay}` : ' and your window has no end'} — rows past ${freshDay} are empty/partial.`);
    }
    // #2 ZERO/degenerate result: almost always a scoping bug, not a real "0".
    if (pageRows.length === 0) recs.push('0 rows — usually an over-scoped where, a group_by with no data in this window, or a measure on a property that is NULL for the scoped events. Widen time_range, re-check the filter, or inspect the property coverage via semantic_index({ property }).');
    // #4 NON-ADDITIVE distinct across time → prefer HLL sketches (mergeable).
    const distinctMeasures = new Set();
    for (const add of Object.values(ctx.state.additions || {})) for (const mm of add.measures || []) if (mm.agg === 'count_distinct') distinctMeasures.add(mm.name);
    const usesDistinct = distinctMeasures.size && input.metrics.some((name) => { const metric = ctx.state.metrics.find((x) => x.name === name); return metric && [...distinctMeasures].some((dm) => metricUsesMeasure(metric, dm)); });
    if (usesDistinct && groupBy.some((g) => String(g).startsWith('metric_time__'))) {
      recs.push('count_distinct is NOT additive across time buckets — do not sum the per-bucket values for a period total. Prefer HLL sketches (a build_native_model pipeline: hll_init per bucket → hll_merge to combine): a high-accuracy distinct count that IS mergeable/re-aggregatable across buckets and segments. Or query the whole period without the time grain.');
    }
    if (page.has_more) recs.push(`More rows exist — page with offset: ${offset + limit} (same query), or add order_by + a tighter limit.`);
    recs.push('Re-slice or persist: pass materialize:true to keep the result as a table readable via get_query_result; group differently or compare segments by re-querying with another group_by.');
    return {
      ok: true,
      command: res.command,
      columns: res.columns,
      rows: pageRows,
      row_count: pageRows.length,
      page,
      // Provenance so the result is self-trustable: which tier produced it, the source,
      // and how fresh the underlying data is (latest event time).
      provenance: { tier: 'governed_metric', metrics: input.metrics, source: this.catalog.anchor, data_freshness: fresh },
      warnings: windowWarnings,
      recommendations: recs,
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
      return { ok: true, status: 'ready', table, ...extra, sampled: true, sampling: samplingNote(samplePercent), columns: res.columns, rows: res.rows, row_count: res.rows.length, ...(transform ? { projected: true } : {}) };
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

/**
 * Presentation shape for a stored memory note: decode the canonical "<kind>:<key>" targets
 * back into typed { kind, key } objects, expose the note/aliases/links, and stamp the time.
 */
function memoryView(e) {
  const targets = (e.targets || []).map((t) => { const i = String(t).indexOf(':'); return i > 0 ? { kind: t.slice(0, i), key: t.slice(i + 1) } : { kind: 'term', key: String(t) }; });
  return {
    id: e.id,
    note: e.note,
    ...(e.question ? { question: e.question } : {}),
    ...(targets.length ? { about: targets } : {}),
    ...(e.aliases && e.aliases.length ? { aliases: e.aliases } : {}),
    ...(e.links && e.links.length ? { links: e.links } : {}),
    recorded_at: e.created_at ? new Date(e.created_at).toISOString() : null,
  };
}

/**
 * The mandatory APPROXIMATE warning attached to any result computed over a random
 * sample: what it is safe for, what it is NOT, and how to get the exact answer. So the
 * caller is never misled into acting on a sampled number, and always has the choice.
 */
function samplingNote(percent) {
  return {
    approximate: true,
    sample_percent: percent,
    why: `These rows were computed over a ~${percent}% RANDOM sample of the source for a FAST directional read — NOT the full population.`,
    safe_for: 'getting the shape/direction: top categories, rough proportions, whether a segment is non-trivial, sanity-checking a pipeline before a full run.',
    not_reliable_for: 'exact totals/counts, rates near 0 or 1, small segments, distinct counts, or ranking values that are close — sampling error can change or flip these.',
    get_exact: 'For a number you will act on, re-run WITHOUT sampling (omit the sample stage, or pass sample:false) to compute over ALL the data.',
  };
}
