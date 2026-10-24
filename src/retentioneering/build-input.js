// A BUILD'S INPUT, CHECKED — each step at its place (checkStepPlaces: the steps are the library's own,
// added once the eventstream is built), and what an eventstream is declared from, held to what it reads:
// the rows of a catalog source or of a task's stored table (the rows build_model prepared), and the
// columns of those rows the start names as the path, the event, its time and the segments. What can be
// said before the rows are read is checked first (validateStart); the names are checked against the
// rows' columns (checkNamedColumns). Every mistake is refused here, naming the field and the nearest name.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { isTimeType } from '../dialects/base.js';
import { userKeyColumn, LIBRARY_STEPS, ADDED, COMPLEX_EVENT_LOGIC, checkConditionPairs } from './schema.js';
import { ES_COLUMNS } from './names.js';

export function suggest(value, known) {
  const near = rankFuzzy(value, known, { fields: (x) => [x], threshold: 0.7, limit: 3 }).map((m) => m.item);
  return near.length ? ` — did you mean ${near.map((n) => `'${n}'`).join(', ')}?` : '';
}

/**
 * What a build's steps are, said before its schema lists the forms: a start takes none (its rows are a
 * source's own, or a task's table build_model prepared), and add_steps / edit_step / insert_step take the
 * library's own steps ({ type }) — a SQL stage ({ stage }) is build_model's. A refusal names the place,
 * what it takes and where the step belongs.
 */
export function precheckPlaces(input, action) {
  const given = action === 'start' ? ['steps', 'stages'].find((k) => input?.[k] !== undefined) : null;
  if (given) throw new ToolError(`${given}: an eventstream's start takes no steps — the library's steps are added once it is built (add_steps). ${COMPLEX_EVENT_LOGIC}`, { stage: 'validate', field: given });
  for (const [field, st] of stepsOf(input, action)) {
    if (st?.stage !== undefined) throw new ToolError(`${field}: ${LIBRARY_STEPS.what} take ${LIBRARY_STEPS.takes} — { stage: "${st.stage}" } is a SQL stage of build_model: prepare the rows there and start the eventstream from its task (from_task)`, { stage: 'validate', field });
  }
}

/** The steps a build action carries, each with the field it is in. */
function stepsOf(input, action) {
  return action === 'add_steps'
    ? (Array.isArray(input?.steps) ? input.steps : []).map((st, i) => [`steps[${i}]`, st])
    : action === 'edit_step' || action === 'insert_step' ? [['step', input?.step]] : [];
}

/**
 * Each library step's parameters this tool adds, at their own place (ADDED: filter_events' where, over
 * the eventstream's rows) — what that place does not take is refused here, before any eventstream is read.
 */
export function checkStepPlaces(catalog, input, action) {
  precheckPlaces(input, action);
  for (const [field, st] of stepsOf(input, action)) {
    for (const [name, a] of Object.entries(ADDED[st?.type] || {})) if (st[name] != null) a.toLibrary(st[name], `${field}.${name}`);
    checkConditionPairs(st, field);
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
 * Whose event, which event, when: an events source's own columns unless the start names others of the
 * source (`columns`), and a task's table's as the start names them (its
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
  if (new Set([...path, cols.event, cols.time]).size < path.length + 2) throw new ToolError('the path, the event column and the time column must each name a different column — one column cannot be two of them', { stage: 'validate', field: 'columns' });
  const reserved = Object.values(ES_COLUMNS);
  for (const seg of spec.segments || []) {
    if (reserved.includes(seg)) throw new ToolError(`segment '${seg}' takes a name the eventstream uses for its own column (${reserved.join(', ')}) — carry it under another: the build_model pipeline the start reads (from_task) copies it ({ stage: "compute", name: "${seg}_value", expr: { column: "${seg}" } })`, { stage: 'validate', field: 'segments' });
  }
  return spec;
}

/**
 * The columns a start names, held to the columns its rows have (`cols`, the tracked Map name → { type }
 * of the source or of the task's table): every path part, the event and the time column, every
 * segment — and the time column a moment, since the paths are ordered by it. `origin` says whose rows
 * they are, for the refusal.
 */
export function checkNamedColumns(catalog, spec, cols, origin) {
  const have = [...cols.keys()];
  // what is not a column of the rows is made one by a build_model pipeline the start reads
  const BROUGHT = ' — a related model\'s attribute or an event property is a column of a table build_model joins or computes it into (start from its task: from_task)';
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
