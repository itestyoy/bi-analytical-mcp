// THE EVENTSTREAM — the one table a path analysis reads, prepared in SQL where the data lives
// (CLAUDE.md: what SQL can compute is computed in SQL; the python step receives a prepared table).
//
// The scoping and the attributes go through the pipeline's own stages (src/pipeline.js — a `where`
// on the time window and the events, a `join` by the relationship the catalog declares, a `where`
// on the joined segment columns), so the dialect, the relationship keys and the point-in-time window
// of a slowly-changing model are handled exactly as a pipeline handles them. On top of that one
// statement shapes the path table:
//
//   user_id     the path owner (the source's per-user key, as text)
//   event       the event name — grouped, and (when the caller asks for a top N) the rest merged into "other"
//   event_time  the event's time
//   session_id  when sessions are asked for: user_id#n, a new n after each gap longer than asked
//   <segments>  the declared segments, as text: a related model's attribute, a column of the source
//               itself, or a scalar event property
//
// Deterministic: a sample keeps users by a hash of their key (or rows of the named events by a hash
// of the row), and every ordering carries a tiebreak.

import { renderPipeline } from '../pipeline.js';
import { getDialect } from '../dialects/index.js';
import { userKeyColumn } from './schema.js';
import { mapConditions, eachCondition } from '../conditions.js';

/** The fixed columns of every eventstream (segment columns come after them). */
export const ES_COLUMNS = { user: 'user_id', event: 'event', time: 'event_time', session: 'session_id' };
export const OTHER_EVENT = 'other';
const SAMPLE_BUCKETS = 10000;

const lit = (d, v) => d.sqlLiteral(v);

/**
 * Whose event, which event, when: read from the catalog for an events source, and named by the caller
 * for a task's table (`from_task` — a pipeline build carries no catalog meaning of its own).
 */
export function pathColumns(catalog, spec) {
  if (spec.columns) return { user: null, event: spec.columns.event, time: spec.columns.time };
  return { user: userKeyColumn(catalog, spec.source), event: catalog.eventNameColumn(spec.source), time: catalog.getModel(spec.source).time.column };
}

/** What one path is: the parts of its key — the source's user (the default), or the columns and
 *  properties the caller names (one path per value; several parts make a composite key). */
export function pathParts(spec) {
  if (spec.columns) return [].concat(spec.columns.path).map((column) => ({ column }));
  return spec.path || null;
}

/**
 * The stages that scope the source and bring the segment attributes, and what they expose.
 * `timeConditions` is the engine's own time-window where (the same window a pipeline applies).
 */
export function eventstreamStages(catalog, spec, { timeConditions = null } = {}) {
  const cols = pathColumns(catalog, spec);
  const eventCol = cols.event;
  const stages = [];
  if (timeConditions) stages.push({ stage: 'where', conditions: timeConditions });
  const ev = spec.events || {};
  if (ev.include?.length) stages.push({ stage: 'where', conditions: [{ column: eventCol, op: 'in', value: ev.include }] });
  if (ev.exclude?.length) stages.push({ stage: 'where', conditions: [{ column: eventCol, op: 'not_in', value: ev.exclude }] });
  // the source's own columns and event properties are read before any join: a filter on them scopes
  // the rows the joins then carry, and a property is surfaced by the pipeline's own `derive` stage
  const segNames = new Set((spec.segments || []).map((seg) => seg.name));
  // a condition on the source (a column, a property surfaced by a derive) is applied before the joins;
  // one on a segment — and a group holding one — once the segments are there
  const early = [];
  const late = [];
  let derived = 0;
  const onSegment = (list) => { let seg = false; eachCondition(list, (c) => { if (c.property === undefined && segNames.has(c.column)) seg = true; }); return seg; };
  const resolved = (list) => mapConditions(list, (c) => {
    const cond = (column) => ({ column, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) });
    if (c.property === undefined) return cond(c.column);
    const col = `es_w${derived++}`;
    stages.push({ stage: 'derive', name: col, op: 'extract', source: c.property });
    return cond(col);
  });
  for (const item of spec.where || []) (onSegment([item]) ? late : early).push(...resolved([item]));
  if (early.length) stages.push({ stage: 'where', conditions: early });
  // events made from an event's parameters (events.split): each rule renames the rows of one event —
  // by the value of a property/column, or by the first case whose conditions hold — in one CASE
  // column the eventstream then reads as its event name. Everything is the pipeline's own stages.
  const splits = spec.events?.split || [];
  let splitCol = null;
  if (splits.length) {
    const read = new Map();
    const colOf = (ref) => {
      if (ref.column !== undefined) return ref.column;
      if (!read.has(ref.property)) {
        const col = `es_p${read.size}`;
        stages.push({ stage: 'derive', name: col, op: 'extract', source: ref.property, type: 'string' });
        read.set(ref.property, col);
      }
      return read.get(ref.property);
    };
    const isEvent = (e) => ({ column: eventCol, op: 'eq', value: e });
    const cond = (c) => ({ column: colOf(c), op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) });
    const cases = [];
    splits.forEach((rule, i) => {
      if (rule.cases) {
        for (const cs of rule.cases) cases.push({ when: [isEvent(rule.event), ...mapConditions(cs.where, cond)], then: { value: cs.name } });
        if (rule.else) cases.push({ when: [isEvent(rule.event)], then: { value: rule.else } });
        return;
      }
      const by = colOf(rule.by);
      const text = `es_v${i}`;
      stages.push({ stage: 'compute', name: text, expr: { fn: 'cast', args: [{ column: by }], type: 'string' } });
      for (const [value, name] of Object.entries(rule.names || {})) cases.push({ when: [isEvent(rule.event), { column: text, op: 'eq', value }], then: { value: name } });
      // any other value: <event>_<value>; an event without the parameter keeps its name
      const named = `es_n${i}`;
      stages.push({ stage: 'compute', name: named, expr: { fn: 'concat', args: [{ value: `${rule.event}_` }, { column: text }] } });
      cases.push({ when: [isEvent(rule.event), { column: text, op: 'is_not_null' }], then: { column: named } });
    });
    splitCol = 'es_event';
    stages.push({ stage: 'compute', name: splitCol, expr: { fn: 'case', cases, else: { column: eventCol }, type: 'string' } });
  }
  // a path by something other than the user: its key parts, each present, as one text column —
  // parts joined by '|' (a composite key), so one path is one value of all of them together
  let pathCol = null;
  const parts = pathParts(spec);
  if (parts) {
    const partCols = parts.map((ref, i) => {
      if (ref.column !== undefined) return ref.column;
      const col = `es_k${i}`;
      stages.push({ stage: 'derive', name: col, op: 'extract', source: ref.property, type: 'string' });
      return col;
    });
    stages.push({ stage: 'where', conditions: partCols.map((column) => ({ column, op: 'is_not_null' })) });
    const texts = partCols.map((column, i) => {
      const text = `es_kt${i}`;
      stages.push({ stage: 'compute', name: text, expr: { fn: 'cast', args: [{ column }], type: 'string' } });
      return text;
    });
    if (texts.length === 1) pathCol = texts[0];
    else {
      pathCol = 'es_path';
      stages.push({ stage: 'compute', name: pathCol, expr: { fn: 'concat', args: texts.flatMap((column, i) => (i ? [{ value: '|' }, { column }] : [{ column }])) } });
    }
  }
  const segments = [];
  for (const seg of spec.segments || []) {
    const name = seg.name || seg.attribute;
    if (seg.column !== undefined) { segments.push({ name, expr: seg.column }); continue; }
    if (seg.property !== undefined) {
      const col = `es_s_${name}`;
      stages.push({ stage: 'derive', name: col, op: 'extract', source: seg.property });
      segments.push({ name, expr: col });
      continue;
    }
    // joined under a name of the eventstream's own (the segment's may be a keyword: group, order), named
    // as the segment in the final select
    const col = `es_j${segments.length}`;
    const join = { stage: 'join', with: seg.model, via: seg.via, attrs: [{ column: seg.attribute, name: col }] };
    // a slowly-changing model is joined point in time — at the event's own time (as a pipeline must state it)
    const m = catalog.getModel(seg.model);
    if (m?.scd) {
      const from = Object.entries(m.dimensions || {}).find(([, dd]) => dd.validity === 'start')?.[0];
      const to = Object.entries(m.dimensions || {}).find(([, dd]) => dd.validity === 'end')?.[0];
      if (from && to) join.between = { value: cols.time, from, to };
    }
    stages.push(join);
    segments.push({ name, expr: col });
  }
  // a condition on a segment is applied once the segments are there
  if (late.length) {
    const exprOf = new Map(segments.map((sg) => [sg.name, sg.expr]));
    stages.push({ stage: 'where', conditions: mapConditions(late, (c) => ({ ...c, column: exprOf.get(c.column) ?? c.column })) });
  }
  return { stages, segments, eventColumn: splitCol, pathColumn: pathCol };
}

/** The whole eventstream model's SQL, in the catalog's dialect. */
export function renderEventstream(catalog, spec, { modelName, physicalCols = null, timeConditions = null, from = null } = {}) {
  const d = getDialect(catalog.dialect);
  const { stages, segments, eventColumn, pathColumn } = eventstreamStages(catalog, spec, { timeConditions });
  // `from`: a task's stored table (a pipeline build) is the relation the stages run over — the same
  // start a pipeline makes from a task; the source is then only what the stages resolve names against
  const base = renderPipeline(catalog, catalog.dialect, spec.source, stages, { physicalCols, modelName, from });
  const q = (c) => c; // column names are plain identifiers, as the pipeline renders them
  const cols = pathColumns(catalog, spec);
  // the path owner: the source's user, or the key the caller named (pathColumn)
  const user = q(pathColumn || cols.user);
  // the event name as the paths read it: the source's own, or the one events.split made from parameters
  const event = q(eventColumn || cols.event);
  const time = q(cols.time);
  const segs = segments.map((sg) => sg.name);
  // an event named by a group takes the group's name
  const groups = Object.entries(spec.events?.groups || {});
  const named = groups.length
    ? `CASE ${groups.map(([g, evs]) => `WHEN ${event} IN (${evs.map((e) => lit(d, e)).join(', ')}) THEN ${lit(d, g)}`).join(' ')} ELSE ${d.castExpr(event, 'string')} END`
    : d.castExpr(event, 'string');
  const top = spec.events?.top ?? null;
  const sample = spec.sample?.share != null && spec.sample.share < 1
    ? ` AND ${d.valueBucket(user, SAMPLE_BUCKETS)} < ${Math.round(spec.sample.share * SAMPLE_BUCKETS)}`
    : '';
  // a share of the rows of the named events (by the name before grouping), each row by a hash of
  // its user, time and name — its own hash, independent of the user sample
  const eventShares = Object.entries(spec.sample?.events || {}).filter(([, v]) => v < 1);
  const rowKey = `concat(${d.castExpr(user, 'string')}, '|', ${d.castExpr(time, 'string')}, '|', ${d.castExpr(event, 'string')})`;
  const eventSample = eventShares.length
    ? ` AND (CASE ${eventShares.map(([e, v]) => `WHEN ${event} = ${lit(d, e)} THEN ${d.valueBucket(rowKey, SAMPLE_BUCKETS)} < ${Math.round(v * SAMPLE_BUCKETS)}`).join(' ')} ELSE TRUE END)`
    : '';
  // a segment's values as text: what the library compares a level with, the same spelling in the
  // summary, the library's own check and every analysis
  const segSel = segments.map((sg) => `, ${d.castExpr(q(sg.expr), 'string')} AS ${d.quoteIdent(sg.name)}`).join('');
  const segNames = segs.map((s) => `, ${d.quoteIdent(s)}`).join('');
  const ctes = [
    `es_base AS (\n${base.sql}\n)`,
    `es_events AS (SELECT ${d.castExpr(user, 'string')} AS ${ES_COLUMNS.user}, ${named} AS ${ES_COLUMNS.event}, ${time} AS ${ES_COLUMNS.time}${segSel} FROM es_base WHERE ${user} IS NOT NULL AND ${event} IS NOT NULL AND ${time} IS NOT NULL${sample}${eventSample})`,
    // every event keeps its name unless the caller asked for a top N
    ...(top
      ? [
        `es_top AS (SELECT ${ES_COLUMNS.event} FROM es_events GROUP BY ${ES_COLUMNS.event} ORDER BY COUNT(*) DESC, ${ES_COLUMNS.event} LIMIT ${Number(top)})`,
        `es_named AS (SELECT ${ES_COLUMNS.user}, CASE WHEN ${ES_COLUMNS.event} IN (SELECT ${ES_COLUMNS.event} FROM es_top) THEN ${ES_COLUMNS.event} ELSE ${lit(d, OTHER_EVENT)} END AS ${ES_COLUMNS.event}, ${ES_COLUMNS.time}${segNames} FROM es_events)`,
      ]
      : [`es_named AS (SELECT * FROM es_events)`]),
  ];
  let final = `SELECT ${ES_COLUMNS.user}, ${ES_COLUMNS.event}, ${ES_COLUMNS.time}${segNames} FROM es_named`;
  if (spec.sessions?.gap_minutes) {
    const order = `ORDER BY ${ES_COLUMNS.time}, ${ES_COLUMNS.event}`;
    const gap = d.dateDiff('second', `LAG(${ES_COLUMNS.time}) OVER (PARTITION BY ${ES_COLUMNS.user} ${order})`, ES_COLUMNS.time);
    ctes.push(`es_breaks AS (SELECT *, CASE WHEN LAG(${ES_COLUMNS.time}) OVER (PARTITION BY ${ES_COLUMNS.user} ${order}) IS NULL OR ${gap} > ${Number(spec.sessions.gap_minutes) * 60} THEN 1 ELSE 0 END AS es_new_session FROM es_named)`);
    final = `SELECT ${ES_COLUMNS.user}, ${ES_COLUMNS.event}, ${ES_COLUMNS.time}${segNames}, CONCAT(${ES_COLUMNS.user}, '#', ${d.castExpr(`SUM(es_new_session) OVER (PARTITION BY ${ES_COLUMNS.user} ${order} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, 'string')}) AS ${ES_COLUMNS.session} FROM es_breaks`;
  }
  return {
    sql: `WITH ${ctes.join(',\n')}\n${final}`,
    segments: segs,
    columns: [ES_COLUMNS.user, ES_COLUMNS.event, ES_COLUMNS.time, ...segs, ...(spec.sessions?.gap_minutes ? [ES_COLUMNS.session] : [])],
  };
}
