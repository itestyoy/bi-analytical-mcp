// Unified, pipe-syntax-shaped transformation pipeline.
//
// A pipeline is `source` + an ordered list of STAGES; each stage transforms the
// table produced by the previous one (BigQuery pipe semantics). Each stage is a
// registry entry { schema, build } — adding a stage changes nothing else. The
// stage `build` is dialect-agnostic: it emits a logical op (IR) and updates the
// tracked column set. The Dialect (src/dialects/*) lowers the op list to SQL —
// Postgres to a chained CTE, BigQuery to native `|>` pipe operators.
//
// Safety: stage params are catalog-enum / typed; column references are validated
// against the live column set threaded through the pipeline; identifiers pass the
// dialect guard; values are bound via sqlLiteral. No raw SQL is ever accepted.

import { getDialect } from './dialects/index.js';

const NAME = '^[a-z][a-z0-9_]{0,40}$';
const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const CMP = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'];
const AGG_FNS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'];

function cmp(d, lhs, op, value) {
  const arr = Array.isArray(value) ? value : [value];
  switch (op) {
    case 'eq': return `${lhs} = ${d.sqlLiteral(value)}`;
    case 'neq': return `${lhs} != ${d.sqlLiteral(value)}`;
    case 'gt': return `${lhs} > ${d.sqlLiteral(value)}`;
    case 'gte': return `${lhs} >= ${d.sqlLiteral(value)}`;
    case 'lt': return `${lhs} < ${d.sqlLiteral(value)}`;
    case 'lte': return `${lhs} <= ${d.sqlLiteral(value)}`;
    case 'in': return `${lhs} IN (${arr.map((v) => d.sqlLiteral(v)).join(', ')})`;
    case 'not_in': return `${lhs} NOT IN (${arr.map((v) => d.sqlLiteral(v)).join(', ')})`;
    default: throw new Error(`unsupported comparison op: ${op}`);
  }
}

function aggExpr(d, fn, column) {
  if (fn === 'count' && !column) return 'count(*)';
  const c = d.ident(column);
  return fn === 'count_distinct' ? `count(distinct ${c})` : `${fn}(${c})`;
}

// ── Stage registry ───────────────────────────────────────────────────────────
const STAGES = {
  where: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'conditions'],
      description: 'Row filter: keep rows matching the conditions (ANDed).',
      properties: {
        stage: { const: 'where' },
        conditions: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string', description: 'Column to test.' }, op: { enum: CMP }, value: {} } } },
      },
    }),
    build: ({ d, cols }, p) => {
      const preds = p.conditions.map((c) => { requireCol(cols, c.column); return cmp(d, d.ident(c.column), c.op, c.value); });
      return { op: { op: 'where', preds }, cols };
    },
  },

  derive: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'name', 'op'],
      description: 'Add a scalar column from an event_data property (scalar extract, or array/struct ops).',
      properties: {
        stage: { const: 'derive' },
        name: { type: 'string', pattern: NAME },
        op: { enum: ['extract', 'array_length', 'contains', 'struct_field'] },
        source: { type: 'string', enum: catalog.eventProps(), description: 'event_data property the value derives from.' },
        value: { description: 'Membership value for op=contains.' },
        field: { type: 'string', description: 'Struct field for op=struct_field.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Result/extract type (default string).' },
      },
    }),
    build: ({ d, catalog, cols }, p) => {
      const json = catalog.eventDataColumn();
      let expr; let type;
      if (p.op === 'extract') { expr = d.jsonExtract(json, p.source, p.type || 'string'); type = p.type || 'string'; }
      else if (p.op === 'array_length') { expr = d.jsonArrayLength(json, p.source); type = 'int'; }
      else if (p.op === 'contains') { expr = d.jsonArrayContains(json, p.source, p.value); type = 'boolean'; }
      else if (p.op === 'struct_field') { expr = d.jsonStructField(json, p.source, p.field, p.type); type = p.type || 'string'; }
      else throw new Error(`derive: bad op ${p.op}`);
      return { op: { op: 'extend', cols: [{ name: p.name, expr }] }, cols: addCol(cols, p.name, type) };
    },
  },

  unnest: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'source', 'as'],
      description: 'Explode a JSON array property into one row per element (changes grain).',
      properties: {
        stage: { const: 'unnest' },
        source: { type: 'string', enum: catalog.complexEventProps() },
        as: { type: 'string', pattern: NAME },
        field: { type: 'string', description: 'For array-of-struct: the struct field to bind.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'] },
      },
    }),
    build: ({ catalog, cols }, p) => ({ op: { op: 'unnest', column: catalog.eventDataColumn(), key: p.source, as: p.as, field: p.field, type: p.type }, cols: addCol(cols, p.as, p.type || 'string') }),
  },

  join: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'with', 'on'],
      description: 'Join another catalog model on a shared entity key (1-hop), exposing its attributes.',
      properties: {
        stage: { const: 'join' },
        with: { type: 'string', enum: catalog.joinableModelKeys(), description: 'Catalog model to join.' },
        on: { type: 'string', description: 'Shared entity key column (present on both sides).' },
        attrs: { type: 'array', items: { type: 'string' }, description: 'Columns of the joined model to expose (default: all its dimensions).' },
        kind: { enum: ['left', 'inner'], default: 'left' },
      },
    }),
    build: ({ catalog, cols }, p) => {
      const m = catalog.getModel(p.with);
      const attrs = p.attrs?.length ? p.attrs : Object.keys(m.dimensions || {});
      const relation = `{{ ref('${m.dbt_model}') }}`;
      let out = cols;
      for (const a of attrs) out = addCol(out, a, 'string');
      return { op: { op: 'join', relation, alias: 'j', on: [p.on], attrs, kind: (p.kind || 'left').toUpperCase() }, cols: out };
    },
  },

  aggregate: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'measures'],
      description: 'Group rows and compute aggregate measures (collapses grain to the group keys).',
      properties: {
        stage: { const: 'aggregate' },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Grouping columns (empty = grand total).' },
        measures: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'fn'], properties: { name: { type: 'string', pattern: NAME }, fn: { enum: AGG_FNS }, column: { type: 'string' } } } },
      },
    }),
    build: ({ d, cols }, p) => {
      const groupBy = p.group_by || [];
      for (const g of groupBy) requireCol(cols, g);
      const aggs = p.measures.map((m) => { if (m.column) requireCol(cols, m.column); return { as: m.name, expr: aggExpr(d, m.fn, m.column) }; });
      let out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const m of p.measures) out.set(m.name, { type: 'numeric' });
      return { op: { op: 'aggregate', groupBy, aggs }, cols: out };
    },
  },

  pivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'on', 'fn', 'value_column', 'values'],
      description: 'Pivot: turn distinct values of `on` into columns, each aggregating `value_column`. Values must be listed (no dynamic pivot).',
      properties: {
        stage: { const: 'pivot' },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Row keys kept (empty = one row).' },
        on: { type: 'string', description: 'Column whose values become columns.' },
        fn: { enum: ['sum', 'avg', 'min', 'max', 'count'] },
        value_column: { type: 'string', description: 'Column aggregated into each pivoted column.' },
        values: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[A-Za-z0-9_]+$' }, description: 'The values of `on` to pivot into columns.' },
      },
    }),
    build: ({ cols }, p) => {
      const groupBy = p.group_by || [];
      [...groupBy, p.on, p.value_column].forEach((c) => requireCol(cols, c));
      let out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const v of p.values) out.set(v, { type: 'numeric' });
      return { op: { op: 'pivot', groupBy, on: p.on, fn: p.fn, valueCol: p.value_column, values: p.values }, cols: out };
    },
  },

  unpivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'columns', 'name_as', 'value_as'],
      description: 'Unpivot: turn the listed columns into rows of (name_as, value_as), keeping the rest.',
      properties: {
        stage: { const: 'unpivot' },
        columns: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Columns to fold into rows.' },
        keep: { type: 'array', items: { type: 'string' }, description: 'Columns to keep as-is (default: none).' },
        name_as: { type: 'string', pattern: NAME },
        value_as: { type: 'string', pattern: NAME },
      },
    }),
    build: ({ cols }, p) => {
      const keep = p.keep || [];
      [...keep, ...p.columns].forEach((c) => requireCol(cols, c));
      let out = new Map();
      for (const k of keep) out.set(k, cols.get(k) || { type: 'string' });
      out.set(p.name_as, { type: 'string' });
      out.set(p.value_as, { type: 'numeric' });
      return { op: { op: 'unpivot', keep, columns: p.columns, nameAs: p.name_as, valueAs: p.value_as }, cols: out };
    },
  },

  order_by: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'keys'],
      description: 'Sort rows.',
      properties: { stage: { const: 'order_by' }, keys: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } } } },
    }),
    build: ({ cols }, p) => { p.keys.forEach((k) => requireCol(cols, k.key)); return { op: { op: 'order_by', keys: p.keys.map((k) => ({ key: k.key, dir: k.direction })) }, cols }; },
  },

  limit: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'n'], description: 'Cap rows.', properties: { stage: { const: 'limit' }, n: { type: 'integer', minimum: 1, maximum: 1000000 } } }),
    build: ({ cols }, p) => ({ op: { op: 'limit', n: p.n }, cols }),
  },

  project: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'columns'], description: 'Keep only these columns.', properties: { stage: { const: 'project' }, columns: { type: 'array', minItems: 1, items: { type: 'string' } } } }),
    build: ({ cols }, p) => { p.columns.forEach((c) => requireCol(cols, c)); const out = new Map(); for (const c of p.columns) out.set(c, cols.get(c) || { type: 'string' }); return { op: { op: 'project', cols: p.columns }, cols: out }; },
  },
};

function addCol(cols, name, type) {
  if (!NAME_RE.test(name)) throw new Error(`invalid column name: ${name}`);
  const out = new Map(cols);
  out.set(name, { type });
  return out;
}
function requireCol(cols, name) {
  if (!cols.has(name)) throw new Error(`pipeline: unknown column '${name}' at this stage (available: ${[...cols.keys()].join(', ')})`);
}

/** Register an additional stage from another module (e.g. match_recognize). */
export function registerStage(name, def) { STAGES[name] = def; }

/** JSON-Schema oneOf for a named subset of stages (e.g. the funnel `prepare` field). */
export function stageSchemas(catalog, names) {
  return { oneOf: names.map((n) => { if (!STAGES[n]) throw new Error(`no such stage: ${n}`); return STAGES[n].schema(catalog); }) };
}

/** Initial columns available from a catalog source model. */
function sourceColumns(catalog, key) {
  const m = catalog.getModel(key);
  const cols = new Map();
  if (key === catalog.anchor) {
    if (m.event_name?.column) cols.set(m.event_name.column, { type: 'string' });
    if (m.time?.column) cols.set(m.time.column, { type: 'time' });
    if (m.event_data_column) cols.set(m.event_data_column, { type: 'json' });
    for (const e of Object.values(m.entities || {})) if (e.column) cols.set(e.column, { type: 'string' });
  } else {
    if (typeof m.primary_entity === 'object' && m.primary_entity.column) cols.set(m.primary_entity.column, { type: 'string' });
    for (const [name, dd] of Object.entries(m.dimensions || {})) cols.set(name, { type: dd.type });
  }
  return cols;
}

/** Starting columns for the events anchor (so prepare/funnel pipelines run over it). */
export function anchorColumns(catalog) { return sourceColumns(catalog, catalog.anchor); }

/** The scalar columns a `prepare` stage list adds (name -> { type }) — threads prep columns. */
export function prepareColumns(catalog, dialectName, stages = []) {
  const d = getDialect(dialectName);
  let cols = new Map();
  for (const st of stages) {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown prepare stage: ${st.stage}`);
    cols = def.build({ d, catalog, cols }, st).cols;
  }
  return cols;
}

export function pipelineStageSchema(catalog) {
  return { oneOf: Object.values(STAGES).map((s) => s.schema(catalog)) };
}

/**
 * Lower a pipeline over an explicit base relation to one SQL text (chained-CTE
 * form), honoring a terminal stage (e.g. match_recognize) that contributes its
 * own CTEs + final SELECT. Used by the funnel: [...prepare, match_recognize].
 */
export function renderPipelineSql(catalog, dialectName, baseRelation, baseColumns, stages) {
  const d = getDialect(dialectName);
  let cols = new Map(baseColumns);
  const ops = [];
  for (const st of stages) {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown pipeline stage: ${st.stage}`);
    const res = def.build({ d, catalog, cols }, st);
    ops.push(res.op);
    cols = res.cols;
  }
  let prev = baseRelation;
  const ctes = [];
  let finalSelect = null;
  for (const op of ops) {
    if (op.terminal) {
      const tail = op.renderTail(prev, dialectName);
      for (const c of tail.ctes) ctes.push(c);
      finalSelect = tail.finalSelect;
      break; // a terminal stage must be last
    }
    const name = `p${ctes.length}`;
    ctes.push({ name, sql: d.stepCte(prev, op) });
    prev = name;
  }
  if (finalSelect === null) finalSelect = `SELECT * FROM ${prev}`;
  const head = ctes.length ? `WITH ${ctes.map((c) => `${c.name} AS (\n  ${c.sql}\n)`).join(',\n')}\n` : '';
  return head + finalSelect;
}

/**
 * Render a full pipeline to SQL for `dialectName` (dialect-native form: Postgres
 * chained CTE, BigQuery pipe syntax).
 * @returns { sql, columns } — columns is the final tracked column set (Map).
 */
export function renderPipeline(catalog, dialectName, source, stages = []) {
  const d = getDialect(dialectName);
  const m = catalog.getModel(source);
  const baseRelation = `{{ ref('${m.dbt_model}') }}`;
  let cols = sourceColumns(catalog, source);
  const ops = [];
  for (const st of stages) {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown pipeline stage: ${st.stage}`);
    const res = def.build({ d, catalog, cols }, st);
    ops.push(res.op);
    cols = res.cols;
  }
  return { sql: d.renderPipeline(baseRelation, ops), columns: cols };
}
