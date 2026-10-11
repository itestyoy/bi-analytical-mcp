// WHAT AN EARLIER VERSION STORED, CARRIED OVER ON READ — the retentioneering side's counterpart of
// src/pipeline/earlier.js. A path-analysis context outlives a deploy (contexts are kept until dropped),
// and what it holds is read again: an eventstream's start by every summary of it, and its steps by every
// re-check after an edit. What an earlier version spelled another way is translated here, once, before
// it is read — its conditions and expressions through the one converter table (src/earlier-spelling.js):
//   - a start declared its rows with fields of its own; they are the pipeline's stages now, and the
//     columns the start names:
//       where → a where stage (a condition on a segment after the stage that makes the segment);
//       events.include / exclude → a where stage: in / not_in on the event column;
//       events.split / groups → compute stages making the event column, which columns.event names;
//       events.top → top;
//       a segment { model, attribute, via?, name? } → a join stage bringing the attribute under its name;
//       { column, name } → a compute copying the column when it is renamed; { property, name? } → a
//       compute reading it (or the column itself, where the property is stored under its own name);
//       path items → column names (a property read by a compute); a start from a task's table named its
//       path in `columns.path` — now `path`;
//     and an events.split case named its conditions `where` before it named them `when`;
//   - a step's `path` could be the word 'users' or 'sessions': now the path column itself, user_id /
//     session_id (the earlier step always read the word as that column, so no column of that name was
//     reachable — nothing is lost);
//   - filter_events' `where` was a list of conditions ({ column, op, value }, { or }, { and }) — and before
//     that a tree of its own: { op: 'and' | 'or', conditions }, { not: x }, leaves with the operators =,
//     ==, !=, >, >=, <, <=, in, not_in, is_null, is_not_null — and now is the expression grammar. Both
//     earlier forms kept a missing value out of every test and IN a negation of one — neq, not_in and
//     not_like (and the tree's != and not_in) were NOT of what they negate. A comparison with a missing
//     value does not hold now, neq's too, and not(…) keeps one: so each negation is carried over as
//     not(eq / in / like), and a step keeps the rows it kept.
// What is in the current spelling passes through unchanged.

import { ES_COLUMNS } from './names.js';
import { ToolError } from '../validate.js';
import { NAME_RE } from '../pipeline/sql.js';
import { currentCondition, currentConditions, isEarlierCondition } from '../earlier-spelling.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** An earlier group of conditions: { or: [...] } or { and: [...] }. */
const isGroup = (c) => isObj(c) && c.fn === undefined && Object.keys(c).length === 1 && (Array.isArray(c.or) || Array.isArray(c.and));

// ── filter_events' where ──────────────────────────────────────────────────────────────────────────

/** The earlier tree's operators, in the one vocabulary. */
const EARLIER_OP = { '=': 'eq', '==': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', in: 'in', not_in: 'not_in', is_null: 'is_null', is_not_null: 'is_not_null' };
/** The negations an earlier filter tested as NOT of what they negate — a missing value, which matched
 *  nothing, was kept by them. */
const NEGATED = { neq: 'eq', not_in: 'in', not_like: 'like' };

/** One condition of an earlier filter — an item of its list, or a leaf or group inside one. */
function filterCondition(c) {
  if (isGroup(c)) {
    const items = (c.or || c.and).map(filterCondition);
    return items.length === 1 ? items[0] : { fn: c.or ? 'or' : 'and', args: items };
  }
  if (isEarlierCondition(c) && NEGATED[c.op]) return { fn: 'not', args: [currentCondition({ ...c, op: NEGATED[c.op] })] };
  return currentCondition(c);
}

/** A node of the earlier tree: its and / or / not as they are, its leaves as a list's conditions. */
function treeNode(node) {
  if (isObj(node) && node.not !== undefined) return { fn: 'not', args: [treeNode(node.not)] };
  if (Array.isArray(node?.conditions)) {
    const items = node.conditions.map(treeNode);
    return items.length === 1 ? items[0] : { fn: node.op === 'or' ? 'or' : 'and', args: items };
  }
  return filterCondition({ ...node, op: EARLIER_OP[node?.op] || node?.op });
}

/** filter_events' earlier `where` — a list of the earlier conditions, or the tree — as the condition
 *  list it says in the expression grammar (the same value when it is in that grammar already). */
export function currentWhere(where) {
  if (!Array.isArray(where)) {
    if (!isObj(where)) return where;
    const top = treeNode(where);
    return top.fn === 'and' ? top.args : [top];
  }
  const out = where.map((c) => (isGroup(c) || isEarlierCondition(c) ? filterCondition(c) : c));
  return out.some((c, i) => c !== where[i]) ? out : where;
}

// ── a step ────────────────────────────────────────────────────────────────────────────────────────

/** The earlier path words, as the columns they named. */
const EARLIER_PATH = { users: ES_COLUMNS.user, sessions: ES_COLUMNS.session };

/** One stored step in the current spelling. */
export function currentStep(step) {
  let out = step;
  if (typeof out?.path === 'string' && Object.hasOwn(EARLIER_PATH, out.path)) out = { ...out, path: EARLIER_PATH[out.path] };
  if (out?.type === 'filter_events' && out.where !== undefined) {
    const where = currentWhere(out.where);
    if (where !== out.where) out = { ...out, where };
  }
  return out;
}

// ── a start ───────────────────────────────────────────────────────────────────────────────────────

/** An earlier start's condition named an event property `property` — never a column of that name. */
const AS_PROPERTY = { subject: () => 'property' };

/** Whether a stored start is in an earlier spelling: a field no start takes since, or a path part or a
 *  segment named by an object. */
const isEarlierSpec = (s) => s.where !== undefined || s.events !== undefined || s.columns?.path !== undefined
  || (Array.isArray(s.path) && s.path.some(isObj)) || (Array.isArray(s.segments) && s.segments.some(isObj));

/** The column an earlier segment was carried as. */
const segmentName = (seg) => (isObj(seg) ? seg.name ?? seg.column ?? seg.property ?? seg.attribute : seg);

/** `name` where a compute stage may make a column of it, else `fallback`. */
const asName = (name, fallback) => (typeof name === 'string' && NAME_RE.test(name) ? name : fallback);

/** The join an earlier segment of a related model's attribute was carried by: the relationship it named
 *  (or the one the source declares toward the model), at the event's time for a slowly-changing model. */
function joinStage(catalog, source, seg, name, timeColumn) {
  const toward = catalog && source ? Object.keys(catalog.entitiesOf(source)).filter((r) => catalog.joinTargetFor(r) === seg.model) : [];
  const via = seg.via ?? (toward.length === 1 ? toward[0] : undefined);
  const m = catalog?.models?.[seg.model] ? catalog.getModel(seg.model) : null;
  const bound = (v) => Object.entries(m?.dimensions || {}).find(([, d]) => d.validity === v)?.[0];
  const between = m?.scd && bound('start') && bound('end') && timeColumn ? { column: timeColumn, from: bound('start'), to: bound('end') } : null;
  return { stage: 'join', with: seg.model, ...(via !== undefined ? { via } : {}), attrs: [{ column: seg.attribute, ...(name !== seg.attribute ? { name } : {}) }], ...(between ? { between } : {}) };
}

/**
 * A stored start in the current spelling — its rows' stages and the columns it names — in the order
 * the earlier start applied them: the events kept, the conditions on the source, the events made and
 * merged, the path, the segments, the conditions on a segment. `catalog` says what the earlier start
 * read of the source implicitly: its event and time columns, the relationship a segment was carried by,
 * a slowly-changing model's validity window, and which properties are stored under their own name.
 */
export function currentSpec(spec, catalog = null) {
  if (!isObj(spec) || !isEarlierSpec(spec)) return spec;
  const { where = [], events = {}, segments = [], path, columns = {}, ...rest } = spec;
  const { path: tablePath, ...named } = columns;
  const source = spec.from_task === undefined ? spec.source : null;
  const own = source && catalog?.models?.[source] ? { event: catalog.eventNameColumn(source), time: catalog.getModel(source).time?.column, columns: new Set(catalog.modelColumns(source).map((c) => c.name)) } : { columns: new Set() };
  const eventColumn = named.event ?? own.event;
  const timeColumn = named.time ?? own.time;
  const stages = [];
  const made = new Set();
  /** A column a compute stage makes — once. */
  const compute = (name, expr) => {
    if (!made.has(name)) { made.add(name); stages.push({ stage: 'compute', name, expr }); }
    return name;
  };
  /** An event property as a column: the source's own where it is stored under its name, else read. */
  const propertyColumn = (property, name, type) => (name === property && own.columns.has(property) ? property : compute(name, { property, ...(type ? { type } : {}) }));

  // the events kept and dropped
  const oneOf = (fn, list) => ({ fn, args: [{ column: eventColumn }, ...list.map((value) => ({ value }))] });
  if (events.include?.length) stages.push({ stage: 'where', conditions: [oneOf('in', events.include)] });
  if (events.exclude?.length) stages.push({ stage: 'where', conditions: [oneOf('not_in', events.exclude)] });
  // a condition on the source before the rest; one on a segment (a group holding one) once it is there
  const segmentNames = new Set(segments.map(segmentName));
  const onSegment = (c) => (isGroup(c) ? (c.or || c.and).some(onSegment) : isObj(c) && c.property === undefined && segmentNames.has(c.column));
  const early = where.filter((c) => !onSegment(c));
  const late = where.filter(onSegment);
  if (early.length) stages.push({ stage: 'where', conditions: currentConditions(early, AS_PROPERTY) });

  // events made from an event's parameters (split), then several merged under one name (groups): a
  // CASE column each, the event column from then on
  let event = eventColumn;
  const rules = events.split || [];
  const groups = Object.entries(events.groups || {});
  if (rules.length) {
    const isEvent = (e) => ({ fn: 'eq', args: [{ column: eventColumn }, { value: e }] });
    const cases = [];
    for (const rule of rules) {
      if (rule.cases) {
        for (const cs of rule.cases) cases.push({ when: [isEvent(rule.event), ...currentConditions(cs.when ?? cs.where ?? [], AS_PROPERTY)], then: { value: cs.name } });
        if (rule.else !== undefined) cases.push({ when: [isEvent(rule.event)], then: { value: rule.else } });
        continue;
      }
      const by = { fn: 'cast', args: [rule.by?.column !== undefined ? { column: rule.by.column } : { property: rule.by?.property, type: 'string' }], type: 'string' };
      for (const [value, name] of Object.entries(rule.names || {})) cases.push({ when: [isEvent(rule.event), { fn: 'eq', args: [by, { value }] }], then: { value: name } });
      // any other value names <event>_<value>; an event without the parameter keeps its name
      cases.push({ when: [isEvent(rule.event), { fn: 'is_not_null', args: [by] }], then: { fn: 'concat', args: [{ value: `${rule.event}_` }, by] } });
    }
    event = compute(groups.length ? 'es_split' : 'es_event', { fn: 'case', cases, else: { column: eventColumn }, type: 'string' });
  }
  if (groups.length) {
    const cases = groups.map(([g, evs]) => ({ when: [{ fn: 'in', args: [{ column: event }, ...evs.map((value) => ({ value }))] }], then: { value: g } }));
    event = compute('es_event', { fn: 'case', cases, else: { fn: 'cast', args: [{ column: event }], type: 'string' }, type: 'string' });
  }

  // what one path is: column names, a property read into a column of its own name
  const parts = tablePath !== undefined ? [].concat(tablePath) : path;
  const pathColumns = Array.isArray(parts)
    ? parts.map((ref, i) => (!isObj(ref) ? ref : ref.column !== undefined ? ref.column : propertyColumn(ref.property, asName(ref.property, `es_k${i}`), 'string')))
    : undefined;

  // the segments: a column under its name (copied when renamed), a property read, an attribute joined
  const segmentColumns = segments.map((seg, i) => {
    if (!isObj(seg)) return seg;
    const name = asName(segmentName(seg), `es_s${i}`);
    if (seg.column !== undefined) return name === seg.column ? name : compute(name, { column: seg.column });
    if (seg.property !== undefined) return propertyColumn(seg.property, name);
    stages.push(joinStage(catalog, source, seg, name, timeColumn));
    return name;
  });
  if (late.length) stages.push({ stage: 'where', conditions: currentConditions(late, AS_PROPERTY) });

  const outColumns = { ...named, ...(event !== eventColumn ? { event } : {}) };
  return {
    ...rest,
    ...(stages.length ? { stages } : {}),
    ...(Object.keys(outColumns).length ? { columns: outColumns } : {}),
    ...(pathColumns ? { path: pathColumns } : {}),
    ...(segmentColumns.length ? { segments: segmentColumns } : {}),
    ...(events.top !== undefined ? { top: events.top } : {}),
  };
}

/**
 * A NEW call written in an earlier spelling is refused — never taken as an alias — with what it says now:
 * a start's fields as its stages and named columns, and filter_events' where as the expression grammar,
 * its negations as not(…). (The general hint of src/validate.js would write an earlier neq as neq, which
 * now leaves a missing value out: the hint here keeps what the caller's condition kept.)
 */
export function refuseEarlierSpelling(input, catalog) {
  if (!isObj(input)) return;
  const refuse = (what, now, field = what) => { throw new ToolError(`invalid input: ${what} is written in an earlier spelling — write ${JSON.stringify(now)}`, { stage: 'validate', field }); };
  if ((input.action ?? 'start') === 'start') {
    const now = currentSpec(input, catalog);
    // (the field named is the first the start no longer takes in that shape)
    if (now !== input) refuse('the start', now, ['where', 'events', 'segments', 'path', 'columns'].find((k) => input[k] !== undefined && JSON.stringify(input[k]) !== JSON.stringify(now[k])));
  }
  const steps = Array.isArray(input.steps) ? input.steps.map((s, i) => [`steps[${i}]`, s]) : isObj(input.step) ? [['step', input.step]] : [];
  for (const [field, s] of steps) {
    if (s?.type !== 'filter_events' || s.where === undefined) continue;
    const where = currentWhere(s.where);
    if (where !== s.where) refuse(`${field}.where`, where);
  }
}

/**
 * Every eventstream a context holds, its start in the current spelling — done where a call reaches the
 * context (contexts.js pathContext), so every reader after it reads one spelling. In place: a start
 * converts to the same value each time, and is kept so from then on.
 */
export function currentEventstreams(state, catalog) {
  for (const es of Object.values(state?.eventstreams || {})) {
    if (isObj(es) && isObj(es.spec)) es.spec = currentSpec(es.spec, catalog);
  }
  return state;
}
