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
//
// ─── STAGE CATALOG (what each stage does + what it solves) ───────────────────
// Modeled on BigQuery pipe syntax (FROM t |> WHERE … |> EXTEND … |> AGGREGATE …).
// See: https://medium.com/google-cloud/bigquery-pipe-syntax-by-example-blasetta-0f3df50ba331
//
//   where      |> WHERE      filter rows by column conditions.
//                            Solves: scope to an event / segment / time window.
//   derive     |> EXTEND     add ONE scalar column FROM an event_data JSON property
//                            (extract a scalar; array_length / contains / struct_field
//                            for complex props). Solves: surface a payload field as a column.
//   compute    |> EXTEND     add ONE column FROM existing columns + literals:
//                            const (literal number/string/bool), arithmetic (+ - * /),
//                            round/floor/ceil/abs, coalesce/least/greatest, cast,
//                            STRING fns (concat/upper/lower/length/substring/trim/replace),
//                            date_diff / date_trunc / date_part, elapsed_days (whole 24h days
//                            between two timestamps — the RETENTION-DAY primitive, not calendar
//                            days; handles cast/negatives/NULLs for you), CASE (bucketing), and
//                            WINDOW functions (row_number / rank / lag / lead / running &
//                            ROLLING sum via a ROWS/RANGE frame), and unix_date (day number
//                            for value-based RANGE windows). Solves: constant tags/labels,
//                            KPIs (ARPU parts), string keys, tiers/buckets, days-since-install
//                            & retention day, period-over-period (lag), nth-event /
//                            repeat-purchase (row_number), rolling N-day metrics (RANGE frame).
//   unnest     |> JOIN UNNEST  explode a JSON array into one row per element.
//                            Solves: per-element frequency (items collected, rewards).
//   join       |> JOIN       1-hop join to another catalog model on a shared entity.
//                            Solves: bring user attributes (country/platform/install_date).
//   aggregate  |> AGGREGATE  group + measures: sum/avg/min/max/count/count_distinct,
//                            approx_count_distinct (HLL++), stddev/variance/median/
//                            percentile(q). Solves: totals, rates, distributions,
//                            DAU/MAU (count_distinct), fast approximate uniques, revenue, ARPU.
//   pivot      |> PIVOT      turn listed values of a column into columns.
//                            Solves: dashboard-ready matrices (revenue per country column).
//   unpivot    |> UNPIVOT    fold listed columns into (name, value) rows. Solves: tidy/long
//                            format for charting; cohort/retention grids → rows.
//   sample     |> TABLESAMPLE  keep ~N% of rows for a FAST approximate first estimate
//                            on large data (BigQuery TABLESAMPLE SYSTEM; Postgres random()).
//   order_by   |> ORDER BY   sort. limit |> LIMIT cap. project |> SELECT keep a column set.
//   match_recognize |> MATCH_RECOGNIZE  (registered by match-recognize.js) row-pattern
//                            funnel; TERMINAL stage → one row per user/session match.
//                            Solves: ordered multi-step funnels, conversion, time-between-steps.

import { getDialect } from './dialects/index.js';

const NAME = '^[a-z][a-z0-9_]{0,40}$';
const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const CMP = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null', 'like', 'not_like', 'contains', 'starts_with', 'ends_with'];
const AGG_FNS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median', 'percentile', 'hll_init', 'hll_merge', 'hll_merge_partial'];
const SKETCH_FNS = new Set(['hll_init', 'hll_merge_partial']); // produce a sketch column
const STAT_FNS = new Set(['stddev', 'variance', 'median', 'percentile']);

// A scalar operand: exactly one of a column reference, a literal value, or the
// `now` token (current timestamp). Shared by `where`, `compute`, and `case`.
const OPERAND = { type: 'object', additionalProperties: false, properties: { column: { type: 'string' }, value: {}, now: { type: 'boolean' } }, description: 'One of: { column }, { value }, or { now: true }.' };

// One comparison, used identically by `where` and `case` branches. Either side is
// a column / constant / now: shorthand `{column, op, value}` (column vs constant)
// or `{left, op, right}` (column-vs-column, constant-vs-column, …). in/not_in take
// an array via `value` or `right.value`.
const CONDITION = {
  type: 'object', additionalProperties: false, required: ['op'],
  anyOf: [{ required: ['column'] }, { required: ['left'] }], // a left side is mandatory
  description: 'A comparison: left = `column` (shorthand) or `left` operand; right = `value` constant (shorthand; array for in/not_in; [low,high] for between) or `right` operand. is_null/is_not_null take no right side.',
  properties: { column: { type: 'string' }, value: {}, left: OPERAND, right: OPERAND, op: { enum: CMP } },
};

const OPSYM = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

// A string constrained to event-property `values`, but never an empty enum (ajv
// rejects `enum: []` at compile time). When the catalog has no such properties
// (e.g. a fully flattened payload with no array/struct fields) the field stays an
// open string — there is nothing valid to pick anyway.
const propEnum = (values, description) => (values.length ? { type: 'string', enum: values, description } : { type: 'string', description });

/** An event property as seen from the pipeline's SOURCE fact (Catalog.propertyFor owns the
 *  bare-vs-qualified rules); a property of another fact is rejected with the fix. */
const sourceProp = (catalog, source, name) => (source
  ? catalog.propertyFor(source, name, { hint: 'start the pipeline from the source that owns it' }) // the message names the owner
  : null);

// SQL for one operand: a column reference, a literal constant, or `now`.
function operandSql(d, cols, o, label = 'operand') {
  if (o === null || typeof o !== 'object') throw new Error(`${label}: must be { column } | { value } | { now: true }`);
  if (o.now) return d.nowExpr();
  if (o.column !== undefined) { requireCol(cols, o.column); return d.ident(o.column); }
  if (o.value !== undefined) return d.sqlLiteral(o.value);
  throw new Error(`${label}: needs column | value | now`);
}

// One comparison. Each side may be a column, a constant (value), or now:
//   { column, op, value }        — column vs constant (shorthand)
//   { left:{...}, op, right:{...} } — operands on both sides (column vs column,
//                                     constant vs column, etc.)
function condPred(d, cols, c) {
  let lhs;
  if (c.left !== undefined) lhs = operandSql(d, cols, c.left, 'left');
  else if (c.column !== undefined) { requireCol(cols, c.column); lhs = d.ident(c.column); }
  else throw new Error('condition needs `column` or `left`');
  if (c.op === 'is_null') return `${lhs} IS NULL`;
  if (c.op === 'is_not_null') return `${lhs} IS NOT NULL`;
  if (c.op === 'in' || c.op === 'not_in') {
    const arr = c.right?.value ?? c.value;
    if (!Array.isArray(arr)) throw new Error(`${c.op} needs an array value`);
    return `${lhs} ${c.op === 'in' ? 'IN' : 'NOT IN'} (${arr.map((v) => d.sqlLiteral(v)).join(', ')})`;
  }
  if (c.op === 'between') {
    const arr = c.right?.value ?? c.value;
    if (!Array.isArray(arr) || arr.length !== 2) throw new Error('between needs [low, high]');
    return `${lhs} BETWEEN ${d.sqlLiteral(arr[0])} AND ${d.sqlLiteral(arr[1])}`;
  }
  if (['like', 'not_like', 'contains', 'starts_with', 'ends_with'].includes(c.op)) {
    const v = c.right?.value ?? c.value;
    if (typeof v !== 'string') throw new Error(`${c.op} needs a string value`);
    const pat = c.op === 'like' || c.op === 'not_like' ? v : c.op === 'contains' ? `%${v}%` : c.op === 'starts_with' ? `${v}%` : `%${v}`;
    return `${lhs} ${c.op === 'not_like' ? 'NOT LIKE' : 'LIKE'} ${d.sqlLiteral(pat)}`;
  }
  if (!OPSYM[c.op]) throw new Error(`unsupported comparison op: ${c.op}`);
  let rhs;
  if (c.right !== undefined) rhs = operandSql(d, cols, c.right, 'right');
  else if (c.value !== undefined) rhs = d.sqlLiteral(c.value);
  else throw new Error('condition needs `value` or `right`');
  return `${lhs} ${OPSYM[c.op]} ${rhs}`;
}

// Window frame clause, e.g. ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW, or
// RANGE BETWEEN 10 PRECEDING AND CURRENT ROW (value offsets on the order key).
function frameClause(f) {
  if (!f) return '';
  const mode = f.mode === 'range' ? 'RANGE' : 'ROWS';
  const bound = (v, dir) => {
    if (v === 'unbounded') return `UNBOUNDED ${dir}`;
    if (v === undefined || v === null || Number(v) === 0) return 'CURRENT ROW';
    if (!Number.isInteger(Number(v)) || Number(v) < 0) throw new Error(`window frame: bad ${dir.toLowerCase()} offset ${v}`);
    return `${Number(v)} ${dir}`;
  };
  const start = bound(f.preceding ?? 'unbounded', 'PRECEDING');
  const end = f.following === undefined ? 'CURRENT ROW' : bound(f.following, 'FOLLOWING');
  return ` ${mode} BETWEEN ${start} AND ${end}`;
}

function aggExpr(d, fn, column, q) {
  if (fn === 'count' && !column) return 'count(*)';
  const c = d.ident(column);
  if (fn === 'count_distinct') return `count(distinct ${c})`;
  if (fn === 'approx_count_distinct') return d.approxCountDistinct(c);
  if (fn === 'hll_init') return d.hllInit(c);
  if (fn === 'hll_merge') return d.hllMerge(c);
  if (fn === 'hll_merge_partial') return d.hllMergePartial(c);
  if (STAT_FNS.has(fn)) {
    if (fn === 'percentile' && !(typeof q === 'number' && q > 0 && q < 1)) throw new Error("percentile requires q in (0,1)");
    return d.statAggExpr(fn, c, q);
  }
  return `${fn}(${c})`; // sum / avg / min / max
}

// ── Stage registry ───────────────────────────────────────────────────────────
const STAGES = {
  where: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'conditions'],
      description: 'Keep only rows where all conditions hold (ANDed). Each condition compares two operands — each a column, a literal constant, or the current time (now). Shorthand `{column, op, value}` = column vs constant; or `{left, op, right}` for column-vs-column / constant-vs-column. Use it to scope to an event, a segment, or a value range — at any point in the pipeline, including after a window or aggregate to filter on a computed column.',
      properties: {
        stage: { const: 'where' },
        conditions: { type: 'array', minItems: 1, items: CONDITION },
      },
    }),
    build: ({ d, cols }, p) => ({ op: { op: 'where', preds: p.conditions.map((c) => condPred(d, cols, c)) }, cols }),
  },

  derive: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'name', 'op'],
      allOf: [
        { if: { properties: { op: { enum: ['extract', 'array_length', 'contains', 'struct_field'] } }, required: ['op'] }, then: { required: ['source'] } },
        { if: { properties: { op: { const: 'contains' } }, required: ['op'] }, then: { required: ['value'] } },
        { if: { properties: { op: { const: 'struct_field' } }, required: ['op'] }, then: { required: ['field'] } },
      ],
      description: 'Add ONE scalar column from an event property — `extract` a scalar value, or `array_length`/`contains`/`struct_field` for array/struct properties. Surfaces a payload field so it can be filtered, grouped, or aggregated. For math/time/CASE/window over EXISTING columns, use `compute`.',
      properties: {
        stage: { const: 'derive' },
        name: { type: 'string', pattern: NAME },
        op: { enum: ['extract', 'array_length', 'contains', 'struct_field'] },
        source: propEnum(catalog.eventPropEnum(), 'event_data property the value derives from — one of the PIPELINE SOURCE\'s own properties (a property of another source is rejected, naming the source that has it).'),
        value: { description: 'Membership value for op=contains.' },
        field: { type: 'string', description: 'Struct field for op=struct_field.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Result/extract type (default string).' },
      },
    }),
    build: ({ d, catalog, cols, source }, p) => {
      // The RAW payload blob. Only a BLOB property is ever read through it; a flattened payload
      // column carries its value itself and is referenced directly below — which is what makes
      // these ops work on a fully flattened fact (a crash report exploded into real columns),
      // where there is no blob at all.
      const blob = catalog.eventDataColumn(source);
      const found = sourceProp(catalog, source, p.source);
      const spec = found?.spec;
      const key = found?.name || p.source; // the PHYSICAL payload key (qualifier stripped)
      // A FLATTENED payload column carries the array/object itself; `encoding` says whether it
      // is a native ARRAY or a STRING holding JSON, which decides how to read it.
      const flat = spec?.column || null;
      const native = flat && (spec.encoding || 'native') === 'native';
      // An array op on a property that is not an array builds SQL the warehouse will reject
      // (array_length over text). Say so here, naming what the property actually is.
      if ((p.op === 'array_length' || p.op === 'contains') && spec && !String(spec.type || '').toLowerCase().startsWith('array')) {
        throw new Error(`derive ${p.op}: '${p.source}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — ${p.op} needs an array (declare the column with meta.mcp.array, or an array / array<struct> entry in the payload spec). For a JSON OBJECT use op=struct_field, or compute op=json_field.`);
      }
      let expr; let type;
      if (p.op === 'extract') {
        // the catalog's one rule for reading a scalar property (flat column or JSON extract)
        expr = spec ? catalog.propertyExpr(source, key, d.name, { type: p.type }) : d.jsonExtract(blob, key, p.type || 'string');
        type = p.type || spec?.type || 'string';
      } else if (p.op === 'array_length') {
        expr = flat ? (native ? d.arrayLength(flat) : d.jsonColumnArrayLength(flat)) : d.jsonArrayLength(blob, key);
        type = 'int';
      } else if (p.op === 'contains') {
        expr = flat ? (native ? d.arrayContains(flat, p.value) : d.jsonColumnArrayContains(flat, p.value)) : d.jsonArrayContains(blob, key, p.value);
        type = 'boolean';
      } else if (p.op === 'struct_field') {
        expr = flat ? d.jsonColumnStructField(flat, p.field, p.type) : d.jsonStructField(blob, key, p.field, p.type);
        type = p.type || 'string';
      } else throw new Error(`derive: bad op ${p.op}`);
      return { op: { op: 'extend', cols: [{ name: p.name, expr }] }, cols: addCol(cols, p.name, type) };
    },
  },

  compute: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'name', 'op'],
      allOf: [
        { if: { properties: { op: { const: 'const' } }, required: ['op'] }, then: { required: ['value'] } },
        { if: { properties: { op: { enum: ['add', 'sub', 'mul', 'div'] } }, required: ['op'] }, then: { required: ['left', 'right'] } },
        { if: { properties: { op: { enum: ['round', 'floor', 'ceil', 'abs', 'cast', 'upper', 'lower', 'length', 'substring', 'trim', 'replace', 'unix_date', 'date_trunc', 'date_part', 'hll_extract'] } }, required: ['op'] }, then: { required: ['column'] } },
        { if: { properties: { op: { const: 'concat' } }, required: ['op'] }, then: { required: ['parts'] } },
        { if: { properties: { op: { enum: ['coalesce', 'least', 'greatest'] } }, required: ['op'] }, then: { required: ['columns'] } },
        { if: { properties: { op: { const: 'cast' } }, required: ['op'] }, then: { required: ['type'] } },
        { if: { properties: { op: { const: 'replace' } }, required: ['op'] }, then: { required: ['search', 'replacement'] } },
        { if: { properties: { op: { const: 'substring' } }, required: ['op'] }, then: { required: ['start'] } },
        { if: { properties: { op: { const: 'date_diff' } }, required: ['op'] }, then: { required: ['from', 'to', 'unit'] } },
        { if: { properties: { op: { const: 'elapsed_days' } }, required: ['op'] }, then: { required: ['from', 'to'] } },
        { if: { properties: { op: { const: 'date_trunc' } }, required: ['op'] }, then: { required: ['granularity'] } },
        { if: { properties: { op: { const: 'date_part' } }, required: ['op'] }, then: { required: ['part'] } },
        { if: { properties: { op: { const: 'json_field' } }, required: ['op'] }, then: { required: ['column', 'field'] } },
        { if: { properties: { op: { const: 'json_parse_array' } }, required: ['op'] }, then: { required: ['column'] } },
        { if: { properties: { op: { const: 'element_at' } }, required: ['op'] }, then: { required: ['column', 'index'] } },
        { if: { properties: { op: { const: 'array_last' } }, required: ['op'] }, then: { required: ['column'] } },
        { if: { properties: { op: { const: 'raw' } }, required: ['op'] }, then: { required: ['sql'] } },
        { if: { properties: { op: { const: 'case' } }, required: ['op'] }, then: { required: ['cases'] } },
        { if: { properties: { op: { const: 'window' } }, required: ['op'] }, then: { required: ['fn'] } },
      ],
      description: 'Add a column from existing columns + literals: arithmetic, rounding, coalesce, cast, string fns, date functions (date_diff/date_trunc/date_part/unix_date/elapsed_days), a CASE expression (op=case), or a window function (op=window: row_number/rank/lag/lead/running & rolling aggregates). Each op enforces its required params at the schema level.',
      properties: {
        stage: { const: 'compute' },
        name: { type: 'string', pattern: NAME },
        op: { enum: ['const', 'add', 'sub', 'mul', 'div', 'round', 'floor', 'ceil', 'abs', 'coalesce', 'least', 'greatest', 'cast', 'concat', 'upper', 'lower', 'length', 'substring', 'trim', 'replace', 'json_field', 'json_parse_array', 'element_at', 'array_last', 'raw', 'hll_extract', 'date_diff', 'date_trunc', 'date_part', 'unix_date', 'elapsed_days', 'case', 'window'] },
        field: { type: 'string', description: 'Struct field name for op=json_field — extract one field from a column holding a JSON OBJECT: an unnested array-of-struct element, or a flattened payload column that holds JSON (e.g. a crash report\'s custom keys).' },
        value: { description: 'Constant literal (number / string / boolean) for op=const.' },
        left: OPERAND, right: OPERAND, // arithmetic
        from: OPERAND, to: OPERAND, // date_diff / elapsed_days (each may be { column } / { value } / { now: true })
        // For retention with elapsed_days, anchor `from` on the TRUE install/cohort timestamp
        // (e.g. install_date) — NOT an SCD validity bound like install_time_valid_from, whose
        // open side is a sentinel (e.g. 1970-01-01), which makes retention_day nonsensically huge.
        clamp_zero: { type: 'boolean', description: 'op=elapsed_days: fold negative (pre-`from`) and NULL (e.g. missing install_date) results to 0, so it is a clean day 0+. Default true; set false for the raw signed/NULL-able value.' },
        column: { type: 'string', description: 'Input column for round/floor/ceil/abs/cast/upper/lower/length/substring/trim/replace/date_trunc/date_part, and for window lag/lead/sum/avg/min/max.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Inputs for coalesce/least/greatest.' },
        parts: { type: 'array', items: OPERAND, minItems: 1, description: 'Operands (columns/literals) to concatenate for op=concat.' },
        search: { type: 'string', description: 'Substring to find for op=replace.' },
        replacement: { type: 'string', description: 'Replacement string for op=replace.' },
        start: { type: 'integer', minimum: 1, description: '1-based start position for op=substring.' },
        index: { type: 'integer', minimum: 1, description: '1-based index for op=element_at.' },
        sql: { type: 'string', description: 'Raw dialect SQL expression over existing columns — escape hatch for op=raw when no built-in op fits (e.g. array indexing, dialect functions). Not portable across dialects.' },
        len: { type: 'integer', minimum: 0, description: 'Length (chars) for op=substring (optional).' },
        unit: { enum: ['day', 'hour', 'minute', 'second'], description: 'date_diff unit.' },
        granularity: { enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'date_trunc granularity.' },
        part: { enum: ['dow', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'doy'], description: 'date_part to extract.' },
        places: { type: 'integer', minimum: 0, maximum: 12, description: 'Decimal places for round (default 0).' },
        default: { description: 'Fallback literal for coalesce, or default for window lag/lead.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Target type for cast / CASE result type. cast is SAFE — a value that will not convert becomes NULL rather than failing the query.' },
        // op=case
        cases: { type: 'array', minItems: 1, description: 'CASE branches (first matching wins); each `when` is a list of ANDed conditions, `then` an operand.', items: { type: 'object', additionalProperties: false, required: ['when', 'then'], properties: { when: { type: 'array', minItems: 1, items: CONDITION }, then: OPERAND } } },
        else: OPERAND,
        // op=window
        fn: { enum: ['row_number', 'rank', 'dense_rank', 'lag', 'lead', 'sum', 'avg', 'count', 'min', 'max'], description: 'Window function for op=window.' },
        partition_by: { type: 'array', items: { type: 'string' }, description: 'Window partition columns.' },
        order_by: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } }, description: 'Window ordering.' },
        offset: { type: 'integer', minimum: 1, description: 'Row offset for window lag/lead (default 1).' },
        frame: {
          type: 'object', additionalProperties: false,
          description: 'Window frame for aggregate window fns (sum/avg/count/min/max). ROWS = physical row offsets; RANGE = value offsets on the ORDER BY key (for a rolling N-DAY window, order by a unix_date column and use range with preceding:N). Omit for the default frame.',
          properties: {
            mode: { enum: ['rows', 'range'], description: 'rows = physical rows; range = value-based on the order key.' },
            preceding: { description: 'Lower bound: an integer offset, or "unbounded" (default unbounded).' },
            following: { description: 'Upper bound: an integer offset, "unbounded", or 0/omitted = CURRENT ROW.' },
          },
        },
      },
    }),
    build: ({ d, cols }, p) => {
      const operand = (o, what) => operandSql(d, cols, o, `compute ${p.op} ${what}`);
      const col = () => { requireCol(cols, p.column); return d.ident(p.column); };
      const list = () => { (p.columns || []).forEach((c) => requireCol(cols, c)); return (p.columns || []).map((c) => d.ident(c)); };
      const ARITH = { add: '+', sub: '-', mul: '*', div: '/' };
      let expr; let type = 'numeric';
      if (p.op === 'const') {
        if (p.value === undefined) throw new Error('const: needs value');
        expr = d.sqlLiteral(p.value);
        type = typeof p.value === 'number' ? 'numeric' : typeof p.value === 'boolean' ? 'boolean' : 'string';
      } else if (p.op === 'concat') {
        if (!p.parts?.length) throw new Error('concat: needs parts');
        expr = `concat(${p.parts.map((o, i) => operand(o, `part[${i}]`)).join(', ')})`; type = 'string';
      } else if (p.op === 'upper') { expr = `upper(${col()})`; type = 'string'; }
      else if (p.op === 'lower') { expr = `lower(${col()})`; type = 'string'; }
      else if (p.op === 'trim') { expr = `trim(${col()})`; type = 'string'; }
      else if (p.op === 'length') { expr = `length(${col()})`; type = 'int'; }
      else if (p.op === 'substring') { expr = d.substringExpr(col(), p.start ?? 1, p.len); type = 'string'; }
      else if (p.op === 'replace') { expr = `replace(${col()}, ${d.sqlLiteral(p.search ?? '')}, ${d.sqlLiteral(p.replacement ?? '')})`; type = 'string'; }
      else if (ARITH[p.op]) {
        const l = operand(p.left, 'left'); const r = operand(p.right, 'right');
        expr = p.op === 'div' ? `(${l} / NULLIF(${r}, 0))` : `(${l} ${ARITH[p.op]} ${r})`;
      } else if (p.op === 'round') expr = d.roundExpr(col(), p.places ?? 0);
      else if (p.op === 'floor') expr = `floor(${col()})`;
      else if (p.op === 'ceil') expr = `ceil(${col()})`;
      else if (p.op === 'abs') expr = `abs(${col()})`;
      else if (p.op === 'coalesce') { const a = list(); expr = `coalesce(${[...a, ...(p.default !== undefined ? [d.sqlLiteral(p.default)] : [])].join(', ')})`; type = 'string'; }
      else if (p.op === 'least') expr = `least(${list().join(', ')})`;
      else if (p.op === 'greatest') expr = `greatest(${list().join(', ')})`;
      else if (p.op === 'cast') { expr = d.castExpr(col(), p.type || 'string'); type = p.type || 'string'; }
      else if (p.op === 'date_diff') { expr = d.dateDiff(p.unit, operand(p.from, 'from'), operand(p.to, 'to')); type = p.unit === 'day' ? 'int' : 'numeric'; }
      else if (p.op === 'elapsed_days') {
        // Whole 24-HOUR days between `from` and `to` (retention-day) — floor of the span in 24h
        // buckets, NOT calendar days. Default clamp_zero folds negatives (pre-`from` events) AND
        // NULLs (e.g. a missing install_date on a left join) to 0, so the result is a clean day 0+.
        const inner = d.fullDaysBetween(operand(p.from, 'from'), operand(p.to, 'to'));
        expr = (p.clamp_zero === false) ? inner : `COALESCE(GREATEST(${inner}, 0), 0)`;
        type = 'int';
      }
      else if (p.op === 'date_trunc') { expr = d.dateTrunc(p.granularity, col()); type = 'time'; }
      else if (p.op === 'date_part') { expr = d.datePart(p.part, col()); type = 'int'; }
      else if (p.op === 'unix_date') { expr = d.unixDateExpr(col()); type = 'int'; }
      else if (p.op === 'json_field') {
        // An unnested struct element is already JSON-typed; a flattened payload column holding
        // JSON is TEXT and has to be parsed first, or the json operators do not apply to it.
        requireCol(cols, p.column);
        const asJson = cols.get(p.column)?.type === 'json';
        expr = asJson ? d.jsonColumnField(col(), p.field, p.type) : d.jsonColumnStructField(col(), p.field, p.type);
        type = p.type || 'string';
      }
      else if (p.op === 'json_parse_array') { expr = d.jsonParseArray(col()); type = 'array'; } // STRING JSON array → native array (then unnest)
      else if (p.op === 'element_at') { requireArrayCol(cols, p.column, 'element_at'); expr = d.arrayElementAt(col(), p.index); type = p.type || 'string'; }
      else if (p.op === 'array_last') { requireArrayCol(cols, p.column, 'array_last'); expr = d.arrayLast(col()); type = p.type || 'string'; }
      else if (p.op === 'raw') { if (!p.sql) throw new Error('raw: needs sql'); expr = `(${p.sql})`; type = p.type || 'string'; } // escape hatch: verbatim dialect SQL
      else if (p.op === 'hll_extract') { expr = d.hllExtract(col()); type = 'int'; }
      else if (p.op === 'case') {
        if (!p.cases?.length) throw new Error('case: needs at least one branch');
        const branches = p.cases.map((cs) => {
          const cond = cs.when.map((c) => condPred(d, cols, c)).join(' AND ');
          return `WHEN ${cond} THEN ${operand(cs.then, 'then')}`;
        });
        expr = `CASE ${branches.join(' ')}${p.else !== undefined ? ` ELSE ${operand(p.else, 'else')}` : ''} END`;
        type = p.type || 'string';
      } else if (p.op === 'window') {
        (p.partition_by || []).forEach((c) => requireCol(cols, c));
        (p.order_by || []).forEach((o) => requireCol(cols, o.key));
        const parts = (p.partition_by || []).map((c) => d.ident(c));
        const ords = (p.order_by || []).map((o) => `${d.ident(o.key)}${o.direction === 'desc' ? ' DESC' : ''}`);
        let call; let frame = '';
        if (['row_number', 'rank', 'dense_rank'].includes(p.fn)) { call = `${p.fn}()`; type = 'int'; }
        else if (['lag', 'lead'].includes(p.fn)) { call = `${p.fn}(${col()}, ${p.offset ?? 1}${p.default !== undefined ? `, ${d.sqlLiteral(p.default)}` : ''})`; }
        else if (['sum', 'avg', 'count', 'min', 'max'].includes(p.fn)) { call = p.fn === 'count' && !p.column ? 'count(*)' : `${p.fn}(${col()})`; frame = frameClause(p.frame); }
        else throw new Error(`window: bad fn ${p.fn}`);
        if (frame && !ords.length) throw new Error('window frame requires order_by');
        const over = `OVER (${[parts.length ? `PARTITION BY ${parts.join(', ')}` : '', ords.length ? `ORDER BY ${ords.join(', ')}` : ''].filter(Boolean).join(' ')}${frame})`;
        expr = `${call} ${over}`;
      } else throw new Error(`compute: bad op ${p.op}`);
      return { op: { op: 'extend', cols: [{ name: p.name, expr }] }, cols: addCol(cols, p.name, type) };
    },
  },

  unnest: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'source', 'as'],
      description: 'Explode an array property into one row per element (CHANGES GRAIN; rows without the array drop out). For per-element analysis (e.g. items collected, rewards granted). For arrays of structs: bind a single struct `field`, or omit `field` to bind the whole element and pull multiple fields from it downstream with compute op=json_field.',
      properties: {
        stage: { const: 'unnest' },
        source: { type: 'string', description: 'Array/struct to explode: an array event property (see semantic_index), or a pipeline column produced by compute op=json_parse_array. A flat ARRAY column unnests directly; a JSON-string column is parsed first.' },
        as: { type: 'string', pattern: NAME },
        field: { type: 'string', description: 'For array-of-struct: a single struct field to bind. Omit to bind the whole struct element (a JSON column) for multi-field extraction via compute json_field.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'] },
      },
    }),
    build: ({ catalog, cols, source }, p) => {
      const found = sourceProp(catalog, source, p.source);
      const spec = found?.spec;
      let column; let key; let encoding; let isStruct = false;
      if (spec) {
        if (!String(spec.type || '').toLowerCase().startsWith('array')) {
          throw new Error(`unnest: '${p.source}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — there is nothing to explode. Declare the column with meta.mcp.array if it holds one, or read a single field with compute op=json_field.`);
        }
        isStruct = String(spec.type || '').toLowerCase() === 'array<struct>';
        if (spec.column) { column = spec.column; key = null; encoding = spec.encoding || 'native'; } // flattened array column
        else { column = catalog.eventDataColumn(source); key = found.name; encoding = 'blob'; } // legacy JSON-blob property
      } else if (cols.has(p.source) && cols.get(p.source).type === 'array') {
        column = p.source; key = null; encoding = 'native'; // a pipeline-derived array (e.g. from json_parse_array)
      } else {
        throw new Error(`unnest: '${p.source}' is not an array event property of '${source}' nor an array column at this stage`);
      }
      const type = p.field ? (p.type || 'string') : (isStruct ? 'json' : (p.type || 'string'));
      return { op: { op: 'unnest', column, key, as: p.as, field: p.field, type, encoding }, cols: addCol(cols, p.as, type) };
    },
  },

  join: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'with'],
      description: 'Bring in columns from a related model, exposing them for grouping and date math. PREFER `via`: the relationship and its key columns are declared in the catalog schema, so you never restate them and cannot pick the wrong column. Use `on` only for an ad-hoc match on a column both sides happen to name identically. Add `between` when the joined model keeps SEVERAL VERSIONS per key (a validity window): without it every row matches every historical version and counts/sums inflate. `attrs` is REQUIRED and it is the whole contract: exactly the columns you list arrive, nothing is pulled in implicitly, so what the next stage sees is what you asked for. semantic_index({ model }) lists what a model has to offer. Join stages STACK — each one sees everything the previous ones added, so a chain can reach several models; `via` always resolves its left-hand key on the pipeline\'s OWN source, so every relationship you chain must be declared there.',
      anyOf: [{ required: ['via'] }, { required: ['on'] }],
      properties: {
        stage: { const: 'join' },
        with: { type: 'string', enum: catalog.joinableModelKeys(), description: 'Catalog model to join (any model but the pipeline\'s own source).' },
        via: { type: 'string', ...(catalog.joinEntityNames().length ? { enum: catalog.joinEntityNames() } : {}), description: 'A RELATIONSHIP declared in the schema and carried by both sides. Its key columns come from the catalog, so you never restate them, and the two sides may name their columns differently — a key may span SEVERAL columns (e.g. an ad-funnel id together with the player). When one side carries the relationship on several ALTERNATIVE columns (one tracking id per ad format), each is offered as its own `<relationship>_<variant>` and you pick the one the question is about. A relationship no model OWNS has no governed path and is joinable only here — that is normal, not a limitation. semantic_index({ model }) lists each model\'s relationships, their key columns and what they point at.' },
        on: {
          description: 'Ad-hoc fallback when no relationship is declared: key column(s) that exist under the SAME NAME on both sides. A single name, or several for a composite key.',
          oneOf: [{ type: 'string' }, { type: 'array', minItems: 1, items: { type: 'string' } }],
        },
        attrs: {
          type: 'array',
          minItems: 1,
          description: 'REQUIRED — the columns of the joined model to expose, and the ONLY ones that arrive. Nothing is added implicitly: list what the downstream stages will use. Each entry is a column name, or { column, as } to expose it under a different name. A name that would end up used twice — because the pipeline already has one, or because two entries resolve to the same name — is rejected with the reason and the rename to apply, since one name cannot address two columns. semantic_index({ model }) lists the joined model\'s columns.',
          items: {
            oneOf: [
              { type: 'string', description: 'A column of the joined model, exposed under its own name.' },
              {
                type: 'object', additionalProperties: false, required: ['column'],
                description: 'A column of the joined model exposed under a different name — use it for a column both sides name identically.',
                properties: {
                  column: { type: 'string', description: 'Column of the JOINED model.' },
                  as: { type: 'string', description: 'Name it gets in the pipeline (defaults to `column`).' },
                },
              },
            ],
          },
        },
        between: {
          type: 'object', additionalProperties: false, required: ['value', 'from', 'to'],
          description: 'Point-in-time / SCD-2 range condition ANDed with the key equality: keep the joined row whose validity window contains a value from THIS side — `base.<value> BETWEEN joined.<from> AND joined.<to>`. Use it to pick the version of a slowly-changing dimension valid at the moment being asked about. Which moment that is CHANGES THE ANSWER: attributing a crash by the crash time and by the time of the ad that preceded it can land the same player in different cohorts — so state it deliberately. Ensure the joined windows do not overlap, or a row can match several versions. In a metric query nothing has to be stated: MetricFlow applies the window itself.',
          properties: {
            value: { type: 'string', description: 'A column on THIS (left) side compared against the window — e.g. the event time.' },
            from: { type: 'string', description: 'Window LOWER-bound column on the joined model (inclusive), e.g. valid_from.' },
            to: { type: 'string', description: 'Window UPPER-bound column on the joined model (inclusive), e.g. valid_until.' },
          },
        },
        kind: { enum: ['left', 'inner'], default: 'left' },
      },
    }),
    build: ({ catalog, cols, source }, p) => {
      const m = catalog.getModel(p.with);
      if (p.with === source) throw new Error(`join: '${p.with}' is the pipeline's own source — join a DIFFERENT model (a self-join is not expressible as a stage)`);
      if (p.via && p.on) throw new Error('join: pass `via` (the declared relationship) OR `on` (ad-hoc shared column names), not both');
      let on = []; let onKeys;
      if (p.via) {
        // The key columns come from the SCHEMA, on both sides — including a composite key — and
        // each side may name its columns its own way. The LEFT key is resolved on the pipeline's
        // own SOURCE, not on whatever the previous stages accumulated, so a chained join must use
        // a relationship the source itself declares.
        const left = catalog.entityKey(source, p.via);
        const right = catalog.entityKey(p.with, p.via);
        if (!left || !right) {
          const missing = !left ? source : p.with;
          const shared = catalog.sharedEntities(source, p.with).map((x) => x.entity);
          throw new Error(`join via '${p.via}': '${missing}' declares no such relationship.${shared.length ? ` '${source}' and '${p.with}' share: ${shared.join(', ')}.` : ` '${source}' and '${p.with}' share no declared relationship — declare one (meta.mcp.entities) or use \`on\` with a column both sides name identically.`}`);
        }
        for (const part of left) requireCol(cols, part.column); // the left key must survive to here
        onKeys = { left, right };
      } else {
        on = Array.isArray(p.on) ? p.on : [p.on];
        if (!on.length || on.some((k) => typeof k !== 'string' || !k)) throw new Error('join: `on` needs a key column name, or a list of them');
        for (const k of on) requireCol(cols, k); // every key must exist on THIS side
      }
      // What the joined model REALLY has (declared, and already grounded to the physical table at
      // catalog load), with each column's type — so a joined amount stays numeric downstream
      // instead of arriving as an untyped string. A fact's raw payload blob is a column too.
      const joined = new Map(catalog.modelColumns(p.with).map((c) => [c.name, c.type || 'string']));
      if (m.event_data_column && !joined.has(m.event_data_column)) joined.set(m.event_data_column, 'json');
      const known = joined.size ? joined : null; // no column info -> accept what the caller names
      const avail = () => [...joined.keys()].join(', ');
      // `attrs` IS the contract: exactly what is listed arrives, nothing implicit. A join that
      // quietly widened the row would change what the next stage sees without anyone saying so.
      if (!p.attrs?.length) {
        throw new Error(
          `join '${p.with}': \`attrs\` is required — list the columns you want from it; nothing is added implicitly.`
          + `${joined.size ? ` Columns of '${p.with}': ${avail()}.` : ''}`
          + ` Use { column, as } to expose one under a different name. semantic_index({ model: '${p.with}' }) describes them.`,
        );
      }
      const attrs = p.attrs.map((a) => (typeof a === 'string' ? { column: a, as: a } : { column: a.column, as: a.as || a.column }));
      const byName = new Map();
      for (const a of attrs) {
        if (known && !known.has(a.column)) throw new Error(`join '${p.with}' attrs: '${a.column}' is not a column of '${p.with}' (available: ${avail()})`);
        // A name used twice is unaddressable downstream, so say WHICH two things collide and
        // what to rename. The join key is worth calling out: its value is the same on both
        // sides, so the copy is usually not wanted at all.
        if (cols.has(a.as)) {
          const isKey = onKeys ? onKeys.right.some((k) => k.column === a.column) : on.includes(a.column);
          throw new Error(
            `join '${p.with}' attrs: the pipeline already has a column named '${a.as}', so exposing '${p.with}'.${a.column} under that name would leave two columns sharing one name — unaddressable in every later stage.`
            + (isKey
              ? ` '${a.column}' is the join key: it matched on both sides, so the column the pipeline already has holds the same value — drop it from attrs.`
              : ` The two hold different data, so rename the joined one: { column: '${a.column}', as: '${p.with}_${a.column}' }.`),
          );
        }
        if (byName.has(a.as)) throw new Error(`join '${p.with}' attrs: '${byName.get(a.as)}' and '${a.column}' would both be named '${a.as}'. Give each its own \`as\`.`);
        byName.set(a.as, a.column);
      }
      const relation = `{{ ref('${m.dbt_model}') }}`;
      let out = cols;
      for (const a of attrs) out = addCol(out, a.as, joined.get(a.column) || 'string');
      let between;
      if (p.between) {
        // `value` is a column on THIS side (validated against the live column set); `from`/`to`
        // are columns of the JOINED model (validated against its declared columns when known).
        requireCol(cols, p.between.value);
        const joinedCols = new Set([...catalog.modelColumns(p.with).map((c) => c.name), ...Object.keys(m.dimensions || {})]);
        for (const side of ['from', 'to']) {
          const c = p.between[side];
          if (joinedCols.size && !joinedCols.has(c)) throw new Error(`join between.${side}: '${c}' is not a column of '${p.with}' (available: ${[...joinedCols].join(', ')})`);
        }
        between = { value: p.between.value, from: p.between.from, to: p.between.to };
      }
      // Each dialect renders the projection `attrs` itself (a `j.col AS alias` list in the CTE
      // form, a projecting subquery on the right side of a pipe JOIN), so the column set promised
      // here is exactly what the next stage sees on either path.
      return { op: { op: 'join', relation, alias: 'j', on, ...(onKeys ? { onKeys } : {}), attrs, kind: (p.kind || 'left').toUpperCase(), ...(between ? { between } : {}) }, cols: out };
    },
  },

  aggregate: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'measures'],
      description: 'Group rows and compute measures (COLLAPSES grain to the group keys). Measures: sum/avg/min/max/count/count_distinct, approx_count_distinct (fast approximate uniques on large data), and statistical stddev/variance/median/percentile(q). For totals, rates, distinct users (DAU/MAU), revenue, ARPU, distributions/percentiles.',
      properties: {
        stage: { const: 'aggregate' },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Grouping columns (empty = grand total).' },
        measures: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'fn'], allOf: [{ if: { properties: { fn: { const: 'percentile' } }, required: ['fn'] }, then: { required: ['q'] } }, { if: { properties: { fn: { enum: ['sum', 'avg', 'min', 'max', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median', 'percentile'] } }, required: ['fn'] }, then: { required: ['column'] } }], properties: { name: { type: 'string', pattern: NAME }, fn: { enum: AGG_FNS, description: 'Aggregate: sum/avg/min/max/count/count_distinct; statistical stddev/variance/median/percentile. For DISTINCT counts PREFER the HLL sketch path — approx_count_distinct (one-shot HLL++), or hll_init (build a sketch per group) → hll_merge (combine sketches): high accuracy AND mergeable, so a distinct count re-aggregates across time buckets / segments and composes incrementally (exact count_distinct is NOT additive across groups — use it only for an exact integer on a small set).' }, column: { type: 'string' }, q: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'Quantile in (0,1) for fn=percentile.' } } } },
      },
    }),
    build: ({ d, cols }, p) => {
      const groupBy = p.group_by || [];
      for (const g of groupBy) requireCol(cols, g);
      const aggs = p.measures.map((m) => { if (m.column) requireCol(cols, m.column); return { as: m.name, expr: aggExpr(d, m.fn, m.column, m.q) }; });
      let out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const m of p.measures) out.set(m.name, { type: SKETCH_FNS.has(m.fn) ? 'sketch' : 'numeric' });
      return { op: { op: 'aggregate', groupBy, aggs }, cols: out };
    },
  },

  pivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'on', 'fn', 'value_column', 'values'],
      description: 'Turn listed values of `on` into columns, each aggregating `value_column` (the values must be listed explicitly). For dashboard-ready matrices (e.g. revenue as one column per country, or retention day as columns).',
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
      description: 'Fold the listed columns into rows of (name_as, value_as), keeping the rest. For wide→long/tidy reshaping, or turning a pivoted (metric-per-column) result back into rows.',
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
      description: 'Sort rows. For rankings/leaderboards (pair with limit) and stable output ordering.',
      properties: { stage: { const: 'order_by' }, keys: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } } } },
    }),
    build: ({ cols }, p) => { p.keys.forEach((k) => requireCol(cols, k.key)); return { op: { op: 'order_by', keys: p.keys.map((k) => ({ key: k.key, dir: k.direction })) }, cols }; },
  },

  limit: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'n'], description: 'Cap the number of rows. For top-N (after order_by) or previews.', properties: { stage: { const: 'limit' }, n: { type: 'integer', minimum: 1, maximum: 1000000 } } }),
    build: ({ cols }, p) => ({ op: { op: 'limit', n: p.n }, cols }),
  },

  sample: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'percent'],
      description: 'Keep roughly `percent`% of rows, chosen at random — a fast, APPROXIMATE read of the population for a first estimate / where-to-dig signal on large data (no need to scan everything just to see the direction). Put it early. The result is flagged `approximate` with safe/unsafe guidance; re-run WITHOUT this stage for any exact number you will act on (sampling error flips rates near 0/1, small segments, distinct counts).',
      properties: {
        stage: { const: 'sample' },
        percent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Approximate share of rows to keep (0 < percent <= 100).' },
      },
    }),
    build: ({ cols }, p) => ({ op: { op: 'sample', percent: p.percent }, cols }),
  },

  project: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'columns'], description: 'Keep only these columns (drop the rest). Trims the output to the columns of interest.', properties: { stage: { const: 'project' }, columns: { type: 'array', minItems: 1, items: { type: 'string' } } } }),
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

// Static type guard so a JSON/string column passed to an array op is rejected when the
// stage is ADDED (renderPipeline), not at warehouse run time. Only KNOWN-bad types fail;
// 'array' and unknown/untyped columns are allowed (benefit of the doubt for raw/native).
function requireArrayCol(cols, name, op) {
  requireCol(cols, name);
  const t = cols.get(name)?.type;
  if (t && t !== 'array' && t !== 'unknown') {
    throw new Error(`compute ${op}: column '${name}' is '${t}', not an array — produce an array first (compute op=json_parse_array on a JSON/string column, or unnest a native array column), then ${op}.`);
  }
}

/** Register an additional stage from another module (e.g. match_recognize). */
export function registerStage(name, def) { STAGES[name] = def; }

/**
 * Root-level `$defs` the stage schemas reference (`#/$defs/<name>`). A tool schema that embeds
 * pipelineStageSchema() / stageSchemas() must carry these at ITS root — `$ref` resolves against
 * the document it is embedded in, so the definitions cannot travel inside the stage fragment.
 */
export function stageDefs(catalog) {
  return Object.assign({}, ...availableStages(catalog).map((s) => (typeof s.defs === 'function' ? s.defs() : {})));
}

/** A stage may declare `available(catalog)`: false hides it from the schemas and refuses it in a build. */
function availableStages(catalog) {
  return Object.values(STAGES).filter((s) => typeof s.available !== 'function' || s.available(catalog));
}

/** JSON-Schema oneOf for a named subset of stages (e.g. the funnel `prepare` field). */
export function stageSchemas(catalog, names) {
  return { discriminator: { propertyName: 'stage' }, oneOf: names.map((n) => { if (!STAGES[n]) throw new Error(`no such stage: ${n}`); return STAGES[n].schema(catalog); }) };
}

/** Initial columns available from a catalog source model. Every REAL physical column
 *  is exposed (incl. flattened event payload + envelope columns like main_data__app_id),
 *  so a native pipeline can filter/group/compute on them WITHOUT a users-join. */
function sourceColumns(catalog, key, physicalCols = null) {
  const m = catalog.getModel(key);
  const cols = new Map();
  for (const c of catalog.modelColumns(key)) cols.set(c.name, { type: c.type });
  // Fallbacks for catalogs that predate column capture (keep entity/time/event_name/dims).
  if (catalog.isFact(key)) {
    if (m.event_name?.column && !cols.has(m.event_name.column)) cols.set(m.event_name.column, { type: 'string' });
    if (m.time?.column && !cols.has(m.time.column)) cols.set(m.time.column, { type: 'time' });
    if (m.event_data_column && !cols.has(m.event_data_column)) cols.set(m.event_data_column, { type: 'json' });
    for (const e of Object.values(m.entities || {})) for (const p of e.key || []) if (!cols.has(p.column)) cols.set(p.column, { type: 'string' });
  } else {
    // the primary entity's key can span several columns, and each of them is a real column of the
    // relation — the same shape the fact branch above reads (the old single `.column` form is gone)
    for (const p of (typeof m.primary_entity === 'object' && m.primary_entity.key) || []) if (!cols.has(p.column)) cols.set(p.column, { type: 'string' });
    for (const e of Object.values(m.entities || {})) for (const p of e.key || []) if (!cols.has(p.column)) cols.set(p.column, { type: 'string' });
    for (const [name, dd] of Object.entries(m.dimensions || {})) if (!cols.has(name)) cols.set(name, { type: dd.type });
  }
  // GROUNDING: when the caller supplies the relation's PHYSICAL column names (lowercased),
  // drop any declared column the physical table does not have — the pipeline can only
  // reference what truly exists, so a phantom catalog column fails as a normal "unknown
  // column" here instead of as a raw warehouse error at commit. No set → declared as-is.
  if (physicalCols) for (const name of [...cols.keys()]) if (!physicalCols.has(name.toLowerCase())) cols.delete(name);
  return cols;
}

/** The scalar columns a `prepare` stage list adds (name -> { type }) — threads prep columns. */
export function prepareColumns(catalog, dialectName, stages = [], source) {
  const d = getDialect(dialectName);
  let cols = new Map();
  for (const st of stages) {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown prepare stage: ${st.stage}`);
    cols = def.build({ d, catalog, cols, source }, st).cols;
  }
  return cols;
}

export function pipelineStageSchema(catalog) {
  // discriminator on `stage` → a bad stage reports only THAT stage's requirements, not every
  // stage's (each stage schema pins stage:{const} + requires it), so errors stay actionable.
  return { discriminator: { propertyName: 'stage' }, oneOf: availableStages(catalog).map((s) => s.schema(catalog)) };
}

// Fold stages -> { ops, cols } (validating column references along the way). `source`
// is the catalog model the pipeline reads FROM: stages that name an event or an
// event_data property resolve it against THAT fact, so a multi-fact catalog cannot
// silently mix one fact's payload into another fact's pipeline.
function buildOps(catalog, d, baseColumns, stages, source) {
  let cols = new Map(baseColumns);
  const ops = [];
  for (const st of stages) {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown pipeline stage: ${st.stage}`);
    if (typeof def.available === 'function' && !def.available(catalog)) throw new Error(def.unavailableReason ? def.unavailableReason(catalog) : `the '${st.stage}' stage is not available on this warehouse`);
    const res = def.build({ d, catalog, cols, source }, st);
    ops.push(res.op);
    cols = res.cols;
  }
  return { ops, cols };
}

/**
 * Render a full pipeline over a catalog `source` as a CHAIN of dbt models. Stages run in one SQL
 * model until a `python` stage: that stage is a dbt Python model of its own, the SQL stages after
 * it another SQL model reading it through ref, and so on — any number of python stages, anywhere
 * (a python stage FIRST reads the source directly). dbt orders the chain from the refs; the last
 * model carries the pipeline's name (`modelName`), the ones before it `<modelName>_s1`, `_s2`, ….
 * SQL uses the dialect-native form (Postgres chained CTE, BigQuery `|>` pipe syntax) for the first
 * model unless a stage requires CTE form (match_recognize on Postgres); later SQL models read a
 * ref, so they are plain CTE chains.
 * @returns { chain: [{ kind: 'sql'|'python', model, input, stages|stage, sql?, columns }], columns, sql }
 *   `columns` = the final tracked column set (Map); `sql` = the LAST SQL model's text (the whole
 *   pipeline when there is no python stage).
 */
export function renderPipeline(catalog, dialectName, source, stages = [], { physicalCols = null, modelName = 'pipe' } = {}) {
  const d = getDialect(dialectName);
  const m = catalog.getModel(source);
  // Cut the stage list at every python stage.
  const segments = []; let cur = [];
  for (const st of stages) {
    if (STAGES[st.stage]?.python) { if (cur.length) segments.push({ kind: 'sql', stages: cur }); segments.push({ kind: 'python', stage: st }); cur = []; } else cur.push(st);
  }
  if (cur.length || !segments.length) segments.push({ kind: 'sql', stages: cur });
  let cols = sourceColumns(catalog, source, physicalCols);
  let input = m.dbt_model; // what the segment's dbt.ref() / FROM names: the source, then the previous model
  segments.forEach((seg, i) => {
    seg.model = i === segments.length - 1 ? modelName : `${modelName}_s${i + 1}`;
    seg.input = input;
    const baseRelation = `{{ ref('${input}') }}`;
    if (seg.kind === 'sql') {
      const { ops, cols: next } = buildOps(catalog, d, cols, seg.stages, source);
      // Every SQL segment renders in the dialect's native form — BigQuery pipe syntax, a chain of
      // CTEs on Postgres — whether it reads the source or the model a python stage produced.
      seg.sql = d.renderPipeline(baseRelation, ops);
      cols = next;
    } else {
      const def = STAGES[seg.stage.stage];
      if (typeof def.available === 'function' && !def.available(catalog)) throw new Error(def.unavailableReason ? def.unavailableReason(catalog) : 'the python stage is not available on this warehouse');
      cols = def.build({ d, catalog, cols, source }, seg.stage).cols;
    }
    seg.columns = cols;
    input = seg.model;
  });
  const lastSql = [...segments].reverse().find((seg) => seg.kind === 'sql');
  return { chain: segments, columns: cols, sql: lastSql ? lastSql.sql : null };
}
