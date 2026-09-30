// SEMANTIC_INDEX — the catalog as the model reads it: the overview, each view (an events source, an
// event, a property's values, a model, the guides and recipes), and the value index's state behind
// them. Read-only; methods of the Engine (src/engine/helpers.js — mixin).

import { ToolError } from '../validate.js';
import { MEASURE_AGGS } from '../catalog.js';
import { frameProfile } from '../python-model.js';
import { CatalogSearch } from '../search.js';
import { buildGuide } from '../guide.js';
import { pythonAuthoringGuide } from '../python-guide.js';
import { SUPPORTED_DIALECTS } from '../dialects/index.js';
import { memoryView } from '../engine/helpers.js';

export const semanticIndexMethods = {
  // Not a tool of its own — reached through semantic_index({ recipe }) and the skills.
  get_recipe(input) {
    if (!this.recipes) throw new ToolError('recipes are not configured on this server', { stage: 'validate', field: 'recipe' });
    const r = this.recipes.get(input.id);
    // A recipe ships as ONE payload for every catalog, but whether a join needs a point-in-time
    // window is a property of THIS catalog's schema — so the payload is fitted to it before it is
    // handed over, and what was fitted is said out loud.
    const { payload, fitted } = this._fitRecipePipeline(r.register_payload);
    // A recipe is a reusable BUILDING BLOCK: a ready payload for a task family PLUS `hack`
    // — the generalizable technique to adapt it to a novel question.
    return {
      ...r,
      ...(payload ? { register_payload: payload } : {}),
      ...(fitted.length ? { fitted_to_catalog: fitted } : {}),
      naming_note: 'Metric/measure names are namespaced by the task name: query them as <task>_<metric> (the example_queries already use the full names).',
      building_block: 'This is a reusable template: take its `hack` (the technique) and adapt the payload to your exact question; feed a pipeline payload through build_pipeline_model, a create_payload through build_semantic_model.',
    };
  },

  /**
   * Fit a recipe's pipeline payload to THIS catalog. A recipe is written once for every
   * deployment, but a join it declares may or may not need a point-in-time window: that depends on
   * whether the joined model keeps several versions per key HERE. Left unfitted, the shipped
   * payload runs as-is and fans out to every historical version — plausible numbers, inflated.
   *
   * Only the window is filled in, and only where the catalog says one is required; the moment it
   * pins is the source's own event time, which is what `_joinCompletenessWarnings` recommends for
   * a hand-written join. Every change is reported so the caller sees it rather than discovering a
   * payload that does not match the recipe text.
   */
  _fitRecipePipeline(payload) {
    const fitted = [];
    const stages = payload?.pipeline?.stages;
    if (!Array.isArray(stages)) return { payload: null, fitted };
    const source = payload.pipeline.source;
    // A recipe is shipped for every deployment, so it may name a source THIS catalog does not have.
    // getModel throws on an unknown key, and the recipe view would then fail outright instead of
    // showing the recipe (the caller can still read it and adapt it). Fitting is best-effort.
    let eventTime = null;
    if (source) { try { eventTime = this.catalog.getModel(source)?.time?.column || null; } catch { eventTime = null; } }
    const next = stages.map((st) => {
      if (st?.stage !== 'join' || st.between || !st.with || !eventTime) return st;
      let m; try { m = this.catalog.getModel(st.with); } catch { return st; }
      if (!m?.scd) return st;
      const from = Object.entries(m.dimensions || {}).find(([, d]) => d.validity === 'start')?.[0];
      const to = Object.entries(m.dimensions || {}).find(([, d]) => d.validity === 'end')?.[0];
      if (!from || !to) return st;
      fitted.push(`join with '${st.with}': added between { value: '${eventTime}', from: '${from}', to: '${to}' } — '${st.with}' keeps several versions per key in this catalog, so without the window every row would match every historical version and the counts would inflate.`);
      return { ...st, between: { value: eventTime, from, to } };
    });
    return { payload: fitted.length ? { ...payload, pipeline: { ...payload.pipeline, stages: next } } : null, fitted };
  },

  /**
   * THE semantic index: one progressive view over everything the data means AND how
   * well it is indexed. The events fact carries ~150 event-scoped properties, so
   * dumping everything at once is wasteful. Call with NO arguments for a compact
   * OVERVIEW, then drill down:
   *   { model }    → one model's entities/time/dimensions (with real values) + physical columns
   *   { source, event } → only the properties POPULATED on that event (what you can use)
   *   { source, property } → one property/attribute: spec + real value distribution + NULL
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
    // The view contract IS the schema: one branch per view, each listing exactly the fields it
    // takes and the vocabulary it accepts. Two views at once, a paging field on a view that does
    // not page, a name a source does not carry — none of it can be written down, so none of it is
    // re-checked here.

    // ── operational views (sync state / one run) ──
    if (input.run != null) return this._indexRun(input);
    if (input.status) return this._indexStatus(input);

    // ── { guide }: the analyst procedure + routing (workflow, IF/DO triggers, per-task
    // recipes) — the generic skill knowledge served through the MCP, single-sourced. ──
    if (input.guide !== undefined && input.guide !== false) {
      return buildGuide(this.catalog, this.recipes, {
        task: typeof input.guide === 'string' ? input.guide : undefined,
        // The python authoring guide is a property of the RUNTIME this deployment submits to, so it
        // comes from the same profile the stage description and the compiled model come from.
        python: this.catalog.pythonRuntime?.available
          ? pythonAuthoringGuide(frameProfile(this.catalog.pythonRuntime, this.pythonModelConfig), this.recipes?.entriesRequiring('python_models') || [])
          : null,
        features: this.features,
      });
    }

    // ── { recipe }: one ready-made recipe by id (folded in from the old get_recipe tool) ──
    if (input.recipe) {
      if (!this.recipes) throw new ToolError('recipes are not configured on this server', { stage: 'validate', field: 'recipe' });
      return this.get_recipe({ id: input.recipe });
    }

    // ── the catalog's views, one method each; none of them is the default ──
    if (input.model) return this._indexModel(input);
    if (input.event) return this._indexEvent(input);
    if (input.property) return this._indexProperty(input);
    if (input.bundle !== undefined && input.bundle !== false) return this._indexBundle(input);
    if (input.search) return this._indexSearch(input);

    return this._indexOverview(input);
  },

  /** { model }: one model in depth — its entities, time and dimensions with real values, and the warehouse's own columns. */
  async _indexModel(input) {
    const c = this.catalog;
    const k = input.model;
    if (c.unavailableModels()[k]) {
      // Declared, but the warehouse cannot back it: say exactly why instead of describing a
      // model no tool will accept.
      const u = c.unavailableModels()[k];
      return { key: k, role: u.role, dbt_model: u.dbt_model, unavailable: true, reason: u.reason, missing_columns: u.missing, note: `'${k}' is excluded from every tool until its table carries the structural column(s) above (or exists). Fix the warehouse table or the dbt schema, then restart the server.` };
    }
    const m = c.getModel(k);
    const descs = c.columnDescriptions(k);
    const out = { key: k, role: m.role, dbt_model: m.dbt_model, description: m.description, primary_entity: c.primaryEntityName(k), entities: m.entities, time: m.time?.column };
    // Catalog-declared measures are SELF-DESCRIBING here: the name alone does not say what a
    // measure aggregates, over which expression, or in what unit — and since any column of any
    // source may declare one, this view is the only place to find out.
    // RELATIONSHIPS this model declares: the join name, the key columns on THIS side, and the
    // model the key points at. This is what makes a pipeline `join { via }` discoverable —
    // the caller names the relationship, never the columns.
    // `use` says what the caller may actually DO with each one, which the type alone does not:
    // an owned relationship has a governed path AND a pipeline join; one nobody owns but two
    // models carry is a pipeline join only (MetricFlow joins onto a unique key); one no other
    // model declares is not a join at all yet — it is a key waiting for a counterpart.
    const shared = new Set(c.joinEntityNames());
    const rels = Object.entries(c.entitiesOf(k)).map(([entity, e]) => {
      const target = c.joinTargetFor(entity);
      const use = (target && target !== k) ? 'metric query + pipeline'
        : target === k ? (shared.has(entity) ? 'owned here — other models point at it (their governed path ends here)' : "owned here (this model's identity; nothing points at it yet)")
          : shared.has(entity) ? 'pipeline only' : 'no counterpart declares it (not joinable)';
      return {
        entity, type: e.type,
        key: e.key.map((part) => part.column),
        use,
        ...(target && target !== k ? { joins: target } : {}),
        ...(target === k ? { owned_here: true } : {}),
      };
    });
    if (rels.length) {
      out.relationships = rels;
      const viaable = rels.filter((r) => r.joins);
      const pipeOnly = rels.filter((r) => r.use === 'pipeline only').map((r) => r.entity);
      const notes = [];
      if (viaable.length) notes.push(`Join with the declared relationship rather than restating columns: build_pipeline_model add_step { stage: 'join', with: '${viaable[0].joins}', via: '${viaable[0].entity}' }. In a metric query, group by { model: '${viaable[0].joins}', attribute: '<attr>'${viaable[0].entity !== c.primaryEntityName(viaable[0].joins) ? `, via: '${viaable[0].entity}'` : ''} } with use_base_models: ['${viaable[0].joins}'].`);
      // A relationship NO model owns cannot be a governed group-by path (MetricFlow joins only
      // onto a unique key) — say so here, or it looks like a missing feature at query time.
      if (pipeOnly.length) notes.push(`No model owns ${pipeOnly.map((n) => `'${n}'`).join(', ')}, so ${pipeOnly.length === 1 ? 'it has' : 'they have'} NO governed group-by path — join ${pipeOnly.length === 1 ? 'it' : 'them'} in a pipeline (via: '${pipeOnly[0]}'). That is by nature: several rows share the key, so neither side is unique on it.`);
      if (notes.length) out.join_note = notes.join(' ');
    }
    // AMOUNTS the schema marks aggregatable on this source. They fix NO function: name one as
    // a measure's `field` and choose the aggregation the question needs.
    const amounts = c.aggregatableFields(k);
    if (amounts.length) {
      out.aggregatable = amounts.map((a) => ({
        field: a.name,
        ...(a.expr !== a.name ? { expr: a.expr } : {}),
        ...(a.type ? { type: a.type } : {}),
        ...(a.unit ? { unit: a.unit } : {}),
        ...(a.label ? { label: a.label } : {}),
        ...(a.description ? { description: a.description } : {}),
      }));
      out.aggregatable_note = `Amounts, not attributes: aggregate them, do not group by them. No aggregation is fixed in the schema — pick the one the question needs: build_semantic_model({ semantic_models: [{ from: '${k}', measures: [{ name: <your name>, agg: 'sum' | 'average' | 'max' | 'min' | 'median' | 'percentile' | 'count' | 'count_distinct', field: '${amounts[0].name}' }] }] }) (percentile also takes { percentile: 0.9 }).`;
    }
    // GOVERNED measures, if the schema fixes one: a standard KPI everyone computes the same way.
    out.measures = Object.entries(m.measures || {}).map(([name, mm]) => ({
      name, agg: mm.agg, expr: mm.expr,
      ...(mm.agg_params ? { agg_params: mm.agg_params } : {}),
      ...(mm.unit ? { unit: mm.unit } : {}),
      ...(mm.label ? { label: mm.label } : {}),
      ...(mm.description ? { description: mm.description } : {}),
    }));
    // The ONE list of columns you can work with on this source (reference in where/
    // compute/group_by/order_by/match_recognize). `time` above is the default order axis.
    // It is silently grounded to the physical table below — only real columns appear.
    out.columns = c.modelColumns(k);
    const apps = c.isFact(k) && c.bundleColumn(k) ? this.valueIndex.bundles(k) : []; // the apps seen in THIS source, once
    if (c.isFact(k)) {
      out.kind = 'events_fact';
      out.event_count = c.eventNames(k).length;
      out.property_count = c.eventProps(k).length;
      if (c.facts.length > 1) {
        out.naming_note = `One of ${c.facts.length} independent events sources. Its events and payload properties are ITS OWN: address them with source: '${k}' (semantic_index({ source, event })), or build a pipeline / semantic model from '${k}' and use the names as-is.`;
      }
      if (m.event_semantics) out.event_semantics = m.event_semantics;
      // Static cost hint (no live runner needed): always constrain the partition
      // column / time axis, or the warehouse scans the whole fact.
      if (m.partition_column) {
        out.partition_column = m.partition_column;
        out.cost_hint = `The physical table is partitioned by ${m.partition_column} — ALWAYS bound queries with time_range (or a where on ${m.partition_column}/${m.time?.column || 'the time column'}) to avoid a full scan.`;
      }
      // The app/bundle dimension: groupable per event AND the axis for per-app coverage.
      if (c.bundleColumn(k)) {
        out.bundle_column = c.bundleColumn(k);
        out.bundle_note = `'${c.bundleColumn(k)}' identifies the app — group/filter by it to segment per app${apps.length ? `, and semantic_index({ bundle: '${apps[0].bundle}' }) shows which properties are populated vs EMPTY for an app (${apps.length} indexed)` : ''}.`;
      }
      out.note = `Events fact: payload fields are event-scoped properties (semantic_index({ source: '${k}', event })). The \`columns\` above are what you can reference in a native pipeline; order windows/match_recognize by \`time\` (${m.time?.column || '?'}).`;
    } else {
      // Dimension attributes WITH their real indexed values (cardinality + top 3) — the index
      // keys them by (this model, column), so each source has its own value space.
      const dims = m.dimensions || {};
      out.dimensions = Object.keys(dims).map((d) => {
        const st = this.valueIndex.stats(k, d);
        return { name: d, type: dims[d].type, description: descs[d], distinct_count: st?.distinctCount ?? null, sample_values: this.valueIndex.sampleValues(k, d, 3) };
      });
    }
    const base = this.ctxs.baseProjectDir;
    if (this.runner && base) {
      // Silent internal guard: keep ONLY columns that physically exist, so a name that is not
      // really in the table never surfaces anywhere. The physical set is cached per source
      // (_physicalCols) — this view is the AI's most frequent call and must not spawn a dbt
      // run-operation each time. Best-effort: if introspection fails, keep the declared set.
      const physSet = await this._physicalCols(k);
      if (physSet) out.columns = out.columns.filter((col) => physSet.has(col.name.toLowerCase()));
      // Data freshness: latest value of the time column (how up-to-date the data is).
      if (m.time?.column) { const fresh = await this._dataFreshness(k); if (fresh) out.data_freshness = fresh; }
    }
    out.recommendations = c.isFact(k)
      ? [
        `Drill into an event to see the properties it carries: semantic_index({ source: '${k}', event: '${c.eventNames(k)[0] || '<event_name>'}' }).`,
        `Then inspect a property's real values + frequency distribution: semantic_index({ source: '${k}', property: '<name>' }).`,
        ...(apps.length ? [`Scoping to one app? semantic_index({ source: '${k}', bundle: '${apps[0].bundle}' }) lists which properties carry data for it vs are EMPTY.`] : []),
        `Recognise a value (an ad format, a status, ...)? Trace which property/event carries it: semantic_index({ search: '<value>' }).`,
      ]
      : [
        `Drill into an attribute's full value/frequency distribution: semantic_index({ source: '${k}', property: '${Object.keys(m.dimensions || {})[0] || '<column>'}' }).`,
        `Looking for a known attribute value? semantic_index({ search: '<value>' }) tells you where it occurs.`,
      ];
    // Concrete next calls (structured) for this model.
    out.next_actions = c.isFact(k)
      ? [
        { call: `semantic_index({ source: '${k}', event: '${c.eventNames(k)[0] || '<event_name>'}' })`, why: 'see the properties an event carries (what you can measure/group/filter)' },
        ...(apps.length ? [{ call: `semantic_index({ source: '${k}', bundle: '${apps[0].bundle}' })`, why: 'for one app — which properties carry data vs are EMPTY' }] : []),
        { call: "semantic_index({ search: '<value>' })", why: 'trace a value to the property/event that carries it' },
      ]
      : [
        { call: `semantic_index({ source: '${k}', property: '${Object.keys(m.dimensions || {})[0] || '<column>'}' })`, why: "drill an attribute's full value/frequency distribution" },
        { call: "semantic_index({ search: '<value>' })", why: 'find where a known attribute value occurs' },
      ];
    // Saved findings about this model (memory tool) — surface them where they belong (compact).
    this._attachMemory(out, [{ kind: 'model', source: k }], { source: k });
    return out;
  },

  /** { source, event }: the properties populated on this event (NULL on the others). */
  _indexEvent(input) {
    const c = this.catalog;
    // The event belongs to ONE source; everything below (payload, coverage, indexed values)
    // comes from that source only. The schema pairs the two in one branch per source, so both
    // arrive named and there is nothing to resolve.
    const fact = input.source; const eventName = String(input.event);
    const numeric = new Set(c.eventNumericProps(fact));
    // DATA-DERIVED applicability: which properties are actually populated on this event (from the
    // value index), not the declared meta.mcp.events. A property with no coverage yet (unknown)
    // is kept — a cold index must not hide fields.
    const applies = this.valueIndex.appliesMap(fact, c.eventProps(fact));
    const descs = c.eventPropertyDescriptions(fact);
    const props = c.eventProps(fact).filter((p) => { const evs = applies[p]; return !evs || evs.includes(eventName); });
    const rows = props.map((p) => {
      // Compact index hint: cardinality + the top 3 real values (null/[] until indexed).
      const st = this.valueIndex.stats(fact, p);
      const spec = c.eventPropertySpec(p, fact) || {};
      return { name: p, type: spec.type, ...(spec.unit ? { unit: spec.unit } : {}), numeric: numeric.has(p), complex: c.isComplexEventProp(p, fact), description: descs[p], distinct_count: st?.distinctCount ?? null, sample_values: this.valueIndex.sampleValues(fact, p, 3) };
    });
    // Drill-down guidance: point at properties whose real values are worth inspecting
    // next (prefer ones already indexed so the AI sees data), plus value search.
    const recommendations = [];
    const withValues = rows.filter((r) => !r.complex && r.sample_values.length);
    const pick = (withValues.length ? withValues : rows.filter((r) => !r.complex)).slice(0, 3);
    if (pick.length) recommendations.push(`Drill into a property's real values + full frequency distribution: ${pick.map((r) => `semantic_index({ source: '${fact}', property: '${r.name}' })`).join(', ')}.`);
    if (withValues.length) recommendations.push(`Spot a value you recognise in the samples above? Find every property/event it occurs in: semantic_index({ search: '<value>' }).`);
    if (rows.some((r) => r.complex)) recommendations.push(`Complex (array/struct) properties carry nested values — semantic_index({ source: '${fact}', property }) shows the shape before you explore inside them.`);
    if (!props.length) {
      // No payload at all (e.g. first_launch) is NOT a dead end: the event's value is
      // its OCCURRENCE — say what it is good for instead of returning an empty page.
      const sem = c.getModel(fact).event_semantics || {};
      const role = Object.entries(sem).find(([, ev]) => ev === eventName)?.[0];
      recommendations.push(`'${input.event}' carries no event-specific payload — its value is the occurrence itself${role ? ` (it is the ${role.replace(/_/g, ' ')})` : ''}: use it as a measure base (count / count_distinct of the user key, event_name: ['${input.event}']) for retention, conversion or funnel metrics.`);
    }
    if (!recommendations.length) recommendations.push(`Inspect any property's real values with semantic_index({ source: '${fact}', property }).`);
    // Per-app helper: these properties may be empty for some apps — point at the bundle view.
    if (c.bundleColumn(fact) && this.valueIndex.bundles(fact).length > 1) recommendations.push(`Multiple apps emit events — a property here can be EMPTY for some of them; semantic_index({ source: '${fact}', bundle: '<app>' }) shows the populated-vs-empty split per app.`);
    const nextActions = [
      ...(pick.length ? [{ call: `semantic_index({ source: '${fact}', property: '${pick[0].name}' })`, why: "drill this property's real value distribution + completeness" }] : []),
      { call: "semantic_index({ search: '<value>' })", why: 'trace a value seen above to every property/event carrying it' },
      ...(c.bundleColumn(fact) && this.valueIndex.bundles(fact).length > 1 ? [{ call: `semantic_index({ source: '${fact}', bundle: '<app>' })`, why: 'a property here may be EMPTY for some apps — see the per-app split' }] : []),
    ];
    const eventOut = {
      event: input.event,
      source: fact,
      property_count: props.length,
      properties: rows,
      next_actions: nextActions,
      recommendations: recommendations.slice(0, 4),
    };
    this._attachMemory(eventOut, [{ kind: 'event', source: fact, name: eventName }], { source: fact, name: eventName });
    return eventOut;
  },

  /** { source, property }: one property's full spec, its values, NULL coverage per event and indexing history. */
  _indexProperty(input) {
    const c = this.catalog;
    // The SOURCE is a separate argument and the view has no source-less spelling: the schema
    // pairs each column with the model that carries it, so both arrive named.
    const pSource = input.source; const p = String(input.property);
    // The enum normally makes an unknown name unwritable — but a source that declares NOTHING
    // yet (a table whose columns have not been introspected) has no enum to project, and the
    // field degrades to an open string. Answer that with the catalog's own refusal instead of
    // reading `.type` off a column that is not there.
    const kind = c.attributeKind(pSource, p);
    if (!kind) {
      const known = c.propertyEnumFor(pSource);
      throw new ToolError(`'${p}' is not a property or attribute of '${pSource}'.${known.length ? ` It carries: ${known.slice(0, 20).join(', ')}${known.length > 20 ? `, … (${known.length} in all)` : ''}.` : ' It declares no columns at all.'}`, { stage: 'validate', field: 'property' });
    }
    if (kind !== 'property') {
      const mk = pSource; const col = p;
      const dim = (c.getModel(mk).dimensions || {})[col];
      const dDescs = c.columnDescriptions(mk);
      const { samples, value_stats } = this._valueListing(mk, col, input);
      // NULL coverage + indexing freshness make this ONE page the full truth about the
      // column: meaning, values, completeness, and how recently it was profiled.
      // (event_coverage is [] here — attributes live on the dimension model, not on
      // events — but the SHAPE matches the event-property page exactly.)
      const { nulls, coverage: attrCoverage, recs: nullRecs } = this._nullCoverage(mk, col);
      Object.assign(value_stats, nulls);
      const ent = c.primaryEntityName(mk);
      const recommendations = [];
      if (samples.length) recommendations.push(`${value_stats.distinct_count != null ? `${value_stats.distinct_count} distinct values; ` : ''}top: ${samples.slice(0, 5).map((s) => `'${s.value}' (${s.freq})`).join(', ')}.`);
      else recommendations.push('No values indexed yet (the background value index may not have run).');
      if (value_stats.values_capped) recommendations.push(`Only the top ${value_stats.indexed_value_count} of ${value_stats.distinct_count} distinct values are indexed — a RARE value may be absent; verify a "not found" with a direct query, do not assume it does not exist.`);
      recommendations.push(...nullRecs);
      // A metric query names the attribute STRUCTURALLY — { model, attribute } — and the old
      // '<entity>__<attr>' path string is refused by the schema, so it must not be recommended.
      // `via` is needed exactly where the query resolver asks for it: a source carrying SEVERAL
      // relationships to this model. Which source the caller will query from is not known here,
      // so each such source is named with its choices — the same candidates the resolver lists.
      const several = c.modelKeys().filter((src) => src !== mk)
        .map((src) => [src, Object.keys(c.entitiesOf(src)).filter((e) => c.joinTargetFor(e) === mk)])
        .filter(([, rels]) => rels.length > 1);
      const viaHint = several.length ? `; from ${several.map(([src, rels]) => `'${src}' add via: one of ${rels.map((r) => `'${r}'`).join(', ')}`).join(', from ')}` : '';
      recommendations.push(ent
        ? `Group/filter by it in metric queries as { model: '${mk}', attribute: '${col}' } (declare use_base_models: ['${mk}']${viaHint}), or reference '${col}' after a pipeline join with:'${mk}'.`
        : `Reference '${col}' after a pipeline join with:'${mk}' (build_pipeline_model join stage).`);
      const attrOut = {
        property: col, source: mk, model: mk, column: col, type: dim.type,
        description: dDescs[col],
        sample_values: samples, distinct_count: value_stats.distinct_count, total_count: value_stats.total_count,
        indexed: value_stats.indexed, value_stats, event_coverage: attrCoverage,
        indexing: this._indexHistory(mk, col, input.recent ?? 3),
        recommendations: recommendations.slice(0, 3),
      };
      this._attachMemory(attrOut, [{ kind: 'property', source: mk, name: col }], { source: mk, name: col });
      return attrOut;
    }
    const propFact = pSource; const propName = p;
    const spec = c.eventPropertySpec(propName, propFact);
    const numeric = c.eventNumericProps(propFact).includes(propName);
    const complex = c.isComplexEventProp(propName, propFact);
    // Applicability is DATA-DERIVED from the value index (which events actually carry this
    // property), NOT the declared meta.mcp.events. null = not indexed yet ⇒ unknown.
    const evs = this.valueIndex.appliesEvents(propFact, propName);
    // Pageable/orderable view of the real indexed VALUES (limit/offset/order_by/direction)
    // + NULL coverage per event + indexing freshness: ONE page = the full truth about the
    // column (meaning, values, completeness, profiling recency).
    const { samples, value_stats } = this._valueListing(propFact, propName, input);
    const { nulls, coverage, recs: nullRecs } = this._nullCoverage(propFact, propName, { eventScoped: true });
    Object.assign(value_stats, nulls);
    const dc = value_stats.distinct_count;
    // Drill-down guidance: keep exploring the VALUES — trace them across the catalog,
    // and pivot to the event(s) that carry this property (≤4 concrete next moves).
    const recommendations = [];
    if (complex) {
      // Complex values are ~unique arrays/structs — sample_values are EXAMPLES of the shape,
      // not a frequency ranking; distinct/top-N do not apply.
      if (samples.length) recommendations.push(`${samples.length} example value(s) showing the array/struct SHAPE (not top-N by frequency; complex values are ~unique). Read them into an unnest/struct_field pipeline to work with the contents.`);
      else recommendations.push(`Complex (${spec.type}) property — no examples indexed yet (the value index may not have run); its structure is in \`items\`/\`fields\` above.`);
    } else if (samples.length) {
      recommendations.push(`${dc != null ? `${dc} distinct values; ` : ''}top: ${samples.slice(0, 5).map((s) => `'${s.value}' (${s.freq})`).join(', ')}.`);
      if (value_stats.has_more) recommendations.push(`More values exist — page with semantic_index({ source: '${propFact}', property: '${p}', offset: ${(input.offset ?? 0) + (input.limit ?? 10)} }), or re-order with order_by:'value'.`);
      recommendations.push(`Trace any of these values across the catalog (which other properties/events carry it): semantic_index({ search: '<value>' }).`);
    } else {
      recommendations.push(`No values indexed yet (the background value index may not have run).${dc != null ? ` distinct_count is ${dc}.` : ''}`);
    }
    if (value_stats.values_capped) recommendations.push(`Only the top ${value_stats.indexed_value_count} of ${dc} distinct values are indexed — a RARE value may be absent here; do NOT treat "not found" as proof it does not exist, verify with a direct query/filter.`);
    recommendations.push(...nullRecs);
    if (evs) recommendations.push(`Carried by event(s) ${evs.join(', ')} — see everything they carry: semantic_index({ source: '${propFact}', event: '${evs[0]}' }).`);
    // Unit-aware cast hint: a numeric-in-meaning value (declared unit) physically typed
    // string must be cast before aggregation — say so HERE, before a query mixes units
    // or averages a string.
    // Token-lean by default: show only the events that CARRY the property (applies:true) — the
    // full per-event table incl. always-NULL events is fetched with include_coverage:true. The
    // omitted count + the drill call are always present so the AI knows the rest exists.
    const carriers = coverage.filter((e) => e.applies);
    const coverageOmitted = coverage.length - carriers.length;
    const showFullCoverage = !!input.include_coverage;
    const historyN = input.recent ?? 3;
    const out = {
      property: p, source: propFact, type: spec.type, ...(spec.unit ? { unit: spec.unit } : {}), numeric, complex,
      // A) declared STRUCTURE of a complex value (element type / struct fields / how it is encoded),
      // so the caller knows the shape even before any example is indexed.
      ...(complex && spec.items ? { items: spec.items } : {}),
      ...(complex && spec.fields ? { fields: spec.fields } : {}),
      ...(complex && spec.encoding ? { encoding: spec.encoding } : {}),
      events: evs, description: spec.description,
      // B) for a complex property these are raw EXAMPLE values (shape), not a frequency ranking.
      ...(complex && samples.length ? { sample_note: 'examples of the value SHAPE (LIMIT sample, not top-N by frequency; complex values are ~unique)' } : {}),
      sample_values: samples, distinct_count: dc, total_count: value_stats.total_count,
      indexed: value_stats.indexed, value_stats,
      event_coverage: showFullCoverage ? coverage : carriers,
      ...(showFullCoverage || coverageOmitted <= 0 ? {} : { event_coverage_omitted: coverageOmitted }),
      indexing: this._indexHistory(propFact, propName, historyN),
      next_actions: [
        ...(evs ? [{ call: `semantic_index({ source: '${propFact}', event: '${evs[0]}' })`, why: 'see everything the carrying event(s) provide alongside this property' }] : []),
        { call: "semantic_index({ search: '<value>' })", why: 'trace one of these values across the catalog' },
        ...(value_stats.has_more ? [{ call: `semantic_index({ source: '${propFact}', property: '${p}', offset: ${(input.offset ?? 0) + (input.limit ?? 10)} })`, why: 'page further through the value distribution' }] : []),
        ...(!showFullCoverage && coverageOmitted > 0 ? [{ call: `semantic_index({ source: '${propFact}', property: '${p}', include_coverage: true })`, why: `full per-event + per-app coverage, incl. the ${coverageOmitted} event(s) where '${p}' is always NULL (hidden by default)` }] : []),
      ],
      recommendations: recommendations.slice(0, 4),
    };
    if (spec.unit && spec.type === 'string') {
      out.cast_hint = 'numeric';
      out.recommendations = [...out.recommendations.slice(0, 3), `Values are ${spec.unit} but physically typed string — add "cast":"numeric" (semantic measures) or a compute cast (pipelines) before sum/avg.`];
    }
    // Per-app split: which apps populate this property vs leave it empty (non_null=0).
    // Surfaced so the AI sees a property is app-specific before using it cross-app.
    if (c.bundleColumn(propFact)) {
      const bcov = this.valueIndex.bundleCoverage(propFact, propName);
      if (bcov.length) {
        const populated = bcov.filter((b) => b.non_null > 0);
        const empty = bcov.filter((b) => b.non_null === 0);
        if (showFullCoverage) {
          out.bundle_coverage = bcov.map((b) => ({ bundle: b.bundle, non_null: b.non_null, row_count: b.row_count }));
        } else {
          // Compact: list EVERY populated app (non_null > 0) — apps that carry the property are
          // signal — and only tally the empty (always-NULL) ones, which are the noise. The full
          // per-app split incl. the empties is behind include_coverage:true / semantic_index({ bundle }).
          out.bundle_coverage_summary = {
            populated_apps: populated.length,
            empty_apps: empty.length,
            populated: populated.map((b) => ({ bundle: b.bundle, non_null: b.non_null, row_count: b.row_count })),
          };
        }
        if (empty.length && populated.length) out.recommendations = [...out.recommendations.slice(0, 3), `Always NULL for ${empty.length} of ${bcov.length} app(s); populated for ${populated.length}. Per-app split: semantic_index({ bundle: '<app>' }) or include_coverage:true.`];
      }
    }
    this._attachMemory(out, [{ kind: 'property', source: propFact, name: p }], { source: propFact, name: p });
    return out;
  },

  /**
   * { bundle }: per-app coverage — which event properties are POPULATED vs EMPTY for one app (bundle
   * id), so the properties that carry no data for it are skipped instead of queried blindly. Needs a
   * source that designates a bundle column (meta.mcp.dimension: { bundle: true }) AND the value index
   * to have run.
   */
  _indexBundle(input) {
    const c = this.catalog;
    const withBundle = c.facts.filter((f) => c.bundleColumn(f));
    if (!withBundle.length) throw new ToolError('this catalog has no app/bundle dimension — mark the app column on an events source with meta.mcp.dimension:{ bundle: true } to enable per-app coverage', { stage: 'validate', field: 'bundle' });
    const bundleId = String(input.bundle);
    // The SOURCE is a separate argument. Coverage is measured per source — the same app emits
    // events into every source that carries it, with its own row count and its own populated /
    // empty split in each — so the view NEVER merges sources: named, it answers for that one;
    // omitted, it answers for every source that saw the app, each in its own block.
    // What was MEASURED is the truth here: every (source, app) the indexer recorded coverage for.
    const known = this.valueIndex.bundles(input.source || undefined);
    if (!known.length) {
      return { bundle: bundleId, ...(input.source ? { source: input.source } : {}), note: 'No per-app coverage indexed yet (the background value index may not have run).', bundles: [] };
    }
    const hits = known.filter((b) => b.bundle === bundleId);
    if (!hits.length) {
      const list = (xs) => xs.map((b) => `${b.source}: ${b.bundle}`).join(', ');
      throw new ToolError(`unknown app '${bundleId}'${input.source ? ` on source '${input.source}'` : ''}. Indexed apps: ${list(known)}`, { stage: 'validate', field: 'bundle' });
    }
    const block = (hit) => {
      const cov = this.valueIndex.bundlePropertyCoverage(hit.source, bundleId);
      const populated = cov.filter((r) => r.non_null > 0).map((r) => ({ property: r.property, non_null: r.non_null }));
      const empty = cov.filter((r) => r.non_null === 0).map((r) => r.property);
      return {
        source: hit.source,
        event_rows: hit.row_count,
        property_count: cov.length,
        populated_count: populated.length,
        empty_count: empty.length,
        // The properties that carry data for THIS app in THIS source (use these).
        populated,
        // Properties ALWAYS NULL for this app here — do NOT query them (another app, or the same app in another source, may populate them).
        empty,
      };
    };
    const blocks = hits.map(block);
    const others = known.filter((b) => b.bundle !== bundleId);
    const first = blocks.find((b) => b.populated.length) || blocks[0];
    const out = {
      bundle: bundleId,
      ...(blocks.length === 1 ? blocks[0] : { by_source: blocks, note: `'${bundleId}' emits into ${blocks.length} sources; coverage is reported per source and never merged.` }),
      next_actions: [
        ...(first.populated.length ? [{ call: `semantic_index({ source: '${first.source}', property: '${first.populated[0].property}' })`, why: 'drill a property that carries data for this app (per-app split under bundle_coverage)' }] : []),
        ...(others.length ? [{ call: `semantic_index({ source: '${others[0].source}', bundle: '${others[0].bundle}' })`, why: 'compare another app — a property empty here may be populated there' }] : []),
      ],
      recommendations: [
        ...blocks.map((b) => (b.empty.length
          ? `[${b.source}] ${b.empty.length} of ${b.property_count} properties are EMPTY for '${bundleId}' (always NULL) — do not use them for this app on this source: ${b.empty.slice(0, 8).join(', ')}${b.empty.length > 8 ? ', …' : ''}.`
          : `[${b.source}] Every indexed property carries data for '${bundleId}'.`)),
        `Use the populated properties; drill one with semantic_index({ source: '${first.source}', property: '${(first.populated[0] || {}).property || '<name>'}' }) (its per-app split is under bundle_coverage).`,
        others.length ? `Other apps: ${[...new Set(others.map((b) => `${b.source}: ${b.bundle}`))].slice(0, 6).join(', ')} — a property empty here may be populated there.` : 'Only one app is indexed.',
      ],
    };
    return out;
  },

  /**
   * { search }: fuzzy discovery across events, properties, attributes, values and recipes — owned by
   * CatalogSearch (src/search.js): exact substring hits first, then approximate matches by similarity,
   * each with its { score, match }; fuzzy: false keeps the exact ones only.
   */
  async _indexSearch(input) {
    const c = this.catalog;
    const res = this.catalogSearch.run({ search: input.search, fuzzy: input.fuzzy !== false, limit: input.limit ?? 20 });
    // Saved findings (memory tool) matching the same word — so a fuzzy term the user once
    // used, recorded as an alias, resolves straight back to the real field it described.
    const mem = await this.memoryStore.search(input.search, { limit: 10, fuzzy: input.fuzzy !== false });
    const memHits = mem.notes.map(memoryView);
    if (memHits.length) res.memory_matches = memHits;
    // Surface a semantic-search failure here too (don't hide it just because this path
    // also returns catalog hits) — otherwise a broken embedder looks like "no memory".
    if (mem.semantic_error) res.memory_semantic_error = mem.semantic_error;
    // Recall caveat: indexed VALUES are the top-N by frequency per property, so a search
    // for a RARE value can miss even though the value exists. Say so when nothing matched,
    // so "not found" is not mistaken for "does not exist".
    if (!(res.value_matches && res.value_matches.length)) {
      (res.recommendations ||= []).push('No indexed value matched. Indexed values are the top-N most frequent per property — a RARE value may not be indexed; confirm presence with a direct filter/query before concluding it does not exist.');
    }
    // App/bundle ids are not indexed as property VALUES, so match them here: a query that
    // hits a known app routes the AI to its per-app coverage view.
    if (c.facts.some((f) => c.bundleColumn(f))) {
      const q = String(input.search).toLowerCase();
      const bundleHits = this.valueIndex.bundles().filter((b) => b.bundle.toLowerCase().includes(q));
      if (bundleHits.length) {
        // one match per (source, app): the same app is a different row set in each source
        res.bundle_matches = bundleHits.map((b) => ({ source: b.source, bundle: b.bundle, event_rows: b.row_count, view: `semantic_index({ source: '${b.source}', bundle: '${b.bundle}' })` }));
        (res.recommendations ||= []).push(`'${input.search}' matches app(s) ${[...new Set(bundleHits.map((b) => b.bundle))].join(', ')} — semantic_index({ source, bundle }) shows which properties are populated vs EMPTY for an app in that source.`);
      }
    }
    return res;
  },

  /** The default view: a compact OVERVIEW of the catalog — no per-property dump, no warehouse calls. */
  _indexOverview(input) {
    const c = this.catalog;
  const models = c.modelKeys().map((k) => {
    const m = c.getModel(k);
    // The model description is NOT drill-able data — it carries behavioural DIRECTIVES the AI
    // must see up front (data-scope window, event-flow rules, time-metric definitions, the SCD
    // join.between rule, lowercase-name rules, …). Truncating it risks the AI never fetching the
    // rest because it "already knows enough", so the FULL prose stays in the overview verbatim.
    const head = { key: k, role: m.role, dbt_model: m.dbt_model, description: String(m.description || '') };
    if (c.isFact(k)) {
      return {
        ...head, kind: 'events_fact', entities: Object.keys(m.entities || {}), time: m.time?.column,
        event_count: c.eventNames(k).length, property_count: c.eventProps(k).length,

        // Business meaning of the key events (which event = install / session / purchase),
        // so retention/conversion metrics are anchored on the RIGHT events, not a guess.
        ...(m.event_semantics ? { event_semantics: m.event_semantics } : {}),
        ...(m.partition_column ? { partition_column: m.partition_column } : {}),
      };
    }
    return { ...head, kind: 'dimension', dimension_count: Object.keys(m.dimensions || {}).length };
  });
  const exFact = c.facts[0];
  const exEvent = c.eventNames(exFact)[0];
  // Freshness of the value index (sample_values/cardinality across responses): lets
  // the AI distinguish "no values exist" from "the index has not run yet".
  const sync = this.valueIndex.syncStatus ? this.valueIndex.syncStatus({ recent: 1 }) : null;
  const lastSync = sync?.last_successful_run || sync?.last_run || null;
  const userModel = c.modelKeys().find((k) => c.getModel(k).role === 'users');
  const exAttr = userModel ? Object.keys(c.getModel(userModel).dimensions || {})[0] : null;
  const memCount = this.memoryStore.counts().notes;
  // Apps (bundle ids) seen during indexing — drill one with { bundle } to see which
  // properties are populated vs empty for it (skip the empties for that app).
  const bundleList = c.facts.some((f) => c.bundleColumn(f)) ? this.valueIndex.bundles() : []; // [{ source, bundle, row_count }]
  return {
    dialect: c.dialect,
    models,
    // The events FACTS — independent and equal; none is a default. Every tool takes the
    // source as its own argument (optional only when there is exactly one).
    facts: c.facts,
    // Whether a pipeline may end in a `python` stage (a dbt Python model on the warehouse runtime):
    // decided from the dbt profile, so the stage is in the tool schemas only where it can run.
    python_models: c.pythonRuntime?.available
      ? {
        available: true,
        runtime: c.pythonRuntime.runtime,
        ...(c.pythonRuntime.method ? { submission_method: c.pythonRuntime.method } : {}),
        // Where the submission came from, because it decides WHICH frame API the code must be
        // written against. `submission_method` is a MODEL config — dbt's macro reads only that —
        // so a value merely inferred from the profile's settings is a guess this server then
        // writes into each generated model to make it true.
        ...(c.pythonRuntime.method_source ? { submission_method_from: c.pythonRuntime.method_source } : {}),
        ...(c.pythonRuntime.method && !c.pythonRuntime.method_declared
          ? { submission_note: `Nothing declares the submission: '${c.pythonRuntime.method}' is inferred from the profile's settings, and this server writes it into every python model it generates so the frame API and the runtime agree. Declare it where dbt itself looks — dbt_project.yml, models: +submission_method — and direct \`dbt run\` outside this server matches too.` }
          : {}),
        note: 'A pipeline may end in a `python` stage (build_pipeline_model add_step { stage: "python", … }): dbt runs it as a Python model on the warehouse runtime.',
      }
      : { available: false, reason: c.pythonRuntime?.reason, note: 'No `python` pipeline stage on this warehouse — pipelines are SQL only.' },
    // The dbt project's own semantic layer: its metrics, queried in their context without a build —
    // or why it could not be read (the project did not parse)
    ...(this.project ? { project_semantic_layer: this._projectOverview() } : {}),
    ...(this.projectError ? { project_semantic_layer: { available: false, reason: `the dbt project's own semantic models could not be read: ${this.projectError}` } } : {}),
    // The features this deployment was asked to run (src/features.js): what each offers when on,
    // and why it is not offered when it cannot run here. A feature nobody asked for is not listed.
    ...(this.featureStatus.length ? {
      features: Object.fromEntries(this.featureStatus.map((st) => {
        const f = this.features.find((x) => x.id === st.id);
        return [st.id, st.available && f?.overview ? { available: true, ...f.overview(this) } : st.available ? { available: true } : { available: false, reason: st.reason }];
      })),
    } : {}),
    // dbt connects with an adapter this server writes no SQL for, so the SQL is rendered in
    // another dialect's syntax against it — true of this deployment, and worth knowing when SQL
    // a pipeline generated is rejected by the engine that runs it.
    ...(c.dialectFallback ? { dialect_note: `dbt connects with the '${c.dialectFallback.profile_type}' adapter, which this server writes no SQL for: pipelines are rendered as ${c.dialectFallback.rendering_as} SQL${c.dialectFallback.explicit ? ' (set explicitly)' : ''}. Supported natively: ${[...SUPPORTED_DIALECTS].join(', ')}.` } : {}),
    // Declared models the warehouse cannot back (a structural column or the table is missing):
    // excluded from every tool; the reason is here so the analyst can be told what to fix.
    ...(Object.keys(c.unavailableModels()).length ? { unavailable_models: Object.fromEntries(Object.entries(c.unavailableModels()).map(([k, u]) => [k, { role: u.role, dbt_model: u.dbt_model, reason: u.reason }])), unavailable_note: 'These models are declared in the catalog but their tables lack a structural column (or do not exist), so no tool accepts them. semantic_index({ model }) on one shows what is missing.' } : {}),
    ...(c.facts.length > 1 ? { facts_note: `${c.facts.length} INDEPENDENT, equal events sources (${c.facts.join(', ')}) — each owns its events, payload properties and indexed values, and they are never mixed. Name the source you mean: semantic_index({ source, event }), build_pipeline_model({ source }), semantic_models[].from; within one source, names are used as-is. A funnel runs over ONE source, while metrics from different sources can still be compared side by side over metric_time.` } : {}),
    // Each events source lists its OWN event names — they are never merged into one list,
    // because two sources may legitimately carry the same event name.
    event_names: Object.fromEntries(c.facts.map((f) => [f, c.eventNames(f)])),
    // Every attribute a metric query can group/filter by, addressed by where it lives:
    // group_by: [{ model, attribute }] — the join is resolved from the schema, never spelled.
    groupable_attributes: c.reachableAttributes(),
    // Saved analyst findings (the memory tool): how many are stored + how to reach them.
    // They also surface inline on the entity views/{ search } they were linked to.
    ...(memCount ? { memory: { notes: memCount, note: 'Saved findings (resolved vague terms, gotchas, sources). They surface on the linked semantic_index views and via { search }; list/manage with the memory tool.' } } : {}),
    // How attributes are REACHED: addressed by the model that carries them in metric queries
    // (the semantic layer resolves the declared key and joins), or an explicit join stage in
    // native pipelines. The fact holds only per-event columns — user/experiment attributes
    // always come via their model.
    join_note: userModel
      ? `Group or filter by { model: '${userModel}', attribute: '${exAttr || 'country'}' } and the '${userModel}' model is joined by its declared key at query time (declare use_base_models: ['${userModel}'] in build_semantic_model) — never spell a join path. In native pipelines, reach the same attributes with a join stage (with: '${userModel}', via: '${c.primaryEntityName(userModel) || 'user'}').`
      : null,
    value_index_status: sync ? {
      ready: (sync.indexed_properties || 0) > 0,
      indexed_properties: sync.indexed_properties,
      running: sync.running,
      seconds_since_last_sync: lastSync?.finished_at != null ? Math.round((Date.now() - lastSync.finished_at) / 1000) : null,
    } : null,
    // Apps in the data (by bundle id). Different apps populate different properties, so
    // drill one with semantic_index({ bundle }) to see what carries data for that app.
    // Apps PER SOURCE — the same bundle id is a different row set in each source that carries it.
    ...(bundleList.length ? { bundles: bundleList.map((b) => ({ source: b.source, bundle: b.bundle, event_rows: b.row_count })) } : {}),
    enums: { agg: [...MEASURE_AGGS], metric_type: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'], time_granularity: c.timeGranularities() },
    // Ready-made task templates, fetched in full via semantic_index({ recipe: id }).
    ...(this.recipes ? { recipes: this.recipes.summary().map((r) => ({ id: r.id, task_type: r.task_type, title: r.title })) } : {}),
    // The analyst PROCEDURE + IF/DO routing live behind { guide } — read it to know HOW
    // to approach a question (which tool, in what order, with what guardrails).
    guide: 'semantic_index({ guide: true }) → the analyst procedure (workflow), IF/DO routing triggers, and per-task recipes. Read it before building a query.',
    // Machine-readable map of the drill-down views (key → when to use it), so the next call
    // can be chosen without parsing prose. Exactly one view key per call (mutually exclusive).
    views: [
      { view: 'model', arg: 'model key', when: "one model's columns/entities/time + dimension attributes with real sample values" },
      { view: 'event', arg: 'event name', when: 'the properties POPULATED on that event (what you can measure/group/filter)' },
      { view: 'property', arg: 'source + property', when: "one column's full passport: real value distribution (paged), NULL coverage, per-app split, freshness" },
      { view: 'search', arg: 'word/value', when: 'fuzzy find an event/property/attribute/VALUE/recipe/app by name or value' },
      ...(bundleList.length ? [{ view: 'bundle', arg: 'bundle id', when: 'which event properties are populated vs EMPTY for ONE app (skip the empty ones)' }] : []),
      ...(this.recipes ? [{ view: 'recipe', arg: 'recipe id', when: 'one ready-made task template in full (payload + example_queries + hack)' }] : []),
      { view: 'guide', arg: 'true | task family', when: 'HOW to approach a question: workflow + IF/DO routing + per-task recipes' },
      { view: 'status', arg: 'true', when: 'operational state: value-index sync runs + background query jobs' },
    ],
    // Concrete, ready-to-run next calls (structured: { call, why }) — pick one. Replaces a
    // prose paragraph so the model can execute the next step without parsing English.
    next_actions: [
      { call: 'semantic_index({ guide: true })', why: 'unsure how to approach the question — get the workflow + IF/DO routing first' },
      { call: `semantic_index({ source: '${exFact}', event: '${exEvent || '<event_name>'}' })`, why: "see an event's properties with real sample values + cardinality" },
      { call: `semantic_index({ model: '${userModel || 'users'}' })`, why: 'list segmentation attributes (country/platform/…) with real values' },
      ...(bundleList.length ? [{ call: `semantic_index({ source: '${bundleList[0].source}', bundle: '${bundleList[0].bundle}' })`, why: 'scope to one app in one source — which properties carry data vs are EMPTY for it' }] : []),
      { call: "semantic_index({ search: '<word or value>' })", why: 'find an event/property/attribute/value/recipe by name or value' },
    ],
    recommendations: [
      `New to this dataset or unsure how to approach the question? semantic_index({ guide: true }) gives the workflow + IF/DO routing (which tool, in what order, with guardrails).`,
      `Start by inspecting an event's properties: semantic_index({ source: '${exFact}', event: '${exEvent || '<event_name>'}' }) — it lists each property with its real sample values + cardinality.`,
      `Segmentation attributes live on the dimension models: semantic_index({ model: '${userModel || 'users'}' }) shows them with real values; drill one via semantic_index({ source: '${userModel || 'users'}', property: '${exAttr || 'country'}' }).`,
      ...(bundleList.length ? [`Working with ONE app? semantic_index({ source: '${bundleList[0].source}', bundle: '${bundleList[0].bundle}' }) lists which event properties carry data for it vs are EMPTY in that source (skip the empty ones); ${bundleList.length} app(s) are in the data.`] : []),
      `Looking for a known value (a country code, an experiment name, an ad format)? semantic_index({ search: '<value>' }) tells you exactly where it lives.`,
    ],
  };
  },

  /**
   * Pageable/orderable view of one indexed key's VALUES (limit/offset/order_by/direction)
   * + descriptive stats. Shared by event-property and dimension-attribute drill-downs.
   * Over-fetches by one so has_more is accurate at the boundary (next page non-empty).
   */
  _valueListing(source, key, input = {}) {
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
  },

  /** Compact row for a property's per-run indexing record. */
  _indexPropRow(r) {
    return { ...(r.source ? { source: r.source } : {}), property: r.property, ms: r.ms, values: r.values_written, distinct_count: r.distinct_count, total_count: r.total_count, status: r.status, ...(r.error ? { error: r.error } : {}) };
  },

  /**
   * NULL coverage of one indexed key (from the latest sync): overall null counts +
   * a per-event_name breakdown. A property is NULL on events it does not apply to —
   * each event is annotated with `applies` (OBSERVED: non-null on at least one of that event's
   * rows) so EXPECTED nulls are distinguishable from real data gaps. Nothing is declared.
   */
  _nullCoverage(source, key, { eventScoped = false } = {}) {
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
  },

  /** Per-sync indexing history of one key: { runs, avg_ms, history } (most recent first). */
  _indexHistory(source, key, recent = 10) {
    const history = this.valueIndex.propertyHistory(source, key, { limit: recent }).map((r) => ({ run_id: r.run_id, started_at: r.started_at, ...this._indexPropRow(r) }));
    const timed = history.filter((r) => r.ms != null);
    return { runs: history.length, avg_ms: timed.length ? Math.round(timed.reduce((s, r) => s + r.ms, 0) / timed.length) : null, history };
  },

  /** semantic_index({ run }): per-property breakdown within one sync run (slowest first). */
  _indexRun(input) {
    const run = this.valueIndex.runById(input.run);
    if (!run) throw new ToolError(`unknown index run '${input.run}'. See semantic_index({ status: true }).value_index.recent_runs[].id`, { stage: 'validate', field: 'run' });
    const props = this.valueIndex.runProperties(input.run).map((r) => this._indexPropRow(r));
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
        props.length ? `Slowest: ${props.slice(0, 3).map((p) => `${p.property} (${p.ms}ms)`).join(', ')}. Drill into one across syncs with semantic_index({ source: '${props[0].source || '<source>'}', property: '${props[0].property}' }).` : `No per-property timing recorded for run ${run.id}.`,
        ...(fallbacks.length ? [`${fallbacks.length} batch(es) fell back to per-property — full reason in fallbacks[].`] : []),
      ],
    };
  },

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
    // Batch-fallback events of the last run (combined scan failed → per-property, FULL reason).
    const fallbacks = (last?.id != null && this.valueIndex.runNotes) ? this.valueIndex.runNotes(last.id).map((n) => n.note) : [];

    const jobs = this.jobs.list(); // [{ task_id, tool, status, table, context_id, age_ms }]
    const running = jobs.filter((j) => j.status === 'running');
    const byStatus = jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});

    const recommendations = [];
    if (sync.running) recommendations.push(`A value-index refresh is in progress — values/cardinality in semantic_index may still be filling in.`);
    else if (sync.total_runs === 0) recommendations.push(`The value index has not run yet — semantic_index({ source, property }) will show no sample_values until the first sync (it runs in the background at startup).`);
    else if (last?.status === 'error') recommendations.push(`The last value-index sync FAILED (${last.error || 'unknown error'}); sample_values may be stale or empty. Check the data source.`);
    else if (secsSince != null) recommendations.push(`Value index is ${sync.indexed_properties} properties / ${sync.total_values} values, last synced ${secsSince}s ago. Inspect a property's values via semantic_index({ source, property }).`);
    if (running.length) recommendations.push(`${running.length} task(s) running — read one with its side's query tool — query_semantic_model({ task_id }) or query_pipeline_model({ task_id }); it waits for the task. semantic_index({ status }) lists them.`);
    if (slowest.length && last?.id != null) recommendations.push(`Per-property timing: semantic_index({ run: ${last.id} }) for the full breakdown, or semantic_index({ source: '${slowest[0].source}', property: '${slowest[0].property}' }) for one property across syncs.`);
    if (fallbacks.length) recommendations.push(`${fallbacks.length} batch(es) fell back to per-property — combined scan failed. Full reason in value_index.last_run_fallbacks[] (also semantic_index({ run: ${last.id} }).fallbacks).`);
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
  },
};
