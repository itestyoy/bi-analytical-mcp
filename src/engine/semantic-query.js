// QUERY_SEMANTIC_MODEL — a metric query is its steps: one metrics step addressed by what and where — the
// refs a metric query's group_by takes (src/schema/refs.js REF_PLACES.group_by): { source, column, via? },
// { source, property }, { semantic_model, dimension }, { entity }, metric_time — resolved to MetricFlow's
// items and run by `mf`; the where steps before it, MetricFlow's where; the read steps after it, run over
// the SQL MetricFlow compiles for it. Its SQL, plan and failures are handed back in the caller's own
// spelling. A task's layer and the project's own share one shell (the steps, window, paging, the early
// answer, the task). Methods of the Engine (src/engine/helpers.js — mixin).

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { measureRefs } from '../compile.js';
import { PARTITION_DIM, renderContext } from '../yaml-render.js';
import { whereSql, referenceComparisons } from '../predicate.js';
import { REFS, REF_PLACES, refAt, refKind } from '../schema/refs.js';
import { commonItems, resolveRef, refOf, tokenOf, columnOf, labelOf } from '../group-by-items.js';
import { formatDbtError } from '../dbt/index.js';
import { getDialect } from '../dialects/index.js';
import { renderRead, stageAt, STAGE_PLACES } from '../pipeline.js';
import { eachNode } from '../pipeline/compute.js';
import { stageDef } from '../pipeline/stages.js';
import { resolveTimeRange, timeRangeWarnings, isValidTimezone } from '../time-range.js';
import { uniqueRefs, pageBlock, samplingNote } from './helpers.js';
import { KEPT_ROWS, METRICS_STEP } from '../schema/fields.js';

/** Whether a request asks its answer to show `what` beyond the default (its `include` list). */
export const wants = (input, what) => Array.isArray(input?.include) && input.include.includes(what);

/** A ref as a call writes it — { source: 'users', column: 'country' } — for a hint or an example. */
export const refText = (ref) => `{ ${Object.entries(ref).map(([k, v]) => `${k}: ${JSON.stringify(v).replace(/"/g, '\'')}`).join(', ')} }`;

/** How a ref of `groupable` is shown in a sentence: users.country (via …), events.tier. */
const refShown = (r) => (r.source !== undefined ? `${r.source}.${r.column ?? r.property}${r.via ? ` (via ${r.via})` : ''}` : `${r.semantic_model.join(' → ')}.${r.dimension}`);

/** The sides query_model reads back: a metric query's and a stored table read's. */
const QUERY_SIDES = ['semantic', 'pipeline'];

/** A query without a metrics step reads a stored table: it takes its steps, limit and dry_run — what
 *  belongs to a metric query alone is refused, naming it. */
function readOnly(q) {
  const extra = ['time_range', 'materialize', 'include'].filter((k) => q[k] !== undefined);
  if (extra.length) throw new ToolError(`${extra.join(', ')} ${extra.length > 1 ? 'belong' : 'belongs'} to a metric query — one with a metrics step; a query without one reads the context's stored table, and takes its steps, limit and dry_run`, { stage: 'validate', field: extra[0] });
  return q;
}

export const semanticQueryMethods = {
  /** Map of task-local dimension name -> entity-qualified path (e.g. event__mon_product_id). */
  _taskDimMap(ctx) {
    const map = new Map();
    for (const [modelKey, add] of Object.entries(ctx.state.additions || {})) {
      const pe = this._catalogOf(ctx).primaryEntityName(modelKey);
      for (const d of add.dimensions || []) map.set(d.name, pe ? `${pe}__${d.name}` : d.name);
    }
    return map;
  },

  /**
   * How a query names a dimension the task declared on `model` — a column of the model { source,
   * column }, an event property of its events { source, property }, or one the task computed
   * { semantic_model: [model], dimension } — told apart by what the declared name is on the model (a
   * computed dimension takes a name no column or scalar property has — the set compileDimension refuses
   * it, src/compile.js, a declared property being scalar: a complex property's name stays free for one).
   */
  _taskDimRef(model, d, c = this.catalog) {
    const name = d._attribute;
    // a build's own table is no model of the catalog: what it carries is named by its semantic model
    if (c.models[model]?.built) return { semantic_model: [model], dimension: name };
    if (c.modelDimensionColumns(model).includes(name)) return { source: model, column: name };
    if (c.isFact(model) && c.scalarEventProps(model).includes(name)) return { source: model, property: name };
    return { semantic_model: [model], dimension: name };
  },

  /**
   * What a context can group / filter by, in the form the tools accept — the refs of a metric query's
   * group_by: the catalog's reachable columns ({ source, column, via? }) plus the dimensions the task
   * declared (a column, { source, property }, { semantic_model: [model], dimension }).
   *
   * Split by whether the ref works RIGHT NOW: a query may only name a model the context has
   * loaded, so a column of a model it has not is offered separately, with what to do about it.
   * Publishing the whole catalog as `groupable` (and picking the example from it) produced calls
   * the query path then refused — "needs model 'users', which is not loaded in this context".
   */
  _groupableSplit(ctx) {
    const c = this._catalogOf(ctx);
    // (a column of a build's own table is named by its semantic model: it is no model of the catalog)
    const all = [...c.reachableAttributes()].map((r) => (r.source !== undefined && c.models[r.source]?.built ? { semantic_model: [r.source], dimension: r.column } : r));
    for (const [model, add] of Object.entries(ctx.state.additions || {})) {
      for (const d of add.dimensions || []) {
        const ref = this._taskDimRef(model, d, c);
        if (!all.some((r) => JSON.stringify(r) === JSON.stringify(ref))) all.push(ref);
      }
    }
    const loaded = new Set(ctx.state.usedModels || []);
    const modelOf = (r) => r.source ?? r.semantic_model[0];
    return { now: all.filter((r) => loaded.has(modelOf(r))), afterLoading: all.filter((r) => !loaded.has(modelOf(r))) };
  },

  /** One wording for "here is what you CAN name, and how to reach the rest", shared by every
   *  not-reachable refusal so they never disagree about what is available. */
  _reachableHint(ctx) {
    const { now, afterLoading } = this._groupableSplit(ctx);
    const show = (rs) => rs.slice(0, 20).map(refShown).join(', ');
    const models = [...new Set(afterLoading.map((r) => r.source ?? r.semantic_model[0]))];
    return `Reachable now: ${show(now) || '(none beyond metric_time)'}.${models.length ? ` Also in the catalog, once the build's semantic_model step joins their model (join: [{ source: <model>, on }]): ${show(afterLoading)}${afterLoading.length > 20 ? ', …' : ''}.` : ''}`;
  },

  /**
   * WHAT A REF NAMES IN A TASK'S CONTEXT — the one judgement of group_by and where alike, which
   * resolves it or refuses it (`at` names it; `field` is the input field a refusal reports): the
   * kinds a metric query's group_by takes (refAt), each resolved WITHOUT the caller knowing
   * MetricFlow's `<entity>__<dimension>` spelling. → { kind: 'time' | 'dimension' | 'entity', path (the
   * dimension's or the entity's MetricFlow name), grain (a time's), column (the result column), label
   * (users.country), type (the result column's, as the steps after the query read it) }.
   */
  _taskRef(ctx, ref, at = 'group_by', field = 'group_by') {
    let kind;
    try { kind = refAt('group_by', ref, at); } catch (e) { throw new ToolError(e.message, { stage: 'validate', field }); }
    if (kind === 'time') {
      const grain = ref.grain || 'day';
      return { kind: 'time', path: 'metric_time', grain, column: `metric_time_${grain}`, label: 'metric_time', type: 'time' };
    }
    if (kind === 'entity') return this._taskEntity(ctx, ref.entity, at, field);
    if (kind === 'dimension') return this._taskComputed(ctx, ref, at, field);
    return this._taskColumn(ctx, kind, ref, at, field);
  },

  /** The models a metric of this context folds the rows of: the owner of every measure it reads,
   *  through the metrics a derived one is built from. */
  _metricModels(ctx, name) {
    const metrics = ctx.state.metrics || [];
    const m = metrics.find((x) => x.name === name);
    if (!m) return [];
    const c = this._catalogOf(ctx);
    const owner = new Map(Object.entries(ctx.state.additions || {}).flatMap(([k, a]) => (a.measures || []).map((me) => [me.name, k])));
    return [...new Set([...measureRefs(m, metrics)].map((r) => owner.get(r) || c.modelOwningMeasure(r)).filter(Boolean))];
  },

  /** Whether the columns of `model` cut the rows of `source`: its own, or those of a model a
   *  relationship of `source` points at (the one join MetricFlow makes from it). */
  _cuts(ctx, source, model) {
    if (source === model) return true;
    const c = this._catalogOf(ctx);
    const own = c.primaryEntityName(model);
    return Object.keys(c.entitiesOf(source)).some((ent) => c.joinTargetFor(ent) === model || (own && ent === own));
  },

  /** The metrics of `metrics` a dimension of `model` does not cut — a metric whose measures fold rows
   *  of a model that neither is `model` nor joins to it. */
  _uncut(ctx, model, metrics) {
    return metrics.filter((m) => this._metricModels(ctx, m).some((src) => !this._cuts(ctx, src, model)));
  },

  /** A dimension of `model` named in a query of metrics it does not cut is refused here, in the call —
   *  MetricFlow would refuse it minutes later in its own words. */
  _checkCuts(ctx, model, label, metrics, at) {
    const not = this._uncut(ctx, model, metrics);
    if (!not.length) return;
    const reads = not.map((m) => `'${m}' (it folds ${this._metricModels(ctx, m).join(', ')})`).join(', ');
    const cut = metrics.filter((m) => !not.includes(m));
    throw new ToolError(`${at}: '${label}' does not cut ${reads} — a metric is grouped by the columns of the model its measures fold and of the models that one joins to, and '${model}' is none of them${cut.length ? `; it cuts ${cut.map((m) => `'${m}'`).join(', ')}` : ''}. Query them apart (queries: [ … ] runs them side by side), or group by what every metric reaches (metric_time, a joined model's column).`, { stage: 'validate', field: 'steps' });
  },

  /** A stage of the pipeline's registry that no step of a query takes (a join, an unnest, a funnel, a
   *  python model: each makes a new table) — said with where it is built; the schema says the rest. */
  _readPlaces(steps, field) {
    if (!Array.isArray(steps)) return;
    const m = steps.findIndex((st) => st?.stage === METRICS_STEP.stage);
    for (const [i, st] of steps.entries()) {
      // (a read's own stages in the wrong place are said by the query's own check, with where they go)
      if (i === m || typeof st?.stage !== 'string' || !stageDef(st.stage) || STAGE_PLACES.read.stages.includes(st.stage)) continue;
      const place = m < 0 ? 'read' : 'metric_result';
      try { stageAt(place, st, `${field}[${i}]`); } catch (e) { throw new ToolError(e.message, { stage: 'validate', field: `${field}[${i}]` }); }
    }
  },

  /** That the dbt project's own semantic layer is queried in its own contexts — the refusal of one of
   *  its names in a task's context. */
  _projectNameHere(said, at, field) {
    return new ToolError(`${at}: ${said} is named as the dbt project's own semantic layer names it — query it in the context of the semantic model whose metrics you want (context_id: its name; semantic_index({ request: {} }) lists them); here a column is { source, column }, a declared event property { source, property }, a computed dimension { semantic_model: [<its source>], dimension }.`, { stage: 'validate', field });
  },

  /**
   * A column of a model ({ source, column, via? }) or an event property the task declared a dimension
   * ({ source, property }). A column resolves to the path the relationship the task's source declares
   * towards the model gives — or the model's own identity when it is the source's own; `via` picks the
   * relationship when the source carries several to the same model (key variants). A dimension the task
   * declared on it (a copy at another grain) is the one it names first.
   */
  _taskColumn(ctx, kind, ref, at, field) {
    const c = this._catalogOf(ctx);
    const { source: model, via } = ref;
    const name = kind === 'source_column' ? ref.column : ref.property;
    const label = `${model}.${name}`;
    if (!c.models[model]) throw new ToolError(`${at}: unknown model '${model}'. Models: ${c.modelKeys().join(', ')}${c.unavailableHint(model)}`, { stage: 'validate', field });
    // A model the context never loaded is answered with the fix (load it: semantic_models [{ source }]),
    // not with the relationship refusal below: "not loaded" is the actual problem, and it is actionable.
    this._checkModelLoaded(ctx, model, label, field, at);
    const declared = this._taskDimOf(ctx, model, name);
    const declaredRef = declared ? this._taskDimRef(model, declared, c) : null;
    if (kind === 'source_property') {
      // an event property is grouped by once the task declares it a dimension of its source
      if (declaredRef?.dimension !== undefined) throw new ToolError(`${at}: '${label}' is a dimension this task computed, not an event property — write ${refText(declaredRef)}`, { stage: 'validate', field });
      if (declaredRef?.property === undefined) {
        throw new ToolError(`${at}: the event property '${label}' is not a dimension of this context — declare it one — { property: '${name}' } in the dimensions of the build's semantic_model step (build_model({ request: { action: 'edit_step', context_id: '${ctx.id}', index, step } }), then materialize) — and name it { source: '${model}', property: '${name}' }.`, { stage: 'validate', field });
      }
      return { kind: 'dimension', path: this._taskDimMap(ctx).get(declared.name) || declared.name, grain: null, column: `${model}_${name}`, label, type: 'unknown' };
    }
    // 1. a column the step declared on this model → that dimension (a time column at the grain it was
    //    declared with)
    if (declaredRef?.column !== undefined) {
      const grain = declared.type === 'time' ? declared.type_params?.time_granularity || 'day' : null;
      return { kind: 'dimension', path: this._taskDimMap(ctx).get(declared.name) || declared.name, grain, column: `${model}_${name}`, label, type: grain ? 'time' : 'unknown' };
    }
    const target = c.getModel(model);
    // the model's own columns: its dimensions and, on an events source, the event name (one set with
    // the schema's — refColumns)
    if (!(target.dimensions || {})[name] && !c.modelDimensionColumns(model).includes(name)) {
      if (declaredRef) throw new ToolError(`${at}: '${label}' is ${declaredRef.property !== undefined ? 'an event property this task declared a dimension' : 'a dimension this task computed'}, not a column — write ${refText(declaredRef)}`, { stage: 'validate', field });
      if (c.isFact(model) && c.eventProps(model).includes(name)) throw new ToolError(`${at}: '${name}' is an event property of '${model}', not a column — { source: '${model}', property: '${name}' }, once the task declares it a dimension.`, { stage: 'validate', field });
      const known = c.modelDimensionColumns(model);
      const near = rankFuzzy(String(name), known, { fields: (x) => [x], limit: 3 }).map((x) => x.item);
      throw new ToolError(`${at}: '${name}' is not a column of '${model}'${near.length ? ` — did you mean ${near.map((x) => `'${x}'`).join(' or ')}?` : '.'} Its columns: ${known.slice(0, 20).join(', ') || '(none)'}. An event property is { source, property } and a value computed from the row { semantic_model: [<its source>], dimension }, each declared a task dimension first.`, { stage: 'validate', field });
    }
    // a time column is read at the catalog's granularity for it: MetricFlow names a time dimension's
    // column with its grain (`<path>__<grain>`), and the column comes back under the caller's name
    const dim = (target.dimensions || {})[name];
    const grain = dim?.type === 'time' ? dim.granularity || 'day' : null;
    const out = (path) => ({ kind: 'dimension', path, grain, column: `${model}_${name}`, label, type: grain ? 'time' : c.modelColumns(model).find((x) => x.name === name)?.type || 'unknown' });
    // The sources whose MEASURES this task reads: a path starts from one of them. A model loaded
    // only to be joined to (an item with only `source`) — even another events source — is a join
    // TARGET here, reached through the relationship a measure source declares towards it.
    const own = c.primaryEntityName(model);
    const sources = this._measureSources(ctx);
    // 2. a column of a model whose measures this task reads → under that model's identity
    if (sources.includes(model) && own) return out(`${own}__${name}`);
    // 3. a relationship from a measure source to the model that owns it
    const candidates = new Set();
    for (const src of sources) {
      for (const [ent] of Object.entries(c.entitiesOf(src))) if (c.joinTargetFor(ent) === model) candidates.add(ent);
    }
    // …or under its own identity: a source CARRIES that relationship by name. (`joinTargetFor(own)`
    // alone is tautological — `own` is this model's primary entity, so it always resolves back to
    // it; the question is whether any source in this context points at it.)
    if (!candidates.size && own && sources.some((src) => c.entitiesOf(src)[own])) candidates.add(own);
    if (via) {
      if (!candidates.has(via)) throw new ToolError(`${at}: '${via}' is not a relationship from this task's source(s) to '${model}'. Available: ${[...candidates].join(', ') || '(none)'}`, { stage: 'validate', field });
      return out(`${via}__${name}`);
    }
    if (candidates.size === 1) return out(`${[...candidates][0]}__${name}`);
    if (candidates.size > 1) throw new ToolError(`${at}: '${model}' is reachable through several relationships (${[...candidates].join(', ')}) — add via: '<relationship>' to say which key to join on.`, { stage: 'validate', field });
    throw new ToolError(`${at}: no source in this context declares a relationship to '${model}' (it must OWN a key some source points at — type primary/unique). Join it in the build's semantic_model step (join: [{ source: '${model}', on }]) and check semantic_index({ request: { source: '${model}' } }).relationships. ${this._reachableHint(ctx)}`, { stage: 'validate', field });
  },

  /**
   * A dimension the task COMPUTED ({ name, expr } on a model), named { semantic_model: [<the model>],
   * dimension: <its name> } — in a task's context the join comes from the schema, so the chain is the
   * model that carries it alone. A column or an event property is named where it lives in the catalog
   * ({ source, column } / { source, property }), so naming one here is refused with that spelling.
   */
  _taskComputed(ctx, ref, at, field) {
    const c = this._catalogOf(ctx);
    const chain = ref.semantic_model;
    const model = chain[chain.length - 1];
    const label = `${chain.join(' → ')}.${ref.dimension}`;
    if (!c.semanticModelKeys().includes(model)) throw this._projectNameHere(`'${label}'`, at, field);
    if (chain.length > 1) throw new ToolError(`${at}: in a task's context the join comes from the schema — name the model that carries the dimension alone: { semantic_model: ['${model}'], dimension: '${ref.dimension}' }`, { stage: 'validate', field });
    this._checkModelLoaded(ctx, model, label, field, at);
    const declared = this._taskDimOf(ctx, model, ref.dimension);
    const declaredRef = declared ? this._taskDimRef(model, declared, c) : null;
    // a column of a build's own table, which only its semantic model names: under its identity, a time
    // column at its day
    const target = c.getModel(model);
    if (target.built && !declared && c.modelDimensionColumns(model).includes(ref.dimension)) {
      const grain = target.dimensions?.[ref.dimension]?.type === 'time' ? ref.grain || 'day' : null;
      if (ref.grain !== undefined && !grain) throw new ToolError(`${at}: '${label}' is no time column — it takes no grain`, { stage: 'validate', field });
      return { kind: 'dimension', path: `${c.primaryEntityName(model)}__${ref.dimension}`, grain, column: `${model}_${ref.dimension}`, label, type: grain ? 'time' : c.modelColumns(model).find((x) => x.name === ref.dimension)?.type || 'unknown' };
    }
    if (declaredRef?.dimension === undefined) {
      const as = declaredRef || (c.modelDimensionColumns(model).includes(ref.dimension) ? { source: model, column: ref.dimension } : null);
      if (as) throw new ToolError(`${at}: '${label}' is ${as.column !== undefined ? 'a column' : 'an event property'} of '${model}', named where it lives in the catalog — write ${refText(as)}`, { stage: 'validate', field });
      const computed = (ctx.state.additions?.[model]?.dimensions || []).map((d) => this._taskDimRef(model, d, c)).filter((r) => r.dimension !== undefined).map((r) => r.dimension);
      throw new ToolError(`${at}: '${label}' is not a dimension this context computed on '${model}'. ${computed.length ? `It computed: ${computed.join(', ')}.` : 'It computed none there.'} A dimension computed from the row is declared { name, expr } in the dimensions of the build's semantic_model step.`, { stage: 'validate', field });
    }
    if (ref.grain !== undefined) throw new ToolError(`${at}: '${label}' is a computed dimension, which is categorical — it takes no grain`, { stage: 'validate', field });
    return { kind: 'dimension', path: this._taskDimMap(ctx).get(declared.name) || declared.name, grain: null, column: `${model}_${ref.dimension}`, label, type: 'unknown' };
  },

  /**
   * The entities a task's metrics can be grouped by: the keys the sources whose measures it reads carry
   * as entities of their semantic models (src/yaml-render.js). An events source's own primary entity is
   * no key — only the name its dimensions are reached under (MetricFlow's primary_entity) — so it groups
   * nothing.
   */
  _taskEntities(ctx) {
    return [...new Set(this._measureSources(ctx).flatMap((s) => this._entitiesOfSource(ctx, s)))];
  },

  /** The keys a source of measures carries — what its rows can be grouped by as entities. */
  _entitiesOfSource(ctx, s) {
    const c = this._catalogOf(ctx);
    return Object.keys(c.isFact(s) ? c.getModel(s).entities || {} : c.entitiesOf(s));
  },

  /** The entities a metric can be grouped by: the keys every model it folds carries. */
  _metricEntities(ctx, metric) {
    const models = this._metricModels(ctx, metric);
    if (!models.length) return this._taskEntities(ctx);
    return models.map((s) => this._entitiesOfSource(ctx, s)).reduce((a, b) => a.filter((e) => b.includes(e)));
  },

  /** An entity named in a query of metrics whose rows do not carry it is refused here, in the call. */
  _checkEntityCuts(ctx, entity, metrics, at) {
    const not = metrics.filter((m) => !this._metricEntities(ctx, m).includes(entity));
    if (!not.length) return;
    const cut = metrics.filter((m) => !not.includes(m));
    throw new ToolError(`${at}: the entity '${entity}' does not cut ${not.map((m) => `'${m}' (it folds ${this._metricModels(ctx, m).join(', ')}, whose rows carry ${this._metricEntities(ctx, m).join(', ') || 'no key'})`).join(', ')}${cut.length ? `; it cuts ${cut.map((m) => `'${m}'`).join(', ')}` : ''}. Query them apart (queries: [ … ] runs them side by side), or group by what every metric reaches (metric_time, a joined model's column).`, { stage: 'validate', field: 'steps' });
  },

  /** An entity — a key a source whose measures the task reads carries (_taskEntities) — grouped by as
   *  it is: one row per key value, its result column the entity's name. */
  _taskEntity(ctx, entity, at, field) {
    const c = this._catalogOf(ctx);
    const sources = this._measureSources(ctx);
    const declared = new Set(this._taskEntities(ctx));
    if (declared.has(entity)) return { kind: 'entity', path: entity, grain: null, column: entity, label: entity, type: 'unknown' };
    if (!c.modelKeys().some((k) => Object.hasOwn(c.entitiesOf(k), entity))) throw this._projectNameHere(`the entity '${entity}'`, at, field);
    throw new ToolError(`${at}: the entity '${entity}' is not one this context's metrics can be grouped by — the sources they read (${sources.join(', ') || 'none'}) declare ${[...declared].join(', ') || 'none'}`, { stage: 'validate', field });
  },

  /** The dimension a task declared on `model` for `attribute` — the one a reference resolves to first. */
  _taskDimOf(ctx, model, attribute) {
    return (ctx.state.additions?.[model]?.dimensions || []).find((d) => d._attribute === attribute) || null;
  },

  /**
   * QUERY A CONTEXT — one tool for both kinds of query, told apart by their steps: a query with a metrics
   * step computes the context's metrics (the semantic layer; the steps before it filter, the steps after
   * it work on the result); one without reads the table the context's pipeline stored, through steps of
   * the pipeline's own read stages. { task_ids } reads tasks of either kind back, { task_ids, cancel }
   * stops them, { queries } starts several — of either kind — side by side.
   */
  async query_model(input) {
    // a stage of the pipeline that a read does not take (a join, a funnel…) is said with where it is
    // built, before the schema lists only what a read takes
    this._readPlaces(input?.steps, 'steps');
    for (const [i, q] of (Array.isArray(input?.queries) ? input.queries : []).entries()) this._readPlaces(q?.steps, `queries[${i}].steps`);
    this._validate('query_model', input);
    if (input.cancel) return this._cancelTasks(input, QUERY_SIDES);
    if (input.task_ids) return this._pollTasks(input, QUERY_SIDES);
    const ctx = this._ctx(input.context_id);
    // a context that holds neither a semantic layer nor a pipeline's rows was made by another tool:
    // nothing here reads it, and saying which metrics it lacks would send the caller the wrong way
    if (!ctx.state.engine && !ctx.state.draft && !ctx.state.pipeline_model && !(ctx.state.metrics || []).length && !Object.keys(ctx.state.additions || {}).length) {
      throw new ToolError(`context ${ctx.id} holds no semantic layer and no pipeline table — a context another tool made is read by that tool's own query tool, and an emptied one has nothing to read (context({ request: { action: "describe", context_id: "${ctx.id}" } }) says what it holds)`, { stage: 'validate', field: 'context_id' });
    }
    // a metric query has a metrics step; a context that holds no pipeline table has nothing else to read,
    // so a query of it without one is a metric query too — refused there, naming the metrics it offers
    // (a draft that is only its semantic_model step is a semantic layer, with no table to read)
    const pipelineContext = ctx.state.engine === 'pipeline' || !!ctx.state.pipeline_model || (!!ctx.state.draft && !(ctx.state.draft.semantic && !ctx.state.draft.stages.length && !ctx.state.draft.base));
    const metricQuery = (q) => !pipelineContext || (q.steps || []).some((st) => st?.stage === METRICS_STEP.stage);
    // A BATCH (queries): every query is validated before any starts, and they run side by side — one
    // task each, of the kind its steps say, read together with { task_ids }.
    if (input.queries) {
      return this._startBatch(ctx, (q) => (metricQuery(q) ? 'query_semantic_model' : 'query_pipeline_model'), input.queries,
        (q) => (metricQuery(q) ? this._metricQueryWork(ctx, { ...q, context_id: ctx.id }) : this._pipelineQueryWork(ctx, readOnly(q))));
    }
    if (!metricQuery(input)) return this._startPipelineQuery(ctx, readOnly(input));
    // The project's context is never written after start (nothing is built on it) and every
    // conversation queries it: its queries run side by side, like a batch's members, instead of
    // each waiting for the one before it.
    // A query only compiled (dry_run) runs nothing on the warehouse: it waits for the
    // declaration it compiles, not behind the queries before it.
    const project = ctx.state.engine === 'project';
    const compileOnly = !!input.dry_run;
    const slot = project ? { batch: { before: null } } : compileOnly ? { batch: this.tasks.afterBuilds(ctx) } : {};
    return this._taskStarted(this._startTask(ctx, 'query_semantic_model', this._metricQueryWork(ctx, input), { input, ...slot }), { context_id: ctx.id });
  },

  /** The work of one metric query (a query with a metrics step) on `ctx`: checked now, run by its task. */
  _metricQueryWork(ctx, input) {
    // A context that holds a pipeline's table and no metrics: its rows are the result — read them with
    // steps of the pipeline's own read stages (no metrics step), or build on them from the build's task.
    if (ctx.state.engine === 'pipeline' && !(ctx.state.metrics || []).length) {
      const built = ctx.state.pipeline_model?.task_id;
      throw new ToolError(`context ${ctx.id} holds a pipeline table (${ctx.state.model}), no metrics: read its rows with query_model({ request: { context_id: '${ctx.id}', steps } }) — steps without a metrics step${built ? `, or build on them with build_model({ request: { action: 'start', name, from_task: '${built}' } })` : ''}`, { stage: 'validate', field: 'steps' });
    }
    // the dbt project's own semantic layer: its metrics and dimensions, as the project defines them
    return ctx.state.engine === 'project' ? this._projectQueryWork(ctx, input) : this._semanticQueryWork(ctx, input);
  },

  /** The tokens any metric query causes besides what it names: metric_time at every grain, and
   *  MetricFlow's alias for each metric's own column (`__<metric>`). */
  _queryTokens(metricNames) {
    const out = new Map();
    for (const g of this.catalog.timeGranularities()) out.set(`metric_time__${g}`, `metric_time_${g}`);
    for (const m of metricNames) out.set(`__${m}`, m);
    return out;
  },

  /** The tokens of every item MetricFlow listed for the metrics — a joined model's validity window, a
   *  dimension the query did not name — in the caller's spelling: `<semantic_model>_<dimension>`, the
   *  result column the same item would give, a time dimension at each grain. */
  _listedTokens(groupBys) {
    const out = new Map();
    for (const items of Object.values(groupBys || {})) {
      for (const item of items) {
        out.set(tokenOf(item), columnOf(item));
        if (item.type === 'time' && item.semantic_model) {
          out.set(item.dunder_name, `${item.semantic_model}_${item.name}`);
          for (const g of this.catalog.timeGranularities()) out.set(tokenOf(item, g), columnOf(item, g));
        }
      }
    }
    return out;
  },

  /** The name MetricFlow gives a semantic model's own time dimension inside a plan — `<dimension>__<grain>`,
   *  before any entity is prefixed — for every time dimension the manifest declares, in the caller's
   *  spelling. Exact tokens from the declaration, like everything _callerSpelling rewrites. */
  _localTimeTokens(layer) {
    const out = new Map();
    for (const sm of layer?.semantic_models || []) {
      for (const d of sm.dimensions) if (d.type === 'time') for (const g of this.catalog.timeGranularities()) out.set(`${d.name}__${g}`, `${sm.name}_${d.name}_${g}`);
    }
    return out;
  },

  /**
   * MetricFlow's names, in the caller's spelling. A query is addressed by WHAT and WHERE — { source,
   * column }, { source, property }, { semantic_model, dimension }, { entity }, metric_time — and the
   * server resolves that to MetricFlow's `entity__dimension__grain` tokens. `names` maps each token the
   * query used to the name the caller
   * sees (its result column), longest first — and ONLY those: a text is never rewritten by a pattern,
   * since a project's own columns may carry `__` in their names (measure__…), and SQL that renamed them
   * would not run. Applied to an explained query's SQL and plan and to every failure message; it
   * renames each occurrence alike, so SQL keeps its meaning.
   */
  _callerSpelling(names = new Map()) {
    const pairs = [...names].filter(([tok, name]) => tok.includes('__') && tok !== name).sort((a, b) => b[0].length - a[0].length);
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const one = (text) => {
      let out = text;
      for (const [tok, name] of pairs) out = out.replace(new RegExp(`\\b${esc(tok)}\\b`, 'g'), name);
      return out;
    };
    const speak = (v) => (typeof v === 'string' ? one(v) : Array.isArray(v) ? v.map(speak) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [speak(k), speak(x)])) : v);
    return speak;
  },

  /** The metrics a context of the project's layer offers: every metric that reads its semantic model. */
  _projectMetricsOf(ctx) {
    return this.project.layer.metrics.filter((m) => m.semantic_models.includes(ctx.state.semantic_model));
  },

  /** What one context of the project's own layer offers — or, with no id, what they all do: the
   *  semantic model it is (its dimensions and entities), and its metrics, each with the semantic models
   *  whose dimensions cut it and the entities it is grouped by. */
  _projectOverview(only = null) {
    const layer = this.project.layer;
    const one = (id) => {
      const ctx = this.ctxs.get(id);
      const sm = layer.semantic_models.find((x) => x.name === ctx.state.semantic_model);
      return {
        context_id: id,
        ...(sm.description ? { description: sm.description } : {}), ...(sm.table ? { table: sm.table } : {}), ...(sm.meta ? { meta: sm.meta } : {}),
        dimensions: sm.dimensions.map((d) => ({ name: d.name, ...(d.type === 'time' ? { time: true, grain: d.grain } : {}), ...(d.description ? { description: d.description } : {}) })),
        entities: sm.entities.map((e) => e.name),
        // each metric with what MetricFlow says it can be grouped by, in short: the semantic models whose
        // dimensions it takes, its entities, and its time axis (context describe gives every item)
        metrics: this._projectMetricsOf(ctx).map((m) => {
          const items = layer.groupBys[m.name] || [];
          const time = items.find((i) => i.name === 'metric_time' && !i.semantic_model);
          return {
            ...m,
            dimensions_from: [...new Set(items.filter((i) => i.kind === 'dimension' && i.semantic_model).map((i) => i.semantic_model))],
            entities: uniqueRefs(items.filter((i) => i.kind === 'entity').map((i) => refOf(i))),
            ...(time ? { metric_time: { grain: time.grain } } : {}),
          };
        }),
      };
    };
    if (only) return one(only);
    return {
      note: `The dbt project's own semantic models and metrics, read from the project at start (nothing to build). Each semantic model is a context of its own, named after it: query_model({ request: { context_id: '<semantic model>', steps: [{ stage: 'metrics', metrics: [...], group_by: [{ semantic_model: [...], dimension }, { entity }, { time: 'metric_time', grain }] }] } }) — semantic_model is the chain of models a dimension is reached through: ['<the context>'] for its own, ['X'] for a model joined to directly, ['A', 'X'] through A. A metric is cut by the dimensions of the semantic models under its dimensions_from, and by its entities — a key the project declares only as an entity is grouped by its name. Its meta is what the project says about reading it. context({ request: { action: 'describe', context_id, metric } }) shows a metric's definition and its group_by — everything it can be grouped by; with validate: true it runs them.`,
      contexts: this.project.contexts.filter((id) => this.ctxs.has(id)).map(one),
      ...(this.project.skipped?.length ? { not_served: this.project.skipped } : {}),
      // joins the project declares that no reference could name — a model joined through several keys,
      // a hop onto no single model: left out, each with how to declare it so it is served
      ...(layer.blocked?.length ? { joins_not_served: layer.blocked.map(({ metrics, ...b }) => b) } : {}),
      // semantic models no metric reads: no context of their own; their dimensions are reached from
      // the contexts whose metrics reach them (each metric's dimensions_from names them)
      ...(this.project.dimension_only?.length ? { dimension_only: this.project.dimension_only } : {}),
    };
  },

  /**
   * One metric query of a context of the dbt project's OWN semantic layer (one per semantic model),
   * checked here against that layer — the context's metrics, and the dimensions each can be grouped
   * and filtered by —
   * and run by MetricFlow over the project as the project defines it. What is returned is the work
   * its task runs, the same task, read and result shape as any metric query.
   */
  _projectQueryWork(ctx, input) {
    const layer = this.project.layer;
    const known = new Map(this._projectMetricsOf(ctx).map((m) => [m.name, m]));
    const list = () => [...known.keys()].join(', ') || '(none)';
    const q = this._metricSteps(input, `The context '${ctx.id}' has: ${list()}`);
    const { metrics } = q;
    for (const m of metrics) {
      if (known.has(m)) continue;
      const home = layer.metrics.find((x) => x.name === m)?.semantic_models;
      throw new ToolError(`${q.at}: '${m}' is not a metric of the context '${ctx.id}'${home ? ` — it reads ${home.join(', ')}: query it in ${home.length > 1 ? 'one of those contexts' : `the context '${home[0]}'`}` : ''}. The context has: ${list()}`, { stage: 'validate', field: 'steps' });
    }
    // what EVERY requested metric can be grouped by, as MetricFlow listed it (src/group-by-items.js):
    // a reference names one of these items exactly — nothing here chooses a join, a path or a grain
    const items = commonItems(layer.groupBys, metrics);
    // a ref of the kinds group_by takes (refAt); the catalog's own names a task's context takes are
    // refused here with the project's spelling
    const kindOf = (ref, at) => {
      let kind;
      try { kind = refAt('group_by', ref, at); } catch (e) { throw new ToolError(e.message, { stage: 'validate', field: 'steps' }); }
      if (kind === 'source_column' || kind === 'source_property') throw new ToolError(`${at}: in the context '${ctx.id}' (a semantic model of the dbt project's own layer) a dimension is { semantic_model: [the chain of models it is reached through], dimension } and an entity { entity } — the project's own names, not the catalog's ${REFS[kind].says}. context({ request: { action: 'describe', context_id: '${ctx.id}', metric } }) lists each exactly.`, { stage: 'validate', field: 'steps' });
      return kind;
    };
    const pick = (ref, at) => {
      const r = resolveRef(items, ref, metrics.join(' and '), layer.blocked || []);
      if (r.error) throw new ToolError(`${at}: ${r.error}`, { stage: 'validate', field: 'steps' });
      return r.item;
    };
    const groupBy = [];
    const rename = new Map();
    const groupByResolved = {};
    const columns = []; // the result's group_by columns, as the steps after the query name them
    // an item of the metrics step's group_by, or a reference a where after it names: the item it is, at its grain
    const itemOf = (g, at) => {
      const time = kindOf(g, at) === 'time';
      const item = time ? items.find((x) => x.name === 'metric_time' && !x.semantic_model) : pick(g, at);
      if (!item) throw new ToolError(`${at}: ${metrics.join(', ')} ${metrics.length > 1 ? 'share' : 'has'} no time axis to group by`, { stage: 'validate', field: 'steps' });
      return { time, item, grain: item.type === 'time' ? g.grain || item.grain || 'day' : null };
    };
    for (const [i, g] of q.groupBy.entries()) {
      const at = `${q.at} group_by[${i}]`;
      const { time, item, grain } = itemOf(g, at);
      const tok = tokenOf(item, grain);
      const column = columnOf(item, grain);
      if (metrics.includes(column) || [...rename.values()].includes(column)) throw new ToolError(`${at}: ${labelOf(item)} would make a result column '${column}' that another column of this query already has`, { stage: 'validate', field: 'steps' });
      groupBy.push(tok); rename.set(tok, column);
      // (the manifest says which dimension is a time; of the others it gives no type)
      columns.push({ name: column, type: grain ? 'time' : 'unknown' });
      if (!time) groupByResolved[labelOf(item)] = column;
    }
    // the MetricFlow names a where resolved to, in the caller's spelling (see _callerSpelling)
    const whereNames = new Map();
    // the where steps before the metrics step: each reference names one item MetricFlow listed, as
    // group_by's do, and every condition of them holds for the rows the metrics fold
    const where = q.wheres.flatMap((w) => this._whereClauses(w.conditions, (ref, at) => {
      if (kindOf(ref, at) === 'time') return { kind: 'metric_time', grain: ref.grain };
      const item = pick(ref, at);
      whereNames.set(tokenOf(item), columnOf(item));
      if (item.kind === 'entity') return { kind: 'entity', name: tokenOf(item) };
      if (item.type === 'time') {
        whereNames.set(item.dunder_name, `${item.semantic_model}_${item.name}`);
        return { kind: 'time_dimension', path: item.dunder_name, grain: ref.grain || item.grain || 'day' };
      }
      return { kind: 'dimension', path: item.dunder_name };
    }, w.at));
    // the steps after the query, over its result's columns: checked here, before anything runs (a
    // reference a where there names is the result's column when a group_by item gave it one — a time
    // named without a grain, the column of each grain the metrics step groups that item by)
    const carried = (ref, at) => {
      try {
        const { time, item, grain } = itemOf(ref, at);
        if (ref.grain === undefined && (time || grain)) return q.groupBy.map((g, i) => itemOf(g, `${q.at} group_by[${i}]`)).filter((g) => g.item === item).map((g) => columnOf(g.item, g.grain));
        const c = columnOf(item, grain);
        return columns.some((x) => x.name === c) ? [c] : [];
      } catch { return []; }
    };
    const tail = this._metricTail(q.tail, { columns: [...columns, ...metrics.map((name) => ({ name, type: 'unknown' }))], rename, first: q.first, carried });
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    // the guardrail, as a task's query has it: a semantic model over a dbt model the catalog requires a
    // window for — or every one, when the deployment does — is not scanned whole
    const reads = [...new Set(metrics.flatMap((m) => known.get(m).semantic_models))];
    // (keyed by the dbt model dbt itself records each semantic model reads)
    const guarded = reads.filter((name) => this.catalog.requireTimeRangeForDbtModel(layer.sources?.[name] ?? null));
    const { bounds, windowWarnings } = this._metricWindow(input, guarded);
    const conversionNotes = this._conversionNotes(layer, metrics, { where: where.length > 0, window: !!(bounds.start || bounds.end) });
    const paging = this._metricPaging(input, tail.ordered);
    const explain = this._compileOnly(input);
    const qopts = { metrics, groupBy, where, orderBy: tail.orderBy, startTime: bounds.start ?? undefined, endTime: bounds.end ?? undefined, limit: this._metricLimit(input, paging, explain) };
    const speak = this._callerSpelling(new Map([...this._localTimeTokens(layer), ...this._queryTokens(layer.metrics.map((m) => m.name)), ...this._listedTokens(Object.fromEntries(metrics.map((m) => [m, layer.groupBys[m] || []]))), ...whereNames, ...rename]));
    const respond = (raw) => {
      this.ctxs.touch(ctx.id);
      const early = this._metricEarlyAnswer(raw, { explain, input, speak, extra: { output_columns: tail.outputColumns, ...(conversionNotes.length ? { warnings: conversionNotes } : {}) } });
      if (early) return early;
      const { rows: pageRows, page } = paging.page(raw.rows || []);
      const recs = [];
      if (!pageRows.length) recs.push('0 rows — a where that matches nothing, or a window with no data: widen time_range or re-check the filter.');
      if (page.has_more) recs.push(this._keptRowsNote(page));
      return {
        ok: true, columns: raw.columns || [], rows: pageRows, row_count: pageRows.length, page,
        ...(Object.keys(groupByResolved).length ? { group_by_resolved: groupByResolved } : {}),
        provenance: { tier: 'project_metric', metrics, semantic_models: reads },
        warnings: [...windowWarnings, ...conversionNotes],
        recommendations: recs,
      };
    };
    return this._metricTask(ctx, { qopts, input, rename, speak, explain, respond, tail });
  },

  // THE SHELL A METRIC QUERY RUNS IN — one for a task's context (_semanticQueryWork) and a project
  // semantic model's (_projectQueryWork): its steps, the steps after its metrics, the window and its
  // guardrail, paging, the answer to a failure or an explain, and the task that runs it. What differs
  // between the two is only how a reference is resolved to MetricFlow's tokens and what a finished answer
  // carries besides its rows.

  /**
   * A METRIC QUERY IS ITS STEPS — one metrics step, what the semantic layer computes ({ stage: "metrics",
   * metrics, group_by? } — METRICS_STEP, src/schema/fields.js: no pipeline stage, offered by the place that
   * takes it); before it where steps, every condition of which holds for the rows its metrics fold
   * (MetricFlow's where, PLACES.metric_where: each reference resolved as group_by's is); after it the
   * steps a read takes, over its result (_metricTail). Where a step stands is checked here, and a refusal
   * names it (STAGE_PLACES.metric_scope): no metrics step or a second one, a step before it that is no
   * where — one the result takes goes after it. `offers`: what the context offers, said to a query with no
   * metrics step.
   * → { metrics, groupBy, at (the metrics step, as a refusal names it), wheres: [{ conditions, at }],
   *     tail (the steps after it), first (the index of the first of them) }
   */
  _metricSteps(input, offers) {
    const steps = input.steps || [];
    const refuse = (message) => new ToolError(message, { stage: 'validate', field: 'steps' });
    const isMetrics = (st) => st?.stage === METRICS_STEP.stage;
    const k = steps.findIndex(isMetrics);
    if (k < 0) throw refuse(`steps: a metric query is one metrics step — { stage: "metrics", metrics: [...], group_by: [...] } — with where steps before it for the rows its metrics fold and steps after it over its result; these steps have none. ${offers}`);
    const again = steps.findIndex((st, i) => i > k && isMetrics(st));
    if (again >= 0) throw refuse(`steps[${again}]: a metric query has one metrics step, and steps[${k}] is one — list every metric in it, or make the other a query of its own (several run side by side in one call: queries)`);
    const result = STAGE_PLACES.metric_result;
    const wheres = steps.slice(0, k).map((st, i) => {
      // a step the result takes goes after the metrics step; any other makes a table of its own
      const place = { ...STAGE_PLACES.metric_scope, elsewhere: result.stages.includes(st?.stage) ? 'works on the metrics\' result: put it after the metrics step' : result.elsewhere };
      try { stageAt(place, st, `steps[${i}]`); } catch (e) { throw refuse(e.message); }
      return { conditions: st.conditions, at: `steps[${i}] conditions` };
    });
    return { metrics: steps[k].metrics, groupBy: steps[k].group_by || [], at: `steps[${k}]`, wheres, tail: steps.slice(k + 1), first: k + 1 };
  },

  /**
   * THE STEPS AFTER THE METRICS STEP — what a read takes (STAGE_PLACES.metric_result), over the result's
   * columns as the caller names them: `columns` [{ name, type }], the group_by items' result columns and
   * then the metrics, each typed where it is known ('unknown' — a constant is written as it is —
   * otherwise); `first` the index of the first of them in the query's steps. Checked here, before anything
   * runs, by the read compiler they run through: a step naming a column the result does not have is
   * refused with the columns there are at that step. The where steps before the metrics step filter the
   * rows a metric folds; a where step after it filters the result (a having) — and a reference a where
   * there names is refused with where it goes: the result's column (`carried(ref, at)` → the columns a
   * group_by item gave it — one, or one per grain for a time named without its grain —, or none) or
   * before the metrics step.
   * What MetricFlow says itself runs as `mf query`: no steps, or one order_by step whose keys it orders
   * as asked (`orderBy`, its order tokens — `rename` maps each token to the caller's name); any other
   * step runs over the SQL it compiles for the query (`viaSql`, _metricRead).
   * → { steps, columns, orderBy, viaSql, ordered, outputColumns, sample }
   */
  _metricTail(steps, { columns, rename, first = 0, carried = () => [] }) {
    const at = (i) => `steps[${first + i}]`;
    const refuse = (message) => new ToolError(message, { stage: 'validate', field: 'steps' });
    steps.forEach((st, i) => {
      try { stageAt(STAGE_PLACES.metric_result, st, at(i)); } catch (e) { throw refuse(e.message); }
      if (st?.stage !== 'where') return;
      let ref = null;
      eachNode(st.conditions, (n) => { ref ||= REF_PLACES.group_by.takes.includes(refKind(n)) ? n : null; });
      if (!ref) return;
      const cols = carried(ref, at(i));
      const named = cols.map((c) => `{ column: '${c}' }`).join(' or ');
      const there = cols.length > 1 ? `is in the result as its columns ${cols.slice(0, -1).map((c) => `'${c}'`).join(', ')} and '${cols[cols.length - 1]}', one per grain the metrics step groups it by — name the one you mean (${named}); or put the where before the metrics step`
        : cols.length ? `is its column '${cols[0]}' there (${named}); or put the where before the metrics step` : 'is a dimension the result does not carry: put it before the metrics step';
      throw refuse(`${at(i)}: a where after the metrics step reads the result's columns — ${refText(ref)} ${there}, where it filters the rows the metrics fold`);
    });
    let read;
    // (the read numbers its steps from 0; here they follow the metrics step)
    try { read = renderRead(this.catalog, '_metrics', columns, steps); } catch (e) {
      throw refuse(e.message.replace(/^steps\[(\d+)\]/, (_, n) => at(Number(n))));
    }
    const only = steps.length === 1 && steps[0].stage === 'order_by' ? steps[0] : null;
    const said = !!only && only.keys.every((k) => metricFlowOrders(this.catalog.dialect, k));
    const tokenOfColumn = new Map([...rename].map(([tok, name]) => [name, tok]));
    return {
      steps, columns, ordered: read.ordered, viaSql: steps.length > 0 && !said,
      orderBy: said ? only.keys.map((k) => `${k.direction === 'desc' ? '-' : ''}${tokenOfColumn.get(k.key) ?? k.key}`) : [],
      outputColumns: [...read.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
      sample: steps.find((st) => st.stage === 'sample') || null,
    };
  },

  /**
   * A metric query's result as SQL under the caller's names: the SQL MetricFlow compiled for it, its
   * group_by columns renamed (`rename`: MetricFlow's token → the result column) and then its metrics,
   * every name quoted — what a materialized query stores, and what the steps after a query read.
   */
  _metricRelation(sql, { groupBy = [], metrics }, rename) {
    const d = getDialect(this.catalog.dialect);
    const cols = [...groupBy.map((g) => `${d.quoteIdent(g)} AS ${d.quoteIdent(rename.get(g) ?? g)}`), ...metrics.map((m) => d.quoteIdent(m))];
    return `SELECT ${cols.join(', ')} FROM (\n${sql}\n) _q`;
  },

  /**
   * A metric query with steps after it, run as SQL: MetricFlow compiles the query — with no order and no
   * limit, since the steps work on the whole result — the read compiler renders the steps over it
   * (_metricRelation), and the warehouse runs that through the dbt client's show on the context's
   * project, `qopts.limit` rows of it. Only compiled (explain), it answers the read's SQL — capped at the
   * query's limit when it names one, as MetricFlow's own compiled query is — and MetricFlow's plan.
   * → what a metric query answers: { ok, columns, rows } | { ok, sql, plan? } | a failure.
   */
  async _metricRead(ctx, { qopts, input, rename, explain, tail }) {
    const dir = this.ctxs.dir(ctx.id);
    const { limit, orderBy: _order, ...query } = qopts;
    const compiled = await this.runner.query(dir, { ...query, explain: true, plan: explain && wants(input, 'plan') });
    if (!compiled.ok) return compiled;
    const steps = explain && input.limit ? [...tail.steps, { stage: 'limit', limit: input.limit }] : tail.steps;
    const read = renderRead(this.catalog, `(\n${this._metricRelation(compiled.sql, query, rename)}\n) AS _metrics`, tail.columns, steps);
    if (explain) return { ok: true, sql: read.sql, ...(compiled.plan !== undefined ? { plan: compiled.plan } : {}) };
    const shown = await this.runner.show(dir, read.sql, limit);
    return shown.ok ? { ok: true, columns: [...read.columns.keys()].map((name) => ({ name })), rows: shown.rows } : shown;
  },

  /** The window: the cost guardrail (`guarded` names what requires a bounded one), the timezone, the
   *  bounds, and the warnings an open or still-filling window gets. → { bounds, windowWarnings } */
  _metricWindow(input, guarded = []) {
    // Cost guardrail (require_time_range): block an unbounded scan over what the query reads
    if (guarded.length && !input.time_range?.start) {
      throw new ToolError(`${guarded.join(', ')} require${guarded.length === 1 ? 's' : ''} a bounded time window (require_time_range): pass time_range { start, end } to prune partitions`, { stage: 'validate', field: 'time_range' });
    }
    // Timezone-aware boundaries: time_range.timezone reads start/end as wall-clock in that IANA zone
    // and converts them to the UTC instants the warehouse stores.
    if (input.time_range?.timezone && !isValidTimezone(input.time_range.timezone)) {
      throw new ToolError(`unknown timezone '${input.time_range.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`, { stage: 'validate', field: 'time_range.timezone' });
    }
    // Window honesty: warn when unbounded or when the window reaches into today (the trailing bucket
    // is incomplete) — so partial periods are never reported silently.
    return { bounds: resolveTimeRange(input.time_range) || {}, windowWarnings: timeRangeWarnings(input.time_range) };
  },

  /**
   * What a query of the PROJECT's conversion metrics is told (a generated context declares none: a
   * conversion is a pipeline there). MetricFlow filters only a conversion's base side
   * (dbt-labs/metricflow#1199) — the query's where and its time window alike — so the conversion
   * events are read from the whole source; and its window is counted on the base's time dimension at
   * that dimension's granularity, so '1 day' at a day grain is the same calendar day.
   */
  _conversionNotes(layer, metrics, { where = false, window = false } = {}) {
    const conv = [];
    const seen = new Set();
    const walk = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      const d = layer.definition(name) || {};
      if (layer.metrics.find((m) => m.name === name)?.type === 'conversion') conv.push({ name, ...d });
      for (const i of [d.numerator, d.denominator, ...(d.inputs || []), d.input, d.base, d.conversion]) if (i?.metric) walk(i.metric);
    };
    metrics.forEach(walk);
    if (!conv.length) return [];
    const route = 'semantic_index({ request: { recipe: "conversion_metric_window" } })';
    const notes = [];
    const bare = conv.filter((m) => !(m.constant_properties || []).length);
    if (where || window) notes.push(`Conversion metric${conv.length > 1 ? 's' : ''} ${conv.map((m) => m.name).join(', ')}: MetricFlow applies ${where && window ? 'the where and the time window' : where ? 'the where' : 'the time window'} to the BASE events only (dbt-labs/metricflow#1199) — the conversion events are read from the whole source${window ? ', every partition' : ''}${where ? ', whatever the filtered columns hold' : ''}, which is slow on a large table${where && bare.length ? ', and a conversion of the same entity under another value of a filtered column (another app, another environment) counts' : ''}. A pipeline counts the same conversion over one bounded scan with every filter on both sides: ${route}.`);
    const order = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
    for (const m of conv) {
      const base = m.base?.metric ? layer.definition(m.base.metric) || {} : m.base || {};
      const sm = layer.semantic_models.find((x) => x.name === base.semantic_model);
      const grain = sm?.dimensions?.find((x) => x.name === base.agg_time_dimension)?.grain;
      const unit = /^\d+ (\w+?)s?$/.exec(String(m.window || ''))?.[1];
      if (grain && unit && order.indexOf(unit) <= order.indexOf(grain)) notes.push(`${m.name}: its window '${m.window}' is compared on the base's time dimension at its ${grain} granularity, so it means the same ${grain} — not ${m.window} after the base event. A pipeline measures the window in seconds from the event: ${route}.`);
    }
    return notes;
  },

  /** The rows a query task keeps — the first `limit` of its result (a read pages them) — and one row
   *  over them fetched, so has_more says whether the result goes on past them; `ordered` whether its
   *  steps end in an order_by (a limit after it aside). */
  _metricPaging(input, ordered) {
    const limit = input.limit ?? KEPT_ROWS;
    return { limit, fetch: limit + 1, page: (rows) => { const kept = rows.slice(0, limit); return { rows: kept, page: pageBlock({ offset: 0, limit, returned: kept.length, has_more: rows.length > limit, ordered }) }; } };
  },

  /** What a query whose result goes on past the rows its task keeps is told: how to have the rest. */
  _keptRowsNote(page) {
    return `More rows exist past the ${page.limit} this task keeps — query again with a larger limit, or with materialize: true to store every row as a table that a read ({ task_ids, offset, limit }) pages to the last one; or end the steps with an order_by step so the rows kept are the ones that matter.`;
  },

  /** Whether a query is only compiled (dry_run); a plan is asked for only with it, and a result is
   *  stored only by a query that runs. */
  _compileOnly(input) {
    const only = !!input.dry_run;
    if (wants(input, 'plan') && !only) throw new ToolError('include: ["plan"] goes with dry_run: the dataflow plan is how a query compiles, and a query that runs returns its rows instead', { stage: 'validate', field: 'include' });
    if (input.materialize && only) throw new ToolError('materialize goes with a query that runs: dry_run only compiles it, so there is no result to store — drop one of the two', { stage: 'validate', field: 'materialize' });
    return only;
  },

  /** The row limit a query is sent with: a query that runs fetches one row past the page (so has_more
   *  means something); one only compiled is compiled with the caller's own limit, as written. */
  _metricLimit(input, paging, explain) {
    return explain ? input.limit : paging.fetch;
  },

  /** The answer to a query that failed, or was only explained — null for one that ran. */
  _metricEarlyAnswer(res, { explain, input, speak, extra = {} }) {
    if (!res.ok) return { ok: false, error: { stage: 'query', message: speak(formatDbtError(res.stdout, res.stderr)) } };
    if (!explain) return null;
    return { ok: true, sql: speak(res.sql), ...speak(extra), ...(input.dry_run ? { dry_run: true } : {}), ...(wants(input, 'plan') ? { plan: speak(res.plan) } : {}) };
  },

  /** The task a metric query is: the time spine first (a real query needs it for metric_time), then
   *  the query — stored as a table after its steps with materialize; else run by MetricFlow when it
   *  says the whole of it (`mf query`), or over the SQL it compiles with the steps after it
   *  (_metricRead) — its rows under the caller's names and in one form either way (oneForm), answered
   *  by `respond`. */
  _metricTask(ctx, { qopts, input, rename, speak, explain, respond, tail }) {
    return async (id) => {
      if (!explain) await this._ensureTimeSpineBuilt(ctx.id);
      // (stored, the steps order the rows: MetricFlow's own order would be undone by them)
      const out = input.materialize && !explain
        ? await this._materialize(ctx, tail.steps.length ? { ...qopts, orderBy: [] } : qopts, input, rename, id, speak, { columns: tail.columns, steps: tail.steps })
        : await respond(oneForm(tail.viaSql
          ? await this._metricRead(ctx, { qopts, input, rename, explain, tail })
          : callerNamed(await this.runner.query(this.ctxs.dir(ctx.id), { ...qopts, explain, plan: wants(input, 'plan') }), rename), tail.outputColumns));
      // a result read through a sample of its rows is approximate, and says so (as a sampled read does)
      return tail.sample && !explain && out?.ok !== false ? { ...out, sampled: true, sampling: samplingNote(tail.sample.share) } : out;
    };
  },

  /**
   * One metric query, checked: every mistake is refused HERE (where each step stands, the metrics, the
   * group_by, the where steps and their values, the steps after the metrics, the time window), and what
   * is returned is the work its task runs.
   */
  _semanticQueryWork(ctx, input) {

    const known = new Set(ctx.state.metrics.map((m) => m.name));
    const q = this._metricSteps(input, `This context defines: ${[...known].join(', ') || '(none — create metrics first)'}`);
    const { metrics } = q;
    for (const m of metrics) if (!known.has(m)) throw new ToolError(`${q.at}: unknown metric in context: '${m}'. Available: ${[...known].join(', ') || '(none)'}`, { stage: 'validate', field: 'steps' });
    // a metric the context declares but its layer could not carry (a measure on a slowly-changing
    // model is dropped from what dbt parses) is refused HERE, not by MetricFlow minutes later
    const emitted = new Set(renderContext(this._catalogOf(ctx), ctx.state, { spec: this._semanticSpec() }).metricNames);
    const dropped = metrics.filter((m) => !emitted.has(m));
    if (dropped.length) throw new ToolError(`${q.at}: metric${dropped.length > 1 ? 's' : ''} ${dropped.map((m) => `'${m}'`).join(', ')} ${dropped.length > 1 ? 'are' : 'is'} declared in this context but not in its semantic layer: ${dropped.length > 1 ? 'they read' : 'it reads'} a measure on a slowly-changing model, where MetricFlow allows no measure (it is a join target only). Count on an events source instead (count_distinct of the user key), and group by that model's attributes. Queryable here: ${[...emitted].join(', ') || '(none)'}`, { stage: 'validate', field: 'steps' });

    // what a reference reaches is _taskRef's one judgement: it resolves the reference or refuses it,
    // saying what is reachable (_reachableHint)
    const groupBy = [];
    // Result columns are named after the reference the caller made — `<source>_<column>` (or
    // `_<property>`), `<semantic model>_<dimension>`, the entity's name and `metric_time_<grain>` — so
    // nothing the caller reads back or addresses later (a step, a card, a pipeline started from the
    // stored result) ever carries MetricFlow's internal `__` spelling.
    const rename = new Map(); // MetricFlow output name → the column name the caller sees
    const groupByResolved = {}; // "<source>.<column>" → the result column
    const columns = []; // the result's group_by columns, as the steps after the query name them
    for (const [i, g] of q.groupBy.entries()) {
      const at = `${q.at} group_by[${i}]`;
      const r = this._taskRef(ctx, g, at, 'steps');
      if (r.kind === 'dimension') this._checkCuts(ctx, g.source ?? g.semantic_model.at(-1), r.label, metrics, at);
      if (r.kind === 'entity') this._checkEntityCuts(ctx, r.path, metrics, at);
      if (metrics.includes(r.column) || [...rename.values()].includes(r.column)) throw new ToolError(`${at}: '${r.label}' would produce a result column '${r.column}' that clashes with another column of this query — rename the metric or drop the duplicate.`, { stage: 'validate', field: 'steps' });
      // a time dimension is asked for at its grain — the column MetricFlow names with it
      const tok = r.kind === 'time' ? `metric_time__${r.grain}` : r.grain ? `${r.path}__${r.grain}` : r.path;
      groupBy.push(tok); rename.set(tok, r.column);
      if (r.kind !== 'time') groupByResolved[r.label] = r.column;
      columns.push({ name: r.column, type: r.type });
    }
    let filterWarnings = [];
    // the MetricFlow names a where resolved to, in the caller's spelling (see _callerSpelling)
    const whereNames = new Map();
    // the where steps before the metrics step: every condition of them holds for the rows the metrics fold
    const where = q.wheres.flatMap((w) => this._whereClauses(w.conditions, (ref, at) => {
      const r = this._taskRef(ctx, ref, at, 'steps');
      if (r.kind === 'time') return { kind: 'metric_time', grain: ref.grain };
      if (r.kind === 'dimension') this._checkCuts(ctx, ref.source ?? ref.semantic_model.at(-1), r.label, metrics, at);
      if (r.kind === 'entity') this._checkEntityCuts(ctx, r.path, metrics, at);
      whereNames.set(r.path, r.column);
      return r.kind === 'entity' ? { kind: 'entity', name: r.path } : { kind: 'dimension', path: r.path };
    }, w.at));
    const conditions = q.wheres.flatMap((w) => w.conditions);
    if (conditions.length) {
      // Verify each constant compared with a column or an event property against its REAL values
      // (source-scoped): reject a wrong-cased/non-existent value instead of filtering to nothing. The
      // value-index key comes from the source the caller NAMED: a path carries no source, so recovering
      // it from the path would lose the guard on any name two sources happen to share.
      const specs = referenceComparisons(conditions).filter((c) => c.ref.source !== undefined).map((c) => {
        const name = c.ref.column ?? c.ref.property;
        return { at: this.advisor.valueKeyForColumn(c.ref.source, name), op: c.op, value: c.values, where: `where ${c.ref.source}.${name}` };
      });
      filterWarnings = this.advisor.guardFilterValues(specs); // throws on a case/typo/absent mismatch
    }
    // the steps after the query, over its result's columns: checked here, before anything runs (a
    // reference a where there names is the result's column when a group_by item gave it one —
    // metric_time named without a grain, the column of each grain the metrics step groups it by)
    const carried = (ref, at) => {
      try {
        const { kind, column } = this._taskRef(ctx, ref, at, 'steps');
        if (kind === 'time' && ref.grain === undefined) return q.groupBy.map((g, i) => this._taskRef(ctx, g, `${q.at} group_by[${i}]`, 'steps')).filter((g) => g.kind === 'time').map((g) => g.column);
        return columns.some((x) => x.name === column) ? [column] : [];
      } catch { return []; }
    };
    const tail = this._metricTail(q.tail, { columns: [...columns, ...metrics.map((name) => ({ name, type: 'unknown' }))], rename, first: q.first, carried });

    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    // the guardrail covers every source this context reads, whichever one the metrics come from
    const guarded = (ctx.state.usedModels || []).filter((k) => this._catalogOf(ctx).requireTimeRangeFor(k)).map((k) => `source ${k}`);
    const { bounds, windowWarnings } = this._metricWindow(input, guarded);
    const paging = this._metricPaging(input, tail.ordered);
    const partitionWhere = this._semanticPartitionWhere(ctx, bounds, metrics);
    const explain = this._compileOnly(input);
    const qopts = { metrics, groupBy, where: [...where, ...partitionWhere], orderBy: tail.orderBy, startTime: bounds.start ?? undefined, endTime: bounds.end ?? undefined, limit: this._metricLimit(input, paging, explain) };
    // The response is built from the runner's answer in ONE place, whether the query finished
    // inside the call or after it was handed back as a job.
    // …and the partition filter this query adds for its window, named as the caller would name it
    const [source] = this._measureSources(ctx);
    const partitionToken = source && this._catalogOf(ctx).primaryEntityName(source) ? [[`${this._catalogOf(ctx).primaryEntityName(source)}__${PARTITION_DIM}`, `${source}_${PARTITION_DIM}`]] : [];
    const spelled = new Map([...this._queryTokens((ctx.state.metrics || []).map((m) => m.name)), ...partitionToken, ...whereNames, ...rename]);
    const speak = this._callerSpelling(spelled);
    const respond = async (res) => {
      this.ctxs.touch(ctx.id);
      // an explain or a failure is text that may quote any item MetricFlow resolved: spelled with its list
      const listed = !res.ok || explain ? await this._listedGroupBys(ctx, metrics) : null;
      const fully = listed ? this._callerSpelling(new Map([...this._localTimeTokens(this._previewLayer(ctx).layer), ...this._listedTokens(listed.groupBys), ...spelled])) : speak;
      const early = this._metricEarlyAnswer(res, { explain, input, speak: fully, extra: { output_columns: tail.outputColumns, ...(filterWarnings.length ? { warnings: filterWarnings } : {}) } });
      if (early) return early;
      const { rows: pageRows, page } = paging.page(res.rows);
      // A context can span several facts (e.g. crashes vs sessions compared over metric_time):
      // report the freshness of each one it reads, and headline the STALEST — that is the date
      // the combined result is actually complete through.
      // Freshness is a property of the sources whose MEASURES THIS query reads — the models its metrics
      // fold (through the metrics a derived one is built from), not every source of the context: a
      // spend table beside the events says nothing of how complete an events metric is, nor does a
      // dimension joined for its attributes (installs).
      // (a build's own table is as fresh as its build: no freshness of the warehouse's is read for it)
      const cc = this._catalogOf(ctx);
      const factsRead = [...new Set(metrics.flatMap((m) => this._metricModels(ctx, m)))].filter((k) => cc.models[k] && !cc.getModel(k).built && cc.getModel(k).time?.column);
      const freshByFact = {};
      await Promise.all(factsRead.map(async (f) => { freshByFact[f] = await this.probe.dataFreshness(f); }));
      const knownFresh = Object.values(freshByFact).filter(Boolean);
      const fresh = knownFresh.length ? knownFresh.reduce((a, b) => (a < b ? a : b)) : null;
      // Situational recommendations: surface a risk ONLY when it is actually present.
      const recs = [];
      // #1 STALENESS/incompleteness: the window reaches past the latest data → empty/partial tail.
      if (fresh) {
        const freshDay = String(fresh).slice(0, 10);
        const endDay = input.time_range?.end ? String(input.time_range.end).slice(0, 10) : null;
        // (several sources: the one whose data ends first, named — the others run further)
        const stalest = factsRead.length > 1 ? Object.keys(freshByFact).find((f) => freshByFact[f] === fresh) : null;
        if (!endDay || endDay > freshDay) recs.push(`Data is current only through ${freshDay} (${stalest ? `the latest row of ${stalest}, the source whose data ends first` : 'latest event time'})${endDay ? `, but your window ends ${endDay}` : ' and your window has no end'} — rows past ${freshDay} are empty/partial.`);
      }
      // #2 ZERO/degenerate result: almost always a scoping bug, not a real "0".
      if (pageRows.length === 0) recs.push('0 rows — usually an over-scoped where, a group_by with no data in this window, or a measure on a property that is NULL for the scoped events. Widen time_range, re-check the filter, or inspect the property coverage via semantic_index({ request: { source, property } }).');
      // #4 NON-ADDITIVE distinct across time → prefer HLL sketches (mergeable).
      const distinctMeasures = new Set();
      for (const add of Object.values(ctx.state.additions || {})) for (const mm of add.measures || []) if (mm.agg === 'count_distinct') distinctMeasures.add(mm.name);
      const usesDistinct = distinctMeasures.size && metrics.some((name) => { const metric = ctx.state.metrics.find((x) => x.name === name); return metric && [...measureRefs(metric, ctx.state.metrics)].some((dm) => distinctMeasures.has(dm)); });
      if (usesDistinct && groupBy.some((g) => String(g).startsWith('metric_time__'))) {
        recs.push('count_distinct is NOT additive across time buckets — do not sum the per-bucket values for a period total. Prefer HLL sketches (a build_model pipeline: hll_init per bucket → hll_merge to combine): a high-accuracy distinct count that IS mergeable/re-aggregatable across buckets and segments. Or query the whole period without the time grain.');
      }
      if (page.has_more) recs.push(this._keptRowsNote(page));
      recs.push('Re-slice or persist: pass materialize:true to keep the result as a table — a pipeline can then start from it (build_model({ request: { action: \'start\', name, from_task } })) and re-slice it without recomputing; group differently or compare segments by re-querying with another group_by.');
      const out = {
        ok: true,
        columns: res.columns,
        rows: pageRows,
        row_count: pageRows.length,
        page,
        // Provenance so the result is self-trustable: which tier produced it, the source,
        // and how fresh the underlying data is (latest event time).
        ...(Object.keys(groupByResolved).length ? { group_by_resolved: groupByResolved } : {}),
        provenance: {
          tier: 'governed_metric',
          metrics,
          source: factsRead.length === 1 ? factsRead[0] : factsRead,
          data_freshness: fresh,
          ...(factsRead.length > 1 ? { data_freshness_by_source: freshByFact } : {}),
        },
        warnings: [...windowWarnings, ...filterWarnings, ...(pageRows.length ? [] : (filterWarnings.onEmpty || []))],
        recommendations: recs,
      };
      return out;
    };

    // The query is a TASK: validated above, run below, its response read with query_model({ request: { task_ids } }).
    // A metric query over a big window can outlast the client in front of this call — so no call
    // holds it.
    return this._metricTask(ctx, { qopts, input, rename, speak, explain, respond, tail });
  },

  /**
   * A where step's conditions, before a metric query's metrics step → MetricFlow's `--where` clauses
   * (src/predicate.js), each reference resolved by `resolve(ref, at)` — a context's own rule for what a
   * name reaches; `at` names the step's conditions. Refused here, before anything runs: a reference that
   * reaches nothing (resolve's refusal), and a where the one writer refuses at its place
   * (PLACES.metric_where) — a column of the rows, a metric, an aggregate, a constant of the wrong kind, a
   * null compared, a condition that is not a boolean.
   */
  _whereClauses(list, resolve, at = 'where') {
    try {
      return whereSql(this.catalog.dialect, list, resolve, at);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(e.message, { stage: 'validate', field: 'steps' });
    }
  },
};

/** What `mf query` answered, under the caller's names: its columns and each row's keys renamed
 *  (`rename`: MetricFlow's token → the result column). A failure or a compiled query is as it came. */
function callerNamed(raw, rename) {
  if (!raw?.ok || !Array.isArray(raw.rows)) return raw;
  return {
    ...raw,
    columns: (raw.columns || []).map((c) => (rename.has(c.name) ? { ...c, name: rename.get(c.name) } : c)),
    rows: raw.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [rename.get(k) || k, v]))),
  };
}

/**
 * A metric query's rows in ONE FORM, whichever path ran it: `mf query` writes a CSV, every dimension as
 * text (a moment as Python prints it, '2026-01-01 00:00:00'; a number as its digits), while the dbt
 * client's show writes JSON (the moment ISO, a number a number). Keyed by the result's typed columns
 * (`columns`, [{ name, type }]): a moment is written ISO, 'T' between its day and its time, and a numeric
 * column's number is a number — an integer past 2^53 kept as the digits written, as show keeps one
 * (src/dbt/output.js). Every other value, a failure and a compiled query are as they came.
 */
function oneForm(raw, columns = []) {
  if (!raw?.ok || !Array.isArray(raw.rows)) return raw;
  const time = new Set(columns.filter((c) => c.type === 'time').map((c) => c.name));
  const numeric = new Set(columns.filter((c) => NUMERIC_TYPES.has(c.type)).map((c) => c.name));
  if (!time.size && !numeric.size) return raw;
  const written = (k, v) => {
    if (typeof v !== 'string') return v;
    if (time.has(k)) return v.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, '$1T');
    if (!numeric.has(k) || v.trim() === '' || !Number.isFinite(Number(v))) return v;
    return /^\s*-?\d+\s*$/.test(v) && !Number.isSafeInteger(Number(v)) ? v : Number(v);
  };
  return { ...raw, rows: raw.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, written(k, v)]))) };
}
/** The column types whose values are numbers. */
const NUMERIC_TYPES = new Set(['numeric', 'int', 'float']);

// Where a warehouse puts NULLs in an ORDER BY key that names no place: last on DuckDB; on BigQuery
// first in an ascending sort, last in a descending one.
const NULLS_UNSAID = { duckdb: () => 'last', bigquery: (direction) => (direction === 'desc' ? 'last' : 'first') };

/**
 * Whether MetricFlow orders a sort key as an order_by step means it. Its ORDER BY names no place for
 * NULLs, so they go where the warehouse puts them, while a step puts them last unless it says first —
 * the same on every warehouse. A key MetricFlow would place otherwise is the read compiler's to write.
 */
function metricFlowOrders(dialect, key) {
  return NULLS_UNSAID[dialect]?.(key.direction) === (key.nulls === 'first' ? 'first' : 'last');
}
