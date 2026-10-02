// ajv-backed validation of tool inputs against the catalog-derived JSON Schemas.

// JSON Schema 2020-12 — the dialect MCP defines for a tool schema without `$schema` (the default
// since 2025-11-25, and what a client validating our schemas uses). The draft-07 validator reads a
// few things differently (siblings of `$ref` are ignored there), so validating in another dialect
// than the client's is how the two could disagree about the same argument.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isPlainObject } from './engine/helpers.js';
import { rankFuzzy } from './fuzzy.js';

export function makeValidators(schemas) {
  // verbose:true attaches the failing SCHEMA NODES to each error (`schema`, `parentSchema`). The
  // refusals are built from those nodes — a union's branch titles, the sibling field names behind
  // "here that field is called 'q'" — and since the schemas fold repeated subtrees into `$defs`,
  // ajv's schemaPath is relative to the folded subschema, not to the tool root. The nodes are
  // unambiguous where a pointer would have to guess its base.
  const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
  addFormats(ajv);
  const validators = {};
  for (const [tool, schema] of Object.entries(schemas)) {
    validators[tool] = ajv.compile(schema);
  }
  return validators;
}

/**
 * ONE VOCABULARY, AND THE SPELLINGS A CALLER BRINGS FROM ELSEWHERE. Every path aggregates with
 * `agg`, the mean is `average`, a quantile is `percentile` and the name a step produces is `name`;
 * a caller used to SQL or another tool writes `avg`, `q`, `fn`, `as` — and the refusal says what
 * this server calls it, when that name is allowed where it was written.
 */
export const CROSS_PATH_SPELLING = {
  avg: 'average',
  mean: 'average',
  q: 'percentile',
  quantile: 'percentile',
  fn: 'agg',
  as: 'name',
  alias: 'name',
};

/** What this path calls `used`, when it has a name for it at all. */
function otherSpelling(used, allowed) {
  if (typeof used !== 'string') return null;
  const alt = CROSS_PATH_SPELLING[used];
  if (!alt) return null;
  return allowed.includes(alt) ? alt : null;
}

/** Read the value the error is about out of the input (ajv reports the path, not the value). */
function valueAt(input, instancePath) {
  let node = input;
  for (const seg of String(instancePath || '').split('/').filter(Boolean)) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/** Human path: '/control/conversions' → '`control.conversions`'; '' → 'request' (the call's one field, whose content every path is relative to). */
function fieldRef(instancePath) {
  if (!instancePath) return 'request';
  return `\`${instancePath.replace(/^\//, '').replace(/\//g, '.')}\``;
}

/**
 * "must be one of" — and, for a string that is a near miss, the nearest values first (a misspelt
 * column or attribute names what was meant, even when the list is long and its first values are not
 * it). A long list is cut: the schema is exact, the message names enough to act on.
 */
function oneOf(at, vals, used, alt) {
  const near = typeof used === 'string' && !alt ? rankFuzzy(used, vals.map(String), { fields: (v) => [v], limit: 3 }).map((r) => r.item) : [];
  return `${at} must be one of: ${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`
    + (near.length ? `. Did you mean ${near.map((v) => `'${v}'`).join(' or ')}?` : '')
    + (alt ? `. Here '${used}' is spelled '${alt}'` : '');
}

/**
 * What a missing field takes, when the schema names its values — an enum, or a list of objects whose
 * key field is one: the refusal then lists them (a join's attrs: the joined model's columns), so the
 * caller can write the field without another round trip. Nothing is said for a free-form field.
 */
function takesValues(prop, root) {
  const list = (vals) => `${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`;
  if (Array.isArray(prop?.enum) && prop.enum.length > 1) return ` — one of: ${list(prop.enum)}`;
  const item = deref(root, prop?.items);
  if (!item?.properties) return '';
  const [key, of] = Object.entries(item.properties).map(([k, v]) => [k, deref(root, v)]).find(([, v]) => Array.isArray(v?.enum) && v.enum.length > 1) || [];
  return key ? ` — a list of { ${key}${(item.required || []).filter((r) => r !== key).map((r) => `, ${r}`).join('')}, … }, ${key} one of: ${list(of.enum)}` : '';
}

/** Turn one Ajv error into a plain-English sentence. `ctx` = { input, schema } for the hints. */
function describe(e, ctx = {}) {
  const at = fieldRef(e.instancePath);
  switch (e.keyword) {
    case 'required': {
      const field = e.params.missingProperty;
      const node = deref(ctx.schema, e.parentSchema);
      return `${at} is missing required property '${field}'${takesValues(deref(ctx.schema, node?.properties?.[field]), ctx.schema)}`;
    }
    case 'additionalProperties': {
      const used = e.params.additionalProperty;
      // A field this path spells differently: say its name here rather than only that it is unknown.
      const node = deref(ctx.schema, e.parentSchema) || (ctx.schema ? atPointer(ctx.schema, e.schemaPath.replace(/\/additionalProperties$/, '')) : null);
      const alt = otherSpelling(used, Object.keys(node?.properties || {}));
      // a form of a union names what it takes: the field is not one of them (src/schema-kit.js form)
      const fields = Object.keys(node?.properties || {});
      const takes = node?.title && node.properties ? ` — ${node.title} takes ${fields.length ? fields.join(', ') : 'no fields'}` : '';
      return `${at} has an unexpected property '${used}'${alt ? ` — here that field is called '${alt}'` : takes}`;
    }
    case 'enum': {
      // A long enum is the schema being exact; a long MESSAGE is just noise — name enough to act on.
      const vals = e.params.allowedValues;
      // A ONE-value enum is a pinned value (a discriminator: which stage, which action, which
      // source). "must be one of: python" reads like a list that lost its other items.
      if (vals.length === 1) return `${at} must be ${JSON.stringify(vals[0])}`;
      const used = valueAt(ctx.input, e.instancePath);
      const alt = otherSpelling(used, vals);
      return oneOf(at, vals, used, alt);
    }
    case 'const': return `${at} must be ${JSON.stringify(e.params.allowedValue)}`;
    case 'type': return `${at} must be ${Array.isArray(e.params.type) ? e.params.type.join(' or ') : e.params.type}`;
    case 'minimum': return `${at} must be >= ${e.params.limit}`;
    case 'maximum': return `${at} must be <= ${e.params.limit}`;
    case 'exclusiveMinimum': return `${at} must be > ${e.params.limit}`;
    case 'exclusiveMaximum': return `${at} must be < ${e.params.limit}`;
    case 'minItems': return `${at} must have at least ${e.params.limit} item${e.params.limit === 1 ? '' : 's'}`;
    case 'maxItems': return `${at} must have at most ${e.params.limit} item${e.params.limit === 1 ? '' : 's'}`;
    case 'pinnedNone': {
      const used = valueAt(ctx.input, e.params.at);
      const alt = otherSpelling(used, e.params.values);
      // said as an enum is said (describe, 'enum'): one value is a pinned one, several a list
      const vals = e.params.values;
      if (vals.length === 1) return `${fieldRef(e.params.at)} must be ${JSON.stringify(vals[0])}`;
      return oneOf(fieldRef(e.params.at), vals, used, alt);
    }
    case 'oneOf':
    case 'anyOf': return `${at} must match exactly one of the allowed configurations (provide the fields for exactly one mode)`;
    case 'oneOfNamed': return `${at} must be exactly one of: ${e.params.names.join(' | ')}`;
    case 'requiresOneOf': return `${at} needs at least one of: ${e.params.keys.join(', ')}`;
    case 'unionOfValues': return `${at} must be ${e.params.title || `one of: ${e.params.names.join(' | ')}`}`;
    case 'pattern':
      // SQL's count(*) habit: a row count is the count with no column
      if (e.data === '*' && /column$/.test(e.instancePath)) return `${at}: '*' is not a column — leave \`column\` out to count rows`;
      return `${at} ${e.message}`;
    default: return `${at} ${e.message}`;
  }
}

/**
 * Resolve a `#/a/b` schema pointer against the compiled schema, FOLLOWING `$ref` on the way.
 *
 * The tool schemas fold repeated subtrees into `#/$defs` before they are handed out (a 5 KB
 * vocabulary offered at three sites, the whole stage union offered as both `stage` and `stages`),
 * so ajv's schemaPath now walks through refs. A reader that stopped at the first `{ $ref }` would
 * silently lose what the refusal is built from — the branch titles of a union, the sibling field
 * names behind "here that field is called 'q'" — so it jumps instead. A pointer into the shared
 * `$defs` document a node validator compiles against (DEFS_ID) is read the same way.
 */
function atPointer(schema, pointer, depth = 0) {
  const deref = (node) => (node && typeof node === 'object' && node.$ref && depth < 20 ? atPointer(schema, node.$ref, depth + 1) : node);
  let node = schema;
  for (const seg of String(pointer).replace(DEFS_ID, '').replace(/^#\/?/, '').split('/').filter(Boolean)) {
    node = deref(node);
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) return undefined;
  }
  return deref(node);
}

/** A node as written, or what it points at when the fold replaced it with a `$ref`. */
function deref(root, node) {
  return node && typeof node === 'object' && node.$ref ? atPointer(root, node.$ref) : node;
}

/** What a branch of a union is CALLED, for "expected one of: …". */
function branchTitle(branch, i) {
  return branch?.title || String(branch?.description || `option ${i + 1}`).split(/[:.]/)[0].trim();
}

/** What a branch of a union of VALUES (not of forms) takes, said plainly. */
function valueBranch(b) {
  if (b.title) return b.title;
  if (Array.isArray(b.enum)) return b.enum.length === 1 ? JSON.stringify(b.enum[0]) : `one of ${b.enum.slice(0, 15).join(', ')}${b.enum.length > 15 ? ', …' : ''}`;
  if (b.const !== undefined) return JSON.stringify(b.const);
  const a = (t) => `${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}`;
  if (b.pattern) return `${a(b.type || 'string')} matching ${b.pattern}`;
  return b.type ? a([].concat(b.type).join(' or ')) : 'another value';
}

/** The values each key is pinned to in a branch (its `const` / `enum`), a branch that is itself a union
 *  pinning what any of its forms pins. */
function pinsOf(schema, branch, depth = 0) {
  const b = deref(schema, branch);
  const out = new Map();
  if (!b || typeof b !== 'object' || depth > 4) return out;
  for (const sub of Array.isArray(b.anyOf) ? b.anyOf : []) {
    for (const [k, vs] of pinsOf(schema, sub, depth + 1)) out.set(k, [...(out.get(k) || []), ...vs]);
  }
  for (const [k, p] of Object.entries(b.properties || {})) {
    const n = deref(schema, p);
    const vs = n?.const !== undefined ? [n.const] : Array.isArray(n?.enum) ? n.enum : null;
    if (vs) out.set(k, [...(out.get(k) || []), ...vs]);
  }
  return out;
}

/** Whether a branch requires `key` — in itself, or in every form of it. */
function requires(schema, branch, key) {
  const b = deref(schema, branch);
  if (Array.isArray(b?.anyOf)) return b.anyOf.every((x) => requires(schema, x, key));
  return Array.isArray(b?.required) && b.required.includes(key);
}

// ONE NODE OF A TOOL SCHEMA, VALIDATED ON ITS OWN (a union's refusal reads its branches one by one). Each
// tool schema has an ajv of its own, held only as long as the schema is (a WeakMap on the root — ajv keeps
// everything it compiled, so one module-wide instance kept every engine's schemas for the process's life),
// with the root's `$defs` added ONCE as their own document: a node is compiled with its `#/$defs/…`
// pointed at that document, so a folded subtree is compiled once per tool, not once per node reaching it.
const DEFS_ID = 'https://tool-defs.invalid/schema';
const perRoot = new WeakMap();
function nodeValidator(root, node) {
  let r = perRoot.get(root);
  if (!r) {
    const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    addFormats(ajv);
    if (root.$defs) ajv.addSchema({ $id: DEFS_ID, $defs: root.$defs });
    r = { ajv, nodes: new WeakMap() };
    perRoot.set(root, r);
  }
  let v = r.nodes.get(node);
  if (!v) { v = r.ajv.compile(rebased(node)); r.nodes.set(node, v); }
  return v;
}

/** A node with its local `#/$defs/…` pointers aimed at the shared `$defs` document (and its own `$defs` left there). */
function rebased(node) {
  const walk = (n) => {
    if (Array.isArray(n)) return n.map(walk);
    if (!isPlainObject(n)) return n;
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === '$defs' && n === node) continue;
      out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/') ? `${DEFS_ID}${v}` : walk(v);
    }
    return out;
  };
  return walk(node);
}

const within = (path, base) => path === base || path.startsWith(`${base}/`);

// A union's own keywords beside its branches (a type, a closed object, a minLength), as one node —
// kept per union, so its compiled validator is found again.
const siblingsOf = new WeakMap();
function unionSiblings(n) {
  if (!siblingsOf.has(n)) {
    const { anyOf: _branches, ...siblings } = n;
    const says = Object.keys(siblings).some((k) => !['description', 'title', 'type', '$defs', 'default'].includes(k));
    siblingsOf.set(n, says ? siblings : null);
  }
  return siblingsOf.get(n);
}

/**
 * WHY A VALUE IS REFUSED, AS THE ERRORS OF WHAT IT MEANT — every union read branch by branch.
 *
 * A union (an `anyOf` of closed forms, src/schema-kit.js) reports every branch's complaints at once,
 * which reads as noise: with a dozen modes the caller gets a dozen "missing required property" lines
 * for modes they never meant. So a union's refusal is the refusal of the branch the value MEANT: where
 * every branch pins one field (an `action`, a `stage`, a `kind`), the value it gave picks the branch —
 * a value no branch takes is refused as that, with the values there are — and where nothing is pinned
 * (or the value left it out), the branch the value came CLOSEST to, with the modes there are said. That
 * branch is validated on its own, so what is reported is its errors and nothing else, and a union
 * inside it is read the same way.
 *
 * Paths in what it returns are relative to the value; `memo` holds each (node, value) explained once in
 * one refusal, so a tree of nested unions (a where tree of and/or groups) costs what its size does, not
 * what every branch tried at every level would.
 */
function explain(root, node, value, memo) {
  const n = deref(root, node);
  let byValue = memo.get(n);
  if (!byValue) { byValue = new Map(); memo.set(n, byValue); }
  if (byValue.has(value)) return byValue.get(value);
  byValue.set(value, []); // a cycle reads as no complaint rather than recursing
  const out = explainNode(root, n, value, memo);
  byValue.set(value, out);
  return out;
}

const under = (at, errors) => errors.map((e) => ({ ...e, instancePath: `${at}${e.instancePath}`, ...(e.params?.at !== undefined ? { params: { ...e.params, at: `${at}${e.params.at}` } } : {}) }));

function explainNode(root, n, value, memo) {
  const v = nodeValidator(root, n);
  if (v(value)) return [];
  const errors = v.errors || [];
  if (!Array.isArray(n.anyOf)) {
    // a union inside this node is read on its own: its errors replace every error under it. Only the
    // OUTERMOST unions are read — one inside another is part of what reading the outer one decides
    // (ajv reports an inner union's errors too, from branches the outer reading may throw away).
    const unions = errors.filter((e) => e.keyword === 'anyOf' && isPlainObject(e.parentSchema));
    const outer = unions.filter((u, i) => !unions.some((o, j) => j !== i && (o.instancePath === u.instancePath ? j > i : within(u.instancePath, o.instancePath))));
    let kept = errors.filter((e) => e.keyword !== 'anyOf');
    for (const u of outer) {
      kept = kept.filter((e) => !within(e.instancePath, u.instancePath));
      kept.push(...under(u.instancePath, explain(root, u.parentSchema, valueAt(value, u.instancePath), memo)));
    }
    return dedupe(kept);
  }
  // the node IS a union: what its own siblings say (a type, a closed object), then its branches
  const siblings = unionSiblings(n);
  const own = siblings ? explain(root, siblings, value, memo) : [];
  const branches = n.anyOf.map((b) => deref(root, b));
  // a value one branch takes fails only on the siblings
  if (branches.some((b) => nodeValidator(root, b)(value))) return own;
  // a union of constraints rather than of forms is said as what it asks for, in one sentence
  if (branches.every((b) => Object.keys(b).length === 1 && Array.isArray(b.required))) {
    return dedupe([...own, { keyword: 'requiresOneOf', instancePath: '', params: { keys: branches.flatMap((b) => b.required) } }]);
  }
  if (branches.every((b) => !b.properties && !b.anyOf && !b.required)) {
    // one branch of the value's own type: its refusal is the one that says what is wrong (a pattern)
    const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
    const typed = branches.filter((b) => !b.type || [].concat(b.type).some((t) => t === kind || (t === 'number' && kind === 'integer')));
    if (typed.length === 1) return dedupe([...own, ...explain(root, typed[0], value, memo)]);
    return dedupe([...own, { keyword: 'unionOfValues', instancePath: '', params: { title: n.title || null, names: branches.map(valueBranch) } }]);
  }
  const pins = branches.map((b) => pinsOf(root, b));
  let candidates = branches.map((_, i) => i);
  let named = false;
  let defaults = null;
  // the fields that tell the branches apart — pinned in every one, to different values — narrow them in
  // turn (an `action`, then a `metric`): the value given picks; left out, the forms that may leave it
  // out are the default ones, preferred on a tie but not assumed — the caller may have forgotten it
  if (isPlainObject(value)) {
    const tried = new Set();
    for (;;) {
      const key = candidates.length > 1 && [...pins[candidates[0]].keys()].find((k) => !tried.has(k)
        && candidates.every((i) => pins[i].has(k))
        && new Set(candidates.map((i) => JSON.stringify([...pins[i].get(k)].sort()))).size > 1);
      if (!key) break;
      tried.add(key);
      if (key in value) {
        const taking = candidates.filter((i) => pins[i].get(key).includes(value[key]));
        if (!taking.length) return [...own, { keyword: 'pinnedNone', instancePath: `/${key}`, params: { at: `/${key}`, values: [...new Set(candidates.flatMap((i) => pins[i].get(key)))] } }];
        candidates = taking;
        named = true;
      } else if (!defaults) {
        const optional = candidates.filter((i) => !requires(root, branches[i], key));
        if (optional.length && optional.length < candidates.length) defaults = new Set(optional);
      }
    }
    // then a field pinned in SOME branches, the others closed without it (an expression's `fn`: the
    // function forms pin it, a column or a constant has no such field): the value given picks too
    for (const key of Object.keys(value)) {
      const taking = candidates.filter((i) => pins[i].has(key) && pins[i].get(key).includes(value[key]));
      const closedWithout = (b) => b.additionalProperties === false && !(b.properties && key in b.properties);
      // …and only when those branches know every field given (a mix of two forms' fields is said as the union)
      // and take what every other pinned field given says (else the fields disagree, and the closest is said)
      const knowsAll = (i) => Object.keys(value).every((k) => branches[i].properties && k in branches[i].properties && (!pins[i].has(k) || pins[i].get(k).includes(value[k])));
      if (taking.length && taking.length < candidates.length && taking.every(knowsAll) && candidates.every((i) => taking.includes(i) || pins[i].has(key) || closedWithout(branches[i]))) {
        candidates = taking;
      }
    }
  }
  // Closest = the branch the value most nearly IS. A field the branch does not know means the caller
  // did not mean this mode at all; `type` is nearly as strong (not even shaped like it); a missing
  // required field means they meant it and left something out; a bad enum/const value means they DID
  // name it and got the value wrong — that is the message worth showing, so it costs least.
  const weight = (e) => ({ additionalProperties: 10, type: 8, required: 6, pinnedNone: 3 }[e.keyword] ?? 1);
  const scored = candidates.map((i) => { const es = explain(root, branches[i], value, memo); return { i, es, score: es.reduce((s, e) => s + weight(e), 0) }; });
  const best = scored.sort((a, b) => a.score - b.score || (defaults ? (defaults.has(b.i) ? 1 : 0) - (defaults.has(a.i) ? 1 : 0) : 0))[0];
  // the modes are named unless the value named its own — or meant the default one, which it need not name
  const label = (named && candidates.length === 1) || defaults?.has(best.i) ? [] : [{ keyword: 'oneOfNamed', instancePath: '', params: { names: [...new Set(candidates.map((i) => branchTitle(branches[i], i)).filter(Boolean))] } }];
  return dedupe([...own, ...label, ...best.es]);
}

function dedupe(errors) {
  const seen = new Set();
  return errors.filter((e) => { const k = `${e.keyword}|${e.instancePath}|${JSON.stringify(e.params)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function validateInput(validator, input) {
  const ok = validator(input);
  if (ok) return { ok: true };
  // every union read as the branch the input meant, each error as a sentence, de-duplicated
  const seen = new Set();
  const errors = [];
  const ctx = { input, schema: validator.schema };
  for (const e of explain(validator.schema, validator.schema, input, new Map())) {
    const msg = describe(e, ctx);
    if (msg && !seen.has(msg)) { seen.add(msg); errors.push(msg); }
  }
  if (errors.length === 0) errors.push('input did not match the expected shape');
  return { ok: false, errors };
}

/** error.code of a result that existed and is no longer there (deleted, expired, forgotten) —
 *  distinct from a query that FAILED, so a reader can say "no longer available" instead of "error". */
export const RESULT_GONE = 'result_gone';

export class ToolError extends Error {
  constructor(message, { stage = 'validate', field, code } = {}) {
    super(message);
    this.name = 'ToolError';
    this.stage = stage;
    this.field = field;
    // a machine-readable kind for a failure a reader acts on differently (e.g. result_gone)
    if (code) this.code = code;
  }
}
