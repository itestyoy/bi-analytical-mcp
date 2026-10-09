// QUERY_SEMANTIC_MODEL — a metric query addressed by what and where ({ model, attribute },
// { semantic_model, dimension }, { entity }, metric_time), resolved to MetricFlow's items and run by
// `mf`; its SQL, plan and failures handed back in the caller's own spelling. A task's layer and the
// project's own share one shell (order, window, paging, the early answer, the task). Methods of the
// Engine (src/engine/helpers.js — mixin).

import { ToolError } from '../validate.js';
import { measureRefs } from '../compile.js';
import { PARTITION_DIM, renderContext } from '../yaml-render.js';
import { renderWhereClauses, wherePredicates } from '../predicate.js';
import { commonItems, resolveRef, refOf, tokenOf, columnOf, labelOf } from '../group-by-items.js';
import { formatDbtError } from '../dbt/index.js';
import { resolveTimeRange, timeRangeWarnings, isValidTimezone } from '../time-range.js';
import { uniqueRefs, clone, pageBlock } from './helpers.js';

export const semanticQueryMethods = {
  /** Map of task-local dimension name -> entity-qualified path (e.g. event__mon_product_id). */
  _taskDimMap(ctx) {
    const map = new Map();
    for (const [modelKey, add] of Object.entries(ctx.state.additions || {})) {
      const pe = this.catalog.primaryEntityName(modelKey);
      for (const d of add.dimensions || []) map.set(d.name, pe ? `${pe}__${d.name}` : d.name);
    }
    return map;
  },

  /**
   * What a context can group / filter by, in the form the tools accept: [{ model, attribute, via? }]
   * — the catalog's reachable attributes plus the dimensions the task declared.
   *
   * Split by whether the ref works RIGHT NOW: a query may only name a model the context has
   * loaded, so an attribute of a model it has not is offered separately, with what to do about it.
   * Publishing the whole catalog as `groupable` (and picking the example from it) produced calls
   * the query path then refused — "needs model 'users', which is not loaded in this context".
   */
  _groupableSplit(ctx) {
    const all = [...this.catalog.reachableAttributes()];
    for (const [model, add] of Object.entries(ctx.state.additions || {})) {
      for (const d of add.dimensions || []) {
        const attribute = d._attribute;
        if (!all.some((r) => r.model === model && r.attribute === attribute && !r.via)) all.push({ model, attribute });
      }
    }
    const loaded = new Set(ctx.state.usedModels || []);
    return { now: all.filter((r) => loaded.has(r.model)), afterLoading: all.filter((r) => !loaded.has(r.model)) };
  },

  /** One wording for "here is what you CAN name, and how to reach the rest", shared by every
   *  not-reachable refusal so they never disagree about what is available. */
  _reachableHint(ctx) {
    const { now, afterLoading } = this._groupableSplit(ctx);
    const show = (rs) => rs.slice(0, 20).map((r) => `${r.model}.${r.attribute}${r.via ? ` (via ${r.via})` : ''}`).join(', ');
    const models = [...new Set(afterLoading.map((r) => r.model))];
    return `Reachable now: ${show(now) || '(none beyond metric_time)'}.${models.length ? ` Also in the catalog, once the context reads their model (a semantic_models item { from: <model> }): ${show(afterLoading)}${afterLoading.length > 20 ? ', …' : ''}.` : ''}`;
  },

  /**
   * An attribute may be addressed WITHOUT knowing MetricFlow's `<entity>__<attribute>` spelling:
   * { model, attribute, via? } names the model that carries the attribute and the attribute
   * itself, and this resolves the path — the relationship the task's source declares towards
   * that model, or the model's own identity when the attribute is the source's own. `via` picks
   * the relationship when the source carries several to the same model (key variants).
   */
  _normalizeRef(ctx, ref, where = 'group_by') {
    if (ref && typeof ref === 'object' && 'entity' in ref && !('attribute' in ref)) {
      throw new ToolError(`${where}: the entity '${ref.entity}' is one of the dbt project's own semantic layer — group by it in the context of one of its semantic models (context_id: the semantic model's name; semantic_index({ request: {} }) lists them), with that model's metrics; here attributes are { model, attribute }.`, { stage: 'validate', field: where });
    }
    if (ref && typeof ref === 'object' && 'dimension' in ref && !('attribute' in ref)) {
      throw new ToolError(`${where}: '${[].concat(ref.semantic_model || []).join(' → ')}${ref.semantic_model ? '.' : ''}${ref.dimension}' is named as a dimension of the dbt project's own semantic layer — query it in the context of the semantic model whose metrics you want (context_id: its name; semantic_index({ request: {} }) lists them); here attributes are { model, attribute }.`, { stage: 'validate', field: where });
    }
    if (ref == null || typeof ref !== 'object' || !('attribute' in ref)) return ref;
    const c = this.catalog;
    const { model, attribute, via } = ref;
    if (!c.models[model]) throw new ToolError(`${where}: unknown model '${model}'. Models: ${c.modelKeys().join(', ')}${c.unavailableHint(model)}`, { stage: 'validate', field: 'model' });
    // A model the context never loaded is answered with the fix (load it: semantic_models [{ from }]),
    // not with the relationship refusal below: "not loaded" is the actual problem, and it is actionable.
    this._checkModelLoaded(ctx, ref);
    const target = c.getModel(model);
    // 1. a dimension the TASK declared on this model (a payload property or a model column named
    //    in create/update) → its task-namespaced name
    const declared = this._taskDimOf(ctx, model, attribute);
    if (declared) return this._taskDimMap(ctx).get(declared.name) || declared.name;
    // the model's own attributes: its dimensions and, on an events source, the event name (one set with
    // the schema's — modelDimensionColumns)
    if (!(target.dimensions || {})[attribute] && !c.modelDimensionColumns(model).includes(attribute)) {
      const known = c.modelDimensionColumns(model);
      throw new ToolError(`${where}: '${attribute}' is not an attribute of '${model}'. Its attributes: ${known.slice(0, 20).join(', ') || '(none — a payload property is declared as a task dimension first)'}`, { stage: 'validate', field: 'attribute' });
    }
    // The sources whose MEASURES this task reads: a path starts from one of them. A model loaded
    // only to be joined to (an item with only `from`) — even another events source — is a join TARGET
    // here, reached through the relationship a measure source declares towards it.
    const own = c.primaryEntityName(model);
    const sources = this._measureSources(ctx);
    // 2. the attribute of a model whose measures this task reads → under that model's identity
    if (sources.includes(model) && own) return `${own}__${attribute}`;
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
      if (!candidates.has(via)) throw new ToolError(`${where}: '${via}' is not a relationship from this task's source(s) to '${model}'. Available: ${[...candidates].join(', ') || '(none)'}`, { stage: 'validate', field: 'via' });
      return `${via}__${attribute}`;
    }
    if (candidates.size === 1) return `${[...candidates][0]}__${attribute}`;
    if (candidates.size > 1) throw new ToolError(`${where}: '${model}' is reachable through several relationships (${[...candidates].join(', ')}) — add via: '<relationship>' to say which key to join on.`, { stage: 'validate', field: 'via' });
    throw new ToolError(`${where}: no source in this context declares a relationship to '${model}' (it must OWN a key some source points at — type primary/unique). Load it (semantic_models: [{ from: '${model}' }]) and check semantic_index({ request: { model: '${model}' } }).relationships. ${this._reachableHint(ctx)}`, { stage: 'validate', field: 'model' });
  },

  /** The dimension a task declared on `model` for `attribute` — the one a reference resolves to first. */
  _taskDimOf(ctx, model, attribute) {
    return (ctx.state.additions?.[model]?.dimensions || []).find((d) => d._attribute === attribute) || null;
  },

  /**
   * The grain a { model, attribute } reference is read at when it is a TIME dimension — the task's
   * own copy at the grain it was declared with, else the model's at the catalog's granularity — or
   * null for a categorical one. MetricFlow names a time dimension's column with its grain
   * (`<path>__<grain>`), so the query asks for it at that grain, and the column comes back under
   * the caller's name like every other.
   */
  _timeGrainOf(ctx, { model, attribute }) {
    const declared = this._taskDimOf(ctx, model, attribute);
    if (declared) return declared.type === 'time' ? declared.type_params?.time_granularity || 'day' : null;
    const d = (this.catalog.getModel(model).dimensions || {})[attribute];
    return d?.type === 'time' ? d.granularity || 'day' : null;
  },

  async query_semantic_model(input) {
    this._validate('query_semantic_model', input);
    // the read half: { task_ids } waits for semantic tasks (a model being parsed, a query) and returns each
    if (input.cancel) return this._cancelTasks(input, 'semantic');
    if (input.task_ids) return this._pollTasks(input, 'semantic');
    const ctx = this._ctx(input.context_id);

    // A pipeline-registered model has no MetricFlow semantic model — its rows ARE
    // the result: read them from its build's task, or re-slice them with a pipeline started from it.
    if (ctx.state.engine === 'pipeline') {
      const built = ctx.state.pipeline_model?.task_id;
      throw new ToolError(`context ${ctx.id} holds a pipeline model (${ctx.state.model}), not metrics: ${built ? `read its rows with query_pipeline_model({ request: { task_ids: ['${built}'] } }), filter or regroup them with query_pipeline_model({ request: { context_id: '${ctx.id}', transform } }), or build on them with build_pipeline_model({ request: { action: 'start', name, from_task: '${built}' } })` : 're-slice it with a new pipeline'} — not query_semantic_model`, { stage: 'validate' });
    }
    // the dbt project's own semantic layer: its metrics and dimensions, as the project defines them
    const project = ctx.state.engine === 'project';
    const work = project ? (q) => this._projectQueryWork(ctx, q) : (q) => this._semanticQueryWork(ctx, q);
    // A BATCH (queries): every query is validated before any starts, and they run
    // side by side — one task each, read together with { task_ids }.
    if (input.queries) return this._startBatch(ctx, 'query_semantic_model', input.queries, (q) => work({ ...q, context_id: ctx.id }));
    // The project's context is never written after start (nothing is built on it) and every
    // conversation queries it: its queries run side by side, like a batch's members, instead of
    // each waiting for the one before it.
    // A query only compiled (dry_run) runs nothing on the warehouse: it waits for the
    // declaration it compiles, not behind the queries before it.
    const compileOnly = !!input.dry_run;
    const slot = project ? { batch: { before: null } } : compileOnly ? { batch: this.tasks.afterBuilds(ctx) } : {};
    return this._taskStarted(this._startTask(ctx, 'query_semantic_model', work(input), { input, ...slot }), { context_id: ctx.id });
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
   * MetricFlow's names, in the caller's spelling. A query is addressed by WHAT and WHERE — { model,
   * attribute }, { semantic_model, dimension }, { entity }, metric_time — and the server resolves that to MetricFlow's
   * `entity__dimension__grain` tokens. `names` maps each token the query used to the name the caller
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
        // dimensions it takes, its entities, and its time axis (preview_semantic_model gives every item)
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
      note: `The dbt project's own semantic models and metrics, read from the project at start (nothing to build). Each semantic model is a context of its own, named after it: query_semantic_model({ request: { context_id: '<semantic model>', metrics: [...], group_by: [{ semantic_model: [...], dimension }, { entity }, { time: 'metric_time', grain }] } }) — semantic_model is the chain of models a dimension is reached through: ['<the context>'] for its own, ['X'] for a model joined to directly, ['A', 'X'] through A. A metric is cut by the dimensions of the semantic models under its dimensions_from, and by its entities — a key the project declares only as an entity is grouped by its name. Its meta is what the project says about reading it. preview_semantic_model({ request: { context_id, metric } }) shows a metric's definition and its group_by — everything it can be grouped by; with validate: true it runs them.`,
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
    if (!input.metrics?.length) throw new ToolError(`metrics is required. The context '${ctx.id}' has: ${list()}`, { stage: 'validate', field: 'metrics' });
    for (const m of input.metrics) {
      if (known.has(m)) continue;
      const home = layer.metrics.find((x) => x.name === m)?.semantic_models;
      throw new ToolError(`'${m}' is not a metric of the context '${ctx.id}'${home ? ` — it reads ${home.join(', ')}: query it in ${home.length > 1 ? 'one of those contexts' : `the context '${home[0]}'`}` : ''}. The context has: ${list()}`, { stage: 'validate', field: 'metrics' });
    }
    // what EVERY requested metric can be grouped by, as MetricFlow listed it (src/group-by-items.js):
    // a reference names one of these items exactly — nothing here chooses a join, a path or a grain
    const items = commonItems(layer.groupBys, input.metrics);
    const pick = (ref, field) => {
      if (ref && typeof ref === 'object' && 'model' in ref) throw new ToolError(`${field}: in the context '${ctx.id}' (a semantic model of the dbt project's own layer) a dimension is { semantic_model: [the chain of models it is reached through], dimension } and an entity { entity } — the project's own names, not the catalog's { model, attribute }. preview_semantic_model({ request: { context_id: '${ctx.id}', metric } }) lists each exactly.`, { stage: 'validate', field });
      const r = resolveRef(items, ref, input.metrics.join(' and '), layer.blocked || []);
      if (r.error) throw new ToolError(`${field}: ${r.error}`, { stage: 'validate', field });
      return r.item;
    };
    const groupBy = [];
    const rename = new Map();
    const groupByResolved = {};
    for (const g of input.group_by || []) {
      const item = g && g.time === 'metric_time' ? items.find((i) => i.name === 'metric_time' && !i.semantic_model) : pick(g, 'group_by');
      if (!item) throw new ToolError(`group_by: ${input.metrics.join(', ')} ${input.metrics.length > 1 ? 'share' : 'has'} no time axis to group by`, { stage: 'validate', field: 'group_by' });
      const grain = item.type === 'time' ? g.grain || item.grain || 'day' : null;
      const tok = tokenOf(item, grain);
      const column = columnOf(item, grain);
      if (input.metrics.includes(column) || [...rename.values()].includes(column)) throw new ToolError(`group_by: ${labelOf(item)} would make a result column '${column}' that another column of this query already has`, { stage: 'validate', field: 'group_by' });
      groupBy.push(tok); rename.set(tok, column);
      if (!(g && g.time === 'metric_time')) groupByResolved[labelOf(item)] = column;
    }
    let where = [];
    // the MetricFlow names a where resolved to, in the caller's spelling (see _callerSpelling)
    const whereNames = new Map();
    if (input.where) {
      const translated = wherePredicates(clone(input.where));
      walkPredicates(translated, (p) => {
        if (p.field?.kind !== 'entity' && p.field?.kind !== 'dimension') return;
        const item = pick(p.field, 'where');
        whereNames.set(tokenOf(item), columnOf(item));
        if (item.kind === 'entity') { p.field = { kind: 'entity', name: tokenOf(item) }; return; }
        if (item.type === 'time') {
          whereNames.set(item.dunder_name, `${item.semantic_model}_${item.name}`);
          p.field = { kind: 'time_dimension', path: item.dunder_name, grain: item.grain || 'day' };
          return;
        }
        p.field = { kind: 'dimension', path: item.dunder_name };
      });
      where = renderWhereClauses(translated);
    }
    // order_by: a requested metric or a result column of group_by
    const { orderBy } = this._metricOrderBy(input, { groupBy, rename });
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    // the guardrail, as a task's query has it: a semantic model over a dbt model the catalog requires a
    // window for — or every one, when the deployment does — is not scanned whole
    const reads = [...new Set(input.metrics.flatMap((m) => known.get(m).semantic_models))];
    // (keyed by the dbt model dbt itself records each semantic model reads)
    const guarded = reads.filter((name) => this.catalog.requireTimeRangeForDbtModel(layer.sources?.[name] ?? null));
    const { bounds, windowWarnings } = this._metricWindow(input, guarded);
    const conversionNotes = this._conversionNotes(layer, input.metrics, { where: where.length > 0, window: !!(bounds.start || bounds.end) });
    const paging = this._metricPaging(input);
    const explain = this._compileOnly(input);
    const qopts = { metrics: input.metrics, groupBy, where, orderBy, startTime: bounds.start ?? undefined, endTime: bounds.end ?? undefined, limit: this._metricLimit(input, paging, explain) };
    const speak = this._callerSpelling(new Map([...this._localTimeTokens(layer), ...this._queryTokens(layer.metrics.map((m) => m.name)), ...this._listedTokens(Object.fromEntries(input.metrics.map((m) => [m, layer.groupBys[m] || []]))), ...whereNames, ...rename]));
    const respond = (raw) => {
      this.ctxs.touch(ctx.id);
      const early = this._metricEarlyAnswer(raw, { explain, input, speak, extra: conversionNotes.length ? { warnings: conversionNotes } : {} });
      if (early) return early;
      const columns = (raw.columns || []).map((c) => (rename.has(c.name) ? { ...c, name: rename.get(c.name) } : c));
      const { rows: pageRows, page } = paging.page((raw.rows || []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [rename.get(k) || k, v]))));
      const recs = [];
      if (!pageRows.length) recs.push('0 rows — a where that matches nothing, or a window with no data: widen time_range or re-check the filter.');
      if (page.has_more) recs.push(`More rows exist — page with offset: ${page.offset + page.limit} (same query), or add order_by + a tighter limit.`);
      return {
        ok: true, columns, rows: pageRows, row_count: pageRows.length, page,
        ...(Object.keys(groupByResolved).length ? { group_by_resolved: groupByResolved } : {}),
        provenance: { tier: 'project_metric', metrics: input.metrics, semantic_models: reads },
        warnings: [...windowWarnings, ...conversionNotes],
        recommendations: recs,
      };
    };
    return this._metricTask(ctx, { qopts, input, rename, speak, explain, respond });
  },

  // THE SHELL A METRIC QUERY RUNS IN — one for a task's context (_semanticQueryWork) and a project
  // semantic model's (_projectQueryWork): order_by, the window and its guardrail, paging, the answer
  // to a failure or an explain, and the task that runs it. What differs between the two is only how a
  // reference is resolved to MetricFlow's tokens and what a finished answer carries besides its rows.

  /** order_by → MetricFlow's order tokens. A key is a name the rows come back with — a requested
   *  metric, or the result column of a group_by item — never the token it is resolved to: that
   *  spelling is the server's own, and is free to change. → { orderBy, orderableKeys } */
  _metricOrderBy(input, { groupBy, rename }) {
    const orderable = new Set([...input.metrics, ...groupBy]);
    const orderableKeys = [...orderable].map((k) => rename.get(k) || k); // what the caller may name
    const byFriendly = new Map([...rename].map(([tok, friendly]) => [friendly, tok]));
    const sayable = new Set(orderableKeys);
    const orderBy = (input.order_by || []).map((o) => {
      if (!sayable.has(o.key)) throw new ToolError(`order_by key '${o.key}' is not a requested metric or the result column of a group_by item. Orderable: ${orderableKeys.join(', ')}`, { stage: 'validate', field: 'order_by' });
      return `${o.direction === 'desc' ? '-' : ''}${byFriendly.get(o.key) || o.key}`;
    });
    return { orderBy, orderableKeys };
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

  /** Paging: the page asked for, and one row over it fetched so has_more means something. */
  _metricPaging(input) {
    const limit = input.limit ?? 1000;
    const offset = input.offset ?? 0;
    const ordered = !!input.order_by?.length;
    return { limit, offset, fetch: limit + offset + 1, page: (rows) => { const page = rows.slice(offset, offset + limit); return { rows: page, page: pageBlock({ offset, limit, returned: page.length, has_more: rows.length > offset + limit, ordered }) }; } };
  },

  /** Whether a query is only compiled (dry_run); a plan is asked for only with it, and a result is
   *  stored only by a query that runs. */
  _compileOnly(input) {
    const only = !!input.dry_run;
    if (input.include_plan && !only) throw new ToolError('include_plan goes with dry_run: the dataflow plan is how a query compiles, and a query that runs returns its rows instead', { stage: 'validate', field: 'include_plan' });
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
    return { ok: true, sql: speak(res.sql), ...speak(extra), ...(input.dry_run ? { dry_run: true } : {}), ...(input.include_plan ? { plan: speak(res.plan) } : {}) };
  },

  /** The task a metric query is: the time spine first (a real query needs it for metric_time), then
   *  the query — stored as a table with materialize, else answered by `respond`. */
  _metricTask(ctx, { qopts, input, rename, speak, explain, respond }) {
    return async (id) => {
      if (!explain) await this._ensureTimeSpineBuilt(ctx.id);
      if (input.materialize && !explain) return this._materialize(ctx, qopts, input, rename, id, speak);
      return respond(await this.runner.query(this.ctxs.dir(ctx.id), { ...qopts, explain, plan: !!input.include_plan }));
    };
  },

  /**
   * One metric query, checked: every mistake is refused HERE (metrics, group_by, where values,
   * order_by, the time window), and what is returned is the work its task runs.
   */
  _semanticQueryWork(ctx, input) {

    const known = new Set(ctx.state.metrics.map((m) => m.name));
    if (!input.metrics?.length) throw new ToolError(`metrics is required for a metric query. This context defines: ${[...known].join(', ') || '(none — create metrics first)'}`, { stage: 'validate', field: 'metrics' });
    for (const m of input.metrics) if (!known.has(m)) throw new ToolError(`unknown metric in context: '${m}'. Available: ${[...known].join(', ') || '(none)'}`, { stage: 'validate', field: m });
    // a metric the context declares but its layer could not carry (a measure on a slowly-changing
    // model is dropped from what dbt parses) is refused HERE, not by MetricFlow minutes later
    const emitted = new Set(renderContext(this.catalog, ctx.state, { spec: this._semanticSpec() }).metricNames);
    const dropped = input.metrics.filter((m) => !emitted.has(m));
    if (dropped.length) throw new ToolError(`metric${dropped.length > 1 ? 's' : ''} ${dropped.map((m) => `'${m}'`).join(', ')} ${dropped.length > 1 ? 'are' : 'is'} declared in this context but not in its semantic layer: ${dropped.length > 1 ? 'they read' : 'it reads'} a measure on a slowly-changing model, where MetricFlow allows no measure (it is a join target only). Count on an events source instead (count_distinct of the user key), and group by that model's attributes. Queryable here: ${[...emitted].join(', ') || '(none)'}`, { stage: 'validate', field: 'metrics' });

    // what a reference reaches is _normalizeRef's one judgement: it resolves the reference or
    // refuses it, saying what is reachable (_reachableHint)
    const groupBy = [];
    // Result columns are named after the reference the caller made — `<model>_<attribute>` and
    // `metric_time_<grain>` — so nothing the caller reads back or addresses later (order_by, a
    // card, a pipeline started from the stored result) ever carries MetricFlow's internal `__` spelling.
    const rename = new Map(); // MetricFlow output name → the column name the caller sees
    const groupByResolved = {}; // "<model>.<attribute>" → the result column
    for (const gRaw of input.group_by || []) {
      const g = this._normalizeRef(ctx, gRaw, 'group_by'); // a string is refused here with the fix
      if (typeof g === 'object' && g.time === 'metric_time') {
        const tok = `metric_time__${g.grain || 'day'}`;
        groupBy.push(tok); rename.set(tok, `metric_time_${g.grain || 'day'}`); continue;
      }
      const friendly = `${gRaw.model}_${gRaw.attribute}`;
      if (input.metrics.includes(friendly) || [...rename.values()].includes(friendly)) throw new ToolError(`group_by: '${gRaw.model}.${gRaw.attribute}' would produce a result column '${friendly}' that clashes with another column of this query — rename the metric or drop the duplicate.`, { stage: 'validate', field: 'group_by' });
      // a time dimension is asked for at its grain — the column MetricFlow names with it
      const grain = this._timeGrainOf(ctx, gRaw);
      const tok = grain ? `${g}__${grain}` : g;
      groupBy.push(tok); rename.set(tok, friendly); groupByResolved[`${gRaw.model}.${gRaw.attribute}`] = friendly;
    }
    /** Apply the friendly names to a result (columns + row keys). */
    const friendlyResult = (columns, rows) => ({
      columns: (columns || []).map((c) => (rename.has(c.name) ? { ...c, name: rename.get(c.name) } : c)),
      rows: (rows || []).map((r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[rename.get(k) || k] = v; return o; }),
    });
    let where = [];
    let filterWarnings = [];
    // the MetricFlow names a where resolved to, in the caller's spelling (see _callerSpelling)
    const whereNames = new Map();
    if (input.where) {
      const translated = wherePredicates(clone(input.where));
      const specs = [];
      walkPredicates(translated, (p) => {
        // a field named the way a project semantic model's context names it is refused with that
        // context's name, as group_by refuses it (the schema takes both shapes in every context)
        if (p.field?.kind === 'entity' || (p.field?.kind === 'dimension' && ('dimension' in p.field || 'semantic_model' in p.field))) this._normalizeRef(ctx, p.field, 'where');
        if (p.field?.kind === 'dimension') {
          const label = `${p.field.model}.${p.field.attribute}`;
          const refModel = p.field.model; const refAttr = p.field.attribute;
          // The value-index key comes from the model the caller NAMED, while it is still here: a
          // path carries no source, so recovering it afterwards loses the guard on any name two
          // sources happen to share.
          const at = this.advisor.valueKeyForColumn(p.field.model, p.field.attribute);
          p.field.path = this._normalizeRef(ctx, { model: p.field.model, attribute: p.field.attribute, via: p.field.via }, 'where');
          whereNames.set(p.field.path, `${refModel}_${refAttr}`);
          delete p.field.model; delete p.field.attribute; delete p.field.via;
          // Verify the filter literal against the column's REAL values (source-scoped):
          // reject a wrong-cased/non-existent value instead of filtering to nothing.
          specs.push({ at, op: p.op, value: p.value, where: `where ${label}` });
        }
      });
      filterWarnings = this.advisor.guardFilterValues(specs); // throws on a case/typo/absent mismatch
      where = renderWhereClauses(translated);
    }
    // order_by: a requested metric or a result column of group_by
    const { orderBy, orderableKeys } = this._metricOrderBy(input, { groupBy, rename });

    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    // the guardrail covers every source this context reads, whichever one the metrics come from
    const guarded = (ctx.state.usedModels || []).filter((k) => this.catalog.requireTimeRangeFor(k)).map((k) => `source ${k}`);
    const { bounds, windowWarnings } = this._metricWindow(input, guarded);
    const paging = this._metricPaging(input);
    const partitionWhere = this._semanticPartitionWhere(ctx, bounds, input.metrics);
    const explain = this._compileOnly(input);
    const qopts = { metrics: input.metrics, groupBy, where: [...where, ...partitionWhere], orderBy, startTime: bounds.start ?? undefined, endTime: bounds.end ?? undefined, limit: this._metricLimit(input, paging, explain) };
    // The response is built from the runner's answer in ONE place, whether the query finished
    // inside the call or after it was handed back as a job.
    // …and the partition filter this query adds for its window, named as the caller would name it
    const [source] = this._measureSources(ctx);
    const partitionToken = source && this.catalog.primaryEntityName(source) ? [[`${this.catalog.primaryEntityName(source)}__${PARTITION_DIM}`, `${source}_${PARTITION_DIM}`]] : [];
    const spelled = new Map([...this._queryTokens((ctx.state.metrics || []).map((m) => m.name)), ...partitionToken, ...whereNames, ...rename]);
    const speak = this._callerSpelling(spelled);
    const respond = async (raw) => {
      this.ctxs.touch(ctx.id);
      const res = raw.ok && !explain ? { ...raw, ...friendlyResult(raw.columns, raw.rows) } : raw;
      // an explain or a failure is text that may quote any item MetricFlow resolved: spelled with its list
      const listed = !res.ok || explain ? await this._listedGroupBys(ctx, input.metrics) : null;
      const fully = listed ? this._callerSpelling(new Map([...this._localTimeTokens(this._previewLayer(ctx).layer), ...this._listedTokens(listed.groupBys), ...spelled])) : speak;
      const early = this._metricEarlyAnswer(res, { explain, input, speak: fully, extra: { orderable_keys: orderableKeys, ...(filterWarnings.length ? { warnings: filterWarnings } : {}) } });
      if (early) return early;
      const { rows: pageRows, page } = paging.page(res.rows);
      // A context can span several facts (e.g. crashes vs sessions compared over metric_time):
      // report the freshness of each one it reads, and headline the STALEST — that is the date
      // the combined result is actually complete through.
      // Freshness is a property of the sources whose MEASURES the query reads: every events source
      // in the context, plus a non-events source (a spend table) only when the task aggregates it.
      // A dimension joined for its attributes (installs) has a time axis too, but its latest install
      // says nothing about how complete a spend or events result is.
      const contributes = (k) => this.catalog.isFact(k) || ((ctx.state.additions?.[k]?.measures || []).length > 0) || Object.keys(this.catalog.getModel(k).measures || {}).length > 0;
      const factsRead = (ctx.state.usedModels || []).filter((k) => this.catalog.getModel(k).time?.column && contributes(k));
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
        if (!endDay || endDay > freshDay) recs.push(`Data is current only through ${freshDay} (latest event time)${endDay ? `, but your window ends ${endDay}` : ' and your window has no end'} — rows past ${freshDay} are empty/partial.`);
      }
      // #2 ZERO/degenerate result: almost always a scoping bug, not a real "0".
      if (pageRows.length === 0) recs.push('0 rows — usually an over-scoped where, a group_by with no data in this window, or a measure on a property that is NULL for the scoped events. Widen time_range, re-check the filter, or inspect the property coverage via semantic_index({ request: { source, property } }).');
      // #4 NON-ADDITIVE distinct across time → prefer HLL sketches (mergeable).
      const distinctMeasures = new Set();
      for (const add of Object.values(ctx.state.additions || {})) for (const mm of add.measures || []) if (mm.agg === 'count_distinct') distinctMeasures.add(mm.name);
      const usesDistinct = distinctMeasures.size && input.metrics.some((name) => { const metric = ctx.state.metrics.find((x) => x.name === name); return metric && [...measureRefs(metric, ctx.state.metrics)].some((dm) => distinctMeasures.has(dm)); });
      if (usesDistinct && groupBy.some((g) => String(g).startsWith('metric_time__'))) {
        recs.push('count_distinct is NOT additive across time buckets — do not sum the per-bucket values for a period total. Prefer HLL sketches (a build_pipeline_model pipeline: hll_init per bucket → hll_merge to combine): a high-accuracy distinct count that IS mergeable/re-aggregatable across buckets and segments. Or query the whole period without the time grain.');
      }
      if (page.has_more) recs.push(`More rows exist — page with offset: ${page.offset + page.limit} (same query), or add order_by + a tighter limit.`);
      recs.push('Re-slice or persist: pass materialize:true to keep the result as a table — a pipeline can then start from it (build_pipeline_model({ request: { action: \'start\', from_task } })) and re-slice it without recomputing; group differently or compare segments by re-querying with another group_by.');
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
          metrics: input.metrics,
          source: factsRead.length === 1 ? factsRead[0] : factsRead,
          data_freshness: fresh,
          ...(factsRead.length > 1 ? { data_freshness_by_source: freshByFact } : {}),
        },
        warnings: [...windowWarnings, ...filterWarnings, ...(pageRows.length ? [] : (filterWarnings.onEmpty || []))],
        recommendations: recs,
      };
      return out;
    };

    // The query is a TASK: validated above, run below, its response read with query_semantic_model({ request: { task_ids } }).
    // A metric query over a big window can outlast the client in front of this call — so no call
    // holds it.
    return this._metricTask(ctx, { qopts, input, rename, speak, explain, respond });
  },
};

function walkPredicates(group, fn) {
  for (const c of group.conditions || []) {
    if (c.conditions) walkPredicates(c, fn);
    else fn(c);
  }
}
