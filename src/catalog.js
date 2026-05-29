// Catalog (registry of dbt models) + derived enum sets and the entity-join
// graph. This is the single source of physical names; everything the AI can
// reference is projected from here into JSON-Schema enums.

import { readFileSync } from 'node:fs';
import { isNumericType } from './dialect.js';

export function loadCatalog(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return new Catalog(raw);
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

  /** Physical JSON column holding event-specific properties on the events model. */
  eventDataColumn() {
    return this.models[this.anchor]?.event_data_column || 'event_properties';
  }

  /** event_name values enum. */
  eventNames() {
    return this.models[this.anchor]?.known_events || [];
  }

  /** event_properties keys. */
  eventProps() {
    return Object.keys(this.models[this.anchor]?.properties || {});
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
      // events: event_name + session_id are useful categorical columns
      const cols = [];
      if (m.event_name?.column) cols.push('event_name');
      if (m.entities?.session) cols.push('session_id');
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
