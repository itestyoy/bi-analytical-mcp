// Catalog (registry of dbt models) + derived enum sets and the entity-join
// graph. This is the single source of physical names; everything the AI can
// reference is projected from here into JSON-Schema enums.

import { readFileSync, existsSync } from 'node:fs';
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

export function loadCatalog(path, opts = {}) {
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
  return new Catalog(raw);
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
    const key = mcp.key;
    if (!key) throw new Error(`catalog model '${model.name}' is missing meta.mcp.key (logical name)`);
    const m = { dbt_model: model.name };
    if (mcp.role) m.role = mcp.role;
    if (mcp.primary_entity !== undefined) m.primary_entity = mcp.primary_entity;
    if (mcp.known_events) m.known_events = mcp.known_events;
    if (mcp.measures) m.measures = mcp.measures;
    if (mcp.anchor) out.anchor_model = key;

    const entities = {};
    const dimensions = {};
    const columnDescriptions = {};
    const isAnchor = !!mcp.anchor;
    for (const col of model.columns || []) {
      const cm = col.meta?.mcp || {};
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
    if (Object.keys(entities).length) m.entities = entities;
    if (Object.keys(dimensions).length) m.dimensions = dimensions;
    if (Object.keys(columnDescriptions).length) m.column_descriptions = columnDescriptions;
    out.models[key] = m;
  }
  if (!out.anchor_model) out.anchor_model = doc.anchor_model;
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

  /** Physical JSON column holding event-specific properties on the events model. */
  eventDataColumn() {
    return this.models[this.anchor]?.event_data_column || 'event_properties';
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

  /** Plain (non-JSON) physical columns of a model usable as categorical dims. */
  modelDimensionColumns(key) {
    const m = this.getModel(key);
    if (key === this.anchor) {
      // events: event_name + the real session key column are useful categorical columns
      const cols = [];
      if (m.event_name?.column) cols.push(m.event_name.column);
      if (m.entities?.session?.column) cols.push(m.entities.session.column);
      return cols;
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
