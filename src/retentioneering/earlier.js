// WHAT AN EARLIER VERSION STORED, CARRIED OVER ON READ — the retentioneering side's counterpart of
// src/pipeline/earlier.js. A path-analysis context outlives a deploy (contexts are kept until dropped),
// and what it holds is read again: an eventstream's spec by every summary of it, and its steps by every
// re-check after an edit. What an earlier version spelled another way is translated here, once, before
// it is read:
//   - a start from a task's table named its path in `columns.path` (a column, or a list of them): now
//     `path: [{ column }, …]`, beside `columns: { event, time }`;
//   - an events.split case named its conditions `where`: now `when`, as a compute case's;
//   - a step's `path` could be the word 'users' or 'sessions': now the path column itself, user_id /
//     session_id (the earlier step always read the word as that column, so no column of that name was
//     reachable — nothing is lost);
//   - filter_events' `where` was a tree of this tool's own — { op: 'and' | 'or', conditions }, { not: x },
//     leaves with the operators =, ==, !=, >, >=, <, <=, in, not_in, is_null, is_not_null — now the one
//     condition grammar (a list that all hold, { or: [...] } of conditions or { and: [...] }), its
//     operators OPS. Both keep a missing value out of every test, so a negation keeps it: a `not` is
//     pushed to the leaves (De Morgan), each negated as the operator that says it — eq / neq and in /
//     not_in negate each other; a negated order comparison (not >) is its opposite or a missing value
//     (the one row it reads otherwise: a value that is there and is not a number, compared with a
//     number — the earlier tree kept it, as no comparison held; is_null does not).
// What is in the current spelling passes through unchanged.

/** The earlier tree's operators, in the one vocabulary. */
const EARLIER_OP = { '=': 'eq', '==': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', in: 'in', not_in: 'not_in', is_null: 'is_null', is_not_null: 'is_not_null' };
/** Each operator's negation where one operator says it; an order comparison's opposite holds only
 *  where the value is there, so its negation also takes a missing one. */
const NEGATION = { eq: 'neq', neq: 'eq', in: 'not_in', not_in: 'in', is_null: 'is_not_null', is_not_null: 'is_null' };
const OPPOSITE = { gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' };

/** The earlier tree as a formula of and / or over leaves, its negations pushed to the leaves. */
function formula(node, negated) {
  if (node && typeof node === 'object' && node.not !== undefined) return formula(node.not, !negated);
  if (Array.isArray(node?.conditions)) {
    const kids = node.conditions.map((c) => formula(c, negated));
    // and ↔ or under a negation (De Morgan)
    return (node.op === 'or') !== negated ? { or: kids } : { and: kids };
  }
  const op = EARLIER_OP[node.op] || node.op;
  const leaf = (o) => ({ column: node.column, op: o, ...(node.value !== undefined && o !== 'is_null' && o !== 'is_not_null' ? { value: node.value } : {}) });
  if (!negated) return leaf(op);
  if (NEGATION[op]) return leaf(NEGATION[op]);
  if (OPPOSITE[op]) return { or: [leaf(OPPOSITE[op]), { column: node.column, op: 'is_null' }] };
  return leaf(op);
}

/** A formula as the disjunction of conjunctions it equals: [[leaf, …], …]. */
function dnf(f) {
  if (f.or) return f.or.flatMap(dnf);
  if (f.and) return f.and.map(dnf).reduce((acc, d) => acc.flatMap((a) => d.map((b) => [...a, ...b])), [[]]);
  return [[f]];
}

/** A formula as the one condition grammar: a list that all hold, an item a leaf or { or: [leaf |
 *  { and: [leaves] }] } — the conjunctions of an `or` written out where it nests deeper than that. */
function conditionList(f) {
  if (f.and) return f.and.flatMap(conditionList);
  if (!f.or) return [f];
  const terms = dnf(f).map((c) => (c.length === 1 ? c[0] : { and: c }));
  if (terms.length === 1) return terms[0].and || [terms[0]];
  return [{ or: terms }];
}

/** filter_events' earlier `where` tree as the condition list it says (a list is today's). */
export function currentWhere(where) {
  if (Array.isArray(where) || !where || typeof where !== 'object') return where;
  return conditionList(formula(where, false));
}

/** The earlier path words, as the columns they named — ES_COLUMNS.user / ES_COLUMNS.session
 *  (src/retentioneering/eventstream.js, not imported: it imports this file). */
const EARLIER_PATH = { users: 'user_id', sessions: 'session_id' };

/** One stored step in the current spelling. */
export function currentStep(step) {
  let out = step;
  if (typeof out?.path === 'string' && Object.hasOwn(EARLIER_PATH, out.path)) out = { ...out, path: EARLIER_PATH[out.path] };
  if (out?.type === 'filter_events' && out.where !== undefined && !Array.isArray(out.where)) out = { ...out, where: currentWhere(out.where) };
  return out;
}

/** A stored eventstream spec in the current spelling. */
export function currentSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  let out = spec;
  if (spec.columns && spec.columns.path !== undefined) {
    const { path, ...columns } = spec.columns;
    out = { ...out, columns, path: [].concat(path).map((column) => ({ column })) };
  }
  const split = out.events?.split;
  if (Array.isArray(split) && split.some((rule) => (rule.cases || []).some((c) => c.where !== undefined))) {
    out = { ...out, events: { ...out.events, split: split.map((rule) => (rule.cases ? { ...rule, cases: rule.cases.map(({ where, ...c }) => (where !== undefined && c.when === undefined ? { ...c, when: where } : c)) } : rule)) } };
  }
  return out;
}
