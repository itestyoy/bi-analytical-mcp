// The two JSON Schema constructs that are INVALID when empty — `enum: []` and `oneOf: []` — built
// so an empty one cannot be written down.
//
// A catalog decides every vocabulary in this server: which events a source declares, which columns
// are groupable, which relationships exist. Any of them may legitimately be EMPTY in a catalog
// someone writes tomorrow (an events source with no declared relationship, a dimension model that
// carries only its key). Written straight into a schema, an empty vocabulary produces a schema ajv
// refuses to compile — and since every tool schema is compiled while the Engine is constructed, the
// SERVER DOES NOT START. The failure is total, it is far from the catalog that caused it, and no
// test with a well-populated fixture can see it.
//
// So the constructs are built here instead of inline, and the empty case is answered once:
//   strEnum  — no values → an open string (nothing valid to pick; compile-time checks still refuse
//              a bad name), so the field stays writable and the schema stays valid.
//   oneOfOr  — no branches → undefined, so the CALLER omits the field entirely: a choice with no
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
export function oneOfOr(branches, rest = {}) {
  return branches?.length ? { ...rest, oneOf: branches } : undefined;
}

/** Drop the keys whose value is undefined — for spreading an `oneOfOr` that came back empty. */
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
