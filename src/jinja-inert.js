// A CALLER'S TEXT INSIDE A FILE dbt RENDERS AS JINJA — every .sql model, whole (comments and string
// literals included), and the prose properties of every YAML file (description, label) — must never
// be read as Jinja. dbt evaluates `{{ … }}` and `{% … %}` wherever they appear in those files, so a
// filter value or a python body carrying `{{ run_query('DELETE …') }}` would RUN, and an unbalanced
// `{%` / `{#` would fail the build.
//
// Only the OPENERS matter (`{{`, `{%`, `{#`): with none of them Jinja sees plain text, and a closer
// on its own is literal. So each opener is broken, in the way the place allows:
//   inertText    — prose (a comment, a description): a space between the brace and its partner.
//                  The text still reads as written.
//   inertLiteral — a SQL string literal: split into two literals joined by `||` at the opener, so the
//                  VALUE compared is byte-for-byte the caller's while the file never holds the pair.
// Text without an opener is returned unchanged.

const OPENER = /\{(?=[{%#])/g;
const HAS_OPENER = /\{[{%#]/;

/** Prose with every Jinja opener broken by a space. */
export function inertText(s) {
  return typeof s === 'string' ? s.replace(OPENER, '{ ') : s;
}

/**
 * A quoted SQL literal of `s` (quote-escaped by `quote`) whose file text holds no Jinja opener:
 * `a{{b` → `('a{' || '{b')`. The concatenation is standard SQL on every warehouse we render for.
 */
export function inertLiteral(s, quote) {
  if (!HAS_OPENER.test(s)) return quote(s);
  const parts = [];
  let from = 0;
  for (const m of s.matchAll(OPENER)) {
    parts.push(s.slice(from, m.index + 1));
    from = m.index + 1;
  }
  parts.push(s.slice(from));
  return `(${parts.map(quote).join(' || ')})`;
}

/**
 * A COPY of a YAML document with every `description` and `label` string made inert. A copy: the
 * document is assembled from the context's own state (its metrics, its additions), which must keep
 * the caller's text exactly as declared.
 */
export function inertProse(node) {
  if (Array.isArray(node)) return node.map(inertProse);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, (k === 'description' || k === 'label') && typeof v === 'string' ? inertText(v) : inertProse(v)]));
}
