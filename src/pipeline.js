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
//                            date_diff / date_trunc / date_part, CASE (bucketing), and
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
        source: propEnum(catalog.eventProps(), 'event_data property the value derives from.'),
        value: { description: 'Membership value for op=contains.' },
        field: { type: 'string', description: 'Struct field for op=struct_field.' },
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Result/extract type (default string).' },
      },
    }),
    build: ({ d, catalog, cols }, p) => {
      const json = catalog.eventDataColumn();
      const spec = catalog.eventPropertySpec(p.source);
      let expr; let type;
      // Flattened payload (spec.column) is a real column → reference it directly;
      // legacy JSON-blob payload is extracted from the event_data column.
      if (p.op === 'extract' && spec?.column) { expr = spec.column; type = p.type || spec.type || 'string'; }
      else if (p.op === 'extract') { expr = d.jsonExtract(json, p.source, p.type || 'string'); type = p.type || 'string'; }
      else if (p.op === 'array_length') { expr = d.jsonArrayLength(json, p.source); type = 'int'; }
      else if (p.op === 'contains') { expr = d.jsonArrayContains(json, p.source, p.value); type = 'boolean'; }
      else if (p.op === 'struct_field') { expr = d.jsonStructField(json, p.source, p.field, p.type); type = p.type || 'string'; }
      else throw new Error(`derive: bad op ${p.op}`);
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
      description: 'Add a column from existing columns + literals: arithmetic, rounding, coalesce, cast, string fns, date functions (date_diff/date_trunc/date_part/unix_date), a CASE expression (op=case), or a window function (op=window: row_number/rank/lag/lead/running & rolling aggregates). Each op enforces its required params at the schema level.',
      properties: {
        stage: { const: 'compute' },
        name: { type: 'string', pattern: NAME },
        op: { enum: ['const', 'add', 'sub', 'mul', 'div', 'round', 'floor', 'ceil', 'abs', 'coalesce', 'least', 'greatest', 'cast', 'concat', 'upper', 'lower', 'length', 'substring', 'trim', 'replace', 'json_field', 'json_parse_array', 'element_at', 'array_last', 'raw', 'hll_extract', 'date_diff', 'date_trunc', 'date_part', 'unix_date', 'case', 'window'] },
        field: { type: 'string', description: 'Struct field name for op=json_field (extract from a JSON column, e.g. an unnested array-of-struct element).' },
        value: { description: 'Constant literal (number / string / boolean) for op=const.' },
        left: OPERAND, right: OPERAND, // arithmetic
        from: OPERAND, to: OPERAND, // date_diff (to may be { now: true })
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
        type: { enum: ['int', 'integer', 'numeric', 'float', 'string'], description: 'Target type for cast / CASE result type.' },
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
      else if (p.op === 'date_trunc') { expr = d.dateTrunc(p.granularity, col()); type = 'time'; }
      else if (p.op === 'date_part') { expr = d.datePart(p.part, col()); type = 'int'; }
      else if (p.op === 'unix_date') { expr = d.unixDateExpr(col()); type = 'int'; }
      else if (p.op === 'json_field') { expr = d.jsonColumnField(col(), p.field, p.type); type = p.type || 'string'; }
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
    build: ({ catalog, cols }, p) => {
      const spec = catalog.eventPropertySpec(p.source);
      let column; let key; let encoding; let isStruct = false;
      if (spec) {
        isStruct = String(spec.type || '').toLowerCase() === 'array<struct>';
        if (spec.column) { column = spec.column; key = null; encoding = spec.encoding || 'native'; } // flattened array column
        else { column = catalog.eventDataColumn(); key = p.source; encoding = 'blob'; } // legacy JSON-blob property
      } else if (cols.has(p.source) && cols.get(p.source).type === 'array') {
        column = p.source; key = null; encoding = 'native'; // a pipeline-derived array (e.g. from json_parse_array)
      } else {
        throw new Error(`unnest: '${p.source}' is not an array event property or an array column at this stage`);
      }
      const type = p.field ? (p.type || 'string') : (isStruct ? 'json' : (p.type || 'string'));
      return { op: { op: 'unnest', column, key, as: p.as, field: p.field, type, encoding }, cols: addCol(cols, p.as, type) };
    },
  },

  join: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'with', 'on'],
      description: 'Bring in attributes from a related model on a shared entity key, exposing its columns. Enriches events with user attributes (e.g. country / platform / install_date) for segmentation or date math.',
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
      description: 'Group rows and compute measures (COLLAPSES grain to the group keys). Measures: sum/avg/min/max/count/count_distinct, approx_count_distinct (fast approximate uniques on large data), and statistical stddev/variance/median/percentile(q). For totals, rates, distinct users (DAU/MAU), revenue, ARPU, distributions/percentiles.',
      properties: {
        stage: { const: 'aggregate' },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Grouping columns (empty = grand total).' },
        measures: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name', 'fn'], allOf: [{ if: { properties: { fn: { const: 'percentile' } }, required: ['fn'] }, then: { required: ['q'] } }, { if: { properties: { fn: { enum: ['sum', 'avg', 'min', 'max', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median', 'percentile'] } }, required: ['fn'] }, then: { required: ['column'] } }], properties: { name: { type: 'string', pattern: NAME }, fn: { enum: AGG_FNS, description: 'Aggregate: sum/avg/min/max/count/count_distinct, approx_count_distinct (fast approximate distinct count), statistical stddev/variance/median/percentile, and the mergeable distinct-sketch functions hll_init/hll_merge/hll_merge_partial.' }, column: { type: 'string' }, q: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'Quantile in (0,1) for fn=percentile.' } } } },
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
      description: 'Keep roughly `percent`% of rows, chosen at random — a fast, approximate peek for a first estimate or where-to-dig signal on large data. Put it early. Results are a random subset, not exact.',
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

/** JSON-Schema oneOf for a named subset of stages (e.g. the funnel `prepare` field). */
export function stageSchemas(catalog, names) {
  return { oneOf: names.map((n) => { if (!STAGES[n]) throw new Error(`no such stage: ${n}`); return STAGES[n].schema(catalog); }) };
}

/** Initial columns available from a catalog source model. Every REAL physical column
 *  is exposed (incl. flattened event payload + envelope columns like main_data__app_id),
 *  so a native pipeline can filter/group/compute on them WITHOUT a users-join. */
function sourceColumns(catalog, key, physicalCols = null) {
  const m = catalog.getModel(key);
  const cols = new Map();
  for (const c of catalog.modelColumns(key)) cols.set(c.name, { type: c.type });
  // Fallbacks for catalogs that predate column capture (keep entity/time/event_name/dims).
  if (key === catalog.anchor) {
    if (m.event_name?.column && !cols.has(m.event_name.column)) cols.set(m.event_name.column, { type: 'string' });
    if (m.time?.column && !cols.has(m.time.column)) cols.set(m.time.column, { type: 'time' });
    if (m.event_data_column && !cols.has(m.event_data_column)) cols.set(m.event_data_column, { type: 'json' });
    for (const e of Object.values(m.entities || {})) if (e.column && !cols.has(e.column)) cols.set(e.column, { type: 'string' });
  } else {
    if (typeof m.primary_entity === 'object' && m.primary_entity.column && !cols.has(m.primary_entity.column)) cols.set(m.primary_entity.column, { type: 'string' });
    for (const [name, dd] of Object.entries(m.dimensions || {})) if (!cols.has(name)) cols.set(name, { type: dd.type });
  }
  // GROUNDING: when the caller supplies the relation's PHYSICAL column names (lowercased),
  // drop any declared column the physical table does not have — the pipeline can only
  // reference what truly exists, so a phantom catalog column fails as a normal "unknown
  // column" here instead of as a raw warehouse error at commit. No set → declared as-is.
  if (physicalCols) for (const name of [...cols.keys()]) if (!physicalCols.has(name.toLowerCase())) cols.delete(name);
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

// Fold stages -> { ops, cols } (validating column references along the way).
function buildOps(catalog, d, baseColumns, stages) {
  let cols = new Map(baseColumns);
  const ops = [];
  for (const st of stages) {
    const def = STAGES[st.stage];
    if (!def) throw new Error(`unknown pipeline stage: ${st.stage}`);
    const res = def.build({ d, catalog, cols }, st);
    ops.push(res.op);
    cols = res.cols;
  }
  return { ops, cols };
}

// Chained-CTE assembly (works for both dialects). A stage that renders itself
// (op.render, e.g. match_recognize) contributes its own self-contained SELECT as
// one CTE; all others use the dialect's stepCte.
function assembleCteSql(d, dialectName, baseRelation, ops) {
  let prev = baseRelation;
  const ctes = [];
  for (const op of ops) {
    const name = `p${ctes.length}`;
    const sql = op.render ? op.render(prev, dialectName) : d.stepCte(prev, op);
    ctes.push({ name, sql });
    prev = name;
  }
  const head = ctes.length ? `WITH ${ctes.map((c) => `${c.name} AS (\n  ${c.sql}\n)`).join(',\n')}\n` : '';
  return `${head}SELECT * FROM ${prev}`;
}

/**
 * Lower a pipeline over an explicit base relation to one SQL text (chained-CTE
 * form). Used by the funnel: [...prepare, match_recognize].
 */
export function renderPipelineSql(catalog, dialectName, baseRelation, baseColumns, stages) {
  const d = getDialect(dialectName);
  const { ops } = buildOps(catalog, d, baseColumns, stages);
  return assembleCteSql(d, dialectName, baseRelation, ops);
}

/**
 * Render a full pipeline over a catalog `source` to SQL for `dialectName`. The
 * dialect-native form is used (Postgres chained CTE, BigQuery `|>` pipe syntax)
 * unless a stage requires CTE form on THIS dialect (e.g. match_recognize on engines
 * without a native row-pattern operator — BigQuery DOES have `|> MATCH_RECOGNIZE`, so
 * it stays pipe; Postgres emulates it as a CTE, forcing chained-CTE assembly).
 * @returns { sql, columns } — columns is the final tracked column set (Map).
 */
export function renderPipeline(catalog, dialectName, source, stages = [], { physicalCols = null } = {}) {
  const d = getDialect(dialectName);
  const m = catalog.getModel(source);
  const baseRelation = `{{ ref('${m.dbt_model}') }}`;
  const { ops, cols } = buildOps(catalog, d, sourceColumns(catalog, source, physicalCols), stages);
  const sql = ops.some((o) => o.requiresCte) ? assembleCteSql(d, dialectName, baseRelation, ops) : d.renderPipeline(baseRelation, ops);
  return { sql, columns: cols };
}
