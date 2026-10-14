// THE EXPRESSION GRAMMAR — ONE, for every place a value, a condition or a measure is written. An
// expression is a LEAF — a column of the rows here ({ column }), an event property read where it is
// stored ({ property, field? }, of the type the catalog declares), a constant ({ value }), the current
// time ({ now: true }), or a
// thing a ref names that holds a value (src/schema/refs.js: { source, column }, { source, property },
// { semantic_model, dimension }, { entity }, { time: "metric_time" }, { metric }) — or a FUNCTION over
// expressions ({ fn, args: [...], …its parameters }), nested to any depth. A condition is a function
// (eq, in, between, is_null … combined by and / or / not), and so is an aggregate (sum, count,
// percentile …), so a where, a measure and a computed column are one grammar placed in different stages.
// A value has the type of what it is read from (a column's, a property's as the catalog declares it), and
// one function converts it (cast). An aggregate folds the rows its argument has a value on: a conditional
// one folds a case — a value on the rows where the condition holds — and nothing else says it.
//
// One table (FNS) says each function's arguments, parameters, kind and SQL; one builder (exprSchema)
// turns it into THE schema every tool that takes an expression carries as `$defs.expr` — a closed form
// per leaf and per function shape, `args` referring back to the same definition, holding what the tool's
// own places take; one writer (exprSql, and conditionListSql for a condition slot) turns an expression
// into SQL. What a PLACE takes of it is one table (PLACES: the leaves and the functions of a pipeline
// step, a read, a semantic model, a where before a metrics step, a derived metric), read by the builder for a
// tool's definition and checked by the writer as the value is built, and so are the rules of
// WHERE each kind may stand: an aggregate folds rows only where a measure is written, a window keeps them
// only in a compute stage, a condition slot takes booleans. A function is added in one place, and a
// parameter it does not read is not in its form, so it is refused instead of silently ignored.

import { GRAINS, TASK_MEASURE_AGGS } from '../catalog.js';
import { isNumericType, isTimeType } from '../dialects/base.js';
// (sql.js is read when a function runs, never as this module loads)
import { fillPlaceholders, rawNamedColumns, unquotedSql, frameClause, requireCol, sqlAgg, TYPE, SORT_KEY, sourceProp, partitionItem, partitionColumn } from './sql.js';
import { OPS, predicateSql } from '../conditions.js';
import { form, strEnum, SCALAR, conditionSlot } from '../schema-kit.js';
import { REFS, VALUE_REFS, REF_PLACES, refKind, valueRefForms } from '../schema/refs.js';
import { rankFuzzy } from '../fuzzy.js';
import { currentOf } from '../earlier-spelling.js';

// ── The function names, by kind — what a level picks its vocabulary from ──────────────────────────
/** The conditions: comparisons, membership, a range, the null tests, the text tests (src/conditions.js OPS). */
export const CONDITION_FNS = [...OPS];
/** The logic over conditions. */
export const LOGIC_FNS = ['and', 'or', 'not'];
/** The aggregates — each folds the rows of a group into one value, where a measure is written. */
export const AGGREGATE_FNS = ['sum', 'average', 'min', 'max', 'count', 'count_distinct', 'approx_count_distinct', 'median', 'percentile', 'stddev', 'variance', 'hll_init', 'hll_merge', 'hll_merge_partial'];
/** The aggregates that also compute over a WINDOW, given `over`. */
export const WINDOW_AGGREGATE_FNS = ['sum', 'average', 'min', 'max', 'count'];
/** The window functions proper: always over a window. */
export const WINDOW_FNS = ['row_number', 'rank', 'dense_rank', 'lag', 'lead'];
/** The aggregates that produce a SKETCH (a value merged later with hll_merge), not a number. */
export const SKETCH_FNS = new Set(['hll_init', 'hll_merge_partial']);
/** The statistical aggregates — each written the dialect's way (exact on one warehouse, a sketch on another). */
export const STAT_FNS = new Set(['stddev', 'variance', 'median', 'percentile']);

// (built when the schema is: what the window parameters reference is read lazily)
const ORDER = () => ({ type: 'array', items: SORT_KEY, description: 'Window ordering: each key a column, its direction and where its NULLs go (last unless said).' });
// `entities`: whether the rows are a source's, so a declared relationship { entity } may name a partition
const PARTITION = (catalog, entities) => ({ type: 'array', uniqueItems: true, items: partitionItem(catalog, { entities }), description: `What the window restarts per: columns${entities ? ', or a declared relationship { entity } (its key column)' : ''}. Without them the window is one global window over every row, held by one worker — on a large table, "Resources exceeded". For a table-wide number use an aggregate stage with no group_by instead.` });

// a frame bound: an offset, or the edge of the partition
const BOUND = { anyOf: [{ type: 'integer', minimum: 0, title: 'an offset' }, { const: 'unbounded', title: '"unbounded"' }] };
const FRAME = {
  type: 'object', additionalProperties: false,
  description: 'Window frame. ROWS = physical row offsets; RANGE = value offsets on the ORDER BY key (for a rolling N-DAY window, order by a unix_date column and use range with preceding:N). Omit for the default frame.',
  properties: {
    mode: { enum: ['rows', 'range'], description: 'rows = physical rows; range = value-based on the order key.' },
    preceding: { ...BOUND, description: 'Lower bound: a row (or value) offset, or "unbounded" (default unbounded).' },
    following: { ...BOUND, description: 'Upper bound: an offset, "unbounded", or 0/omitted = CURRENT ROW.' },
  },
};

// the parameters a function may take, by name — each function's form picks its own. `ref` is the one
// expression's definition (a CASE's branches and conditions are expressions too); `entities` whether a
// window may restart per a relationship of the source.
const params = (catalog, { ref, entities = true }) => ({
  places: { type: 'integer', minimum: 0, maximum: 12, description: 'Decimal places (default 0).' },
  type: TYPE,
  start: { type: 'integer', minimum: 1, description: '1-based start position.' },
  len: { type: 'integer', minimum: 0, description: 'Length in characters (optional).' },
  search: { type: 'string', description: 'Substring to find.' },
  replacement: { type: 'string', description: 'What replaces it.' },
  field: { type: 'string', description: 'The field of the JSON object to read.' },
  index: { type: 'integer', minimum: 1, description: '1-based index.' },
  unit: { enum: ['day', 'hour', 'minute', 'second'], description: 'The unit of the difference: the whole units elapsed from the first argument to the second, truncated toward zero (1 h 59 min is 1 hour; a day is 24 hours, not a calendar boundary — date_trunc both to the day for calendar days), an integer, negative when the second is earlier.' },
  grain: { enum: GRAINS, description: 'The time bucket to truncate to (a week starts on Monday, the ISO week).' },
  part: { enum: ['dow', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'doy'], description: 'The date part to extract: dow is the ISO day of the week (Monday 1 … Sunday 7), week the ISO week number — on every warehouse.' },
  clamp_zero: { type: 'boolean', description: 'Fold negative (before the start) and NULL (e.g. a missing install_date) results to 0, so it is a clean day 0+. Default true; false for the raw signed/NULL-able value.' },
  sql: { type: 'string', description: 'Dialect SQL — the escape hatch when no function fits; not portable. Columns are positional: each is an item of `args`, and {1}, {2}, … in the SQL stand where it goes, written quoted by the server. A word spelled exactly as a column of this step (or in identifier quotes) is refused, so write SQL keywords in upper case (DAY, DATE). E.g. { fn: "raw", sql: "SAFE_DIVIDE({1}, {2})", args: [{ column: "new" }, { column: "new_n" }] }.' },
  cases: { type: 'array', minItems: 1, description: 'CASE branches (the first that holds wins); each `when` a list of conditions that all hold, `then` an expression.', items: { type: 'object', additionalProperties: false, required: ['when', 'then'], properties: { when: conditionSlot(ref, 'The conditions this branch takes: all of them hold.'), then: { $ref: ref } } } },
  else: { $ref: ref, description: 'The value when no branch holds (default NULL — under an aggregate, the rows it leaves out; of the aggregates only sum may take another, else: 0).' },
  offset: { type: 'integer', minimum: 1, description: 'Row offset (default 1).' },
  default: { ...SCALAR, description: 'The constant when the offset row does not exist.' },
  percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'The quantile in (0,1), e.g. 0.95 for p95.' },
  over: { type: 'object', additionalProperties: false, description: 'The window: the rows it is computed over, in order.', properties: { partition_by: PARTITION(catalog, entities), order_by: ORDER() } },
  over_frame: { type: 'object', additionalProperties: false, description: 'The window: the rows it is computed over, in order, and the frame of them each value reads.', properties: { partition_by: PARTITION(catalog, entities), order_by: ORDER(), frame: FRAME } },
});

// a window clause in raw SQL, outside its string literals, quoted names and comments
const RAW_OVER = /\bover\s*\(/i;

/** The type of a value picked from several (coalesce, least, greatest, a CASE's branches): the one its
 *  typed arguments share; numbers of any kind are numeric, moments of any kind a time; arguments of
 *  kinds that do not meet are 'unknown' (compared as written); with no typed argument, `fallback`. An
 *  untyped constant (null) says nothing. */
function commonType(types, fallback) {
  const typed = [...new Set(types.filter((t) => t && t !== 'unknown'))];
  if (!typed.length) return fallback;
  if (typed.length === 1) return typed[0];
  if (typed.every(isNumericType)) return 'numeric';
  if (typed.every(isTimeType)) return 'time';
  return 'unknown';
}

const one = (fn, type) => ({ args: 1, sql: ({ a }) => ({ expr: `${fn}(${a[0]})`, type }) });
const arith = (sym) => ({ args: 2, title: '[left, right]', sql: ({ a }) => ({ expr: sym === '/' ? `(${a[0]} / NULLIF(${a[1]}, 0))` : `(${a[0]} ${sym} ${a[1]})` }) });
// An array function's argument is checked when the stage is ADDED, not at warehouse run time: only a
// KNOWN non-array type fails — an array, or a column whose type is unknown (raw, native), passes.
const ARRAY_TYPES = new Set(['array', 'unknown', undefined, null]);
const needsArray = (fn, t) => {
  if (ARRAY_TYPES.has(t)) return;
  // an array of structs has no scalar element to take: its elements are read a field at a time
  if (String(t).startsWith('array')) throw new Error(`${fn}: its argument is '${t}' — ${fn} takes an array of scalars. Read the elements' fields instead: unnest the property, then json_field on the element`);
  throw new Error(`${fn}: its argument is '${t}', not an array — produce an array first (json_parse_array on a JSON/string column, or unnest a native array column)`);
};

/** The window clause of a window: OVER (PARTITION BY … ORDER BY … frame). `frame`: an aggregate of a
 *  frame (sum, count …) rather than a rank or a neighbour — the dialect orders the two differently where
 *  it places NULLs. `opts` carries the pipeline's catalog and source, for a partition named by a
 *  declared relationship. */
function overSql(d, cols, over = {}, { frame = false, opts = {} } = {}) {
  const partCols = (over.partition_by || []).map((p, i) => partitionColumn({ catalog: opts.catalog, source: opts.source, cols }, p, `over.partition_by[${i}]`));
  if (cols) {
    partCols.forEach((c) => requireCol(cols, c));
    (over.order_by || []).forEach((o) => requireCol(cols, o.key));
  }
  const parts = partCols.map((c) => d.quoteIdent(c));
  const keys = (over.order_by || []).map((o) => ({ sql: d.quoteIdent(o.key), direction: o.direction, nulls: o.nulls }));
  const f = frame ? frameClause(over.frame) : '';
  if (f && !keys.length) throw new Error('a window frame requires order_by');
  const ords = keys.length ? d.windowOrder(keys, { aggregate: frame, frame: frame ? over.frame : null }) : '';
  return `OVER (${[parts.length ? `PARTITION BY ${parts.join(', ')}` : '', ords ? `ORDER BY ${ords}` : ''].filter(Boolean).join(' ')}${f})`;
}

/**
 * An event property of the pipeline's source, read where it is stored: its flattened column (a native
 * ARRAY, or text holding JSON) or a key of the source's event_data blob. `kind` is what is read: its
 * value (one field of it with `field`), an array's length, or whether an array holds `item`. The value
 * is of the type the catalog declares (text where it declares none), a field of it text: another type
 * is a cast of the read. The column it reads must still be in the row — after a stage that changed the
 * grain it is gone.
 */
function propertyRead(kind, { d, cols, catalog, source, property, field, item, as, at }) {
  if (!catalog || !source) throw new Error(`${at}: { property: '${property}' } reads an event property of a pipeline's source, and these rows read none (a stored table) — name one of their columns ({ column })`);
  const blob = catalog.eventDataColumn(source);
  const found = sourceProp(catalog, source, property);
  const spec = found?.spec;
  const key = found?.name || property; // the PHYSICAL payload key (qualifier stripped)
  if (cols) requireCol(cols, spec?.column || blob);
  // what is read — the property's own column, or the payload column it is a key of — is written quoted,
  // as every column the server writes is; the catalog's rule (propertyBackingColumn) says which it is
  const flat = spec?.column ? d.quoteIdent(catalog.propertyBackingColumn(source, key)) : null;
  const payload = d.quoteIdent(blob);
  const native = flat && (spec.encoding || 'native') === 'native';
  if (kind !== 'value' && spec && !String(spec.type || '').toLowerCase().startsWith('array')) {
    throw new Error(`${at}: '${property}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — an array function needs an array (declare the column with meta.mcp.array, or an array / array<struct> entry in the payload spec). A field of a JSON object is { property, field }.`);
  }
  if (kind === 'length') return { sql: flat ? (native ? d.arrayLength(flat) : d.jsonColumnArrayLength(flat)) : d.jsonArrayLength(payload, key), type: 'int' };
  if (kind === 'contains') return { sql: flat ? (native ? d.arrayContains(flat, item) : d.jsonColumnArrayContains(flat, item)) : d.jsonArrayContains(payload, key, item), type: 'boolean' };
  if (field !== undefined) return { sql: flat ? d.jsonColumnStructField(flat, field) : d.jsonStructField(payload, key, field), type: 'string' };
  // a scalar in its own column holds what the catalog declares; a payload key is extracted as that type —
  // or, read by a cast (`as`), as the type cast to: the payload's text converted once, not the declared
  // type's value converted again (3 read as text is '3', not '3.0')
  const type = propertyType(spec);
  if (flat) return { sql: flat, type };
  if (as) return { sql: d.jsonExtract(payload, key, as), type: as, readAs: as };
  return { sql: d.jsonExtract(payload, key, type), type };
}

/** The type a property's value is read as: the catalog's declared type, text where it declares none. */
const propertyType = (spec) => spec?.type || 'string';

/**
 * What a { property } of `source` is read as, by name (`opts.propertyType` of src/earlier-spelling.js:
 * a typed read of an earlier spelling keeps its `type` only where it is another): the catalog's type,
 * text where it declares none — undefined for a name that is no property of the source. With no source
 * (a call's input, before its source is known), the type every events source declaring the name agrees on.
 */
export const propertyTypes = (catalog, source = null) => (name) => {
  if (!catalog) return undefined;
  try {
    if (source) {
      const found = sourceProp(catalog, source, name);
      return found ? propertyType(found.spec) : undefined;
    }
    const types = new Set((catalog.facts || []).filter((f) => catalog.models[f]?.properties?.[name]).map((f) => propertyType(catalog.models[f].properties[name])));
    return types.size === 1 ? [...types][0] : undefined;
  } catch { return undefined; }
};

/** An aggregate's SQL over its written argument `c` (null: a count of the rows). A CONDITIONAL
 *  aggregate's argument is a case: its value is NULL on every row no branch takes, which every aggregate
 *  skips — count(case when …), sum(case when …) — the same on every warehouse. */
function aggregateSql(d, fn, c, q) {
  if (fn === 'count' && c == null) return 'count(*)';
  if (fn === 'count_distinct') return `count(distinct ${c})`;
  if (fn === 'approx_count_distinct') return d.approxCountDistinct(c);
  if (fn === 'hll_init') return d.hllInit(c);
  if (fn === 'hll_merge') return d.hllMerge(c);
  if (fn === 'hll_merge_partial') return d.hllMergePartial(c);
  if (STAT_FNS.has(fn)) return d.statAggExpr(fn, c, q);
  return `${sqlAgg(fn)}(${c})`; // sum / average / min / max / count
}

/** What an aggregate yields: a count is an integer, a sketch a sketch, the earliest / latest of a value
 *  that value's type (a time stays a time), every other a number. */
function aggregateType(fn, argType) {
  if (SKETCH_FNS.has(fn)) return 'sketch';
  if (['count', 'count_distinct', 'approx_count_distinct', 'hll_merge'].includes(fn)) return 'int';
  if (fn === 'min' || fn === 'max') return argType || 'unknown';
  return 'numeric';
}

const condition = (op, args, title) => ({
  kind: 'condition', args, title,
  sql: ({ d, r, opts }) => ({ expr: predicateSql(op, r, { timeOperand: (x) => d.timeOperand(x), castToConstant: !!opts.castToConstant, dialect: d.name }), type: 'boolean' }),
});

const aggregate = (fn, { args = 1, title, needs } = {}) => ({
  kind: 'aggregate', args, title, ...(needs ? { needs } : {}), windowable: WINDOW_AGGREGATE_FNS.includes(fn),
  sql: ({ d, cols, a, t, p, window, opts }) => (window
    ? { expr: `${sqlAgg(fn)}(${a.length ? a[0] : '*'}) ${overSql(d, cols, p.over, { frame: true, opts })}`, type: aggregateType(fn, t[0]) }
    : { expr: aggregateSql(d, fn, a.length ? a[0] : null, p.percentile), type: aggregateType(fn, t[0]) }),
});

/**
 * Every function, by name: its `kind` (scalar | condition | logic | aggregate | window), how many `args`
 * it takes (a number, or { min, max? }), the parameters it requires (`needs`) and may take (`may`), and
 * its SQL over the written arguments — `a` their SQL, `t` their types, `r` all that is known of each —
 * → { expr, type } (type 'numeric' when it is not said). `title` says what the arguments are when their
 * order matters. An aggregate takes, when `windowable`, `over`; a conditional one folds a case.
 */
export const FNS = {
  add: arith('+'),
  sub: arith('-'),
  mul: arith('*'),
  div: arith('/'),
  round: { args: 1, may: ['places'], sql: ({ d, a, p }) => ({ expr: d.roundExpr(a[0], p.places ?? 0) }) },
  floor: one('floor'),
  ceil: one('ceil'),
  abs: one('abs'),
  upper: one('upper', 'string'),
  lower: one('lower', 'string'),
  length: one('length', 'int'),
  trim: one('trim', 'string'),
  unix_date: { args: 1, sql: ({ d, a }) => ({ expr: d.unixDateExpr(a[0]), type: 'int' }) },
  hll_extract: { args: 1, sql: ({ d, a }) => ({ expr: d.hllExtract(a[0]), type: 'int' }) },
  json_parse_array: { args: 1, sql: ({ d, a }) => ({ expr: d.jsonParseArray(a[0]), type: 'array' }) }, // STRING JSON array → native array (then unnest)
  coalesce: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `coalesce(${a.join(', ')})`, type: commonType(t, 'string') }) },
  least: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `least(${a.join(', ')})`, type: commonType(t, 'numeric') }) },
  greatest: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `greatest(${a.join(', ')})`, type: commonType(t, 'numeric') }) },
  concat: { args: { min: 1 }, sql: ({ a }) => ({ expr: `concat(${a.join(', ')})`, type: 'string' }) },
  cast: { args: 1, needs: ['type'], sql: ({ d, a, p }) => ({ expr: d.castExpr(a[0], p.type), type: p.type }) },
  substring: { args: 1, needs: ['start'], may: ['len'], sql: ({ d, a, p }) => ({ expr: d.substringExpr(a[0], p.start, p.len), type: 'string' }) },
  replace: { args: 1, needs: ['search', 'replacement'], sql: ({ d, a, p }) => ({ expr: `replace(${a[0]}, ${d.sqlLiteral(p.search)}, ${d.sqlLiteral(p.replacement)})`, type: 'string' }) },
  // An unnested struct element is already JSON-typed; a flattened payload column holding JSON is
  // TEXT and has to be parsed first, or the json operators do not apply to it. What it reads is text
  // (cast converts it), as what element_at and array_last take out of an array.
  json_field: { args: 1, needs: ['field'], sql: ({ d, a, t, p }) => ({ expr: t[0] === 'json' ? d.jsonColumnField(a[0], p.field) : d.jsonColumnStructField(a[0], p.field), type: 'string' }) },
  // how many elements an array holds, whether it holds one value: of an array event property read where
  // it is stored ({ property }), or of an expression that yields an array (written by the writer itself)
  array_length: { args: 1, title: '[array]', array: 'length' },
  array_contains: { args: 2, title: '[array, { value }]', array: 'contains' },
  element_at: { args: 1, needs: ['index'], sql: ({ d, a, t, p }) => { needsArray('element_at', t[0]); return { expr: d.arrayElementAt(a[0], p.index), type: 'string' }; } },
  array_last: { args: 1, sql: ({ d, a, t }) => { needsArray('array_last', t[0]); return { expr: d.arrayLast(a[0]), type: 'string' }; } },
  date_diff: { args: 2, title: '[from, to]', needs: ['unit'], sql: ({ d, a, p }) => ({ expr: d.dateDiff(p.unit, a[0], a[1]), type: 'int' }) },
  date_trunc: { args: 1, needs: ['grain'], sql: ({ d, a, p }) => ({ expr: d.dateTrunc(p.grain, a[0]), type: 'time' }) },
  date_part: { args: 1, needs: ['part'], sql: ({ d, a, p }) => ({ expr: d.datePart(p.part, a[0]), type: 'int' }) },
  // Whole 24-HOUR days between `from` and `to` (retention-day) — floor of the span in 24h buckets,
  // NOT calendar days. Default clamp_zero folds negatives (pre-`from` events) AND NULLs (e.g. a
  // missing install_date on a left join) to 0, so the result is a clean day 0+.
  elapsed_days: {
    args: 2, title: '[from, to]', may: ['clamp_zero'],
    sql: ({ d, a, p }) => {
      const inner = d.fullDaysBetween(a[0], a[1]);
      return { expr: p.clamp_zero === false ? inner : `COALESCE(GREATEST(${inner}, 0), 0)`, type: 'int' };
    },
  },
  case: {
    args: 0, needs: ['cases'], may: ['else', 'type'],
    sql: ({ p, sub, conds }) => {
      const thens = [];
      const branches = p.cases.map((cs, i) => {
        const then = sub(cs.then, `cases[${i}].then`);
        thens.push(then.type);
        return `WHEN ${conds(cs.when, `cases[${i}].when`).map((x) => `(${x})`).join(' AND ')} THEN ${then.sql}`;
      });
      const other = p.else !== undefined ? sub(p.else, 'else') : null;
      if (other) thens.push(other.type);
      return { expr: `CASE ${branches.join(' ')}${other ? ` ELSE ${other.sql}` : ''} END`, type: p.type || commonType(thens, 'string') };
    },
  },
  // escape hatch: dialect SQL whose columns come STRUCTURED — each an item of args, `{n}` in the SQL
  // where the n-th goes, written quoted by the server; a column named in its text is refused
  raw: {
    args: { min: 0 }, needs: ['sql'], may: ['type'], title: '[the expressions {1}, {2}, … stand for in sql]',
    sql: ({ d, cols, p, scope, a, at }) => {
      // a raw window is still a window: where SQL takes none, it is refused as the structured one is
      if (RAW_OVER.test(unquotedSql(p.sql))) {
        if (scope.noWindows) throw new Error(`${at}: a raw expression with OVER (…) is a window function, and a condition cannot test one — a where keeps rows before any window is computed. Compute it into a column first (a compute stage), then filter on that column`);
        if (scope.inWindow) throw new Error(`${at}: a raw expression with OVER (…) is a window function, and it cannot be an argument of another window function — compute it into a column first (a compute stage), then use that column`);
        if (scope.inAggregate || scope.aggregateLevel) throw new Error(`${at}: a raw expression with OVER (…) is a window function, and a measure folds rows — compute it into a column first (a compute stage), then fold that column`);
      }
      // a column comes positionally, in args: one written by name in the text is refused
      const named = cols ? rawNamedColumns(p.sql, cols, d.quoteIdent('x')[0]) : [];
      if (named.length) throw new Error(`pipeline: a raw expression names ${named.map((n) => `'${n}'`).join(', ')} in its SQL text — a column goes in \`args\`, with {1}, {2}, … in the SQL where each goes (e.g. sql: "SAFE_DIVIDE({1}, {2})", args: [{ column: "${named[0]}" }, …]); the server writes it quoted`);
      return { expr: `(${fillPlaceholders(p.sql, a)})`, type: p.type || 'string' };
    },
  },
  // conditions: a boolean of their arguments, written by the one comparison writer (src/conditions.js)
  ...Object.fromEntries(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].map((op) => [op, condition(op, 2, '[a, b]')])),
  ...Object.fromEntries(['in', 'not_in'].map((op) => [op, condition(op, { min: 2 }, '[a, member, member, …]')])),
  between: condition('between', 3, '[a, low, high] (both included)'),
  ...Object.fromEntries(['is_null', 'is_not_null'].map((op) => [op, condition(op, 1, '[a]')])),
  ...Object.fromEntries(['like', 'not_like', 'contains', 'starts_with', 'ends_with'].map((op) => [op, condition(op, 2, '[text, pattern]')])),
  // logic: and / or of two or more conditions, not of one — a missing value is false in all of them
  // (`not` of a comparison with a missing operand holds: NOT COALESCE(c, FALSE))
  and: { kind: 'logic', args: { min: 2 }, title: '[condition, condition, …]', sql: ({ a }) => ({ expr: `(${a.map((x) => `(${x})`).join(' AND ')})`, type: 'boolean' }) },
  or: { kind: 'logic', args: { min: 2 }, title: '[condition, condition, …]', sql: ({ a }) => ({ expr: `(${a.map((x) => `(${x})`).join(' OR ')})`, type: 'boolean' }) },
  not: { kind: 'logic', args: 1, title: '[condition]', sql: ({ a }) => ({ expr: `(NOT COALESCE(${a[0]}, FALSE))`, type: 'boolean' }) },
  // aggregates: each folds a group's rows into one value where a measure is written (an aggregate stage,
  // a pivot, a semantic model) — or, with `over`, sum / average / min / max / count compute over a window
  ...Object.fromEntries(['sum', 'average', 'min', 'max', 'count_distinct', 'approx_count_distinct', 'median', 'stddev', 'variance', 'hll_init', 'hll_merge', 'hll_merge_partial'].map((fn) => [fn, aggregate(fn)])),
  count: aggregate('count', { args: { min: 0, max: 1 }, title: '[] counts the rows, [x] the rows where x is present' }),
  percentile: aggregate('percentile', { needs: ['percentile'] }),
  // window functions: each over its `over` — the rank of a row, the value of a neighbour
  row_number: { kind: 'window', args: 0, needs: ['over'], sql: ({ d, cols, p, opts }) => ({ expr: `row_number() ${overSql(d, cols, p.over, { opts })}`, type: 'int' }) },
  rank: { kind: 'window', args: 0, needs: ['over'], sql: ({ d, cols, p, opts }) => ({ expr: `rank() ${overSql(d, cols, p.over, { opts })}`, type: 'int' }) },
  dense_rank: { kind: 'window', args: 0, needs: ['over'], sql: ({ d, cols, p, opts }) => ({ expr: `dense_rank() ${overSql(d, cols, p.over, { opts })}`, type: 'int' }) },
  lag: { kind: 'window', args: 1, needs: ['over'], may: ['offset', 'default'], sql: ({ d, cols, a, t, p, opts }) => ({ expr: `lag(${a[0]}, ${p.offset ?? 1}${p.default !== undefined ? `, ${d.sqlLiteral(p.default)}` : ''}) ${overSql(d, cols, p.over, { opts })}`, type: t[0] || 'unknown' }) },
  lead: { kind: 'window', args: 1, needs: ['over'], may: ['offset', 'default'], sql: ({ d, cols, a, t, p, opts }) => ({ expr: `lead(${a[0]}, ${p.offset ?? 1}${p.default !== undefined ? `, ${d.sqlLiteral(p.default)}` : ''}) ${overSql(d, cols, p.over, { opts })}`, type: t[0] || 'unknown' }) },
};

const kindOf = (fn) => FNS[fn].kind || 'scalar';
/** The scalar functions: neither a condition, logic, an aggregate nor a window. */
export const SCALAR_FNS = Object.keys(FNS).filter((fn) => kindOf(fn) === 'scalar');

// ── The places an expression stands in ───────────────────────────────────────────────────────────────

/** The leaves of the rows a step reads, each told apart by the field that names it: the fields its form
 *  takes, and how a refusal says it. */
const ROW_LEAVES = {
  column: { fields: ['column'], says: '{ column }' },
  property: { fields: ['property', 'field'], says: '{ property }' },
  value: { fields: ['value'], says: '{ value }' },
  now: { fields: ['now'], says: '{ now: true }' },
};
/** Every leaf of the one expression: the rows' own, and the refs that name a value (src/schema/refs.js). */
const LEAVES = { ...ROW_LEAVES, ...Object.fromEntries(VALUE_REFS.map((k) => [k, REFS[k]])) };

/** Which leaf an expression is (a ref by its fields first: { source, column } is no { column }), or null. */
const leafKind = (e) => refKind(e) || Object.keys(ROW_LEAVES).find((k) => Object.hasOwn(e, k)) || null;

/** The scalar functions a where before a metrics step leaves out: raw, whose dialect SQL would reach
 *  MetricFlow's where, which MetricFlow renders as Jinja; and those that read an array, a JSON document or
 *  a sketch — never what a dimension holds. */
const NOT_OVER_DIMENSIONS = new Set(['raw', 'json_parse_array', 'json_field', 'array_length', 'array_contains', 'element_at', 'array_last', 'hll_extract']);

/**
 * THE PLACES — what each place an expression stands in takes of the one grammar: its `leaves` (by kind)
 * and its `fns`, whether a window may stand there, and whether its rows are a source's (`entities`: a
 * window may restart per a relationship the source declares, { entity }). The writer refuses anything else as it builds the
 * value (exprSql's `place`), naming the place (`what`) and what it takes, with the place's `hint` where
 * something it refuses has a home elsewhere. A tool's `$defs.expr` holds what its places take together
 * (exprSchema's `places`); each place narrows it further, as the value is built.
 *   source_rows    — a pipeline step over a source's rows (a build, an eventstream's start);
 *   stored_rows    — rows without a payload: a read of a stored table, the steps after a metrics step,
 *                    a card's drill (a feature's filter over its own rows passes a place of this shape);
 *   semantic_model — a semantic model's where, its computed dimensions and its measures (no raw: its SQL
 *                    would reach MetricFlow unchecked, a semantic model's columns are not tracked; no
 *                    window: a semantic model has no order of rows);
 *   metric_where   — a where step before a metric query's metrics step, the rows its metrics fold: what
 *                    group_by names, and constants;
 *   derived_metric — a derived metric's value: other metrics and constants, in arithmetic.
 */
export const PLACES = {
  source_rows: {
    what: 'a step over a source\'s rows', leaves: ['column', 'property', 'value', 'now'], fns: Object.keys(FNS), windows: true, entities: true,
    hint: 'A column of another model arrives by a join stage (its attrs), and a metric is query_semantic_model\'s',
  },
  stored_rows: {
    what: 'a read of stored rows', leaves: ['column', 'value', 'now'], fns: Object.keys(FNS).filter((fn) => fn !== 'raw'), windows: true,
    hint: 'Raw SQL and an event property are a build\'s: build from the task — build_pipeline_model({ request: { action: "start", name, from_task } }) (a pipeline build\'s task, or a query run with materialize: true)',
  },
  semantic_model: {
    what: 'a semantic model\'s where, dimension or measure', leaves: ['column', 'property', 'value', 'now'], fns: [...CONDITION_FNS, ...LOGIC_FNS, ...SCALAR_FNS.filter((fn) => fn !== 'raw'), ...TASK_MEASURE_AGGS], windows: false,
    hint: 'A window or raw SQL is a pipeline\'s (build_pipeline_model)',
  },
  metric_where: {
    what: 'a where before the metrics step', leaves: [...REF_PLACES.group_by.takes, 'value'], fns: [...CONDITION_FNS, ...LOGIC_FNS, ...SCALAR_FNS.filter((fn) => !NOT_OVER_DIMENSIONS.has(fn))], windows: false,
    hint: 'It filters the rows a metric folds, named as group_by names them; an aggregate is what a metric\'s measure is, and a condition on a metric\'s value is a where step after the metrics step',
  },
  derived_metric: {
    what: 'a derived metric\'s expr', leaves: ['metric', 'value'], fns: ['add', 'sub', 'mul', 'div', 'round', 'floor', 'ceil', 'abs', 'coalesce', 'least', 'greatest'], windows: false,
    hint: 'What a metric folds is its measure\'s',
  },
};

/** A place by its name, or the place itself (a feature passes one of its own, of the same shape). */
const placeOf = (place) => (typeof place === 'string' ? PLACES[place] : place) || null;

/** How each kind of function is called, for saying what a place takes. */
const KIND_SAID = { condition: 'the conditions', logic: 'and / or / not', scalar: 'the scalar functions', aggregate: 'the aggregates', window: 'the window functions' };

/** The functions of a place, said plainly: every one but a few, or kind by kind — a whole kind by its
 *  name, most of one as that kind but the few it leaves out, a few of one by their names. */
function fnsSaid(fns) {
  const all = Object.keys(FNS);
  const left = all.filter((fn) => !fns.includes(fn));
  if (!left.length) return 'every function';
  if (left.length <= 3) return `every function but ${left.join(', ')}`;
  return Object.keys(KIND_SAID).flatMap((kind) => {
    const of = all.filter((fn) => kindOf(fn) === kind);
    const taken = of.filter((fn) => fns.includes(fn));
    if (!taken.length) return [];
    if (taken.length === of.length) return [KIND_SAID[kind]];
    const out = of.filter((fn) => !taken.includes(fn));
    return [out.length < taken.length && out.length <= 8 ? `${KIND_SAID[kind]} but ${out.join(', ')}` : taken.join(', ')];
  }).join('; ');
}

/** What a place takes, said whole: its leaves, its functions, whether a window stands there, and its hint. */
const placeSaid = (p) => `${p.leaves.map((k) => LEAVES[k].says).join(', ')}, and ${fnsSaid(p.fns)}${p.windows ? '' : ', with no window'}${p.hint ? `. ${p.hint}` : ''}`;

/** The refusal of what a place does not take: `what` (a leaf, a function), named with the place. */
const notTaken = (p, what, at) => new Error(`${at}: ${what} is not what ${p.what} takes — it takes ${placeSaid(p)}`);

/** The parameter a function's spec names, as the caller writes it (`over_frame` is written `over`). */
const written = (name) => (name === 'over_frame' ? 'over' : name);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Whether an expression calls a window: a window function, or an aggregate given `over`. */
export const isWindowCall = (e) => isObj(e) && Object.hasOwn(FNS, e.fn ?? '') && (kindOf(e.fn) === 'window' || (kindOf(e.fn) === 'aggregate' && e.over !== undefined));
/** Whether an expression calls an aggregate that folds rows (an aggregate with no `over`). */
export const isAggregateCall = (e) => isObj(e) && Object.hasOwn(FNS, e.fn ?? '') && kindOf(e.fn) === 'aggregate' && e.over === undefined;
/** Whether an expression is a condition or a logic function — a boolean by what it is. */
export const isConditionCall = (e) => isObj(e) && (CONDITION_FNS.includes(e.fn) || LOGIC_FNS.includes(e.fn));

// ── The leaves, as the schema offers them ────────────────────────────────────────────────────────────
/** { column } — a column of the rows here (checked when built, with the columns there are). */
export const columnLeaf = (description = 'A column of the rows here: a pipeline step\'s, a stored table\'s, a semantic model\'s (a column, an entity key, an amount the catalog marks aggregatable).') => form({ title: 'a column — { column }', required: ['column'], properties: { column: { type: 'string', description } } });
/** { value } — a constant: a string, a number, a boolean or null; never a list. */
export const valueLeaf = () => form({ title: 'a constant — { value }', required: ['value'], properties: { value: { ...SCALAR, description: 'A string, a number, a boolean or null — never a list (in / not_in take each member as an argument of its own). A constant is compared in the type of what it meets.' } } });
/** { now: true } — the current time. */
export const nowLeaf = () => form({ title: 'the current time — { now: true }', required: ['now'], properties: { now: { const: true } } });
/** { property, field? } — an event property among `values`, read where it is stored, of the type the
 *  catalog declares. (The enum carries no sentence of its own: the transport folds it with a ref's that
 *  lists the same names.) */
export const propertyLeaf = (values) => form({
  title: 'an event property — { property }', required: ['property'],
  description: 'An event property of the pipeline\'s or the semantic model\'s source (semantic_index lists them) — a scalar, an array or a JSON object, read where it is stored (its own column, or the event_data payload) as the type the catalog declares; cast converts it.',
  properties: {
    property: strEnum(values || []),
    field: { type: 'string', description: 'One field of a JSON object property, read as text.' },
  },
});

/** The shapes a function is offered in: an aggregate in two when it is windowable — folding rows and
 *  over a window (with `over`, which the fold does not take) — so the forms stay apart by the field one
 *  of them requires. */
function shapesOf(fn) {
  const s = FNS[fn];
  const base = { args: s.args, title: s.title || null, needs: s.needs || [], may: s.may || [] };
  if (kindOf(fn) === 'aggregate') {
    return [
      { ...base, label: 'an aggregate' },
      ...(s.windowable ? [{ ...base, needs: [...base.needs, 'over_frame'], label: 'over a window', window: true }] : []),
    ];
  }
  return [{ ...base, window: kindOf(fn) === 'window', label: kindOf(fn) === 'condition' ? 'a condition' : kindOf(fn) === 'logic' ? 'logic' : null }];
}

/** Where the one expression is defined in every tool schema that takes one. */
export const EXPR_REF = '#/$defs/expr';

/** Places by their PLACES names (or places of that shape, as a feature passes) — null for none named. */
function exprPlacesOf(places) {
  if (!places?.length) return null;
  return places.map((p) => {
    const place = placeOf(p);
    if (!place) throw new Error(`exprSchema: no expression place '${p}'`);
    return place;
  });
}

/** How the description says each of the rows' leaves. */
const LEAF_SAID = {
  column: 'a column of the rows here { column }',
  property: 'an event property of the source { property, field? }',
  value: 'a constant { value }',
  now: 'the current time { now: true }',
};

/** A list said in words: "a, b or c". */
const either = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0] || '');

/**
 * THE EXPRESSION SCHEMA — `$defs.expr` of every tool that takes an expression, ONE definition built by
 * this one builder for the PLACES of that tool (PLACES names, or places of that shape; none named —
 * everything): the leaves those places take (the rows' { column }, { property } of the catalog's events,
 * { value }, { now }, and the refs that name a value — src/schema/refs.js, with the catalog's names closed
 * per source and, given `project`, the dbt project's semantic models and entities) and the functions they
 * take, a window's form only where one of them takes windows, recursive through `#/$defs/expr` (every
 * argument and a CASE's branches refer back to it). One form per function SHAPE — the
 * functions that take the same arguments and parameters share one, tagged by those of them the places
 * take — each with exactly its own fields. Places of one tool that take different parts share the one
 * definition, never one each: what each takes is the writer's check (PLACES) as the value is built.
 */
export function exprSchema(catalog, { project = null, places = null } = {}) {
  const ref = EXPR_REF;
  const at = exprPlacesOf(places);
  // a window restarts per a declared relationship only over a source's rows
  const entities = !at || at.some((p) => p.entities);
  const P = params(catalog, { ref, entities });
  const leaves = Object.keys(LEAVES).filter((k) => !at || at.some((p) => p.leaves.includes(k)));
  const offered = Object.keys(FNS).filter((fn) => !at || at.some((p) => p.fns.includes(fn)));
  const windows = !at || at.some((p) => p.windows);
  const byShape = new Map();
  for (const fn of offered) {
    for (const shape of shapesOf(fn)) {
      if (shape.window && !windows) continue;
      const key = JSON.stringify(shape);
      if (!byShape.has(key)) byShape.set(key, { ...shape, fns: [] });
      byShape.get(key).fns.push(fn);
    }
  }
  // A form says how MANY arguments its functions take; WHAT each argument is — an expression — is said
  // once, beside the forms (the union's own `properties`). Said inside every form, a validator reading all
  // of a value's errors would check the arguments once per form whose `fn` is not the value's, at every
  // level of nesting: exponential in the depth of the expression (seconds for an or of ands). Beside
  // them, once per node.
  const argsOf = (n) => {
    const { min, max } = typeof n === 'number' ? { min: n, max: n } : { min: n.min, max: n.max };
    return { type: 'array', minItems: min, ...(max !== undefined ? { maxItems: max } : {}) };
  };
  const forms = [...byShape.values()].map(({ args, title, needs, may, fns: names, label }) => {
    const takesArgs = args !== 0;
    const required = typeof args === 'number' ? args > 0 : args.min > 0;
    const fields = Object.fromEntries([...needs, ...may].map((n) => [written(n), P[n]]));
    return form({
      title: `fn: ${names.join(' | ')}${title ? ` — args ${title}` : ''}${label ? ` (${label})` : ''}`,
      tag: ['fn', names],
      required: [...(takesArgs && required ? ['args'] : []), ...needs.map(written)],
      properties: { ...(takesArgs ? { args: argsOf(args) } : {}), ...fields },
    });
  });
  const rowLeaf = { column: () => columnLeaf(), property: () => propertyLeaf(catalog?.eventPropEnum ? catalog.eventPropEnum() : []), value: valueLeaf, now: nowLeaf };
  const leafForms = [...Object.keys(ROW_LEAVES).filter((k) => leaves.includes(k)).map((k) => rowLeaf[k]()), ...valueRefForms(catalog, { project, kinds: leaves })];
  // what the definition holds, said from what it holds — and, where the tool's places take different parts
  // of it, what each takes, read off the one table, so the description and the refusals say the same
  const has = (...fns) => fns.every((fn) => offered.includes(fn));
  const refLeaves = VALUE_REFS.filter((k) => leaves.includes(k));
  const leafSaid = [...Object.keys(ROW_LEAVES).filter((k) => leaves.includes(k)).map((k) => LEAF_SAID[k]), ...(refLeaves.length ? [`what a ref names that holds a value (${refLeaves.map((k) => REFS[k].says).join(', ')})`] : [])];
  // the places the definition is for, each once (none named: every place there is)
  const ownPlaces = at ? at.filter((p, i) => at.findIndex((q) => q.what === p.what) === i) : Object.values(PLACES);
  const noRaw = at && has('raw') ? ownPlaces.filter((p) => !p.fns.includes('raw')).map((p) => `${p.what} takes no raw`) : [];
  const text = [
    `An expression: a leaf — ${either(leafSaid)} — or a function { fn, args: [expressions], …its parameters }, its arguments expressions themselves, nested to any depth.`,
    ...(ownPlaces.length > 1 ? [`Each place takes some of them, and a refusal says which — ${ownPlaces.map((p) => `${p.what}: ${p.leaves.map((k) => LEAVES[k].says).join(', ')}`).join('; ')}${noRaw.length ? `; ${noRaw.join('; ')}` : ''}.`] : []),
    // where what a place leaves out is written instead — its hint, as its refusal says it
    ...(at ? ownPlaces.filter((p) => p.hint).map((p) => (ownPlaces.length > 1 ? `For ${p.what}: ${p.hint.charAt(0).toLowerCase()}${p.hint.slice(1)}.` : `${p.hint}.`)) : []),
    ...(leaves.includes('column') && has('round', 'div', 'sub') ? ['round((a - b) / b, 2): { fn: "round", args: [{ fn: "div", args: [{ fn: "sub", args: [{ column: "a" }, { column: "b" }] }, { column: "b" }] }], places: 2 }.'] : []),
    ...(CONDITION_FNS.some((fn) => offered.includes(fn)) ? ['A condition is a function: eq / neq / gt / gte / lt / lte [a, b], in / not_in [a, member, …], between [a, low, high], is_null / is_not_null [a], like / not_like / contains / starts_with / ends_with [text, pattern]; and / or join two or more, not negates one. A constant is compared in the type of what it meets; a comparison with a missing value does not hold — test it with is_null.'] : []),
    ...(AGGREGATE_FNS.some((fn) => offered.includes(fn)) ? ['An aggregate (sum, average, min, max, count — with no args it counts rows —, count_distinct, median, percentile with `percentile`, …) folds rows where a measure is written, skipping a missing value. A conditional one folds a case, missing on the other rows — the rows where c holds { fn: "count", args: [{ fn: "case", cases: [{ when: [c], then: { value: 1 } }] }] }, their revenue { fn: "sum", args: [{ fn: "case", cases: [{ when: [c], then: { column: "price" } }] }] } — with no else, which would fold the other rows too (sum alone may keep else: 0).'] : []),
    ...(windows ? ['With `over`, sum / average / min / max / count — and row_number, rank, dense_rank, lag, lead — compute over a window of rows, in a compute stage.'] : []),
    ...(has('raw') ? ['raw is a build\'s escape hatch: dialect SQL in `sql`, its columns in `args` ({1}, {2}, … in the SQL).'] : []),
  ].join(' ');
  // what an argument is, said once beside the forms that take one
  const nested = {
    ...(forms.some((f) => f.properties.args) ? { args: { type: 'array', items: { $ref: ref }, description: 'A function\'s arguments, each an expression.' } } : {}),
  };
  return { type: 'object', description: text, properties: nested, anyOf: [...leafForms, ...forms] };
}

// ── The writer ───────────────────────────────────────────────────────────────────────────────────────

/** What a refusal calls a written argument. */
const said = (r) => (r.constant ? `the constant ${JSON.stringify(r.value)}` : r.name ? `'${r.name}' (${r.type || 'of unknown type'})` : `an expression of type ${r.type || 'unknown'}`);
/** Whether a written argument is a boolean — or may be one: nothing is known of its type. */
const mayBeBoolean = (r) => (r.constant ? typeof r.value === 'boolean' : r.type === 'boolean' || r.type == null || r.type === 'unknown');

/** A refusal of a value written in an earlier spelling of the grammar, with the value it is now — a
 *  typed property read converted as the catalog of the rows types the property (`opts`: catalog, source). */
function earlier(e, at, opts = {}) {
  const now = currentOf(e, { propertyType: propertyTypes(opts.catalog, opts.source) });
  return now !== e && JSON.stringify(now) !== JSON.stringify(e) ? new Error(`${at}: ${JSON.stringify(e)} is an earlier spelling — write ${JSON.stringify(now)}`) : null;
}

/** Whether an expression is the constant null — what a case yields where no branch holds. */
const isNull = (x) => isObj(x) && x.fn === undefined && Object.keys(x).length === 1 && Object.hasOwn(x, 'value') && x.value === null;

/** The aggregate `e` folding only the rows where `conds` hold: its argument a case that yields it there
 *  (1 for a count of the rows) and nothing elsewhere. An argument that is a case already gets them in
 *  every branch, its else only where they hold — so an else the aggregate is refused for stays its own
 *  (a pivot's cell, src/pipeline/stages.js). */
export function foldWhere(e, conds) {
  const [arg] = Array.isArray(e.args) ? e.args : [];
  if (isObj(arg) && arg.fn === 'case' && Array.isArray(arg.cases)) {
    const { else: other, ...rest } = arg;
    const cases = arg.cases.map((cs) => ({ ...cs, when: [...conds, ...(Array.isArray(cs.when) ? cs.when : [])] }));
    return { ...e, args: [{ ...rest, cases, ...(other !== undefined && !isNull(other) ? { else: { fn: 'case', cases: [{ when: conds, then: other }] } } : {}) }] };
  }
  return { ...e, args: [{ fn: 'case', cases: [{ when: conds, then: arg === undefined ? { value: 1 } : arg }] }] };
}

function writer(d, cols, opts) {
  const groupBy = new Set(opts.groupBy || []);
  const aggregateLevel = opts.context === 'aggregate' || opts.context === 'measure';
  const offeredAggregates = opts.aggregates ? new Set(opts.aggregates) : null;
  // the place the expression stands in — what it takes of the grammar (PLACES); with none named, every
  // leaf the rows have and every function, the level's own leaves resolved by `opts.leaf` first
  const place = placeOf(opts.place);
  let aggregates = 0;

  // outside an aggregate, a measure reads only what is the same on every row of a group
  const groupRule = (name, at, s) => {
    if (!aggregateLevel || s.inAggregate || groupBy.has(name)) return;
    throw new Error(`${at}: '${name}' stands outside an aggregate, so it has to be one of the group_by columns (${[...groupBy].join(', ') || 'none'}) — group by it, or fold it ({ fn: "max", args: [{ column: "${name}" }] })`);
  };

  // a leaf of `kind` where the place stands: refused when the place does not take it
  const takes = (kind, at) => { if (place && !place.leaves.includes(kind)) throw notTaken(place, LEAVES[kind].says, at); };

  function leaf(e, at, s) {
    if (!place && opts.leaf) {
      const hooked = opts.leaf(e, at, s);
      if (hooked) return hooked;
    }
    const kind = leafKind(e);
    const def = kind ? LEAVES[kind] || REFS[kind] : null;
    const stray = def ? Object.keys(e).filter((k) => !def.fields.includes(k)) : [];
    if (!def || stray.length) {
      throw earlier(e, at, opts) || new Error(def
        ? `${at}: ${def.says} takes ${def.fields.join(', ')}, not ${stray.join(', ')}`
        : `${at}: an expression is ${(place ? place.leaves : Object.keys(ROW_LEAVES)).map((k) => LEAVES[k].says).join(', ')} — or a function { fn, args, … }`);
    }
    if (!LEAVES[kind]) throw new Error(`${at}: ${def.says} names no value — an expression's leaves are ${place ? place.leaves.map((k) => LEAVES[k].says).join(', ') : Object.values(LEAVES).map((l) => l.says).join(', ')}`);
    takes(kind, at);
    // a place's own leaves — a metric, what a metric query's group_by names, a declared amount — are the
    // level's to resolve
    if (place && opts.leaf) {
      const hooked = opts.leaf(e, at, s);
      if (hooked) return hooked;
    }
    if (!ROW_LEAVES[kind]) throw new Error(`${at}: ${def.says} is not resolved here${place ? ` (${place.what})` : ''}`);
    if (kind === 'column') {
      groupRule(e.column, at, s);
      if (cols) requireCol(cols, e.column);
      const c = cols?.get(e.column);
      return { sql: d.quoteIdent(e.column), type: c?.type ?? opts.columnType?.(e.column) ?? null, physical: !!c?.physical, name: e.column };
    }
    if (kind === 'property') {
      groupRule(e.property, at, s);
      return { ...propertyRead('value', { d, cols, catalog: opts.catalog, source: opts.source, property: e.property, field: e.field, as: e.field === undefined ? s.readAs : undefined, at }), name: e.property };
    }
    if (kind === 'now') {
      if (e.now !== true) throw new Error(`${at}: the current time is { now: true }`);
      return { sql: d.nowExpr(), type: 'time', name: 'now' };
    }
    const v = e.value;
    // a list is no constant: in / not_in take each member as an argument of its own
    if (Array.isArray(v) || isObj(v)) throw new Error(`${at}: a constant is a string, a number, a boolean or null — a list is written as arguments of their own ({ fn: "in", args: [<the expression>, { value: "a" }, { value: "b" }] })`);
    return { sql: d.sqlLiteral(v), type: typeof v === 'number' ? 'numeric' : typeof v === 'boolean' ? 'boolean' : v === null ? null : 'string', constant: true, value: v };
  }

  // an array function: of an array property read where it is stored, or of an expression yielding one
  function arrayCall(e, at, s) {
    const [arr, item] = e.args || [];
    const kind = FNS[e.fn].array;
    if (kind === 'contains' && !(isObj(item) && item.fn === undefined && Object.keys(item).length === 1 && Object.hasOwn(item, 'value') && !isObj(item.value) && !Array.isArray(item.value))) {
      throw new Error(`${at}: array_contains takes [array, { value }] — the element looked for is a constant`);
    }
    const v = item?.value;
    if (isObj(arr) && arr.fn === undefined && arr.property !== undefined && arr.source === undefined) {
      if (arr.field !== undefined || arr.type !== undefined) throw new Error(`${at}: ${e.fn} reads the array itself — { property: '${arr.property}' }, with no field`);
      takes('property', `${at} ${e.fn} args[0]`);
      groupRule(arr.property, at, s);
      return { ...propertyRead(kind, { d, cols, catalog: opts.catalog, source: opts.source, property: arr.property, item: v, at }), name: `${e.fn}(${arr.property})` };
    }
    const r = render(arr, `${at} ${e.fn} args[0]`, s);
    if (r.constant) throw new Error(`${at}: ${e.fn} reads an array — an array { property } of the source, or an expression that yields one (json_parse_array)`);
    // text holding a JSON array is read as one; anything else has to be an array
    const json = r.type === 'json' || r.type === 'string';
    if (!json) needsArray(e.fn, r.type);
    if (kind === 'length') return { sql: json ? d.jsonColumnArrayLength(r.sql) : d.arrayLength(r.sql), type: 'int' };
    return { sql: json ? d.jsonColumnArrayContains(r.sql, v) : d.arrayContains(r.sql, v), type: 'boolean' };
  }

  function render(e, at, s) {
    if (!isObj(e)) throw new Error(`${at}: an expression is an object — { column }, { property }, { value }, { now: true } or a function { fn, args, … }`);
    if (e.fn === undefined) return leaf(e, at, s);
    const spec = Object.hasOwn(FNS, e.fn) ? FNS[e.fn] : null;
    if (!spec) {
      const wrong = earlier(e, at, opts);
      if (wrong) throw wrong;
      const near = typeof e.fn === 'string' ? rankFuzzy(e.fn, Object.keys(FNS), { fields: (x) => [x], limit: 3 }).map((x) => x.item) : [];
      throw new Error(`${at}: unknown function '${e.fn}'${near.length ? ` — did you mean ${near.map((x) => `'${x}'`).join(' or ')}?` : ''} (the functions: ${Object.keys(FNS).join(', ')})`);
    }
    const fn = e.fn;
    const kind = kindOf(fn);
    const window = kind === 'window' || (spec.windowable && e.over !== undefined);
    const folds = kind === 'aggregate' && !window;
    // what the place takes: its functions, and a window only where one may stand
    if (place && !place.fns.includes(fn)) throw notTaken(place, fn, at);
    if (place && window && !place.windows) throw notTaken(place, `a window (${fn} with over)`, at);
    // the fields a call may carry: its function's parameters, and over where it is a window
    const allowed = new Set(['fn', ...(spec.args !== 0 ? ['args'] : []), ...(spec.needs || []).map(written), ...(spec.may || []).map(written), ...(window ? ['over'] : [])]);
    const stray = Object.keys(e).filter((k) => !allowed.has(k));
    if (stray.length) {
      if (stray.includes('over') && kind !== 'window' && !spec.windowable) throw new Error(`${at}: ${fn} takes no \`over\` — a window is ${WINDOW_FNS.join(', ')}, or ${WINDOW_AGGREGATE_FNS.join(' / ')} over rows`);
      if (stray.includes('where') && window) throw new Error(`${at}: ${fn} over a window takes no \`where\` — a conditional window folds a CASE: { fn: "${fn}", args: [{ fn: "case", cases: [{ when: [...], then: <the value> }] }], over }`);
      throw earlier(e, at, opts) || new Error(`${at}: ${fn} takes ${[...allowed].filter((k) => k !== 'fn').join(', ') || 'no field'}, not ${stray.join(', ')}`);
    }
    const args = e.args || [];
    if (!Array.isArray(args)) throw new Error(`${at}: ${fn} takes \`args\` as a list of expressions`);
    const { min, max } = typeof spec.args === 'number' ? { min: spec.args, max: spec.args } : { min: spec.args.min, max: spec.args.max ?? Infinity };
    if (args.length < min || args.length > max) throw new Error(`${at}: ${fn} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? '' : 's'}${spec.title ? ` ${spec.title}` : ''}, not ${args.length}`);
    for (const n of spec.needs || []) if (e[written(n)] === undefined) throw new Error(`${at}: ${fn} needs \`${written(n)}\``);
    if (kind === 'window' && e.over === undefined) throw new Error(`${at}: ${fn} needs \`over\``);
    // an aggregate folds the rows its argument has a value on: a case's else gives one to the rows no
    // branch takes, so every other aggregate folds those too — only a sum of them is the same with 0s
    if (kind === 'aggregate' && fn !== 'sum' && isObj(args[0]) && args[0].fn === 'case' && args[0].else !== undefined && !isNull(args[0].else)) {
      throw new Error(`${at}: ${fn} over a case with an else folds every row, the rows no branch takes too (as the else's value) — leave the else out: those rows are then missing, and ${fn} skips them. (Only sum may keep one, else: 0 adding nothing.)`);
    }
    // WHERE each kind may stand
    if (window) {
      if (s.noWindows) throw new Error(`${at}: a window function (${fn} with over) cannot stand in a condition — a where keeps rows before any window is computed. Compute it into a column first (a compute stage), then filter on that column`);
      if (s.inWindow) throw new Error(`${at}: a window function (${fn}) cannot be an argument of another window function — compute the inner one into a column first (a compute stage), then use that column`);
      if (s.inAggregate) throw new Error(`${at}: a window function (${fn}) cannot be an aggregate's argument — compute it into a column first (a compute stage), then fold that column`);
      if (aggregateLevel) throw new Error(`${at}: a measure folds a group's rows into one value, and a window (${fn} with over) keeps every row — compute the window in a compute stage before the aggregate, then fold its column`);
    }
    if (folds) {
      if (s.inAggregate) throw new Error(`${at}: ${fn} cannot fold the result of another aggregate — an aggregate of aggregates is a second aggregate stage over the first one's columns`);
      if (!aggregateLevel) throw new Error(`${at}: ${fn} with no \`over\` folds many rows into one value, which a row cannot hold — fold rows in an aggregate stage's measure (or a pivot's), or give it \`over\` to compute it over a window in a compute stage`);
      if (offeredAggregates && !offeredAggregates.has(fn)) throw new Error(`${at}: ${fn} is not an aggregate this measure takes (${[...offeredAggregates].join(', ')})`);
      if (fn === 'percentile' && !(typeof e.percentile === 'number' && e.percentile > 0 && e.percentile < 1)) throw new Error(`${at}: percentile needs \`percentile\` in (0,1), e.g. 0.95 for p95`);
      aggregates += 1;
    }
    if (spec.array) return arrayCall(e, at, s);
    // an aggregate's argument is refused a window as an aggregate's (inAggregate); a case's conditions
    // are a condition slot, which refuses one as a condition's (conditions() sets noWindows)
    const inner = folds ? { ...s, inAggregate: true } : window ? { ...s, inWindow: true } : s;
    // a cast of an event property is the property read as that type where it is read (a payload key
    // extracted once, as the cast type)
    const castsRead = fn === 'cast' && isObj(args[0]) && args[0].fn === undefined && args[0].property !== undefined;
    const r = args.map((x, i) => render(x, `${at} ${fn} args[${i}]`, castsRead && i === 0 ? { ...inner, readAs: e.type } : inner));
    if (castsRead && r[0].readAs === e.type) return { sql: r[0].sql, type: e.type, name: `${fn}(…)` };
    if (kind === 'logic') {
      r.forEach((x, i) => { if (!mayBeBoolean(x)) throw new Error(`${at} ${fn} args[${i}]: ${fn} takes conditions — a comparison ({ fn: "eq", args: [...] }), and / or / not, or a boolean column; this is ${said(x)}`); });
    }
    const out = spec.sql({
      d, cols, opts, at, scope: { ...s, aggregateLevel: aggregateLevel && !s.inAggregate }, window,
      a: r.map((x) => x.sql), t: r.map((x) => x.type), r, p: e,
      sub: (x, what) => render(x, `${at} ${fn} ${what}`, inner),
      conds: (list, what) => conditions(list, `${at} ${fn} ${what}`, inner),
    });
    return { sql: out.expr, type: out.type || 'numeric', name: `${fn}(…)` };
  }

  // a condition slot: a list of booleans that all hold; no window can stand in one
  function conditions(list, at, s) {
    if (!Array.isArray(list) || !list.length) throw new Error(`${at}: a list of conditions that all hold — at least one`);
    return list.map((c, i) => {
      const where = `${at}[${i}]`;
      const r = render(c, where, { ...s, noWindows: true });
      if (!mayBeBoolean(r)) throw new Error(`${where}: a where takes conditions — a comparison ({ fn: "eq", args: [...] }), and / or / not, or a boolean column; this is ${said(r)}`);
      return r.sql;
    });
  }

  return { render, conditions, aggregates: () => aggregates };
}

/**
 * THE ONE WRITER: an expression's SQL and type over the columns at this step (`cols`, a Map name →
 * { type, physical? }; null where columns are not tracked — a { column } is then taken as written, its
 * type `opts.columnType(name)`). `at` names it in a refusal. `opts`:
 *   place           — where it stands (a PLACES name, or a place of that shape): a leaf or a function the
 *                     place does not take is refused, naming the place and what it takes;
 *   catalog, source — what a { property } is read from and a window's { entity } resolved against;
 *   leaf(e, at)     — a place's own leaves (a metric, what a metric query's group_by names, a declared
 *                     amount): { sql, type, … } for one it resolves, undefined to fall back to the rows'
 *                     { column } / { property } / { value } / { now } (asked after the place's check);
 *   context         — 'row' (default: a compute stage's expression; no aggregate without over, a window
 *                     only with `windows` not false), 'aggregate' (a measure of an aggregate stage or a
 *                     pivot: aggregates combined by scalar functions, at least one, and a column outside
 *                     them one of `groupBy`; no window), 'measure' (a semantic measure: ONE aggregate at
 *                     the top, of `aggregates` when given);
 *   windows         — false where no window may stand (a where);
 *   castToConstant  — a column compared with constants is read as their kind (the retentioneering filter).
 * → { sql, type, physical? }
 */
export function exprSql(d, cols, e, at = 'expression', opts = {}) {
  if (opts.context === 'measure' && !isAggregateCall(e)) {
    throw (isObj(e) && earlier(e, at, opts)) || new Error(`${at}: a measure is ONE aggregate — { fn: "sum" | "average" | "count" | …, args: [<a row expression>] } (the rows where a condition holds: a case) — a formula over several aggregates is several measures and a derived metric`);
  }
  const w = writer(d, cols, opts);
  const r = w.render(e, at, { inAggregate: false, inWindow: false, noWindows: opts.windows === false });
  if ((opts.context === 'aggregate' || opts.context === 'measure') && !w.aggregates()) {
    throw new Error(`${at}: a measure folds rows, so it needs an aggregate — sum, count, average, … (e.g. { fn: "sum", args: [{ column: "price" }] }); a constant or a column alone is no measure`);
  }
  return { sql: r.sql, type: r.type, ...(r.physical ? { physical: true } : {}) };
}

/**
 * A CONDITION SLOT's SQL — a list of boolean expressions that all hold (a where stage, a funnel step, a
 * scope), one SQL per item, over the columns at this step. No window stands in one, and in a row a
 * condition folds no rows. `opts` as exprSql's.
 */
export function conditionListSql(d, cols, list, at = 'where', opts = {}) {
  return writer(d, cols, opts).conditions(list, at, { inAggregate: false, inWindow: false, noWindows: true });
}

// ── Reading expressions (to check, warn and convert) ────────────────────────────────────────────────

/** Every node of an expression — leaves and calls — visited once, in its arguments, a CASE's branches
 *  and their conditions. */
export function eachNode(e, visit) {
  if (Array.isArray(e)) { e.forEach((x) => eachNode(x, visit)); return; }
  if (!isObj(e)) return;
  visit(e);
  if (e.fn === undefined) return;
  eachNode(e.args, visit);
  for (const cs of Array.isArray(e.cases) ? e.cases : []) { eachNode(cs?.when, visit); eachNode(cs?.then, visit); }
  eachNode(e.else, visit);
}

/** Every function an expression calls, nested ones included (to find a window, a raw SQL). */
export function exprCalls(e, out = []) {
  eachNode(e, (n) => { if (n.fn !== undefined) out.push(n); });
  return out;
}

/** Every column an expression names ({ column } leaves), anywhere in it. */
export function exprColumns(e) {
  const out = new Set();
  eachNode(e, (n) => { if (n.fn === undefined && typeof n.column === 'string') out.add(n.column); });
  return [...out];
}

/** Every condition of a list, the logic functions opened (and / or / not): to read what each compares. */
export function eachCondition(list, visit) {
  for (const c of Array.isArray(list) ? list : []) {
    if (isObj(c) && LOGIC_FNS.includes(c.fn)) eachCondition(c.args, visit);
    else visit(c);
  }
}

/**
 * A condition that compares a column or an event property with constants — { subject: the leaf, op,
 * values } — or null: the first argument a bare { column } / { property }, every other a { value }.
 * What a scope reads (an event filter, a time bound, a value to verify).
 */
export function comparisonOf(e) {
  if (!isObj(e) || !CONDITION_FNS.includes(e.fn) || !Array.isArray(e.args) || !e.args.length) return null;
  const [subject, ...rest] = e.args;
  if (!isObj(subject) || subject.fn !== undefined || (subject.column === undefined && subject.property === undefined)) return null;
  if (!rest.every((x) => isObj(x) && x.fn === undefined && Object.hasOwn(x, 'value'))) return null;
  return { subject, op: e.fn, values: rest.map((x) => x.value) };
}

/** The expression with every aggregate that folds rows replaced by `f(call)` — an aggregate's own
 *  arguments are rows, and are left as they are (a pivot's cell folds each over its rows: foldWhere). */
export function mapAggregates(e, f) {
  if (Array.isArray(e)) return e.map((x) => mapAggregates(x, f));
  if (!isObj(e) || e.fn === undefined) return e;
  if (isAggregateCall(e)) return f(e);
  return {
    ...e,
    ...(Array.isArray(e.args) ? { args: e.args.map((x) => mapAggregates(x, f)) } : {}),
    ...(Array.isArray(e.cases) ? { cases: e.cases.map((cs) => (isObj(cs) ? { ...cs, when: mapAggregates(cs.when, f), then: mapAggregates(cs.then, f) } : cs)) } : {}),
    ...(e.else !== undefined ? { else: mapAggregates(e.else, f) } : {}),
  };
}
