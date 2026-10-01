// A BUILD'S INPUT, CHECKED — what an eventstream is declared from, held to what it reads: a catalog
// source (its events, columns, scalar event properties, the relationship a segment is carried by) or a
// task's stored table (its columns alone). Every mistake is refused here, naming the field and the
// nearest name.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { userKeyColumn, sourceColumns, NAME } from './schema.js';
import { ES_COLUMNS } from './eventstream.js';
import { eachCondition } from '../conditions.js';

export function suggest(value, known) {
  const near = rankFuzzy(value, known, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => m.item);
  return near.length ? ` — did you mean ${near.map((n) => `'${n}'`).join(', ')}?` : '';
}

export function checkEvents(catalog, source, names, field) {
  const known = catalog.eventNames(source);
  if (!known.length) return; // a source that declares no vocabulary: the warehouse decides
  for (const n of names || []) {
    if (!known.includes(n)) throw new ToolError(`'${n}' is not an event of '${source}'${suggest(n, known)}`, { stage: 'validate', field });
  }
}

/** The relationship `source` reaches `model` by — the one declared, or the one the caller named. */
export function relationshipTo(catalog, source, model, via) {
  const shared = Object.keys(catalog.entitiesOf(source)).filter((name) => catalog.joinTargetFor(name) === model);
  if (via) {
    if (!shared.includes(via)) throw new ToolError(`'${source}' reaches '${model}' by ${shared.length ? shared.map((n) => `'${n}'`).join(', ') : 'no declared relationship'}, not '${via}'`, { stage: 'validate', field: 'segments.via' });
    return via;
  }
  if (!shared.length) throw new ToolError(`'${source}' declares no relationship toward '${model}', so its attributes cannot be carried onto the events`, { stage: 'validate', field: 'segments.model' });
  if (shared.length > 1) throw new ToolError(`'${source}' reaches '${model}' by several relationships (${shared.join(', ')}) — name the one you mean with via`, { stage: 'validate', field: 'segments.via' });
  return shared[0];
}

export function validateBuild(engine, input, physical = null) {
  const c = engine.catalog;
  const { source } = input;
  if (!userKeyColumn(c, source)) throw new ToolError(`'${source}' names no single user key toward the users model, so its events have no path owner`, { stage: 'validate', field: 'source' });
  checkEvents(c, source, input.events?.include, 'events.include');
  checkEvents(c, source, input.events?.exclude, 'events.exclude');
  // a group merges events of the source, or events events.split makes: the names it gives, and for
  // a split by value, <event>_<value> (the value is known only from the data)
  const rules = input.events?.split || [];
  const splitNames = new Set(rules.flatMap((rule) => [...Object.values(rule.names || {}), ...(rule.cases || []).map((cs) => cs.name), ...(rule.else ? [rule.else] : [])]));
  const byValue = rules.filter((rule) => rule.by).map((rule) => `${rule.event}_`);
  const madeBySplit = (e) => splitNames.has(e) || byValue.some((p) => e.startsWith(p));
  for (const [g, evs] of Object.entries(input.events?.groups || {})) {
    if (!new RegExp(NAME).test(g)) throw new ToolError(`group name '${g}' must be lowercase snake_case`, { stage: 'validate', field: 'events.groups' });
    checkEvents(c, source, evs.filter((e) => !madeBySplit(e)), `events.groups.${g}`);
  }
  checkEvents(c, source, Object.keys(input.sample?.events || {}).filter((e) => !madeBySplit(e)), 'sample.events');
  const own = sourceColumns(c, source, physical);
  const props = c.scalarEventProps(source);
  // a parameter or condition names a column of the source or one of its scalar event properties
  const checkRef = (ref, field) => {
    if (ref.property !== undefined && !props.includes(ref.property)) throw new ToolError(`'${ref.property}' is not a scalar event property of '${source}'${suggest(ref.property, props)}`, { stage: 'validate', field });
    if (ref.column !== undefined && !own.includes(ref.column)) throw new ToolError(`'${ref.column}' is not a column of '${source}'${suggest(ref.column, own)}`, { stage: 'validate', field });
  };
  (input.events?.split || []).forEach((rule, i) => {
    checkEvents(c, source, [rule.event], `events.split.${i}.event`);
    if (rule.by) checkRef(rule.by, `events.split.${i}.by`);
    for (const cs of rule.cases || []) eachCondition(cs.where, (w) => { checkRef(w, `events.split.${i}.cases.where`); checkBetween(w, `events.split.${i}.cases.where`); });
  });
  // what one path is, when not the user: columns and properties of the source
  (input.path || []).forEach((ref) => checkRef(ref, 'path'));
  const segNames = [];
  const segments = (input.segments || []).map((seg) => {
    let name;
    let out;
    if (seg.column !== undefined) {
      // a column of the source itself: no join
      if (!own.includes(seg.column)) throw new ToolError(`'${seg.column}' is not a column of '${source}'${suggest(seg.column, own)} (its columns: ${own.join(', ') || 'none declared'})`, { stage: 'validate', field: 'segments.column' });
      name = seg.name || seg.column;
      out = { column: seg.column, name };
    } else if (seg.property !== undefined) {
      if (!props.includes(seg.property)) throw new ToolError(`'${seg.property}' is not a scalar event property of '${source}'${suggest(seg.property, props)}`, { stage: 'validate', field: 'segments.property' });
      name = seg.name || seg.property;
      out = { property: seg.property, name };
    } else {
      const dims = c.modelDimensionColumns(seg.model);
      if (!dims.includes(seg.attribute)) throw new ToolError(`'${seg.attribute}' is not an attribute of '${seg.model}'${suggest(seg.attribute, dims)}`, { stage: 'validate', field: 'segments.attribute' });
      name = seg.name || seg.attribute;
      out = { ...seg, name, via: relationshipTo(c, source, seg.model, seg.via) };
    }
    claimSegmentName(name, segNames);
    return out;
  });
  eachCondition(input.where, (w) => {
    const field = w.property !== undefined ? 'where.property' : 'where.column';
    if (w.property !== undefined) {
      if (!props.includes(w.property)) throw new ToolError(`'${w.property}' is not a scalar event property of '${source}'${suggest(w.property, props)}`, { stage: 'validate', field });
    } else if (!segNames.includes(w.column) && !own.includes(w.column)) {
      const known = [...own, ...segNames];
      throw new ToolError(`where filters on a column of '${source}' or a declared segment — '${w.column}' is neither${suggest(w.column, known)} (columns: ${own.join(', ') || 'none'}; segments: ${segNames.join(', ') || 'none'})`, { stage: 'validate', field });
    }
    checkWhereValue(w);
  });
  return { ...input, segments };
}

/** A between condition takes [low, high]. */
export function checkBetween(w, field) {
  if (w.op === 'between' && !(Array.isArray(w.value) && w.value.length === 2)) throw new ToolError('between takes [low, high] (both included)', { stage: 'validate', field });
}

/** A row filter's value, as its operator takes it: one, a list (in / not_in), [low, high] (between), or none (is_null / is_not_null). */
export function checkWhereValue(w) {
  if (!['is_null', 'is_not_null'].includes(w.op) && w.value === undefined) throw new ToolError(`where ${w.op} on '${w.column ?? w.property}' needs a value`, { stage: 'validate', field: 'where.value' });
  if (['in', 'not_in'].includes(w.op) && !Array.isArray(w.value)) throw new ToolError(`where ${w.op} takes an array value`, { stage: 'validate', field: 'where.value' });
  if (w.op === 'between' && !(Array.isArray(w.value) && w.value.length === 2)) throw new ToolError('where between takes [low, high] (both included)', { stage: 'validate', field: 'where.value' });
}

/** A segment's name, once: not one of the eventstream's own columns, nor another segment's. */
export function claimSegmentName(name, taken) {
  if (Object.values(ES_COLUMNS).includes(name) || taken.includes(name)) throw new ToolError(`segment name '${name}' is taken — give it another with name`, { stage: 'validate', field: 'segments.name' });
  taken.push(name);
}

/**
 * A build FROM A TASK's stored table (a pipeline build — the place for event logic the build's own
 * rules cannot say: windows, a match_recognize, several sources joined, a cohort). The table has no
 * catalog meaning, so the caller names its path columns, and what the build reads is its columns:
 * a filter, a segment and a split parameter each name one. Payload properties and joined attributes
 * belong in the pipeline that made the table.
 */
export function validateTaskBuild(input, base) {
  const have = base.columns.map((c) => c.name);
  const typeOf = new Map(base.columns.map((c) => [c.name, c.type]));
  const known = (col, field) => {
    if (!have.includes(col)) throw new ToolError(`'${col}' is not a column of task ${base.task_id}'s table${suggest(col, have)} (its columns: ${have.join(', ')})`, { stage: 'validate', field });
  };
  if (input.path) throw new ToolError('with from_task the path is named in columns.path (the table\'s own columns), not in path', { stage: 'validate', field: 'path' });
  const { event, time } = input.columns;
  const path = [].concat(input.columns.path);
  path.forEach((col) => known(col, 'columns.path'));
  known(event, 'columns.event'); known(time, 'columns.time');
  if (new Set([...path, event, time]).size < path.length + 2) throw new ToolError('columns.path, columns.event and columns.time name different columns', { stage: 'validate', field: 'columns' });
  const t = String(typeOf.get(time) || 'unknown');
  if (!['time', 'timestamp', 'date', 'datetime', 'unknown'].includes(t)) throw new ToolError(`columns.time '${time}' is a ${t} column — the paths are ordered by a time (a timestamp or a date)`, { stage: 'validate', field: 'columns.time' });
  const noCatalog = (what, field) => { throw new ToolError(`${what} — a task's table carries no catalog meaning: bring it in as a column in the pipeline that made the table (a derive of the property, a join of the attribute), then name that column here`, { stage: 'validate', field }); };
  (input.events?.split || []).forEach((rule, i) => {
    if (rule.by?.property !== undefined) noCatalog(`events.split.${i}.by names the event property '${rule.by.property}'`, `events.split.${i}.by`);
    if (rule.by) known(rule.by.column, `events.split.${i}.by`);
    for (const cs of rule.cases || []) eachCondition(cs.where, (w) => {
      if (w.property !== undefined) noCatalog(`a case of events.split.${i} names the event property '${w.property}'`, `events.split.${i}.cases.where`);
      known(w.column, `events.split.${i}.cases.where`);
      checkBetween(w, `events.split.${i}.cases.where`);
    });
  });
  const segNames = [];
  const segments = (input.segments || []).map((seg) => {
    if (seg.property !== undefined) noCatalog(`the segment names the event property '${seg.property}'`, 'segments.property');
    if (seg.column === undefined) noCatalog(`the segment names ${seg.model}.${seg.attribute}`, 'segments.model');
    known(seg.column, 'segments.column');
    const name = seg.name || seg.column;
    claimSegmentName(name, segNames);
    return { column: seg.column, name };
  });
  eachCondition(input.where, (w) => {
    if (w.property !== undefined) noCatalog(`where names the event property '${w.property}'`, 'where.property');
    if (!segNames.includes(w.column)) known(w.column, 'where.column');
    checkWhereValue(w);
  });
  return { ...input, segments };
}
