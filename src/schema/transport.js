// A SCHEMA AS IT LEAVES THE SERVER — written with every vocabulary spelled out where it is accepted, and
// folded here before it is sent: identical subtrees become one `$defs` entry the sites point at.
// Validation is unchanged (ajv resolves the ref); the client is handed each list once.

/** A tool schema as it leaves the process: repeated vocabularies and subtrees folded into `$defs`
 *  (the core's tools here, a feature's in the engine that registers it). */
export function transportSchema(schema) {
  return foldRepeats(foldVocabularies(schema));
}

/**
 * THE INPUT AS A CLIENT SEES IT: every tool takes ONE field, `request`, and what the tool's own schema
 * describes is its value. The root is a plain closed object with one required field — the one shape
 * every host's API takes at a tool's root (a union there is refused: Anthropic's API rejects the
 * whole request) — and the tool's forms, its `anyOf`, sit one level down, where every API takes them.
 * The `$defs` stay at the root, so every `#/$defs/…` inside still resolves. The surface unwraps the
 * call at one point (src/mcp-surface.js runTool): the engine validates and runs `request` against the
 * same schema it built, so what a client is shown and what is checked are one schema.
 */
export function wireSchema(schema) {
  const { $defs, ...request } = schema;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['request'],
    properties: { request },
    ...($defs ? { $defs } : {}),
  };
}

/**
 * Fold IDENTICAL subtrees of one schema into `#/$defs` and point every occurrence at the one copy.
 * Purely a transport saving: the folded node carries its own description, so nothing a reader sees
 * is lost, and ajv validates through the ref exactly as it did inline.
 *
 * Only SCHEMA POSITIONS are folded — the value of a `properties` entry, a branch of a union, an
 * `items`. A raw array (an `enum`'s values, a `required` list) is never replaced: `$ref` is a
 * schema, and `enum: { $ref }` is not a schema at all. The saving on a vocabulary comes from
 * folding the little object that CARRIES the enum, which is what repeats anyway.
 *
 * Largest repetition first, so a big list is extracted before the structures that contain it.
 */
export const MIN_FOLD = 100;

export const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];

export const SCHEMA_LISTS = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];

export const SCHEMA_KEYS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'];

/**
 * Fold a repeated VOCABULARY — the same `enum` list offered at several sites under different
 * descriptions (a source's payload properties are the { property } leaf of a pipeline's and a
 * semantic model's expressions, and a dimension's `property`). The values move to one `$defs` entry and each site keeps its own
 * sentence: `{ $ref, description }`. On the production catalog one such list is ~5 KB and appears
 * three times per tool, in two tools.
 *
 * Only a node that is NOTHING BUT a typed vocabulary is folded (type/enum/description/title), so
 * no other constraint can be lost on the way into the ref.
 */
export const VOCAB_KEYS = new Set(['type', 'enum', 'description', 'title']);

export function foldVocabularies(schema, { minSize = MIN_FOLD } = {}) {
  const counts = new Map();
  const keyOf = (n) => (n.enum && Object.keys(n).every((k) => VOCAB_KEYS.has(k)) ? JSON.stringify([n.type || null, n.enum]) : null);
  eachSchema(schema, (n) => { const k = keyOf(n); if (k && k.length >= minSize) counts.set(k, (counts.get(k) || 0) + 1); });
  const shared = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (!shared.length) return schema;
  const $defs = { ...(schema.$defs || {}) };
  const names = new Map();
  for (const k of shared) {
    const [type, values] = JSON.parse(k);
    const name = defName({ enum: values }, Object.keys($defs), sitesOf(schema, (n) => keyOf(n) === k));
    $defs[name] = { ...(type ? { type } : {}), enum: values };
    names.set(k, name);
  }
  const fold = (n) => {
    const k = keyOf(n);
    const name = k && names.get(k);
    return name ? { $ref: `#/$defs/${name}`, ...(n.description ? { description: n.description } : {}) } : n;
  };
  return { ...mapSchemas(schema, (n) => (n === schema ? n : fold(n))), $defs: Object.fromEntries(Object.entries($defs).map(([k, v]) => [k, v.enum ? v : mapSchemas(v, fold)])) };
}

export function foldRepeats(schema, { minSize = MIN_FOLD, maxDefs = 40 } = {}) {
  let out = schema;
  for (let i = 0; i < maxDefs; i += 1) {
    const counts = new Map();
    eachSchema(out, (n) => { const j = JSON.stringify(n); if (j.length >= minSize) counts.set(j, (counts.get(j) || 0) + 1); });
    let best = null;
    for (const [json, n] of counts) {
      if (n < 2) continue;
      const waste = (n - 1) * json.length;
      if (!best || waste > best.waste) best = { json, waste };
    }
    if (!best) break;
    const def = JSON.parse(best.json);
    const key = defName(def, Object.keys(out.$defs || {}), sitesOf(out, (n) => JSON.stringify(n) === best.json));
    const ref = { $ref: `#/$defs/${key}` };
    const fold = (n) => (JSON.stringify(n) === best.json ? ref : n);
    const $defs = Object.fromEntries(Object.entries(out.$defs || {}).map(([k, v]) => [k, mapSchemas(v, fold)]));
    out = { ...mapSchemas(out, (n) => (n === out ? n : fold(n))), $defs: { ...$defs, [key]: def } };
  }
  return out;
}

/** Visit every schema-position node of a document, the root included. */
export function eachSchema(node, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  visit(node);
  for (const k of SCHEMA_MAPS) if (node[k] && typeof node[k] === 'object') for (const v of Object.values(node[k])) eachSchema(v, visit);
  for (const k of SCHEMA_LISTS) if (Array.isArray(node[k])) for (const v of node[k]) eachSchema(v, visit);
  for (const k of SCHEMA_KEYS) if (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) eachSchema(node[k], visit);
}

/** The same traversal, rebuilding the document: `fn` may return a replacement for a node. */
export function mapSchemas(node, fn) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const replaced = fn(node);
  if (replaced !== node) return replaced;
  const out = { ...node };
  for (const k of SCHEMA_MAPS) if (out[k] && typeof out[k] === 'object') out[k] = Object.fromEntries(Object.entries(out[k]).map(([kk, v]) => [kk, mapSchemas(v, fn)]));
  for (const k of SCHEMA_LISTS) if (Array.isArray(out[k])) out[k] = out[k].map((v) => mapSchemas(v, fn));
  for (const k of SCHEMA_KEYS) if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = mapSchemas(out[k], fn);
  return out;
}

/**
 * Where a folded subtree sits: for each site, the field it is the value of (an `items` site is named
 * after its list, `<list>_item`) and, where the object holding it pins its `source`, that source.
 */
export function sitesOf(root, matches) {
  const sites = [];
  const walk = (node, key, holder) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (key && matches(node)) {
      const src = holder?.properties?.source;
      sites.push({ key, source: src?.const ?? (src?.enum?.length === 1 ? src.enum[0] : null) });
      return;
    }
    for (const k of SCHEMA_MAPS) if (node[k] && typeof node[k] === 'object') for (const [kk, v] of Object.entries(node[k])) walk(v, k === 'properties' ? kk : null, k === 'properties' ? node : null);
    for (const k of SCHEMA_LISTS) if (Array.isArray(node[k])) for (const v of node[k]) walk(v, key && `${key}_form`, holder);
    for (const k of SCHEMA_KEYS) if (node[k] && typeof node[k] === 'object' && !Array.isArray(node[k])) walk(node[k], k === 'items' && key ? `${key}_item` : null, null);
  };
  walk(root, null, null);
  return sites;
}

/**
 * A readable name for a folded definition — what it IS, not `shared_3`: its title; else the one field
 * every site is the value of (`context_id`, `users_column` where the holder pins its source); else the
 * vocabulary it pins, the stage it describes, or its first field.
 */
export function defName(node, taken, sites = []) {
  const keys = [...new Set(sites.map((x) => x.key).filter(Boolean))];
  const sources = [...new Set(sites.map((x) => x.source))];
  const bySite = keys.length === 1 ? `${sources.length === 1 && sources[0] ? `${sources[0]}_` : ''}${keys[0]}` : null;
  const titled = typeof node.title === 'string' && node.title.length <= 40 ? node.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : null;
  // an object by the fields it requires ({ name, expr } → name_expr), a union by what its branches are
  const fieldsOf = (n) => (n.required?.length ? n.required : Object.keys(n.properties || {}).slice(0, 1)).slice(0, 3).join('_');
  const branchName = (b) => (typeof b?.title === 'string' ? b.title : b?.properties ? fieldsOf(b) : b?.$ref ? String(b.$ref).split('/').pop() : b?.type || '');
  const branches = node.oneOf || node.anyOf;
  const base = titled || bySite || (node.enum?.length ? `enum_${node.enum[0]}`
    : node.properties?.stage?.enum?.[0] ? `stage_${node.properties.stage.enum[0]}`
      : node.items?.$ref ? `list_${String(node.items.$ref).split('/').pop()}`
        : node.properties ? fieldsOf(node)
          : branches ? branches.slice(0, 3).map(branchName).filter(Boolean).map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')).join('_or_') || 'one_of'
            : 'shared');
  const key = String(base).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48);
  let name = key; let n = 2;
  while (taken.includes(name)) { name = `${key}_${n}`; n += 1; }
  return name;
}
