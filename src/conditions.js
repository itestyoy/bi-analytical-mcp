// ONE COMPARISON — written the same way wherever the server writes one: a condition function of the
// expression grammar (src/pipeline/compute.js FNS: eq … between, in / not_in, the text tests, the null
// tests) at every level — a pipeline stage, a funnel step, a CASE's branch (a conditional aggregate's
// too), a semantic model's scope, a MetricFlow where, a retentioneering filter — and a bound a scan puts
// on a table. The
// arguments arrive WRITTEN (a quoted column, a JSON read, a Jinja Dimension, a function's SQL) with
// what is known of each: its type, whether the warehouse said so, whether it is a constant. This module
// chooses the operator's SQL and writes the constants, through the dialect's one literal writer, in
// the type of what they are compared with (typedLiteral below).

import { sqlLiteral, isNumericType, isTimeType } from './dialects/base.js';
import { localToUtc, hasOffset } from './moment.js';

/** The order comparisons, as the grammar spells them → SQL. */
export const COMPARE_SQL = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** like / not_like: the caller's own LIKE pattern, % and _ its wildcards. */
const LIKE_SQL = { like: 'LIKE', not_like: 'NOT LIKE' };

/**
 * A substring test over the written text `lhs` and substring `s`. A constant substring is the text it
 * says: a % or _ in it is that character, never a wildcard. Written with the functions DuckDB and
 * BigQuery both name alike (STARTS_WITH, ENDS_WITH, STRPOS), so one text serves every warehouse — an
 * escaped LIKE would not: BigQuery's LIKE escapes with a backslash and takes no ESCAPE clause, DuckDB's
 * has no escape character without one. An empty substring is in every string (STRPOS's answer for it is
 * not one both warehouses document), and a missing text holds no substring, so the empty case is a LIKE
 * '%' — NULL where the text is.
 */
const SUBSTRING = {
  contains: (lhs, s, constant) => (constant === '' ? `${lhs} LIKE '%'` : constant !== undefined ? `STRPOS(${lhs}, ${s}) > 0` : `(CASE WHEN ${s} = '' THEN ${lhs} LIKE '%' ELSE STRPOS(${lhs}, ${s}) > 0 END)`),
  starts_with: (lhs, s) => `STARTS_WITH(${lhs}, ${s})`,
  ends_with: (lhs, s) => `ENDS_WITH(${lhs}, ${s})`,
};

/** The comparisons that order their arguments. */
const ORDER_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'between']);

/** The text tests — a LIKE pattern or a substring: their second argument is text whatever the first is. */
export const TEXT_OPS = new Set([...Object.keys(LIKE_SQL), ...Object.keys(SUBSTRING)]);

/** EVERY condition function — one vocabulary, the same at every level a condition is written. */
export const OPS = [...Object.keys(COMPARE_SQL), 'in', 'not_in', 'between', 'is_null', 'is_not_null', ...TEXT_OPS];

// A constant compared with something of a KNOWN type is written in that type. A warehouse compares a
// value only with its own type — BigQuery refuses BOOL = STRING, INT64 = STRING and STRING = INT64
// outright, and DuckDB reads a text column met by a number or a flag as that, failing on the first word —
// and the caller often spells a flag "true" or a number "5". So a boolean takes true / false (written
// either way, or 1 / 0), a number a number (or a numeric string), and a text a number or a flag as its
// text (5 is '5', true is 'true'); anything else is refused HERE, when the step is added, rather than by
// the warehouse when it runs. A moment takes a moment with an offset of its own (Z, ±hh[:mm]) as the UTC
// instant it names, to the microsecond — BigQuery reads the offset, DuckDB's reading of the text drops it —
// as a window's bound is written (resolveTimeRange); a date-time in any other spelling (a zone name, an
// offset of one digit, a time past 23:59) is refused, since the two warehouses would read it apart. What
// nothing is known about ('unknown', null) takes the constant as it is written.
const BOOL_TEXT = new Map([['true', true], ['false', false], ['1', true], ['0', false]]);

// a text that starts as a date-time: what a moment's constant is read as, or refused
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** A constant as a value of `type` (what it is compared with, or looked for among; null for unknown) —
 *  the value typedLiteral writes, and an array's member (array_contains) is. `where` names it in a refusal. */
export function typedValue(type, v, where) {
  if (v === null) return v;
  if (type === 'boolean') {
    const b = typeof v === 'boolean' ? v : typeof v === 'number' && (v === 0 || v === 1) ? v === 1 : typeof v === 'string' ? BOOL_TEXT.get(v.trim().toLowerCase()) : undefined;
    if (b === undefined) throw new Error(`${where} is a boolean: compare it with true or false, not ${JSON.stringify(v)}`);
    return b;
  }
  if (isNumericType(type)) {
    // a whole number (a count, a date part) is never a fraction: a fraction compared with it matches nothing
    if (type === 'int' && typeof v === 'number' && !Number.isInteger(v)) throw new Error(`${where} is a whole number: ${v} is never one — compare it with a whole number, or cast it to numeric`);
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    throw new Error(`${where} is a number: compare it with a number, not ${JSON.stringify(v)}`);
  }
  if (type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (isTimeType(type) && typeof v === 'string' && DATE_TIME.test(v.trim())) {
    const utc = localToUtc(v.trim());
    if (utc == null) throw new Error(`${where} is a moment: write it YYYY-MM-DD[ HH:mm[:ss[.ffffff]]] with an optional Z or ±hh[:mm] (a zone name, or an offset of one digit, is not read alike by every warehouse), not ${JSON.stringify(v)}`);
    // a moment at midnight is written as its day: a DATE column reads no time of day in a literal, and a
    // timestamp's midnight is the same instant either way
    const at = (hasOffset(v.trim()) ? utc : v.trim()).replace('T', ' ');
    const day = /^(\d{4}-\d{2}-\d{2}) 00:00(?::00(?:\.0+)?)?$/.exec(at);
    return day ? day[1] : at;
  }
  return v;
}

/** A constant as a literal of `type` (what it is compared with; null for unknown). `where` names it in a refusal. */
export const typedLiteral = (type, v, where) => sqlLiteral(typedValue(type, v, where));

// How a flag is spelled when the warehouse stores it as text.
const TEXT_TRUE = ['true', '1', 't'];
const TEXT_FALSE = ['false', '0', 'f'];

/** A boolean compared with a TEXT column of the warehouse holding a flag: matched against every way
 *  text spells it (true / 1 / t, false / 0 / f), so neither STRING = BOOL in the run nor a guess at the
 *  spelling. Only an equality or a membership can say that, and only with booleans on the other side. */
function textFlag(op, subject, constants) {
  if (!['eq', 'neq', 'in', 'not_in'].includes(op) || !constants.every((v) => typeof v === 'boolean')) {
    throw new Error(`'${subject.name}' is a text column in the warehouse: a boolean is compared with it by eq / neq / in / not_in alone, and not mixed with other constants — or compare it with its text value (semantic_index({ request: { source, property } }) lists the values an event property holds, ({ source, column }) a column's)`);
  }
  const spellings = constants.flatMap((v) => (v ? TEXT_TRUE : TEXT_FALSE)).map((x) => sqlLiteral(x));
  return `LOWER(TRIM(${subject.sql})) ${op === 'neq' || op === 'not_in' ? 'NOT IN' : 'IN'} (${spellings.join(', ')})`;
}

/**
 * A column compared with constants AS THE CONSTANTS' KIND (castToConstant — the retentioneering
 * eventstream, whose segments are stored as text: a threshold on one is a number's): its text read as a
 * number or a flag by the dialect's one conversion of a text (fromText — the rule cast and every typed
 * read follow, so '1_000' is missing on every warehouse), or as text — a value that does not read as
 * that kind is missing, and matches nothing.
 */
function castToKind(sql, kind, op, d) {
  const text = d.castExpr(sql, 'string');
  if (TEXT_OPS.has(op)) return text;
  if (kind === 'number') return d.fromText(text, 'float');
  if (kind === 'boolean') return d.fromText(text, 'boolean');
  return sql;
}

const isConstant = (x) => x.constant === true;

// An operand that is not ATOMIC — a quoted column, a Jinja reference (a constant is a literal, written by
// the one literal writer) — is written in parentheses, so an argument that is itself a condition or an
// infix expression (a = b, x IN (…), x LIKE p, a AND b) keeps its own precedence beside the operator it
// is an argument of: eq [gt(a, b), true] is ("a" > "b") = TRUE, never "a" > "b" = TRUE.
const ATOMIC = /^(?:"[^"]*"|`[^`]*`|\{\{[^{}]*\}\})$/;
const operand = (sql) => (ATOMIC.test(sql) ? sql : `(${sql})`);

/**
 * ONE CONDITION FUNCTION over its written arguments → its SQL. `args`: [{ sql, type?, physical?,
 * constant?, value?, name? }] in the order the caller wrote them — eq … lte [a, b], in / not_in [a,
 * member, …], between [a, low, high], is_null / is_not_null [a], like … ends_with [text, pattern].
 *
 * The typing rule, one for every level: a constant is written in the type of the first argument that
 * is not a constant (a flag spelled "true" meets a boolean, "5" a number, 5 a text as '5', true a text as
 * 'true' — and a text is not ordered against a number, which would order it as text: refused, saying to
 * cast); a boolean beside a physical TEXT column holding a flag matches every spelling of it; two
 * arguments that are not constants, one a moment, meet as timestamps (`timeOperand`) — a number or a
 * boolean on the other side is refused. A
 * constant null is refused: a missing value is tested with is_null / is_not_null, and a comparison with
 * a missing operand never holds (neq, not_in and not_like included: "present and different").
 *
 * Every operand that is not atomic is written in parentheses (`operand`), so a condition stands as an
 * argument of another as it means.
 *
 * `opts.timeOperand` the dialect's (a moment read as a timestamp); `opts.literal` writes a constant
 * instead of typedLiteral (a caller that binds the type itself); `opts.castToConstant` with
 * `opts.dialect` (the dialect itself) reads the first argument as its constants' kind (castToKind).
 */
export function predicateSql(op, args, { timeOperand = (x) => x, literal = null, castToConstant = false, dialect = null } = {}) {
  if (!OPS.includes(op)) throw new Error(`unsupported condition: ${op} (the conditions: ${OPS.join(', ')})`);
  const [subject, ...rest] = args;
  if (!subject) throw new Error(`${op} needs its arguments`);
  if (op === 'is_null' || op === 'is_not_null') return `${operand(subject.sql)} ${op === 'is_null' ? 'IS NULL' : 'IS NOT NULL'}`;
  if (args.some((a) => isConstant(a) && a.value === null)) {
    throw new Error(`${op} compares with { value: null }, which no value equals — a missing value is tested with is_null / is_not_null ({ fn: "is_null", args: [<the expression>] })`);
  }
  // the first argument that is not a constant: the constants are written in its type
  const anchor = args.find((a) => !isConstant(a)) || null;
  const constants = args.filter(isConstant).map((a) => a.value);
  // a date part takes the values of its numbering: a constant outside them matches nothing, or every row —
  // most often a day of the week counted from 0 (Sunday 0, Saturday 6), which here is Saturday 6, Sunday 7
  const outside = anchor?.range ? constants.find((v) => typeof v === 'number' && (v < anchor.range[0] || v > anchor.range[1])) : undefined;
  if (outside !== undefined) {
    throw new Error(`${op} compares date_part '${anchor.part}' with ${outside}, which it never is — '${anchor.part}' runs ${anchor.range[0]} … ${anchor.range[1]}${anchor.part === 'dow' ? ' (ISO: Monday 1 … Saturday 6, Sunday 7 — a weekend is in [6, 7])' : ''}`);
  }
  const named = (a) => `'${a?.name ?? 'the expression'}'`;
  if (TEXT_OPS.has(op)) {
    const pattern = rest[0];
    if (isConstant(pattern) && typeof pattern.value !== 'string') throw new Error(`${op} takes text as its second argument (a ${LIKE_SQL[op] ? 'LIKE pattern' : 'substring'}), not ${JSON.stringify(pattern.value)}`);
    const text = operand(castToConstant && !isConstant(subject) ? castToKind(subject.sql, 'string', op, dialect) : subject.sql);
    const p = isConstant(pattern) ? sqlLiteral(pattern.value) : operand(pattern.sql);
    return LIKE_SQL[op] ? `${text} ${LIKE_SQL[op]} ${p}` : SUBSTRING[op](text, p, isConstant(pattern) ? pattern.value : undefined);
  }
  // a column compared as its constants' kind: one kind for all of them, read safely as it
  let castKind = null;
  if (castToConstant && anchor && constants.length) {
    const kinds = new Set(constants.map((v) => typeof v));
    if (kinds.size > 1) throw new Error(`${op} on ${named(anchor)} takes constants of one kind — the column is compared as that kind`);
    castKind = [...kinds][0];
  }
  // a text ordered against a number would be ordered as text ('10' before '9'), the number written as its
  // text: refused, saying to read the number the text holds first
  if (!castKind && !literal && anchor?.type === 'string' && ORDER_OPS.has(op) && constants.some((v) => typeof v === 'number')) {
    throw new Error(`${named(anchor)} is text: ${op} with a number would order it as text ('10' before '9') — read the number it holds first ({ fn: "cast", args: [<it>], type: "numeric" }), or compare it with text`);
  }
  const flag = !castKind && anchor?.physical && anchor.type === 'string' && constants.some((v) => typeof v === 'boolean');
  if (flag) {
    // an equality reads the same either way round; a membership tests its first argument
    if (args.filter((a) => !isConstant(a)).length > 1 || ((op === 'in' || op === 'not_in') && args[0] !== anchor)) throw new Error(`'${anchor.name}' is a text column in the warehouse: a boolean is compared with it by constants alone, the column first in an in / not_in`);
    return textFlag(op, anchor, constants);
  }
  // two arguments that are not constants, one a moment: both read as timestamps — a number or a flag is never one
  const exprs = args.filter((a) => !isConstant(a));
  const timed = exprs.length > 1 && exprs.some((a) => isTimeType(a.type));
  if (timed) {
    const other = exprs.find((a) => isNumericType(a.type) || a.type === 'boolean');
    if (other) {
      const moment = exprs.find((a) => isTimeType(a.type));
      throw new Error(`${named(moment)} is a moment (a date or a timestamp), and ${named(other)} is ${other.type}: compare it with a moment — { now: true }, a time column, a date_trunc, or a raw expression that yields a timestamp — or with a date string as a constant`);
    }
  }
  const lit = literal || ((v) => (castKind ? sqlLiteral(v) : typedLiteral(anchor?.type ?? null, v, named(anchor))));
  const write = (a) => (isConstant(a) ? lit(a.value) : operand(castKind && a === anchor ? castToKind(a.sql, castKind, op, dialect) : timed ? timeOperand(a.sql) : a.sql));
  const [s, ...others] = args.map(write);
  if (COMPARE_SQL[op]) {
    if (others.length !== 1) throw new Error(`${op} compares two arguments [a, b], not ${args.length}`);
    return `${s} ${COMPARE_SQL[op]} ${others[0]}`;
  }
  if (op === 'in' || op === 'not_in') {
    if (!others.length) throw new Error(`${op} takes [a, member, …] — at least one member`);
    return `${s} ${op === 'in' ? 'IN' : 'NOT IN'} (${others.join(', ')})`;
  }
  // between
  if (others.length !== 2) throw new Error(`between takes [a, low, high] (both included), not ${args.length} arguments`);
  return `${s} BETWEEN ${others[0]} AND ${others[1]}`;
}

/**
 * The same writer over a SQL left side and constants as one value (a list for in / not_in, [low, high]
 * for between, none for the null tests) — a bound a scan or a window puts on a table, where nothing is
 * known of the left side's type. `lit` writes one constant (sqlLiteral unless the caller binds a type).
 */
export function comparison(lhs, op, value, { lit = sqlLiteral } = {}) {
  const constants = op === 'is_null' || op === 'is_not_null' ? [] : (op === 'in' || op === 'not_in' || op === 'between') && Array.isArray(value) ? value : [value];
  return predicateSql(op, [{ sql: lhs, name: lhs }, ...constants.map((v) => ({ constant: true, value: v }))], { literal: lit });
}
