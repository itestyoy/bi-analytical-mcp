// WHAT A PIPELINE STAGE IS WRITTEN WITH — the schema pieces every stage shares (the reference to the
// expression grammar, the type word, a sort key, a partition item), the SQL helpers a stage and an
// expression share (a window frame, a raw expression's placeholders and the names it may not write, an
// aggregate's SQL name), and the bookkeeping of the columns available at each step (add one, require
// one to exist). The expressions themselves — conditions and measures among them — are compute.js's.

import { getDialect } from '../dialects/index.js';
import { anyOfOr, strEnum } from '../schema-kit.js';
import { hasJinjaOpener } from '../jinja-inert.js';

export const NAME = '^[a-z][a-z0-9_]{0,40}$';

export const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * What THIS warehouse's statistical aggregates are: exact, or a sketch. The dialect declares it
 * (`approximateStats`), because the same `percentile` is exact on one warehouse and approximate on
 * another — and a caller that reports "the P99" has to say which of the two it is holding.
 */
export function statAccuracyNote(catalog) {
  let approx = [];
  try { approx = getDialect(catalog?.dialect)?.approximateStats || []; } catch { approx = []; }
  return approx.length
    ? `ON THIS WAREHOUSE ${approx.join('/')} are APPROXIMATE (sketch-based, which is what makes them cheap on a large table) — say so when you report the number; the other measures are exact.`
    : 'On this warehouse every measure here is exact.';
}

// An operand is an EXPRESSION (src/pipeline/compute.js: a column, an event property, a constant, now, or
// a function of expressions), defined once in the stage schemas' $defs and referenced from every place
// that takes one.
export const EXPR = { $ref: '#/$defs/expr' };

/**
 * ONE TYPE WORD — what a value is read or converted as: cast's, an event property's or a JSON / array
 * read's, an unnested element's, a raw expression's result, a CASE's.
 */
export const TYPES = ['int', 'numeric', 'float', 'string'];
export const TYPE = { enum: TYPES, description: 'The type: what cast converts to (SAFE — a value that will not convert becomes NULL rather than failing the query), what a JSON/array read, an unnested element or a raw expression yields, a CASE result.' };

/**
 * ONE SORT KEY — the order_by stage's keys (a build's, a read's, the steps after a metric query) and a
 * window's over.order_by: a column, its direction, and where its NULLs go. An omitted `nulls` is last on every warehouse (each writes it
 * explicitly: their own defaults differ), so a top-N or a row_number over a nullable key is the same rows
 * everywhere.
 */
export const SORT_KEY = {
  type: 'object', additionalProperties: false, required: ['key'],
  properties: {
    key: { type: 'string', description: 'The column to sort by.' },
    direction: { enum: ['asc', 'desc'], description: 'asc (default) or desc.' },
    nulls: { enum: ['first', 'last'], description: 'Where NULLs go: last (default) or first — the same on every warehouse.' },
  },
};

/** Every relationship name the events sources declare — what a partition's { entity } may name. */
function relationshipNames(catalog) {
  if (!catalog?.facts) return [];
  return [...new Set(catalog.facts.flatMap((f) => Object.keys(catalog.getModel(f).entities || {})))].sort();
}

/**
 * ONE PARTITION ITEM — what a funnel's sequence and a window's rows restart per: a column available
 * here, or { entity }, a relationship the source declares, whose key column is used. A catalog whose
 * sources declare no relationship offers the column alone, and so does a place that reads no source
 * (`entities: false` — a read over a stored table; such rows refuse an { entity } as the step is built
 * too: partitionColumn).
 */
export function partitionItem(catalog, { entities = true } = {}) {
  const rel = entities ? relationshipNames(catalog) : [];
  return anyOfOr([
    { title: 'a column', type: 'string', description: 'A column available here.' },
    ...(rel.length ? [{
      title: '{ entity }', type: 'object', additionalProperties: false, required: ['entity'],
      description: 'A relationship the source declares — its key column is used.',
      properties: { entity: strEnum(rel) },
    }] : []),
  ]);
}

/**
 * The column a partition item names: a column as it is, or { entity } — the key column of that
 * relationship of the pipeline's source, which has to be ONE real column (a composite key, or a part
 * truncated to a grain, is an expression: the caller partitions by the columns it means). A bare name
 * that is a relationship and no column here is told to say { entity }. `where` names it in a refusal.
 */
export function partitionColumn({ catalog, source, cols }, p, where) {
  const model = catalog && source ? catalog.getModel(source) : null;
  const declared = Object.keys(model?.entities || {});
  if (p !== null && typeof p === 'object') {
    if (!model) throw new Error(`${where}: { entity } names a relationship of a pipeline's source, and these rows read none (a stored table) — partition by its columns`);
    const e = model.entities?.[p.entity];
    if (!e) throw new Error(`${where}: '${source}' declares no relationship '${p.entity}' (declared: ${declared.join(', ') || 'none'})`);
    const parts = e.key || [];
    if (parts.length !== 1 || parts[0].grain) {
      throw new Error(`${where}: relationship '${p.entity}' of '${source}' is keyed by ${parts.map((x) => x.column).join(' + ') || 'nothing'}${parts.some((x) => x.grain) ? ' (truncated to a grain)' : ''}, which is an expression, not a column — partition by the column(s) you mean`);
    }
    return parts[0].column;
  }
  const s = String(p);
  if (!cols?.has(s) && declared.includes(s)) throw new Error(`${where}: '${s}' is a RELATIONSHIP of '${source}', not a column — write { entity: '${s}' } to partition by its key column`);
  return s;
}

/** An event property as seen from the pipeline's SOURCE fact (Catalog.propertyFor owns the
 *  bare-vs-qualified rules); a property of another fact is rejected with the fix. */
export const sourceProp = (catalog, source, name) => (source
  ? catalog.propertyFor(source, name, { hint: 'start the pipeline from the source that owns it' }) // the message names the owner
  : null);

/** A raw expression's SQL with `{n}` replaced by its n-th argument's SQL (outside strings, quoted
 *  names and comments); a placeholder with no argument, or an argument no placeholder uses, is refused.
 *  So is a Jinja opener anywhere in the text, strings and comments included: the SQL lands in a file
 *  dbt renders as Jinja, which would RUN it (src/jinja-inert.js) — and breaking it, as a constant's is
 *  broken, would change the SQL the caller wrote. */
export function fillPlaceholders(sql, args) {
  const src = String(sql); const code = unquotedSql(src);
  if (hasJinjaOpener(src)) throw new Error('pipeline: a raw expression\'s SQL may not hold {{, {% or {# — dbt renders the model as Jinja and would run it; a text holding one goes in as a constant: { value } in args, {n} in the SQL where it goes');
  const used = new Set();
  let out = ''; let last = 0;
  for (const m of code.matchAll(/\{(\d+)\}/g)) {
    const n = Number(m[1]);
    if (!(n >= 1 && n <= args.length)) throw new Error(`pipeline: a raw expression's {${n}} has no argument — it has ${args.length} (args: [${'{ column }'}, …], {1} the first)`);
    used.add(n);
    out += src.slice(last, m.index) + args[n - 1]; last = m.index + m[0].length;
  }
  const unused = args.map((_, i) => i + 1).filter((n) => !used.has(n));
  if (unused.length) throw new Error(`pipeline: a raw expression's argument${unused.length > 1 ? 's' : ''} ${unused.map((n) => `{${n}}`).join(', ')} ${unused.length > 1 ? 'are' : 'is'} not used in its SQL`);
  return out + src.slice(last);
}

/**
 * The columns a RAW expression writes by name in its TEXT — each word spelled exactly as a column at
 * this step is named (case included, so a keyword in upper case is not a lower-case column), outside
 * strings and comments, and each name in the warehouse's own identifier quotes (`identQuote`). A
 * function call (`name(`) and a field (`.name`) are not a column. A column reaches raw SQL only as an
 * item of its `args`: one found here is refused, so the positional form holds by construction.
 */
export function rawNamedColumns(sql, cols, identQuote) {
  const src = String(sql);
  const named = [];
  const add = (c) => { if (!named.includes(c)) named.push(c); };
  // a quoted name: the identifier quotes of this warehouse, read with the comments blanked first
  const uncommented = src.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  for (const m of uncommented.matchAll(/'(?:[^'\\]|\\.|'')*'|"((?:[^"\\]|\\.|"")*)"|`([^`]*)`/g)) {
    const inner = m[0][0] === '"' ? m[1] : m[0][0] === '`' ? m[2] : null;
    if (inner != null && m[0][0] === identQuote && cols.has(inner)) add(inner);
  }
  // a bare word of the code
  const code = unquotedSql(src);
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const word = m[0]; const at = m.index; const end = at + word.length;
    if (!cols.has(word) || /[0-9]/.test(code[at - 1] || '')) continue;
    if (/[.@:$]\s*$/.test(code.slice(Math.max(0, at - 2), at)) || /^\s*[(.]/.test(code.slice(end, end + 3))) continue;
    add(word);
  }
  return named;
}

/** Raw SQL with its comments, strings ('…', "…") and quoted names (`…`) blanked to spaces of the same
 *  length: what is left is its code, at the positions it holds in the text — the one reading of raw
 *  text, for its placeholders and its OVER alike. */
export function unquotedSql(sql) {
  return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, (m) => ' '.repeat(m.length));
}


// Window frame clause, e.g. ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW, or
// RANGE BETWEEN 10 PRECEDING AND CURRENT ROW (value offsets on the order key).
export function frameClause(f) {
  if (!f) return '';
  const mode = f.mode === 'range' ? 'RANGE' : 'ROWS';
  const bound = (v, dir) => {
    if (v === 'unbounded') return `UNBOUNDED ${dir}`;
    if (v === undefined || v === null || Number(v) === 0) return 'CURRENT ROW';
    if (!Number.isInteger(Number(v)) || Number(v) < 0) throw new Error(`window frame: bad ${dir.toLowerCase()} offset ${v}`);
    return `${Number(v)} ${dir}`;
  };
  const start = bound(f.preceding ?? 'unbounded', 'PRECEDING');
  const end = f.following === undefined ? 'CURRENT ROW' : bound(f.following, 'FOLLOWING');
  return ` ${mode} BETWEEN ${start} AND ${end}`;
}

/** The SQL function of an aggregation where it differs from its name (the vocabulary is the semantic layer's). */
export const sqlAgg = (agg) => (agg === 'average' ? 'avg' : agg);

export function addCol(cols, name, type) {
  if (!NAME_RE.test(name)) throw new Error(`invalid column name: ${name}`);
  const out = new Map(cols);
  out.set(name, { type });
  return out;
}

export function requireCol(cols, name) {
  if (cols.has(name)) return;
  // '*' is SQL's spelling for "the rows themselves"; here a count with no argument counts the rows, so
  // say that instead of listing every column and leaving the caller to guess what a SQL habit translates to
  if (name === '*') {
    throw new Error("pipeline: '*' is not a column — a count with no argument counts the ROWS ({ fn: 'count' })");
  }
  throw new Error(`pipeline: unknown column '${name}' at this stage (available: ${[...cols.keys()].join(', ')})`);
}
