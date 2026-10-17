// ajv-backed validation of tool inputs against the catalog-derived JSON Schemas.

// JSON Schema 2020-12 — the dialect MCP defines for a tool schema without `$schema` (the default
// since 2025-11-25, and what a client validating our schemas uses). The draft-07 validator reads a
// few things differently (siblings of `$ref` are ignored there), so validating in another dialect
// than the client's is how the two could disagree about the same argument.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isPlainObject } from './engine/helpers.js';
import { rankFuzzy } from './fuzzy.js';
import { PATTERN_SAYS } from './schema/names.js';

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
 * ONE VOCABULARY, AND THE SPELLINGS A CALLER BRINGS FROM ELSEWHERE. An aggregation is a function
 * (`fn`), the mean is `average`, a quantile is `percentile`, the name a step produces is `name`, a
 * context is `context_id`, a list of measures is `measures`, what a note is about is `about`, a
 * substring filter is `search`, a time window `time_range`, and a list a tool runs in order `steps`
 * (one of them `step`; each item tagged by what it is — a SQL stage by `stage`); a caller used to SQL or
 * another tool (or to an earlier version of this one) writes `avg`, `q`, `agg`, `as`, `draft_id`,
 * `aggregations`, `targets`, `text`, `since`, `stages` — or a stage's earlier field: a limit's `n`, a
 * sample's `percent`, unpivot's `name_as` / `value_as`, a funnel's `mode` —
 * and the refusal says what this server calls it, when that name is allowed where it was written.
 * A hint, never an alias: the other spelling is refused.
 */
export const CROSS_PATH_SPELLING = {
  avg: 'average',
  mean: 'average',
  q: 'percentile',
  quantile: 'percentile',
  agg: 'fn',
  as: 'name',
  alias: 'name',
  explain: 'dry_run',
  draft_id: 'context_id',
  aggregations: 'measures',
  // a metric kind of another layer: a ratio of two metrics is a derived metric dividing one by the other
  ratio: 'derived',
  // what a note is about, a substring filter, a time window, a catalog model on its own (hinted only
  // where `source` takes the model named: HINT_WHERE_VALUE_TAKEN)
  targets: 'about',
  text: 'search',
  since: 'time_range',
  until: 'time_range',
  model: 'source',
  // a model's column, which semantic_index's views and what a note is about once named a property as an
  // event's payload is named (hinted only where `column` takes the name: HINT_WHERE_VALUE_TAKEN)
  property: 'column',
  // the list a tool runs in order, and one of its items — hinted only where the field it became is
  // taken, so a stage's own `stage` tag (its kind, in a form with no `step`) is never touched
  stages: 'steps',
  stage: 'step',
  // a stage's earlier field, hinted only in the stage that has the field it became (a form with a
  // `mode` of its own — a frame, a drill — takes it as written)
  n: 'limit',
  percent: 'share',
  name_as: 'name_column',
  value_as: 'value_column',
  mode: 'between_steps',
};

/** What a value spelled another tool's way needs besides its name here. */
const SPELLING_NOTE = {
  ratio: 'a derived metric has no numerator / denominator: its expr divides one metric by the other, { fn: "div", args: [{ metric: <numerator> }, { metric: <denominator> }] }',
};

/** A query's fields that are said in its steps — where each goes, for a request that wrote it beside them. */
const STEP_FIELDS = {
  metrics: 'a query names its metrics in a step: steps: [{ stage: "metrics", metrics: [...], group_by: [...] }]',
  group_by: 'what the metrics are grouped by goes in the metrics step: steps: [{ stage: "metrics", metrics, group_by: [...] }]',
  where: 'a filter is a where step: steps: [{ stage: "where", conditions: [...] }, { stage: "metrics", … }] — before the metrics step it filters the rows, after it the result',
  order_by: 'an order is an order_by step after the metrics step: { stage: "order_by", keys: [{ key, direction }] }',
};

/**
 * A HINT NAMES THE SAME THING, OR NOTHING. A field this server spells one way may still mean another
 * thing in another tool: `source` is a catalog model where a view, a pipeline or a note is about one,
 * and where an error came from (tool | task | startup) in explore_errors. A spelling listed here is
 * hinted only where the field it names takes the value written under it — `model: 'events'` is called
 * `source` where `source` takes 'events', `property: 'country'` is called `column` where `column` takes
 * 'country' (an event property is `property` wherever it is one) — and, having no value to test, never
 * as a value of an enum.
 */
const HINT_WHERE_VALUE_TAKEN = new Set(['model', 'property']);

/** The fields whose value says which form of a union is meant: a function, a stage, a tool's action. */
const DISCRIMINATORS = new Set(['fn', 'stage', 'action']);

/**
 * What this path calls `used`, when it has a name for it at all. `takes(alt)` says whether the field
 * `alt` here takes the value written under `used`; it is asked only for HINT_WHERE_VALUE_TAKEN.
 */
function otherSpelling(used, allowed, takes = null) {
  if (typeof used !== 'string') return null;
  const alt = CROSS_PATH_SPELLING[used];
  if (!alt || !allowed.includes(alt)) return null;
  if (HINT_WHERE_VALUE_TAKEN.has(used) && !takes?.(alt)) return null;
  return alt;
}

/** `takes` for otherSpelling over a form's fields: whether the field `alt` of `node` names `value` among
 *  its own (an enum or a const) — a free name (an expression's `{ column }`) takes any, so a misspelt
 *  event property is not told it is a column. */
function fieldTakes(root, node, value) {
  return (alt) => {
    const field = deref(root, node?.properties?.[alt]);
    return isPlainObject(field) && (Array.isArray(field.enum) || field.const !== undefined) && nodeValidator(root, field)(value);
  };
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
function oneOf(at, vals, used, alt, elsewhere = null) {
  const near = typeof used === 'string' && !alt && !elsewhere ? rankFuzzy(used, vals.map(String), { fields: (v) => [v], limit: 3 }).map((r) => r.item) : [];
  return `${at} must be one of: ${vals.slice(0, 15).join(', ')}${vals.length > 15 ? `, … (${vals.length} in all)` : ''}`
    + (near.length ? `. Did you mean ${near.map((v) => `'${v}'`).join(' or ')}?` : '')
    + (alt ? `. Here '${used}' is spelled '${alt}'${SPELLING_NOTE[used] ? ` — ${SPELLING_NOTE[used]}` : ''}` : '')
    + (elsewhere ? `. '${used}' is not taken here: it stands in ${elsewhere}` : '');
}

/**
 * A VALUE ANOTHER DEFINITION OF THE SCHEMA TAKES. A tool may hold one concept in several definitions, each
 * for the places that take a closed part of it (src/pipeline/compute.js EXPR_KINDS: a semantic measure's
 * ONE aggregate, a derived metric's value): a value refused at a field that a TITLED definition of the
 * same schema pins that field to is said with where it stands — an aggregate in a dimension is a
 * measure's, a sum in a derived metric too — instead of the nearest spellings of what this place takes.
 * A value (`whole`, the object the field is in) that the ARGUMENT of a titled kind takes as written is
 * said as that argument, wrapped in the kind — a row formula written as a measure is what the measure's
 * ONE aggregate folds, not a derived metric's value, though the derived metric pins its function too.
 * → where it stands, or null.
 */
function takenElsewhere(root, key, used, whole) {
  if (typeof used !== 'string') return null;
  // a value the ARGUMENT of a closed kind takes whole (a measure's ONE aggregate folds a value of each
  // row): it stands there — wrapped in that kind — rather than wherever else its function does
  for (const def of Object.values(root?.$defs || {})) {
    const arg = isPlainObject(def) && def.title ? deref(root, deref(root, def.properties?.args)?.items) : null;
    if (isPlainObject(arg) && arg !== def && isPlainObject(whole) && nodeValidator(root, arg)(whole)) {
      // a formula OVER the kind's own functions (a ratio of two sums) is no argument of one of them —
      // wrapped, it would fold the per-row ratio instead: it is one measure per aggregate, and a
      // derived metric over them
      const own = new Set((def.anyOf || [def]).flatMap((b) => pinsOf(root, b).get(key) || []));
      const inner = JSON.stringify(whole.args ?? []);
      if (own.size && [...own].some((f) => inner.includes(`"${key}":"${f}"`))) return `a derived metric over one measure per aggregate (each { name, expr: { fn: <aggregate>, args } }) — { type: "derived", expr: { fn: "${used}", args: [{ metric: <one> }, { metric: <other> }] } }; inside one aggregate it would fold the value of each row instead`;
      return `the argument of ${def.title}: { fn: <one of them>, args: [{ ${key}: "${used}", … }] }`;
    }
  }
  for (const def of Object.values(root?.$defs || {})) {
    if (!isPlainObject(def) || !def.title || !Array.isArray(def.anyOf)) continue;
    if (def.anyOf.some((b) => (pinsOf(root, b).get(key) || []).includes(used))) return def.title;
  }
  return null;
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
      const alt = otherSpelling(used, Object.keys(node?.properties || {}), ctx.schema && fieldTakes(ctx.schema, node, valueAt(ctx.input, e.instancePath)?.[used]));
      // a form of a union names what it takes: the field is not one of them (src/schema-kit.js form)
      const fields = Object.keys(node?.properties || {});
      const takes = node?.title && node.properties ? ` — ${node.title} takes ${fields.length ? fields.join(', ') : 'no fields'}` : '';
      // what a metric query said beside its steps is said IN them: a field of a step, not of the request
      const inStep = !alt && node?.properties?.steps ? STEP_FIELDS[used] : null;
      return `${at} has an unexpected property '${used}'${alt ? ` — here that field is called '${alt}'` : inStep ? ` — ${inStep}` : takes}`;
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
    case 'type': {
      // an object the schema spells out is said with its fields — the ones it needs first — rather than
      // only "object", which leaves the caller to dig for its shape
      const node = deref(ctx.schema, e.parentSchema) || (ctx.schema ? atPointer(ctx.schema, e.schemaPath.replace(/\/type$/, '')) : null);
      const want = Array.isArray(e.params.type) ? e.params.type.join(' or ') : e.params.type;
      if (want === 'object' && node?.properties) {
        const req = node.required || [];
        const fields = [...req, ...Object.keys(node.properties).filter((k) => !req.includes(k)).map((k) => `${k}?`)];
        return `${at} must be an object { ${fields.join(', ')} }`;
      }
      return `${at} must be ${want}`;
    }
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
      const path = String(e.params.at);
      return oneOf(fieldRef(path), vals, used, alt, alt ? null : takenElsewhere(ctx.schema, path.split('/').pop(), used, valueAt(ctx.input, path.slice(0, path.lastIndexOf('/')))));
    }
    case 'oneOf':
    case 'anyOf': return `${at} must match exactly one of the allowed configurations (provide the fields for exactly one mode)`;
    case 'oneOfNamed': return `${at} must be exactly one of: ${e.params.names.join(' | ')}`;
    case 'requiresOneOf': return `${at} needs at least one of: ${e.params.keys.join(', ')}`;
    case 'unionOfValues': return `${at} must be ${e.params.title || `one of: ${e.params.names.join(' | ')}`}`;
    case 'pattern': return PATTERN_SAYS[e.params.pattern] ? `${at} must be ${PATTERN_SAYS[e.params.pattern]}` : `${at} ${e.message}`;
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

/** A path and every path it lies within, itself first and the root last: '/a/b' → ['/a/b', '/a', '']. */
function prefixes(path) {
  const out = [path];
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) out.push(path.slice(0, i));
  if (path) out.push('');
  return out;
}

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

/** How many forms a union may have before its refusal names only those the value came closest to. */
const LONG_UNION = 8;

function explainNode(root, n, value, memo) {
  const v = nodeValidator(root, n);
  if (v(value)) return [];
  const errors = v.errors || [];
  if (!Array.isArray(n.anyOf)) {
    // a union inside this node is read on its own: its errors replace every error under it. Only the
    // OUTERMOST unions are read — one inside another is part of what reading the outer one decides
    // (ajv reports an inner union's errors too, from branches the outer reading may throw away).
    // Found by walking each path's own prefixes, not by comparing every union with every other: a deep
    // expression tree reports a union at each of its nodes, and pairwise that is quadratic in its size.
    // Of several unions reported at one path the last is read (the outermost schema node reports last).
    const unions = errors.filter((e) => e.keyword === 'anyOf' && isPlainObject(e.parentSchema));
    const lastAt = new Map();
    unions.forEach((u, i) => lastAt.set(u.instancePath, i));
    const outer = unions.filter((u, i) => lastAt.get(u.instancePath) === i && !prefixes(u.instancePath).slice(1).some((p) => lastAt.has(p)));
    const outerAt = new Set(outer.map((u) => u.instancePath));
    const kept = errors.filter((e) => e.keyword !== 'anyOf' && !prefixes(e.instancePath).some((p) => outerAt.has(p)));
    for (const u of outer) kept.push(...under(u.instancePath, explain(root, u.parentSchema, valueAt(value, u.instancePath), memo)));
    return dedupe(kept);
  }
  // the node IS a union: what its own siblings say (a type, a closed object), then its branches
  const siblings = unionSiblings(n);
  const own = siblings ? explain(root, siblings, value, memo) : [];
  const branches = n.anyOf.map((b) => deref(root, b));
  // a value one branch takes fails only on the siblings. The union's own validation said already whether
  // a branch takes it (its anyOf refused, or not): the branches are asked again only where one does —
  // over a deep value (an and / or tree) every branch asked validates all of it
  const noneTakes = errors.some((e) => e.keyword === 'anyOf' && e.instancePath === '' && e.schemaPath === '#/anyOf');
  if (!noneTakes && branches.some((b) => nodeValidator(root, b)(value))) return own;
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
  // A field the value spells as another path does (CROSS_PATH_SPELLING — `model` where this form says
  // `source`) stands for the field it names here: it is no unknown field of the form, and the field it
  // stands for is not missing from it — the refusal says the name instead (describe, additionalProperties).
  // (once per branch: it is asked for every field given of every candidate, and a field it tests validates)
  const respelledOf = new Map();
  const respelled = (b) => {
    if (respelledOf.has(b)) return respelledOf.get(b);
    const fields = Object.keys(b?.properties || {});
    const out = new Map();
    if (isPlainObject(value)) for (const k of Object.keys(value)) { const alt = !fields.includes(k) && otherSpelling(k, fields, fieldTakes(root, b, value[k])); if (alt) out.set(k, alt); }
    respelledOf.set(b, out);
    return out;
  };
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
    // function forms pin it, a column or a constant has no such field): the value given picks too — and
    // a value none of them takes is refused as that, with the values there are (an unknown function). A
    // form that takes the field under its own name (respelled: a users `column` for a `property`) is not
    // closed without it.
    for (const key of Object.keys(value)) {
      const taking = candidates.filter((i) => pins[i].has(key) && pins[i].get(key).includes(value[key]));
      const closedWithout = (b) => b.additionalProperties === false && !(b.properties && key in b.properties) && !respelled(b).has(key);
      // (of the forms that take every OTHER pinned value given: a { source: 'users', property } names
      // the users form, whose properties are the ones to list — not every source's)
      const pinning = candidates.filter((i) => pins[i].has(key) && Object.keys(value).every((k) => k === key || !pins[i].has(k) || pins[i].get(k).includes(value[k])));
      // a tag of SEVERAL forms only: a field one form alone has (an enum of that form) is that form's
      // field, and its refusal is that form's — its label, its missing fields, its type
      if (!taking.length && pinning.length > 1 && candidates.every((i) => pins[i].has(key) || closedWithout(branches[i]))) {
        return [...own, { keyword: 'pinnedNone', instancePath: `/${key}`, params: { at: `/${key}`, values: [...new Set(pinning.flatMap((i) => pins[i].get(key)))] } }];
      }
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
  // A field this form takes under another name, with a value the field takes, is the nearest miss of
  // all: the caller named this form's field as another path spells it (respelled, above).
  const weight = (e) => ({ additionalProperties: 10, type: 8, required: 6, pinnedNone: 3 }[e.keyword] ?? 1);
  const weighed = (alts) => (e) => (e.keyword === 'additionalProperties' && e.instancePath === '' && alts.has(e.params.additionalProperty) ? 0.5 : weight(e));
  // How far a form is from the value, field by field, in three steps. Furthest: a field it lacks that
  // another form REQUIRES — the field that names another mode (an `event`, a `bundle`), so the value
  // meant that mode. Then: a field it pins to ONE value (its tag — the source a { source, property }
  // form is of) that the value gives otherwise — the caller named another form. Closest: a field it
  // lacks that no form requires, a modifier written where it does not apply — so a stray field beside
  // a users property is that form's stray field, not a reason to say "`source` must be events" of a
  // form that knows every field given. A pin of several values is a vocabulary, not a tag: a name it
  // does not hold is a misspelling inside the form meant, and costs what a bad value costs (below).
  // A discriminator (DISCRIMINATORS: the function, the stage, the action) names the form even where its
  // pin holds several values: a value some form takes there means that form, so a form that does not
  // take it is another form — a `cast` with a misnamed parameter is the cast form missing `type`, not a
  // floor form whose `fn` is wrong; and a field only such another form requires names no mode (a
  // date_trunc given a `unit` meant date_trunc, not date_diff, whose `unit` it is).
  const takenBySome = (k) => DISCRIMINATORS.has(k) && candidates.some((j) => pins[j].get(k)?.includes(value[k]));
  const meansForm = (j) => Object.keys(value).every((k) => !takenBySome(k) || !pins[j].has(k) || pins[j].get(k).includes(value[k]));
  const identifying = new Set(isPlainObject(value) ? Object.keys(value).filter((k) => candidates.some((j) => meansForm(j) && requires(root, branches[j], k))) : []);
  const mismatched = (i) => (isPlainObject(value) ? Object.keys(value).filter((k) => { const p = pins[i].get(k); return p && !p.includes(value[k]) && (new Set(p).size === 1 || takenBySome(k)); }).length : 0);
  // These, the value's own fields, decide before whatever lies deeper inside the fields a form knows — a
  // list of views with one bad item is still the { views } form, not the empty one that knows no
  // `views` (errors under a field would otherwise outweigh the field).
  const read = (i, strays) => ({ i, lacksMode: strays.filter((k) => identifying.has(k)).length, mismatched: mismatched(i), unknown: strays.length });
  const scoreOf = (i) => {
    const alts = respelled(branches[i]);
    const standsFor = new Set(alts.values());
    const es = explain(root, branches[i], value, memo).filter((e) => !(e.keyword === 'required' && e.instancePath === '' && standsFor.has(e.params.missingProperty)));
    const strays = es.filter((e) => e.keyword === 'additionalProperties' && e.instancePath === '' && !alts.has(e.params.additionalProperty)).map((e) => e.params.additionalProperty);
    return { ...read(i, strays), es, score: es.reduce((s, e) => s + weighed(alts)(e), 0) };
  };
  // A closed form's strays are its own fields' business — the fields given it does not know — so those
  // three are read off the form, and only the forms that tie on them are validated for their score (of
  // a long union, a leaf with a stray field at every level of a deep tree would otherwise validate every
  // form at each); a form that is a union of its own says its strays through its own reading.
  const strayOf = (i) => {
    const b = branches[i];
    if (Array.isArray(b.anyOf)) return null;
    if (!isPlainObject(value) || b.additionalProperties !== false) return [];
    const alts = respelled(b);
    return Object.keys(value).filter((k) => !(b.properties && k in b.properties) && !alts.has(k));
  };
  const byShape = (a, b) => a.lacksMode - b.lacksMode || a.mismatched - b.mismatched || a.unknown - b.unknown;
  const shaped = candidates.map((i) => { const strays = strayOf(i); return strays ? read(i, strays) : scoreOf(i); });
  const closest = shaped.reduce((m, x) => (byShape(x, m) < 0 ? x : m));
  const scored = shaped.filter((x) => byShape(x, closest) === 0).map((x) => (x.es ? x : scoreOf(x.i)));
  const best = scored.sort((a, b) => a.lacksMode - b.lacksMode || a.mismatched - b.mismatched || a.unknown - b.unknown || a.score - b.score || (defaults ? (defaults.has(b.i) ? 1 : 0) - (defaults.has(a.i) ? 1 : 0) : 0))[0];
  // the modes are named unless the value named its own — or meant the default one, which it need not name;
  // a value that gives a pinned field (an expression's `fn`) is told the forms that take what it gave
  // — or, where nothing given is pinned, the forms that know every field it gave; and of a long union
  // (an expression's dozens of forms) the ones it came as close to as the closest. A field given that
  // none of those knows names a form too (a `guide` beside a `source`), so the forms that take it are
  // said with them: the caller mixed two forms, and both are what it may have meant. Where no form takes
  // every pinned value given, the forms whose TAGS take it (a field pinned to one value: the source a
  // { source, column } form is of) are the ones meant — a name its vocabulary lacks is a misspelling there.
  const knows = (i, k) => !!branches[i].properties && k in branches[i].properties;
  const agree = (pinned) => (isPlainObject(value) ? candidates.filter((i) => Object.keys(value).some((k) => pinned(i, k)) && Object.keys(value).every((k) => !pinned(i, k) || pins[i].get(k).includes(value[k]))) : []);
  const agreeingAll = agree((i, k) => pins[i].has(k));
  const agreeing = agreeingAll.length ? agreeingAll : agree((i, k) => pins[i].has(k) && new Set(pins[i].get(k)).size === 1);
  const knowing = isPlainObject(value) && Object.keys(value).length ? candidates.filter((i) => Object.keys(value).every((k) => knows(i, k))) : [];
  const tied = scored.filter((x) => x.lacksMode === best.lacksMode && x.mismatched === best.mismatched && x.unknown === best.unknown && x.score === best.score).map((x) => x.i);
  const narrowed = agreeing.length ? agreeing : knowing.length ? knowing : candidates.length > LONG_UNION ? tied : candidates;
  const unheard = isPlainObject(value) ? Object.keys(value).filter((k) => !narrowed.some((i) => knows(i, k))) : [];
  const meant = [...narrowed, ...candidates.filter((i) => !narrowed.includes(i) && unheard.some((k) => knows(i, k)))];
  // (a union of one form — a group of one, where a deployment offers one — names no choice; nor does a
  // union whose closest branch is a union of its own — a group of forms, the ref inside what a note is
  // about: the innermost union names the forms, and a group's title is no form to write)
  // (nor a value its form took at its own level — every error of it inside a field the form has: the
  // form was right, and the modes listed beside a misspelt nested name are only noise)
  const nestedOnly = (es) => es.length > 0 && es.every((e) => e.instancePath !== '');
  const settled = nestedOnly(best.es) && meant.length <= LONG_UNION && meant.every((i) => i === best.i || scoreOf(i).es.some((e) => e.instancePath === ''));
  const label = settled || (named && candidates.length === 1) || defaults?.has(best.i) || branches.length === 1 || Array.isArray(branches[best.i].anyOf) ? [] : [{ keyword: 'oneOfNamed', instancePath: '', params: { names: [...new Set(meant.map((i) => branchTitle(branches[i], i)).filter(Boolean))] } }];
  return dedupe([...own, ...label, ...best.es]);
}

function dedupe(errors) {
  const seen = new Set();
  return errors.filter((e) => { const k = `${e.keyword}|${e.instancePath}|${JSON.stringify(e.params)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** An input checked against its tool's schema → { ok } or { ok: false, errors }. `opts` is kept for the
 *  callers that pass the catalog's reading of a property; the refusal reads the input as it is. */
export function validateInput(validator, input, _opts = {}) {
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
