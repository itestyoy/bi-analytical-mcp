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
import { compilePythonStage, importAllowlist, runAstGate, frameProfile, pythonRunHints } from './python-model.js'; // registers the python pipeline stage
import { resolveTimeRange, timeRangeWarnings, isValidTimezone } from './time-range.js';
import { sqlLiteral } from './dialect.js';
import { renderPipeline } from './pipeline.js';
import { CatalogSearch } from './search.js';
import { rankFuzzy } from './fuzzy.js';
import { buildGuide } from './guide.js';
import { JobManager } from './jobs.js';
import { ValueIndex } from './value-index.js';
import { MemoryStore, targetKey, targetWords } from './memory.js';
import { openStore } from './store.js';
import { buildProjection } from './projection.js';
import { SUPPORTED_DIALECTS } from './dialects/index.js';
import { sqlConfigHeader } from './sql-header.js';

export class Engine {
  constructor({ catalog, contextManager, runner, recipes, sqlRunner, queryTimeoutMs, dbPath, store, resetDb = false, embedder, memoryDbPath, pythonBin, pythonModelConfig }) {
    this.catalog = catalog;
    this.recipes = recipes; // optional Recipes instance
    this.sqlRunner = sqlRunner; // optional async (sql) => { columns, rows } — for match_recognize
    // ONE shared store (single db file) for the job registry + value index. resetDb wipes
    // it on open (MCP_DB_RESET) before the managers read it.
    this.store = store || openStore({ dbPath, reset: resetDb });
    this._ownsStore = !store;
    this.jobs = new JobManager({ store: this.store }); // persisted if the store is
    this.valueIndex = new ValueIndex({ store: this.store }); // real event-property values (background-populated)
    // Memory is curated, non-re-derivable knowledge. By default it shares the store (and
    // survives reset). Point MCP_MEMORY_DB at a PERSISTENT volume to keep findings across
    // container restarts — then it lives in its own store, isolated from the value index.
    this._memoryStore = memoryDbPath ? openStore({ dbPath: memoryDbPath }) : null;
    this.memoryStore = new MemoryStore({ store: this._memoryStore || this.store, embedder }); // durable analyst findings, linked to catalog entities (the `memory` tool); embedder → semantic search
    // Target keys written before a target carried its source ('property:ad_type_of_event_data')
    // name an entity no source owns. Attributing one to a source now would be guessing which
    // entity was meant, so each is demoted ONCE to a searchable term instead: the note stays
    // findable, and every stored key that addresses a view is (kind, source, name).
    try {
      const moved = this.memoryStore.retarget((canon) => this._memoryCanonForward(canon));
      if (moved.targets) console.error(`[mcp] memory targets stored structurally: ${moved.targets} target(s) on ${moved.notes} note(s)`);
    } catch (e) { console.error(`[mcp] memory target migration skipped: ${e?.message || e}`); }
    this.catalogSearch = new CatalogSearch({ catalog, recipes, valueIndex: this.valueIndex }); // semantic_index({ search })
    this.queryTimeoutMs = queryTimeoutMs ?? 60000; // materialize -> background after this
    // Literal dbt.config extras the OPERATOR pins for every generated Python model (e.g.
    // {"submission_method":"bigframes"}); the caller never decides where the compute runs. The
    // catalog resolved them from the environment already — an injected value replaces them THERE,
    // before the schemas are built, so the stage schema, its validation and the compiled model all
    // describe the same runtime.
    if (pythonModelConfig) catalog.pythonRuntime = { ...catalog.pythonRuntime, config: pythonModelConfig };
    this.pythonModelConfig = catalog.pythonRuntime?.config || {};
    this.schemas = buildSchemas(catalog);
    // Recipes are NOT a standalone tool — they are building blocks surfaced THROUGH
    // semantic_index ({ recipe: id } for one, the overview list + { guide } per task family).
    // Constrain the recipe view to real ids when recipes are configured.
    // The recipe view offers the ids this server actually has — the schema says what exists.
    if (recipes) {
      const branch = (this.schemas.semantic_index?.oneOf || []).find((b) => b.properties?.recipe);
      if (branch) branch.properties.recipe = { type: 'string', enum: recipes.ids(), description: branch.properties.recipe.description };
    }
    this.validators = makeValidators(this.schemas);
    this.ctxs = contextManager || new ContextManager({});
    this.runner = runner; // optional; required for non-dry_run parse/query
    // The interpreter that runs the static gate over a python stage's functions (a local syntax /
    // safety check; the model itself runs where dbt sends it). The MetricFlow sidecar's Python.
    this.pythonBin = pythonBin || process.env.PYTHON_BIN || runner?.pythonBin || 'python3';
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
      building_block: 'This is a reusable template: take its `hack` (the technique) and adapt the payload to your exact question; feed a pipeline payload through build_native_model, a create_payload through create_semantic_model.',
    };
  }

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
    const eventTime = source ? this.catalog.getModel(source)?.time?.column : null;
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
  }

  _validate(tool, input) {
    const res = validateInput(this.validators[tool], input || {});
    if (!res.ok) throw new ToolError(`invalid input: ${res.errors.join('; ')}`, { stage: 'validate' });
  }

  /**
   * One stored memory target brought onto the current form. Older stores kept a target as a STRING
   * key ('property:ad_type', 'model:users'); a target is now the STRUCTURE it names, so the rewrite
   * returns an OBJECT — otherwise one note ends up holding both shapes and the key's own prefix
   * leaks into the text that is searched and embedded.
   *
   * A property/event key written without a source names no entity this catalog can address, and
   * which one was meant is not recoverable from the name — so it becomes a searchable term rather
   * than a guess. Returns null when the target is already structural.
   */
  _memoryCanonForward(stored) {
    if (stored && typeof stored === 'object') return null; // already a target, not a legacy key
    const raw = String(stored);
    const i = raw.indexOf(':');
    const kind = i > 0 ? raw.slice(0, i) : '';
    const key = i > 0 ? raw.slice(i + 1) : raw;
    if (kind === 'term') return memoryTarget('term', key).target;
    const dot = key.indexOf('.');
    // 'model:<source>' and the scoped 'property:<source>.<name>' name a real entity — keep what
    // they name, as the structure.
    if (kind === 'model' && this.catalog.models[key]) return memoryTarget('model', key).target;
    if ((kind === 'property' || kind === 'event') && dot > 0) {
      const source = key.slice(0, dot); const name = key.slice(dot + 1);
      if (this.catalog.models[source]) return memoryTarget(kind, source, name).target;
    }
    return memoryTarget('term', key.toLowerCase()).target;
  }

  /**
   * Resolve a memory TARGET to a canonical, typed key so a saved finding links to a real
   * semantic_index view. `{ source, name }` names an attribute, payload property or event of that
   * source exactly; `{ source }` alone names the model; `{ term }` is a phrase the catalog has no
   * entity for. There is no bare-name form: the source is always written, so nothing here has to
   * be attributed to an owner, and a name that source does not carry is refused rather than
   * fuzzily re-pointed at something else.
   */
  _resolveMemoryTarget(t) {
    const c = this.catalog;
    if (t && typeof t === 'object' && t.term !== undefined) return memoryTarget('term', String(t.term).trim());
    const source = String(t?.source ?? '').trim(); const name = t?.name == null ? null : String(t.name).trim();
    if (!c.models[source]) throw new ToolError(`memory target: unknown source '${source}'. Known sources: ${c.modelKeys().join(', ')}${c.unavailableHint(source)}`, { stage: 'validate', field: 'targets' });
    if (!name) return memoryTarget('model', source);
    if (c.attributeKind(source, name)) return memoryTarget('property', source, name);
    if (c.isFact(source) && c.eventNames(source).includes(name)) return memoryTarget('event', source, name);
    // The source is known, so a miss is a misspelling WITHIN it: suggest its own nearest names
    // rather than linking to something the caller did not write.
    const own = [...c.propertyEnumFor(source), ...(c.isFact(source) ? c.eventNames(source) : [])];
    const near = rankFuzzy(name, own, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => `'${m.item}'`);
    throw new ToolError(`memory target: '${name}' is not a property, attribute or event of '${source}'.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} semantic_index({ model: '${source}' }) lists what it carries.`, { stage: 'validate', field: 'targets' });
  }

  /** Where a resolved target's findings surface in semantic_index (a ready call to copy). */
  _memorySurfaceHint({ kind, addressable: target }) {
    if (kind === 'property') return `semantic_index({ source: '${target.source}', property: '${target.name}' })`;
    if (kind === 'event') return `semantic_index({ source: '${target.source}', event: '${target.name}' })`;
    if (kind === 'model') return `semantic_index({ model: '${target.source}' })`;
    return `semantic_index({ search: '${target.term}' })`;
  }

  /** Compact notes linked to any of these TARGETS, for attaching to a semantic_index view. */
  _memoryFor(targets) {
    return this.memoryStore.forTargets(targets.map(targetKey)).map(memoryView);
  }

  /**
   * Attach saved findings to a semantic_index view COMPACTLY (token-lean): the `cap` most recent,
   * each note truncated. Always leaves an explicit drill so nothing is lost — memory({ action:
   * 'list', target }) returns EVERY linked finding in full. `drillTarget` is the singular target
   * that view is about — { source, name } for a property/attribute/event, { source } for a model.
   */
  _attachMemory(out, targets, drillTarget, { cap = 3 } = {}) {
    const all = this.memoryStore.forTargets(targets.map(targetKey));
    if (!all.length) return;
    const shown = all.slice(0, cap).map((e) => memoryCompact(e));
    out.memory = shown.map((s) => s.view);
    const truncatedAny = shown.some((s) => s.truncated);
    const hiddenCount = all.length - shown.length;
    if (hiddenCount > 0) out.memory_more = hiddenCount;
    if (hiddenCount > 0 || truncatedAny) {
      (out.next_actions ||= []).push({
        call: `memory({ action: 'list', target: ${JSON.stringify(drillTarget)} })`,
        why: hiddenCount > 0
          ? `read all ${all.length} saved findings linked here IN FULL (only the ${shown.length} most recent are shown, truncated)`
          : `read the ${all.length} finding(s) above IN FULL (note text is truncated here)`,
      });
    }
  }

  /**
   * THE analyst memory tool. Save a FINDING the AI made (a vague phrasing tracked down to a
   * real field, a non-obvious gotcha, an associated source/link) and LINK it to the catalog
   * entities it concerns, so it surfaces back THROUGH semantic_index (the linked { model }/
   * { source, event }/{ source, property } views and { search }) next time the same word/field comes up.
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
      const entry = this.memoryStore.record({ note, question, targets: resolved.map((r) => r.target), aliases, links });
      return {
        saved: true,
        id: entry.id,
        note: entry.note,
        ...(question ? { question } : {}),
        linked_to: resolved.map((r) => ({ kind: r.kind, target: r.addressable, surfaces_in: this._memorySurfaceHint(r) })),
        ...(resolved.some((r) => r.kind === 'term') ? { unresolved_terms: resolved.filter((r) => r.kind === 'term').map((r) => r.addressable.term) } : {}),
        aliases, links,
        next: 'Saved. This finding now surfaces in semantic_index on the linked entities and via semantic_index({ search }) (and memory({ action: "search" })) — including the aliases/words above.',
      };
    }

    if (action === 'list') {
      if (input.target !== undefined) {
        const r = this._resolveMemoryTarget(input.target);
        return { target: r.addressable, kind: r.kind, notes: this.memoryStore.forTargets([targetKey(r.target)]).map(memoryView) };
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

  /**
   * The context by id, checked against the catalog AS IT IS NOW. A context is a set of declarations
   * over models, and a later grounding pass may have found that the warehouse no longer backs one
   * of them — reported here with the grounding reason, not as a bare 'Unknown model' thrown from
   * inside the renderer.
   */
  _ctx(id) {
    let ctx;
    try { ctx = this.ctxs.get(id); } catch (e) { throw new ToolError(e.message, { stage: 'validate', field: 'context_id' }); }
    const gone = [...new Set([...(ctx.state.usedModels || []), ...Object.keys(ctx.state.additions || {})])].filter((k) => !this.catalog.models[k]);
    if (gone.length) {
      throw new ToolError(`context '${id}' was built over ${gone.map((k) => `'${k}'`).join(', ')}, which the catalog no longer serves${this.catalog.unavailableHint(gone[0])} Start a new context over the sources that are available (semantic_index() lists them).`, { stage: 'validate', field: 'context_id' });
    }
    return ctx;
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
    const tasks = ctx.state.tasks || [];
    for (const [model, add] of Object.entries(ctx.state.additions || {})) {
      for (const d of add.dimensions || []) {
        const attribute = declaredAttribute(d, tasks);
        if (!all.some((r) => r.model === model && r.attribute === attribute && !r.via)) all.push({ model, attribute });
      }
    }
    const loaded = new Set(ctx.state.usedModels || []);
    return { now: all.filter((r) => loaded.has(r.model)), afterLoading: all.filter((r) => !loaded.has(r.model)) };
  }

  /** The refs a query in THIS context may name today — what the tools publish as `groupable`. */
  _groupableRefs(ctx) {
    return this._groupableSplit(ctx).now;
  }

  /** One wording for "here is what you CAN name, and how to reach the rest", shared by every
   *  not-reachable refusal so they never disagree about what is available. */
  _reachableHint(ctx) {
    const { now, afterLoading } = this._groupableSplit(ctx);
    const show = (rs) => rs.slice(0, 20).map((r) => `${r.model}.${r.attribute}${r.via ? ` (via ${r.via})` : ''}`).join(', ');
    const models = [...new Set(afterLoading.map((r) => r.model))];
    return `Reachable now: ${show(now) || '(none beyond metric_time)'}.${models.length ? ` Also in the catalog, once their model is loaded (use_base_models): ${show(afterLoading)}${afterLoading.length > 20 ? ', …' : ''}.` : ''}`;
  }

  /** All group-by/where dimension paths allowed for a context (bare + qualified). */
  _allowedPaths(ctx) {
    const set = new Set(this.catalog.reachableGroupByPaths());
    for (const [bare, qualified] of this._taskDimMap(ctx)) { set.add(bare); set.add(qualified); }
    return set;
  }

  /** The structured spelling of a legacy `<entity>__<attribute>` / task-dimension path, for error messages. */
  _suggestRef(ctx, path) {
    const c = this.catalog;
    const p = String(path);
    if (p === 'metric_time') return "{ time: 'metric_time', grain: 'day' }";
    // A PATH is a caller-typed legacy spelling, so reading it apart here is reading INPUT, not
    // recovering something we discarded. Every segment but the last is a relationship hop: follow
    // them to the model that actually carries the attribute, instead of assuming one hop.
    if (p.includes('__')) {
      const segs = p.split('__');
      const attr = segs[segs.length - 1];
      const hops = segs.slice(0, -1);
      const model = c.joinTargetFor(hops[hops.length - 1]);
      if (!model) return `{ model: '<the model that owns ${hops[hops.length - 1]}>', attribute: '${attr}' }`;
      if (hops.length > 1) return `{ model: '${model}', attribute: '${attr}' } (reached through ${hops.join(' → ')})`;
      const identity = c.primaryEntityName(model);
      return `{ model: '${model}', attribute: '${attr}'${hops[0] !== identity ? `, via: '${hops[0]}'` : ''} }`;
    }
    for (const [model, add] of Object.entries(ctx.state.additions || {})) {
      const d = (add.dimensions || []).find((x) => x.name === p);
      if (d) return `{ model: '${model}', attribute: '${declaredAttribute(d, ctx.state.tasks || [])}' }`;
    }
    return `{ model: '<model>', attribute: '${p}' }`;
  }

  /**
   * An attribute may be addressed WITHOUT knowing MetricFlow's `<entity>__<attribute>` spelling:
   * { model, attribute, via? } names the model that carries the attribute and the attribute
   * itself, and this resolves the path — the relationship the task's source declares towards
   * that model, or the model's own identity when the attribute is the source's own. `via` picks
   * the relationship when the source carries several to the same model (key variants). A string
   * is returned unchanged, so both spellings flow through the same validation.
   */
  _normalizeRef(ctx, ref, where = 'group_by') {
    if (typeof ref === 'string') {
      throw new ToolError(`${where}: an attribute is addressed by where it lives — { model, attribute } (plus via when several relationships lead there) — never by a path string. '${ref}' → ${this._suggestRef(ctx, ref)}.`, { stage: 'validate', field: where });
    }
    if (ref == null || typeof ref !== 'object' || !('attribute' in ref)) return ref;
    const c = this.catalog;
    const { model, attribute, via } = ref;
    if (!c.models[model]) throw new ToolError(`${where}: unknown model '${model}'. Models: ${c.modelKeys().join(', ')}${c.unavailableHint(model)}`, { stage: 'validate', field: 'model' });
    const target = c.getModel(model);
    // 1. a dimension the TASK declared on this model (a payload property or a model column named
    //    in create/update_semantic_model) → its task-namespaced name
    const tasks = ctx.state.tasks || [];
    for (const d of (ctx.state.additions?.[model]?.dimensions || [])) {
      if (declaredAttribute(d, tasks) === attribute) return this._taskDimMap(ctx).get(d.name) || d.name;
    }
    if (!(target.dimensions || {})[attribute]) {
      const known = Object.keys(target.dimensions || {});
      throw new ToolError(`${where}: '${attribute}' is not an attribute of '${model}'. Its attributes: ${known.slice(0, 20).join(', ') || '(none — a payload property is declared as a task dimension first)'}`, { stage: 'validate', field: 'attribute' });
    }
    // The sources whose MEASURES this task reads: a path starts from one of them. A model loaded
    // only to be joined to (use_base_models) — even another events source — is a join TARGET
    // here, reached through the relationship a measure source declares towards it.
    const own = c.primaryEntityName(model);
    const measureSources = Object.entries(ctx.state.additions || {}).filter(([, a]) => (a.measures || []).length).map(([k]) => k);
    const baseOwners = (ctx.state.metrics || []).flatMap((m) => [m?.type_params?.measure?.name].filter(Boolean)).map((ref) => c.modelOwningMeasure(ref)).filter(Boolean);
    const sources = [...new Set([...measureSources, ...baseOwners])].filter((k) => ctx.state.usedModels?.includes(k));
    // 2. the attribute of a model whose measures this task reads → under that model's identity
    if (sources.includes(model) && own) return `${own}__${attribute}`;
    // 3. a relationship from a measure source to the model that owns it
    const candidates = new Set();
    for (const src of sources) {
      for (const [ent] of Object.entries(c.entitiesOf(src))) if (c.joinTargetFor(ent) === model) candidates.add(ent);
    }
    if (!candidates.size && own && c.joinTargetFor(own) === model) candidates.add(own); // reached under its identity
    if (via) {
      if (!candidates.has(via)) throw new ToolError(`${where}: '${via}' is not a relationship from this task's source(s) to '${model}'. Available: ${[...candidates].join(', ') || '(none)'}`, { stage: 'validate', field: 'via' });
      return `${via}__${attribute}`;
    }
    if (candidates.size === 1) return `${[...candidates][0]}__${attribute}`;
    if (candidates.size > 1) throw new ToolError(`${where}: '${model}' is reachable through several relationships (${[...candidates].join(', ')}) — add via: '<relationship>' to say which key to join on.`, { stage: 'validate', field: 'via' });
    throw new ToolError(`${where}: no source in this context declares a relationship to '${model}' (it must OWN a key some source points at — type primary/unique). Load it with use_base_models and check semantic_index({ model: '${model}' }).relationships.`, { stage: 'validate', field: 'model' });
  }

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
        if (viaable.length) notes.push(`Join with the declared relationship rather than restating columns: build_native_model add_step { stage: 'join', with: '${viaable[0].joins}', via: '${viaable[0].entity}' }. In a metric query, group by { model: '${viaable[0].joins}', attribute: '<attr>'${viaable[0].entity !== c.primaryEntityName(viaable[0].joins) ? `, via: '${viaable[0].entity}'` : ''} } with use_base_models: ['${viaable[0].joins}'].`);
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
        out.aggregatable_note = `Amounts, not attributes: aggregate them, do not group by them. No aggregation is fixed in the schema — pick the one the question needs: create_semantic_model({ semantic_models: [{ from: '${k}', measures: [{ name: <your name>, agg: 'sum' | 'average' | 'max' | 'min' | 'median' | 'percentile' | 'count' | 'count_distinct', field: '${amounts[0].name}' }] }] }) (percentile also takes { percentile: 0.9 }).`;
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
    }

    // ── { source, event }: the properties populated on this event (NULL on others) ──
    if (input.event) {
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
    }

    // ── { source, property }: one property's full spec ──
    if (input.property) {
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
        recommendations.push(ent
          ? `Group/filter by it in metric queries as { model: '${mk}', attribute: '${col}'${ent !== this.catalog.primaryEntityName(mk) ? `, via: '${ent}'` : ''} } (declare use_base_models: ['${mk}']), or reference '${col}' after a pipeline join with:'${mk}'.`
          : `Reference '${col}' after a pipeline join with:'${mk}' (build_native_model join stage).`);
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
    }

    // ── { bundle }: per-app coverage — which event properties are POPULATED vs EMPTY for
    // one app (bundle id). Lets the AI skip properties that carry no data for the chosen app
    // instead of querying them blindly. Requires the anchor to designate a bundle column
    // (meta.mcp.dimension:{bundle:true}) AND the value index to have run. ──
    if (input.bundle !== undefined && input.bundle !== false) {
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
    }

    // ── default: compact OVERVIEW (no per-property dump, no warehouse calls) ──
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
          note: 'A pipeline may end in a `python` stage (build_native_model add_step { stage: "python", … }): dbt runs it as a Python model on the warehouse runtime.',
        }
        : { available: false, reason: c.pythonRuntime?.reason, note: 'No `python` pipeline stage on this warehouse — pipelines are SQL only.' },
      // dbt connects with an adapter this server writes no SQL for, so the SQL is rendered in
      // another dialect's syntax against it — true of this deployment, and worth knowing when SQL
      // a pipeline generated is rejected by the engine that runs it.
      ...(c.dialectFallback ? { dialect_note: `dbt connects with the '${c.dialectFallback.profile_type}' adapter, which this server writes no SQL for: pipelines are rendered as ${c.dialectFallback.rendering_as} SQL${c.dialectFallback.explicit ? ' (set explicitly)' : ''}. Supported natively: ${[...SUPPORTED_DIALECTS].join(', ')}.` } : {}),
      // Declared models the warehouse cannot back (a structural column or the table is missing):
      // excluded from every tool; the reason is here so the analyst can be told what to fix.
      ...(Object.keys(c.unavailableModels()).length ? { unavailable_models: Object.fromEntries(Object.entries(c.unavailableModels()).map(([k, u]) => [k, { role: u.role, dbt_model: u.dbt_model, reason: u.reason }])), unavailable_note: 'These models are declared in the catalog but their tables lack a structural column (or do not exist), so no tool accepts them. semantic_index({ model }) on one shows what is missing.' } : {}),
      ...(c.facts.length > 1 ? { facts_note: `${c.facts.length} INDEPENDENT, equal events sources (${c.facts.join(', ')}) — each owns its events, payload properties and indexed values, and they are never mixed. Name the source you mean: semantic_index({ source, event }), build_native_model({ source }), semantic_models[].from; within one source, names are used as-is. A funnel runs over ONE source, while metrics from different sources can still be compared side by side over metric_time.` } : {}),
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
        ? `Group or filter by { model: '${userModel}', attribute: '${exAttr || 'country'}' } and the '${userModel}' model is joined by its declared key at query time (declare use_base_models: ['${userModel}'] in create_semantic_model) — never spell a join path. In native pipelines, reach the same attributes with a join stage (with: '${userModel}', via: '${c.primaryEntityName(userModel) || 'user'}').`
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
      enums: { agg: AGG, metric_type: ['simple', 'ratio', 'cumulative', 'derived', 'conversion'], time_granularity: c.timeGranularities() },
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
  }



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
  }

  /** Compact row for a property's per-run indexing record. */
  _indexPropRow(r) {
    return { ...(r.source ? { source: r.source } : {}), property: r.property, ms: r.ms, values: r.values_written, distinct_count: r.distinct_count, total_count: r.total_count, status: r.status, ...(r.error ? { error: r.error } : {}) };
  }

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
  }

  /** Per-sync indexing history of one key: { runs, avg_ms, history } (most recent first). */
  _indexHistory(source, key, recent = 10) {
    const history = this.valueIndex.propertyHistory(source, key, { limit: recent }).map((r) => ({ run_id: r.run_id, started_at: r.started_at, ...this._indexPropRow(r) }));
    const timed = history.filter((r) => r.ms != null);
    return { runs: history.length, avg_ms: timed.length ? Math.round(timed.reduce((s, r) => s + r.ms, 0) / timed.length) : null, history };
  }

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
    // Batch-fallback events of the last run (combined scan failed → per-property, FULL reason).
    const fallbacks = (last?.id != null && this.valueIndex.runNotes) ? this.valueIndex.runNotes(last.id).map((n) => n.note) : [];

    const jobs = this.jobs.list(); // [{ query_id, status, table, context_id, age_ms }]
    const running = jobs.filter((j) => j.status === 'running');
    const byStatus = jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {});

    const recommendations = [];
    if (sync.running) recommendations.push(`A value-index refresh is in progress — values/cardinality in semantic_index may still be filling in.`);
    else if (sync.total_runs === 0) recommendations.push(`The value index has not run yet — semantic_index({ source, property }) will show no sample_values until the first sync (it runs in the background at startup).`);
    else if (last?.status === 'error') recommendations.push(`The last value-index sync FAILED (${last.error || 'unknown error'}); sample_values may be stale or empty. Check the data source.`);
    else if (secsSince != null) recommendations.push(`Value index is ${sync.indexed_properties} properties / ${sync.total_values} values, last synced ${secsSince}s ago. Inspect a property's values via semantic_index({ source, property }).`);
    if (running.length) recommendations.push(`${running.length} query job(s) running — poll with get_query_result({ query_id }); semantic_index({ status }) lists them.`);
    if (slowest.length && last?.id != null) recommendations.push(`Per-property timing: semantic_index({ run: ${last.id} }) for the full breakdown, or semantic_index({ source: '${slowest[0].source}', property: '${slowest[0].property}' }) for one property across syncs.`);
    if (fallbacks.length) recommendations.push(`${fallbacks.length} batch(es) fell back to per-property — combined scan failed. Full reason in value_index.last_run_fallbacks[] (also semantic_index({ run: ${last.id} }).fallbacks).`);
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
        ...(fallbacks.length ? { last_run_fallbacks: fallbacks } : {}),
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

  /**
   * The model a reference resolves onto must be LOADED in this context: a task built from one
   * source does not load another's semantic model, so MetricFlow would reject the entity. The
   * model is taken from the reference the caller wrote — the compiled path is not read back.
   */
  _checkModelLoaded(ctx, ref) {
    const model = ref?.model;
    if (!model || !this.catalog.models[model]) return; // metric_time, a bare token, or already refused
    if (ctx.state.usedModels?.includes(model)) return;
    throw new ToolError(
      `'${model}.${ref.attribute}' needs model '${model}', which is not loaded in this context. `
        + `Recreate/update the task with use_base_models including '${model}'.`,
      { stage: 'validate', field: 'model' },
    );
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
    if (input.action === 'fork') return this._draftFork(input); // branches a NEW draft (no live draft required)
    const ctx = this._ctx(input.draft_id);
    const draft = ctx.state.draft;
    if (!draft) throw new ToolError(`no draft in context '${input.draft_id}' — start one with build_native_model({ action: 'start', name })`, { stage: 'validate', field: 'draft_id' });
    this.ctxs.touch(ctx.id);
    if (input.action === 'add_step') return this._draftAddStep(ctx, draft, input.stage, input.include_columns, input.include_steps);
    if (input.action === 'add_steps') return this._draftAddSteps(ctx, draft, input.stages, input.include_columns);
    if (input.action === 'edit_step') return this._draftEditStep(ctx, draft, input.index, input.stage, input.include_columns);
    if (input.action === 'insert_step') return this._draftInsertStep(ctx, draft, input.index, input.stage, input.include_columns);
    if (input.action === 'delete_step') return this._draftDeleteStep(ctx, draft, input.index, input.include_columns);
    if (input.action === 'truncate') return this._draftTruncate(ctx, draft, input.after, input.include_columns);
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

  // ---- CHECKPOINTS: a materialized prefix of the draft ---------------------------------------
  // `materialize` no longer ends the draft: the table it built STANDS FOR the first `at` stages, so
  // the steps added after it read that table instead of recomputing the prefix (an expensive
  // aggregate, a python model). Several materializations chain into several checkpoints.
  // The checkpoints live in the draft — the thing we own and edit — so invalidation is POSITIONAL
  // and needs no hashing: editing step i retires every checkpoint whose baked prefix contains i.
  // Freshness is not positional, so it rides on the value index's own run marker: a completed index
  // scan (whatever it found) means the underlying data may have moved, and every checkpoint taken
  // before it is retired.

  /** The value index's current run marker — a checkpoint built under a different one is stale. */
  _indexRunId() {
    try { return this.valueIndex?.syncStatus?.({ recent: 1 })?.last_successful_run?.id ?? null; }
    catch { return null; } // no index / unreadable status → nothing to compare against
  }

  /** null when the checkpoint is usable, { retire: why } when it never will be, { building } while its build runs. */
  _checkpointState(cp) {
    if (!this.ctxs.has(cp.owner)) return { retire: `the context that built ${cp.model} (${cp.owner}) is gone` };
    if (!this.ctxs.hasPipelineModel(cp.owner, cp.model)) return { retire: `the model ${cp.model} no longer exists` };
    if (cp.query_id) {
      const job = this.jobs.get(cp.query_id);
      if (!job) return { retire: `the build of ${cp.model} left no job record` };
      if (job.status === 'error') return { retire: `the build of ${cp.model} failed` };
      // Still 'running', but only THIS process drives a build: a job inherited from the store is
      // one whose builder is gone, so waiting on it forever is wrong — retire it and rebuild.
      if (job.status !== 'ready') return this.jobs.isLive?.(cp.query_id) ? { building: cp.query_id } : { retire: `the build of ${cp.model} did not finish (its builder is gone)` };
    }
    const run = this._indexRunId();
    if ((cp.index_run_id ?? null) !== run) return { retire: `the value index was refreshed after ${cp.model} was built, so the source data may have moved` };
    return null;
  }

  /**
   * The last checkpoint of `list` that can still be read from, with the stale ones retired.
   * A checkpoint whose build is still running carries valid COLUMNS (so the draft keeps growing),
   * but nothing can read its table yet — forBuild refuses instead of silently recomputing.
   */
  _useCheckpoint(list = [], { forBuild = false } = {}) {
    const retired = []; let checkpoint = null;
    for (let i = list.length - 1; i >= 0 && !checkpoint; i -= 1) {
      const st = this._checkpointState(list[i]);
      if (st?.retire) { retired.push({ at: list[i].at, model: list[i].model, reason: st.retire }); continue; }
      if (st?.building && forBuild) {
        throw new ToolError(
          `steps 1..${list[i].at} are still being materialized as ${list[i].model} — nothing can read that table yet, so a second build would only duplicate the work. `
          + `Poll get_query_result({ query_id: '${st.building}' }) and materialize again once it is ready; if that build is gone for good (the server restarted), retire it with truncate/edit_step at or before step ${list[i].at} — or context({ action: 'delete_model' }) — and materialize again.`,
          { stage: 'validate', field: 'draft_id' },
        );
      }
      checkpoint = list[i];
    }
    const gone = new Set(retired.map((r) => r.model));
    return { checkpoint, retired, surviving: list.filter((cp) => !gone.has(cp.model)) };
  }

  /**
   * How the draft renders RIGHT NOW: from the catalog source, or from the last live checkpoint.
   * `dropFrom` retires the checkpoints an edit at that step invalidates BEFORE choosing (they are
   * only written back to the draft once the edit validates). `stepOf` maps a position in the
   * rendered stage list back to the draft's own step numbering, so an error still names the step
   * the caller sees.
   */
  _renderPlan(draft, stages = draft.stages, { dropFrom = null, forBuild = false } = {}) {
    const all = draft.checkpoints || [];
    const dropped = dropFrom == null ? [] : all.filter((cp) => cp.at >= dropFrom);
    const kept = dropped.length ? all.filter((cp) => !dropped.includes(cp)) : all;
    const { checkpoint, retired, surviving } = this._useCheckpoint(kept, { forBuild });
    if (checkpoint) this.ctxs.touch(checkpoint.owner); // a checkpoint in use keeps its owner alive
    if (!checkpoint) {
      const effective = this._draftEffectiveStages({ ...draft, stages });
      const offset = effective.length - stages.length;
      return { from: null, checkpoint: null, stages: effective, dropped, retired, checkpoints: surviving, stepOf: (i) => i - offset };
    }
    return {
      from: { model: checkpoint.model, columns: checkpoint.columns },
      checkpoint, stages: stages.slice(checkpoint.at), dropped, retired, checkpoints: surviving,
      stepOf: (i) => checkpoint.at + i,
    };
  }

  /**
   * Whether a built relation still carries the SOURCE's own identifying columns (event name, time
   * axis, payload). It decides nothing by itself — every stage validates the columns it reads —
   * but it is what makes "can I still run a funnel on this?" answerable from the checkpoint alone.
   */
  _carriesSource(source, columns) {
    const m = this.catalog.getModel(source);
    const need = [m.event_name?.column, m.time?.column, m.event_data_column].filter(Boolean);
    if (!need.length) return null;
    const have = new Set(columns.map((c) => c.name));
    return need.every((n) => have.has(n)) ? source : null;
  }

  /** Delete the files of checkpoints this context owns and nobody else reads (a fork may). */
  _retireCheckpointFiles(ctx, checkpoints = []) {
    for (const cp of checkpoints) {
      if (cp.owner !== ctx.id) continue; // another context's model: not ours to remove
      if ((ctx.state.checkpoint_consumers?.[cp.model] || []).some((id) => this.ctxs.has(id))) continue;
      this.ctxs.removePipelineFiles(ctx.id, cp.model);
    }
  }

  /** Columns available after a draft's accumulated stages (source columns when empty),
   *  grounded to the physical relation (phantom catalog columns excluded). */
  _draftColumns(draft, physSet) {
    if (!draft.stages.length) return this._groundedDeclared(draft.source, physSet).cols;
    const plan = this._renderPlan(draft);
    const { columns } = renderPipeline(this.catalog, this.catalog.dialect, draft.source, plan.stages, { physicalCols: physSet, from: plan.from });
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
    const ctx = input.draft_id ? this._ctx(input.draft_id) : this.ctxs.create();
    const source = input.source;
    ctx.state.draft = { name: input.name, source, materialized: input.materialized || 'table', time_range: input.time_range || null, stages: [], checkpoints: [], builds: 0 };
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

  async _draftAddStep(ctx, draft, stage, includeColumns = false, includeSteps = false) {
    return this._draftCommit(ctx, draft, [...draft.stages, stage], { changedStage: stage, includeColumns, includeSteps, action: 'add_step' });
  }

  /**
   * Append SEVERAL stages in one call, applied SEQUENTIALLY. The response folds the per-step
   * effects together — for each stage, how it changed the columns (added / removed count) and any
   * warnings — so you see the same "how each application affected the data" detail as adding them
   * one at a time, in a single reply. ATOMIC: if any stage fails validation the whole batch is
   * rolled back (nothing applied) and the failing step is named. NB: adding many steps blind is
   * discouraged — the response says so.
   */
  async _draftAddSteps(ctx, draft, stages, includeColumns = false) {
    if (!Array.isArray(stages) || !stages.length) throw new ToolError('add_steps needs a non-empty `stages` array', { stage: 'validate', field: 'stages' });
    const snapshot = draft.stages.slice(); // atomic: restore on any failure so the draft is never half-applied
    const effects = [];
    try {
      for (const stage of stages) {
        const r = await this._draftCommit(ctx, draft, [...draft.stages, stage], { changedStage: stage, includeColumns: false, includeSteps: true, action: 'add_step' });
        effects.push({
          step_index: r.step_index,
          stage: stage.stage,
          column_count: r.column_count,
          columns_added: r.columns_added,
          columns_removed_count: r.columns_removed_count,
          ...(r.columns_removed ? { columns_removed: r.columns_removed } : {}),
          notes: r.recommendations, // per-step warnings/nudges (filter guard, empty-combination, funnel, etc.)
        });
      }
    } catch (e) {
      draft.stages = snapshot; this.ctxs.touch(ctx.id);
      throw new ToolError(`${e.message} — NO steps applied (add_steps is atomic; fix that stage and retry, ideally in a smaller chunk)`, { stage: 'compile', field: 'stages' });
    }
    const physSet = await this._physicalCols(draft.source);
    const after = this._draftColumns(draft, physSet);
    const resp = {
      draft_id: ctx.id, action: 'add_steps', added: effects.length,
      steps: this._draftSteps(draft),
      // The sequential effect of EACH stage, in order — the combined view of what would have been
      // N separate add_step replies. Read it top-to-bottom to see how the data narrowed/expanded.
      step_effects: effects,
      column_count: after.length,
      next: 'Review step_effects (each stage\'s column delta + notes), then add the NEXT logical chunk or materialize.',
      recommendations: [
        'STRONGLY recommended: add stages in small LOGICAL chunks (e.g. scope+derive, THEN the funnel, THEN aggregate) rather than the whole pipeline at once — you see how each chunk changes the data and catch a mistake before it compounds across later steps.',
      ],
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  }

  /** Validate `index` (1-based) against the current stage count for an edit op. */
  _stepIndex(draft, index, action) {
    if (!Number.isInteger(index) || index < 1 || index > draft.stages.length) {
      throw new ToolError(`${action} index=${index} out of range — the draft has ${draft.stages.length} step(s); use 1..${draft.stages.length} (see steps[].index)`, { stage: 'validate', field: 'index' });
    }
    return index;
  }

  /** Replace step N in place (then revalidate the whole pipeline end-to-end). */
  async _draftEditStep(ctx, draft, index, stage, includeColumns = false) {
    const i = this._stepIndex(draft, index, 'edit_step');
    const next = draft.stages.slice(); next[i - 1] = stage;
    return this._draftCommit(ctx, draft, next, { changedStage: stage, includeColumns, action: 'edit_step', stepIndex: i, dropFrom: i });
  }

  /** Insert a step BEFORE position N (1-based; N = count+1 appends). */
  async _draftInsertStep(ctx, draft, index, stage, includeColumns = false) {
    if (!Number.isInteger(index) || index < 1 || index > draft.stages.length + 1) {
      throw new ToolError(`insert_step index=${index} out of range — use 1..${draft.stages.length + 1} (insert before that step; ${draft.stages.length + 1} appends)`, { stage: 'validate', field: 'index' });
    }
    const next = draft.stages.slice(); next.splice(index - 1, 0, stage);
    return this._draftCommit(ctx, draft, next, { changedStage: stage, includeColumns, action: 'insert_step', stepIndex: index, dropFrom: index });
  }

  /** Delete step N (then revalidate the remaining downstream steps). */
  async _draftDeleteStep(ctx, draft, index, includeColumns = false) {
    const i = this._stepIndex(draft, index, 'delete_step');
    const next = draft.stages.slice(); next.splice(i - 1, 1);
    return this._draftCommit(ctx, draft, next, { changedStage: null, includeColumns, action: 'delete_step', stepIndex: Math.min(i, next.length), dropFrom: i });
  }

  /** Drop every step after position N — the cheap "go back to step N" (after=0 empties the draft). */
  async _draftTruncate(ctx, draft, after, includeColumns = false) {
    if (!Number.isInteger(after) || after < 0 || after > draft.stages.length) {
      throw new ToolError(`truncate after=${after} out of range — the draft has ${draft.stages.length} step(s); use 0..${draft.stages.length}`, { stage: 'validate', field: 'after' });
    }
    return this._draftCommit(ctx, draft, draft.stages.slice(0, after), { changedStage: null, includeColumns, action: 'truncate', stepIndex: after, dropFrom: after + 1 });
  }

  /**
   * Branch a NEW draft from an existing draft (or an already-materialized pipeline) keeping
   * steps 1..after — so you iterate on a variant WITHOUT re-typing the shared prefix and
   * WITHOUT touching the original. after omitted → copy every step.
   */
  async _draftFork(input) {
    const src = this._ctx(input.draft_id);
    const origin = src.state.draft || src.state.pipeline_origin; // live draft, or the snapshot a materialize left behind
    if (!origin) throw new ToolError(`context '${input.draft_id}' has no draft or built pipeline to fork — start one, or fork a context whose pipeline was materialized`, { stage: 'validate', field: 'draft_id' });
    const total = origin.stages.length;
    const after = input.after == null ? total : input.after;
    if (!Number.isInteger(after) || after < 0 || after > total) throw new ToolError(`fork after=${input.after} out of range — the source has ${total} step(s); use 0..${total}`, { stage: 'validate', field: 'after' });
    const ctx = this.ctxs.create();
    const name = input.name || origin.name;
    // Deep-copy the kept stages so editing the fork can never mutate the source's stages.
    ctx.state.draft = { name, source: origin.source, materialized: origin.materialized || 'table', time_range: origin.time_range || null, stages: origin.stages.slice(0, after).map((s) => JSON.parse(JSON.stringify(s))), checkpoints: [], builds: 0 };
    // A materialized prefix the fork KEEPS (at <= after) is inherited: the fork reads the SAME
    // table, so branching a variant on top of an expensive prefix costs only the new steps. The
    // owner's model definition is copied into this overlay so `{{ ref() }}` resolves here (a
    // context is a copy of the BASE project, so it has none of its parent's generated models);
    // nothing rebuilds it — every build selects its own models by name.
    const inherited = [];
    for (const cp of (origin.checkpoints || []).filter((c) => c.at <= after)) {
      const owner = cp.owner;
      if (!this.ctxs.has(owner) || !this.ctxs.hasPipelineModel(owner, cp.model)) continue; // gone → nothing to inherit
      this.ctxs.copyPipelineFiles(owner, ctx.id, cp.model);
      ctx.state.draft.checkpoints.push(JSON.parse(JSON.stringify(cp)));
      // Reference count on the OWNER: dropping it would take the table this fork reads with it.
      const ownerState = this.ctxs.get(owner).state;
      const consumers = ((ownerState.checkpoint_consumers ||= {})[cp.model] ||= []);
      if (!consumers.includes(ctx.id)) consumers.push(ctx.id);
      this.ctxs.touch(owner);
      inherited.push({ at: cp.at, model: cp.model, owner });
    }
    this.ctxs.touch(ctx.id);
    const physSet = await this._physicalCols(ctx.state.draft.source);
    const cols = this._draftColumns(ctx.state.draft, physSet);
    const resp = {
      draft_id: ctx.id, action: 'fork', forked_from: input.draft_id, name, source: ctx.state.draft.source,
      materialized: ctx.state.draft.materialized, copied_steps: after, step_index: after,
      steps: this._draftSteps(ctx.state.draft), column_count: cols.length,
      ...(inherited.length ? { inherited_checkpoints: inherited } : {}),
      next: 'Continue editing this NEW draft (add_step / edit_step / insert_step / delete_step / truncate); the original is untouched. Materialize when done.',
      recommendations: [
        `Forked ${after} of ${total} step(s) into a new draft ${ctx.id}; the source ${input.draft_id} is unchanged — branch variants freely.`,
        ...(inherited.length ? [`Steps 1..${inherited[inherited.length - 1].at} are already materialized (${inherited[inherited.length - 1].model}, built in ${inherited[inherited.length - 1].owner}) and this fork READS that table: only the steps you add here are computed. Keep that context alive while this fork uses it — context({ action: 'drop' }) on it is refused unless forced.`] : []),
        `Materialize with build_native_model({ action: "materialize", draft_id: "${ctx.id}" }).`,
      ],
    };
    if (input.include_columns) resp.available_columns = cols;
    return resp;
  }

  /** Index (1-based) of the first step in `stages` that fails to render — for a pinpointed error. */
  _failingStepIndex(source, stages, physSet, from = null) {
    for (let i = 1; i <= stages.length; i += 1) {
      try { renderPipeline(this.catalog, this.catalog.dialect, source, stages.slice(0, i), { physicalCols: physSet, from }); }
      catch { return i; }
    }
    return null;
  }

  /**
   * Validate `newStages` as a whole and, on success, replace the draft's stages — returning
   * the per-step diff (columns added/removed). Powers add_step AND the edit ops (edit/insert/
   * delete/truncate): every edit revalidates the ENTIRE downstream, so a change that breaks a
   * later step is reported with that step's index and the draft is left intact to fix. The
   * `changedStage` (the added/edited stage; null for delete/truncate) drives the filter/scope/
   * funnel warnings.
   */
  async _draftCommit(ctx, draft, newStages, { changedStage = null, includeColumns = false, includeSteps = false, action = 'add_step', stepIndex = null, dropFrom = null } = {}) {
    const physSet = await this._physicalCols(draft.source);
    const before = this._draftColumns(draft, physSet); // columns BEFORE the change
    // Validate what will actually be built: from the last live checkpoint when there is one (the
    // steps it baked are a TABLE now, not stages to re-validate), else from the source with the
    // draft's time_range as the leading where materialize will add. An edit at step i first
    // retires the checkpoints that baked it — but only the draft's acceptance writes that back.
    const plan = this._renderPlan(draft, newStages, { dropFrom });
    let rendered = null;
    try {
      // This render IS the validation and it returns the resulting columns, so the "after" state
      // below reads them from here instead of rendering the same stages a second time.
      if (newStages.length) rendered = renderPipeline(this.catalog, this.catalog.dialect, draft.source, plan.stages, { physicalCols: physSet, from: plan.from });
    } catch (e) {
      // Reject WITHOUT persisting; pinpoint which step broke so an edit in the middle is actionable.
      const at = this._failingStepIndex(draft.source, plan.stages, physSet, plan.from);
      const step = at != null ? plan.stepOf(at) : null;
      throw new ToolError(step ? `step ${step}: ${e.message}` : e.message, { stage: 'compile', field: 'stage' });
    }
    // Verify filter literals on the changed stage against the SOURCE's real values BEFORE persisting
    // — a wrong-cased/non-existent value ('organic' vs 'Organic') is flagged with the correct value.
    let filterWarnings = [];
    // A python stage's bodies pass the static gate BEFORE the draft persists them.
    if (changedStage && changedStage.stage === 'python') await this._gatePythonStage(changedStage);
    if (changedStage && changedStage.stage === 'where' && Array.isArray(changedStage.conditions)) {
      filterWarnings = this._guardFilterValues(changedStage.conditions
        .filter((cd) => cd && cd.column != null && Object.prototype.hasOwnProperty.call(cd, 'value'))
        .map((cd) => ({ at: this._valueKeyForColumn(draft.source, cd.column), op: cd.op, value: cd.value, where: `where ${cd.column}` })));
    }
    draft.stages = newStages;
    // The edit is accepted: the checkpoints it invalidated (and any that went stale) go now, and
    // the files of the ones nobody else reads go with them.
    const retiredNow = [...plan.dropped.map((cp) => ({ at: cp.at, model: cp.model, reason: `step ${dropFrom} was ${action === 'delete_step' ? 'deleted' : action === 'insert_step' ? 'shifted by an insert' : action === 'truncate' ? 'truncated away' : 'edited'}` })), ...plan.retired];
    draft.checkpoints = plan.checkpoints;
    this._retireCheckpointFiles(ctx, plan.dropped);
    this.ctxs.touch(ctx.id);
    const after = rendered
      ? [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' }))
      : this._draftColumns(draft, physSet);
    const beforeNames = new Set(before.map((c) => c.name));
    const afterNames = new Set(after.map((c) => c.name));
    const removed = before.filter((c) => !afterNames.has(c.name)).map((c) => c.name);
    const allSteps = this._draftSteps(draft);
    // add_step is APPEND-ONLY: the AI already saw every prior step in earlier responses, so echoing
    // the whole (growing) steps list each call is O(n²) waste across a build. Return only the applied
    // step + a count by default; the full list is available via include_steps:true or preview.
    // edit/insert/delete/truncate DO reshuffle the sequence, so they always return the full list.
    const leanSteps = action === 'add_step' && !includeSteps;
    const resp = {
      draft_id: ctx.id, action, step_index: stepIndex ?? draft.stages.length,
      ...(leanSteps
        ? { step: allSteps.find((s) => s.index === (stepIndex ?? draft.stages.length)) || allSteps[allSteps.length - 1], steps_count: allSteps.length }
        : { steps: allSteps }),
      column_count: after.length,
      columns_added: after.filter((c) => !beforeNames.has(c.name)),
      // Compact by default: a step that drops 200 columns must not reprint 200 names every call.
      // Always give the count; include the full list only when it is short or include_columns is set.
      columns_removed_count: removed.length,
      ...((includeColumns || removed.length <= 10) ? { columns_removed: removed } : {}),
      ...(plan.checkpoint ? { from_checkpoint: { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at }, steps_recomputed: newStages.length - plan.checkpoint.at } : {}),
      ...(retiredNow.length ? { checkpoints_dropped: retiredNow } : {}),
      next: action === 'add_step'
        ? 'add_step the next stage; or fix a prior step with edit_step/insert_step/delete_step/truncate; or materialize. Pass include_columns:true / preview for the full column list.'
        : 'Pipeline revalidated end-to-end after the edit. Continue editing, preview, or materialize (include_columns:true for the full list).',
      recommendations: [
        ...filterWarnings,
        ...(plan.checkpoint ? [`Steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model}: this step reads THAT table, so the prefix is not recomputed. Editing a step at or before ${plan.checkpoint.at} retires it and the next materialize rebuilds from '${draft.source}'.`] : []),
        ...(retiredNow.length ? [`Materialized prefix retired (${retiredNow.map((r) => `step ${r.at}: ${r.reason}`).join('; ')}) — the next materialize recomputes from '${draft.source}'.`] : []),
        ...(leanSteps ? [`Only the applied step is echoed (steps_count: ${allSteps.length}) to save tokens — you already have the earlier steps. For the FULL step list, pass include_steps:true or use build_native_model({ action: "preview", draft_id }).`] : []),
        ...(changedStage ? [...this._eventScopeWarnings(draft, changedStage), ...this._emptyCombinationWarnings(draft, changedStage), ...this._funnelCompletionWarnings(changedStage), ...this._joinCompletenessWarnings(changedStage, draft), ...this._draftStepRecommendations(changedStage, after)] : []),
      ],
    };
    if (includeColumns) resp.available_columns = after;
    return resp;
  }

  /** one_per_match counts EVERY start (incl. partial chains). Nudge to filter completed=true
   *  downstream when the intent is "completed situations" — the common foot-gun. */
  _funnelCompletionWarnings(stage) {
    if (!stage || stage.stage !== 'match_recognize' || (stage.rows || 'one_per_partition') !== 'one_per_match') return [];
    return [`rows:'one_per_match' counts EVERY occurrence of the start step — including partial/abandoned chains, not only completed funnels. To count only COMPLETED situations, add a downstream where on completed = true (the funnel exposes a 'completed' boolean). Keep it unfiltered only if you really want all starts.`];
  }

  /**
   * An events↔dimension join is INCOMPLETE when it joins a slowly-changing (SCD-2) dimension on the
   * key alone: without a point-in-time `between` window it fans out to EVERY historical version of
   * each key, multiplying rows and inflating counts. Surface this in the response so the caller can
   * add the window (and fix it) instead of trusting a silently wrong join.
   */
  /**
   * The stage-level warnings for a WHOLE pipeline — the same judgements the incremental builder
   * makes per step, applied to a pipeline submitted all at once. Both entry points must warn about
   * the same stages: a recipe or a hand-written payload that goes straight through
   * register_native_model is exactly where a silently-wrong join does the most damage, because
   * nobody stepped through it.
   */
  _stageWarnings(source, stages = []) {
    const draft = { source, stages };
    return stages.flatMap((st) => [
      ...this._joinCompletenessWarnings(st, draft),
      ...this._funnelCompletionWarnings(st),
    ]);
  }

  _joinCompletenessWarnings(stage, draft = null) {
    if (!stage || stage.stage !== 'join' || stage.between) return [];
    let m; try { m = this.catalog.getModel(stage.with); } catch { return []; }
    if (!m?.scd) return [];
    const from = Object.entries(m.dimensions || {}).find(([, d]) => d.validity === 'start')?.[0];
    const to = Object.entries(m.dimensions || {}).find(([, d]) => d.validity === 'end')?.[0];
    const eventTime = draft?.source ? this.catalog.getModel(draft.source)?.time?.column : null;
    const fix = (from && to && eventTime)
      ? ` Add between: { value: '${eventTime}', from: '${from}', to: '${to}' } to keep only the version valid at the event time.`
      : ' Add a `between` window (value = the event time column; from/to = the validity-window columns) to keep only the version valid at the event time.';
    // The key may be named by the relationship (`via`) or restated inline (`on`) — say whichever
    // the caller actually used, or the message reads "key 'undefined'".
    const named = stage.via
      ? `the declared relationship '${stage.via}'`
      : `key '${Array.isArray(stage.on) ? stage.on.join(' + ') : stage.on}'`;
    return [`INCOMPLETE JOIN: '${stage.with}' is a slowly-changing (SCD-2) dimension, but this join matches only on ${named} with no point-in-time window — it fans out to EVERY historical version of each key, so per-event rows multiply and counts inflate.${fix}`];
  }

  /**
   * Verify ONE filter literal against the REAL indexed values at `at` = { source, property }. The
   * guard against silently filtering on a wrong-cased / non-existent value (user wrote
   * 'organic' but the column holds 'Organic'). Returns null when OK or unverifiable (cold
   * index, numeric/bool value), else { kind, value, suggest?, note? }:
   *   case     — same value, different CASING → HARD (suggest the real casing)
   *   typo     — a close fuzzy match exists → HARD (suggest it)
   *   absent   — value not present AND the full value set is indexed (not capped) → HARD
   *   unverifiable — value not found but only the top-N is indexed → WARN, do not block
   */
  _checkFilterValue(at, value) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return null; // only string literals are case/value-checked
    if (!at) return null;
    const st = this.valueIndex.stats(at.source, at.property);
    if (!st) return null; // not indexed → cannot verify (do not block)
    const stored = this.valueIndex.sampleValues(at.source, at.property, 1000); // all stored values (≤ indexer cap)
    if (!stored.length) return null;
    const sval = String(value);
    if (stored.some((v) => String(v.value) === sval)) return null; // exact, real value → OK
    const ci = stored.find((v) => String(v.value).toLowerCase() === sval.toLowerCase());
    if (ci) return { kind: 'case', value: sval, suggest: [ci.value] };
    const [best] = rankFuzzy(sval, stored, { fields: (v) => [String(v.value)], threshold: 0.8, limit: 1 });
    if (best) return { kind: 'typo', value: sval, suggest: [best.item.value] }; // SOFT (a similar value exists, but could be a distinct sibling like level_1/level_3)
    // Is the FULL value set indexed? Only then is "absent" a reliable hard signal. A column
    // with many values is capped at the indexer's top-N (default 50) — a value can exist
    // without being indexed — so we must NOT hard-reject it. We also treat a near-cap count
    // as capped, because distinct_count can be HLL-approximate and under-count near the cap.
    const VALUE_CAP = 50; // mirrors the value indexer's default maxValues
    const storedCount = this.valueIndex.valueCount(at.source, at.property) ?? stored.length;
    const capped = storedCount < (st.distinctCount ?? Infinity) || storedCount >= VALUE_CAP;
    if (capped) return { kind: 'unverifiable', value: sval, note: 'this column has more values than are indexed (top-N only) — the value may well exist but is not in the index; verify with a direct query before relying on this filter' };
    return { kind: 'absent', value: sval, suggest: stored.slice(0, 10).map((v) => String(v.value)) };
  }

  /** Where a column filtered on `sourceKey` (the pipeline source) lives in the value index:
   *  { source, property } or null. The index keys rows by that pair, per source. */
  _valueKeyForColumn(sourceKey, column) {
    const c = this.catalog;
    if (!column) return null;
    return c.attributeKind(sourceKey, column) ? { source: sourceKey, property: column } : null;
  }

  /**
   * HARD guard: given resolved filter specs [{ key, op, value, where }] (op ∈ equality ops,
   * value scalar or array), reject any literal that is a case/typo/absent mismatch of the
   * column's REAL values, with the correct value(s) suggested. Unverifiable misses become
   * warnings (returned), never a block. Throws a single ToolError listing all hard mismatches.
   */
  _guardFilterValues(specs) {
    const EQ = new Set(['eq', 'neq', 'in', 'not_in']);
    const errors = []; const warnings = [];
    for (const { at, op, value, where } of specs) {
      if (!EQ.has(op)) continue;
      for (const v of Array.isArray(value) ? value : [value]) {
        const r = this._checkFilterValue(at, v);
        if (!r) continue;
        const fix = r.suggest && r.suggest.length ? ` Did you mean: ${r.suggest.map((s) => `'${s}'`).join(', ')}?` : '';
        // HARD-reject ONLY the certain cases: an exact case-mismatch (the value provably
        // exists with different casing) and a value absent from a FULLY-indexed small set.
        // A fuzzy near-match or any incompletely-indexed (top-N) column → WARN, never block —
        // a real value may simply not be in the index, so we must not reject it.
        if (r.kind === 'case') errors.push(`${where}: value '${r.value}' is not a real value — the column holds it with different casing.${fix}`);
        else if (r.kind === 'absent') errors.push(`${where}: value '${r.value}' does not occur in this column (its full value set is indexed).${fix || ` Known values: ${(r.suggest || []).map((s) => `'${s}'`).join(', ')}.`}`);
        else if (r.kind === 'typo') warnings.push(`${where}: value '${r.value}' was not found among indexed values; a similar value exists.${fix} Verify the exact value before relying on this filter.`);
        else if (r.kind === 'unverifiable') warnings.push(`${where}: ${r.note}`);
      }
    }
    if (errors.length) {
      throw new ToolError(`filter value(s) not verified against the real data — check the exact value via semantic_index({ source, property }) and use it as stored: ${errors.join(' ')}`, { stage: 'validate', field: 'value' });
    }
    return warnings;
  }

  /** #3 gotcha: the just-added stage references an event-specific property whose event(s)
   *  are not scoped by an upstream where on event_name → it reads NULL elsewhere. */
  _eventScopeWarnings(draft, stage) {
    // Identify event properties from the catalog (always known); derive WHICH events actually carry
    // each one from the value index (data, not the declared meta.mcp.events). Unknown coverage
    // (cold index) can't be assessed, so such a property is not flagged.
    const c = this.catalog;
    if (!c.isFact(draft?.source)) return []; // a measures/dimension pipeline reads no event payload
    const fact = draft.source; // the pipeline reads ONE fact — its own
    const applies = this.valueIndex.appliesMap(fact, c.eventProps(fact)); // key -> observed [event_name]
    const s = JSON.stringify(stage);
    const referenced = c.eventProps(fact).filter((p) => s.includes(`"${p}"`));
    if (!referenced.length) return [];
    const evCol = c.eventNameColumn(fact);
    const scoped = new Set(); let hasScope = false;
    for (const st of draft.stages) if (st.stage === 'where') for (const cond of st.conditions || []) if (cond.column === evCol) { hasScope = true; (Array.isArray(cond.value) ? cond.value : [cond.value]).forEach((v) => scoped.add(v)); }
    const risky = referenced.filter((p) => { const evs = applies[p]; return evs && evs.length && !evs.every((e) => scoped.has(e)); });
    if (!risky.length) return [];
    const p = risky[0]; const evs = applies[p] || [];
    return [`'${p}' is populated only on event(s) ${evs.join(', ')} — ${hasScope ? 'your event_name scope does not cover all of them' : 'add an earlier where on event_name to those'}, or it reads NULL on the other rows (see semantic_index({ source: '${fact}', property: '${p}' }).event_coverage).`];
  }

  /**
   * After a step, warn when a USED event-property is empty for the pipeline's SCOPED app
   * (bundle_id) and/or event_name — i.e. it is the wrong field FOR THIS APP, so the step
   * will likely produce no values. Uses the precise (property × bundle × event) TRIPLE when
   * both are scoped, else the per-bundle / per-event marginal. Soft warning only (the index
   * can be incomplete/stale); silent when nothing concrete is scoped or the field is fine.
   */
  _emptyCombinationWarnings(draft, stage) {
    const c = this.catalog;
    if (!c.isFact(draft?.source)) return []; // no events, no (app × event) cells to be empty
    const fact = draft.source;
    const bundleCol = c.bundleColumn(fact);
    const evCol = c.eventNameColumn(fact);
    const props = c.scalarEventProps(fact);
    const s = JSON.stringify(stage);
    const used = props.filter((p) => s.includes(`"${p}"`)); // event-properties referenced by THIS step
    if (!used.length) return [];
    // Concrete scope from all where-stages so far (eq / in only).
    const scopedEvents = new Set(); const scopedBundles = new Set();
    for (const st of draft.stages) if (st.stage === 'where') for (const cd of st.conditions || []) {
      if (!cd || cd.column == null || !(cd.op === 'eq' || cd.op === 'in')) continue;
      const vals = Array.isArray(cd.value) ? cd.value : [cd.value];
      if (cd.column === evCol) vals.forEach((v) => scopedEvents.add(String(v)));
      else if (bundleCol && cd.column === bundleCol) vals.forEach((v) => scopedBundles.add(String(v)));
    }
    if (!scopedBundles.size && !scopedEvents.size) return []; // nothing concrete scoped → _eventScopeWarnings covers it
    const fmt = (arr) => arr.slice(0, 4).join(', ') + (arr.length > 4 ? ', …' : '');
    const warns = [];
    for (const p of used) {
      if (scopedBundles.size && scopedEvents.size) {
        // Precise triple: every scoped app×event pair where the field carries no value.
        const empty = [];
        for (const b of scopedBundles) for (const ev of scopedEvents) {
          const cell = this.valueIndex.cellCoverage(fact, p, { bundle: b, event: ev });
          if (!cell || cell.non_null === 0) empty.push(`${b} + ${ev}`); // missing cell = no rows for that combo
        }
        const total = scopedBundles.size * scopedEvents.size;
        if (empty.length === total) warns.push(`'${p}' has NO values for the scoped app+event combination ${fmt(empty)} (NULL/absent in the index) — this step will likely return nothing for '${p}'. Pick a field populated there: semantic_index({ bundle: '${[...scopedBundles][0]}' }) or semantic_index({ source: '${fact}', property: '${p}' }).bundle_coverage / event_coverage.`);
        else if (empty.length) warns.push(`'${p}' is empty for app+event ${fmt(empty)} (present for the other scoped pairs) — those rows contribute no '${p}'.`);
      } else if (scopedBundles.size) {
        const byB = new Map(this.valueIndex.bundleCoverage(fact, p).map((x) => [x.bundle, x]));
        const empty = [...scopedBundles].filter((b) => byB.get(b) && byB.get(b).non_null === 0);
        if (empty.length === scopedBundles.size) warns.push(`'${p}' is NULL for app(s) ${fmt(empty)} — this step likely yields no '${p}' values for ${empty.length > 1 ? 'them' : 'this app'} (semantic_index({ bundle: '${empty[0]}' })).`);
        else if (empty.length) warns.push(`'${p}' is empty for app(s) ${fmt(empty)} (populated for the other scoped app(s)).`);
      } else {
        const byE = new Map(this.valueIndex.coverage(fact, p).map((x) => [x.event_name, x]));
        const empty = [...scopedEvents].filter((ev) => byE.get(ev) && byE.get(ev).non_null === 0);
        if (empty.length === scopedEvents.size) warns.push(`'${p}' is NULL on event(s) ${fmt(empty)} — this step likely yields no '${p}' values (semantic_index({ source: '${fact}', property: '${p}' }).event_coverage).`);
        else if (empty.length) warns.push(`'${p}' is empty on event(s) ${fmt(empty)} (populated on the other scoped event(s)).`);
      }
    }
    return warns.slice(0, 3);
  }

  /** Stage-aware next-step hints from the just-added stage + the resulting columns. */
  _draftStepRecommendations(stage, available) {
    const recs = [];
    if (stage.stage === 'match_recognize') {
      recs.push(`The funnel columns (reached_<step>, completed, furthest_step_name, secs_<metric>) plus the carried partition key(s) are now available — join 'users' or aggregate to slice conversion (e.g. by country).`);
    } else if (stage.stage === 'aggregate') {
      recs.push(`Aggregated: the output is now group_by keys + measures (${available.slice(0, 6).map((c) => c.name).join(', ')}${available.length > 6 ? ', …' : ''}); add order_by/limit or materialize.`);
      // Comparing two groups? The stats live in a tool — don't hand-roll a t-test. ab_test is a
      // GENERAL two-sample significance test (not only randomized experiments).
      recs.push(`Comparing two groups (A vs B, before/after, first vs last)? Don't compute significance by hand — feed the per-group aggregates to ab_test({ action or metric: 'mean' → mean+stddev+n (Welch t-test), 'proportion' → conversions+n (z-test) }) for p-value + CI.`);
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
    // Preview what materialize would ACTUALLY build: from the last live checkpoint when there is
    // one (the steps it baked are a table, not SQL to re-render), else the whole pipeline.
    const plan = this._renderPlan(draft);
    draft.checkpoints = plan.checkpoints;
    const seq = (draft.builds || 0) + 1;
    const modelName = `pipe_${draft.name}_${ctx.id}${seq > 1 ? `_c${seq}` : ''}`;
    // Render ONLY the active warehouse dialect, so every response is consistent with where
    // the pipeline actually runs (bigquery → `|>`, postgres → CTEs). Grounded to physical.
    const rendered = renderPipeline(this.catalog, dialect, draft.source, plan.stages, { physicalCols: physSet, modelName, from: plan.from });
    const models = this._chainModels(rendered.chain, { name: draft.name, pipeline: { source: draft.source } });
    return {
      ...base, available_columns: [...rendered.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })), model_sql: rendered.sql,
      ...(plan.checkpoint ? {
        from_checkpoint: { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at },
        steps_recomputed: plan.stages.length,
        checkpoint_note: plan.stages.length
          ? `Steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model}; the SQL above is only what runs on top of it (${plan.stages.length} step(s)).`
          : `Every step is already materialized as ${plan.checkpoint.model} — add_step before materializing again (the SQL above would just copy that table).`,
      } : {}),
      ...(models.length > 1 ? { models: models.map(({ yml, functions, bindings, ...m }) => m), note: `The pipeline builds as a chain of ${models.length} dbt models (each python stage is a model of its own, reading the previous one via dbt.ref); ${modelName} — the last — is the result.` } : {}),
    };
  }

  /**
   * The chain a pipeline renders to, as the caller sees it: one entry per dbt model, in build
   * order, each with its input and — for a python model — the compiled code. `pipeline` is the
   * declaration the file headers record.
   */
  _chainModels(chain, pipeline) {
    return chain.map((seg) => (seg.kind === 'sql'
      ? { model: seg.model, kind: 'sql', input: seg.input, stages: seg.stages.map((st) => st.stage), sql: seg.sql, columns: [...seg.columns.keys()] }
      : (() => { const py = this._compilePythonStage(seg.stage, { modelName: seg.model, inputModel: seg.input, pipeline }); return { model: seg.model, kind: 'python', input: seg.input, runtime: py.runtime, packages: py.packages, steps: seg.stage.steps.map((st) => st.call), code: py.code, yml: py.yml, functions: py.functions, bindings: py.bindings, columns: [...seg.columns.keys()] }; })()));
  }

  /**
   * A dbt failure of a PYTHON model is the warehouse runtime's traceback, and its actionable part is
   * one class name. Append what that class name means for THIS runtime, so the caller reads the fix
   * instead of a stack. Best-effort decoration: the original message is always kept intact.
   */
  _pythonRunMessage(message) {
    try {
      const hints = pythonRunHints(frameProfile(this.catalog.pythonRuntime || {}, this.pythonModelConfig || {}), message);
      return hints.length ? `${message}\n\n${hints.join('\n')}` : message;
    } catch { return message; }
  }

  /** Compile a python stage into its dbt model (structure only — the gate is separate). */
  _compilePythonStage(stage, { modelName, inputModel, pipeline }) {
    try {
      const profile = frameProfile(this.catalog.pythonRuntime, this.pythonModelConfig);
      return compilePythonStage(stage, { modelName, inputModel, allow: importAllowlist(this.catalog.pythonRuntime || process.env, profile), config: this.pythonModelConfig, pipeline, profile, submission: this.catalog.pythonRuntime?.method || null });
    } catch (e) { throw new ToolError(e.message, { stage: 'validate', field: 'stage' }); }
  }

  /** The static gate over ONE python stage's function bodies (the incremental builder's path). */
  async _gatePythonStage(stage) {
    const compiled = this._compilePythonStage(stage, { modelName: 'm', inputModel: 'm_in', pipeline: null });
    await this._gateCompiled([compiled]);
    return compiled;
  }

  /**
   * The static gate over the bodies of ALREADY-COMPILED python models — every stage of a chain in
   * ONE interpreter run (the gate takes a list, and each function carries its own bindings, so the
   * stages are still checked separately). Re-compiling a stage just to gate it would only repeat
   * work the chain has done, and one interpreter start-up per stage is pure request latency.
   */
  async _gateCompiled(units) {
    const functions = units.flatMap((u, i) => (u.functions || []).map((f) => ({ ...f, id: String(i), bindings: u.bindings || [] })));
    if (!functions.length) return;
    // Whether an unordered head()/tail() is fatal is a property of the RUNTIME (dbt's BigFrames
    // wrapper runs with ordering_mode="partial" and raises OrderRequiredError there), so the
    // profile decides and the gate enforces — the author hears it here, not from a traceback in
    // the warehouse's notebook runtime.
    // The same for the INDEX the frame does not have: an alignment that would raise NullIndexError
    // there is refused here, where the author can still change the code.
    const profile = frameProfile(this.catalog.pythonRuntime || {}, this.pythonModelConfig || {});
    const gate = await runAstGate(this.pythonBin, functions, [], { requireOrderForRowSlice: !!profile.partialOrdering, requireIndexForAlign: !!profile.nullIndex });
    if (gate.ok) return;
    const named = units.length > 1;
    const lines = gate.errors.map((e) => {
      const where = named && units[Number(e.id)]?.model ? `${units[Number(e.id)].model}: ` : '';
      return `${where}${e.function} line ${e.line}${e.text ? ` (${e.text})` : ''}: ${e.message}`;
    });
    throw new ToolError(`python stage: functions rejected by the static gate:\n${lines.join('\n')}`, { stage: 'validate', field: 'functions', details: gate.errors });
  }

  /**
   * Run `dbt run --select <select>` detached, with a lease on the context, as a background job:
   * past queryTimeoutMs the caller gets a query_id to poll (get_query_result), otherwise the
   * finished result. Used where a build is a cold start of minutes (a Python model).
   */
  async _runDetached(ctx, select, table) {
    const dir = this.ctxs.dir(ctx.id);
    const id = this.jobs.create({ contextId: ctx.id });
    this.jobs.setTable(id, table);
    this.ctxs.acquire(ctx.id);
    let result = null;
    const build = (async () => {
      try {
        result = await this.runner.run(dir, select);
        if (!result.ok) this.jobs.fail(id, this._pythonRunMessage(formatDbtError(result.stdout, result.stderr)));
        else this.jobs.ready(id);
      } catch (e) {
        result = { ok: false, stdout: '', stderr: e?.message || String(e) };
        this.jobs.fail(id, e?.message || String(e));
      } finally {
        this.ctxs.release(ctx.id);
      }
    })().catch(() => {});
    let timer;
    const timed = new Promise((res) => { timer = setTimeout(() => res('timeout'), this.queryTimeoutMs); });
    const winner = await Promise.race([build.then(() => 'done'), timed]);
    clearTimeout(timer); // a finished build must not keep the process alive for the rest of the window
    if (winner === 'timeout') return { status: 'running', query_id: id };
    return { status: 'done', query_id: id, result };
  }

  async _draftMaterialize(ctx, draft) {
    if (!draft.stages.length) throw new ToolError('draft has no stages to materialize — add_step at least one stage first', { stage: 'validate', field: 'draft_id' });
    // A build of THIS draft already in flight is never started twice. A retried call — the first
    // response never reached the caller, a dropped connection — is the same pipeline, and a second
    // run would write the same model files under the first one's feet. Once a build detaches into
    // the background the pending checkpoint takes over this duty (see _checkpointState).
    if (draft.building) {
      throw new ToolError(
        `a build of this draft is already in flight (started ${draft.building.started_at}) — it is the SAME pipeline, so a second run would build nothing new and would write over the first one. `
        + `Find it with list_query_jobs() and poll it with get_query_result({ query_id }); the result table is ${draft.building.model}.`,
        { stage: 'validate', field: 'draft_id' },
      );
    }
    // Build only what is NOT already a table: with a live checkpoint the run starts from it and
    // only the steps after it are rendered. Each build gets its own model name, so a rebuild never
    // overwrites the very table it is reading (nor one a fork inherited).
    const plan = this._renderPlan(draft, draft.stages, { forBuild: true });
    draft.checkpoints = plan.checkpoints;
    if (plan.checkpoint && !plan.stages.length) {
      throw new ToolError(`nothing to build: steps 1..${plan.checkpoint.at} are already materialized as ${plan.checkpoint.model} and there is no step after them — add_step first, or read the built table with get_query_result({ context_id: '${plan.checkpoint.owner}', table: '${plan.checkpoint.model}' })`, { stage: 'validate', field: 'draft_id' });
    }
    const seq = (draft.builds || 0) + 1;
    const suffix = seq > 1 ? `_c${seq}` : '';
    draft.building = { started_at: new Date().toISOString(), model: `pipe_${draft.name}_${ctx.id}${suffix}` };
    let result;
    try {
      result = await this._registerPipeline({
        name: draft.name, context_id: ctx.id, materialized: draft.materialized,
        pipeline: { source: draft.source, time_range: draft.time_range || undefined, stages: draft.stages },
        from_checkpoint: plan.checkpoint ? { at: plan.checkpoint.at, model: plan.checkpoint.model, columns: plan.checkpoint.columns } : null,
        model_suffix: suffix,
      });
    } finally {
      delete draft.building; // a detached build hands the guard over to its pending checkpoint
    }
    if (result && result.ok === false) return result; // build/run FAILED — keep the draft so it can be fixed & retried (no rebuild from scratch)
    // Funnel-completeness nudge: a one_per_match funnel with NO downstream completed filter
    // counts all starts (incl. partials), not completed situations — surface it on the result.
    const mrIdx = draft.stages.findIndex((s) => s.stage === 'match_recognize' && (s.rows || 'one_per_partition') === 'one_per_match');
    if (mrIdx >= 0 && !draft.stages.slice(mrIdx + 1).some((s) => s.stage === 'where' && (s.conditions || []).some((c) => c.column === 'completed')) && result && typeof result === 'object') {
      (result.warnings ||= []).push(`This funnel used rows:'one_per_match' with NO downstream filter on completed — the row count includes partial/abandoned chains (all starts), not only completed situations. Add a 'where completed = true' step before materialize if you meant completed funnels.`);
    }
    // The built table IS the first `stages.length` steps from now on: record the checkpoint and KEEP
    // the draft open, so the next step reads that table instead of recomputing the prefix.
    const physSet = await this._physicalCols(draft.source);
    const columns = this._draftColumns(draft, physSet);
    const checkpoint = {
      at: draft.stages.length, model: result.model, owner: ctx.id, columns,
      built_at: new Date().toISOString(), index_run_id: this._indexRunId(),
      rows: result.row_count ?? null, carries_source: this._carriesSource(draft.source, columns),
      ...(result.status === 'running' && result.query_id ? { query_id: result.query_id } : {}),
    };
    draft.builds = seq;
    draft.checkpoints = [...draft.checkpoints.filter((cp) => cp.at < checkpoint.at), checkpoint];
    // Snapshot the built pipeline (with its checkpoints) so it can still be forked after a discard.
    ctx.state.pipeline_origin = { name: draft.name, source: draft.source, materialized: draft.materialized, time_range: draft.time_range || null, stages: draft.stages.map((s) => JSON.parse(JSON.stringify(s))), checkpoints: draft.checkpoints.map((cp) => JSON.parse(JSON.stringify(cp))) };
    this.ctxs.touch(ctx.id);
    if (result && typeof result === 'object') {
      if (plan.checkpoint) {
        result.from_checkpoint = { at: plan.checkpoint.at, model: plan.checkpoint.model, built_at: plan.checkpoint.built_at };
        result.steps_recomputed = plan.stages.length;
      }
      // Why a build started from further back than the caller may expect (a failed/lost build, a
      // refreshed value index) — said on the result, not left to be guessed from the timing.
      if (plan.retired.length) result.checkpoints_dropped = plan.retired;
      result.checkpoint = { at: checkpoint.at, model: checkpoint.model, ...(checkpoint.carries_source ? { carries_source: checkpoint.carries_source } : {}) };
      // A VIEW is not a computed prefix: reading it re-runs its SQL, so continuing on top of one
      // saves nothing. Say it once, here, where the choice can still be changed.
      if (result.materialized === 'view') {
        (result.warnings ||= []).push(`${checkpoint.model} is a VIEW, so the steps you add next re-run its SQL instead of reading a computed prefix — nothing is saved. Start the draft with materialized:'table' when the point of materializing is to stop recomputing.`);
      }
      (result.assumptions ||= []).push(
        `The draft ${ctx.id} stays open and steps 1..${checkpoint.at} are now the table ${checkpoint.model}: add_step continues ON TOP of it (that prefix is not recomputed), while editing a step at or before ${checkpoint.at} retires it and the next materialize rebuilds from '${draft.source}'.`
        + (plan.checkpoint ? ` This build recomputed only ${plan.stages.length} step(s), reading ${plan.checkpoint.model} for the first ${plan.checkpoint.at}.` : ''),
      );
    }
    return result;
  }

  /**
   * Register (or rebuild) a general transformation PIPELINE as a dbt model.
   * The pipeline's rows ARE the result: we materialize, build, and read them back.
   * Re-readable/sliceable later via get_query_result(table, transform).
   */
  async _registerPipeline(input) {
    const dialect = this.catalog.dialect;
    const source = input.pipeline.source;
    // A pipeline-level time_range is applied as a leading WHERE on the source's time
    // column — one place to bound the window (parity with query_semantic_model).
    // Timezone-aware via _timeRangeConditions (boundaries are wall-clock in tr.timezone).
    let stages = input.pipeline.stages;
    const tr = input.pipeline.time_range;
    // A materialized prefix (checkpoint): the first `at` stages ARE the relation we start from, so
    // only the rest is rendered — and the window they were built under is already baked into it.
    const from = input.from_checkpoint || null;
    if (from) stages = stages.slice(from.at);
    else if (tr && (tr.start || tr.end)) {
      if (!this.catalog.getModel(source).time?.column) throw new ToolError(`time_range given but source '${source}' has no time column`, { stage: 'validate', field: 'time_range' });
      const conditions = this._timeRangeConditions(source, tr);
      if (conditions) stages = [{ stage: 'where', conditions }, ...stages];
    } else if (this.catalog.requireTimeRangeFor(source) && !this._stagesBoundInTime(source, stages)) {
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
    const render = (modelName) => renderPipeline(this.catalog, dialect, source, stages, { physicalCols: physSet, modelName, from: from ? { model: from.model, columns: from.columns } : null });
    // A pipeline renders as a CHAIN of dbt models: SQL stages until a python stage, that stage as a
    // Python model reading the previous one (or the source), and so on; the last model carries
    // the pipeline's name and is the result. Every python stage's bodies pass the static gate
    // BEFORE anything else happens, so a refused declaration leaves nothing behind.
    if (input.dry_run) {
      const out = render(`pipe_${input.name}`);
      const built = this._chainModels(out.chain, input);
      await this._gateCompiled(built.filter((m) => m.kind === 'python'));
      const models = built.map(({ yml, functions, bindings, ...m }) => m);
      const last = out.chain[out.chain.length - 1];
      const resp = {
        kind: 'pipeline', dry_run: true, model: `pipe_${input.name}`, materialized: last.kind === 'python' ? 'table' : (input.materialized || 'table'), dialect,
        columns: [...out.columns.keys()],
        output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
        model_sql: out.sql,
        ...(models.length > 1 ? { models } : {}),
        ...(models.some((m) => m.kind === 'python') ? { python: models.filter((m) => m.kind === 'python') } : {}),
      };
      // The same per-stage judgements the incremental builder makes: a dry run is exactly where a
      // silently-wrong stage should be pointed out, BEFORE anything is built.
      const dryWarnings = this._stageWarnings(source, stages);
      if (dryWarnings.length) resp.warnings = dryWarnings;
      // A5: cheap volume estimate — COUNT(*) over the SOURCE within the window only
      // (no full materialize). Lets the caller size the scan before materializing.
      const est = await this._estimateSourceRows(source, tr);
      if (est != null) resp.estimated_source_rows = est;
      return resp;
    }
    // Everything that can refuse the declaration runs BEFORE a context exists, so a refused one
    // leaves nothing behind: the chain is laid out and its python bodies gated on this probe.
    const probe = render('pipe');
    await this._gateCompiled(this._chainModels(probe.chain, input).filter((m) => m.kind === 'python'));
    const ctx = input.context_id ? this._ctx(input.context_id) : this.ctxs.create();
    // Every build of the same draft gets its own name (`_c2`, `_c3`, …): a rebuild must never
    // overwrite the table it reads as its checkpoint, nor one a fork inherited.
    const modelName = `pipe_${input.name}_${ctx.id}${input.model_suffix || ''}`;
    const out = render(modelName);
    const models = this._chainModels(out.chain, input);
    const last = models[models.length - 1];
    const hasPython = models.some((m) => m.kind === 'python');
    // The last model takes the requested materialization when it is SQL; a Python model, and every
    // model something else reads, is a table (a Python model reads a relation, a view would re-run
    // the SQL through the runtime).
    const materialized = last.kind === 'python' ? 'table' : (input.materialized || 'table');
    // The header records the WHOLE declaration; when this model only computes the tail, it also
    // says which built relation the earlier steps are, so the file is readable on its own.
    const header = sqlConfigHeader('pipeline_model', { name: input.name, pipeline: input.pipeline, ...(from ? { continues: { model: from.model, after_step: from.at } } : {}) });
    // A rebuild under the same name must leave no stale model of the previous chain behind: dbt
    // allows one model per name, and a shorter chain would otherwise keep orphaned _sN files.
    this.ctxs.removePipelineFiles(ctx.id, modelName);
    for (const m of models) {
      if (m.kind === 'sql') this.ctxs.writeModel(ctx.id, m.model, `{{ config(materialized='${m === last ? materialized : 'table'}') }}\n${header}${m.sql}\n`);
      else { this.ctxs.writeFile(ctx.id, `${m.model}.py`, m.code); this.ctxs.writeFile(ctx.id, `${m.model}.yml`, m.yml); }
    }
    const pyInfo = hasPython ? models.filter((m) => m.kind === 'python').map(({ yml, functions, bindings, ...m }) => m) : null;
    const chainInfo = models.map((m) => ({ model: m.model, kind: m.kind, input: m.input, materialized: m === last ? materialized : 'table' }));
    ctx.state.engine = 'pipeline';
    ctx.state.model = modelName;
    ctx.state.native = { model: modelName, materialized, kind: 'pipeline', columns: [...out.columns.keys()], ...(models.length > 1 ? { chain: chainInfo } : {}), ...(hasPython ? { python: pyInfo.map(({ code, ...m }) => m) } : {}) };
    if (!ctx.state.tasks?.includes(input.name)) (ctx.state.tasks ||= []).push(input.name);
    this.ctxs.touch(ctx.id);
    // Honest status: `executed` makes it unambiguous whether the model was actually built
    // and run, vs only written to disk (no runner). `ok` stays for backward-compatible checks.
    let build = { ok: true, executed: false, reason: 'no runner configured — model written but not built/executed (dry/unit mode)' };
    let rows = []; let columns = [...out.columns.keys()];
    if (this.runner) {
      let r;
      // Detached whenever the build can be SLOW, not merely when it is a chain: a pipeline whose
      // only stage is `python` renders as ONE model and still pays the warehouse Python runtime's
      // cold start — minutes during which a synchronous call just blocks with no query_id to poll.
      if (hasPython || models.length > 1) {
        // Select the chain's OWN models by name (space = dbt's union operator), in ref order —
        // never `+model`, whose ancestor operator would also select the catalog's base tables and
        // REBUILD them. A Python model is a cold start of minutes on the warehouse runtime, so the
        // build runs detached and may hand back a query_id.
        const bg = await this._runDetached(ctx, models.map((m) => m.model).join(' '), modelName);
        if (bg.status === 'running') {
          return {
            context_id: ctx.id, kind: 'pipeline', ok: true, status: 'running', query_id: bg.query_id, model: modelName, materialized, dialect, models: chainInfo, ...(hasPython ? { python: pyInfo } : {}),
            message: `dbt is building ${models.length > 1 ? `the chain of ${models.length} models` : 'the model'} (${hasPython ? 'Python models run on the warehouse runtime — a cold start' : 'SQL'}) (> ${this.queryTimeoutMs / 1000}s); poll get_query_result with query_id — the result table is ${modelName}`,
            read_with: { tool: 'get_query_result', query_id: bg.query_id, table: modelName },
          };
        }
        r = bg.result;
      } else r = await this.runner.run(this.ctxs.dir(ctx.id), modelName);
      if (!r.ok) return { context_id: ctx.id, kind: 'pipeline', ok: false, error: { stage: 'run', message: hasPython ? this._pythonRunMessage(formatDbtError(r.stdout, r.stderr)) : formatDbtError(r.stdout, r.stderr) }, ...(models.length > 1 ? { models: chainInfo } : {}), ...(hasPython ? { python: pyInfo } : {}) };
      const show = await this.runner.show(this.ctxs.dir(ctx.id), `SELECT * FROM {{ ref('${modelName}') }}`, 200);
      if (show.ok) { rows = show.rows; columns = show.columns || columns; }
      else return { context_id: ctx.id, kind: 'pipeline', ok: false, error: { stage: 'show', message: formatDbtError(show.stdout, show.stderr) } };
      build = { ok: true, executed: true };
    }
    return {
      context_id: ctx.id, kind: 'pipeline', model: modelName, materialized, dialect,
      columns, output_columns: [...out.columns].map(([name, c]) => ({ name, type: c?.type || 'unknown' })),
      row_count: rows.length, rows, model_sql: out.sql, build,
      ...(models.length > 1 ? { models: chainInfo } : {}),
      ...(hasPython ? { python: pyInfo } : {}),
      // Provenance: a custom pipeline (not a governed metric), its source, and how fresh
      // the underlying data is — so the rows are self-trustable. A sample stage makes the
      // result APPROXIMATE — flag it loudly with the safe/unsafe + how-to-get-exact note.
      provenance: { tier: 'pipeline', source, data_freshness: await this._dataFreshness(source), ...(stages.some((s) => s.stage === 'sample') ? { approximate: true } : {}) },
      ...(stages.some((s) => s.stage === 'sample') ? { sampling: samplingNote(stages.find((s) => s.stage === 'sample').percent ?? 10) } : {}),
      // A4: how to read this result again — these rows are a pipeline model, re-read
      // with get_query_result (NOT query_semantic_model, which is for metric queries).
      read_with: { tool: 'get_query_result', table: modelName, note: 'optional transform to re-slice; use query_semantic_model only for metric/semantic-layer queries, not for this pipeline model.' },
      assumptions: [
        ...(models.length > 1
          ? [`The pipeline built as a chain of ${models.length} dbt models (${chainInfo.map((m) => `${m.model} [${m.kind}]`).join(' → ')}); each python stage is a Python model run by dbt on the warehouse's Python runtime, never here, reading the previous model via dbt.ref. The last, ${modelName}, is the result.${input.materialized === 'view' && last.kind === 'python' ? ' materialized: view was requested, but a Python model is a TABLE.' : ''}`]
          : [`Pipeline materialized as a ${materialized} model (${modelName}); its rows are the result.`]),
        `Re-read or re-slice it with get_query_result (table: ${modelName}, optional transform).`,
      ],
      warnings: [
        // The same per-stage judgements the incremental builder makes — a pipeline submitted all at
        // once (a recipe payload, a hand-written one) gets them too, or a silently-wrong join
        // reaches the caller as plausible numbers.
        ...this._stageWarnings(source, stages),
        ...((this.runner && rows.length === 0)
          ? [`0 rows — usually a scoping bug, not a real empty result: an over-narrow where, a property that is NULL on the events you kept, or${tr && (tr.start || tr.end) ? ' a time_range that misses the data (a date-only `end` is the whole day, next-day-exclusive)' : ' an event filter that matches nothing'}. Re-check the stages / widen the window.`]
          : []),
      ],
    };
  }

  /**
   * Data FRESHNESS of a source: the LATEST value of its time column, live —
   *   SELECT MAX(<time column>) FROM <the source's model>
   * It is a DATA aggregate (the newest event actually present), NOT a dbt-run/deploy timestamp,
   * partition metadata, or an orchestration mark — and it is scoped to THIS model's relation.
   * Recomputed ONCE PER INDEX SCAN: the cache is keyed on the value-index sync generation, so a
   * completed background scan invalidates it and the next read re-queries MAX(time) — tied to the
   * scan, not a wall-clock timer. Best-effort: null with no runner/time column, or if it fails.
   */
  async _dataFreshness(sourceKey) {
    const base = this.ctxs.baseProjectDir;
    const m = this.catalog.getModel(sourceKey);
    const tcol = m.time?.column;
    if (!this.runner || !base || !tcol) return null;
    this._freshCache ??= new Map();
    const gen = this.valueIndex?.syncGeneration ? this.valueIndex.syncGeneration() : 0;
    const hit = this._freshCache.get(sourceKey);
    if (hit && hit.gen === gen) return hit.value; // re-query only after the next index scan completes
    let latest = null;
    try {
      const r = await this.runner.show(base, `SELECT MAX(${tcol}) AS latest FROM {{ ref('${m.dbt_model}') }}`, 1);
      if (r.ok && r.rows?.[0]?.latest != null) latest = String(r.rows[0].latest);
    } catch { /* freshness is best-effort */ }
    this._freshCache.set(sourceKey, { value: latest, gen });
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
      case 'drop': return this.drop_context({ context_id: input.context_id, ...(input.force ? { force: true } : {}) });
      case 'delete_model': return this.delete_native_model({ context_id: input.context_id });
      case 'delete_semantic_model': return this.delete_semantic_model({ context_id: input.context_id, semantic_model: input.semantic_model, cascade: input.cascade });
      default: throw new ToolError(`unknown context action '${input.action}'`, { stage: 'validate', field: 'action' });
    }
  }

  /** Delete a registered native model: remove its files + state and re-parse. */
  async delete_native_model(input) {
    this._validate('delete_native_model', input);
    const ctx = this._ctx(input.context_id);
    if (ctx.state.engine !== 'pipeline') return { context_id: ctx.id, removed: false, reason: 'no native (pipeline) model registered in this context' };
    const model = ctx.state.model;
    // a pipeline is a CHAIN of files (.sql / .py / .yml, plus `_sN` steps) — all of them go, and so
    // do the models of its earlier builds (`_cN`): the base name owns the whole family.
    const consumers = this._checkpointConsumers(ctx.id); // forks reading a table built here
    const removedFiles = this.ctxs.removePipelineFiles(ctx.id, model.replace(/_c\d+$/, ''));
    delete ctx.state.engine; delete ctx.state.model; delete ctx.state.native;
    if (ctx.state.draft) { ctx.state.draft.checkpoints = []; ctx.state.draft.builds = 0; } // their tables are gone with the files
    delete ctx.state.checkpoint_consumers;
    for (const c of consumers) { // a fork that read one of these prefixes has to recompute it now
      const st = this.ctxs.get(c.consumer).state;
      if (st.draft) st.draft.checkpoints = (st.draft.checkpoints || []).filter((cp) => cp.model !== c.model);
      this.ctxs.touch(c.consumer);
    }
    ctx.state.metrics ||= []; ctx.state.additions ||= {}; ctx.state.usedModels ||= []; // core-safe after delete
    this.ctxs.touch(ctx.id);
    const parse = this.runner ? await this.runner.parse(this.ctxs.dir(ctx.id)) : { ok: true, executed: false, reason: 'no runner configured — not parsed (dry/unit mode)' };
    return { context_id: ctx.id, removed: true, model, removed_files: removedFiles, ...(consumers.length ? { consumers_recomputing: consumers } : {}), parse: parse.ok ? { ok: true } : { ok: false, error: { stage: 'parse', message: formatDbtError(parse.stdout, parse.stderr) } }, note: "model definition removed; the stored view may persist until the context is dropped (context({ action: 'drop' })) or the store cleans ephemeral objects" };
  }

  async create_semantic_model(input) {
    this._validate('create_semantic_model', input);
    const compiled = this._compile(input);

    if (input.dry_run) {
      const draft = { tasks: [], additions: {}, metrics: [], usedModels: [] };
      if (input.context_id && this.ctxs.has(input.context_id)) {
        const cur = this._ctx(input.context_id).state;
        mergeCompiled(draft, { additions: clone(cur.additions), metrics: clone(cur.metrics), usedModels: [...cur.usedModels], task: null });
      }
      mergeCompiled(draft, compiled);
      const render = renderContext(this.catalog, draft);
      return { context_id: input.context_id || null, task: compiled.task, dry_run: true, yaml: render.yaml, semantic_models: render.semanticModels, metrics: render.metricNames, warnings: render.warnings || [] };
    }

    const ctx = input.context_id ? this._ctx(input.context_id) : this.ctxs.create();
    mergeCompiled(ctx.state, compiled);
    const render = renderContext(this.catalog, ctx.state);
    const file = this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);

    const parse = await this._parse(ctx.id);
    const { now: groupable, afterLoading } = this._groupableSplit(ctx);
    // the example must be a call that RUNS in this context, so it comes from what is loaded
    const exRef = groupable[0];
    const exText = exRef ? `{ model: '${exRef.model}', attribute: '${exRef.attribute}'${exRef.via ? `, via: '${exRef.via}'` : ''} }` : "{ time: 'metric_time', grain: 'day' }";
    return {
      context_id: ctx.id,
      task: compiled.task,
      files: [file],
      ...(input.include_yaml ? { yaml: render.yaml } : {}),
      semantic_models: render.semanticModels,
      joined_models: ctx.state.usedModels,
      metrics: render.metricNames,
      groupable,
      ...(afterLoading.length ? {
        groupable_after_loading: afterLoading,
        groupable_after_loading_note: `These attributes are reachable in the catalog but their model is not loaded in this context — add it with use_base_models: ['${afterLoading[0].model}'] (create/update) before naming them in group_by/where.`,
      } : {}),
      parse,
      assumptions: this._assumptions(ctx),
      warnings: render.warnings || [],
      // Never a dead end: name the exact next call with real metric/path names.
      next: `Query it: query_semantic_model({ context_id: '${ctx.id}', metrics: [${render.metricNames.slice(0, 3).map((m) => `'${m}'`).join(', ')}], time_range: { start, end }, group_by: [${exText}] }).`,
      recommendations: [
        `Bound every query with time_range. Group or filter by an attribute from \`groupable\`, addressed as { model, attribute } (e.g. ${exText}), or by { time: 'metric_time', grain }.`,
        `Extend this task later with update_semantic_model({ context_id: '${ctx.id}', ... }); inspect it anytime with context({ action: 'describe', context_id: '${ctx.id}' }).`,
      ],
    };
  }

  async update_semantic_model(input) {
    this._validate('update_semantic_model', input);
    const ctx = this._ctx(input.context_id);
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
    if (input.remove_dimensions) {
      // A dimension is named by its ATTRIBUTE — the name `groupable` offers and `add_dimensions`
      // takes. What is STORED is the task-namespaced copy ('ret_country'), a name the caller is
      // never shown, so matching on it made every removal a silent no-op that still reported
      // success. Match on the attribute the dimension declares, and refuse a name that matches
      // nothing rather than pretending to have removed it.
      const tasks = state.tasks || [];
      const attrOf = (d) => declaredAttribute(d, tasks);
      for (const name of input.remove_dimensions) {
        if (!add.dimensions.some((d) => attrOf(d) === name || d.name === name)) {
          const have = [...new Set(add.dimensions.map(attrOf))];
          throw new ToolError(`cannot remove dimension '${name}': '${modelKey}' carries no such dimension in this context.${have.length ? ` It has: ${have.join(', ')}.` : ' It has none.'}`, { stage: 'validate', field: 'remove_dimensions' });
        }
      }
      add.dimensions = add.dimensions.filter((d) => !input.remove_dimensions.includes(attrOf(d)) && !input.remove_dimensions.includes(d.name));
    }

    mergeCompiled(state, compiled);
    const render = renderContext(this.catalog, state);
    if (input.dry_run) {
      return { context_id: ctx.id, semantic_model: modelKey, dry_run: true, yaml: render.yaml, metrics: render.metricNames, warnings: render.warnings || [] };
    }
    const file = this.ctxs.writeYaml(ctx.id, render.yaml);
    this.ctxs.touch(ctx.id);
    const parse = await this._parse(ctx.id);
    return {
      context_id: ctx.id, semantic_model: modelKey, files: [file], ...(input.include_yaml ? { yaml: render.yaml } : {}),
      metrics: render.metricNames, groupable: this._groupableRefs(ctx), parse, warnings: render.warnings || [],
      next: `Query the updated task: query_semantic_model({ context_id: '${ctx.id}', metrics: [...] }) — \`metrics\` above is the current full list.`,
    };
  }

  async delete_semantic_model(input) {
    this._validate('delete_semantic_model', input);
    const ctx = this._ctx(input.context_id);
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
    // A context whose materialized prefix another draft READS cannot just vanish: the fork's
    // `{{ ref() }}` would resolve to a relation that no longer exists. Name the consumers and let
    // the operator decide (drop them first, or force).
    const consumers = this._checkpointConsumers(input.context_id);
    if (consumers.length && !input.force) {
      throw new ToolError(
        `context ${input.context_id} cannot be dropped: ${consumers.map((c) => `draft ${c.consumer} reads ${c.model}`).join('; ')} — that table is built HERE, so dropping this context leaves them with an unresolvable model. `
        + `Drop those drafts first, or pass force: true (they will then have to recompute that prefix from the source).`,
        { stage: 'validate', field: 'context_id' },
      );
    }
    for (const c of consumers) { // forced: the consumers' checkpoints are dead as of now
      const st = this.ctxs.get(c.consumer).state;
      if (st.draft) st.draft.checkpoints = (st.draft.checkpoints || []).filter((cp) => cp.model !== c.model);
      this.ctxs.touch(c.consumer);
    }
    return this.ctxs.drop(input.context_id);
  }

  /** Drafts in OTHER contexts that read a table this context materialized. */
  _checkpointConsumers(id) {
    if (!this.ctxs.has(id)) return [];
    const map = this.ctxs.get(id).state.checkpoint_consumers || {};
    const out = [];
    for (const [model, ids] of Object.entries(map)) {
      for (const consumer of ids) {
        if (consumer === id || !this.ctxs.has(consumer)) continue;
        const draft = this.ctxs.get(consumer).state.draft;
        if ((draft?.checkpoints || []).some((cp) => cp.model === model)) out.push({ consumer, model });
      }
    }
    return out;
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
    const ctx = this._ctx(input.context_id);
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
      const draft = ctx.state.draft;
      return {
        context_id: ctx.id,
        engine: 'pipeline',
        tasks: ctx.state.tasks || [],
        models: [{ model: n.model, materialized: n.materialized, columns }],
        columns,
        // A draft that already materialized something is still OPEN: say which steps are a table
        // already, so continuing it is an informed choice rather than a rediscovery.
        ...(draft ? {
          draft: {
            name: draft.name, source: draft.source, steps: this._draftSteps(draft),
            checkpoints: (draft.checkpoints || []).map((cp) => ({ at: cp.at, model: cp.model, owner: cp.owner, built_at: cp.built_at, ...(cp.carries_source ? { carries_source: cp.carries_source } : {}) })),
          },
        } : {}),
        ...(Object.keys(ctx.state.checkpoint_consumers || {}).length ? { checkpoint_consumers: ctx.state.checkpoint_consumers } : {}),
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
      groupable: this._groupableRefs(ctx),
      files: this.ctxs.generatedFiles(ctx.id),
    };
  }

  async query_semantic_model(input) {
    this._validate('query_semantic_model', input);
    const ctx = this._ctx(input.context_id);

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
    // Result columns are named after the reference the caller made — `<model>_<attribute>` and
    // `metric_time_<grain>` — so nothing the caller reads back or addresses later (order_by, a
    // get_query_result transform) ever carries MetricFlow's internal `__` spelling.
    const rename = new Map(); // MetricFlow output name → the column name the caller sees
    const groupByResolved = {}; // "<model>.<attribute>" → the result column
    for (const gRaw of input.group_by || []) {
      const g = this._normalizeRef(ctx, gRaw, 'group_by'); // a string is refused here with the fix
      if (typeof g === 'object' && g.time === 'metric_time') {
        const tok = `metric_time__${g.grain || 'day'}`;
        groupBy.push(tok); rename.set(tok, `metric_time_${g.grain || 'day'}`); continue;
      }
      if (!allowed.has(g)) throw new ToolError(`group_by: '${gRaw.model}.${gRaw.attribute}' is not reachable in this context. ${this._reachableHint(ctx)}`, { stage: 'validate', field: 'group_by' });
      this._checkModelLoaded(ctx, gRaw);
      const friendly = `${gRaw.model}_${gRaw.attribute}`;
      if (input.metrics.includes(friendly) || [...rename.values()].includes(friendly)) throw new ToolError(`group_by: '${gRaw.model}.${gRaw.attribute}' would produce a result column '${friendly}' that clashes with another column of this query — rename the metric or drop the duplicate.`, { stage: 'validate', field: 'group_by' });
      groupBy.push(g); rename.set(g, friendly); groupByResolved[`${gRaw.model}.${gRaw.attribute}`] = friendly;
    }
    /** Apply the friendly names to a result (columns + row keys). */
    const friendlyResult = (columns, rows) => ({
      columns: (columns || []).map((c) => (rename.has(c.name) ? { ...c, name: rename.get(c.name) } : c)),
      rows: (rows || []).map((r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[rename.get(k) || k] = v; return o; }),
    });
    let where = [];
    let filterWarnings = [];
    if (input.where) {
      const translated = clone(input.where);
      const specs = [];
      walkPredicates(translated, (p) => {
        if (p.field?.kind === 'dimension') {
          if (p.field.path != null) throw new ToolError(`where: a dimension is addressed by where it lives — { kind: 'dimension', model, attribute } — never by a path string. '${p.field.path}' → ${this._suggestRef(ctx, p.field.path)}.`, { stage: 'validate', field: 'where' });
          const label = `${p.field.model}.${p.field.attribute}`;
          const refModel = p.field.model; const refAttr = p.field.attribute;
          // The value-index key comes from the model the caller NAMED, while it is still here: a
          // path carries no source, so recovering it afterwards loses the guard on any name two
          // sources happen to share.
          const at = this._valueKeyForColumn(p.field.model, p.field.attribute);
          p.field.path = this._normalizeRef(ctx, { model: p.field.model, attribute: p.field.attribute, via: p.field.via }, 'where');
          delete p.field.model; delete p.field.attribute; delete p.field.via;
          if (!allowed.has(p.field.path)) throw new ToolError(`where: '${label}' is not reachable in this context. ${this._reachableHint(ctx)}`, { stage: 'validate', field: 'where' });
          this._checkModelLoaded(ctx, { model: refModel, attribute: refAttr });
          // Verify the filter literal against the column's REAL values (source-scoped):
          // reject a wrong-cased/non-existent value instead of filtering to nothing.
          specs.push({ at, op: p.op, value: p.value, where: `where ${label}` });
        }
      });
      filterWarnings = this._guardFilterValues(specs); // throws on a case/typo/absent mismatch
      where = renderWhereClauses(translated);
    }
    // order_by keys must be a requested metric or group-by token. `metric_time` is a
    // convenience alias that resolves to the GRAINED token a time group_by actually
    // produces (e.g. metric_time__day), so callers don't have to guess the suffix.
    // A string key is a RESULT COLUMN name (a metric, or the friendly `<model>_<attribute>` /
    // `metric_time_<grain>` a group_by produces) — never MetricFlow's internal `__` token.
    const orderable = new Set([...input.metrics, ...groupBy]);
    const orderableKeys = [...orderable].map((k) => rename.get(k) || k); // what the caller may name
    const byFriendly = new Map([...rename].map(([tok, friendly]) => [friendly, tok]));
    const metricTimeTok = groupBy.find((g) => g.startsWith('metric_time__'));
    const orderBy = (input.order_by || []).map((o) => {
      let key = o.key;
      if (typeof key === 'object' && key) key = this._normalizeRef(ctx, key, 'order_by'); // { model, attribute } → the group-by token
      else if (key === 'metric_time' && metricTimeTok) key = metricTimeTok;
      else if (typeof key === 'string' && key.includes('__')) throw new ToolError(`order_by: an attribute is addressed as { model, attribute }, not by a path string. '${key}' → ${this._suggestRef(ctx, key)}.`, { stage: 'validate', field: 'order_by' });
      else if (typeof key === 'string' && byFriendly.has(key)) key = byFriendly.get(key); // a result column name
      if (!orderable.has(key)) throw new ToolError(`order_by key '${typeof o.key === 'object' ? `${o.key.model}.${o.key.attribute}` : o.key}' is not a requested metric or group_by attribute. Orderable: ${orderableKeys.join(', ')}${metricTimeTok ? ' (metric_time is an alias of the time column)' : ''}`, { stage: 'validate', field: 'order_by' });
      return `${o.direction === 'desc' ? '-' : ''}${key}`;
    });

    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });

    // Build the time-spine table before a REAL query (not needed for dry_run/explain, which only
    // generate SQL). MetricFlow requires the spine materialized for metric_time / SCD joins.
    if (!(input.dry_run || input.explain)) await this._ensureTimeSpineBuilt(ctx.id);

    // Cost guardrail (require_time_range): block an unbounded scan over any source this context
    // reads, so a partitioned source is protected whichever one the metrics come from.
    const guarded = (ctx.state.usedModels || []).filter((k) => this.catalog.requireTimeRangeFor(k));
    if (guarded.length && !input.time_range?.start) {
      throw new ToolError(`source(s) ${guarded.join(', ')} require a bounded time window (require_time_range): pass time_range { start, end } to prune partitions`, { stage: 'validate', field: 'time_range' });
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
    if (input.materialize && !explain) return this._materialize(ctx, qopts, input, rename);
    const raw = await this.runner.query(this.ctxs.dir(ctx.id), { ...qopts, explain, plan: !!input.explain });
    this.ctxs.touch(ctx.id);
    const res = raw.ok && !explain ? { ...raw, ...friendlyResult(raw.columns, raw.rows) } : raw;

    if (!res.ok) return { ok: false, command: res.command, error: { stage: 'query', message: formatDbtError(res.stdout, res.stderr) } };
    if (explain) {
      const out = { ok: true, command: res.command, sql: res.sql, orderable_keys: orderableKeys };
      if (input.dry_run) out.dry_run = true;
      if (input.explain) { out.explain = true; out.plan = res.plan; }
      if (filterWarnings.length) out.warnings = filterWarnings;
      return out;
    }

    const pageRows = res.rows.slice(offset, offset + limit);
    const page = { limit, offset, has_more: res.rows.length > offset + limit };
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
    await Promise.all(factsRead.map(async (f) => { freshByFact[f] = await this._dataFreshness(f); }));
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
    if (pageRows.length === 0) recs.push('0 rows — usually an over-scoped where, a group_by with no data in this window, or a measure on a property that is NULL for the scoped events. Widen time_range, re-check the filter, or inspect the property coverage via semantic_index({ source, property }).');
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
      ...(Object.keys(groupByResolved).length ? { group_by_resolved: groupByResolved } : {}),
      provenance: {
        tier: 'governed_metric',
        metrics: input.metrics,
        source: factsRead.length === 1 ? factsRead[0] : factsRead,
        data_freshness: fresh,
        ...(factsRead.length > 1 ? { data_freshness_by_source: freshByFact } : {}),
      },
      warnings: [...windowWarnings, ...filterWarnings],
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
  async _materialize(ctx, qopts, input, rename = new Map()) {
    if (!this.runner) throw new ToolError('no query engine configured', { stage: 'query' });
    const dir = this.ctxs.dir(ctx.id);
    // The TABLE is the deliverable here — get_query_result pages it and runs transforms OVER it —
    // so it holds the whole result. `limit` is the caller's page size for reading rows back below,
    // and baking it into the query would persist one page and let every later total be read off it
    // as if it were the full answer.
    const { limit: _page, ...full } = qopts;
    const explain = await this.runner.query(dir, { ...full, explain: true });
    if (!explain.ok) return { ok: false, error: { stage: 'query', message: formatDbtError(explain.stdout, explain.stderr) } };
    // The persisted table is what get_query_result transforms address later, so its columns get
    // the caller-facing names (`<model>_<attribute>`, `metric_time_<grain>`), never `__`.
    const projected = rename.size
      ? `select ${[...(full.groupBy || []).map((g) => (rename.has(g) ? `${g} as ${rename.get(g)}` : g)), ...full.metrics].join(', ')} from (\n${explain.sql}\n) _q`
      : explain.sql;

    const id = this.jobs.create({ contextId: ctx.id });
    const table = `qr_${id}`;
    this.jobs.setTable(id, table);
    const header = sqlConfigHeader('materialized_query', { context_id: ctx.id, metrics: input.metrics, group_by: input.group_by, where: input.where, order_by: input.order_by, time_range: input.time_range });
    this.ctxs.writeModel(ctx.id, table, `{{ config(materialized='table') }}\n${header}${projected}\n`);

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
    // The top-level `limit` and `transform.limit` BOTH cap rows; applied together they emit
    // two LIMITs (… LIMIT a … LIMIT b → SQL syntax error). Accept exactly one source of truth,
    // and when it lives in transform, strip it so buildProjection doesn't also emit a LIMIT —
    // the read applies it via `limit`. (Input-validation guard; no string-matching of SQL.)
    const tLimit = (input.transform && typeof input.transform.limit === 'number') ? input.transform.limit : undefined;
    if (tLimit != null && input.limit != null) {
      throw new ToolError('specify the row cap ONCE: pass `limit` at the top level OR `transform.limit`, not both.', { stage: 'validate', field: 'transform.limit' });
    }
    const limit = input.limit ?? tLimit ?? 1000;
    const transform = (input.transform && tLimit != null) ? { ...input.transform, limit: undefined } : input.transform;
    const offset = input.offset ?? 0;
    const sample = !!input.sample;
    const samplePercent = input.sample_percent ?? 10;
    // direct fetch by table (crash-resilient: works even if the job is gone).
    // Accepts a query-result table (qr_*) or a registered pipeline model (pipe_*).
    if (input.table) {
      this._ctx(input.context_id); // validate the context exists (throws otherwise)
      if (!/^(qr_[a-f0-9]{8,16}|pipe_[a-z][a-z0-9_]{0,80})$/.test(input.table)) throw new ToolError(`invalid result table name: ${input.table}`, { stage: 'validate', field: 'table' });
      return this._readTable(this.ctxs.dir(input.context_id), input.table, limit, transform, {}, offset, sample, samplePercent);
    }
    const job = this.jobs.get(input.query_id);
    if (!job) throw new ToolError(`unknown query_id: ${input.query_id} (pass {context_id, table} to fetch a known table directly)`, { stage: 'validate', field: 'query_id' });
    if (job.status === 'running') return { ok: true, status: 'running', query_id: job.id, table: job.table };
    if (job.status === 'error') return { ok: false, status: 'error', query_id: job.id, table: job.table, error: { stage: 'materialize', message: job.error } };
    return this._fetchResult(job.id, limit, transform, offset, sample, samplePercent);
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
    try { this._memoryStore?.close?.(); } catch { /* noop */ } // separate memory store (MCP_MEMORY_DB)
    try { this.runner?.close?.(); } catch { /* noop */ }
  }

  /**
   * Materialize the time-spine TABLE the first time a context is queried. MetricFlow needs the
   * spine BUILT (not just configured) for metric_time / cumulative / SCD validity_params joins.
   * Only builds the spine WE generated (a base-provided spine is already built by the base
   * project). Idempotent per context; best-effort (a failure is left to surface on the query).
   */
  async _ensureTimeSpineBuilt(ctxId) {
    if (!this.runner?.run) return;
    const ctx = this.ctxs.get(ctxId);
    if (ctx.state._timeSpineBuilt) return;
    // Self-heal: make sure the spine files exist even for a reused/persisted context that never
    // went through create()'s ensureTimeSpine — then build the table we generated.
    try { this.ctxs.ensureTimeSpine?.(ctxId); } catch { /* best effort */ }
    if (!this.ctxs.generatedTimeSpine?.(ctxId)) { ctx.state._timeSpineBuilt = true; return; }
    const r = await this.runner.run(this.ctxs.dir(ctxId), 'metricflow_time_spine');
    if (r.ok) { ctx.state._timeSpineBuilt = true; this.ctxs.touch(ctxId); }
  }

  async _parse(ctxId) {
    if (!this.runner) return { ok: true, executed: false, reason: 'no runner configured — not parsed (unit mode)' };
    // Guarantee a time spine is CONFIGURED before parsing. The semantic manifest is invalid
    // without one ("At least one time spine must be configured"), and a REUSED context (passed
    // context_id) or one PERSISTED from before spine generation existed would otherwise fail
    // parse. ensureTimeSpine is idempotent — a no-op once a `time_spine:` config is present.
    try { this.ctxs.ensureTimeSpine?.(ctxId); } catch { /* best effort — parse will surface a real miss */ }
    const r = await this.runner.parse(this.ctxs.dir(ctxId));
    if (!r.ok) return { ok: false, error: { stage: 'parse', message: formatDbtError(r.stdout, r.stderr) } };
    return { ok: true, manifest: r.manifest };
  }

  _assumptions(ctx) {
    const a = [`one semantic model per table in context ${ctx.id}`];
    if (this.catalog.facts.some((f) => ctx.state.additions[f])) a.push('the event scope is applied inside each measure');
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
 * A memory target, resolved: `kind` (property | event | model | term), the public `target` the
 * tool speaks — { source, name } for a property/attribute/event, { source } for a model, { term }
 * for a free phrase — plus the stored canonical key "<kind>:<source>.<name>" and the flat `key`
 * the fuzzy matcher scores.
 */
/**
 * The attribute a compiled dimension was DECLARED as. `_attribute` records it at compile time; a
 * context persisted before that falls back to the longest task name the identifier starts with —
 * longest, because one task name may be a prefix of another ('ret' and 'ret_v2') and the shorter
 * one would leave part of the task name inside the attribute.
 */
function declaredAttribute(dim, tasks = []) {
  if (dim._attribute) return dim._attribute;
  const t = [...tasks].filter((tk) => dim.name.startsWith(`${tk}_`)).sort((a, b) => b.length - a.length)[0];
  return t ? dim.name.slice(t.length + 1) : dim.name;
}

/**
 * A resolved memory target: `target` is what gets STORED (the kind and its parts), `addressable` is
 * the same thing as the tool speaks it back — what you hand to memory({ action: 'list', target })
 * — and `label` is its words, for fuzzy matching and messages. Nothing here is ever re-parsed.
 */
function memoryTarget(kind, source, name = null) {
  const addressable = kind === 'term' ? { term: source } : (name == null ? { source } : { source, name });
  return { kind, target: { kind, ...addressable }, addressable, label: targetWords({ kind, ...addressable }) };
}


/**
 * Presentation shape for a stored memory note: decode the canonical "<kind>:<key>" targets
 * back into their public { kind, source, name } form, expose the note/aliases/links, and stamp
 * the time.
 */
// Compact form of a saved finding for ATTACHING to a semantic_index view: id + a truncated note +
// the date. The full text + question + about[] + aliases[] + links[] are fetched on demand via
// memory({ action: 'list', target }) — so the view stays light without losing the finding.
function memoryCompact(e, maxLen = 220) {
  const note = String(e.note || '');
  const truncated = note.length > maxLen;
  // Keep the semantically useful, usually-short parts inline (note/question/about); drop the long
  // search-metadata (aliases/links). The full untruncated note + aliases/links is one drill away
  // via memory({ action: 'list', target }).
  const targets = [...(e.targets || [])];
  return {
    view: {
      id: e.id,
      note: truncated ? `${note.slice(0, maxLen)}…` : note,
      ...(e.question ? { question: e.question } : {}),
      ...(targets.length ? { about: targets } : {}),
      ...(e.created_at ? { recorded_at: new Date(e.created_at).toISOString().slice(0, 10) } : {}),
    },
    truncated,
  };
}

function memoryView(e) {
  const targets = [...(e.targets || [])];
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
