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
//   a semantic    model item { from, where?, dimensions?, measures? } and a dimension an update removes
//                 { from, column | property | name } → `source` names the model;
//   an update     of build_semantic_model naming its task `task` → `name`;
//   a ref         { model, attribute, via? } (a metric query's group_by and where) → { source, column,
//                 via? }, { source, property } or { semantic_model: [model], dimension } — which of the
//                 three `opts.subject(attribute, model)` says ('column' | 'property' | 'dimension');
//   an expression { fn: "event_property", property, field?, type? } → the leaf { property, field? },
//                 array_length / array_contains naming `property` (and `item`) → args;
//   a typed read  { property, field?, type } and json_field / element_at / array_last with a `type` → the
//                 read, which yields its own type now (a property the catalog's — `opts.propertyType(name)`
//                 says it —, a field of one or an element text), converted by cast when `type` is another;
//   an aggregate  { fn, args, where } → the aggregate over a case that yields its argument where the
//                 conditions hold (a count of the rows: 1) and nothing on every other row;
//   an unnest's   { property } / { column } → its `expr`; its `type`, in a list of steps, → the element
//                 read as it is under `<name>_element` and a compute stage casting it under `name` (a
//                 kept draft's builds as it did: src/pipeline/earlier.js);
//   a read's      `transform` (where, group_by + measures, having, order_by, then) → its steps;
//   a query's     input kept with its task (currentQueryInput): a read's `stages` (or `transform`) → its
//                 `steps`, a metric query's `order_by` → the order_by step after them, its `metrics`,
//                 `group_by` and `where` → its metrics step, after a where step of that where;
//   a metric      a ratio { numerator, denominator } → the derived metric dividing them, a derived
//                 metric's SQL text over its listed `metrics` → the expression of { metric } leaves, a
//                 side or a measure referenced as { name } → its name;
//   a display's   fold (a pivot value's, a drill's) `agg` → `fn` (currentDisplay — a display only: a
//                 pivot value { column, agg } is no measure, so it is not one of currentOf's);
//   a request's   "show me more" flags (include_columns, include_steps, include_yaml, include_plan,
//                 include_coverage, explore_errors' detail: full) → the one list `include` of what they
//                 asked for (currentInclude).
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

/** Whether a value is a ref of an earlier form: what a metric query names, { model, attribute, via? }. */
export function isEarlierRef(v) {
  return isObj(v) && typeof v.model === 'string' && typeof v.attribute === 'string' && Object.keys(v).every((k) => ['model', 'attribute', 'via'].includes(k));
}

/**
 * A ref in this version's spelling: the model's column { source, column, via? }, its event property
 * { source, property } (a payload property the task declared a dimension) or a dimension the task
 * computed there { semantic_model: [model], dimension } — which, the caller that knows says
 * (`opts.subject(attribute, model)` → 'column' | 'property' | 'dimension'); a column without one, and
 * one that names a relationship (`via`), which only a column is reached through.
 */
export function currentRef(v, opts = {}) {
  if (!isEarlierRef(v)) return v;
  const { model, attribute, via } = v;
  const kind = via === undefined && opts.subject ? opts.subject(attribute, model) : 'column';
  if (kind === 'property') return { source: model, property: attribute };
  if (kind === 'dimension') return { semantic_model: [model], dimension: attribute };
  return { source: model, column: attribute, ...(via !== undefined ? { via } : {}) };
}

/** Whether a value names its model `from` where this version names it `source`: an item of a
 *  declaration's semantic_models, or a dimension an update removes. */
const isEarlierSourceItem = (v) => isObj(v) && typeof v.from === 'string' && v.source === undefined
  && Object.keys(v).every((k) => ['from', 'where', 'dimensions', 'measures', 'column', 'property', 'name'].includes(k));

/** Whether a value is build_semantic_model's update naming the task it changes `task` (`name` now). */
const isEarlierUpdate = (v) => isObj(v) && v.action === 'update' && typeof v.task === 'string' && v.name === undefined;

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
  // axis …): it is the leaf now, in this version's spelling
  const subject = c.left !== undefined ? currentExpression(c.left, opts)
    : c.column !== undefined ? { column: c.column }
      : isObj(c.field) ? currentRef(c.field, opts)
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

/** The functions that read a value out of a JSON document or an array, and once took the `type` to read it as. */
const TYPED_READS = ['json_field', 'element_at', 'array_last'];

/** Whether an expression reads a value as a type it names, the way an earlier version took one: an
 *  event property { property, field?, type }, or json_field / element_at / array_last with a `type`. */
export function isTypedRead(e) {
  if (!isObj(e) || e.type === undefined) return false;
  if (e.fn === undefined) return typeof e.property === 'string' && Object.keys(e).every((k) => ['property', 'field', 'type'].includes(k));
  return TYPED_READS.includes(e.fn);
}

/** A typed read as the read alone and, where `type` is not what the read yields now, a cast to it. An
 *  event property yields its catalog type (`opts.propertyType(name)`; without one it is not known, and
 *  the cast stays), a field of one and what json_field / element_at / array_last read text. */
function untypedRead(e, opts) {
  const { type, ...read } = e;
  const yields = e.fn === undefined && e.field === undefined ? opts.propertyType?.(e.property) : 'string';
  return yields != null && String(yields).toLowerCase() === String(type).toLowerCase() ? read : { fn: 'cast', args: [read], type };
}

/** Whether an expression is an aggregate of an earlier form: the rows it folds narrowed by a `where`
 *  of its own (only an aggregate folding rows took one). */
export const isEarlierAggregate = (e) => isObj(e) && typeof e.fn === 'string' && Array.isArray(e.where) && e.over === undefined;

/** An aggregate's earlier `where` (its conditions already current) as what it folds now: a case that
 *  yields its argument — 1 for a count of the rows — where the conditions hold, and nothing on every
 *  other row, which the aggregate skips: the same rows folded, the same value. */
function overCase(e) {
  const { where, ...rest } = e;
  if (!where.length) return rest;
  const [arg] = Array.isArray(rest.args) ? rest.args : [];
  return { ...rest, args: [{ fn: 'case', cases: [{ when: where, then: arg === undefined ? { value: 1 } : arg }] }] };
}

/** An expression in this version's grammar — every earlier form inside it too (a CASE's conditions,
 *  an aggregate's where, a typed read). `opts.propertyType` as untypedRead's. */
export function currentExpression(e, opts = {}) {
  if (Array.isArray(e)) return e.map((x) => currentExpression(x, opts));
  if (!isObj(e)) return e;
  if (e.fn === undefined) {
    if (isTypedRead(e)) return untypedRead(e, opts);
    return isEarlierCondition(e) ? currentCondition(e, opts) : currentRef(e, opts);
  }
  // an event property read by a function of its own, then; a leaf now
  if (e.fn === 'event_property' && e.args === undefined && e.property !== undefined) {
    return currentExpression({ property: e.property, ...(e.field !== undefined ? { field: e.field } : {}), ...(e.type !== undefined ? { type: e.type } : {}) }, opts);
  }
  if ((e.fn === 'array_length' || e.fn === 'array_contains') && e.args === undefined && e.property !== undefined) {
    return { fn: e.fn, args: [{ property: e.property }, ...(e.fn === 'array_contains' ? [{ value: e.item === undefined ? null : e.item }] : [])] };
  }
  // a membership or a range whose constants are one list, as a condition's `value` held them: each its own argument now
  if (listConstant(e)) return { ...e, args: [currentExpression(e.args[0], opts), ...e.args[1].value.map((v) => ({ value: v }))] };
  const out = {
    ...e,
    ...(Array.isArray(e.args) ? { args: e.args.map((x) => currentExpression(x, opts)) } : {}),
    ...(Array.isArray(e.where) ? { where: currentConditions(e.where, opts) } : {}),
    ...(Array.isArray(e.cases) ? { cases: e.cases.map((cs) => (isObj(cs) ? { ...cs, ...(cs.when !== undefined ? { when: currentConditions(cs.when, opts) } : {}), ...(cs.then !== undefined ? { then: currentExpression(cs.then, opts) } : {}) } : cs)) } : {}),
    ...(e.else !== undefined ? { else: currentExpression(e.else, opts) } : {}),
  };
  if (isEarlierAggregate(out)) return overCase(out);
  return isTypedRead(out) ? untypedRead(out, opts) : out;
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
  // its where, as an aggregate's: the rows it folds are a case's now (overCase)
  const expr = currentExpression({
    fn, args: arg ? [arg] : [],
    ...(fn === 'percentile' && quantile !== undefined ? { percentile: quantile } : {}),
    ...(Array.isArray(where) && where.length ? { where } : {}),
  }, opts);
  return name === undefined ? expr : { name, expr, ...own };
}

/** Whether a value is a semantic model's dimension of an earlier form: what it reads named `field`,
 *  beside a declaration's grain and label or an update's `from` — and nothing else. */
export function isEarlierDimension(d) {
  return isObj(d) && typeof d.field === 'string' && d.fn === undefined && Object.keys(d).every((k) => ['field', 'grain', 'label', 'from'].includes(k));
}

/** A semantic model's dimension in this version's spelling: the column or the event property it reads
 *  ({ column } | { property }, which of the two `opts.subject` says), its other fields as they were —
 *  an update's model, `from` then, named `source`. */
export function currentDimension(d, opts = {}) {
  if (!isEarlierDimension(d)) return d;
  const { from, field, ...own } = d;
  return { ...(from !== undefined ? { source: from } : {}), ...subjectOf(field, opts), ...own };
}

/** An unnest of an earlier form — the array named { property } or { column } beside the stage's fields
 *  — with what it explodes as its `expr`. */
export function currentUnnest(st) {
  if (!isObj(st) || st.stage !== 'unnest' || st.expr !== undefined || (st.property === undefined && st.column === undefined)) return st;
  const { stage, property, column, ...rest } = st;
  return { stage, expr: property !== undefined ? { property } : { column }, ...rest };
}

/** Whether a step is an unnest naming the type its element is read as, the way an earlier version took one. */
export const isTypedUnnest = (st) => isObj(st) && st.stage === 'unnest' && st.type !== undefined && typeof st.name === 'string';

/**
 * A typed unnest as the steps it is now: the element read as it is (text, or a whole struct element's
 * JSON) — a `type` of text said that already, and goes — else under `<name>_element`, with a compute
 * stage after it casting the element under `name`, so the steps after them read the column they did.
 * (A KEPT draft's unnest is not split: its indexes and checkpoints count its steps — it builds as it
 * did, src/pipeline/earlier.js.)
 */
export function untypedUnnest(st) {
  const { type, ...rest } = currentUnnest(st);
  if (String(type).toLowerCase() === 'string') return [rest];
  const element = `${rest.name}_element`;
  return [{ ...rest, name: element }, { stage: 'compute', name: rest.name, expr: { fn: 'cast', args: [{ column: element }], type } }];
}

/**
 * A read's earlier `transform` as the steps it is now: its where, its group_by and measures as an
 * aggregate, its having as a where after that, its order_by, and a second level (`then`) as the steps
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

/** The fields a metric query took beside its metrics, in any version — what tells a query apart from a
 *  bare list of metric names, which is also what an update removes. */
const METRIC_QUERY_FIELDS = ['context_id', 'group_by', 'where', 'order_by', 'steps', 'time_range', 'limit', 'materialize', 'dry_run', 'include', 'include_plan'];

/** Whether a value is a metric query of an earlier form: its metrics named outside its steps (a metrics
 *  step now). `asQuery`: it stands where a query does (a kept input, a batch's item); elsewhere it is
 *  told by a field of a query beside them. A step is never one. */
export const isEarlierMetricQuery = (v, asQuery = false) => isObj(v) && v.stage === undefined && Array.isArray(v.metrics) && v.metrics.every((m) => typeof m === 'string')
  && (asQuery || METRIC_QUERY_FIELDS.some((k) => v[k] !== undefined));

/** Whether a query's input says, outside its steps, what an earlier version wrote there: a read's
 *  `transform`, or a metric query's metrics (with its group_by, where, order_by) — a batch's queries too. */
const earlierQueryParts = (v) => (isObj(v.transform) && v.steps === undefined && v.stages === undefined)
  || isEarlierMetricQuery(v) || (Array.isArray(v.queries) && v.queries.some((q) => isEarlierMetricQuery(q, true)));

/**
 * A QUERY'S INPUT AS AN EARLIER VERSION KEPT IT WITH ITS TASK, in this version's spelling — what a query
 * is read back by when it is read again (a recipe's example query, a kept call). The steps a read runs
 * were its `stages` (its `transform` before that); a metric query's `order_by` is the order_by step after
 * its steps, which run over the metric result; its `metrics` and `group_by` are its metrics step, its
 * `where` a where step before it and its steps the steps after it; what its group_by and where name were
 * { model, attribute } refs (currentRef, `opts.subject` as there), and its plan was `include_plan`. A
 * batch's queries alike. The same object when nothing in it is of an earlier spelling. (A NEW call that
 * writes `stages` is told the field's name by the refusal, CROSS_PATH_SPELLING; one with a `transform`, a
 * metric query's metrics outside its steps, a { model, attribute } or a flag is shown converted, currentOf.)
 */
export function currentQueryInput(input, opts = {}) {
  if (!isObj(input)) return input;
  const o = isObj(opts) ? opts : {}; // (mapped over a list, the second argument is an index)
  let out = input;
  if (Array.isArray(out.queries)) {
    const queries = out.queries.map((q) => currentQueryInput(q, o));
    if (queries.some((q, i) => q !== out.queries[i])) out = { ...out, queries };
  }
  if (Array.isArray(out.metrics) && isEarlierInclude(out)) out = currentInclude(out);
  if (out.steps === undefined && (Array.isArray(out.stages) || isObj(out.transform))) {
    const { stages, transform, ...rest } = out;
    out = { ...rest, steps: Array.isArray(stages) ? stages : transformStages(transform) };
  }
  if (Array.isArray(out.metrics) && Array.isArray(out.order_by)) {
    const { order_by: keys, ...rest } = out;
    out = keys.length ? { ...rest, steps: [...(rest.steps || []), { stage: 'order_by', keys }] } : rest;
  }
  // the metric query itself: its metrics step, the rows its metrics fold a where step before it, and its
  // steps after it (a list left empty said nothing)
  if (isEarlierMetricQuery(out, true)) {
    const { metrics, group_by: groupBy, where, steps, ...rest } = out;
    out = {
      ...rest,
      steps: [
        ...(Array.isArray(where) && where.length ? [{ stage: 'where', conditions: where }] : []),
        { stage: 'metrics', metrics, ...(Array.isArray(groupBy) && groupBy.length ? { group_by: groupBy } : {}) },
        ...(Array.isArray(steps) ? steps : []),
      ],
    };
  }
  // what its steps hold, in the one grammar (a ref, a condition, an aggregate's where, a typed read)
  if (Array.isArray(out.steps)) {
    const steps = currentOf(out.steps, o);
    if (steps !== out.steps) out = { ...out, steps };
  }
  return out;
}

/** A boolean "show me more" flag: true asked for `name`, false for nothing — any other value is no such flag. */
const flag = (name) => (x) => (typeof x === 'boolean' ? (x ? [name] : []) : null);

/** Each "show me more" field an earlier version took, and what it asked for in the one list `include`
 *  now (null: the value is not that field's earlier form) — a flag per thing, and explore_errors' level
 *  of `detail` (full: each error's details; summary, its default: nothing more). */
const EARLIER_INCLUDE = {
  include_columns: flag('columns'), include_steps: flag('steps'), include_yaml: flag('yaml'), include_plan: flag('plan'), include_coverage: flag('coverage'),
  detail: (x) => (x === 'full' ? ['details'] : x === 'summary' ? [] : null),
};
const asked = (k, x) => (Object.hasOwn(EARLIER_INCLUDE, k) ? EARLIER_INCLUDE[k](x) : null);

/** Whether a value asks for more of an answer the way an earlier version did: a field per thing. */
export const isEarlierInclude = (v) => isObj(v) && Object.entries(v).some(([k, x]) => asked(k, x) !== null) && (v.include === undefined || Array.isArray(v.include));

/**
 * A request's flags as the one list `include` — what each flag set to true asked for, after what the
 * list already holds (a flag set to false asked for nothing, and goes); the same value when it holds no
 * flag. A request kept with its task and read again is carried over by this, and a new call written so
 * is refused with it converted (src/validate.js).
 */
export function currentInclude(v) {
  if (!isEarlierInclude(v)) return v;
  const include = [...(v.include || [])];
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const names = asked(k, x);
    if (names) { for (const n of names) if (!include.includes(n)) include.push(n); } else if (k !== 'include') out[k] = x;
  }
  return include.length ? { ...out, include } : out;
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
 * semantic metric, an expression (a typed read, an aggregate's where), an unnest (a typed one in a list
 * of steps, two), a read's transform, a metric query's metrics outside its steps, a request's
 * include flags, a { model, attribute } ref, a semantic model item's `from`, an update's `task` —
 * wherever it sits; the same value (by identity) when nothing in it is of an earlier form. `opts.subject`
 * as currentCondition's and currentRef's. A metric's sides are read as metrics here (a list's are read
 * by currentMetrics); a display is not walked (currentDisplay); a field only renamed (`stages`) is the
 * refusal's hint, not a conversion of the whole value.
 */
export function currentOf(value, opts = {}) {
  if (Array.isArray(value)) {
    // a typed unnest in a list of steps is two steps now (untypedUnnest)
    const out = value.flatMap((v) => (isTypedUnnest(v) ? untypedUnnest(v).map((x) => currentOf(x, opts)) : [currentOf(v, opts)]));
    return out.length !== value.length || out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (!isObj(value)) return value;
  if (isEarlierCondition(value)) return currentCondition(value, opts);
  if (isEarlierMetric(value)) return currentMetric(value);
  if (isEarlierMeasure(value)) return currentMeasure(value, opts);
  if (isEarlierDimension(value)) return currentDimension(value, opts);
  if (value.fn === 'event_property' || ((value.fn === 'array_length' || value.fn === 'array_contains') && value.args === undefined && value.property !== undefined) || listConstant(value) || isTypedRead(value) || isEarlierAggregate(value)) return currentExpression(value, opts);
  if (value.stage === 'unnest' && ((value.expr === undefined && (value.property !== undefined || value.column !== undefined)) || isTypedUnnest(value))) {
    // on its own, an unnest whose type was text drops it; one of another type is two steps, said in its list
    const u = currentUnnest(value);
    const now = isTypedUnnest(u) ? untypedUnnest(u) : [u];
    return now.length === 1 ? currentOf(now[0], opts) : u;
  }
  if (earlierQueryParts(value)) return currentOf(currentQueryInput(value, opts), opts);
  if (isEarlierInclude(value)) return currentOf(currentInclude(value), opts);
  if (isEarlierRef(value)) return currentRef(value, opts);
  if (isEarlierSourceItem(value)) { const { from, ...rest } = value; return currentOf({ source: from, ...rest }, opts); }
  if (isEarlierUpdate(value)) { const { task, ...rest } = value; return currentOf({ ...rest, name: task }, opts); }
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const c = currentOf(v, opts);
    if (c !== v) changed = true;
    out[k] = c;
  }
  return changed ? out : value;
}
