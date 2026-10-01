// THE SCHEMA CONSTRUCTS EVERY TOOL IS WRITTEN WITH — the ones every client takes, built so an empty
// one cannot be written down.
//
// ONLY WHAT EVERY CLIENT READS. A tool's input reaches a model through its host's API, and the APIs
// take a SUBSET of JSON Schema: Anthropic's refuses a whole request whose tool schema has a union at
// its root, OpenAI's strict mode refuses `allOf`, `not` and `if/then/else`, and neither documents
// `oneOf`. What both take is a plain object, `enum` / `const`, `$ref` into `$defs`, and `anyOf` below
// the root. So a union here is an `anyOf` of CLOSED forms (`form`): each form lists exactly its own
// fields (`additionalProperties: false`) and is told apart from the others by a pinned value — the
// mode it is (`action: "start"`) — or by the fields it requires. Closed and told apart, exactly one
// form matches any input, so the `anyOf` means what a `oneOf` would, in the spelling all of them read.
// A rule "in this mode that field is required, this one is not allowed" is not a condition bolted on
// beside the fields (`if/then`, `not`) but the form itself: the field is in its required list, or it is
// not among its properties. test/unit/schema-portability.test.js holds every published schema to
// that subset.
//
// EMPTY CONSTRUCTS. A catalog decides every vocabulary in this server: which events a source
// declares, which columns are groupable, which relationships exist. Any of them may legitimately be
// EMPTY in a catalog someone writes tomorrow (an events source with no declared relationship, a
// dimension model that carries only its key). Written straight into a schema, an empty vocabulary
// produces a schema ajv refuses to compile — and since every tool schema is compiled while the Engine
// is constructed, the SERVER DOES NOT START. So the two constructs that are invalid when empty are
// built here, and the empty case is answered once:
//   strEnum  — no values → an open string (nothing valid to pick; compile-time checks still refuse
//              a bad name), so the field stays writable and the schema stays valid.
//   anyOfOr  — no branches → undefined, so the CALLER omits the field entirely: a choice with no
//              options is not a field the caller can fill in.
// `assertSchemaSound` is the backstop: it walks a finished schema and names any empty construct
// that got in another way, with the path to it.

/** A string constrained to `values` — or an open string when the catalog offers none. */
export function strEnum(values, description) {
  // a missing description is an ABSENT key, never `description: undefined` — that is not JSON, and
  // a client validating the tool list as an object (not as parsed text) rejects the whole list
  const desc = description === undefined ? {} : { description };
  return values?.length ? { type: 'string', enum: values, ...desc } : { type: 'string', ...desc };
}

/** A choice between `branches` — or undefined when there is nothing to choose between. */
export function anyOfOr(branches, rest = {}) {
  return branches?.length ? { ...rest, anyOf: branches } : undefined;
}

/** The named fields of `fields`, in the order named — what one form of a union takes. */
export function pick(fields, names) {
  return Object.fromEntries(names.filter((n) => fields[n] !== undefined).map((n) => [n, fields[n]]));
}

/**
 * One CLOSED form of a union: exactly `properties`, `required` of them, and — with `tag` — one field
 * pinned to the value(s) that say which form this is: `tag: ['action', 'start']`, or several values
 * that share the form (`['action', ['preview', 'materialize']]`). A tag marked `optional` may be left
 * out (the form a tool takes by default). `tagDescription` says what that value of the tag means.
 */
export function form({ title, description, tag, tagDescription, optionalTag = false, required = [], properties = {} }) {
  const [key, value] = tag || [];
  const pinned = key === undefined ? {} : {
    [key]: {
      ...(Array.isArray(value) ? (value.length === 1 ? { const: value[0] } : { enum: value }) : { const: value }),
      ...(tagDescription ? { description: tagDescription } : {}),
    },
  };
  const req = [...new Set([...(key !== undefined && !optionalTag ? [key] : []), ...required])];
  return {
    type: 'object',
    additionalProperties: false,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(req.length ? { required: req } : {}),
    properties: { ...pinned, ...properties },
  };
}

/**
 * ONE CONDITION GRAMMAR — what every `where` is written in, wherever it sits: a list of conditions
 * that ALL hold, each item a condition (`leaf`, the place's own: a column, an event property, a
 * dimension) or a group — { or: [...] }, at least one holds, whose items may be { and: [...] }, all
 * of them hold. A list of ors is every boolean condition there is (with the negated operators at the
 * leaves), and it nests no deeper, so no schema recursion is needed. The groups are told apart from a
 * condition by the field each requires (`or` / `and`, a condition its `op`).
 */
export function conditionList(leaf, description, { minItems = 1 } = {}) {
  const leaves = leaf.anyOf && !leaf.properties ? leaf.anyOf : [leaf];
  const all = form({ title: 'all of', required: ['and'], properties: { and: { type: 'array', minItems: 2, items: { anyOf: leaves }, description: 'Conditions that all hold.' } } });
  const any = form({ title: 'any of', required: ['or'], properties: { or: { type: 'array', minItems: 2, items: { anyOf: [...leaves, all] }, description: 'Conditions of which at least one holds — each a condition, or { and: [...] } for several that hold together.' } } });
  return { type: 'array', minItems, description, items: { anyOf: [...leaves, any] } };
}

/**
 * A string that is anything but `value` — the one rule `not: { const }` would say, written in the
 * portable subset: a string of another length, or one that differs from `value` at some position. Each
 * alternative is a plain pattern (a character class and a count), so it reads the same everywhere.
 */
export function stringOtherThan(value, rest = {}) {
  const v = String(value);
  const esc = (c) => c.replace(/[\\\]^-]/g, (x) => `\\${x}`);
  const lengths = [...(v.length ? [`^[\\s\\S]{0,${v.length - 1}}$`] : []), `^[\\s\\S]{${v.length + 1},}$`];
  const positions = [...v].map((c, i) => `^[\\s\\S]{${i}}[^${esc(c)}][\\s\\S]{${v.length - i - 1}}$`);
  // the title is what a refusal says (src/validate.js): the alternatives are patterns, not something to read
  return { type: 'string', title: `any value other than ${JSON.stringify(v)}`, ...rest, anyOf: [...lengths, ...positions].map((pattern) => ({ pattern })) };
}

/** Drop the keys whose value is undefined — for spreading an `anyOfOr` that came back empty. */
export function withoutEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Walk a built schema and report every construct JSON Schema forbids as empty. Used by the Engine's
 * own guard test so a catalog shape that would refuse to compile is named here, with its path,
 * instead of surfacing as "schema is invalid" from deep inside ajv.
 */
export function assertSchemaSound(schema, path = '#') {
  const bad = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${at}/${i}`)); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum) && node.enum.length === 0) bad.push(`${at}/enum is empty`);
    for (const k of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(node[k]) && node[k].length === 0) bad.push(`${at}/${k} is empty`);
    }
    for (const [k, v] of Object.entries(node)) {
      // `undefined` is not a JSON value: dropped by serialization, rejected by a client that
      // validates the list as objects (the SDK's in-memory transport does)
      if (v === undefined) bad.push(`${at}/${k} is undefined`);
      else walk(v, `${at}/${k}`);
    }
  };
  walk(schema, path);
  return bad;
}
