// A METRIC QUERY'S WHERE → MetricFlow `--where` clauses. The where is the one expression grammar
// (src/pipeline/compute.js) over DIMENSION REFERENCES — named exactly as the query's group_by names them:
// { time: 'metric_time', grain }, { model, attribute, via? }, { semantic_model, dimension, grain? },
// { entity } — and constants. The query resolves each reference to the MetricFlow item it names; this
// module writes that item as the Jinja wrapper MetricFlow's where takes (Dimension / TimeDimension /
// Entity), every name in it checked to be an identifier path, and everything around it — the
// comparisons, and / or / not, a scalar function of a reference — by the dialect, through the one writer.
// The caller never sends SQL: a constant is a literal the dialect writes.

import { getDialect } from './dialects/index.js';
import { conditionListSql, eachNode, FNS, CONDITION_FNS, LOGIC_FNS, SCALAR_FNS } from './pipeline/compute.js';

/** The scalar functions a where leaves out: raw, whose dialect SQL would reach MetricFlow's where, which
 *  MetricFlow renders as Jinja; and those that read an array, a JSON document or a sketch — never what
 *  a dimension holds. */
const NOT_OVER_DIMENSIONS = new Set(['raw', 'json_parse_array', 'json_field', 'array_length', 'array_contains', 'element_at', 'array_last', 'hll_extract']);

/**
 * The functions a metric query's where takes: the conditions, the logic and the scalar functions of a
 * dimension's value. No aggregate (a where filters the rows before they are folded) and no window.
 */
export const WHERE_FNS = [...CONDITION_FNS, ...LOGIC_FNS, ...SCALAR_FNS.filter((fn) => !NOT_OVER_DIMENSIONS.has(fn))];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Whether a leaf is a dimension reference — named as group_by names one. */
export const isDimensionRef = (e) => isObj(e) && e.fn === undefined && ['time', 'model', 'semantic_model', 'entity'].some((k) => e[k] !== undefined);

/** How a reference is called in a refusal. */
const refLabel = (e) => (e.time !== undefined ? 'metric_time' : e.model !== undefined ? `${e.model}.${e.attribute}` : e.semantic_model !== undefined ? `${[].concat(e.semantic_model).join(' → ')}.${e.dimension}` : String(e.entity));

/** Render a resolved field into its Jinja wrapper: { kind: 'dimension', path } | { kind: 'time_dimension',
 *  path, grain } | { kind: 'metric_time', grain } | { kind: 'entity', name }. */
export function renderField(field) {
  if (!field || typeof field !== 'object') throw new Error('predicate.field required');
  switch (field.kind) {
    case 'dimension':
      assertPath(field.path);
      return `{{ Dimension('${field.path}') }}`;
    case 'metric_time': {
      const grain = field.grain || 'day';
      return `{{ TimeDimension('metric_time', '${grain}') }}`;
    }
    case 'entity':
      assertName(field.name);
      return `{{ Entity('${field.name}') }}`;
    case 'time_dimension':
      assertPath(field.path);
      return `{{ TimeDimension('${field.path}', '${field.grain || 'day'}') }}`;
    default:
      throw new Error(`Unsupported field.kind: ${field.kind}`);
  }
}

function assertPath(p) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(__[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(String(p || ''))) {
    throw new Error(`Unsafe dimension path: ${p}`);
  }
}
function assertName(n) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(n || ''))) {
    throw new Error(`Unsafe entity name: ${n}`);
  }
}

/**
 * A where's `--where` clauses, one per item of the list (all of them hold). `resolve(ref, at)` turns a
 * dimension reference into the field it names (renderField's shapes) or throws with why it names none;
 * a time axis or a time dimension is compared as a moment. Any other leaf than a reference or a constant
 * is refused. `dialect` is the warehouse's dialect name.
 */
export function whereSql(dialect, list, resolve, at = 'where') {
  // what folds rows or reads a window is a metric's, not the where's that filters the rows it folds
  eachNode(list, (n) => {
    if (typeof n.fn === 'string' && Object.hasOwn(FNS, n.fn) && !WHERE_FNS.includes(n.fn)) throw new Error(`${at}: ${n.fn} is not a function a metric query's where takes — it filters the rows a metric folds, with conditions, and / or / not and scalar functions of what group_by names; an aggregate is what a metric's measure is`);
  });
  const leaf = (e, where) => {
    if (isDimensionRef(e)) {
      const field = resolve(e, where);
      return { sql: renderField(field), type: field.kind === 'metric_time' || field.kind === 'time_dimension' ? 'time' : null, name: refLabel(e) };
    }
    if (Object.keys(e).length === 1 && Object.hasOwn(e, 'value')) return undefined;
    throw new Error(`${where}: a metric query's where compares what group_by names — { model, attribute }, { time: "metric_time", grain }, { semantic_model, dimension }, { entity } — and constants ({ value }); ${JSON.stringify(e)} is neither`);
  };
  return conditionListSql(getDialect(dialect), null, list, at, { leaf, windows: false });
}

/**
 * Each condition of a where that compares a dimension reference with constants — its first argument
 * the reference, every other a { value } — wherever it stands (inside and / or / not too): { ref, op,
 * values }. What the filter value guard checks against the values the index holds.
 */
export function referenceComparisons(list) {
  const out = [];
  eachNode(list, (n) => {
    if (!CONDITION_FNS.includes(n.fn) || !Array.isArray(n.args) || !n.args.length) return;
    const [ref, ...rest] = n.args;
    if (!isDimensionRef(ref) || !rest.every((x) => isObj(x) && x.fn === undefined && Object.hasOwn(x, 'value'))) return;
    out.push({ ref, op: n.fn, values: rest.map((x) => x.value) });
  });
  return out;
}
