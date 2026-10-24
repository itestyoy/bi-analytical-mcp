// A JOIN CONTRACT AS THE SCHEMA DECLARES IT — `config.meta.mcp.join` on the model that is JOINED: what a
// caller must say to join it, part by part, and how each part matches. Only a model that declares one is
// joinable, and it declares its key unique (`unique: true` — the authors' word, not checked on data): a
// joined row then meets at most one row of it, so nothing the rows carry is repeated.
//
//   join:
//     unique: true
//     key:    { user: player_id_of_internal }               # a part matched by equality on a column of the rows
//             { funnel: { by: format, columns: { rewarded: rewarded_tracking_id, … } } }
//                                                           # …on the column a select part's value picks
//     time:   { within: [valid_from, valid_until] }         # the rows' moment inside the joined row's window
//             { same_day: spend_date }                      # …or on the joined row's day
//     select: { experiment: experiment_name }               # a VALUE the joined model is filtered to first
//             { format: [rewarded, interstitial, banner] }  # …or a choice among the listed words
//
// A call names every part, and nothing else: `on: { <part>: <a column of the rows | a value> }`.

import { NAME } from '../pipeline/sql.js';

const PART = /^[a-z][a-z0-9_]*$/;
const FIELDS = ['unique', 'key', 'time', 'select'];

/** The one name of the time part — the moment of the rows a joined row is matched at. */
export const TIME_PART = 'time';

/**
 * A model's `join` block brought to one shape — { key: [{ part, column } | { part, by, columns }],
 * time: { within: [from, to] } | { same_day } | null, select: [{ part, column } | { part, values }] } —
 * every mistake refused at load, naming the model and the part.
 */
export function normalizeJoinContract(raw, { model, columns }) {
  const where = `model '${model}': config.meta.mcp.join`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} is an object: { unique: true, key: { <part>: <column> }, time?, select? }`);
  const unknown = Object.keys(raw).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`${where} has no field ${unknown.map((k) => `'${k}'`).join(', ')} — it takes ${FIELDS.join(', ')}`);
  if (raw.unique !== true) throw new Error(`${where}: a model is joinable only on a key its authors declare unique — write unique: true (a row of the rows then meets at most one row of '${model}')`);
  const has = (c) => !columns?.size || columns.has(c);
  const column = (c, at) => {
    if (typeof c !== 'string' || !c) throw new Error(`${where}.${at}: a column name`);
    if (!has(c)) throw new Error(`${where}.${at}: '${c}' is not a column of the model`);
    return c;
  };
  const partName = (p, at) => {
    if (!PART.test(p)) throw new Error(`${where}.${at}: part '${p}' — a part's name is lowercase snake_case`);
    if (p === TIME_PART) throw new Error(`${where}.${at}: '${TIME_PART}' is the time part's own name (join.time)`);
    return p;
  };
  const select = Object.entries(raw.select || {}).map(([part, v]) => {
    partName(part, 'select');
    if (Array.isArray(v)) {
      if (!v.length || v.some((x) => typeof x !== 'string' || !PART.test(x))) throw new Error(`${where}.select.${part}: a list of words (lowercase snake_case) the caller chooses among`);
      return { part, values: [...new Set(v)] };
    }
    return { part, column: column(v, `select.${part}`) };
  });
  const choices = new Map(select.filter((s) => s.values).map((s) => [s.part, s.values]));
  const key = Object.entries(raw.key || {}).map(([part, v]) => {
    partName(part, 'key');
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const extra = Object.keys(v).filter((k) => k !== 'by' && k !== 'columns');
      if (extra.length) throw new Error(`${where}.key.${part}: a part chosen by a select part is { by, columns } — not ${extra.join(', ')}`);
      const values = choices.get(v.by);
      if (!values) throw new Error(`${where}.key.${part}: by '${v.by}' names no select part with a list of words`);
      const cols = v.columns || {};
      const missing = values.filter((x) => !cols[x]);
      const stray = Object.keys(cols).filter((x) => !values.includes(x));
      if (missing.length || stray.length) throw new Error(`${where}.key.${part}: columns name one column for each of ${values.join(', ')}${missing.length ? ` — missing ${missing.join(', ')}` : ''}${stray.length ? ` — ${stray.join(', ')} is no word of select.${v.by}` : ''}`);
      return { part, by: v.by, columns: Object.fromEntries(values.map((x) => [x, column(cols[x], `key.${part}.columns.${x}`)])) };
    }
    return { part, column: column(v, `key.${part}`) };
  });
  if (!key.length) throw new Error(`${where}: key names at least one part — { <part>: <column> }`);
  const dup = [...key, ...select].map((p) => p.part).find((p, i, all) => all.indexOf(p) !== i);
  if (dup) throw new Error(`${where}: part '${dup}' is named twice`);
  let time = null;
  if (raw.time != null) {
    const t = raw.time;
    const forms = Object.keys(t || {});
    if (forms.length !== 1 || !['within', 'same_day'].includes(forms[0])) throw new Error(`${where}.time: one of { within: [<from>, <to>] } (the joined row's validity window) or { same_day: <column> }`);
    if (t.within) {
      if (!Array.isArray(t.within) || t.within.length !== 2) throw new Error(`${where}.time.within: [<from column>, <to column>]`);
      time = { within: [column(t.within[0], 'time.within[0]'), column(t.within[1], 'time.within[1]')] };
    } else time = { same_day: column(t.same_day, 'time.same_day') };
  }
  return { key, time, select };
}

/** The parts a call names, in order: the key's, the time's, the select's. */
export function contractParts(contract) {
  return [...contract.key.map((k) => k.part), ...(contract.time ? [TIME_PART] : []), ...contract.select.map((s) => s.part)];
}

/** How a contract matches, in a line: what a description and an answer say of it. */
export function describeContract(model, contract) {
  const key = contract.key.map((k) => (k.by ? `${k.part} (the ${k.by}'s column)` : `${k.part} = ${k.column}`));
  const time = contract.time?.within ? [`time within ${contract.time.within.join('–')}`] : contract.time?.same_day ? [`time on the day of ${contract.time.same_day}`] : [];
  const select = contract.select.map((s) => (s.values ? `${s.part}: one of ${s.values.join(' | ')}` : `${s.part}: a value of ${s.column}`));
  return `${model} — ${[...key, ...time, ...select].join('; ')}`;
}

/** What is wrong with the parts an `on` names for `contract` — every part named, nothing else — or null. */
export function onPartsError(model, contract, on) {
  const parts = contractParts(contract);
  const missing = parts.filter((k) => on?.[k] === undefined);
  const stray = Object.keys(on || {}).filter((k) => !parts.includes(k));
  if (!missing.length && !stray.length) return null;
  return `on names its contract's parts — ${parts.join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${stray.length ? `; ${stray.join(', ')} is no part of it` : ''} (${describeContract(model, contract)})`;
}

/**
 * `on` of a join onto `model` — the parts of the contract it declares, each named: a key part and the
 * time a column of the rows, a select part its value. The pipeline's join step and the semantic_model
 * stage's join take this one object.
 */
export function contractOnSchema(model, contract) {
  const rowsColumn = (what) => ({ type: 'string', pattern: NAME, description: `A column of the rows: ${what}.` });
  const on = {};
  for (const k of contract.key) on[k.part] = rowsColumn(k.by ? `its value equals ${model}'s column the ${k.by} picks` : `its value equals ${model}.${k.column}`);
  if (contract.time) on[TIME_PART] = rowsColumn(contract.time.within ? `the moment the version of ${model} valid then is joined (${contract.time.within.join(' … ')})` : `the moment whose day is ${model}.${contract.time.same_day}'s`);
  for (const s of contract.select) on[s.part] = s.values ? { enum: s.values, description: `Which ${s.part}.` } : { type: 'string', minLength: 1, description: `The ${s.column} of ${model} the join keeps — a value it holds.` };
  return { type: 'object', additionalProperties: false, required: Object.keys(on), properties: on, description: `The join contract ${model} declares: ${describeContract(model, contract)}.` };
}
