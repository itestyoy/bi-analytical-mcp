// THE EVENTSTREAM — the one table a path analysis reads, prepared in SQL where the data lives
// (AGENTS.md: what SQL can compute is computed in SQL; the python step receives a prepared table).
//
// The rows are prepared by the pipeline's own stages (src/pipeline.js): the time window as a `where`,
// then the start's steps as the caller wrote them — a `where` scoping the events, a `compute` renaming
// them or reading a property into a column, a `join` bringing an attribute by a relationship the catalog
// declares (point in time for a slowly-changing model, as the caller states it) — so the dialect, the
// relationship keys and the typing of every comparison are exactly a pipeline's. On top of that one
// statement shapes the path table from the columns the start names:
//
//   user_id     the path owner: the source's per-user key, or the path's columns (several joined by
//               '|', a composite key), as text — rows without every part are left out
//   event       the event name, as text (when the caller asks for a top N, the rest merged into "other")
//   event_time  the event's time
//   session_id  when sessions are asked for: user_id#n, a new n after each gap longer than asked
//   <segments>  the named columns, as text, each under its own name
//
// Deterministic: a sample keeps users by a hash of their key (or rows of the named events by a hash
// of the row), and every ordering carries a tiebreak.

import { renderPipeline } from '../pipeline.js';
import { concatSql } from '../pipeline/compute.js';
import { getDialect } from '../dialects/index.js';
import { ToolError } from '../validate.js';
import { namedColumns, checkNamedColumns } from './build-input.js';
import { ES_COLUMNS } from './names.js';

export const OTHER_EVENT = 'other';
const SAMPLE_BUCKETS = 10000;

const lit = (d, v) => d.sqlLiteral(v);

/** What one path is: the columns of its key the start named (one path per value; several make a
 *  composite key), or null — one path per user. */
export function pathParts(spec) {
  return spec.path || null;
}

/** The stages the rows are prepared by: the time window (the engine's own where, the window a pipeline
 *  applies), then the start's steps as written. */
function eventstreamStages(spec, { timeConditions = null } = {}) {
  return [...(timeConditions ? [{ stage: 'where', conditions: timeConditions }] : []), ...(spec.steps || [])];
}

/**
 * The pipeline over `stages`, or the refusal of the first stage it cannot build — named by its place in
 * the start's `steps`; `own` stages before them are the server's (the time window).
 */
function prepared(catalog, spec, stages, own, opts) {
  try {
    return renderPipeline(catalog, catalog.dialect, spec.source, stages, opts);
  } catch (e) {
    // the first stage whose prefix no longer builds is the one refused, with that prefix's own reason
    for (let i = 1; i <= stages.length; i += 1) {
      try { renderPipeline(catalog, catalog.dialect, spec.source, stages.slice(0, i), opts); } catch (at) {
        const k = i - 1 - own;
        const message = at?.message || String(at);
        if (k < 0) throw new ToolError(message, { stage: 'validate', field: 'time_range' });
        throw new ToolError(`steps[${k}] (${stages[i - 1]?.stage}): ${message}`, { stage: 'validate', field: `steps[${k}]` });
      }
    }
    throw new ToolError(e?.message || String(e), { stage: 'validate', field: 'steps' });
  }
}

/** The whole eventstream model's SQL, in the catalog's dialect. */
export function renderEventstream(catalog, spec, { modelName, physicalCols = null, timeConditions = null, from = null } = {}) {
  const d = getDialect(catalog.dialect);
  const stages = eventstreamStages(spec, { timeConditions });
  // `from`: a task's stored table (a pipeline build) is the relation the steps run over — the same
  // start a pipeline makes from a task; the source is then only what the steps resolve names against
  const base = prepared(catalog, spec, stages, stages.length - (spec.steps || []).length, { physicalCols, modelName, from });
  checkNamedColumns(catalog, spec, base.columns, from ? `task ${spec.from_task}'s table${spec.steps?.length ? ' after the steps' : ''}` : `'${spec.source}'${spec.steps?.length ? ' after the steps' : ''}`);
  // every column the eventstream reads of the rows is one the caller named: quoted as the dialect quotes it
  const q = (c) => d.quoteIdent(c);
  const text = (sql) => d.castExpr(sql, 'string');
  // values ({ sql, type? }) joined by '|' as text, by the one writer of a concatenation: missing where
  // any is missing, on every warehouse; each not known to be text read as its text
  const joined = (values) => concatSql(d, values.flatMap((v, i) => (i ? [{ sql: lit(d, '|'), type: 'string' }, v] : [v])));
  const cols = namedColumns(catalog, spec);
  // the path owner: the source's user, or the key the caller named — its parts as text, several joined
  // by '|' (a composite key), so one path is one value of all of them together
  const named = pathParts(spec);
  const parts = named || [cols.user];
  const owner = !named ? q(cols.user) : named.length === 1 ? text(q(named[0])) : joined(named.map((p) => ({ sql: q(p) })));
  const ownerText = named ? owner : text(owner);
  const event = q(cols.event);
  const time = q(cols.time);
  const segments = spec.segments || [];
  const top = spec.top ?? null;
  const sample = spec.sample?.share != null && spec.sample.share < 1
    ? ` AND ${d.valueBucket(owner, SAMPLE_BUCKETS)} < ${Math.round(spec.sample.share * SAMPLE_BUCKETS)}`
    : '';
  // a share of the rows of the named events (by the name the rows hold), each row by a hash of its
  // user, time and name — its own hash, independent of the user sample
  const eventShares = Object.entries(spec.sample?.events || {}).filter(([, v]) => v < 1);
  const rowKey = joined([{ sql: ownerText, type: 'string' }, { sql: time }, { sql: event }]);
  const eventSample = eventShares.length
    ? ` AND (CASE ${eventShares.map(([e, v]) => `WHEN ${event} = ${lit(d, e)} THEN ${d.valueBucket(rowKey, SAMPLE_BUCKETS)} < ${Math.round(v * SAMPLE_BUCKETS)}`).join(' ')} ELSE TRUE END)`
    : '';
  // a segment's values as text: what the library compares a level with, the same spelling in the
  // summary, the library's own check and every analysis
  const segSel = segments.map((s) => `, ${text(q(s))} AS ${q(s)}`).join('');
  const segNames = segments.map((s) => `, ${q(s)}`).join('');
  const present = [...parts, cols.event, cols.time].map((c) => `${q(c)} IS NOT NULL`).join(' AND ');
  const ctes = [
    `es_base AS (\n${base.sql}\n)`,
    `es_events AS (SELECT ${ownerText} AS ${ES_COLUMNS.user}, ${text(event)} AS ${ES_COLUMNS.event}, ${time} AS ${ES_COLUMNS.time}${segSel} FROM es_base WHERE ${present}${sample}${eventSample})`,
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
    const n = `SUM(es_new_session) OVER (PARTITION BY ${ES_COLUMNS.user} ${order} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
    final = `SELECT ${ES_COLUMNS.user}, ${ES_COLUMNS.event}, ${ES_COLUMNS.time}${segNames}, ${concatSql(d, [{ sql: ES_COLUMNS.user, type: 'string' }, { sql: lit(d, '#'), type: 'string' }, { sql: n }])} AS ${ES_COLUMNS.session} FROM es_breaks`;
  }
  return {
    sql: `WITH ${ctes.join(',\n')}\n${final}`,
    segments,
    columns: [ES_COLUMNS.user, ES_COLUMNS.event, ES_COLUMNS.time, ...segments, ...(spec.sessions?.gap_minutes ? [ES_COLUMNS.session] : [])],
  };
}
