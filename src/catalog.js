// Catalog (registry of dbt models) + derived enum sets and the entity-join
// graph. This is the single source of physical names; everything the AI can
// reference is projected from here into JSON-Schema enums.
//
// This file is the Catalog itself (its accessors) and how one is loaded; what it is made of lives in
// src/catalog/: from-dbt-schema.js (a dbt schema file read as a catalog), measures.js, entities.js,
// column-types.js (the declarations brought to one shape), project.js (the dbt project and its
// profile: paths, macros, dialect, the Python runtime), grounding.js (checked against the warehouse).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { isNumericType } from './dialects/base.js';
import { SUPPORTED_DIALECTS, getDialect } from './dialects/index.js';
import { MEASURE_AGGS, NUMERIC_AGGS } from './catalog/measures.js';
import { ENTITY_TYPES, GRAINS, KEY_PART_GRAINS } from './catalog/entities.js';
import { isBooleanType } from './catalog/column-types.js';
import { groundCatalogToPhysical } from './catalog/grounding.js';
import { readModelPaths, validateDbtProject, collectSchemaModels, resolveDialect, profileOutput, submissionFromProject, gatePythonRuntime, resolvePythonRuntime } from './catalog/project.js';
import { mcpOf, dbtSchemaToCatalog, primaryEntityName, asPrimaryEntity } from './catalog/from-dbt-schema.js';
export { MEASURE_AGGS, NUMERIC_AGGS, ENTITY_TYPES, GRAINS, KEY_PART_GRAINS, groundCatalogToPhysical, validateDbtProject, resolveDialect, profileOutput, submissionFromProject, gatePythonRuntime, resolvePythonRuntime, mcpOf, dbtSchemaToCatalog, primaryEntityName };

export { SUPPORTED_DIALECTS };

export function loadCatalog(path, opts = {}) {
  // A directory => a dbt project: discover the MCP-tagged models from its own
  // schema YAMLs (no separate catalog file needed).
  if (existsSync(path) && statSync(path).isDirectory()) return loadCatalogFromProject(path, opts);
  const text = readFileSync(path, 'utf8');
  let raw;
  if (/\.ya?ml$/i.test(path)) {
    const doc = yaml.load(text);
    // dbt model-schema notation (models: [ {name, columns, meta} ]) -> registry.
    // A plain registry object (models: {events:{..}}) is also accepted as-is.
    raw = Array.isArray(doc?.models) ? dbtSchemaToCatalog(doc) : doc;
  } else {
    raw = JSON.parse(text);
  }
  // The warehouse dialect is runtime config, NOT catalog data: resolve it from
  // the environment / the dbt profile dbt actually runs with — never the YAML.
  raw.warehouse_dialect = resolveDialect({ dialect: opts.dialect, profilesDir: opts.profilesDir, projectDir: opts.projectDir, report: (r) => { raw.dialect_fallback = r; } });
  raw.python_runtime = resolvePythonRuntime({ profilesDir: opts.profilesDir, projectDir: opts.projectDir });
  if (opts.requireTimeRange != null) raw.require_time_range = !!opts.requireTimeRange; // runtime override (e.g. MCP_REQUIRE_TIME_RANGE)
  return new Catalog(raw);
}

/**
 * Build the catalog directly from a dbt project's OWN model-schema YAMLs — no
 * separate catalog file. We scan the project's model-paths, collect every model
 * entry, and keep the ones tagged with `meta.mcp.role`. Each role must be carried
 * by EXACTLY ONE model (more than one per role is a config error).
 */
export function loadCatalogFromProject(projectDir, opts = {}) {
  const models = [];
  for (const mp of readModelPaths(projectDir)) collectSchemaModels(join(projectDir, mp), models);
  const mcpModels = models.filter((m) => mcpOf(m)?.role);
  if (!mcpModels.length) throw new Error(`no MCP-tagged models found under ${projectDir} (tag a dbt model with config.meta.mcp.role)`);
  const byRole = new Map();
  for (const m of mcpModels) {
    const { role } = mcpOf(m);
    if (byRole.has(role)) throw new Error(`config error: more than one model declares role '${role}' (${byRole.get(role)} and ${m.name}); exactly one model per role`);
    byRole.set(role, m.name);
  }
  const raw = dbtSchemaToCatalog({ models: mcpModels });
  raw.warehouse_dialect = resolveDialect({ dialect: opts.dialect, profilesDir: opts.profilesDir || projectDir, projectDir, report: (r) => { raw.dialect_fallback = r; } });
  raw.python_runtime = resolvePythonRuntime({ profilesDir: opts.profilesDir || projectDir, projectDir });
  if (opts.requireTimeRange != null) raw.require_time_range = !!opts.requireTimeRange; // runtime override (e.g. MCP_REQUIRE_TIME_RANGE)
  return new Catalog(raw);
}

export class Catalog {
  constructor(raw) {
    this.raw = raw;
    this.dialect = raw.warehouse_dialect;
    // Whether dbt can run PYTHON models on the active profile (resolvePythonRuntime): the `python`
    // pipeline stage exists in the tool schemas only when it can. A plain registry object without
    // a profile is treated as "no runtime" unless it says otherwise.
    this.pythonRuntime = raw.python_runtime || { available: false, reason: 'no dbt profile — Python models unavailable' };
    // Set when dbt's adapter is one this server writes no SQL for, so the SQL is rendered in
    // another dialect's syntax against it: { profile_type, rendering_as, explicit }.
    this.dialectFallback = raw.dialect_fallback || null;
    this.models = raw.models || {};
    // one shape for a primary entity, whoever wrote the registry (a schema file, a test's object)
    for (const m of Object.values(this.models)) if (m && m.primary_entity != null) m.primary_entity = asPrimaryEntity(m.primary_entity);
    // `facts` = every events source; they are equal, each is addressed by name, and none is a
    // default. Declared by the schema converter, or derived here for a plain registry object:
    // a model with an event_name column is an events source.
    this.facts = (Array.isArray(raw.facts) && raw.facts.length ? raw.facts : Object.keys(this.models).filter((k) => this.models[k]?.event_name || this.models[k]?.event_data_column)).filter((k) => this.models[k]);
    if (!this.facts.length) throw new Error('no events source in the catalog: at least one model must declare an event_name column');
    // Cost guardrail per SOURCE: a catalog-wide override, else that source's own
    // meta.mcp.require_time_range. A partitioned source can demand a bounded window even when
    // another source does not (see requireTimeRangeFor).
    this._requireTimeRangeAll = raw.require_time_range;
    // Models the warehouse cannot back (a STRUCTURAL column or the table itself is missing):
    // removed from `models` by grounding, kept here with the reason so the overview can say why.
    this.unavailable = {};
    this._indexOwners();
  }

  /**
   * (Re)build the map: entity name -> model key that OWNS it (the join target). A model's primary
   * entity is its identity; a `unique` entity is a second key that is also unique per row, so it
   * is an equally valid target. Rebuilt after grounding, because a key whose column turns out not
   * to exist is dropped there and must stop being advertised as a target.
   */
  _indexOwners() {
    this.primaryByEntity = {};
    for (const [key, m] of Object.entries(this.models)) {
      const name = primaryEntityName(m);
      if (name) this.primaryByEntity[name] = key;
    }
    for (const [key, m] of Object.entries(this.models)) {
      for (const [name, e] of Object.entries(m.entities || {})) {
        if (e.type === 'unique' && !this.primaryByEntity[name]) this.primaryByEntity[name] = key;
      }
    }
  }

  /**
   * What the warehouse says a column IS, where the declaration could not: a column with no
   * `data_type` in the YAML is typed 'string' for a pipeline, and a BOOL among them then takes a
   * constant as a string — which the warehouse refuses (BOOL = STRING). The physical type of each
   * boolean column is carried onto the pipeline's column. → the columns retyped, by model.
   */
  typeToPhysical(typesByModel = {}) {
    const retyped = {};
    for (const [key, types] of Object.entries(typesByModel)) {
      const m = this.models[key];
      if (!m || !(types instanceof Map)) continue;
      for (const c of m.columns || []) {
        if (c.type !== 'boolean' && isBooleanType(types.get(String(c.name).toLowerCase()))) { c.type = 'boolean'; (retyped[key] ||= []).push(c.name); }
      }
    }
    return retyped;
  }

  /**
   * Reconcile the DECLARED catalog against PHYSICAL truth. Given each model's real
   * column names, PRUNE every declared column / event-payload property / dimension the
   * table does not actually have — so nothing that isn't physically present is EVER
   * surfaced anywhere (the tool schemas, semantic_index, and the value indexer all
   * derive from these maps). Models absent from `physByModel` (introspection
   * unavailable / relation not built) are left untouched. Returns { pruned } for logs.
   * Call BEFORE building schemas (so the enums reflect physical reality).
   */
  groundToPhysical(physByModel) {
    const get = (k) => (physByModel instanceof Map ? physByModel.get(k) : physByModel?.[k]);
    const pruned = {};
    const unavailable = {};
    // Who owned each relationship BEFORE anything is removed: a foreign key pointing at an owner
    // that turns out to be unavailable has to go with it (the join has no target any more).
    this._indexOwners();
    const ownerBefore = { ...this.primaryByEntity };
    for (const [key, m] of Object.entries(this.models)) {
      const raw = get(key);
      if (!raw) continue; // unknown physical shape → keep declared as-is
      if (raw && !(raw instanceof Set) && !Array.isArray(raw) && typeof raw === 'object' && 'unavailable' in raw) {
        unavailable[key] = { reason: `the table cannot be introspected: ${raw.unavailable}`, missing: [] };
        continue;
      }
      const phys = raw instanceof Set ? raw : new Set([...raw].map((n) => String(n).toLowerCase()));
      const has = (n) => phys.has(String(n).toLowerCase());
      const gone = new Set();
      const isFact = this.facts.includes(key);

      // ── STRUCTURAL columns: the ones the whole machinery of the model rests on. Missing one of
      // them there is no useful degraded model — an events source without its event_name column
      // has no scopes, funnels or coverage scan; a model without its identity key cannot be a
      // join target. Such a model is not pruned but marked UNAVAILABLE with the reason, exactly
      // like a contradictory declaration is refused at load: nothing downstream may see it.
      const missing = [];
      if (isFact) {
        if (m.event_name?.column && !has(m.event_name.column)) missing.push(`${m.event_name.column} (meta.mcp.is_event_name — the event name)`);
        if (m.time?.column && !has(m.time.column)) missing.push(`${m.time.column} (meta.mcp.is_time — the event time axis)`);
        if (m.event_data_column && !has(m.event_data_column)) {
          // The raw payload blob is structural only while properties are READ from it; otherwise it
          // is just a column the pipeline offered, and can be dropped like any other.
          const inBlob = Object.keys(m.properties || {}).filter((n) => !m.properties[n].column);
          if (inBlob.length) missing.push(`${m.event_data_column} (meta.mcp.is_event_data — ${inBlob.length} payload propert${inBlob.length === 1 ? 'y' : 'ies'} live in it: ${inBlob.slice(0, 5).join(', ')})`);
          else { delete m.event_data_column; gone.add('(event_data column)'); }
        }
      } else if (m.time?.column && !has(m.time.column)) {
        // A dimension / measures source is still groupable without its time axis — just not
        // over time. Rendered as agg_time_dimension, a missing column would break the manifest.
        delete m.time; gone.add('(time axis)');
      }
      const pe = m.primary_entity;
      if (pe && typeof pe === 'object') {
        const parts = pe.key || [];
        for (const part of parts) if (!has(part.column)) missing.push(`${part.column} (key of the primary entity '${pe.name}')`);
      }
      if (missing.length) { unavailable[key] = { reason: `the table lacks structural column(s): ${missing.join('; ')}`, missing: missing.map((x) => x.split(' ')[0]) }; continue; }

      // ── Ordinary declarations: each one is a single capability, dropped on its own.
      // Physical columns referenceable in a pipeline.
      if (Array.isArray(m.columns)) m.columns = m.columns.filter((c) => { if (has(c.name)) return true; gone.add(c.name); return false; });
      // Event-payload properties: a flattened property is pruned by its physical column.
      if (m.properties) for (const [name, spec] of Object.entries(m.properties)) {
        if (spec.column && !has(spec.column)) { delete m.properties[name]; gone.add(name); }
      }
      // Groupable dimensions (semantic-layer group-by + schema enums).
      if (m.dimensions) for (const name of Object.keys(m.dimensions)) if (!has(name)) { delete m.dimensions[name]; gone.add(name); }
      // The designated app/bundle column: drop it if it is not physically present, so the
      // indexer never groups by a missing column (per-app coverage is simply unavailable).
      if (m.bundle_column && !has(m.bundle_column)) { delete m.bundle_column; gone.add('(bundle column)'); }
      if (m.column_descriptions) for (const name of Object.keys(m.column_descriptions)) if (!has(name)) delete m.column_descriptions[name];
      // AMOUNTS and GOVERNED MEASURES declared on a column the table lacks: offered, they would be
      // accepted by the tool schema and compiled into SQL that fails in the warehouse. A column-
      // level declaration names its column; a model-level one whose `expr` is a bare column name
      // is checked the same way. A genuine expression (`cost / nullif(clicks, 0)`) is kept — its
      // columns cannot be told apart from SQL here.
      const bareColumn = (d) => d.column || (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(d.expr || '')) ? d.expr : null);
      if (m.aggregatable) for (const [name, a] of Object.entries(m.aggregatable)) { const col = bareColumn(a); if (col && !has(col)) { delete m.aggregatable[name]; gone.add(`amount:${name}`); } }
      if (m.measures) for (const [name, mm] of Object.entries(m.measures)) { const col = bareColumn(mm); if (col && !has(col)) { delete m.measures[name]; gone.add(`measure:${name}`); } }
      // A DECLARED JOIN KEY whose column is not physically there cannot be executed, so it must
      // stop being offered: `via` would otherwise build SQL against a missing column and fail in
      // the warehouse instead of here. A relationship is one capability among several, so it is
      // dropped alone (unlike the primary key above, which is the model's identity).
      if (m.entities) for (const [name, e] of Object.entries(m.entities)) {
        const parts = e.key || [];
        if (parts.some((p) => !has(p.column))) { delete m.entities[name]; gone.add(`entity:${name}`); }
      }
      // A model is SLOWLY-CHANGING only while it still HAS its window. If the validity columns
      // did not survive, the table has no windows to join on, so the flag has to go with them:
      // left set, the model would render a `natural` entity with no validity_params, which
      // MetricFlow rejects outright — an error about columns that are no longer even visible.
      // Cleared, it renders as an ordinary primary-key dimension, which is what such a table is.
      if (m.scd) {
        const v = Object.values(m.dimensions || {}).filter((d) => d.validity);
        if (v.filter((d) => d.validity === 'start').length !== 1 || v.filter((d) => d.validity === 'end').length !== 1) {
          delete m.scd;
          gone.add('(validity window — no longer treated as slowly-changing)');
        }
      }
      if (gone.size) pruned[key] = [...gone];
    }

    // ── Remove the unavailable models from the live catalog. Everything downstream (tool enums,
    // facts, the indexer worklist, reachable attributes) derives from `models`, so they vanish
    // from every surface at once; the reason stays in `unavailable` for the overview.
    for (const [key, info] of Object.entries(unavailable)) {
      const m = this.models[key];
      this.unavailable[key] = { role: m.role, dbt_model: m.dbt_model, ...info };
      delete this.models[key];
    }
    this.facts = this.facts.filter((k) => this.models[k]);
    if (!this.facts.length) {
      const why = Object.entries(this.unavailable).map(([k, u]) => `'${k}': ${u.reason}`).join('; ');
      throw new Error(`no events source is available: ${why}`);
    }
    // Relationships whose OWNER became unavailable have no join target any more.
    for (const [key, m] of Object.entries(this.models)) {
      for (const name of Object.keys(m.entities || {})) {
        const owner = ownerBefore[name];
        if (owner && owner !== key && unavailable[owner]) { delete m.entities[name]; (pruned[key] ||= []).push(`entity:${name} (owner '${owner}' unavailable)`); }
      }
    }
    // Grounding may have dropped a key that OWNED a relationship — re-index so nothing points at
    // a target that no longer declares it.
    this._indexOwners();
    return { pruned, unavailable: Object.fromEntries(Object.keys(unavailable).map((k) => [k, this.unavailable[k]])) };
  }

  modelKeys() {
    return Object.keys(this.models);
  }

  getModel(key) {
    const m = this.models[key];
    if (!m) throw new Error(`Unknown model: ${key}${this.unavailableHint(key)}`);
    return m;
  }

  /** Models grounding found the warehouse cannot back: { <key>: { role, dbt_model, reason, missing } }. */
  unavailableModels() {
    return this.unavailable || {};
  }

  /** For an "unknown model" message: the reason when the name IS declared but unavailable, else ''. */
  unavailableHint(key) {
    const u = this.unavailable?.[key];
    return u ? ` — '${key}' is declared in the catalog but UNAVAILABLE: ${u.reason}. Fix the warehouse table or the schema and restart the server.` : '';
  }

  primaryEntityName(key) {
    return primaryEntityName(this.getModel(key));
  }

  /** True when queries over `source` must carry a time window (partition-pruning guardrail). */
  requireTimeRangeFor(source) {
    return !!(this._requireTimeRangeAll ?? this.models[source]?.require_time_range);
  }

  /**
   * The same guardrail for a query that reads a dbt model by its NAME rather than as a source — a
   * semantic model the dbt project declares itself, over a table the catalog may also serve: the
   * deployment-wide setting, or the flag of the catalog model over that dbt model.
   */
  requireTimeRangeForDbtModel(dbtModel) {
    return !!(this._requireTimeRangeAll ?? Object.values(this.models).some((m) => m.dbt_model === dbtModel && m.require_time_range));
  }

  /**
   * Resolve the SOURCE an event accessor is asked about. The source is ALWAYS a separate argument
   * and is always passed: there is no "default" fact to fall back to, in any catalog, and silently
   * reading one source's vocabulary for another is exactly the mix-up the per-source design exists
   * to prevent. An omitted source is a programming error, refused here at the accessor.
   */
  _fact(fact) {
    if (!fact) throw new Error(`a source is required: sources are never mixed, so name the one you mean (${this.facts.join(', ')})`);
    if (!this.facts.includes(fact)) throw new Error(`'${fact}' is not an events source. Events sources: ${this.facts.join(', ')}`);
    return fact;
  }

  /**
   * The relationship `source` declares toward a model with the given ROLE — the structural way to
   * ask "which key means per-user here", instead of assuming a relationship is literally named
   * 'user'. Roles are the catalog's own vocabulary; relationship names are the author's.
   */
  entityTowardRole(source, role) {
    const m = this.models[source];
    if (!m) return undefined;
    for (const name of Object.keys(m.entities || {})) {
      const target = this.joinTargetFor(name);
      if (target && this.models[target]?.role === role) return name;
    }
    return undefined;
  }

  /** True when `key` is an events fact (has its own event vocabulary). */
  isFact(key) {
    return this.facts.includes(key);
  }

  /**
   * The event `name` as seen from `fact`. Every source names its own events, so the name is
   * always bare here; it THROWS when this source does not declare it — naming which source
   * does, when one exists — so a cross-source mistake never degrades into a filter that
   * silently matches nothing. `hint` appends the caller's fix.
   */
  eventNameFor(fact, name, { hint } = {}) {
    if (this.eventNames(fact).includes(name)) return name;
    const other = this.facts.find((f) => f !== fact && this.eventNames(f).includes(name));
    if (other) throw new Error(`event '${name}' belongs to the '${other}' source, not '${fact}'${hint ? ` — ${hint}` : ''}`);
    throw new Error(`unknown event '${name}' on '${fact}'. See semantic_index({ request: { model: '${fact}' } })`);
  }

  /**
   * THE SQL expression that reads one event property of `fact`, for `dialect` (a dialect name).
   * A flattened property is its physical column; a blob property is a JSON extract from the
   * source's event_data column, cast to `type` (the property's declared type by default).
   * `qualifier` prefixes both forms (an alias such as `S1`), so joined/pattern queries can use it.
   * The single place this rule lives — the governed compiler, the pipeline, the funnel matcher
   * and the value indexer all read a property through here, so they can never disagree.
   */
  propertyExpr(fact, name, dialect, { type, qualifier } = {}) {
    fact = this._fact(fact);
    const spec = (this.models[fact].properties || {})[name];
    if (!spec) throw new Error(`unknown event property '${name}' on '${fact}'`);
    const col = this.propertyBackingColumn(fact, name); // the ONE rule for which column this reads
    const q = qualifier ? `${qualifier}.${col}` : col;
    return spec.column ? q : getDialect(dialect).jsonExtract(q, name, type || spec.type);
  }

  /**
   * The PHYSICAL column a property is read from: its own flattened column, or the source's payload
   * blob. Whoever reads a property needs that column to still be there, so the same rule that
   * builds the expression also answers "which column does this depend on".
   */
  propertyBackingColumn(fact, name) {
    fact = this._fact(fact);
    const spec = (this.models[fact].properties || {})[name];
    if (!spec) throw new Error(`unknown event property '${name}' on '${fact}'`);
    return spec.column || this.eventDataColumn(fact);
  }

  /**
   * One event PROPERTY as seen from `fact`: { name, spec }, or null when this source simply has
   * no such property. THROWS when another source declares it (reading another source's payload
   * is never what was meant).
   */
  propertyFor(fact, name, { hint } = {}) {
    const props = this.models[fact]?.properties || {};
    if (props[name]) return { name, spec: props[name] };
    const other = this.facts.find((f) => f !== fact && this.eventProps(f).includes(name));
    if (other) throw new Error(`'${name}' is a property of the '${other}' source, not of '${fact}'${hint ? ` — ${hint}` : ''}`);
    return null;
  }

  /**
   * Enums for a schema whose SOURCE is not fixed when the schema is built — the pipeline
   * stages, where the source is chosen per draft, and the model-agnostic update payloads.
   * They are the union of every source's own (bare) names; the caller still resolves the name
   * against the actual source via eventNameFor / propertyFor, which reports a cross-source
   * mistake with the fix.
   */
  eventNameEnum() {
    return [...new Set(this.facts.flatMap((f) => this.eventNames(f)))];
  }

  /** Every name a source can be asked about in the { source, property } view: its payload
   *  properties and its groupable attributes. The schema enumerates these PER SOURCE, so a name
   *  that source does not carry is not expressible. */
  propertyEnumFor(key) {
    const m = this.getModel(key);
    return [...new Set([...(this.facts.includes(key) ? this.eventProps(key) : []), ...Object.keys(m.dimensions || {})])];
  }

  eventPropEnum() {
    return [...new Set(this.facts.flatMap((f) => this.eventProps(f)))];
  }

  scalarEventPropEnum() {
    return [...new Set(this.facts.flatMap((f) => this.scalarEventProps(f)))];
  }

  /** dbt column descriptions for a model: { columnName: description }. */
  columnDescriptions(key) {
    return this.getModel(key).column_descriptions || {};
  }

  /** event_data property descriptions (if declared): { property: description }. */
  eventPropertyDescriptions(fact) {
    fact = this._fact(fact);
    const props = this.models[fact]?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props)) if (v && v.description) out[k] = v.description;
    return out;
  }

  /** Physical JSON column holding event-specific properties on the events model. */
  eventDataColumn(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.event_data_column || 'event_properties';
  }

  /** Physical column of `fact` that carries the event type, or null. */
  eventNameColumn(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.event_name?.column || null;
  }

  /** Anchor column identifying the app/bundle (meta.mcp.dimension:{bundle:true}), or null.
   *  When set, the value index breaks per-property coverage down by it (per-app emptiness). */
  bundleColumn(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.bundle_column || null;
  }

  /** event_name values enum. */
  eventNames(fact) {
    fact = this._fact(fact);
    return this.models[fact]?.known_events || [];
  }

  /** event_properties keys (all, including complex array/struct ones). */
  eventProps(fact) {
    fact = this._fact(fact);
    return Object.keys(this.models[fact]?.properties || {});
  }

  /**
   * What `name` is on `source`: 'property' for an events source's payload property, 'dimension'
   * for a groupable attribute of any model, null when the source does not carry it. THE one place
   * that answers "does this source have this attribute" — every resolver in the engine (value-index
   * keys, the { source, property } view, memory targets) asks here, so a dimension is never asked for
   * payload properties and no caller re-implements the rule.
   */
  attributeKind(source, name) {
    const m = this.models[source];
    if (!m || !name) return null;
    // `has` on the OWN keys only: a plain-object lookup also answers for Object.prototype, so
    // 'toString' / 'constructor' / 'valueOf' resolved as real fields and were then addressed
    // as one (the memory tool's target `name` is free text, which is how they get in here).
    const has = (bag, key) => !!bag && Object.prototype.hasOwnProperty.call(bag, key);
    if (this.facts.includes(source) && has(m.properties, name)) return 'property';
    return has(m.dimensions, name) ? 'dimension' : null;
  }

  /** Full spec for one event_data property ({ type, items?, fields?, values?, description? }). */
  eventPropertySpec(name, fact) {
    fact = this._fact(fact);
    return (this.models[fact]?.properties || {})[name];
  }

  /** True if a property is a complex (array / struct / array-of-struct) type. */
  isComplexEventProp(name, fact) {
    fact = this._fact(fact);
    const t = String(this.eventPropertySpec(name, fact)?.type || '').toLowerCase();
    return t === 'array' || t === 'struct' || t === 'array<struct>';
  }

  /** SCALAR event_property keys — usable directly as categorical dims / scalar filters. */
  scalarEventProps(fact) {
    fact = this._fact(fact);
    return this.eventProps(fact).filter((k) => !this.isComplexEventProp(k, fact));
  }

  /** COMPLEX (array/struct) event_property keys — only usable via prepare stages. */
  complexEventProps(fact) {
    fact = this._fact(fact);
    return this.eventProps(fact).filter((k) => this.isComplexEventProp(k, fact));
  }

  /** Numeric event_properties keys (valid for sum/avg/median/percentile). */
  eventNumericProps(fact) {
    fact = this._fact(fact);
    const props = this.models[fact]?.properties || {};
    return Object.keys(props).filter((k) => isNumericType(props[k].type));
  }

  /** Every physical column of a model as { name, type } — referenceable in pipelines. */
  modelColumns(key) {
    return this.getModel(key).columns || [];
  }

  /** Plain (non-JSON) physical columns of a model usable as categorical dims. */
  modelDimensionColumns(key) {
    const m = this.getModel(key);
    if (this.isFact(key)) {
      // events: event_name plus every column explicitly marked meta.mcp.dimension (e.g. the app
      // column — present on every event, so it can segment without a join). A join KEY that should
      // also be groupable is marked meta.mcp.dimension like any other column; no key is singled
      // out by name.
      const cols = [];
      if (m.event_name?.column) cols.push(m.event_name.column);
      cols.push(...Object.keys(m.dimensions || {}));
      return [...new Set(cols)];
    }
    return Object.keys(m.dimensions || {});
  }

  /** Entity key columns of a model (for count_distinct field choices). */
  entityKeyColumns(key) {
    const m = this.getModel(key);
    const cols = [];
    const pe = m.primary_entity;
    if (pe && typeof pe === 'object') for (const p of pe.key || []) cols.push(p.column);
    for (const e of Object.values(m.entities || {})) {
      for (const p of e.key || []) cols.push(p.column);
    }
    return [...new Set(cols)];
  }

  /** Every join key `key` declares, by entity name: { <entity>: { type, key: [parts] } }. */
  entitiesOf(key) {
    const m = this.getModel(key);
    const out = {};
    const pe = m.primary_entity;
    if (pe && typeof pe === 'object' && pe.name) out[pe.name] = { type: 'primary', key: pe.key || [] };
    for (const [name, e] of Object.entries(m.entities || {})) out[name] = { type: e.type, key: e.key || [] };
    return out;
  }

  /** The parts of `entity`'s key ON `modelKey`, or undefined when it declares no such key. */
  entityKey(modelKey, entity) {
    return this.entitiesOf(modelKey)[entity]?.key;
  }

  /** The model that OWNS `entity` (declares it primary/unique) — the join target. */
  joinTargetFor(entity) {
    return this.primaryByEntity[entity];
  }

  /**
   * Entity names declared on BOTH models — the join(s) the schema sanctions between them.
   * Each carries the key parts on either side, so a caller never restates the columns.
   */
  sharedEntities(a, b) {
    const ea = this.entitiesOf(a); const eb = this.entitiesOf(b);
    return Object.keys(ea).filter((n) => eb[n]).map((n) => ({ entity: n, left: ea[n], right: eb[n] }));
  }

  /**
   * Every attribute a metric query can group or filter by, addressed by WHERE IT LIVES — the
   * only form the query tools accept: { model, attribute, via? }. `via` names the relationship
   * when the attribute is reached through a join whose name differs from the model's identity
   * (an owned key such as ad_funnel), and is omitted when the relationship IS the identity
   * (user → users) or the attribute is the source's own. One hop only — that is what a
   * structured reference can say.
   */
  reachableAttributes() {
    const out = []; const seen = new Set();
    const push = (model, attribute, via) => { const k = `${model}\u0000${attribute}\u0000${via || ''}`; if (!seen.has(k)) { seen.add(k); out.push({ model, attribute, ...(via ? { via } : {}) }); } };
    for (const fact of this.facts) {
      const m = this.models[fact];
      for (const [ent, e] of Object.entries(m.entities || {})) {
        if (e.type !== 'foreign') continue;
        const target = this.primaryByEntity[ent];
        if (!target) continue;
        const identity = primaryEntityName(this.models[target]);
        for (const dim of Object.keys(this.models[target].dimensions || {})) push(target, dim, ent === identity ? undefined : ent);
      }
    }
    for (const key of this.modelKeys()) {
      if (!primaryEntityName(this.models[key])) continue;
      for (const dim of Object.keys(this.models[key].dimensions || {})) push(key, dim, undefined);
    }
    return out;
  }

  /**
   * Fields of `key` the schema marks as AGGREGATABLE amounts. Each is { name, expr, column?,
   * type?, unit?, label?, description? } and carries NO aggregation — a task measure names one
   * as its `field` and chooses the function itself.
   */
  aggregatableFields(key) {
    return Object.values(this.getModel(key).aggregatable || {});
  }

  /** One aggregatable field of `key` by name, or undefined. */
  aggregatableField(key, name) {
    return this.getModel(key).aggregatable?.[name];
  }

  /** Aggregatable field names across every model (for the model-agnostic update schema). */
  aggregatableFieldNames() {
    return [...new Set(this.modelKeys().flatMap((k) => Object.keys(this.models[k].aggregatable || {})))];
  }

  /** The model that declares a base measure (meta.mcp.measures), or undefined. */
  modelOwningMeasure(ref) {
    return this.modelKeys().find((k) => (this.models[k].measures || {})[ref]);
  }

  /** Base measure reference names available across the registry. */
  baseMeasureRefs() {
    const refs = [];
    for (const m of Object.values(this.models)) {
      for (const name of Object.keys(m.measures || {})) refs.push(name);
    }
    return refs;
  }

  /** Relationships carried by VARIANTS (one relationship, several alternative key columns on a
   *  side): { <relationship>: [<expanded entity name>, …] }. Empty when no model declares any. */
  variantRelationships() {
    const out = {};
    for (const m of Object.values(this.models)) for (const [name, e] of Object.entries(m.entities || {})) if (e.variant_of) (out[e.variant_of] ||= new Set()).add(name);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
  }

  /** Entity names that appear on at least TWO models — the joins the schema sanctions. */
  joinEntityNames() {
    const seen = new Map();
    for (const k of this.modelKeys()) for (const name of Object.keys(this.entitiesOf(k))) seen.set(name, (seen.get(name) || 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort();
  }

  timeGranularities() {
    return [...GRAINS];
  }
}
