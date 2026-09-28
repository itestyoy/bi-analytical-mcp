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
//   <segments>  the declared user attributes
//
// Deterministic: a sample keeps users by a hash of their key, and every ordering carries a tiebreak.

import { renderPipeline } from '../pipeline.js';
import { getDialect } from '../dialects/index.js';
import { userKeyColumn } from './schema.js';

/** The fixed columns of every eventstream (segment columns come after them). */
export const ES_COLUMNS = { user: 'user_id', event: 'event', time: 'event_time', session: 'session_id' };
export const OTHER_EVENT = 'other';
const SAMPLE_BUCKETS = 10000;

const lit = (d, v) => d.sqlLiteral(v);

/**
 * The stages that scope the source and bring the segment attributes, and what they expose.
 * `timeConditions` is the engine's own time-window where (the same window a pipeline applies).
 */
export function eventstreamStages(catalog, spec, { timeConditions = null } = {}) {
  const src = catalog.getModel(spec.source);
  const eventCol = catalog.eventNameColumn(spec.source);
  const stages = [];
  if (timeConditions) stages.push({ stage: 'where', conditions: timeConditions });
  const ev = spec.events || {};
  if (ev.include?.length) stages.push({ stage: 'where', conditions: [{ column: eventCol, op: 'in', value: ev.include }] });
  if (ev.exclude?.length) stages.push({ stage: 'where', conditions: [{ column: eventCol, op: 'not_in', value: ev.exclude }] });
  const segments = [];
  for (const seg of spec.segments || []) {
    const name = seg.as || seg.attribute;
    const join = { stage: 'join', with: seg.model, via: seg.via, attrs: [{ column: seg.attribute, as: name }] };
    // a slowly-changing model is joined point in time — at the event's own time (as a pipeline must state it)
    const m = catalog.getModel(seg.model);
    if (m?.scd) {
      const from = Object.entries(m.dimensions || {}).find(([, dd]) => dd.validity === 'start')?.[0];
      const to = Object.entries(m.dimensions || {}).find(([, dd]) => dd.validity === 'end')?.[0];
      if (from && to) join.between = { value: src.time.column, from, to };
    }
    stages.push(join);
    segments.push(name);
  }
  if (spec.where?.length) stages.push({ stage: 'where', conditions: spec.where.map((c) => ({ column: c.column, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) })) });
  return { stages, segments };
}

/** The whole eventstream model's SQL, in the catalog's dialect. */
export function renderEventstream(catalog, spec, { modelName, physicalCols = null, timeConditions = null } = {}) {
  const d = getDialect(catalog.dialect);
  const { stages, segments } = eventstreamStages(catalog, spec, { timeConditions });
  const base = renderPipeline(catalog, catalog.dialect, spec.source, stages, { physicalCols, modelName });
  const q = (c) => c; // catalog column names are plain identifiers, as the pipeline renders them
  const user = q(userKeyColumn(catalog, spec.source));
  const event = q(catalog.eventNameColumn(spec.source));
  const time = q(catalog.getModel(spec.source).time.column);
  const segs = segments.map(q);
  // an event named by a group takes the group's name
  const groups = Object.entries(spec.events?.groups || {});
  const named = groups.length
    ? `CASE ${groups.map(([g, evs]) => `WHEN ${event} IN (${evs.map((e) => lit(d, e)).join(', ')}) THEN ${lit(d, g)}`).join(' ')} ELSE ${d.castExpr(event, 'string')} END`
    : d.castExpr(event, 'string');
  const top = spec.events?.top ?? null;
  const sample = spec.sample?.share != null && spec.sample.share < 1
    ? ` AND ${d.valueBucket(user, SAMPLE_BUCKETS)} < ${Math.round(spec.sample.share * SAMPLE_BUCKETS)}`
    : '';
  const segSel = segs.map((s) => `, ${s}`).join('');
  const segNames = segs.map((s) => `, ${s}`).join('');
  const ctes = [
    `es_base AS (\n${base.sql}\n)`,
    `es_events AS (SELECT ${d.castExpr(user, 'string')} AS ${ES_COLUMNS.user}, ${named} AS ${ES_COLUMNS.event}, ${time} AS ${ES_COLUMNS.time}${segSel} FROM es_base WHERE ${user} IS NOT NULL AND ${event} IS NOT NULL AND ${time} IS NOT NULL${sample})`,
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
    segments,
    columns: [ES_COLUMNS.user, ES_COLUMNS.event, ES_COLUMNS.time, ...segments, ...(spec.sessions?.gap_minutes ? [ES_COLUMNS.session] : [])],
  };
}
