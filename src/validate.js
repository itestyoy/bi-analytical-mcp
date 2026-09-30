// ajv-backed validation of tool inputs against the catalog-derived JSON Schemas.

// JSON Schema 2020-12 — the dialect MCP defines for a tool schema without `$schema` (the default
// since 2025-11-25, and what a client validating our schemas uses). The draft-07 validator reads a
// few things differently (siblings of `$ref` are ignored there), so validating in another dialect
// than the client's is how the two could disagree about the same argument.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
 * THE SAME FUNCTION, TWO SPELLINGS — because there are two engines underneath. A governed measure
 * is MetricFlow's vocabulary (`average`, the quantile in `percentile`, `field: '*'` for rows); a
 * pipeline stage is SQL's (`avg`, the quantile in `q`, `count` with no column at all). Neither
 * spelling is wrong; each is right in its own path, and a caller that learned one hits a flat
 * refusal in the other.
 *
 * So: the vocabularies stay as they are, and the REFUSAL says which spelling this path uses. The
 * table is symmetric (a → b and b → a) and is consulted only when the name the caller used has a
 * counterpart that IS allowed here — otherwise nothing is added.
 */
const CROSS_PATH_SPELLING = {
  average: 'avg',
  avg: 'average',
  mean: 'average',
  percentile: 'q',
  q: 'percentile',
  quantile: 'q',
  count_distinct: 'count_distinct',
};

/** What this path calls `used`, when it has a name for it at all. */
function otherSpelling(used, allowed) {
  if (typeof used !== 'string') return null;
  const alt = CROSS_PATH_SPELLING[used];
  if (!alt || alt === used) return null;
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

/** Turn one Ajv error into a plain-English sentence. `ctx` = { input, schema } for the hints. */
function describe(e, ctx = {}) {
  const at = fieldRef(e.instancePath);
  switch (e.keyword) {
    case 'required': return `${at} is missing required property '${e.params.missingProperty}'`;
    case 'additionalProperties': {
      const used = e.params.additionalProperty;
      // A field this path spells differently: say its name here rather than only that it is unknown.
      const node = deref(ctx.schema, e.parentSchema) || (ctx.schema ? atPointer(ctx.schema, e.schemaPath.replace(/\/additionalProperties$/, '')) : null);
      const alt = otherSpelling(used, Object.keys(node?.properties || {}));
      // a form of a union names what it takes: the field is not one of them (src/schema-kit.js form)
      const fields = Object.keys(node?.properties || {});
      const takes = node?.title && node.properties ? ` — ${node.title} takes ${fields.length ? fields.join(', ') : 'no fields'}` : '';
      return `${at} has an unexpected property '${used}'${alt ? ` — here that field is called '${alt}' (${used} is the other path's spelling)` : takes}`;
    }
    case 'enum': {
      // A long enum is the schema being exact; a long MESSAGE is just noise — name enough to act on.
      const vals = e.params.allowedValues;
      // A ONE-value enum is a pinned value (a discriminator: which stage, which action, which
      // source). "must be one of: python" reads like a list that lost its other items.
      if (vals.length === 1) return `${at} must be ${JSON.stringify(vals[0])}`;
      const used = valueAt(ctx.input, e.instancePath);
      const alt = otherSpelling(used, vals);
      return `${at} must be one of: ${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`
        + (alt ? `. Here '${used}' is spelled '${alt}' — '${used}' is the other path's spelling of the same function` : '');
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
      return `${fieldRef(e.params.at)} must be one of: ${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`
        + (alt ? `. Here '${used}' is spelled '${alt}' — '${used}' is the other path's spelling of the same function` : '');
    }
    case 'oneOf':
    case 'anyOf': return `${at} must match exactly one of the allowed configurations (provide the fields for exactly one mode)`;
    case 'oneOfNamed': return `${at} must be exactly one of: ${e.params.names.join(' | ')}`;
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
 * names behind "here that field is called 'q'" — so it jumps instead.
 */
function atPointer(schema, pointer, depth = 0) {
  const deref = (node) => (node && typeof node === 'object' && node.$ref && depth < 20 ? atPointer(schema, node.$ref, depth + 1) : node);
  let node = schema;
  for (const seg of String(pointer).replace(/^#\/?/, '').split('/').filter(Boolean)) {
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

// One node of a tool schema, validated on its own (the refusal of a union reads its branches one by
// one): compiled with the tool's `$defs` beside it, so every `#/$defs/…` inside still resolves; once per
// node of a document.
const nodeAjv = new Ajv({ allErrors: true, strict: false, verbose: true });
addFormats(nodeAjv);
const compiledNodes = new WeakMap();
function nodeValidator(root, node) {
  let perRoot = compiledNodes.get(root);
  if (!perRoot) { perRoot = new WeakMap(); compiledNodes.set(root, perRoot); }
  let v = perRoot.get(node);
  if (!v) { v = nodeAjv.compile(root.$defs && !node.$defs ? { ...node, $defs: root.$defs } : node); perRoot.set(node, v); }
  return v;
}

const within = (path, base) => path === base || path.startsWith(`${base}/`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
 * inside it is read the same way. `at` is where the value sits in the call.
 */
function explain(root, node, value, at = '') {
  const n = deref(root, node);
  const v = nodeValidator(root, n);
  if (v(value)) return [];
  const errors = (v.errors || []).map((e) => ({ ...e, instancePath: `${at}${e.instancePath}` }));
  if (!Array.isArray(n.anyOf)) {
    // a union inside this node is read on its own: its errors replace every error under it
    const unions = errors.filter((e) => e.keyword === 'anyOf' && isObject(e.parentSchema));
    let kept = errors.filter((e) => e.keyword !== 'anyOf');
    for (const u of unions) {
      kept = kept.filter((e) => !within(e.instancePath, u.instancePath));
      kept.push(...explain(root, u.parentSchema, valueAt(value, u.instancePath.slice(at.length)), u.instancePath));
    }
    return dedupe(kept);
  }
  // the node IS a union: what its own siblings say (a type, a closed object), then its branches
  const { anyOf: branchNodes, ...siblings } = n;
  const own = Object.keys(siblings).some((k) => !['description', 'title', 'type', '$defs', 'default'].includes(k)) ? explainSiblings(root, siblings, value, at) : [];
  const branches = branchNodes.map((b) => deref(root, b));
  const pins = branches.map((b) => pinsOf(root, b));
  let candidates = branches.map((_, i) => i);
  let named = false;
  // the fields that tell the branches apart — pinned in every one, to different values — narrow them in
  // turn (an `action`, then a `metric`): the value given picks, or its absence picks the branches that
  // may leave the field out
  if (isObject(value)) {
    const tried = new Set();
    for (;;) {
      const key = candidates.length > 1 && [...pins[candidates[0]].keys()].find((k) => !tried.has(k)
        && candidates.every((i) => pins[i].has(k))
        && new Set(candidates.map((i) => JSON.stringify([...pins[i].get(k)].sort()))).size > 1);
      if (!key) break;
      tried.add(key);
      if (key in value) {
        const taking = candidates.filter((i) => pins[i].get(key).includes(value[key]));
        if (!taking.length) return [...own, { keyword: 'pinnedNone', instancePath: `${at}/${key}`, params: { at: `${at}/${key}`, values: [...new Set(candidates.flatMap((i) => pins[i].get(key)))] } }];
        candidates = taking;
        named = true;
      } else {
        const optional = candidates.filter((i) => !requires(root, branches[i], key));
        if (optional.length && optional.length < candidates.length) { candidates = optional; named = true; }
      }
    }
  }
  // Closest = the branch the value most nearly IS. A field the branch does not know means the caller
  // did not mean this mode at all; `type` is nearly as strong (not even shaped like it); a missing
  // required field means they meant it and left something out; a bad enum/const value means they DID
  // name it and got the value wrong — that is the message worth showing, so it costs least.
  const weight = (e) => ({ additionalProperties: 10, type: 8, required: 6, pinnedNone: 3 }[e.keyword] ?? 1);
  const scored = candidates.map((i) => { const es = explain(root, branches[i], value, at); return { i, es, score: es.reduce((s, e) => s + weight(e), 0) }; });
  const best = scored.sort((a, b) => a.score - b.score)[0];
  const label = named && candidates.length === 1 ? [] : [{ keyword: 'oneOfNamed', instancePath: at, params: { names: [...new Set(candidates.map((i) => branchTitle(branches[i], i)).filter(Boolean))] } }];
  return dedupe([...own, ...label, ...best.es]);
}

/** What a union's own keywords (beside its branches) say about a value. */
function explainSiblings(root, siblings, value, at) {
  return explain(root, siblings, value, at);
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
  for (const e of explain(validator.schema, validator.schema, input)) {
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
