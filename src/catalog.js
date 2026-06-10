// Catalog (registry of dbt models) + derived enum sets and the entity-join
// graph. This is the single source of physical names; everything the AI can
// reference is projected from here into JSON-Schema enums.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { isNumericType, SUPPORTED_DIALECTS } from './dialect.js';

export { SUPPORTED_DIALECTS };

// Native dbt `data_type`s that map to a MetricFlow time dimension.
const TIME_DATA_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'timestamp_ntz', 'timestamp_tz', 'datetime', 'time']);

/** Logical dimension type derived from the native dbt column `data_type`. */
function dimTypeFromDataType(dataType) {
  return TIME_DATA_TYPES.has(String(dataType || '').toLowerCase()) ? 'time' : 'categorical';
}

/** Coarse pipeline type for a physical column (so native pipelines can reference it). */
function pipelineColumnType(cm, col) {
  if (cm.is_time) return 'time';
  if (cm.is_event_data) return 'json';
  if (cm.array) {
    const enc = cm.array.encoding || (String(col.data_type).toLowerCase() === 'string' ? 'json' : 'native');
    return enc === 'native' ? 'array' : 'string';
  }
  const dt = String(col.data_type || '').toLowerCase();
  if (TIME_DATA_TYPES.has(dt)) return 'time';
  return isNumericType(dt) ? 'numeric' : 'string';
}

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
  raw.warehouse_dialect = resolveDialect({ dialect: opts.dialect, profilesDir: opts.profilesDir, projectDir: opts.projectDir, fallback: raw.warehouse_dialect });
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
  const mcpModels = models.filter((m) => m.meta?.mcp && (m.meta.mcp.role || m.meta.mcp.key));
  if (!mcpModels.length) throw new Error(`no MCP-tagged models found under ${projectDir} (tag a dbt model with meta.mcp.role + meta.mcp.key)`);
  const byRole = new Map();
  for (const m of mcpModels) {
    const role = m.meta.mcp.role || m.meta.mcp.key;
    if (byRole.has(role)) throw new Error(`config error: more than one model declares role '${role}' (${byRole.get(role)} and ${m.name}); exactly one model per role`);
    byRole.set(role, m.name);
  }
  const raw = dbtSchemaToCatalog({ models: mcpModels });
  raw.warehouse_dialect = resolveDialect({ dialect: opts.dialect, profilesDir: opts.profilesDir || projectDir, projectDir, fallback: raw.warehouse_dialect });
  if (opts.requireTimeRange != null) raw.require_time_range = !!opts.requireTimeRange; // runtime override (e.g. MCP_REQUIRE_TIME_RANGE)
  return new Catalog(raw);
}

/** A configured path list from dbt_project.yml (e.g. model-paths), with a default. */
function readPaths(projectDir, key, dflt) {
  try {
    const dp = yaml.load(readFileSync(join(projectDir, 'dbt_project.yml'), 'utf8')) || {};
    const v = dp[key] ?? dflt;
    return Array.isArray(v) ? v : [v];
  } catch {
    return dflt;
  }
}
function readModelPaths(projectDir) {
  return readPaths(projectDir, 'model-paths', readPaths(projectDir, 'source-paths', ['models']));
}

/** Basenames (without extension) of files matching `extRe` under the given dirs. */
function collectBasenames(projectDir, paths, extRe, acc = new Set()) {
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extRe.test(e.name)) acc.add(e.name.replace(extRe, ''));
    }
  };
  for (const mp of paths) walk(join(projectDir, mp));
  return acc;
}

/** Concatenated text of every .sql under the given dirs (for macro scanning). */
function readAllSql(projectDir, paths) {
  let text = '';
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.sql$/i.test(e.name)) { try { text += `\n${readFileSync(p, 'utf8')}`; } catch { /* skip */ } }
    }
  };
  for (const mp of paths) walk(join(projectDir, mp));
  return text;
}

// dbt macros the server shells out to (run-operation) and therefore REQUIRES.
const REQUIRED_MACROS = ['mcp_relation_columns'];

/**
 * Validate that a dbt project implements the components the server needs:
 *   - dbt_project.yml present
 *   - the required macro(s) defined (column introspection)
 *   - each catalog role's dbt node exists as a model (.sql) or seed (.csv)
 * Throws a single, actionable error listing everything missing.
 */
export function validateDbtProject(projectDir, catalog) {
  const problems = [];
  if (!existsSync(join(projectDir, 'dbt_project.yml'))) problems.push('dbt_project.yml not found (is this a dbt project?)');

  const macroText = readAllSql(projectDir, readPaths(projectDir, 'macro-paths', ['macros']));
  for (const name of REQUIRED_MACROS) {
    if (!new RegExp(`macro\\s+${name}\\s*\\(`).test(macroText)) {
      problems.push(`required macro '${name}' is not defined (needed for warehouse column introspection)`);
    }
  }

  const nodes = collectBasenames(projectDir, readModelPaths(projectDir), /\.sql$/i);
  collectBasenames(projectDir, readPaths(projectDir, 'seed-paths', ['seeds']), /\.csv$/i, nodes);
  for (const key of catalog.modelKeys()) {
    const name = catalog.getModel(key).dbt_model;
    if (name && !nodes.has(name)) problems.push(`role '${key}' references dbt node '${name}', which is not a model (.sql) or seed (.csv) in the project`);
  }

  if (problems.length) {
    throw new Error(`dbt project at ${projectDir} is missing required components:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Recursively collect `models:` entries from every *.yml/*.yaml under dir. */
function collectSchemaModels(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { collectSchemaModels(p, acc); continue; }
    if (!/\.ya?ml$/i.test(e.name)) continue;
    try {
      const doc = yaml.load(readFileSync(p, 'utf8'));
      if (Array.isArray(doc?.models)) for (const m of doc.models) if (m && m.name) acc.push(m);
    } catch { /* skip unparseable YAML */ }
  }
}

/**
 * Resolve the warehouse dialect (runtime config). Precedence:
 *   1. explicit `dialect` argument
 *   2. WAREHOUSE_DIALECT env var
 *   3. the active dbt profile's output `type` (what dbt actually connects with)
 *   4. `fallback` (legacy catalogs) / 'postgres'
 */
export function resolveDialect({ dialect, profilesDir, projectDir, fallback } = {}) {
  const d = dialect || process.env.WAREHOUSE_DIALECT || dialectFromProfile(profilesDir, projectDir) || fallback || 'postgres';
  if (!SUPPORTED_DIALECTS.has(d)) {
    throw new Error(`unsupported warehouse dialect '${d}' (supported: ${[...SUPPORTED_DIALECTS].join(', ')}). Set WAREHOUSE_DIALECT or fix the dbt profile output type.`);
  }
  return d;
}

/** Read the adapter `type` from the dbt profile (the dialect dbt runs with). */
function dialectFromProfile(profilesDir, projectDir) {
  try {
    let profileName;
    if (projectDir) {
      const pj = join(projectDir, 'dbt_project.yml');
      if (existsSync(pj)) profileName = yaml.load(readFileSync(pj, 'utf8'))?.profile;
    }
    const dir = profilesDir || process.env.DBT_PROFILES_DIR || join(homedir(), '.dbt');
    const pp = join(dir, 'profiles.yml');
    if (!existsSync(pp)) return undefined;
    const profiles = yaml.load(readFileSync(pp, 'utf8')) || {};
    const prof = (profileName && profiles[profileName]) || profiles[Object.keys(profiles).filter((k) => k !== 'config')[0]];
    if (!prof) return undefined;
    const target = process.env.DBT_TARGET || prof.target || Object.keys(prof.outputs || {})[0];
    const type = prof.outputs?.[target]?.type;
    return type && SUPPORTED_DIALECTS.has(type) ? type : undefined;
  } catch {
    return undefined; // best-effort: fall back to env/default
  }
}

/**
 * Transform a dbt model-schema document into the internal catalog registry.
 * MCP semantics are read from `meta.mcp` at the model level (key/role/anchor/
 * primary_entity/known_events/measures) and the column level (entity/is_time/
 * is_event_name/is_event_data+properties/dimension).
 */
export function dbtSchemaToCatalog(doc) {
  // warehouse_dialect is intentionally NOT read from the catalog here; loadCatalog
  // resolves it from env/profile. `fallback` carries any legacy value if present.
  const out = { warehouse_dialect: doc.warehouse_dialect, models: {} };
  for (const model of doc.models || []) {
    const mcp = model.meta?.mcp || {};
    // The ROLE is the logical name — the dbt model can be named anything. (`key`
    // is still accepted as a legacy alias.) Nothing is hardcoded to a specific name.
    const key = mcp.role || mcp.key;
    if (!key) throw new Error(`catalog model '${model.name}' is missing meta.mcp.role`);
    const m = { dbt_model: model.name };
    if (model.description) m.description = model.description;
    if (mcp.role) m.role = mcp.role;
    if (mcp.primary_entity !== undefined) m.primary_entity = mcp.primary_entity;
    if (mcp.known_events) m.known_events = mcp.known_events;
    if (mcp.measures) m.measures = mcp.measures;
    // Business meaning of key events (e.g. acquisition_event: first_launch) — lets an
    // AI pick the right base events for retention/conversion without guessing.
    if (mcp.event_semantics) m.event_semantics = mcp.event_semantics;
    // The physical partition column (cost hint): queries should constrain it (or the
    // time column) to prune the scan. Surfaced statically — no live runner needed.
    if (mcp.partition_column) m.partition_column = mcp.partition_column;
    // Cost guardrail: when the anchor declares require_time_range, unbounded queries
    // (no time window) are rejected instead of full-scanning the warehouse.
    if (mcp.require_time_range != null) m.require_time_range = !!mcp.require_time_range;

    // The anchor (events fact) is DETECTED structurally: the model that declares
    // the event_name / event_data / time columns. `anchor: true` is an optional
    // override. Exactly one model may be the fact.
    const isAnchor = mcp.anchor === true
      || (model.columns || []).some((c) => { const cm = c.meta?.mcp || {}; return cm.is_event_name || cm.is_event_data || cm.is_time; });
    if (isAnchor) {
      if (out.anchor_model && out.anchor_model !== key) throw new Error(`multiple anchor (fact) models: '${out.anchor_model}' and '${key}'. Exactly one model may declare event_name/event_data/time columns.`);
      out.anchor_model = key;
    }

    const entities = {};
    const dimensions = {};
    const flatProps = {}; // anchor-only: flattened event_data__* payload columns
    const columnDescriptions = {};
    const allColumns = []; // EVERY physical column (name + pipeline type) — referenceable in native pipelines
    for (const col of model.columns || []) {
      const cm = col.meta?.mcp || {};
      // Expose every REAL column to native pipelines — except the raw is_event_data
      // payload marker, which may not exist as a physical column once flattened.
      if (!cm.is_event_data) allColumns.push({ name: col.name, type: pipelineColumnType(cm, col) });
      if (col.description) columnDescriptions[col.name] = col.description; // dbt column doc
      if (cm.entity) {
        if (cm.entity.type === 'primary') m.primary_entity = { name: cm.entity.name, column: col.name };
        else entities[cm.entity.name] = { column: col.name, type: cm.entity.type };
        continue; // entity key columns are not dimensions
      }
      if (cm.is_time) { m.time = { column: col.name, granularity: cm.granularity || 'day' }; continue; }
      if (cm.is_event_name) { m.event_name = { column: col.name }; continue; }
      if (cm.is_event_data) {
        m.event_data_column = col.name;
        if (cm.properties) m.properties = cm.properties;
        continue;
      }
      // Flattened event payload: on the anchor, an event_data__* column (or any
      // column scoped to specific events via meta.mcp.events) is a per-event
      // PROPERTY. Unlike the legacy JSON-blob form, these are REAL physical columns
      // — recorded with `column` so SQL references them directly (no JSON extract).
      if (isAnchor && !cm.dimension && cm.array) {
        // A flattened ARRAY/array<struct> payload column. `meta.mcp.array` declares how
        // to read it: encoding 'native' (a real ARRAY/REPEATED column) or 'json' (a STRING
        // holding a JSON array → parse before unnest). items = scalar element type;
        // fields = struct shape. The physical `column` is referenced directly.
        const a = cm.array;
        flatProps[col.name] = {
          type: a.fields ? 'array<struct>' : 'array',
          column: col.name,
          encoding: a.encoding || (String(col.data_type).toLowerCase() === 'string' ? 'json' : 'native'),
          ...(a.items ? { items: a.items } : {}),
          ...(a.fields ? { fields: a.fields } : {}),
          ...(cm.events ? { events: cm.events } : {}),
          ...(cm.unit ? { unit: cm.unit } : {}),
          ...(col.description ? { description: col.description } : {}),
        };
        continue;
      }
      if (isAnchor && !cm.dimension && cm.events) {
        // A flattened event-payload property: a real column populated only on the
        // events in meta.mcp.events. The column is named directly (no `__`, which
        // MetricFlow reserves), so it is used as-is for both the key and the expr.
        // `unit` (meta.mcp.unit, e.g. 'seconds', 'usd_cents') is machine-readable so
        // values in different units are never blindly mixed/summed.
        flatProps[col.name] = {
          type: isNumericType(col.data_type) ? 'numeric' : 'string',
          column: col.name,
          ...(cm.values ? { values: cm.values } : {}),
          ...(cm.events ? { events: cm.events } : {}),
          ...(cm.unit ? { unit: cm.unit } : {}),
          ...(col.description ? { description: col.description } : {}),
        };
        continue;
      }
      // Dimensions: on a non-anchor (dimension) model, every remaining column is
      // a groupable dimension. Its TYPE comes from the native dbt `data_type`
      // (date/timestamp -> time, else categorical) — not from meta. Only the bits
      // dbt has no native field for stay in meta: time `granularity` (non-day)
      // and categorical `values` hints. `meta.mcp.dimension` is still honored.
      if (cm.dimension || !isAnchor) {
        const explicit = cm.dimension || {};
        const type = explicit.type || dimTypeFromDataType(col.data_type);
        const d = { type };
        if (type === 'time') d.granularity = explicit.granularity || cm.granularity || 'day';
        const values = explicit.values || cm.values;
        if (values) d.values = values;
        dimensions[col.name] = d;
      }
    }
    if (Object.keys(flatProps).length) m.properties = { ...(m.properties || {}), ...flatProps };
    m.columns = allColumns;
    if (Object.keys(entities).length) m.entities = entities;
    if (Object.keys(dimensions).length) m.dimensions = dimensions;
    if (Object.keys(columnDescriptions).length) m.column_descriptions = columnDescriptions;
    out.models[key] = m;
  }
  out.anchor_model = out.anchor_model || doc.anchor_model;
  if (!out.anchor_model) throw new Error('no anchor (events fact) model: exactly one model must declare an event_name / event_data / time column');
  // Schema validation: names that become MetricFlow identifiers (event-property keys
  // and dimension columns) MUST NOT contain '__' — MetricFlow reserves it as the
  // entity/dimension separator. Fail loudly at load so the dbt schema is corrected at
  // the source (with proper names) instead of silently rewritten in code.
  for (const [key, m] of Object.entries(out.models)) {
    const bad = [];
    for (const p of Object.keys(m.properties || {})) if (p.includes('__')) bad.push(`event property '${p}'`);
    for (const d of Object.keys(m.dimensions || {})) if (d.includes('__')) bad.push(`dimension column '${d}'`);
    if (bad.length) {
      throw new Error(`catalog schema invalid in model '${key}': ${bad.join(', ')} contain '__', which MetricFlow reserves as the entity/dimension separator. Give the column(s) correct names in your dbt model — e.g. an inverted '_of_' form: event_data__price_in_usd -> price_in_usd_of_event_data.`);
    }
  }
  return out;
}

/** Logical name of a model's primary entity. */
function primaryEntityName(model) {
  const pe = model.primary_entity;
  return typeof pe === 'string' ? pe : pe?.name;
}

export class Catalog {
  constructor(raw) {
    this.raw = raw;
    this.dialect = raw.warehouse_dialect;
    this.models = raw.models;
    this.anchor = raw.anchor_model || 'events';
    if (!this.models?.[this.anchor]) {
      throw new Error(`anchor_model '${this.anchor}' not found in catalog.models`);
    }
    // Cost guardrail: reject unbounded (no time window) queries when the anchor model
    // (or a loadCatalog override) demands a bounded window. See engine guards.
    this.requireTimeRange = !!(raw.require_time_range ?? this.models[this.anchor]?.require_time_range);
    // Map: entity name -> model key that owns it as primary/unique (join target).
    this.primaryByEntity = {};
    for (const [key, m] of Object.entries(this.models)) {
      const name = primaryEntityName(m);
      if (name) this.primaryByEntity[name] = key;
    }
  }

  modelKeys() {
    return Object.keys(this.models);
  }

  getModel(key) {
    const m = this.models[key];
    if (!m) throw new Error(`Unknown model: ${key}`);
    return m;
  }

  primaryEntityName(key) {
    return primaryEntityName(this.getModel(key));
  }

  /** Model key whose PRIMARY entity is `entity` (the join target), excluding the anchor. */
  dimensionModelForEntity(entity) {
    const key = this.primaryByEntity[entity];
    return key && key !== this.anchor ? key : undefined;
  }

  /** Physical column on the anchor for an entity (e.g. the user/session key). */
  anchorEntityColumn(entity) {
    return this.models[this.anchor]?.entities?.[entity]?.column;
  }

  /** dbt column descriptions for a model: { columnName: description }. */
  columnDescriptions(key) {
    return this.getModel(key).column_descriptions || {};
  }

  /** event_data property descriptions (if declared): { property: description }. */
  eventPropertyDescriptions() {
    const props = this.models[this.anchor]?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props)) if (v && v.description) out[k] = v.description;
    return out;
  }

  /**
   * Which event(s) each property is populated on: { property: [event_name, ...] }.
   * A property is NULL on any event NOT in its list, so a measure/dimension/filter on
   * it MUST be scoped (event_name / event_scope) to those events. Only properties that
   * declare an applicability list are included.
   */
  eventPropertyEvents() {
    const props = this.models[this.anchor]?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props)) if (v && Array.isArray(v.events) && v.events.length) out[k] = v.events;
    return out;
  }

  /** Physical JSON column holding event-specific properties on the events model. */
  eventDataColumn() {
    return this.models[this.anchor]?.event_data_column || 'event_properties';
  }

  /** Physical column on the anchor that carries the event type, or null. */
  eventNameColumn() {
    return this.models[this.anchor]?.event_name?.column || null;
  }

  /** event_name values enum. */
  eventNames() {
    return this.models[this.anchor]?.known_events || [];
  }

  /** event_properties keys (all, including complex array/struct ones). */
  eventProps() {
    return Object.keys(this.models[this.anchor]?.properties || {});
  }

  /** Full spec for one event_data property ({ type, items?, fields?, values?, description? }). */
  eventPropertySpec(name) {
    return (this.models[this.anchor]?.properties || {})[name];
  }

  /** True if a property is a complex (array / struct / array-of-struct) type. */
  isComplexEventProp(name) {
    const t = String(this.eventPropertySpec(name)?.type || '').toLowerCase();
    return t === 'array' || t === 'struct' || t === 'array<struct>';
  }

  /** SCALAR event_property keys — usable directly as categorical dims / scalar filters. */
  scalarEventProps() {
    return this.eventProps().filter((k) => !this.isComplexEventProp(k));
  }

  /** COMPLEX (array/struct) event_property keys — only usable via prepare stages. */
  complexEventProps() {
    return this.eventProps().filter((k) => this.isComplexEventProp(k));
  }

  /** Numeric event_properties keys (valid for sum/avg/median/percentile). */
  eventNumericProps() {
    const props = this.models[this.anchor]?.properties || {};
    return Object.keys(props).filter((k) => isNumericType(props[k].type));
  }

  /** Every physical column of a model as { name, type } — referenceable in native pipelines. */
  modelColumns(key) {
    return this.getModel(key).columns || [];
  }

  /** Plain (non-JSON) physical columns of a model usable as categorical dims. */
  modelDimensionColumns(key) {
    const m = this.getModel(key);
    if (key === this.anchor) {
      // events: event_name + the real session key column, plus any column explicitly
      // marked meta.mcp.dimension (e.g. bundle_id — present on every event, so it
      // can segment by app without a users-join).
      const cols = [];
      if (m.event_name?.column) cols.push(m.event_name.column);
      if (m.entities?.session?.column) cols.push(m.entities.session.column);
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
    if (typeof pe === 'object' && pe.column) cols.push(pe.column);
    for (const e of Object.values(m.entities || {})) {
      if (e.column) cols.push(e.column);
    }
    return [...new Set(cols)];
  }

  /**
   * Group-by / filter paths reachable from the anchor via the entity graph,
   * up to `maxHops` (default 2 hops / 3 tables). Foreign entities with no
   * matching primary target are pruned (m3). Includes `metric_time`.
   */
  reachableGroupByPaths(maxHops = 2) {
    const out = new Set(['metric_time']);
    const anchor = this.models[this.anchor];

    // local categorical columns on the anchor are added per-task; here we expose
    // only join-reachable dimensions + metric_time (task dims added at runtime).
    const visit = (modelKey, prefix, hop) => {
      if (hop > maxHops) return;
      const model = this.models[modelKey];
      for (const [entName, ent] of Object.entries(model.entities || {})) {
        if (ent.type !== 'foreign') continue;
        const targetKey = this.primaryByEntity[entName];
        if (!targetKey) continue; // pruned: dangling foreign (m3)
        const target = this.models[targetKey];
        const newPrefix = prefix ? `${prefix}__${entName}` : entName;
        for (const dim of Object.keys(target.dimensions || {})) {
          out.add(`${newPrefix}__${dim}`);
        }
        visit(targetKey, newPrefix, hop + 1);
      }
    };
    visit(this.anchor, '', 1);
    return [...out];
  }

  /** Base measure reference names available across the registry. */
  baseMeasureRefs() {
    const refs = [];
    for (const m of Object.values(this.models)) {
      for (const name of Object.keys(m.measures || {})) refs.push(name);
    }
    return refs;
  }

  /** Models that may be referenced in `use_base_models` (everything but anchor). */
  joinableModelKeys() {
    return this.modelKeys().filter((k) => k !== this.anchor);
  }

  timeGranularities() {
    return ['day', 'week', 'month', 'quarter', 'year'];
  }
}
