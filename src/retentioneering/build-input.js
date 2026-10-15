// A BUILD'S INPUT, CHECKED — each step at its place (checkStepPlaces: a start's steps are the pipeline's
// stages that keep the rows events, the steps added after it the library's own), and what an eventstream
// is declared from, held to what it reads: the rows of a catalog source or of a task's stored table,
// prepared by its steps (the pipeline's own stages), and the columns of those rows the start names as the
// path, the event, its time and the segments. What can be said before the steps are built is checked
// first (validateStart); the names are checked against the columns the steps leave (checkNamedColumns).
// Every mistake is refused here, naming the field and the nearest name.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { isTimeType } from '../dialects/base.js';
import { stageAt } from '../pipeline/stages.js';
import { userKeyColumn, startPlace, LIBRARY_STEPS, ADDED } from './schema.js';
import { BUILD, ES_COLUMNS } from './names.js';

export function suggest(value, known) {
  const near = rankFuzzy(value, known, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => m.item);
  return near.length ? ` — did you mean ${near.map((n) => `'${n}'`).join(', ')}?` : '';
}

/**
 * Each step of a build at its place — the one stage definition holds every step there is, and each place
 * takes its part (schema.js startPlace, LIBRARY_STEPS), checked before anything is built: a start's steps
 * are the pipeline's stages that keep the rows the source's events (the core's check, stageAt), and
 * add_steps / edit_step / insert_step take the library's own steps, a parameter this tool adds to one
 * written at its own place (ADDED: filter_events' where). A refusal names the place, what it takes and
 * where the step belongs.
 */
export function checkStepPlaces(catalog, input, action) {
  const steps = action === 'start' || action === 'add_steps'
    ? (Array.isArray(input.steps) ? input.steps : []).map((st, i) => [`steps[${i}]`, st])
    : action === 'edit_step' || action === 'insert_step' ? [['step', input.step]] : [];
  const start = action === 'start' ? startPlace(catalog) : null;
  for (const [field, st] of steps) {
    const library = st?.type !== undefined && st?.stage === undefined;
    if (start) {
      if (library) throw new ToolError(`${field}: ${start.what} takes ${start.stages.join(', ')} — { type: "${st.type}" } is one of the library's steps, added once the eventstream is built: ${BUILD}({ request: { action: 'add_steps', context_id, eventstream, steps: [...] } })`, { stage: 'validate', field });
      try { stageAt(start, st, field); } catch (e) { throw new ToolError(e?.message || String(e), { stage: 'validate', field }); }
    } else if (!library) {
      throw new ToolError(`${field}: ${LIBRARY_STEPS.what} take ${LIBRARY_STEPS.takes}${st?.stage !== undefined ? ` — { stage: "${st.stage}" } is a SQL stage, and the rows are prepared in SQL by the start's steps (${startPlace(catalog).stages.join(', ')}): start the eventstream again with it there` : ''}`, { stage: 'validate', field });
    } else {
      // a parameter this tool adds is written at its own place (filter_events' where: the eventstream's
      // rows): what that place does not take is refused here, before any eventstream is read
      for (const [name, a] of Object.entries(ADDED[st.type] || {})) if (st[name] != null) a.toLibrary(st[name], `${field}.${name}`);
    }
  }
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
 * What a start says that can be checked before its steps are built: a source whose paths have an owner
 * (unless the path is named), the events a sample names — when the event is the source's own column, its
 * vocabulary is the catalog's — and the names the eventstream keeps for its own columns, which no segment
 * may take. (A join repeats no event: it is onto a contract unique on the joined side.)
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
  return spec;
}

/**
 * The columns a start names, held to the columns its rows have after the steps (`cols`, the tracked
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
