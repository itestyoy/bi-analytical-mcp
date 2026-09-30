// A dbt SCHEMA FILE READ AS A CATALOG — each model's `config.meta.mcp` (or the pre-1.10 top-level
// `meta`, config winning per key) turned into the catalog's own shape: its role, its time axis, its
// entities, measures and dimensions, and every mistake in it refused at load.

import { isNumericType } from '../dialect.js';
import { normalizeMeasure, normalizeAggregatable } from './measures.js';
import { normalizeEntityKey } from './entities.js';
import { dimTypeFromDataType, pipelineColumnType } from './column-types.js';

/**
 * WHERE `meta` LIVES IN A dbt SCHEMA FILE — both places, because dbt moved it.
 *
 * Up to dbt 1.9 a model or a column carried `meta:` as a property of its own. dbt 1.10 moved it
 * under `config:`; 1.11 still reads the old place and only warns (PropertyMovedToConfigDeprecation),
 * but dbt Fusion treats the top-level key as unknown (UnusedConfigKey, dbt1060) and DROPS it. A
 * catalog read from a Fusion-parsed project would then have no roles, no dimensions and no
 * measures at all — the whole MCP surface is in that block.
 *
 * So this reader takes it from either place, with `config.meta` winning key by key (dbt's own
 * precedence) for a project caught half-way through the move. Everything downstream keeps reading
 * `meta.mcp`, because this is the only door the two shapes come through.
 */
export function mcpMetaOf(node) {
  const legacy = node?.meta?.mcp;
  const moved = node?.config?.meta?.mcp;
  if (!legacy) return moved;
  if (!moved) return legacy;
  return { ...legacy, ...moved };
}

/** The same node with its MCP block in ONE place, so the rest of this file reads `meta.mcp`. */
export function withNormalizedMeta(node) {
  const mcp = mcpMetaOf(node);
  if (!mcp || node.meta?.mcp === mcp) return node;
  return { ...node, meta: { ...(node.meta || {}), mcp } };
}

/**
 * Transform a dbt model-schema document into the internal catalog registry.
 * MCP semantics are read from `meta.mcp` at the model level (key/role/
 * primary_entity/known_events/measures) and the column level (entity/is_time/
 * is_event_name/is_event_data+properties/dimension).
 */
export function dbtSchemaToCatalog(doc) {
  // warehouse_dialect is intentionally NOT read from the catalog here; loadCatalog
  // resolves it from env/profile. `fallback` carries any legacy value if present.
  const out = { warehouse_dialect: doc.warehouse_dialect, models: {} };
  for (const raw of doc.models || []) {
    // dbt 1.10 moved `meta` under `config:` — on the model and on every column. Both shapes are
    // folded into one here (see mcpMetaOf), so nothing below has to know which file it came from.
    const model = { ...withNormalizedMeta(raw), ...(raw.columns ? { columns: raw.columns.map(withNormalizedMeta) } : {}) };
    const mcp = model.meta?.mcp || {};
    // The ROLE is the logical name — the dbt model can be named anything. (`key`
    // is still accepted as a legacy alias.) Nothing is hardcoded to a specific name.
    const key = mcp.role || mcp.key;
    if (!key) throw new Error(`catalog model '${model.name}' is missing config.meta.mcp.role (dbt 1.10+ keeps meta under config:; the pre-1.10 top-level meta.mcp is still read)`);
    const m = { dbt_model: model.name };
    if (model.description) m.description = model.description;
    if (mcp.role) m.role = mcp.role;
    // an explicit null is no primary entity (the model owns none), as leaving it out is
    if (mcp.primary_entity != null) m.primary_entity = asPrimaryEntity(mcp.primary_entity);
    if (mcp.known_events) m.known_events = mcp.known_events;
    // Model-level declarations. An entry WITHOUT `agg` is an aggregatable EXPRESSION — the
    // caller picks the function; an entry WITH `agg` is additionally a governed measure whose
    // function is fixed (a standard KPI everyone must compute the same way).
    for (const [name, raw] of Object.entries(mcp.measures || {})) {
      const decl = raw || {};
      (m.aggregatable ||= {})[name] = normalizeAggregatable(name, decl, { model: model.name });
      if (decl.agg) (m.measures ||= {})[name] = normalizeMeasure(name, decl, { model: model.name });
    }
    // Business meaning of key events (e.g. acquisition_event: first_launch) — lets an
    // AI pick the right base events for retention/conversion without guessing.
    if (mcp.event_semantics) m.event_semantics = mcp.event_semantics;
    // The physical partition column (cost hint): queries should constrain it (or the
    // time column) to prune the scan. Surfaced statically — no live runner needed.
    if (mcp.partition_column) m.partition_column = mcp.partition_column;
    // The partition column is the DAY of the time axis — an event is stored under its own day.
    // A source that files a late-arriving event under the day it ARRIVED says how late one may
    // be: partition_late_days: N reads N more days after a window, so no late event is missed.
    if (mcp.partition_late_days != null) {
      const n = mcp.partition_late_days;
      if (!Number.isInteger(n) || n < 0) throw new Error(`model '${model.name}': meta.mcp.partition_late_days must be a whole number of days (0 or more), got ${JSON.stringify(n)}`);
      if (!mcp.partition_column) throw new Error(`model '${model.name}': meta.mcp.partition_late_days needs a partition_column`);
      m.partition_late_days = n;
    }
    // Cost guardrail: when the anchor declares require_time_range, unbounded queries
    // (no time window) are rejected instead of full-scanning the warehouse.
    if (mcp.require_time_range != null) m.require_time_range = !!mcp.require_time_range;

    // A FACT (events source) is DETECTED structurally: a model declaring an
    // event_name / event_data column. SEVERAL facts may coexist — e.g. an analytics
    // events source and a Crashlytics one — and they are INDEPENDENT AND EQUAL: each
    // owns its event vocabulary (known_events + event-scoped properties) and its own
    // space in the value index, and the SOURCE is always a separate argument. A model
    // with neither column is not a fact even if it declares a time axis (a measures
    // source such as acquisition). There is NO default or "anchor" source: a source may
    // be omitted only when the catalog has exactly one.
    if (mcp.anchor !== undefined) {
      throw new Error(`model '${model.name}': meta.mcp.anchor is no longer a schema key — there is no default source. Every events source is addressed by name (semantic_index({ source }), build_pipeline_model({ source }), semantic_models[].from); a source may be omitted only when the catalog has exactly one.`);
    }
    const isFact = (model.columns || []).some((c) => { const cm = c.meta?.mcp || {}; return cm.is_event_name || cm.is_event_data; });
    if (isFact) (out.facts ||= []).push(key);

    const entities = {};
    let primaryFromColumn = null; // the column that claimed this model's identity, if any
    const dimensions = {};
    const flatProps = {}; // fact-only: flattened event_data__* payload columns
    const columnDescriptions = {};
    const allColumns = []; // EVERY physical column (name + pipeline type) — referenceable in native pipelines
    for (const col of model.columns || []) {
      const cm = col.meta?.mcp || {};
      // A VALIDITY MARK only means something on a groupable time dimension — that is the only
      // place it can become validity_params. On a column that is a join key, a measure, the
      // model's time axis or an opted-out dimension, the branches below take the column first
      // and the mark would never be read: reject it here rather than let the author believe the
      // window is in effect.
      {
        const v = cm.dimension && typeof cm.dimension === 'object' ? cm.dimension.validity : undefined;
        const taken = cm.entity ? 'a join key (meta.mcp.entity)'
          : cm.is_time ? "the model's time axis (meta.mcp.is_time)"
            : (cm.measure && !cm.dimension) ? 'a measure (meta.mcp.measure)'
              : cm.is_event_name ? 'the event-name column' : cm.is_event_data ? 'the event-data payload' : null;
        if (v && taken) {
          throw new Error(`column '${col.name}' of model '${model.name}' is marked meta.mcp.dimension.validity: ${v}, but that column is ${taken}, so it never becomes a groupable time dimension and the window would be ignored. A validity window is a PAIR of separate time columns (start and end) on a slowly-changing dimension model.`);
        }
      }
      // Expose every REAL column to native pipelines — except the raw is_event_data
      // payload marker, which may not exist as a physical column once flattened.
      if (!cm.is_event_data) allColumns.push({ name: col.name, type: pipelineColumnType(cm, col) });
      if (col.description) columnDescriptions[col.name] = col.description; // dbt column doc
      if (cm.entity) {
        // A column-level entity is the single-column case of the same declaration.
        const ent = normalizeEntityKey(cm.entity.name, { type: cm.entity.type, key: col.name }, { model: model.name });
        // Two declarations of the SAME thing must not silently pick a winner: whichever the
        // loop happened to see last would decide the model's identity — or its join key — and
        // the author would never learn which of the two the manifest was built from.
        if (ent.type === 'primary') {
          // The model may already NAME its identity (meta.mcp.primary_entity: acquisition) — this
          // column then supplies its key, which is the normal pairing. What must not pass is a
          // SECOND column claiming the identity, or a column claiming a different name than the
          // model declared: either way one of the two declarations would be dropped in silence.
          const declaredName = primaryEntityName(m);
          if (primaryFromColumn) {
            throw new Error(`model '${model.name}': columns '${primaryFromColumn.column}' and '${col.name}' both declare a PRIMARY entity ('${primaryFromColumn.name}' and '${cm.entity.name}'). A model has exactly one identity — for a key that spans BOTH columns declare it once in meta.mcp.entities with a composite key; for a second join key use type: unique (still a join target) or foreign.`);
          }
          if (declaredName && declaredName !== cm.entity.name) {
            throw new Error(`model '${model.name}' declares meta.mcp.primary_entity '${declaredName}', but column '${col.name}' declares primary entity '${cm.entity.name}'. One of the two would be dropped — name the identity once.`);
          }
          primaryFromColumn = { name: cm.entity.name, column: col.name };
          m.primary_entity = { name: cm.entity.name, key: ent.key };
        } else {
          if (entities[cm.entity.name]) {
            throw new Error(`model '${model.name}': entity '${cm.entity.name}' is declared on two columns ('${(entities[cm.entity.name].key || []).map((p) => p.column).join(', ')}' and '${col.name}'). One relationship has one key here — use meta.mcp.entities with a composite key if it spans both columns, or 'variants' if they are alternative keys for it.`);
          }
          entities[cm.entity.name] = ent;
        }
        continue; // entity key columns are not dimensions
      }
      if (cm.is_time) {
        m.time = { column: col.name, granularity: cm.granularity || 'day' };
        // On an events source the time axis is the event time, surfaced as the fact's own
        // time dimension. On any OTHER source (an install record, a daily spend table) the
        // axis is equally a groupable attribute — "installs by install day" — so it stays in
        // the dimension list and everything reading dimensions keeps seeing it. Unless the
        // author opts out with meta.mcp.dimension: false, which means here exactly what it
        // means on any other column: a real column that is not an attribute to group by.
        if (!isFact && cm.dimension !== false) dimensions[col.name] = { type: 'time', granularity: m.time.granularity };
        continue;
      }
      // A column declared a MEASURE becomes an aggregatable amount of this model (any aggregation
      // from MEASURE_AGGS, on any column — nothing is special-cased). An amount is not a groupable
      // attribute, so on its own it is neither a dimension nor a value-index target; marked
      // meta.mcp.dimension AS WELL it is both (registered here, then it falls through to the
      // dimension branch below) — a numeric code people group by and occasionally sum.
      if (cm.measure) {
        // `measure: true` (or a bare object) MARKS the column as an amount: aggregatable with
        // ANY function, chosen per question at build time — the schema never fixes one. An
        // amount is not a groupable attribute, so it is neither a dimension nor a value-index
        // target. An optional `agg` ADDITIONALLY declares a governed measure with that fixed
        // function, under `name` — the free choice over the raw column stays either way.
        if (cm.measure !== true && (typeof cm.measure !== 'object' || Array.isArray(cm.measure))) {
          throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.measure must be true, or an object with unit/label/description (and optionally agg to also fix a governed measure)`);
        }
        const decl = cm.measure === true ? {} : cm.measure;
        m.aggregatable = m.aggregatable || {};
        m.aggregatable[col.name] = normalizeAggregatable(col.name, { ...decl, unit: decl.unit ?? cm.unit }, {
          model: model.name, column: col.name, type: pipelineColumnType(cm, col),
        });
        if (decl.agg) {
          const name = decl.name || col.name;
          (m.measures ||= {})[name] = normalizeMeasure(name, { ...decl, unit: decl.unit ?? cm.unit }, { model: model.name, column: col.name });
        }
        if (!cm.dimension) continue; // an amount alone is not an attribute
      }
      if (cm.is_event_name) { m.event_name = { column: col.name }; continue; }
      if (cm.is_event_data) {
        m.event_data_column = col.name;
        if (cm.properties) {
          for (const [pn, ps] of Object.entries(cm.properties)) {
            if (ps && (ps.values !== undefined || ps.events !== undefined)) throw new Error(`property '${pn}' of model '${model.name}' (meta.mcp.properties): 'values' / 'events' are no longer schema keys — both are measured by the value index. Keep type / items / fields / description.`);
          }
          m.properties = cm.properties;
        }
        continue;
      }
      // WHICH EVENTS CARRY A PROPERTY AND WHICH VALUES IT TAKES ARE MEASURED, NOT DECLARED. The
      // value index observes both per source and serves them everywhere (the { event },
      // { source, property } and { search } views, the filter-value guard, the event-scope warnings). A
      // declared list would only go stale in silence, so the schema no longer carries one: the
      // former meta.mcp.events / meta.mcp.values keys are refused with the replacement.
      if (cm.events !== undefined) {
        throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.events is no longer a schema key — which events carry a property is measured by the value index. To mark the column as an event-payload PROPERTY use meta.mcp.property: true (an array column needs only meta.mcp.array).`);
      }
      if (cm.values !== undefined || (cm.dimension && typeof cm.dimension === 'object' && cm.dimension.values !== undefined)) {
        throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.values is no longer a schema key — a column's real values and their frequencies come from the value index (semantic_index({ source, property })). Remove it; put the MEANING of special values in the description instead.`);
      }
      // Flattened event payload: on a FACT, a column marked meta.mcp.property (scalar) or
      // meta.mcp.array (array / array<struct>) is a per-event PROPERTY. These are REAL physical
      // columns — recorded with `column` so SQL references them directly (no JSON extract).
      if (isFact && !cm.dimension && cm.array) {
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
          ...(cm.unit ? { unit: cm.unit } : {}),
          ...(col.description ? { description: col.description } : {}),
        };
        continue;
      }
      if (cm.property === true && !isFact) {
        throw new Error(`column '${col.name}' of model '${model.name}': meta.mcp.property marks an EVENT-PAYLOAD property, which only an events source has. On a dimension or measures source every unmarked column is already a groupable attribute.`);
      }
      if (isFact && !cm.dimension && cm.property === true) {
        // A flattened scalar event-payload property: a real column, populated on whichever
        // events carry it — the index finds out which. The column is named directly (no `__`,
        // which MetricFlow reserves), so it is used as-is for both the key and the expr. `unit`
        // (meta.mcp.unit, e.g. 'seconds', 'usd_cents') is machine-readable so values in different
        // units are never blindly mixed/summed.
        flatProps[col.name] = {
          type: isNumericType(col.data_type) ? 'numeric' : 'string',
          column: col.name,
          ...(cm.unit ? { unit: cm.unit } : {}),
          ...(col.description ? { description: col.description } : {}),
        };
        continue;
      }
      // Dimensions: on a non-fact (dimension) model, every remaining column is
      // a groupable dimension. Its TYPE comes from the native dbt `data_type`
      // (date/timestamp -> time, else categorical) — not from meta. Only the bits
      // dbt has no native field for stay in meta: time `granularity` (non-day)
      // and categorical `values` hints. `meta.mcp.dimension` is still honored.
      // meta.mcp.dimension: false takes a column OUT of the group-by surface (it stays a real
      // column a pipeline can reference) — the opt-out for anything that is not an attribute.
      if (cm.dimension === false) continue;
      if (cm.dimension || !isFact) {
        const explicit = cm.dimension || {};
        // A validity-window bound (meta.mcp.dimension.validity: start|end) marks the SCD-2 pair
        // MetricFlow uses for a point-in-time join — force it to a TIME dimension regardless of
        // the guessed type, and flag the model as slowly-changing.
        const validity = explicit.validity === 'start' || explicit.validity === 'end' ? explicit.validity : null;
        const type = validity ? 'time' : (explicit.type || dimTypeFromDataType(col.data_type));
        const d = { type };
        if (type === 'time') d.granularity = explicit.granularity || cm.granularity || 'day';
        if (validity) { d.validity = validity; m.scd = true; }
        // meta.mcp.index: false keeps a column out of the VALUE index (an id or a free-text
        // column has no enumerable value set worth scanning) while staying groupable.
        if (cm.index === false || explicit.index === false) d.index = false;
        dimensions[col.name] = d;
        // A dimension explicitly marked the BUNDLE/app identifier on an events source lets the
        // value index break coverage down per app (which properties are empty for which app).
        if (isFact && explicit.bundle) m.bundle_column = col.name;
      }
    }
    if (Object.keys(flatProps).length) m.properties = { ...(m.properties || {}), ...flatProps };
    m.columns = allColumns;
    // Model-level `meta.mcp.entities`: a join key that spans SEVERAL columns, or one relationship
    // carried by several ALTERNATIVE columns (`variants`). It lives on the MODEL because it
    // belongs to no single column. The same entity NAME on two models is the join between them, and the key is
    // declared once here rather than passed in at every call site.
    {
      const known = new Set(allColumns.map((c) => c.name));
      for (const [name, decl] of Object.entries(mcp.entities || {})) {
        const ent = normalizeEntityKey(name, decl || {}, { model: model.name, columns: known });
        if (ent.type === 'primary') {
          if (ent.variants) throw new Error(`entity '${name}' of model '${model.name}': a primary entity is the model's single identity and cannot have variants; declare the alternatives as type: unique or foreign.`);
          const prev = primaryEntityName(m);
          if (prev && prev !== name) throw new Error(`model '${model.name}' declares two primary entities ('${prev}' and '${name}'). A model has exactly one identity; declare the other key as type: unique (still a join target) or foreign.`);
          m.primary_entity = { name, key: ent.key };
        } else {
          // The same name declared BOTH on a column and here: the model-level entry would win
          // by position in the file. Say so instead — the author has two keys for one
          // relationship and must state which it is.
          if (entities[name]) {
            throw new Error(`model '${model.name}': entity '${name}' is declared both on column '${(entities[name].key || []).map((p) => p.column).join(', ')}' (meta.mcp.entity) and in meta.mcp.entities. Declare it in ONE place — meta.mcp.entities is the form that can carry a composite key or variants.`);
          }
          const peName = primaryEntityName(m);
          if (peName === name) {
            throw new Error(`model '${model.name}': '${name}' is already the model's PRIMARY entity, so it cannot also be declared in meta.mcp.entities — the semantic model would carry two entities of that name. Drop the duplicate, or give this key its own relationship name.`);
          }
          entities[name] = ent;
        }
      }
    }
    if (Object.keys(entities).length) m.entities = entities;
    if (Object.keys(dimensions).length) m.dimensions = dimensions;
    if (Object.keys(columnDescriptions).length) m.column_descriptions = columnDescriptions;
    // The role IS the source's identity, so two models cannot share one: the second used to
    // silently REPLACE the first, and everything downstream — the tool enums, the value index,
    // every join path — then described a table nobody meant. Several events sources are fine;
    // each carries its own role name.
    if (out.models[key]) {
      throw new Error(`catalog models '${out.models[key].dbt_model}' and '${model.name}' both declare meta.mcp.role: '${key}' — the role is the source's IDENTITY, so exactly one model may carry it. Give one of them its own role name (several sources of the same kind are fine: events, crashlytics, …).`);
    }
    out.models[key] = m;
  }
  if (!(out.facts || []).length) throw new Error('no events source: at least one model must declare an event_name (meta.mcp.is_event_name) or event_data (meta.mcp.is_event_data) column');

  // Every fact needs the two columns the event machinery is built on.
  for (const key of out.facts || []) {
    const m = out.models[key];
    if (!m.event_name) throw new Error(`fact model '${key}' declares no event_name column: add meta.mcp.is_event_name to the column carrying the event type.`);
    if (!m.time) throw new Error(`fact model '${key}' declares no time column: add meta.mcp.is_time to the column carrying the event time.`);
  }

  // One NAME per source: a payload property and a groupable column of the same source live in the
  // same (source, property) space — it is how the value index files values, how semantic_index
  // addresses a field and how a filter literal is verified. A name carried by both is a field
  // nobody can address: the index writes one over the other and the views describe one while
  // reporting the other's numbers. Refused here, where it is a one-line rename.
  for (const key of Object.keys(out.models)) {
    const m = out.models[key];
    const clash = Object.keys(m.properties || {}).filter((name) => (m.dimensions || {})[name]);
    if (clash.length) {
      throw new Error(`model '${m.dbt_model}' (role '${key}') carries ${clash.map((n) => `'${n}'`).join(', ')} BOTH as an event_data property and as a groupable column — one source addresses a field by ONE name, so these cannot coexist. Rename the payload entry, or give it its own name with an explicit column: mapping.`);
    }
  }

  // A PRIMARY entity must be owned by exactly ONE model: it is both the MetricFlow
  // identity of the semantic model and the join TARGET for that entity, so a second
  // claimant would silently hijack the join (e.g. a new fact stealing `user` from the
  // users dimension) and MetricFlow would reject the duplicate identity anyway.
  // THE entity -> owning model map, built once here from the primary entities and extended below
  // with the `unique` ones (after variant expansion, so an expanded name is checked too).
  const ownerOf = new Map();
  for (const [key, m] of Object.entries(out.models)) {
    // A primary entity with a key or without one makes the model the owner alike.
    const pe = primaryEntityName(m);
    if (!pe) continue;
    if (ownerOf.has(pe)) {
      throw new Error(`models '${ownerOf.get(pe)}' and '${key}' both declare primary entity '${pe}'. A primary entity has exactly one owner (it is the join target for that entity) — give each model its own meta.mcp.primary_entity, e.g. 'event' for the analytics fact and 'crash' for a crash fact.`);
    }
    ownerOf.set(pe, key);
  }
  // EXPAND KEY VARIANTS. A relationship may be carried by several alternative key columns on one
  // side (a crash row reporting one tracking id per ad format). Each variant becomes its own
  // '<relationship>_<variant>' key so the caller can pick which one to join on. A side that
  // declares a PLAIN key for the same relationship mirrors it to every variant — the install
  // record has one tracking column and it is the counterpart of all of them.
  {
    const variantsOf = new Map(); // relationship -> Set(variant name)
    for (const m of Object.values(out.models)) {
      for (const [rel, e] of Object.entries(m.entities || {})) {
        for (const v of Object.keys(e.variants || {})) {
          if (!variantsOf.has(rel)) variantsOf.set(rel, new Set());
          variantsOf.get(rel).add(v);
        }
      }
    }
    for (const m of Object.values(out.models)) {
      for (const [rel, e] of Object.entries({ ...(m.entities || {}) })) {
        const vs = variantsOf.get(rel);
        if (!vs) continue;
        for (const v of vs) {
          const name = `${rel}_${v}`;
          if (m.entities[name]) continue; // an explicit declaration wins over the expansion
          const parts = e.variants?.[v] || e.key;
          if (!parts) continue; // this side carries neither that variant nor a plain key
          m.entities[name] = { type: e.type, key: parts, variant_of: rel };
        }
        // A side declared ONLY as variants has no canonical key of its own.
        if (!e.key) delete m.entities[rel];
        else delete m.entities[rel].variants;
      }
    }
  }

  // A join key is only a join if BOTH sides agree on it: exactly one owner (primary or unique),
  // and every side of the same entity built from the same NUMBER of key parts — two sides with
  // different arity would compare a one-part key against a two-part one and silently match
  // nothing. Checked at load so a mistyped key fails here, not as an empty result set.
  for (const [key, m] of Object.entries(out.models)) {
    for (const [name, e] of Object.entries(m.entities || {})) {
      if (e.type !== 'unique') continue;
      if (ownerOf.has(name) && ownerOf.get(name) !== key) {
        throw new Error(`models '${ownerOf.get(name)}' and '${key}' both OWN entity '${name}' (as primary/unique). An entity has exactly one join target — make one of them type: foreign.`);
      }
      ownerOf.set(name, key);
    }
  }
  // The SHAPE of a key is its parts in order, each with the grain it is compared at. Both the
  // number of parts and the grain of each must agree across the sides: a grain declared on one
  // side only truncates that side, so a day-truncated value is compared against a raw timestamp
  // and the join matches (almost) nothing — silently, with a plausible-looking query.
  const shapeOf = new Map();
  const grainsOf = (parts) => parts.map((p) => p.grain || '-');
  for (const [key, m] of Object.entries(out.models)) {
    const all = [];
    const pe = m.primary_entity;
    if (pe?.key) all.push([pe.name, pe.key]);
    // variants are already expanded into their own '<relationship>_<variant>' entities above, each
    // with its own key — so every side of every relationship is in this list exactly once.
    for (const [name, e] of Object.entries(m.entities || {})) if (e.key) all.push([name, e.key]);
    for (const [name, parts] of all) {
      const prev = shapeOf.get(name);
      if (prev && prev.n !== parts.length) {
        throw new Error(`entity '${name}' is declared with ${prev.n} key part(s) on '${prev.model}' but ${parts.length} on '${key}'. Both sides of a join must be built from the same number of parts, in the same order.`);
      }
      const grains = grainsOf(parts);
      if (prev && String(prev.grains) !== String(grains)) {
        const show = (g) => g.map((x, i) => `part ${i + 1}: ${x === '-' ? 'no grain' : x}`).join(', ');
        throw new Error(`entity '${name}' is joined at a different grain on each side: ${show(prev.grains)} on '${prev.model}', but ${show(grains)} on '${key}'. A grain truncates the side that declares it, so declaring it on one side only compares a truncated value against a raw one and matches nothing — declare the same grain on both sides.`);
      }
      if (!prev) shapeOf.set(name, { n: parts.length, grains, model: key });
    }
  }

  // `natural` IS NOT DECLARED — it is derived. The renderer emits it for the primary key of a
  // model that has a validity window, because that is the only place MetricFlow accepts one
  // ("The use of `natural` entities is currently supported only in conjunction with a validity
  // window", dbt_semantic_interfaces/validations/entities.py). Declared by hand it passes
  // straight into the manifest and dbt fails with that sentence, about a window the author never
  // mentioned. Refuse it here, where the fix can be named.
  for (const [key, m] of Object.entries(out.models)) {
    const nat = Object.entries(m.entities || {}).filter(([, e]) => e.type === 'natural').map(([n]) => n);
    if (nat.length) {
      throw new Error(`model '${key}' declares entit${nat.length === 1 ? 'y' : 'ies'} ${nat.map((n) => `'${n}'`).join(', ')} as type: natural. That type is not declared by hand — it is what a model with a VALIDITY WINDOW gets automatically for its own key: mark the window columns meta.mcp.dimension.validity (start/end) and make the key the model's meta.mcp.primary_entity. For an ordinary join key use 'unique' (this model owns it) or 'foreign' (it points at the owner).`);
    }
  }

  // A VALIDITY WINDOW belongs to a dimension, never to an events source. An events source is one
  // row per event: there is no version of a row to be valid between two instants, MetricFlow
  // forbids measures on a model with validity params (and an events source exists to carry
  // measures), and the fact renderer has no window to apply — so a window declared here would be
  // silently ignored, which is the one outcome worse than an error.
  for (const key of out.facts || []) {
    const m = out.models[key];
    if (!m?.scd) continue;
    // The time axis of a fact is a dimension too, so both marks are found here; a mark on a
    // column that is not a dimension at all cannot reach this code (scd is set from one).
    const cols = Object.entries(m.dimensions || {}).filter(([, d]) => d.validity).map(([n, d]) => `${n} (${d.validity})`);
    throw new Error(`events source '${key}' declares a validity window (meta.mcp.dimension.validity on ${cols.map((n) => `'${n}'`).join(', ')}). A window describes VERSIONS of a row, so it belongs to a dimension model (one row per key per period), not to a source with one row per event. Move the window to the dimension this source joins to, or drop the validity marks and keep the columns as ordinary time dimensions.`);
  }

  // A SLOWLY-CHANGING model (validity window) may expose only ONE join key, and only as its
  // natural key: MetricFlow rejects a manifest where a model with validity params also carries a
  // `primary` or `unique` entity ("we do not currently process joins against these key types for
  // semantic models with validity windows"). Catch it here, where we can say what to do, instead
  // of letting `dbt parse` fail with that sentence and no context.
  for (const [key, m] of Object.entries(out.models)) {
    if (!m.scd) continue;
    const extra = Object.entries(m.entities || {}).filter(([, e]) => e.type === 'primary' || e.type === 'unique').map(([n]) => n);
    if (extra.length) {
      throw new Error(`model '${key}' declares a validity window (meta.mcp.dimension.validity) and also owns join key(s) ${extra.map((n) => `'${n}'`).join(', ')} as primary/unique. A slowly-changing model can only be joined on its natural key, so MetricFlow rejects the others — declare them 'foreign' (they stay usable as a pipeline join) or drop them.`);
    }
  }

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

/**
 * A primary entity in its one shape, { name, key? }: a schema may write it as a bare name
 * (meta.mcp.primary_entity: event — the events-source form, whose key is the model's own identity)
 * or name the key column (meta.mcp.entity: { type: primary }), which adds `key`.
 */
export function asPrimaryEntity(pe) {
  if (pe == null) return null;
  return typeof pe === 'string' ? { name: pe } : pe;
}

/** Logical name of a model's primary entity. */
export function primaryEntityName(model) {
  return asPrimaryEntity(model.primary_entity)?.name ?? null;
}
