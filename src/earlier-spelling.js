// AN EARLIER SPELLING, AND WHAT IT IS NOW — every converter from a spelling an earlier version of this
// server took to the one grammar it takes now (src/pipeline/compute.js), in one table:
//   a condition   { column | left | field | property, op, value | right } → { fn: op, args: [subject, …] },
//                 its groups { or: [...] } / { and: [...] } → { fn: "or" | "and", args }, and an
//                 in / not_in / between whose constants are one { value: [...] } → each its own argument;
//   a measure     { name, agg, column | field, percentile?, where?, cast? } (and before it `fn` for agg,
//                 `q` for percentile) → { name, expr }, its aggregate the expression;
//   a pivot's     { agg, column?, percentile? } measure → the aggregate expression itself;
//   a dimension   of a semantic model { field, grain?, label? } (and an update's { from, field }) →
//                 { column | property, … };
//   an expression { fn: "event_property", property, field?, type? } → the leaf { property, field?, type? },
//                 array_length / array_contains naming `property` (and `item`) → args;
//   an unnest's   { property } / { column } → its `expr`;
//   a read's      `transform` (where, group_by + measures, having, order_by, then) → its stages;
//   a metric      a ratio { numerator, denominator } → the derived metric dividing them, a derived
//                 metric's SQL text over its listed `metrics` → the expression of { metric } leaves, a
//                 side or a measure referenced as { name } → its name;
//   a display's   fold (a pivot value's, a drill's) `agg` → `fn` (currentDisplay — a display only: a
//                 pivot value { column, agg } is no measure, so it is not one of currentOf's).
// Each converter leaves a value already in the current spelling as it is (by what it says), so it may
// be applied to anything a store holds. They serve whoever reads a kept value — a draft's steps
// (src/pipeline/earlier.js), a kept eventstream, a stored declaration, a deployment's recipe file, a
// drawn card's display — and the refusal of a NEW call in an earlier spelling, which shows the value
// converted (src/validate.js) but never accepts it.

import { CROSS_PATH_SPELLING as SPELLING } from './validate.js';
import { OPS } from './conditions.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const only = (v, key) => isObj(v) && Object.keys(v).length === 1 && Array.isArray(v[key]);

/** An aggregation's earlier name (avg, mean, quantile …) as the function it is now — from the one
 *  table that also tells a caller this server's spelling; a name it does not rename stays. */
const aggregation = (name) => (['average', 'percentile'].includes(SPELLING[name]) ? SPELLING[name] : name);

/** A subject named `name` where the earlier build read either a column or an event property (a semantic
 *  model's `field`, a funnel step's or a kept prefilter's `property`): what it resolved to,
 *  said by the caller that knows (`opts.subject(name)` → 'column' | 'property'); a column without one. */
const subjectOf = (name, opts) => ((opts.subject ? opts.subject(name) : 'column') === 'property' ? { property: name } : { column: name });

/** Whether an expression is in / not_in / between with its constants as ONE list — { value: [...] }, the
 *  way a condition's `value` held them. */
const listConstant = (e) => ['in', 'not_in', 'between'].includes(e.fn) && Array.isArray(e.args) && e.args.length === 2
  && isObj(e.args[1]) && e.args[1].fn === undefined && Object.keys(e.args[1]).length === 1 && Array.isArray(e.args[1].value);

/** Whether a value is a condition of an earlier form: a comparison with its operator in `op`, or a group. */
export function isEarlierCondition(c) {
  if (!isObj(c) || c.fn !== undefined) return false;
  if (only(c, 'or') || only(c, 'and')) return true;
  return OPS.includes(c.op) && ['column', 'left', 'field', 'property'].some((k) => c[k] !== undefined);
}

/** A condition (or a group of them) in this version's grammar — the same value when it is already. */
export function currentCondition(c, opts = {}) {
  if (!isObj(c)) return c;
  if (c.fn !== undefined) return currentExpression(c, opts);
  if (only(c, 'or') || only(c, 'and')) {
    const items = (c.or || c.and).map((x) => currentCondition(x, opts));
    return items.length === 1 ? items[0] : { fn: c.or ? 'or' : 'and', args: items };
  }
  if (!isEarlierCondition(c)) return c;
  // a metric query's `field` was a reference named as group_by names it ({ model, attribute }, the time
  // axis …): it is the leaf now, as it was written
  const subject = c.left !== undefined ? currentExpression(c.left, opts)
    : c.column !== undefined ? { column: c.column }
      : isObj(c.field) ? c.field
        : c.field !== undefined ? subjectOf(c.field, opts) : subjectOf(c.property, opts);
  if (c.op === 'is_null' || c.op === 'is_not_null') return { fn: c.op, args: [subject] };
  // what the earlier build compared with: the expression `right` when there was one (a `value` beside
  // it was not read), else the constant — a list of them for in / not_in / between, each an argument now
  const many = c.op === 'in' || c.op === 'not_in' || c.op === 'between';
  const others = c.right !== undefined ? [currentExpression(c.right, opts)]
    : many && Array.isArray(c.value) ? c.value.map((v) => ({ value: v }))
      : [{ value: c.value === undefined ? null : c.value }];
  return { fn: c.op, args: [subject, ...others] };
}

/** A list of conditions, each in this version's grammar. */
export function currentConditions(list, opts = {}) {
  return Array.isArray(list) ? list.map((c) => currentCondition(c, opts)) : list;
}

/** An expression in this version's grammar — every earlier form inside it too (a CASE's conditions,
 *  an aggregate's where). */
export function currentExpression(e, opts = {}) {
  if (Array.isArray(e)) return e.map((x) => currentExpression(x, opts));
  if (!isObj(e)) return e;
  if (e.fn === undefined) return isEarlierCondition(e) ? currentCondition(e, opts) : e;
  // an event property read by a function of its own, then; a leaf now
  if (e.fn === 'event_property' && e.args === undefined && e.property !== undefined) {
    return { property: e.property, ...(e.field !== undefined ? { field: e.field } : {}), ...(e.type !== undefined ? { type: e.type } : {}) };
  }
  if ((e.fn === 'array_length' || e.fn === 'array_contains') && e.args === undefined && e.property !== undefined) {
    return { fn: e.fn, args: [{ property: e.property }, ...(e.fn === 'array_contains' ? [{ value: e.item === undefined ? null : e.item }] : [])] };
  }
  // a membership or a range whose constants are one list, as a condition's `value` held them: each its own argument now
  if (listConstant(e)) return { ...e, args: [currentExpression(e.args[0], opts), ...e.args[1].value.map((v) => ({ value: v }))] };
  return {
    ...e,
    ...(Array.isArray(e.args) ? { args: e.args.map((x) => currentExpression(x, opts)) } : {}),
    ...(Array.isArray(e.where) ? { where: currentConditions(e.where, opts) } : {}),
    ...(Array.isArray(e.cases) ? { cases: e.cases.map((cs) => (isObj(cs) ? { ...cs, ...(cs.when !== undefined ? { when: currentConditions(cs.when, opts) } : {}), ...(cs.then !== undefined ? { then: currentExpression(cs.then, opts) } : {}) } : cs)) } : {}),
    ...(e.else !== undefined ? { else: currentExpression(e.else, opts) } : {}),
  };
}

/** Whether a value is a measure of an earlier form: its aggregation in `agg` — or, before that, in `fn`
 *  beside a name — and no arguments (an expression never has a name). An expression whose function is
 *  written under `agg` with its `args` is not one: it is today's grammar with one field misnamed, which
 *  the refusal says as that (CROSS_PATH_SPELLING), keeping its arguments. A stage is never a measure. */
export function isEarlierMeasure(m) {
  if (!isObj(m) || m.expr !== undefined || m.args !== undefined || m.stage !== undefined) return false;
  if (typeof m.agg === 'string' && m.fn === undefined) return true;
  return typeof m.fn === 'string' && m.name !== undefined && m.op === undefined;
}

/**
 * A measure in this version's grammar: { name, expr, …the place's own fields (label) }. A measure
 * written without its name (a pivot's) is its expression alone. A measure already { name, expr } has
 * its expression brought up to date.
 */
export function currentMeasure(m, opts = {}) {
  if (!isObj(m)) return m;
  if (m.expr !== undefined) return { ...m, expr: currentExpression(m.expr, opts) };
  if (!isEarlierMeasure(m)) return m;
  const { name, agg: a, fn: f, column, field, percentile, q, where, cast, ...own } = m;
  const fn = aggregation(a ?? f);
  const subject = column !== undefined ? { column } : field !== undefined ? subjectOf(field, opts) : null;
  // a field read as a number first was cast; it is an argument of cast now
  const arg = subject && cast !== undefined ? { fn: 'cast', args: [subject], type: cast } : subject;
  const quantile = percentile ?? q;
  const expr = {
    fn, args: arg ? [arg] : [],
    ...(fn === 'percentile' && quantile !== undefined ? { percentile: quantile } : {}),
    ...(Array.isArray(where) && where.length ? { where: currentConditions(where, opts) } : {}),
  };
  return name === undefined ? expr : { name, expr, ...own };
}

/** Whether a value is a semantic model's dimension of an earlier form: what it reads named `field`,
 *  beside a declaration's grain and label or an update's `from` — and nothing else. */
export function isEarlierDimension(d) {
  return isObj(d) && typeof d.field === 'string' && d.fn === undefined && Object.keys(d).every((k) => ['field', 'grain', 'label', 'from'].includes(k));
}

/** A semantic model's dimension in this version's spelling: the column or the event property it reads
 *  ({ column } | { property }, which of the two `opts.subject` says), its other fields as they were. */
export function currentDimension(d, opts = {}) {
  if (!isEarlierDimension(d)) return d;
  const { from, field, ...own } = d;
  return { ...(from !== undefined ? { from } : {}), ...subjectOf(field, opts), ...own };
}

/** An unnest of an earlier form — the array named { property } or { column } beside the stage's fields
 *  — with what it explodes as its `expr`. */
export function currentUnnest(st) {
  if (!isObj(st) || st.stage !== 'unnest' || st.expr !== undefined || (st.property === undefined && st.column === undefined)) return st;
  const { stage, property, column, ...rest } = st;
  return { stage, expr: property !== undefined ? { property } : { column }, ...rest };
}

/**
 * A read's earlier `transform` as the stages it is now: its where, its group_by and measures as an
 * aggregate, its having as a where after that, its order_by, and a second level (`then`) as the stages
 * after them — the pipeline's own stages, run over the stored table. A group_by with no measures listed
 * the distinct groups; an aggregate folds something, so they come with their row count (`rows`).
 */
export function transformStages(t) {
  if (!isObj(t)) return [];
  const out = [];
  if (Array.isArray(t.where) && t.where.length) out.push({ stage: 'where', conditions: currentConditions(t.where) });
  const groupBy = Array.isArray(t.group_by) ? t.group_by : [];
  const measures = Array.isArray(t.measures) ? t.measures : [];
  if (groupBy.length || measures.length) out.push({ stage: 'aggregate', ...(groupBy.length ? { group_by: groupBy } : {}), measures: measures.length ? measures.map((m) => currentMeasure(m)) : [{ name: 'rows', expr: { fn: 'count' } }] });
  if (Array.isArray(t.having) && t.having.length) out.push({ stage: 'where', conditions: currentConditions(t.having) });
  if (Array.isArray(t.order_by) && t.order_by.length) out.push({ stage: 'order_by', keys: t.order_by });
  if (isObj(t.then)) out.push(...transformStages(t.then));
  return out;
}

const METRIC_TYPES = ['simple', 'cumulative', 'ratio', 'derived'];
/** A metric's side or measure as an earlier version took it: a name, or `{ name }`. */
const named = (r) => typeof r === 'string' || (isObj(r) && typeof r.name === 'string');
const nameOf = (r) => (isObj(r) && typeof r.name === 'string' ? r.name : r);

/** Whether a value is a semantic metric of an earlier form: a ratio of two named sides, a derived
 *  metric written as SQL text over its listed inputs, or one referencing a side or its measure as
 *  `{ name }`. Only a metric — an object a metric `type` names, never a stage — is one. */
export function isEarlierMetric(m) {
  if (!isObj(m) || !METRIC_TYPES.includes(m.type) || m.stage !== undefined || m.fn !== undefined) return false;
  if (m.type === 'ratio') return named(m.numerator) && named(m.denominator);
  if (m.type === 'derived' && typeof m.expr === 'string' && Array.isArray(m.metrics)) return true;
  return ['measure', 'numerator', 'denominator'].some((k) => isObj(m[k]) && typeof m[k].name === 'string');
}

/**
 * A derived metric's earlier `expr` — SQL arithmetic over its input metrics' names — as the expression
 * it is now: `+ - * /` (by precedence, parentheses kept), numbers, the input metrics as { metric } leaves
 * and the functions a derived metric computes with, under their SQL names (`ceiling` is ceil). Anything
 * else in the text — another function, a name that is not an input — leaves it unread (null), and the
 * value is kept as written, for build_semantic_model to refuse with the way to write it.
 */
function derivedExpression(text, inputs) {
  const tokens = String(text).match(/\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[-+*/(),])/g)?.map((t) => t.trim());
  if (!tokens || tokens.join('') !== String(text).replace(/\s+/g, '')) return null;
  const SQL_NAMES = { round: 'round', floor: 'floor', ceil: 'ceil', ceiling: 'ceil', abs: 'abs', coalesce: 'coalesce', least: 'least', greatest: 'greatest' };
  const OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => { if (tokens[i] !== t) throw new Error(t); i += 1; };
  const binary = (next, ops) => () => {
    let left = next();
    while (ops.includes(peek())) { const op = tokens[i++]; left = { fn: OPS[op], args: [left, next()] }; }
    return left;
  };
  const primary = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('end');
    if (t === '(') { const e = sum(); take(')'); return e; }
    if (t === '-') { const e = primary(); return typeof e.value === 'number' ? { value: -e.value } : { fn: 'sub', args: [{ value: 0 }, e] }; }
    if (/^\d/.test(t)) return { value: Number(t) };
    const fn = SQL_NAMES[t.toLowerCase()];
    if (peek() === '(' && fn) {
      take('(');
      const args = [sum()];
      while (peek() === ',') { take(','); args.push(sum()); }
      take(')');
      return { fn, args };
    }
    if (inputs.has(t)) return { metric: t };
    throw new Error(t);
  };
  const product = binary(primary, ['*', '/']);
  const sum = binary(product, ['+', '-']);
  try {
    const e = sum();
    return i === tokens.length ? e : null;
  } catch { return null; }
}

/**
 * A metric in this version's spelling: a side or a measure referenced as `{ name }` is its name; a
 * derived metric's text over its inputs (listed as names or as `[{ metric, name }]`, an alias read as
 * the metric it stood for) is the expression of { metric } leaves it computes; a ratio is the derived
 * metric dividing its numerator by its denominator, each read as a METRIC (currentMetrics also reads a
 * side that names a measure of the declaration). The same value when it is of no earlier form.
 */
export function currentMetric(m) {
  if (!isEarlierMetric(m)) return m;
  let out = m;
  for (const k of ['measure', 'numerator', 'denominator']) if (isObj(out[k]) && typeof out[k].name === 'string') out = { ...out, [k]: out[k].name };
  if (out.type === 'ratio') {
    const { numerator, denominator, type: _t, ...own } = out;
    return { ...own, type: 'derived', expr: { fn: 'div', args: [{ metric: numerator }, { metric: denominator }] } };
  }
  if (out.type === 'derived' && typeof out.expr === 'string' && Array.isArray(out.metrics)) {
    const alias = new Map(out.metrics.map((x) => (isObj(x) ? [x.name ?? x.metric, x.metric] : [x, x])));
    // every identifier at once, so two aliases swapped with each other's metric are read as written
    const text = out.expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (tok) => alias.get(tok) ?? tok);
    const expr = derivedExpression(text, new Set(alias.values()));
    if (expr) {
      const { metrics: _m, ...rest } = out;
      out = { ...rest, expr };
    }
  }
  return out;
}

/**
 * A declaration's metrics in this version's spelling, each as currentMetric has it — and a ratio's side
 * that names no metric of the list read as the earlier build read it: through a simple metric over that
 * measure, the one the list declares, else one named as the measure is, added as that build added it.
 * The same list when nothing in it is of an earlier form.
 */
export function currentMetrics(metrics) {
  if (!Array.isArray(metrics)) return metrics;
  const names = new Set(metrics.map((m) => m?.name));
  const over = new Map(metrics.filter((m) => m?.type === 'simple' && named(m.measure)).map((m) => [nameOf(m.measure), m.name]));
  const made = [];
  const side = (r) => {
    const ref = nameOf(r);
    if (names.has(ref)) return ref;
    if (over.has(ref)) return over.get(ref);
    names.add(ref);
    over.set(ref, ref);
    made.push({ name: ref, type: 'simple', measure: ref });
    return ref;
  };
  const out = metrics.map((m) => currentMetric(m?.type === 'ratio' && isEarlierMetric(m) ? { ...m, numerator: side(m.numerator), denominator: side(m.denominator) } : m));
  return made.length || out.some((m, i) => m !== metrics[i]) ? [...made, ...out] : metrics;
}

/**
 * A display kept with a drawn task, in this version's spelling: a card drawn before a value's fold was
 * `fn` kept it as `agg` — a pivot value's and a drill's — and a card outlives a restart, so the display
 * it was drawn with is read through this before a view of it is made. The same object when nothing in it
 * is of the earlier spelling.
 */
export function currentDisplay(display) {
  const fold = (x) => {
    if (!x || typeof x !== 'object' || x.agg === undefined) return x;
    const { agg, ...rest } = x;
    return { ...rest, fn: rest.fn ?? agg };
  };
  if (!display || typeof display !== 'object') return display;
  const values = display.kind === 'pivot' && Array.isArray(display.values) && display.values.some((v) => v?.agg !== undefined) ? display.values.map(fold) : display.values;
  const drill = fold(display.drill);
  return values === display.values && drill === display.drill ? display : { ...display, ...(values !== undefined ? { values } : {}), ...(drill !== undefined ? { drill } : {}) };
}

/**
 * ANY VALUE, with every earlier form in it converted — a condition, a measure, a pivot's measure, a
 * semantic metric, an expression, an unnest, a read's transform — wherever it sits; the same value (by
 * identity) when nothing in it is of an earlier form. `opts.subject` as currentCondition's. A metric's
 * sides are read as metrics here (a list's are read by currentMetrics); a display is not walked
 * (currentDisplay).
 */
export function currentOf(value, opts = {}) {
  if (Array.isArray(value)) {
    const out = value.map((v) => currentOf(v, opts));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!isObj(value)) return value;
  if (isEarlierCondition(value)) return currentCondition(value, opts);
  if (isEarlierMetric(value)) return currentMetric(value);
  if (isEarlierMeasure(value)) return currentMeasure(value, opts);
  if (isEarlierDimension(value)) return currentDimension(value, opts);
  if (value.fn === 'event_property' || ((value.fn === 'array_length' || value.fn === 'array_contains') && value.args === undefined && value.property !== undefined) || listConstant(value)) return currentExpression(value, opts);
  if (value.stage === 'unnest' && value.expr === undefined && (value.property !== undefined || value.column !== undefined)) return currentUnnest(value);
  if (isObj(value.transform) && value.stages === undefined) {
    const { transform, ...rest } = value;
    return currentOf({ ...rest, stages: transformStages(transform) }, opts);
  }
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const c = currentOf(v, opts);
    if (c !== v) changed = true;
    out[k] = c;
  }
  return changed ? out : value;
}
