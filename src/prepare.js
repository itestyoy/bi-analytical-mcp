// Declarative data-prep pipeline for register_native_model.
//
// `prepare` is an ORDERED list of stages; each stage transforms the previous
// relation into a new one (emitted as a chained CTE prep_0, prep_1, …). This is
// a constructor/"Lego": to add a new transform you register ONE entry in STAGES
// with { schema, build } — the schema (for the tool) and the SQL contribution are
// derived from the registry, nothing else changes. Stages compose: each can
// reference columns added by earlier stages.
//
// A stage's build({ prev, alias, dialect, catalog, jsonCol }, params) returns:
//   { select: '<full SELECT over `prev`>', columns: { name: { type } } }
// where `columns` are the NEW scalar columns the stage exposes downstream
// (usable in sequence step `where`, agg_at_step, etc.).

import { jsonArrayLength, jsonArrayContains, jsonStructField, jsonArrayUnnest } from './dialect.js';

const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

// ── Stage registry ───────────────────────────────────────────────────────────
const STAGES = {
  // derive a scalar column from an array/struct event_data property.
  derive: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'name', 'source', 'op'],
      description: 'Derive a scalar column from a complex (array/struct) event_data property.',
      properties: {
        stage: { const: 'derive' },
        name: { type: 'string', pattern: NAME_RE.source, description: 'New column name (referenceable in steps/metrics).' },
        source: { type: 'string', enum: catalog.complexEventProps(), description: 'Array/struct event_data property to derive from.' },
        op: { enum: ['array_length', 'contains', 'struct_field'], description: 'array_length -> element count (int); contains -> membership boolean (needs value); struct_field -> a field of a struct property (needs field).' },
        value: { description: 'Membership value for op=contains.' },
        field: { type: 'string', description: 'Struct field name for op=struct_field.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Result type for op=struct_field (default string).' },
      },
    }),
    build: ({ prev, alias, dialect, jsonCol }, p) => {
      let expr; let type;
      if (p.op === 'array_length') { expr = jsonArrayLength(dialect, jsonCol, p.source); type = 'int'; }
      else if (p.op === 'contains') { expr = jsonArrayContains(dialect, jsonCol, p.source, p.value); type = 'boolean'; }
      else if (p.op === 'struct_field') { expr = jsonStructField(dialect, jsonCol, p.source, p.field, p.type); type = p.type || 'string'; }
      else throw new Error(`derive: unsupported op '${p.op}'`);
      return { select: `SELECT ${alias}.*, (${expr}) AS ${p.name} FROM ${prev} ${alias}`, columns: { [p.name]: { type } } };
    },
  },

  // explode an array property into one row per element (changes grain).
  unnest: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'source', 'as'],
      description: 'Explode a JSON array property into one row per element (changes grain; rows without the array drop out). For array-of-struct, bind a struct `field`.',
      properties: {
        stage: { const: 'unnest' },
        source: { type: 'string', enum: catalog.complexEventProps(), description: 'Array (or array-of-struct) event_data property to explode.' },
        as: { type: 'string', pattern: NAME_RE.source, description: 'Column the element (or struct field) is bound to.' },
        field: { type: 'string', description: 'For array-of-struct: the struct field to bind.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Bound element/field type (default string).' },
      },
    }),
    build: ({ prev, alias, dialect, catalog }, p) => {
      const { join, element } = jsonArrayUnnest(dialect, alias, catalog.eventDataColumn(), p.source, p.as, p.field, p.type);
      return { select: `SELECT ${alias}.*, ${element} AS ${p.as} FROM ${prev} ${alias} ${join}`, columns: { [p.as]: { type: p.type || 'string' } } };
    },
  },
};

export function prepareStageSchema(catalog) {
  return { oneOf: Object.values(STAGES).map((s) => s.schema(catalog)) };
}

/**
 * Render the prep pipeline. Returns the chained CTEs, the final prepared
 * relation name (or the base relation when there are no stages), and the map of
 * scalar columns the pipeline exposes downstream.
 */
export function renderPrepare(catalog, spec, dialect, baseRelation) {
  const stages = spec.prepare || [];
  const columns = new Map();
  if (!stages.length) return { ctes: [], relation: baseRelation, columns };
  const alias = 'p';
  const jsonCol = `${alias}.${catalog.eventDataColumn()}`;
  let prev = baseRelation;
  const ctes = [];
  stages.forEach((st, i) => {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown prepare stage: ${st.stage}`);
    const name = `prep_${i}`;
    const { select, columns: added } = def.build({ prev, alias, dialect, catalog, jsonCol }, st);
    ctes.push({ name, sql: select });
    for (const [k, v] of Object.entries(added || {})) {
      if (!NAME_RE.test(k)) throw new Error(`invalid prepare column name: ${k}`);
      columns.set(k, v);
    }
    prev = name;
  });
  return { ctes, relation: prev, columns };
}
