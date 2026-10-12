// A METRIC QUERY'S WHERE → MetricFlow `--where` clauses. The where is the one expression (src/pipeline/
// compute.js) at its place — PLACES.metric_where: what the query's group_by names, as it names it (the
// refs of src/schema/refs.js: { source, column, via? }, { source, property }, { semantic_model, dimension,
// grain? }, { entity }, { time: 'metric_time', grain }) and constants, with the conditions, the logic and
// the scalar functions of a dimension's value. The query resolves each reference to the MetricFlow item it
// names; this module writes that item as the Jinja wrapper MetricFlow's where takes (Dimension /
// TimeDimension / Entity), every name in it checked to be an identifier path, and everything around it —
// the comparisons, and / or / not, a scalar function of a reference — by the dialect, through the one
// writer. The caller never sends SQL: a constant is a literal the dialect writes.

import { getDialect } from './dialects/index.js';
import { conditionListSql, eachNode, CONDITION_FNS } from './pipeline/compute.js';
import { REF_PLACES, refKind } from './schema/refs.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Whether a leaf is a reference a metric query names — one its group_by takes (REF_PLACES.group_by). */
const isQueryRef = (e) => REF_PLACES.group_by.takes.includes(refKind(e));

/** How a reference is called in a refusal. */
const refLabel = (e) => {
  const kind = refKind(e);
  if (kind === 'time') return 'metric_time';
  if (kind === 'source_column' || kind === 'source_property') return `${e.source}.${e.column ?? e.property}`;
  if (kind === 'dimension') return `${[].concat(e.semantic_model).join(' → ')}.${e.dimension}`;
  return String(e.entity);
};

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
 * A where's `--where` clauses, one per item of the list (all of them hold). `resolve(ref, at, kind)` turns
 * a reference into the field it names (renderField's shapes) or throws with why it names none; a time
 * axis or a time dimension is compared as a moment. What the place does not take — a column of the rows,
 * a metric, an aggregate, a window — the one writer refuses, naming what a metric query's where takes.
 * `dialect` is the warehouse's dialect name.
 */
export function whereSql(dialect, list, resolve, at = 'where') {
  const leaf = (e, where) => {
    const kind = refKind(e);
    if (!kind) return undefined; // a constant: the writer's own
    const field = resolve(e, where, kind);
    return { sql: renderField(field), type: field.kind === 'metric_time' || field.kind === 'time_dimension' ? 'time' : null, name: refLabel(e) };
  };
  return conditionListSql(getDialect(dialect), null, list, at, { place: 'metric_where', leaf });
}

/**
 * Each condition of a where that compares a reference with constants — its first argument the reference,
 * every other a { value } — wherever it stands (inside and / or / not too): { ref, op, values }. What the
 * filter value guard checks against the values the index holds.
 */
export function referenceComparisons(list) {
  const out = [];
  eachNode(list, (n) => {
    if (!CONDITION_FNS.includes(n.fn) || !Array.isArray(n.args) || !n.args.length) return;
    const [ref, ...rest] = n.args;
    if (!isQueryRef(ref) || !rest.every((x) => isObj(x) && x.fn === undefined && Object.hasOwn(x, 'value'))) return;
    out.push({ ref, op: n.fn, values: rest.map((x) => x.value) });
  });
  return out;
}
