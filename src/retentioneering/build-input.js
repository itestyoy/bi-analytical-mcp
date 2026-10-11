// A START'S INPUT, CHECKED — what an eventstream is declared from, held to what it reads: the rows of a
// catalog source or of a task's stored table, prepared by the pipeline's own stages, and the columns of
// those rows the start names as the path, the event, its time and the segments. What can be said before
// the stages are built is checked first (validateStart); the names are checked against the columns the
// stages leave (checkNamedColumns). Every mistake is refused here, naming the field and the nearest name.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { isTimeType } from '../dialects/base.js';
import { userKeyColumn } from './schema.js';
import { ES_COLUMNS } from './names.js';

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

/**
 * Whose event, which event, when: an events source's own columns unless the start names others
 * (`columns` — a column a compute stage made), and a task's table's as the start names them (its
 * columns carry no catalog meaning: `user` is null there, and the path is always named).
 */
export function namedColumns(catalog, spec) {
  const own = spec.from_task === undefined && spec.source
    ? { user: userKeyColumn(catalog, spec.source), event: catalog.eventNameColumn(spec.source), time: catalog.getModel(spec.source).time.column }
    : { user: null, event: undefined, time: undefined };
  return { user: own.user, event: spec.columns?.event ?? own.event, time: spec.columns?.time ?? own.time };
}

/**
 * What a start says that can be checked before its stages are built: a source whose paths have an owner
 * (unless the path is named), the events a sample names — when the event is the source's own column, its
 * vocabulary is the catalog's — the names the eventstream keeps for its own columns, which no segment
 * may take, and a join that would repeat the events.
 */
export function validateStart(catalog, spec) {
  const { source } = spec;
  if (spec.from_task === undefined && !spec.path && !userKeyColumn(catalog, source)) throw new ToolError(`'${source}' names no single user key toward the users model, so its events have no path owner — name what one path is with path`, { stage: 'validate', field: 'source' });
  if (spec.from_task === undefined) {
    const own = catalog.eventNameColumn(source);
    if ((spec.columns?.event ?? own) === own) checkEvents(catalog, source, Object.keys(spec.sample?.events || {}), 'sample.events');
  }
  const cols = namedColumns(catalog, spec);
  const path = spec.path || [cols.user];
  if (new Set([...path, cols.event, cols.time]).size < path.length + 2) throw new ToolError('the path, the event column and the time column name different columns', { stage: 'validate', field: 'columns' });
  const reserved = Object.values(ES_COLUMNS);
  for (const seg of spec.segments || []) {
    if (reserved.includes(seg)) throw new ToolError(`segment '${seg}' takes a name the eventstream uses for its own column (${reserved.join(', ')}) — carry it under another: a compute stage copies it ({ stage: "compute", name: "${seg}_value", expr: { column: "${seg}" } })`, { stage: 'validate', field: 'segments' });
  }
  // a slowly-changing model joined on its key alone matches every version of it, so each event would
  // repeat once per version — and an eventstream is one row per event: the version valid at the event's
  // time is stated, as a pipeline states it (a pipeline only warns: its rows may be meant as versions)
  (spec.stages || []).forEach((st, i) => {
    if (st?.stage !== 'join' || st.between || !catalog.models?.[st.with]) return;
    const m = catalog.getModel(st.with);
    if (!m?.scd) return;
    const bound = (v) => Object.entries(m.dimensions || {}).find(([, d]) => d.validity === v)?.[0] ?? `<its ${v === 'start' ? 'valid-from' : 'valid-until'} column>`;
    throw new ToolError(`stages[${i}] (join): '${st.with}' is a slowly-changing model, and joined on its key alone it matches every version of a key — each event would repeat once per version, and an eventstream is one row per event. Join the version valid at the event's time: between: { column: '${cols.time ?? '<the event time column>'}', from: '${bound('start')}', to: '${bound('end')}' }`, { stage: 'validate', field: `stages[${i}]` });
  });
  return spec;
}

/**
 * The columns a start names, held to the columns its rows have after the stages (`cols`, the tracked
 * Map name → { type } the pipeline leaves): every path part, the event and the time column, every
 * segment — and the time column a moment, since the paths are ordered by it. `origin` says whose rows
 * they are, for the refusal.
 */
export function checkNamedColumns(catalog, spec, cols, origin) {
  const have = [...cols.keys()];
  // what is not a column of the rows yet is made one by a stage
  const BROUGHT = ' — a related model\'s attribute is brought in by a join stage, an event property read into a column by a compute stage';
  const known = (col, field, how = '') => {
    if (!cols.has(col)) throw new ToolError(`'${col}' is not a column of ${origin}${suggest(col, have)}${how} (its columns: ${have.join(', ')})`, { stage: 'validate', field });
  };
  const { user, event, time } = namedColumns(catalog, spec);
  (spec.path || [user]).forEach((col) => known(col, spec.path ? 'path' : 'source', spec.path ? BROUGHT : ''));
  known(event, 'columns.event');
  known(time, 'columns.time');
  for (const seg of spec.segments || []) known(seg, 'segments', BROUGHT);
  const t = cols.get(time)?.type;
  if (t && t !== 'unknown' && !isTimeType(t)) throw new ToolError(`the time column '${time}' is a ${t} column — the paths are ordered by a time (a timestamp or a date)`, { stage: 'validate', field: 'columns.time' });
}
