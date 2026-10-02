// READING A TOOL SCHEMA IN A TEST — through the two things that stand between a test and a field: the
// fold (src/schema/transport.js puts repeated subtrees behind `$ref` into `#/$defs`) and the forms (a
// union is an `anyOf` of closed forms — src/schema-kit.js — so a field lives in the form that takes it,
// not on the union). A test reads "the `stage` field of build_pipeline_model" instead of a walk.

/** A node as written, or what its `$ref` points at (followed until it is not a ref). */
export function deref(doc, node, depth = 0) {
  if (!node || typeof node !== 'object' || !node.$ref || depth > 20) return node;
  const target = String(node.$ref).replace(/^#\//, '').split('/').reduce((n, key) => n?.[decodeURIComponent(key)], doc);
  return deref(doc, target, depth + 1);
}

/** The closed forms of a node: its `anyOf` branches (each resolved, a nested union flattened), or the node itself. */
export function forms(doc, node) {
  const n = deref(doc, node);
  if (!n || typeof n !== 'object') return [];
  if (!Array.isArray(n.anyOf)) return [n];
  return n.anyOf.flatMap((b) => forms(doc, b));
}

/** The form of a node whose `key` is pinned to `value` (`action: "start"`, `stage: "python"`). */
export function formWhere(doc, node, key, value) {
  return forms(doc, node).find((f) => pinned(doc, f, key).includes(value));
}

/** The values a form pins `key` to — its `const`, or its `enum`. */
export function pinned(doc, form, key) {
  const p = deref(doc, form?.properties?.[key]);
  if (!p) return [];
  return p.const !== undefined ? [p.const] : Array.isArray(p.enum) ? p.enum : [];
}

/** The schema of field `name` of a node: from its own properties, or from the first form that takes it. */
export function field(doc, node, name) {
  for (const f of forms(doc, node)) {
    if (f?.properties && name in f.properties) return deref(doc, f.properties[name]);
  }
  return undefined;
}

/** Every field name any form of a node takes. */
export function fieldNames(doc, node) {
  return [...new Set(forms(doc, node).flatMap((f) => Object.keys(f?.properties || {})))];
}
