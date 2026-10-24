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
// turns it into the schema every tool that takes an expression carries — the row expression `$defs.expr`,
// and, where a place takes a closed part of the grammar, that part as a kind of its own (EXPR_KINDS: a
// semantic measure's `$defs.aggregate`, a derived metric's `$defs.metric_expr`) — a closed form per leaf
// and per function shape, `args` referring to the kind's arguments, holding what the tool's own places
// take, a window function's `over` `$defs.over`, an aggregate over a window's `$defs.over_frame` (with its
// frame); one writer (exprSql, and conditionListSql
// for a condition slot) turns an expression into SQL. What a PLACE takes of it is one table (PLACES: the
// leaves and the functions of a pipeline step, a read, a semantic model, a where before a metrics step, a
// derived metric), read by the builder for a tool's definitions and checked by the writer as the value is
// built, and so are the rules of
// WHERE each kind may stand: an aggregate folds rows only where a measure is written, a window keeps them
// only in a compute stage, a condition slot takes booleans. A function is added in one place, and a
// parameter it does not read is not in its form, so it is refused instead of silently ignored.

import { GRAINS, TASK_MEASURE_AGGS } from '../catalog.js';
import { isNumericType, isTimeType } from '../dialects/base.js';
import { isArrayPropertyType, arrayColumnType, elementType, nativeArrayType, isBooleanType } from '../catalog/column-types.js';
// (sql.js is read when a function runs, never as this module loads)
import { fillPlaceholders, rawNamedColumns, unquotedSql, frameClause, requireCol, sqlAgg, TYPE, SORT_KEY, sourceProp, partitionItem, partitionColumn } from './sql.js';
import { OPS, predicateSql, typedValue } from '../conditions.js';
import { form, strEnum, SCALAR, conditionSlot } from '../schema-kit.js';
import { REFS, VALUE_REFS, REF_PLACES, refKind, valueRefForms } from '../schema/refs.js';
import { rankFuzzy } from '../fuzzy.js';
import { isValidTimezone } from '../time-range.js';

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
const ORDER = (refNames = false) => ({ type: 'array', items: refNames ? { ...SORT_KEY, properties: { ...SORT_KEY.properties, key: { anyOf: [SORT_KEY.properties.key, { $ref: '#/$defs/ref' }], description: 'The column to order by — after a metrics step also a group_by item as group_by names it, or { metric }.' } } } : SORT_KEY, description: 'Window ordering: each key a column, its direction and where its NULLs go (last unless said).' });
// `entities`: whether the rows are a source's, so a declared relationship { entity } may name a partition
const PARTITION = (catalog, entities, refNames = false) => ({ type: 'array', uniqueItems: true, items: refNames && !entities ? { anyOf: [{ title: 'a column', type: 'string', description: 'A column available here.' }, { $ref: '#/$defs/ref' }] } : partitionItem(catalog, { entities }), description: `What the window restarts per: columns${entities ? ', or a declared relationship { entity } (its key column)' : ''}. Without them the window is one global window over every row, held by one worker — on a large table, "Resources exceeded". For a table-wide number use an aggregate stage with no group_by instead.` });

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

/** Where the window is defined in every tool schema whose expression takes one: a window function's
 *  (`$defs.over`), and an aggregate over a window's, which also reads a frame (`$defs.over_frame`). */
export const OVER_REF = '#/$defs/over';
export const OVER_FRAME_REF = '#/$defs/over_frame';

/**
 * THE WINDOW — one builder for both of its definitions in a tool schema whose expression takes one: the
 * rows a window function or an aggregate over a window is computed over, restarted per `partition_by`, in
 * the order of `order_by` — `$defs.over`, what a rank or a neighbour reads (its partition whole) — and,
 * with `frame` (`$defs.over_frame`, an aggregate over a window's), the frame of them each value folds; so
 * a frame on a window function is refused by the schema, not ignored.
 * `entities`: whether the rows are a source's, so a partition may name a declared relationship.
 */
export function overSchema(catalog, { entities = true, frame = false, refNames = false } = {}) {
  return {
    type: 'object', additionalProperties: false,
    description: frame ? 'The window: the rows it is computed over, in order, and the frame of them each value reads.' : 'The window: the rows it is computed over, in order.',
    properties: { partition_by: PARTITION(catalog, entities, refNames), order_by: ORDER(refNames), ...(frame ? { frame: FRAME } : {}) },
  };
}

// the parameters a function may take, by name — each function's form picks its own. `ref` is the
// definition a CASE's branches and conditions are (expressions of the same kind as the case).
const params = ({ ref }) => ({
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
  timezone: { type: 'string', minLength: 1, description: 'An IANA timezone name (Europe/Berlin, America/New_York, UTC).' },
  clamp_zero: { type: 'boolean', description: 'Fold negative (before the start) and NULL (e.g. a missing install_date) results to 0, so it is a clean day 0+. Default true; false for the raw signed/NULL-able value.' },
  sql: { type: 'string', description: 'Dialect SQL — the escape hatch when no function fits; not portable. Columns are positional: each is an item of `args`, and {1}, {2}, … in the SQL stand where it goes, written quoted by the server. A word spelled exactly as a column of this step (or in identifier quotes) is refused, so write SQL keywords in upper case (DAY, DATE). It is one expression: no ; or comment, a text with one in `args` as { value }. E.g. { fn: "raw", sql: "POWER({1}, {2})", args: [{ column: "base" }, { column: "exponent" }] }.' },
  cases: { type: 'array', minItems: 1, description: 'CASE branches (the first that holds wins); each `when` a list of conditions that all hold, `then` an expression.', items: { type: 'object', additionalProperties: false, required: ['when', 'then'], properties: { when: conditionSlot(ref, 'The conditions this branch takes: all of them hold.'), then: { $ref: ref } } } },
  else: { $ref: ref, description: 'The value when no branch holds (default NULL — under an aggregate, the rows it leaves out). Under count / count_distinct leave it out: count would count those rows, count_distinct their else value as one more.' },
  offset: { type: 'integer', minimum: 1, description: 'Row offset (default 1).' },
  default: { ...SCALAR, description: 'The constant when the offset row does not exist.' },
  percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'The quantile in (0,1), e.g. 0.95 for p95.' },
  over: { $ref: OVER_REF },
});

// a window clause in raw SQL, outside its string literals, quoted names and comments
const RAW_OVER = /\bover\s*\(/i;

/** The type of a value picked from several (coalesce, least, greatest, a CASE's branches): the one its
 *  typed arguments share; numbers of any kind are numeric, moments of any kind a time; arguments of
 *  kinds that do not meet are 'unknown' (compared as written); with no typed argument, 'unknown' where
 *  one of them is of a type not known, else (only constant nulls) `fallback`. An untyped constant (null)
 *  says nothing. */
function commonType(types, fallback) {
  const typed = [...new Set(types.filter((t) => t && t !== 'unknown'))];
  if (!typed.length) return types.includes('unknown') ? 'unknown' : fallback;
  if (typed.length === 1) return typed[0];
  if (typed.every(isNumericType)) return 'numeric';
  if (typed.every(isTimeType)) return 'time';
  return 'unknown';
}

/** The texts of `parts` ({ sql, type?, declared? }) one after another, missing where any of them is
 *  missing — SQL's ||, on every warehouse (DuckDB's concat() would skip a NULL, BigQuery's returns one);
 *  a part that is not known to be text read as its text by the dialect's cast (BigQuery's || takes text
 *  alone). The one writer of a concatenation: concat's, and the eventstream's keys. */
/** least / greatest of the arguments, missing where any of them is (one rule on every warehouse). */
const pickedSql = (fn, a) => `CASE WHEN ${a.map((x) => `(${x}) IS NULL`).join(' OR ')} THEN NULL ELSE ${fn}(${a.join(', ')}) END`;

export function concatSql(d, parts) {
  const texts = parts.map((x) => (x.type === 'string' && !x.declared ? x.sql : d.castExpr(x.sql, 'string', x.type)));
  return texts.length === 1 ? texts[0] : `(${texts.join(' || ')})`;
}

/** The values each date part takes, on every warehouse (dow ISO: Monday 1 … Sunday 7). */
const PART_RANGE = { dow: [1, 7], hour: [0, 23], day: [1, 31], week: [1, 53], month: [1, 12], quarter: [1, 4], doy: [1, 366] };

/** A function of one text: a value of another known type is refused, saying to cast it — no warehouse
 *  runs upper or replace over a number. */
const text = (fn, write) => ({
  args: 1,
  sql: ({ d, a, t, p, at }) => {
    const said = { int: 'a number', numeric: 'a number', float: 'a number', boolean: 'a flag (true / false)', time: 'a moment', time_of_day: 'a time of day' }[t[0]];
    if (said) throw new Error(`${at} ${fn}: its argument is ${said}, and ${fn} reads text — cast it first: { fn: "cast", args: [<it>], type: "string" }`);
    return { expr: write(a[0], d, p), type: 'string' };
  },
});

const one = (fn, type) => ({ args: 1, sql: ({ a }) => ({ expr: `${fn}(${a[0]})`, type }) });
const arith = (sym) => ({ args: 2, title: '[left, right]', sql: ({ a }) => ({ expr: sym === '/' ? `(${a[0]} / NULLIF(${a[1]}, 0))` : `(${a[0]} ${sym} ${a[1]})` }) });
// An array function's argument is checked when the stage is ADDED, not at warehouse run time: only a
// KNOWN non-array type fails — an array, or a column whose type is unknown (raw, native), passes.
// `scalars`: the function reads an element (element_at, array_last, array_contains), which an array of
// structs does not hold as one value — its elements are read a field at a time.
const needsArray = (fn, t, scalars = true) => {
  if (t == null || t === 'unknown') return;
  if (isArrayPropertyType(t)) {
    if (scalars && elementType(t) === 'struct') throw new Error(`${fn}: its argument is '${t}' — ${fn} takes an array of scalars. Read the elements' fields instead: unnest the property, then json_field on the element`);
    return;
  }
  throw new Error(`${fn}: its argument is '${t}', not an array — produce an array first (json_parse_array on a JSON/string column, or unnest a native array column)${/string|json|varchar|text/i.test(String(t)) ? '; an event property the catalog declares an array, held as JSON text in a column of its own, is read as one with { property: "<its name>" }' : ''}`);
};

/** An element of an array (element_at, array_last): of a native array, an element of its items' type;
 *  of an array property the catalog says is held as JSON (as array_length and array_contains read one),
 *  an element's text — any other text is parsed first (json_parse_array). */
const elementRead = (d, sql, read, fn, at) => {
  if (read.jsonArray) return { expr: at(d.jsonParseArray(sql)), type: 'string' };
  needsArray(fn, read.type);
  return { expr: at(sql), type: elementType(read.type) };
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
 * value (one field of it with `field`), an array's length, or whether an array holds `item` (looked for
 * as an element is: of a native array's items, a JSON array's text). The value is of the type the
 * catalog declares (text where it declares none) — an array as it is stored: a native one an array of its
 * items (nativeArrayType: as its column is tracked here, the warehouse's where it was asked, else the
 * catalog's `items`), one held as JSON its text (a payload key's too, read as JSON) — and a field of it
 * text: another type is a cast of the read. The column it reads must still be in the row — after a stage
 * that changed the grain it is gone.
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
  // a native array is of its items as its column is tracked here — the one reader, the unnest's too
  const array = isArrayPropertyType(spec?.type);
  const arrayType = native && array ? nativeArrayType(spec, cols?.get(spec.column)?.type) : null;
  if (kind === 'length') return { sql: flat ? (native ? d.arrayLength(flat) : d.jsonColumnArrayLength(flat)) : d.jsonArrayLength(payload, key), type: 'int' };
  if (kind === 'contains') {
    if (!native) return { sql: flat ? d.jsonColumnArrayContains(flat, item) : d.jsonArrayContains(payload, key, item), type: 'boolean' };
    return { sql: d.arrayContains(flat, typedValue(elementType(arrayType), item, `an element of '${property}'`)), type: 'boolean' };
  }
  if (field !== undefined) return { sql: flat ? d.jsonColumnStructField(flat, field) : d.jsonStructField(payload, key, field), type: 'string' };
  // a scalar in its own column holds what the catalog declares (the column itself: a text one holding a
  // flag is compared as one, as a { column } of it is); a payload key is extracted as that type — or, read
  // by a cast (`as`), as the type cast to: the payload's text converted once, by the dialect's one
  // conversion of a text (fromText: a number, a flag, a moment), not the declared type's value converted
  // again (3 read as text is '3', not '3.0') — but a flag cast to a number is its 1 / 0, cast's own rule
  // for a flag: read as the flag, which cast converts; a type that conversion does not make is not
  // claimed: the key's text. An array is what it is stored as: a native one an array of its items, JSON
  // text otherwise — a payload key's read as its JSON (a read of the key's text takes only a scalar on BigQuery)
  // (`jsonArray`: text the catalog says holds a JSON array — an element of it is read through the parse)
  if (array && !flat) return { sql: d.jsonExtractJson(payload, key), type: 'string', jsonArray: true };
  const type = !array ? propertyType(spec) : native ? arrayType : 'string';
  // a scalar's own column, where it is tracked here, is read as that column is — its type (the
  // warehouse's once it was asked: a BOOLEAN column is a flag, a VARCHAR one holding a flag text) and its
  // mark — exactly as a { column } of it
  const backing = flat && !array ? cols?.get(spec.column) : null;
  if (backing && backing.type && backing.type !== 'unknown') return { sql: flat, type: backing.type, ...(backing.physical ? { physical: true } : {}) };
  if (flat) return { sql: flat, type: tracked(type), ...(array && !native ? { jsonArray: true } : {}) };
  const castTo = as !== undefined && !(isBooleanType(type) && isNumericType(as)) ? as : undefined;
  const read = textConverts(castTo ?? type) ? castTo ?? type : 'string';
  return { sql: d.jsonExtract(payload, key, read), type: tracked(read), ...(castTo !== undefined ? { readAs: read } : {}) };
}

/** Whether a text is converted to `type` by the dialect's one conversion of a text (fromText): a number,
 *  a flag, a moment — any other type is the text as it is. */
const textConverts = (type) => isNumericType(type) || isBooleanType(type) || isTimeType(type);

/** A declared type in the words a value is tracked by — a flag `boolean` (bool, BOOLEAN …), a moment
 *  `time` (date, timestamp …), as a column of either is: what the conditions and a compute stage test.
 *  The read itself is told the declared word (a date is read as a DATE, a timestamp as a TIMESTAMP). */
const tracked = (type) => (isBooleanType(type) ? 'boolean' : isTimeType(type) ? 'time' : type);

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

/** The aggregates that fold numbers: over a text, a flag or a moment the warehouse has no such function. */
const NUMBER_FOLDS = new Set(['sum', 'average', 'median', 'percentile', 'stddev', 'variance']);
function needsNumber(fn, type, at, arg) {
  const said = { string: 'text', boolean: 'a flag (true / false)', time: 'a moment', time_of_day: 'a time of day', json: 'JSON text' }[type];
  if (!said) return;
  const fix = type === 'boolean'
    ? 'count the rows where it holds — count of { fn: "case", cases: [{ when: [<it>], then: { value: 1 } }] } — or average a case of then 1 else 0 for a share'
    : type === 'time' || type === 'time_of_day' ? 'fold a number made from it (date_diff, date_part, unix_date), or take its min / max'
      : `read the number it holds first: { fn: "${fn}", args: [{ fn: "cast", args: [${arg === undefined ? '<it>' : JSON.stringify(arg)}], type: "numeric" }] }`;
  throw new Error(`${at} ${fn}: its argument is ${said}, which ${fn} cannot fold — ${fix}`);
}

/** The aggregates that merge sketches (hll_init's) — into a coarser sketch, or into the count. */
const MERGE_FNS = new Set(['hll_merge', 'hll_merge_partial']);
/** A function that reads a sketch refuses a value known to be something else — a number most often: the
 *  count hll_merge already gave, or a column of the rows. */
function needsSketch(fn, type, at) {
  if (type && type !== 'sketch' && type !== 'unknown' && type !== 'string' && type !== 'bytes') {
    throw new Error(`${at} ${fn}: its argument is ${type === 'int' || type === 'numeric' || type === 'float' ? 'a number' : `of type ${type}`}, not a sketch — ${fn} reads what hll_init or hll_merge_partial built (hll_merge already gives the count: read it as it is)`);
  }
}

const condition = (op, args, title) => ({
  kind: 'condition', args, title,
  sql: ({ d, r, opts }) => ({ expr: predicateSql(op, r, { timeOperand: (x) => d.timeOperand(x), castToConstant: !!opts.castToConstant, dialect: d }), type: 'boolean' }),
});

const aggregate = (fn, { args = 1, title, needs } = {}) => ({
  kind: 'aggregate', args, title, ...(needs ? { needs } : {}), windowable: WINDOW_AGGREGATE_FNS.includes(fn),
  sql: ({ d, cols, a, t, p, window, opts, at }) => (MERGE_FNS.has(fn) && needsSketch(fn, t[0], at), NUMBER_FOLDS.has(fn) && needsNumber(fn, t[0], at, p.args?.[0]), window
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
  upper: text('upper', (a) => `upper(${a})`),
  lower: text('lower', (a) => `lower(${a})`),
  length: one('length', 'int'),
  trim: one('trim', 'string'),
  unix_date: { args: 1, sql: ({ d, a }) => ({ expr: d.unixDateExpr(a[0]), type: 'int' }) },
  hll_extract: { args: 1, title: '[sketch] → the distinct count of one sketch', sql: ({ d, a, t, at }) => { needsSketch('hll_extract', t[0], at); return { expr: d.hllExtract(a[0]), type: 'int' }; } },
  json_parse_array: { args: 1, sql: ({ d, a }) => ({ expr: d.jsonParseArray(a[0]), type: arrayColumnType('string') }) }, // STRING JSON array → native array of its texts (then unnest)
  coalesce: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: `coalesce(${a.join(', ')})`, type: commonType(t, 'string') }) },
  // (missing where any argument is, on every warehouse: DuckDB's least / greatest skip a NULL, BigQuery's
  // return one — so a clamp of a missing value stays missing instead of becoming its bound)
  least: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: pickedSql('least', a), type: commonType(t, 'numeric') }) },
  greatest: { args: { min: 2 }, sql: ({ a, t }) => ({ expr: pickedSql('greatest', a), type: commonType(t, 'numeric') }) },
  concat: { args: { min: 1 }, sql: ({ d, r }) => ({ expr: concatSql(d, r), type: 'string' }) },
  // the dialect's one conversion, told what the value is where it is known: a number, a flag or a text
  // converts to int alike on every warehouse — the number it holds, rounded half away from zero. A raw's
  // type is the caller's word for what its SQL yields, never checked: it converts as a value of no known
  // type does (read as its text), which takes every one of them
  cast: { args: 1, needs: ['type'], sql: ({ d, a, t, r, p }) => ({ expr: d.castExpr(a[0], p.type, r[0].declared ? null : t[0]), type: p.type }) },
  substring: { ...text('substring', (a, d, p) => d.substringExpr(a, p.start, p.len)), needs: ['start'], may: ['len'] },
  replace: { ...text('replace', (a, d, p) => `replace(${a}, ${d.sqlLiteral(p.search)}, ${d.sqlLiteral(p.replacement)})`), needs: ['search', 'replacement'] },
  // An unnested struct element is already JSON-typed; a flattened payload column holding JSON is
  // TEXT and has to be parsed first, or the json operators do not apply to it. What it reads is text
  // (cast converts it): a field read out of JSON.
  json_field: { args: 1, needs: ['field'], sql: ({ d, a, t, p }) => ({ expr: t[0] === 'json' ? d.jsonColumnField(a[0], p.field) : d.jsonColumnStructField(a[0], p.field), type: 'string' }) },
  // how many elements an array holds, whether it holds one value: of an array event property read where
  // it is stored ({ property }), or of an expression that yields an array (written by the writer itself)
  array_length: { args: 1, title: '[array]', array: 'length' },
  array_contains: { args: 2, title: '[array, { value }]', array: 'contains' },
  // an element of a native array, of the type it is stored as: the array's items (a parsed JSON array's
  // text), not claimed ('unknown') where they are not known
  element_at: { args: 1, needs: ['index'], sql: ({ d, a, r, p }) => elementRead(d, a[0], r[0], 'element_at', (arr) => d.arrayElementAt(arr, p.index)) },
  array_last: { args: 1, sql: ({ d, a, r }) => elementRead(d, a[0], r[0], 'array_last', (arr) => d.arrayLast(arr)) },
  date_diff: { args: 2, title: '[from, to]', needs: ['unit'], sql: ({ d, a, p }) => ({ expr: d.dateDiff(p.unit, a[0], a[1]), type: 'int' }) },
  // the wall-clock time of a moment in a timezone — its local day, hour, week (date_trunc / date_part of it)
  in_timezone: {
    args: 1, needs: ['timezone'], sql: ({ d, a, p, at }) => {
      if (!isValidTimezone(p.timezone)) throw new Error(`${at} in_timezone: unknown timezone '${p.timezone}' — an IANA name like 'Europe/Berlin' or 'UTC'`);
      return { expr: d.inTimezone(a[0], p.timezone), type: 'time' };
    },
  },
  date_trunc: { args: 1, needs: ['grain'], sql: ({ d, a, p }) => ({ expr: d.dateTrunc(p.grain, a[0]), type: 'time' }) },
  // (a time of day has its hour alone: no date, so no day, week, month, quarter, year, doy or dow); the
  // values a part takes ride with it, so a constant compared with it outside them is refused
  date_part: {
    args: 1, needs: ['part'], sql: ({ d, a, t, p, at }) => {
      if (t[0] === 'time_of_day' && p.part !== 'hour') throw new Error(`${at} date_part: its argument is a time of day, which has an hour and no date — part '${p.part}' needs a date or a timestamp`);
      return { expr: d.datePart(p.part, a[0], t[0]), type: 'int', ...(PART_RANGE[p.part] ? { range: PART_RANGE[p.part] } : {}) };
    },
  },
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
  // what a case yields is what its branches share — or the `type` it says, its value converted to it where
  // the branches are of another (cast's one conversion), so the type it is tracked by is its SQL's
  case: {
    args: 0, needs: ['cases'], may: ['else', 'type'],
    sql: ({ d, p, sub, conds }) => {
      const thens = [];
      const branches = p.cases.map((cs, i) => {
        const then = sub(cs.then, `cases[${i}].then`);
        thens.push(then.type);
        return `WHEN ${conds(cs.when, `cases[${i}].when`).map((x) => `(${x})`).join(' AND ')} THEN ${then.sql}`;
      });
      const other = p.else !== undefined ? sub(p.else, 'else') : null;
      if (other) thens.push(other.type);
      const sql = `CASE ${branches.join(' ')}${other ? ` ELSE ${other.sql}` : ''} END`;
      const common = commonType(thens, null);
      if (p.type && p.type !== common) return { expr: d.castExpr(sql, p.type, common), type: p.type };
      return { expr: sql, type: p.type || common || 'string' };
    },
  },
  // escape hatch: dialect SQL whose columns come STRUCTURED — each an item of args, `{n}` in the SQL
  // where the n-th goes, written quoted by the server; a column named in its text is refused. What its SQL
  // yields is known to no one but the caller: its `type` says it (`declared` — taken at its word where it
  // is compared, read as of no known type where it is converted), and without one it is not claimed
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
      if (named.length) throw new Error(`pipeline: a raw expression names ${named.map((n) => `'${n}'`).join(', ')} in its SQL text — a column goes in \`args\`, with {1}, {2}, … in the SQL where each goes (e.g. sql: "POWER({1}, {2})", args: [{ column: "${named[0]}" }, …]); the server writes it quoted`);
      return { expr: `(${fillPlaceholders(p.sql, a)})`, type: p.type || 'unknown', ...(p.type ? { declared: true } : {}) };
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
  ...Object.fromEntries(['sum', 'average', 'min', 'max', 'count_distinct', 'approx_count_distinct', 'median', 'stddev', 'variance'].map((fn) => [fn, aggregate(fn)])),
  hll_init: aggregate('hll_init', { title: '[x] → a sketch of its distinct values' }),
  hll_merge: aggregate('hll_merge', { title: '[sketch] → the distinct count (a number)' }),
  hll_merge_partial: aggregate('hll_merge_partial', { title: '[sketch] → a merged sketch' }),
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
 * something it refuses has a home elsewhere. A tool's definition of each expression kind (EXPR_KINDS)
 * holds what its places of that kind take together (exprSchema's `places`); each place narrows it
 * further, as the value is built.
 *   source_rows    — a pipeline step over a source's rows (a build, an eventstream's start);
 *   stored_rows    — rows without a payload: a read of a stored table, the steps after a metrics step,
 *                    a card's drill (a feature's filter over its own rows passes a place of this shape);
 *   semantic_model — a semantic model's where, its computed dimensions and its measures (no raw: its SQL
 *                    would reach MetricFlow unchecked, a semantic model's columns are not tracked; no
 *                    window: a semantic model has no order of rows);
 *   metric_where   — a where step before a metric query's metrics step, the rows its metrics fold: what
 *                    group_by names, and constants;
 *   metric_result  — the steps after a metrics step, over its result: what a read of stored rows takes,
 *                    and a group_by item named as group_by names it, a metric as { metric } — each the
 *                    result's column it gave (src/engine/semantic-query.js _metricTail);
 *   derived_metric — a derived metric's value: other metrics and constants, in arithmetic.
 */
export const PLACES = {
  source_rows: {
    what: 'a step over a source\'s rows', leaves: ['column', 'property', 'value', 'now'], fns: Object.keys(FNS), windows: true, entities: true,
    hint: 'A column of another model arrives by a join stage (its attrs), and a metric is query_model\'s',
  },
  stored_rows: {
    what: 'a read of stored rows', leaves: ['column', 'value', 'now'], fns: Object.keys(FNS).filter((fn) => fn !== 'raw'), windows: true,
    hint: 'Raw SQL and an event property are a build\'s: build from the task — build_model({ request: { action: "start", name, from_task } }) (a pipeline build\'s task, or a query run with materialize: true)',
  },
  semantic_model: {
    what: 'a semantic model\'s computed dimension or measure', leaves: ['column', 'property', 'value', 'now'], fns: [...CONDITION_FNS, ...LOGIC_FNS, ...SCALAR_FNS.filter((fn) => fn !== 'raw'), ...TASK_MEASURE_AGGS], windows: false,
    hint: 'A window or raw SQL is a pipeline\'s (build_model)',
  },
  metric_where: {
    what: 'a where before the metrics step', leaves: [...REF_PLACES.group_by.takes, 'value'], fns: [...CONDITION_FNS, ...LOGIC_FNS, ...SCALAR_FNS.filter((fn) => !NOT_OVER_DIMENSIONS.has(fn))], windows: false,
    hint: 'It filters the rows a metric folds, named as group_by names them; an aggregate is what a metric\'s measure is, and a condition on a metric\'s value is a where step after the metrics step',
  },
  metric_result: {
    what: 'a step after the metrics step', refNames: true, leaves: ['column', 'value', 'now', ...REF_PLACES.group_by.takes, 'metric'], fns: Object.keys(FNS).filter((fn) => fn !== 'raw'), windows: true,
    hint: 'A group_by item is named as group_by names it ({ source, column }, { semantic_model, dimension }, { time, grain }…), a metric as { metric }, a column a step after the metrics step made by its name ({ column }); raw SQL and an event property are a build\'s (build_model from the task)',
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

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Whether an expression calls a window: a window function, or an aggregate given `over`. */
export const isWindowCall = (e) => isObj(e) && Object.hasOwn(FNS, e.fn ?? '') && (kindOf(e.fn) === 'window' || (kindOf(e.fn) === 'aggregate' && e.over !== undefined));
/** Whether an expression calls an aggregate that folds rows (an aggregate with no `over`). */
export const isAggregateCall = (e) => isObj(e) && Object.hasOwn(FNS, e.fn ?? '') && kindOf(e.fn) === 'aggregate' && e.over === undefined;

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
      ...(s.windowable ? [{ ...base, needs: [...base.needs, 'over'], label: 'over a window', window: true, frame: true }] : []),
    ];
  }
  return [{ ...base, window: kindOf(fn) === 'window', label: kindOf(fn) === 'condition' ? 'a condition' : kindOf(fn) === 'logic' ? 'logic' : null }];
}

/** Where the ROW expression is defined in every tool schema that takes an expression. */
export const EXPR_REF = '#/$defs/expr';

/**
 * THE EXPRESSION KINDS — the definitions a tool schema holds an expression in, by what its places take
 * of the one grammar. Every tool that takes an expression holds the ROW expression, `$defs.expr`: a value
 * of each row — and, where its places fold or window rows (a pipeline's measure, a compute stage), the
 * aggregates over them. Where a place takes a CLOSED part of the grammar, the tool holds that part as a
 * kind of its own, and its schema refuses the rest:
 *   aggregate   — a semantic measure's expr: exactly ONE aggregate, its arguments row expressions
 *                 (`$defs.expr`, a case among them where it folds only some rows) — the tool's row
 *                 expression then holds no aggregate, which only ever stands as a measure there;
 *   metric_expr — a derived metric's expr: the leaves and functions of its place, its arguments of the
 *                 same kind.
 * Each is built by exprSchema from FNS and PLACES for the places a tool has of that kind (src/schema.js
 * TOOL_PLACES); the writer checks the place as the value is built, whichever definition the schema held.
 * `ref` is where the kind is defined, `args` what its arguments are, `fnKinds` the kinds of function it
 * holds (none said: every one its places take), `leaves` false where it holds none, `windows` false where
 * no window form stands in it; `title` names a closed kind, so a value refused elsewhere in the tool that
 * it takes is said with where it stands (src/validate.js).
 */
export const EXPR_KINDS = {
  expr: { ref: EXPR_REF, args: EXPR_REF },
  aggregate: { ref: '#/$defs/aggregate', args: EXPR_REF, fnKinds: ['aggregate'], leaves: false, windows: false, title: 'a measure\'s expr — ONE aggregate of the rows' },
  metric_expr: { ref: '#/$defs/metric_expr', args: '#/$defs/metric_expr', title: 'a derived metric\'s expr' },
};

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

/** How an aggregate folds rows, said where one is offered: a conditional one folds a case. */
const FOLD_SAID = 'A conditional one folds a case, missing on the other rows — the rows where c holds { fn: "count", args: [{ fn: "case", cases: [{ when: [c], then: { value: 1 } }] }] }, their revenue { fn: "sum", args: [{ fn: "case", cases: [{ when: [c], then: { column: "price" } }] }] }; average of the first case with else: { value: 0 } is the share of the rows where c holds. A count / count_distinct takes no else: count would count the other rows, count_distinct their else value as one more.';

/**
 * THE EXPRESSION SCHEMA — one definition of a KIND (EXPR_KINDS: the row expression `$defs.expr` unless
 * `kind` says another), built by this one builder for the PLACES of a tool (PLACES names, or places of
 * that shape; none named — everything): the leaves those places take (the rows' { column }, { property } of
 * the catalog's events, { value }, { now }, and the refs that name a value — src/schema/refs.js, with the
 * catalog's names closed per source and, given `project`, the dbt project's semantic models and entities)
 * and the functions they take, of the function kinds the definition holds (`leaveOut`: kinds it leaves to
 * another definition of the tool — a row expression's aggregates, where measures are a kind of their own),
 * a window's form only where one of them takes windows (its `over` a window function's `$defs.over`, an
 * aggregate over a window's `$defs.over_frame`, with its frame), each
 * argument the kind's `args` and a CASE's branches its own. One form per function SHAPE — the functions
 * that take the same arguments and parameters share one, tagged by those of them the places take — each
 * with exactly its own fields. Places of one tool that take different parts of one kind share its one
 * definition, never one each: what each takes is the writer's check (PLACES) as the value is built.
 */
export function exprSchema(catalog, { project = null, places = null, kind = 'expr', leaveOut = [] } = {}) {
  const K = EXPR_KINDS[kind];
  if (!K) throw new Error(`exprSchema: no expression kind '${kind}'`);
  const at = exprPlacesOf(places);
  const P = params({ ref: K.ref });
  const leaves = K.leaves === false ? [] : Object.keys(LEAVES).filter((k) => !at || at.some((p) => p.leaves.includes(k)));
  const offered = Object.keys(FNS).filter((fn) => (!at || at.some((p) => p.fns.includes(fn))) && (!K.fnKinds || K.fnKinds.includes(kindOf(fn))) && !leaveOut.includes(kindOf(fn)));
  const windows = K.windows !== false && (!at || at.some((p) => p.windows));
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
  const forms = [...byShape.values()].map(({ args, title, needs, may, fns: names, label, frame }) => {
    const takesArgs = args !== 0;
    const required = typeof args === 'number' ? args > 0 : args.min > 0;
    const fields = Object.fromEntries([...needs, ...may].map((n) => [n, P[n]]));
    return form({
      // (the parameters it requires named beside its args, where a reader of the title looks — a window's
      // `over` is said by its label)
      title: `fn: ${names.join(' | ')}${title ? ` — args ${title}` : ''}${needs.filter((n) => n !== 'over').length ? ` + ${needs.filter((n) => n !== 'over').join(', ')}` : ''}${label ? ` (${label})` : ''}`,
      tag: ['fn', names],
      required: [...(takesArgs && required ? ['args'] : []), ...needs],
      // an aggregate over a window reads a frame of its window; a window function reads its partition whole
      properties: { ...(takesArgs ? { args: argsOf(args) } : {}), ...fields, ...(frame ? { over: { $ref: OVER_FRAME_REF } } : {}) },
    });
  });
  const rowLeaf = { column: () => columnLeaf(), property: () => propertyLeaf(catalog?.eventPropEnum ? catalog.eventPropEnum() : []), value: valueLeaf, now: nowLeaf };
  const leafForms = [...Object.keys(ROW_LEAVES).filter((k) => leaves.includes(k)).map((k) => rowLeaf[k]()), ...(leaves.length ? valueRefForms(catalog, { project, kinds: leaves }) : [])];
  // what the definition holds, said from what it holds — and, where the tool's places take different parts
  // of it, what each takes, read off the one table, so the description and the refusals say the same
  const has = (...fns) => fns.every((fn) => offered.includes(fn));
  const refLeaves = VALUE_REFS.filter((k) => leaves.includes(k));
  const leafSaid = [...Object.keys(ROW_LEAVES).filter((k) => leaves.includes(k)).map((k) => LEAF_SAID[k]), ...(refLeaves.length ? [`what a ref names that holds a value (${refLeaves.map((k) => REFS[k].says).join(', ')})`] : [])];
  // the places the definition is for, each once (none named: every place there is)
  const ownPlaces = at ? at.filter((p, i) => at.findIndex((q) => q.what === p.what) === i) : Object.values(PLACES);
  const noRaw = at && has('raw') ? ownPlaces.filter((p) => !p.fns.includes('raw')).map((p) => `${p.what} takes no raw`) : [];
  const aggregates = AGGREGATE_FNS.filter((fn) => offered.includes(fn));
  const text = [
    leaves.length
      ? `An expression: a leaf — ${either(leafSaid)} — or a function { fn, args: [expressions], …its parameters }, its arguments expressions themselves, nested to any depth.`
      : `ONE aggregate of the rows { fn, args: [row expressions], …its parameters } — ${either(aggregates)}; count with no args counts the rows, percentile takes \`percentile\`. It folds the rows its argument has a value on, skipping a missing value; its arguments are values of each row, with no aggregate in them — a formula over several aggregates is several measures and a derived metric.`,
    ...(ownPlaces.length > 1 ? [`Each place takes some of them, and a refusal says which — ${ownPlaces.map((p) => `${p.what}: ${p.leaves.map((k) => LEAVES[k].says).join(', ')}`).join('; ')}${noRaw.length ? `; ${noRaw.join('; ')}` : ''}.`] : []),
    // where what a place leaves out is written instead — its hint, as its refusal says it
    ...(at ? ownPlaces.filter((p) => p.hint).map((p) => (ownPlaces.length > 1 ? `For ${p.what}: ${p.hint.charAt(0).toLowerCase()}${p.hint.slice(1)}.` : `${p.hint}.`)) : []),
    ...(leaveOut.includes('aggregate') ? ['An aggregate is no value of a row: it stands only as a measure\'s expr.'] : []),
    ...(leaves.includes('column') && has('round', 'div', 'sub') ? ['round((a - b) / b, 2): { fn: "round", args: [{ fn: "div", args: [{ fn: "sub", args: [{ column: "a" }, { column: "b" }] }, { column: "b" }] }], places: 2 }.'] : []),
    ...(CONDITION_FNS.some((fn) => offered.includes(fn)) ? ['A condition is a function: eq / neq / gt / gte / lt / lte [a, b], in / not_in [a, member, …], between [a, low, high], is_null / is_not_null [a], like / not_like / contains / starts_with / ends_with [text, pattern]; and / or join two or more, not negates one. A constant is compared in the type of what it meets; a comparison with a missing value does not hold — test it with is_null.'] : []),
    ...(aggregates.length && leaves.length ? [`An aggregate (sum, average, min, max, count — with no args it counts rows —, count_distinct, median, percentile with \`percentile\`, …) folds rows where a measure is written, skipping a missing value. ${FOLD_SAID}`] : []),
    ...(aggregates.length && !leaves.length ? [FOLD_SAID] : []),
    ...(has('hll_init') ? ['Distinct counts that add up across buckets: hll_init [x] folds values into a sketch; hll_merge_partial [sketch] merges sketches into a sketch (a coarser bucket); hll_merge [sketch] merges them into the count; hll_extract [sketch] reads the count of one sketch in a row.'] : []),
    ...(windows ? ['With `over`, sum / average / min / max / count — and row_number, rank, dense_rank, lag, lead — compute over a window of rows, in a compute stage.'] : []),
    ...(has('raw') ? ['raw is a build\'s escape hatch: dialect SQL in `sql`, its columns in `args` ({1}, {2}, … in the SQL).'] : []),
  ].join(' ');
  // what an argument is, said once beside the forms that take one
  const nested = {
    ...(forms.some((f) => f.properties.args) ? { args: { type: 'array', items: { $ref: K.args }, description: K.args === K.ref ? 'A function\'s arguments, each an expression.' : 'Its arguments, each a value of the row.' } } : {}),
  };
  return { type: 'object', ...(K.title ? { title: K.title } : {}), description: text, properties: nested, anyOf: [...leafForms, ...forms] };
}

/**
 * THE EXPRESSION'S DEFINITIONS IN A TOOL SCHEMA — each kind the tool's places take (`kinds`: { <EXPR_KINDS
 * name>: [its places] }, null for every place; src/schema.js TOOL_PLACES — any other key is not an
 * expression's), built by exprSchema, and the window where one of them takes one — each of its two
 * definitions a form refers to (`over`, a window function's; `over_frame`, an aggregate over a window's,
 * with its frame), by overSchema. A tool whose measures are a kind of their own (`aggregate`) holds no
 * aggregate in its row expression.
 * → { expr, aggregate?, metric_expr?, over?, over_frame? }, for the tool's `$defs`.
 */
export function exprDefs(catalog, { project = null, kinds = {} } = {}) {
  const named = Object.keys(EXPR_KINDS).filter((k) => kinds[k] === null || kinds[k]?.length);
  const defs = Object.fromEntries(named.map((k) => [k, exprSchema(catalog, { project, places: kinds[k], kind: k, leaveOut: k === 'expr' && named.includes('aggregate') ? ['aggregate'] : [] })]));
  // the window: where a kind holds window forms — its places take a window — over the places it is for
  const windowed = named.filter((k) => EXPR_KINDS[k].windows !== false).flatMap((k) => (exprPlacesOf(kinds[k]) || Object.values(PLACES)).filter((p) => p.windows));
  if (!windowed.length) return defs;
  const entities = windowed.some((p) => p.entities);
  // after a metrics step a window's columns are named as the query names them, as every column there
  const refNames = windowed.some((p) => p.refNames);
  // each window definition a form refers to: a window function's, an aggregate over a window's
  const refs = new Set(Object.values(defs).flatMap((d) => d.anyOf.map((f) => f.properties?.over?.$ref)));
  return {
    ...defs,
    ...(refs.has(OVER_REF) ? { over: overSchema(catalog, { entities, refNames }) } : {}),
    ...(refs.has(OVER_FRAME_REF) ? { over_frame: overSchema(catalog, { entities, frame: true, refNames }) } : {}),
  };
}

// ── The writer ───────────────────────────────────────────────────────────────────────────────────────

/** What a refusal calls a written argument. */
const said = (r) => (r.constant ? `the constant ${JSON.stringify(r.value)}` : r.name ? `'${r.name}' (${r.type || 'of unknown type'})` : `an expression of type ${r.type || 'unknown'}`);
/** Whether a written argument is a boolean — or may be one: nothing is known of its type. */
const mayBeBoolean = (r) => (r.constant ? typeof r.value === 'boolean' : r.type === 'boolean' || r.type == null || r.type === 'unknown');

/** Whether an expression is the constant null — what a case yields where no branch holds. */
const isNull = (x) => isObj(x) && x.fn === undefined && Object.keys(x).length === 1 && Object.hasOwn(x, 'value') && x.value === null;

/** The aggregates that count what their argument holds, whatever the value — count, count_distinct and
 *  its approximations (approx_count_distinct, the sketch hll_init builds for it) — the ones a case's else
 *  (a value on every row no branch takes) always changes, so the writer refuses one there. */
const COUNTING_FNS = new Set(['count', 'count_distinct', 'approx_count_distinct', 'hll_init']);

/** The aggregate `e` folding only the rows where `conds` hold: its argument a case that yields it there
 *  (1 for a count of the rows) and nothing elsewhere. An argument that is a case already gets them in
 *  every branch, its else only where they hold — the conditions' rows keep the else's value (an average
 *  of 1 else 0 stays a share of them), the others are missing, and an else a count is refused for stays
 *  its own. The one builder of a conditional fold: a pivot's cell (src/pipeline/stages.js) and an earlier
 *  aggregate's `where` (src/earlier-spelling.js). */
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
      throw new Error(def
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
    if (!json) needsArray(e.fn, r.type, kind === 'contains'); // (an array of structs has a length too)
    if (kind === 'length') return { sql: json ? d.jsonColumnArrayLength(r.sql) : d.arrayLength(r.sql), type: 'int' };
    // the value looked for is written as an element is: of a native array's items (as written where they
    // are not known), a JSON array's text (the dialect's)
    if (json) return { sql: d.jsonColumnArrayContains(r.sql, v), type: 'boolean' };
    return { sql: d.arrayContains(r.sql, typedValue(elementType(r.type), v, `an element of ${r.name ? `'${r.name}'` : 'the array'}`)), type: 'boolean' };
  }

  function render(e, at, s) {
    if (!isObj(e)) throw new Error(`${at}: an expression is an object — { column }, { property }, { value }, { now: true } or a function { fn, args, … }`);
    if (e.fn === undefined) return leaf(e, at, s);
    const spec = Object.hasOwn(FNS, e.fn) ? FNS[e.fn] : null;
    if (!spec) {
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
    const allowed = new Set(['fn', ...(spec.args !== 0 ? ['args'] : []), ...(spec.needs || []), ...(spec.may || []), ...(window ? ['over'] : [])]);
    const stray = Object.keys(e).filter((k) => !allowed.has(k));
    if (stray.length) {
      if (stray.includes('over') && kind !== 'window' && !spec.windowable) throw new Error(`${at}: ${fn} takes no \`over\` — a window is ${WINDOW_FNS.join(', ')}, or ${WINDOW_AGGREGATE_FNS.join(' / ')} over rows`);
      if (stray.includes('where') && window) throw new Error(`${at}: ${fn} over a window takes no \`where\` — a conditional window folds a CASE: { fn: "${fn}", args: [{ fn: "case", cases: [{ when: [...], then: <the value> }] }], over }`);
      throw new Error(`${at}: ${fn} takes ${[...allowed].filter((k) => k !== 'fn').join(', ') || 'no field'}, not ${stray.join(', ')}`);
    }
    const args = e.args || [];
    if (!Array.isArray(args)) throw new Error(`${at}: ${fn} takes \`args\` as a list of expressions`);
    const { min, max } = typeof spec.args === 'number' ? { min: spec.args, max: spec.args } : { min: spec.args.min, max: spec.args.max ?? Infinity };
    if (args.length < min || args.length > max) throw new Error(`${at}: ${fn} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? '' : 's'}${spec.title ? ` ${spec.title}` : ''}, not ${args.length}`);
    for (const n of spec.needs || []) if (e[n] === undefined) throw new Error(`${at}: ${fn} needs \`${n}\``);
    if (kind === 'window' && e.over === undefined) throw new Error(`${at}: ${fn} needs \`over\``);
    // a frame is read only by an aggregate over a window (it bounds what it folds for each row); a rank or
    // a neighbour reads its partition whole, in order — its window ($defs.over) has no frame, and a caller
    // past the schema is told so here
    if (kind === 'window' && isObj(e.over) && e.over.frame !== undefined) throw new Error(`${at}: ${fn} takes no \`over.frame\` — a frame bounds what an aggregate over a window (${WINDOW_AGGREGATE_FNS.join(' / ')}) folds for each row; ${fn} is read over its whole partition, in the window's order. Leave the frame out`);
    // an aggregate folds the rows its argument has a value on: a case's else gives one to the rows no
    // branch takes — which a count counts whatever it is; any other aggregate folds it as the value it
    // is (average of 1 else 0: a share of the rows)
    if (kind === 'aggregate' && COUNTING_FNS.has(fn) && isObj(args[0]) && args[0].fn === 'case' && args[0].else !== undefined && !isNull(args[0].else)) {
      throw new Error(`${at}: ${fn} over a case with an else — an else under ${[...COUNTING_FNS].join(', ')} always changes what is counted: it gives every row no branch takes a value, and ${fn === 'count' ? 'count counts each of them' : fn === 'hll_init' ? 'the sketch hll_init builds holds it as one more distinct value' : `${fn} counts it as one more distinct value`}. Leave the else out: those rows are then missing, and ${fn} skips them${fn === 'count' ? ' (every row is { fn: "count" } with no args)' : ''}.`);
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
    return { sql: out.expr, type: out.type || 'numeric', name: `${fn}(…)`, ...(out.declared ? { declared: true } : {}), ...(out.range ? { range: out.range, part: e.part } : {}) };
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
    throw new Error(`${at}: a measure is ONE aggregate — { fn: "sum" | "average" | "count" | …, args: [<a row expression>] } (the rows where a condition holds: a case) — a formula over several aggregates is several measures and a derived metric`);
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

/** The columns some condition compares, anywhere in `v` — steps, measures, a whole declaration: a
 *  comparison's { column } (or { property }) argument, keyed by its name and, where the leaf names its
 *  model, `<source>.<name>` — each with the constants an eq / in compares it with (none for another
 *  comparison: it is compared, with no value it keeps). */
export function comparedColumns(v, out = new Map()) {
  if (Array.isArray(v)) { v.forEach((x) => comparedColumns(x, out)); return out; }
  if (!isObj(v)) return out;
  if (v.fn !== undefined) {
    eachNode(v, (n) => {
      if (!CONDITION_FNS.includes(n.fn)) return;
      const args = Array.isArray(n.args) ? n.args : [];
      const kept = n.fn === 'eq' || n.fn === 'in' ? args.filter((a) => isObj(a) && a.fn === undefined && Object.hasOwn(a, 'value')).map((a) => a.value) : [];
      for (const a of args) {
        const name = isObj(a) && a.fn === undefined ? (typeof a.column === 'string' ? a.column : typeof a.property === 'string' ? a.property : null) : null;
        if (!name) continue;
        for (const key of [name, ...(typeof a.source === 'string' ? [`${a.source}.${name}`] : [])]) {
          if (!out.has(key)) out.set(key, new Set());
          for (const x of kept) out.get(key).add(x);
        }
      }
    });
    return out;
  }
  for (const x of Object.values(v)) comparedColumns(x, out);
  return out;
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
