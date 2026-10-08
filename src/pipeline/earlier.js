// A STEP STORED BY AN EARLIER VERSION, CARRIED OVER ON READ. A draft outlives a deploy, and its steps
// are rendered again on every edit; what an earlier version spelled another way is translated to this
// version's spelling here, once, before a stage is built — the renames from the ONE table that also
// tells a caller this server's spelling (src/validate.js CROSS_PATH_SPELLING: fn → agg, q → percentile,
// avg → average, as → name), a computed column written as { op, …fields } to its expression, a derive
// stage to the compute stage reading the same event property, a join's top-level `on` to via: { on },
// a funnel step's condition on `property`
// to the condition every where writes, and a python function body written as nested arrays of lines
// (a nested array the block under the line before it) to its text. A funnel's `filter` and `metrics`
// have no spelling here: such a kept draft builds as it did (src/match-recognize.js).
// And the stage words of the one vocabulary: a pivot's agg + value_column + its values as names, now
// one measure and { value, name } per value; unpivot's name_as / value_as, now name_column /
// value_column; a funnel's `mode`, folded into between_steps (strict → none); a condition's column
// written as left: { column }, now { column }, a constant written as right: { value }, now `value`, and
// a `value` beside a `right` (the right was what it compared with); unnest's `source`, now { property }
// or { column } as the build resolved it; a sample's percent, now a share; a join window's
// between.value, now between.column; project's `columns`, now keep; limit's `n`, now limit.
// A step in the current spelling passes through unchanged.

import { CROSS_PATH_SPELLING as SPELLING } from '../validate.js';
import { OPS } from '../conditions.js';
import { columnAsLeft, constantAsRight } from './sql.js';

/** The object with each key the table renames given its current name, and an aggregation's old value its current one. */
function respelled(obj, keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = keys.includes(k) && SPELLING[k] ? SPELLING[k] : k;
    out[key] = key === 'agg' && typeof v === 'string' && SPELLING[v] ? SPELLING[v] : v;
  }
  return out;
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
  if (st.op === 'extract') return { fn: 'event_property', property: st.source, ...type };
  if (st.op === 'struct_field') return { fn: 'event_property', property: st.source, field: st.field, ...type };
  if (st.op === 'array_length') return { fn: 'array_length', property: st.source };
  if (st.op === 'contains') return { fn: 'array_contains', property: st.source, item: st.value };
  return null;
}

/** A list of conditions with each one rewritten by `f` — inside { or } and { and } groups too. */
function mapConditions(list, f) {
  return (list || []).map((c) => (c && c.or ? { or: mapConditions(c.or, f) } : c && c.and ? { and: mapConditions(c.and, f) } : f(c)));
}

/** Whether a condition of the list — inside { or } and { and } groups too — is one `pred` holds for. */
function someCondition(list, pred) {
  return Array.isArray(list) && list.some((c) => (c && c.or ? someCondition(c.or, pred) : c && c.and ? someCondition(c.and, pred) : pred(c)));
}

/** A funnel step's condition on `property` — a column of the rows when there is one, else the event
 *  property it named — as the condition every where writes, resolved as the earlier build resolved it. */
function stepCondition(c, cols) {
  if (!c || c.property === undefined) return c;
  const { property, ...rest } = c;
  return cols?.has(property) ? { column: property, ...rest } : { left: { fn: 'event_property', property }, ...rest };
}

/** A condition in this version's closed forms: a column written as left: { column } is `column`, a
 *  `value` beside a `right` is dropped (the right side is what the earlier build compared with), and a
 *  constant written as right: { value } is `value`. */
function currentCondition(c) {
  if (!c || typeof c !== 'object') return c;
  let out = c;
  if (columnAsLeft(out)) {
    const { left, ...rest } = out;
    out = { column: left.column, ...rest };
  }
  if (out.value !== undefined && out.right !== undefined) {
    const { value: _dropped, ...rest } = out;
    out = rest;
  }
  if (constantAsRight(out)) {
    const { right, ...rest } = out;
    out = { ...rest, value: right.value };
  }
  return { ...out, ...(out.left !== undefined ? { left: currentExpr(out.left) } : {}), ...(out.right !== undefined ? { right: currentExpr(out.right) } : {}) };
}

/** An expression with every condition inside it (a CASE's branches, at any depth) in the closed forms. */
function currentExpr(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || e.fn === undefined) return e;
  return {
    ...e,
    ...(Array.isArray(e.args) ? { args: e.args.map(currentExpr) } : {}),
    ...(Array.isArray(e.cases) ? { cases: e.cases.map((cs) => (cs && typeof cs === 'object' ? { ...cs, when: mapConditions(cs.when, currentCondition), then: currentExpr(cs.then) } : cs)) } : {}),
    ...(e.else !== undefined ? { else: currentExpr(e.else) } : {}),
  };
}

/** A condition of an earlier form: its column written as left: { column }, `value` beside `right`, or
 *  its constant written as right: { value }. */
const earlierCondition = (x) => columnAsLeft(x) || constantAsRight(x) || (OPS.includes(x.op) && x.value !== undefined && x.right !== undefined);

/** Whether a stage carries a condition of an earlier form, anywhere in it. */
function keptCondition(st) {
  const walk = (x) => (Array.isArray(x) ? x.some(walk) : !!x && typeof x === 'object' && (earlierCondition(x) || Object.values(x).some(walk)));
  return walk(st);
}

/** A pivot of the earlier { agg, value_column, values: [string] } form as the measure it computed and
 *  the columns it named: each value its own name — a value that is no SQL name (it starts with a digit)
 *  prefixed with '_', as BigQuery's PIVOT names it. */
function currentPivot(st) {
  const { agg, fn, value_column: column, values, ...rest } = st;
  const a = agg ?? (SPELLING[fn] || fn);
  return {
    ...rest,
    measure: { agg: a, ...(column !== undefined ? { column } : {}) },
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
  if (st.stage === 'aggregate' && (st.measures || []).some((m) => m && (m.fn !== undefined || m.q !== undefined))) return { ...st, measures: st.measures.map((m) => respelled(m, ['fn', 'q'])) };
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
  if (st.stage === 'unnest' && st.source !== undefined && st.property === undefined && st.column === undefined) {
    const { source: from, ...rest } = st;
    return { ...rest, ...(unnestsProperty(from, ctx) ? { property: from } : { column: from }) };
  }
  // a step condition of the earlier form carries `property` at its top level — not one that reads an
  // event property as its left side ({ left: { fn: 'event_property', property } }), the form it became
  if (st.stage === 'match_recognize' && (st.steps || []).some((x) => someCondition(x?.where, (c) => !!c && typeof c === 'object' && c.property !== undefined))) {
    return { ...st, steps: st.steps.map((x) => (x?.where ? { ...x, where: mapConditions(x.where, (c) => stepCondition(c, ctx.cols)) } : x)) };
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
  if (keptCondition(st)) {
    if (st.stage === 'where') return { ...st, conditions: mapConditions(st.conditions, currentCondition) };
    if (st.stage === 'aggregate') return { ...st, measures: (st.measures || []).map((m) => (m?.where ? { ...m, where: mapConditions(m.where, currentCondition) } : m)) };
    if (st.stage === 'compute') return { ...st, expr: currentExpr(st.expr) };
    if (st.stage === 'match_recognize') return { ...st, steps: (st.steps || []).map((x) => (x?.where ? { ...x, where: mapConditions(x.where, currentCondition) } : x)) };
  }
  if (st.stage === 'python' && (st.functions || []).some((f) => Array.isArray(f?.body))) return { ...st, functions: st.functions.map((f) => (Array.isArray(f?.body) ? { ...f, body: bodyText(f.body).join('\n') } : f)) };
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
