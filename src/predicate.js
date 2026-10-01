// Structured predicates -> MetricFlow `--where` Jinja expressions.
// The AI never sends raw SQL; the server renders the typed predicate tree into
// safe Dimension()/TimeDimension()/Entity() wrappers.

import { comparison } from './conditions.js';

/**
 * A query's `where`, as the caller writes it — the one condition grammar (src/schema-kit.js
 * conditionList: a list that all hold, { or } / { and } groups), each condition's `field` named the
 * way group_by names it ({ model, attribute }, { time: 'metric_time', grain }, { semantic_model,
 * dimension }, { entity }) — as the predicate tree the query resolves and renders: { op, conditions }
 * groups, each field with its `kind`.
 */
export function wherePredicates(list) {
  const kindOf = (f) => (f?.time ? { kind: 'metric_time', ...(f.grain ? { grain: f.grain } : {}) } : f?.entity ? { kind: 'entity', entity: f.entity } : { kind: 'dimension', ...f });
  const one = (c) => (c.or ? { op: 'or', conditions: c.or.map(one) } : c.and ? { op: 'and', conditions: c.and.map(one) } : { ...c, field: kindOf(c.field) });
  return { op: 'and', conditions: (list || []).map(one) };
}

/** Render a fieldRef into its Jinja wrapper (left-hand side of a predicate). */
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

/** Render one predicate {field, op, value} into a SQL boolean fragment. */
export function renderPredicate(pred) {
  return comparison(renderField(pred.field), pred.op, pred.value);
}

/** Render a predicateGroup (recursive and/or) into a single boolean expression. */
export function renderGroup(group) {
  if (!group) return null;
  if (!group.op || !Array.isArray(group.conditions) || group.conditions.length === 0) {
    throw new Error('predicateGroup requires op and non-empty conditions');
  }
  const joiner = group.op === 'or' ? ' or ' : ' and ';
  const parts = group.conditions.map((c) => {
    if (c.conditions) return `(${renderGroup(c)})`;
    return renderPredicate(c);
  });
  return parts.join(joiner);
}

/**
 * Top-level: returns an array of `--where` clause strings. A top-level AND is
 * split into one clause per condition (clean, equivalent); anything else is a
 * single combined clause.
 */
export function renderWhereClauses(group) {
  if (!group) return [];
  if (group.op === 'and') {
    return group.conditions.map((c) => (c.conditions ? `(${renderGroup(c)})` : renderPredicate(c)));
  }
  return [renderGroup(group)];
}
