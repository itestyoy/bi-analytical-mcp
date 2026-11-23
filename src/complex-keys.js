// THE KEYS OF A COMPLEX PROPERTY — what the value index learns, from the data alone, about what an
// array, a struct or a JSON payload holds: each key of its elements (`words_selected[].word_dictionary`)
// is indexed as a property is — its top values with frequencies, distinct count, the rows that carry
// it per event and per app, and for a number its min / max / percentiles — and an array of scalars'
// elements alike (`breadcrumbs[]`). Nothing is declared: the keys are read off the data (a JSON
// element's keys) or off the warehouse's type (a native struct's fields), every sync, so a key a new
// app version adds to the payload is in the index after the next sync.
//
// A key's rows live in the value store under an id of its own — `<property>[].<key>`, or `<property>[]`
// for scalar elements — so every reader of a property's values and coverage reads a key's alike; the
// registry of keys (when each was first and last seen, its numeric summary) is the store's `prop_keys`.
// The id is internal: a key is NAMED as the grammar reads it, { source, property, field }.

/** A key's id in the value store: `<property>[].<field>`, or `<property>[]` for the scalar elements. */
export const keyId = (property, field) => (field ? `${property}[].${field}` : `${property}[]`);

/** The property and field an id names, or null when it is a property's own id. */
export function parseKeyId(id) {
  const m = /^(.+)\[\](?:\.(.+))?$/.exec(String(id));
  return m ? { property: m[1], field: m[2] ?? '' } : null;
}

/** How a key is shown: `words_selected_of_event_data[].word_dictionary`. */
export const keyPath = keyId;

/**
 * The registry row of no key that says where the key pass of a text holding JSON stands (its watermark):
 * its own row is the scalar pass's, and it may have no keys at all (an empty array, a JSON text inside a
 * JSON text) — without it every sync would scan its whole window again. Never a key: READABLE_KEY refuses it.
 */
export const KEY_PASS = '*';

/** A key this index reads as a field: a name the JSON path and every warehouse take as it is. */
export const READABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * THE STRUCTS INSIDE AN ELEMENT ARE WHERE ITS DECLARATION SAYS — never a depth guessed. A field the catalog
 * declares `struct` (`fields: { additional_info: struct }`, or `{ type: struct, fields: {...} }`) is an object
 * whose keys the value index reads off the data and counts as keys of their own, by their path
 * (additional_info.arrow); the struct itself is their container, no key with values. A struct declared with
 * its own `fields` names the structs inside it alike. → [{ path, nested: [paths of structs declared in it] }]
 * flattened: every declared struct's path, outermost first.
 */
export function declaredStructPaths(fields, prefix = '') {
  const out = [];
  for (const [name, t] of Object.entries(fields || {})) {
    const type = String(t?.type ?? t ?? '').toLowerCase();
    if (type !== 'struct') continue;
    const path = prefix ? `${prefix}.${name}` : name;
    out.push(path);
    if (t && typeof t === 'object' && t.fields) out.push(...declaredStructPaths(t.fields, path));
  }
  return out;
}

/**
 * The scalar leaves of a native struct by their path — its type's fields, a STRUCT field's own fields under
 * its name (a.b), however deep the type nests them; an array inside is no leaf. `fields` as structFieldsOfType
 * gives them, or as a declaration names them ({ name, type, scalar, fields? }).
 */
export function nativeLeafPaths(fields, prefix = '') {
  const out = [];
  for (const f of fields || []) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    if (f.scalar) { out.push(path); continue; }
    const inner = f.fields || (isStructType(f.type) ? structFieldsOfType(f.type) : []);
    if (inner.length) out.push(...nativeLeafPaths(inner, path));
  }
  return out;
}

/** A key not seen in the data for this long is inactive — kept, and said so. */
export const KEY_STALE_MS = 30 * 24 * 3600 * 1000;

/**
 * Whether a property's indexed values say it holds JSON — an object or an array in a text — as a payload
 * declared a plain text often does (custom keys, a config): every value is written as one (it starts with
 * `{` or `[`, a long one may be cut) and at least one reads as one. Its keys are then indexed as a declared
 * array's are, its own values staying a text's.
 */
export function holdsJson(values) {
  const list = (values || []).map((v) => (v && typeof v === 'object' ? v.value : v)).filter((v) => v != null);
  if (!list.length || !list.every((v) => /^\s*[[{]/.test(String(v)))) return false;
  return list.some((v) => { try { const x = JSON.parse(String(v)); return x !== null && typeof x === 'object'; } catch { return false; } });
}

/** Whether a warehouse type is ONE struct (BigQuery `STRUCT<…>`, DuckDB `STRUCT(…)`), not an array of them. */
export const isStructType = (dtype) => /^\s*(STRUCT|ROW|RECORD)\b/i.test(String(dtype || '')) && !/(\[\d*\]\s*$)/.test(String(dtype));

/** The quantile points kept per numeric key (0 %, 1 %, …, 100 %). */
export const QUANTILE_POINTS = 100;

/**
 * The top-level fields of a native struct type as the warehouse writes it — BigQuery's
 * `ARRAY<STRUCT<a INT64, b STRUCT<c STRING>>>` / `STRUCT<…>`, DuckDB's `STRUCT(a INTEGER, b VARCHAR)[]` —
 * as [{ name, type, scalar }] (`scalar`: no struct or array inside, so it reads as a text), or [] when the
 * type holds no struct (an array of scalars).
 */
export function structFieldsOfType(dtype) {
  const t = String(dtype || '').trim();
  const open = t.search(/STRUCT\s*[<(]/i);
  if (open < 0) return [];
  const start = t.indexOf(t.slice(open).match(/[<(]/)[0], open) + 1;
  const fields = [];
  let depth = 0; let part = '';
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (ch === '<' || ch === '(') depth += 1;
    if (ch === '>' || ch === ')') {
      if (depth === 0) { fields.push(part); break; }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) { fields.push(part); part = ''; continue; }
    part += ch;
  }
  return fields.map((f) => f.trim().match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?\s+(.+)$/s)).filter(Boolean)
    .map(([, name, type]) => ({ name, type: type.trim(), scalar: !/STRUCT|ARRAY|MAP|\[\]|</i.test(type) }));
}

/**
 * Two samples' quantiles as one: each point stands for an equal share of its sample's `n` values, so the
 * points of both, weighted by their sample's size, are a weighted sample of the union — read at
 * QUANTILE_POINTS + 1 evenly spaced cumulative weights. An approximation within a point's share; exact
 * when one side is empty. `a` / `b`: ascending points (min … max), or null.
 */
export function mergeQuantiles(a, na, b, nb, points = QUANTILE_POINTS) {
  const side = (q, n) => (Array.isArray(q) && q.length > 1 && n > 0 ? q.map(Number).filter(Number.isFinite) : null);
  const qa = side(a, na); const qb = side(b, nb);
  if (!qa && !qb) return null;
  if (!qa) return qb.slice();
  if (!qb) return qa.slice();
  const weighted = [
    ...qa.map((v, i) => ({ v, w: na / (qa.length - 1) * (i === 0 || i === qa.length - 1 ? 0.5 : 1) })),
    ...qb.map((v, i) => ({ v, w: nb / (qb.length - 1) * (i === 0 || i === qb.length - 1 ? 0.5 : 1) })),
  ].sort((x, y) => x.v - y.v);
  const total = weighted.reduce((s, x) => s + x.w, 0);
  const out = [];
  let acc = 0; let j = 0;
  for (let p = 0; p <= points; p++) {
    const target = (p / points) * total;
    while (j < weighted.length - 1 && acc + weighted[j].w < target) { acc += weighted[j].w; j += 1; }
    out.push(weighted[j].v);
  }
  out[0] = Math.min(qa[0], qb[0]);
  out[points] = Math.max(qa[qa.length - 1], qb[qb.length - 1]);
  return out;
}

/** A numeric key's summary merged with a delta's: counts add, min / max widen, quantiles merge. */
export function mergeNumeric(prior, delta) {
  if (!prior?.count) return delta?.count ? { ...delta } : prior || null;
  if (!delta?.count) return { ...prior };
  return {
    count: prior.count + delta.count,
    min: Math.min(prior.min, delta.min),
    max: Math.max(prior.max, delta.max),
    quantiles: mergeQuantiles(prior.quantiles, prior.count, delta.quantiles, delta.count),
  };
}

/** The percentiles a view says of a numeric key, read off its quantile points. */
export function percentilesOf(quantiles) {
  if (!Array.isArray(quantiles) || quantiles.length < 2) return null;
  const at = (p) => quantiles[Math.round(p * (quantiles.length - 1))];
  return { p01: at(0.01), p05: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), p99: at(0.99) };
}
