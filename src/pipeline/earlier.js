// A STEP STORED BY AN EARLIER VERSION, CARRIED OVER ON READ. A draft outlives a deploy, and its steps
// are rendered again on every edit; what an earlier version spelled another way is translated to this
// version's spelling here, once, before a stage is built. The grammar of what a stage holds — a
// condition, a measure, an expression, an unnest's array, a pivot's measure — is converted by the ONE
// table of those converters (src/earlier-spelling.js); a funnel step's condition on `property` reads a
// column of the rows when there is one, else the event property, as the earlier build resolved it.
// The stage words are this module's own: a computed column written as { op, …fields } is its
// expression, a derive stage the compute stage reading the same event property, a join's top-level
// `on` is via: { on } and its attrs' `as` their `name`, a join window's between.value is between.column;
// a pivot's agg + value_column + its values as names is one measure and { value, name } per value;
// unpivot's name_as / value_as are name_column / value_column; a funnel's `mode` is folded into
// between_steps (strict → none); unnest's `as` is `name` and its `source` the array it names; a
// sample's percent is a share; project's `columns` is keep; limit's `n` is limit; and a python function
// body written as nested arrays of lines (a nested array the block under the line before it) is its
// text. A funnel's `filter` and `metrics` have no spelling here: such a kept draft builds as it did
// (src/match-recognize.js). A step in the current spelling passes through unchanged.

import { CROSS_PATH_SPELLING as SPELLING } from '../validate.js';
import { currentConditions, currentExpression, currentMeasure, isEarlierMeasure, currentUnnest } from '../earlier-spelling.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The object with each of `keys` the table renames given its current name (`as` → `name`). */
function respelled(obj, keys) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [keys.includes(k) && SPELLING[k] ? SPELLING[k] : k, v]));
}

const ONE = new Set(['floor', 'ceil', 'abs', 'upper', 'lower', 'length', 'trim', 'unix_date', 'hll_extract', 'json_parse_array']);

/** A computed column of the earlier { op, …fields } form, as the expression it computes. */
function computeExpr(st) {
  const col = () => ({ column: st.column });
  const fn = (name, args, params = []) => ({ fn: name, ...(args ? { args } : {}), ...Object.fromEntries(params.filter((k) => st[k] !== undefined).map((k) => [k === 'granularity' ? 'grain' : k, st[k]])) });
  const op = st.op;
  if (op === 'const') return { value: st.value };
  if (['add', 'sub', 'mul', 'div'].includes(op)) return fn(op, [st.left, st.right]);
  if (ONE.has(op)) return fn(op, [col()]);
  if (op === 'round') return fn(op, [col()], ['places']);
  if (op === 'coalesce') return fn(op, [...(st.columns || []).map((c) => ({ column: c })), ...(st.default !== undefined ? [{ value: st.default }] : [])]);
  if (['least', 'greatest', 'concat'].includes(op)) return fn(op, st.parts);
  if (op === 'cast') return fn(op, [col()], ['type']);
  if (op === 'substring') return fn(op, [col()], ['start', 'len']);
  if (op === 'replace') return fn(op, [col()], ['search', 'replacement']);
  if (op === 'json_field') return fn(op, [col()], ['field', 'type']);
  if (op === 'element_at') return fn(op, [col()], ['index', 'type']);
  if (op === 'array_last') return fn(op, [col()], ['type']);
  // the earlier raw named its columns in its text, which went to the warehouse as written — as the
  // text of a raw goes now; nothing is read out of it to move into args
  if (op === 'raw') return fn(op, null, ['sql', 'type']);
  if (op === 'date_diff') return fn(op, [st.from, st.to], ['unit']);
  if (op === 'date_trunc') return fn(op, [col()], ['granularity']);
  if (op === 'date_part') return fn(op, [col()], ['part']);
  if (op === 'elapsed_days') return fn(op, [st.from, st.to], ['clamp_zero']);
  if (op === 'case') return fn(op, null, ['cases', 'else', 'type']);
  if (op === 'window') {
    const w = SPELLING[st.fn] || st.fn;
    const aggregate = ['sum', 'average', 'min', 'max', 'count'].includes(w);
    const over = Object.fromEntries(['partition_by', 'order_by', ...(aggregate ? ['frame'] : [])].filter((k) => st[k] !== undefined).map((k) => [k, st[k]]));
    if (['row_number', 'rank', 'dense_rank'].includes(w)) return { fn: w, over };
    if (['lag', 'lead'].includes(w)) return { fn: w, args: [col()], ...(st.offset !== undefined ? { offset: st.offset } : {}), ...(st.default !== undefined ? { default: st.default } : {}), over };
    return { fn: w, args: st.column !== undefined ? [col()] : [], over };
  }
  return null; // an op this version never had: left for the stage's own refusal
}

/** A python body of the earlier form — a line is a string, a nested array the block indented under
 *  the line before it — as the text it stood for, four spaces a level. */
function bodyText(items, depth = 0) {
  return items.flatMap((x) => (Array.isArray(x) ? bodyText(x, depth + 1) : [`${'    '.repeat(depth)}${x}`]));
}

/** A derive stage (one column read from an event property) as the compute stage that reads it now. */
function deriveExpr(st) {
  const type = st.type !== undefined ? { type: st.type } : {};
  if (st.op === 'extract') return { property: st.source, ...type };
  if (st.op === 'struct_field') return { property: st.source, field: st.field, ...type };
  if (st.op === 'array_length') return { fn: 'array_length', args: [{ property: st.source }] };
  if (st.op === 'contains') return { fn: 'array_contains', args: [{ property: st.source }, { value: st.value === undefined ? null : st.value }] };
  return null;
}

/** A pivot of the earlier { agg, value_column, values: [string] } form as the measure it computed and
 *  the columns it named: each value its own name — a value that is no SQL name (it starts with a digit)
 *  prefixed with '_', as BigQuery's PIVOT names it. */
function currentPivot(st) {
  const { agg, fn, value_column: column, values, ...rest } = st;
  const a = agg ?? fn;
  return {
    ...rest,
    measure: currentMeasure({ agg: a, ...(column !== undefined ? { column } : {}) }),
    values: (values || []).map((v) => (v && typeof v === 'object' ? v : { value: v, name: /^[A-Za-z_]/.test(String(v)) ? String(v) : `_${v}` })),
  };
}

/** The stage in this version's spelling (the same object when it already is). `ctx.cols` — the
 *  columns before it — settles what an earlier spelling left to the build to resolve; `ctx.catalog`
 *  and `ctx.source` what it resolved against the source (an unnest's property or column). */
export function currentSpelling(st, ctx = {}) {
  if (!st || typeof st !== 'object') return st;
  // one rename at a time, until the stage is in this version's spelling (a stage may carry several)
  let cur = st;
  for (let i = 0; i < 16; i++) {
    const next = currentStage(cur, ctx);
    if (next === cur || JSON.stringify(next) === JSON.stringify(cur)) return cur;
    cur = next;
  }
  return cur;
}

function currentStage(st, ctx) {
  if (st.stage === 'derive') {
    const expr = deriveExpr(st);
    return expr ? { stage: 'compute', name: st.name, expr } : st;
  }
  if (st.stage === 'compute' && st.op !== undefined && st.expr === undefined) {
    const expr = computeExpr(st);
    return expr ? { stage: 'compute', name: st.name, expr } : st;
  }
  if (st.stage === 'pivot' && st.measure === undefined && (st.agg !== undefined || st.fn !== undefined || st.value_column !== undefined)) return currentPivot(st);
  if (st.stage === 'unpivot' && (st.name_as !== undefined || st.value_as !== undefined)) {
    const { name_as: nameColumn, value_as: valueColumn, ...rest } = st;
    return { ...rest, ...(nameColumn !== undefined ? { name_column: nameColumn } : {}), ...(valueColumn !== undefined ? { value_column: valueColumn } : {}) };
  }
  if (st.stage === 'join' && st.on !== undefined && st.via === undefined) {
    const { on, ...rest } = st;
    return { ...rest, via: { on } };
  }
  if (st.stage === 'join' && (st.attrs || []).some((a) => a && typeof a === 'object' && a.as !== undefined)) return { ...st, attrs: st.attrs.map((a) => (a && typeof a === 'object' ? respelled(a, ['as']) : a)) };
  if (st.stage === 'join' && st.between && typeof st.between === 'object' && st.between.value !== undefined && st.between.column === undefined) {
    const { value: column, ...rest } = st.between;
    return { ...st, between: { column, ...rest } };
  }
  if (st.stage === 'unnest' && st.as !== undefined) return respelled(st, ['as']);
  if (st.stage === 'unnest' && st.source !== undefined && st.property === undefined && st.column === undefined && st.expr === undefined) {
    const { source: from, ...rest } = st;
    return { ...rest, ...(unnestsProperty(from, ctx) ? { property: from } : { column: from }) };
  }
  if (st.stage === 'match_recognize' && st.mode !== undefined) {
    const { mode, between_steps: between, ...rest } = st;
    const steps = mode === 'strict' ? 'none' : between;
    return { ...rest, ...(steps !== undefined ? { between_steps: steps } : {}) };
  }
  if (st.stage === 'sample' && st.percent !== undefined && st.share === undefined) {
    const { percent, ...rest } = st;
    return { ...rest, share: Number(percent) / 100 };
  }
  if (st.stage === 'project' && st.columns !== undefined && st.keep === undefined) {
    const { columns: keep, ...rest } = st;
    return { ...rest, keep };
  }
  if (st.stage === 'limit' && st.n !== undefined && st.limit === undefined) {
    const { n: limit, ...rest } = st;
    return { ...rest, limit };
  }
  if (st.stage === 'python' && (st.functions || []).some((f) => Array.isArray(f?.body))) return { ...st, functions: st.functions.map((f) => (Array.isArray(f?.body) ? { ...f, body: bodyText(f.body).join('\n') } : f)) };
  // what a stage holds, in the one grammar — the same value when it already is
  if (st.stage === 'unnest') return currentUnnest(st);
  if (st.stage === 'where' && Array.isArray(st.conditions)) return { ...st, conditions: currentConditions(st.conditions) };
  if (st.stage === 'aggregate' && Array.isArray(st.measures)) return { ...st, measures: st.measures.map((m) => currentMeasure(m)) };
  if (st.stage === 'compute' && st.expr !== undefined) return { ...st, expr: currentExpression(st.expr) };
  if (st.stage === 'pivot' && st.measure !== undefined) return { ...st, measure: isEarlierMeasure(st.measure) ? currentMeasure(st.measure) : currentExpression(st.measure) };
  if (st.stage === 'match_recognize' && Array.isArray(st.steps)) {
    // a step's condition on `property` reads a column of the rows when there is one — as it did
    const subject = (name) => (ctx.cols?.has(name) ? 'column' : 'property');
    return { ...st, steps: st.steps.map((x) => (isObj(x) && x.where !== undefined ? { ...x, where: currentConditions(x.where, { subject }) } : x)) };
  }
  return st;
}

/** Whether a kept unnest's `source` named an event property, resolved as its build resolved it: a
 *  property of the source first (another source's property too — the property form names the owner),
 *  else a column at this step; with nothing to resolve against, a name that is no column here. */
function unnestsProperty(name, { catalog, source, cols } = {}) {
  if (catalog && source) {
    try { if (catalog.propertyFor(source, name)?.spec) return true; } catch { return true; }
    return !cols?.has(name);
  }
  return !cols?.has(name);
}
