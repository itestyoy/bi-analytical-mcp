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
    ? `On this warehouse ${approx.join('/')} are approximate — say so when you report the number.`
    : '';
}

// An operand is an EXPRESSION (src/pipeline/compute.js: a column, an event property, a constant, now, or
// a function of expressions), defined once in the stage schemas' $defs and referenced from every place
// that takes one.
export const EXPR = { $ref: '#/$defs/expr' };

/**
 * ONE TYPE WORD — what a value is converted to: cast's, a CASE's (its value converted to it), and what a
 * raw expression says it yields (its caller's word: a raw that says none claims none). A value that is
 * read (a column, an event property, a JSON field, an array element) has the type of what it is read
 * from, and is converted by cast — by one rule on every warehouse (the dialects' castExpr / fromText): to
 * int, the number a value or a text holds, rounded half away from zero.
 */
export const TYPES = ['int', 'numeric', 'float', 'string'];
export const TYPE = { enum: TYPES, description: 'cast is safe: what will not convert is NULL; int rounds half away from zero.' };

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

/** A raw expression's SQL with `{n}` replaced by its n-th argument's SQL (outside strings and quoted
 *  names); a placeholder with no argument, or an argument no placeholder uses, is refused. So is a
 *  Jinja opener anywhere in the text, strings included: the SQL lands in a file dbt renders as Jinja,
 *  which would RUN it (src/jinja-inert.js) — and breaking it, as a constant's is broken, would change
 *  the SQL the caller wrote. And so is anything that makes it more than ONE expression (rawCode). */
export function fillPlaceholders(sql, args) {
  const src = String(sql);
  if (hasJinjaOpener(src)) throw new Error('pipeline: a raw expression\'s SQL may not hold {{, {% or {# — dbt renders the model as Jinja and would run it; a text holding one goes in as a constant: { value } in args, {n} in the SQL where it goes');
  const code = rawCode(src);
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

// QUOTED TEXT of raw SQL: strings ('…', "…" — a doubled quote inside is one) and quoted names (`…`).
// It is where both warehouses end it once rawCode has refused the quotes they read differently.
const QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g;
const COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\//;
const blank = (m) => ' '.repeat(m.length);

/** Raw SQL with its comments, strings ('…', "…") and quoted names (`…`) blanked to spaces of the same
 *  length: what is left is its code, at the positions it holds in the text — the reading of raw text
 *  for its OVER and the columns it names (its placeholders are read where it is checked: rawCode). */
export function unquotedSql(sql) {
  return String(sql).replace(new RegExp(`${COMMENT.source}|${QUOTED.source}`, 'g'), blank);
}

/**
 * A raw expression is ONE EXPRESSION, in the parentheses the server writes around it — the one place its
 * text is checked (fillPlaceholders). Its quoted text has to end where both warehouses end it: a backslash
 * before a quote escapes it on BigQuery and is a character on DuckDB ('a\' is a whole text there), and
 * three quotes in a row open a text on BigQuery and are an escaped quote on DuckDB — both refused. Its
 * code (the text with the quoted text blanked) then holds no statement end (;), no comment (--, #, /*,
 * *\/), no $ (DuckDB's $$ opens a text), no quote that does not close and no parenthesis that does not
 * balance: else '1)); DROP TABLE x; SELECT ((1' would close the model's SELECT, and BigQuery runs the rest
 * as a script. A text holding one goes in as a constant, which the server quotes.
 * → the code, at the positions it holds in the text
 */
function rawCode(src) {
  const fix = 'a text holding one goes in as a constant: { value } in args, {n} in the SQL where it goes';
  const read = [/\\['"`]/.test(src) && 'a backslash before a quote', /'''|"""/.test(src) && 'three quotes in a row'].filter(Boolean);
  if (read.length) throw new Error(`pipeline: a raw expression's SQL holds ${read.join(' and ')}, which BigQuery and DuckDB end a text at differently; ${fix}`);
  const code = src.replace(QUOTED, blank);
  const found = [];
  const quote = /['"`]/.exec(code);
  if (quote) found.push(`a ${quote[0]} that does not close`);
  if (code.includes(';')) found.push('a statement end (;)');
  const comments = ['--', '#', '/*', '*/'].filter((c) => code.includes(c));
  if (comments.length) found.push(`a comment (${comments.join(' ')})`);
  if (code.includes('$')) found.push('a $ (a dollar-quoted text on DuckDB)');
  let depth = 0;
  for (const ch of code) if ((depth += ch === '(' ? 1 : ch === ')' ? -1 : 0) < 0) break;
  if (depth) found.push(depth < 0 ? 'a ) that closes what it did not open' : 'a ( that does not close');
  if (found.length) throw new Error(`pipeline: a raw expression is ONE expression, and its SQL holds ${found.join(', ')} outside quoted text; ${fix}`);
  return code;
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

const AVAILABLE_SHOWN = 40; // columns a refusal lists in full; past that, those like the name asked for

/**
 * The columns a refusal names beside a name that is not one of them: all of them where they are few, else
 * those whose name holds it (or a word of it), and how many there are — a wide source has hundreds.
 */
export function availableColumns(cols, name) {
  const all = [...(cols.keys ? cols.keys() : cols)];
  if (all.length <= AVAILABLE_SHOWN) return `available: ${all.join(', ')}`;
  const q = String(name ?? '').toLowerCase();
  const words = q.match(/[a-z0-9]+/g) || [];
  const like = q ? all.filter((c) => c.toLowerCase().includes(q) || words.some((w) => w.length > 2 && c.toLowerCase().includes(w))).slice(0, 10) : [];
  if (like.length) return `${all.length} columns here; those like '${name}': ${like.join(', ')}`;
  return `${all.length} columns here${q ? `, none like '${name}'` : ''}; the first ${AVAILABLE_SHOWN}: ${all.slice(0, AVAILABLE_SHOWN).join(', ')}, …`;
}

export function requireCol(cols, name) {
  if (cols.has(name)) return;
  // a column named by a reference is a metrics step's result's — anywhere else a column is its name
  if (name !== null && typeof name === 'object') throw new Error(`pipeline: ${JSON.stringify(name)} names a column of a metrics step's result by what the query grouped or computed — here name the column itself (${availableColumns(cols, null)})`);
  // '*' is SQL's spelling for "the rows themselves"; here a count with no argument counts the rows, so
  // say that instead of listing every column and leaving the caller to guess what a SQL habit translates to
  if (name === '*') {
    throw new Error("pipeline: '*' is not a column — a count with no argument counts the ROWS ({ fn: 'count' })");
  }
  throw new Error(`pipeline: unknown column '${name}' at this stage (${availableColumns(cols, name)})`);
}
