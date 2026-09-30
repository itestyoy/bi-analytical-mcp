// JOIN KEYS AS THE SCHEMA DECLARES THEM — a relationship's type and its key parts (several columns,
// each at an optional grain), brought to one shape for every model that declares one.

// Entity roles a join key may take. `primary`/`unique` make the model the join TARGET for
// that entity; `foreign` points at whichever model owns it; `natural` is the SCD-2 form.
export const ENTITY_TYPES = new Set(['primary', 'unique', 'foreign', 'natural']);

// The time grains — the ones both dialects can truncate to, finest first: what a time dimension, a
// cumulative metric's grain_to_date and a date_trunc take, and what a key part may be joined on.
export const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

export const KEY_PART_GRAINS = new Set(GRAINS);

/**
 * Normalise the PARTS of one key: a column name, or a list of them for a composite key. A part may
 * be written as `{ column, grain }` — the grain is the unit the two sides are compared at, and BOTH
 * sides render as the column TRUNCATED to it. That is what makes a per-day join a per-day join: a
 * timestamp on one side and a date on the other otherwise compare raw and match (almost) nothing.
 * A key part carries nothing else, so an unknown field is a mistake, not decoration.
 */
export function normalizeKeyParts(raw, { where, columns }) {
  const parts = (Array.isArray(raw) ? raw : [raw]).map((p) => {
    if (typeof p === 'string') return { column: p };
    for (const k of Object.keys(p || {})) {
      if (k !== 'column' && k !== 'grain') throw new Error(`${where}: a key part takes 'column' and optionally 'grain' — '${k}' is not a key-part field`);
    }
    if (p?.grain !== undefined && !KEY_PART_GRAINS.has(p.grain)) {
      throw new Error(`${where}: grain '${p.grain}' is not one of ${[...KEY_PART_GRAINS].join(', ')}`);
    }
    return { column: p?.column, ...(p?.grain ? { grain: p.grain } : {}) };
  });
  if (!parts.length || parts.some((p) => !p.column)) {
    throw new Error(`${where}: 'key' needs a column name, or a list of them for a composite key`);
  }
  if (columns?.size) {
    for (const p of parts) if (!columns.has(p.column)) throw new Error(`${where}: '${p.column}' is not a column of the model`);
  }
  return parts;
}

/**
 * Normalise ONE declared join key into { type, key: [parts], column?, variants? }. `column` is
 * kept for the plain single-column case so everything that already reads it keeps working.
 */
export function normalizeEntityKey(name, decl, { model, columns }) {
  const where = `entity '${name}' of model '${model}'`;
  if (!name) throw new Error(`${model}: an entity declaration needs a name`);
  const type = decl.type || 'foreign';
  if (!ENTITY_TYPES.has(type)) throw new Error(`${where}: unknown entity type '${type}' — use one of: ${[...ENTITY_TYPES].join(', ')}`);
  // VARIANTS: the same relationship carried by SEVERAL alternative key columns on this side —
  // e.g. a crash row that reports one tracking id per ad format. Each becomes its own
  // '<relationship>_<variant>' key, and the caller picks which one to join on.
  const variants = {};
  for (const [vName, vDecl] of Object.entries(decl.variants || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(vName)) throw new Error(`${where}: variant name '${vName}' must be lowercase snake_case`);
    if (vName.includes('__')) throw new Error(`${where}: variant name '${vName}' may not contain '__'`);
    const vRaw = Array.isArray(vDecl) || typeof vDecl === 'string' ? vDecl : (vDecl || {}).key ?? (vDecl || {}).column;
    variants[vName] = normalizeKeyParts(vRaw, { where: `${where} variant '${vName}'`, columns });
  }
  const raw = decl.key !== undefined ? decl.key : decl.column;
  if (raw === undefined) {
    if (!Object.keys(variants).length) throw new Error(`${where}: 'key' needs a column name, or a list of them for a composite key`);
    return { type, variants }; // variants only: this side has no single canonical key
  }
  const parts = normalizeKeyParts(raw, { where, columns });
  return { type, key: parts, ...(Object.keys(variants).length ? { variants } : {}) };
}
