// A refusal is the only teacher the caller has at that moment, so it must name the spelling THIS
// server uses instead of only listing what is allowed.
//
// Every path aggregates with ONE vocabulary — an aggregation is a function (`fn`), the mean `average`,
// a quantile `percentile`, the name a step produces `name` — so a caller who learned it once can use it
// everywhere. A caller who brings SQL's words (`avg`, `mean`, `quantile`, `q`, `as`) or the earlier
// `agg` is told what this server calls them, in every path; a value written in an earlier spelling of
// the grammar is shown as it is written now.
//
// Input-validation tests: bad input is refused, and the refusal says the right thing. Nothing here
// asserts on generated SQL/YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { renderPipeline, renderRead } from '../../src/pipeline.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const validators = makeValidators(buildSchemas(catalog));
const check = (tool, input) => validateInput(validators[tool], input);
const text = (res) => (res.errors || []).join(' | ');

const stage = (st) => ({ action: 'add_steps', context_id: 'ctxabc123456', steps: [st] });
/** A build whose only step is its semantic layer, over `source`. */
const layer = (source, step) => check('build_model', { action: 'start', name: 'spell_task', source, steps: [{ stage: 'semantic_model', ...step }] });
const measure = (name, expr) => stage({ stage: 'aggregate', measures: [{ name, expr }] });

test("a pipeline measure refuses `avg` (and `mean`, `quantile`) and says how it is spelled here", () => {
  const res = check('build_model', measure('x', { fn: 'avg', args: [{ column: 'price' }] }));
  assert.equal(res.ok, false);
  assert.match(text(res), /'avg' is spelled 'average'/);
  // the allowed list is still there — the hint adds to it, it does not replace it
  assert.match(text(res), /must be one of: add, sub/);
  assert.match(text(check('build_model', measure('x', { fn: 'mean', args: [{ column: 'price' }] }))), /'mean' is spelled 'average'/);
  assert.match(text(check('build_model', measure('x', { fn: 'quantile', args: [{ column: 'price' }], percentile: 0.5 }))), /'quantile' is spelled 'percentile'/);
  // …and the correct spelling is accepted
  assert.equal(check('build_model', measure('x', { fn: 'average', args: [{ column: 'price' }] })).ok, true);
});

test("a governed measure refuses `avg` and says it is spelled `average` here", () => {
  const payload = (fn) => layer('events', {
    measures: [{ name: 'price', expr: { fn, args: [{ column: 'price_in_usd_of_event_data' }] } }],
    metrics: [{ name: 'price', type: 'simple', measure: 'price' }],
  });
  const res = payload('avg');
  assert.equal(res.ok, false);
  assert.match(text(res), /'avg' is spelled 'average'/);
  assert.equal(payload('average').ok, true);
});

test("a card's fold refuses `avg` and the earlier `agg`, naming `average` and `fn`", () => {
  const draw = (display) => check('display_model_result', { task_id: 'abcdef123456', display });
  assert.match(text(draw({ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', fn: 'avg' }] })), /'avg' is spelled 'average'/);
  assert.match(text(draw({ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', agg: 'max' }] })), /unexpected property 'agg' — here that field is called 'fn'/);
  assert.match(text(draw({ kind: 'bar', x: 'a', y: ['b'], drill: { levels: [{ column: 'c' }], agg: 'max' } })), /unexpected property 'agg' — here that field is called 'fn'/);
  assert.equal(draw({ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', fn: 'average' }] }).ok, true);
  // a card folds into a number: a sketch producer is no fold, nor is a percentile without its quantile
  for (const fn of ['hll_init', 'percentile']) assert.equal(draw({ kind: 'bar', x: 'a', y: ['b'], drill: { levels: [{ column: 'c' }], fn } }).ok, false, fn);
});

test('the quantile is `percentile` on every path, and SQL\'s `q` / `as` and the earlier `agg` are named for what they are here', () => {
  const res = check('build_model', measure('p90', { fn: 'percentile', q: 0.9, args: [{ column: 'price' }] }));
  assert.equal(res.ok, false);
  assert.match(text(res), /here that field is called 'percentile'/);
  assert.equal(check('build_model', measure('p90', { fn: 'percentile', percentile: 0.9, args: [{ column: 'price' }] })).ok, true);

  const gov = layer('acquisition', {
    measures: [{ name: 'p90', expr: { fn: 'percentile', args: [{ column: 'cost' }], q: 0.9 } }],
    metrics: [{ name: 'p90', type: 'simple', measure: 'p90' }],
  });
  assert.equal(gov.ok, false);
  assert.match(text(gov), /here that field is called 'percentile'/);

  // a measure written as the earlier { name, agg } is no form of a measure: it is { name, expr }
  const agg = check('build_model', stage({ stage: 'aggregate', measures: [{ name: 'n', agg: 'count' }] }));
  assert.equal(agg.ok, false);
  assert.match(text(agg), /missing required property 'expr'/);
  const as = check('build_model', stage({ stage: 'unnest', expr: { column: 'items' }, as: 'item' }));
  assert.equal(as.ok, false);
  assert.match(text(as), /here that field is called 'name'/);
});

test('a name with no counterpart in this path gets the plain list, with no invented advice', () => {
  const res = check('build_model', measure('x', { fn: 'geomean', args: [{ column: 'price' }] }));
  assert.equal(res.ok, false);
  assert.match(text(res), /must be one of/);
  assert.ok(!/is spelled/.test(text(res)), 'nothing is suggested for a function this server does not have');
});

// `sum_boolean` has no word-for-word counterpart: a count of a column counts its non-NULL rows, not
// its true ones, so naming `count` alone would hand back another number under the same reading. The
// refusal lists the functions; the aggregate's description (and recipe boolean_condition_as_measure)
// teach a count over a case.
test('sum_boolean is refused with the list of functions, and no word-for-word advice, on both paths', () => {
  const pipe = check('build_model', measure('payers', { fn: 'sum_boolean', args: [{ column: 'is_payer' }] }));
  const semantic = layer('events', { measures: [{ name: 'm', expr: { fn: 'sum_boolean' } }], metrics: [{ name: 'm', type: 'simple', measure: 'm' }] });
  for (const res of [pipe, semantic]) {
    assert.equal(res.ok, false);
    assert.match(text(res), /must be one of/);
    assert.ok(!/is spelled/.test(text(res)), text(res));
  }
});

// A list of measures is `measures` wherever rows are aggregated — a stage, a read, a semantic model —
// and a context is `context_id` in every tool: the earlier spellings are refused, with this server's
// name in the refusal (a hint, not an alias).
test("a read's measure list is `measures`, and `aggregations` is refused with that name", () => {
  const res = check('query_model', { context_id: 'ctxabc123456', steps: [{ stage: 'aggregate', group_by: ['event_name'], aggregations: [{ name: 'n', expr: { fn: 'count' } }] }] });
  assert.equal(res.ok, false);
  assert.match(text(res), /'aggregations' — here that field is called 'measures'/);
  assert.equal(check('query_model', { context_id: 'ctxabc123456', steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }] }] }).ok, true);
});

// A list a tool runs in order is `steps` in every tool, its items tagged by what they are. What changed
// only its name (`stages`, `stage`) is told the name (refusal-views.test.js); what changed its shape — a
// read's `transform`, a metric query's metrics, group_by, where and order_by beside its steps, the earlier
// { model, attribute }, the include_* flags — is no form of the tool's schema, refused as any value it does
// not take, and what it is written as today is taken.
test("a query's earlier fields are refused; its steps say them today", () => {
  const keys = [{ key: 'revenue', direction: 'desc' }];
  const revenue = { stage: 'metrics', metrics: ['revenue'] };
  const country = { source: 'users', column: 'country' };
  const US = { fn: 'eq', args: [country, { value: 'US' }] };
  for (const earlier of [
    { context_id: 'ctxabc123456', transform: { group_by: ['event_name'] } },
    { context_id: 'ctxabc123456', metrics: ['revenue'] },
    { context_id: 'ctxabc123456', metrics: ['revenue'], group_by: [country], where: [US], order_by: keys },
    { context_id: 'ctxabc123456', queries: [{ steps: [revenue] }, { metrics: ['revenue'], order_by: keys }] },
    { context_id: 'ctxabc123456', steps: [{ ...revenue, group_by: [{ model: 'users', attribute: 'country' }] }] },
    { context_id: 'ctxabc123456', steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ model: 'users', attribute: 'country' }, { value: 'US' }] }] }, revenue] },
    { context_id: 'ctxabc123456', steps: [revenue], dry_run: true, include_plan: true },
  ]) assert.equal(check('query_model', earlier).ok, false, JSON.stringify(earlier));
  for (const today of [
    { context_id: 'ctxabc123456', steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'rows', expr: { fn: 'count' } }] }] },
    { context_id: 'ctxabc123456', steps: [{ stage: 'where', conditions: [US] }, { ...revenue, group_by: [country] }, { stage: 'order_by', keys }] },
    { context_id: 'ctxabc123456', queries: [{ steps: [revenue] }, { steps: [revenue, { stage: 'order_by', keys }] }] },
    { context_id: 'ctxabc123456', steps: [revenue], dry_run: true, include: ['plan'] },
    { context_id: 'ctxabc123456', steps: [revenue, { stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'revenue' }, { value: 100 }] }] }, { stage: 'limit', limit: 3 }] },
  ]) assert.equal(check('query_model', today).ok, true, JSON.stringify(today));
  // a list of no steps says nothing: there is no query without its metrics step
  assert.equal(check('query_model', { context_id: 'ctxabc123456', steps: [] }).ok, false);
});

// The builders' "show me more" is the one list `include`; an action that answers with no shape (preview)
// takes none.
test('build_model: include is one list; include_columns and include_steps are no fields', () => {
  const add = { action: 'add_steps', context_id: 'ctxabc123456', steps: [{ stage: 'limit', limit: 1 }] };
  assert.match(text(check('build_model', { ...add, include_columns: true, include_steps: true })), /unexpected property 'include_columns'/);
  assert.equal(check('build_model', { ...add, include: ['columns', 'steps'] }).ok, true);
  assert.equal(check('build_model', { ...add, include: ['columns', 'columns'] }).ok, false, 'each item once');
  assert.equal(check('build_model', { ...add, include: ['yaml'] }).ok, false, 'the builder\'s own enum');
  assert.match(text(check('build_model', { action: 'preview', context_id: 'ctxabc123456', include: ['steps'] })), /unexpected property 'include'/);
});

test('a pipeline step names its context with context_id; `draft_id` is refused with that name', () => {
  const res = check('build_model', { action: 'materialize', draft_id: 'ctxabc123456' });
  assert.equal(res.ok, false);
  assert.match(text(res), /'draft_id' — here that field is called 'context_id'/);
  assert.equal(check('build_model', { action: 'materialize', context_id: 'ctxabc123456' }).ok, true);
  // a start may omit its action (the default) and name a context to start the draft in
  assert.equal(check('build_model', { name: 'started', source: 'events', context_id: 'ctxabc123456', steps: [{ stage: 'limit', limit: 1 }], materialize: true }).ok, true);
});

// `count(*)` is a SQL habit; here the rows are counted by a count with no argument. The refusal for
// '*' says that instead of listing every column available at that point — in a stage and in a read.
test("a stage and a read explain '*': count rows with no argument", () => {
  const cols = new Map([['player_id_of_internal', { type: 'string' }]]);
  const star = [{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count', args: [{ column: '*' }] } }] }];
  for (const build of [
    () => renderPipeline(catalog, catalog.dialect, 'events', star, { physicalCols: new Set(cols.keys()) }),
    () => renderRead(catalog, "{{ ref('t') }}", cols, star),
  ]) {
    assert.throws(build, (e) => {
      assert.match(e.message, /'\*' is not a column/);
      assert.match(e.message, /a count with no argument counts the ROWS/);
      return true;
    });
  }
  // and the form that works
  const ok = renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] }], { physicalCols: new Set(cols.keys()) });
  assert.ok(ok.columns.has('n'), 'a count with no argument is the row count');
});

// A stage object that arrived without its `stage` field is a truncated call, not an unknown stage
// type — the message used to point at the schema ("unknown pipeline stage: undefined").
test('a stage with no `stage` field says the stage never arrived', () => {
  assert.throws(
    () => renderPipeline(catalog, catalog.dialect, 'events', [{ measures: [{ name: 'n', expr: { fn: 'count' } }] }], { physicalCols: new Set(['player_id_of_internal']) }),
    (e) => {
      assert.match(e.message, /has no `stage` field/);
      assert.match(e.message, /truncated/);
      return true;
    },
  );
  // an unknown stage NAME still reports itself as that, and lists what exists
  assert.throws(
    () => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'transmogrify' }], { physicalCols: new Set(['player_id_of_internal']) }),
    (e) => {
      assert.match(e.message, /unknown pipeline stage: transmogrify/);
      assert.match(e.message, /known: /);
      return true;
    },
  );
});

// An expression that names nothing — no column, no constant, no function — is refused in words, by
// every internal render too (preview, checkpoint, a recipe payload go through renderPipeline directly).
test('an expression says what it is missing, in words', () => {
  assert.throws(
    () => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'compute', name: 'flag', expr: {} }], { physicalCols: new Set(['player_id_of_internal']) }),
    (e) => {
      assert.match(e.message, /compute 'flag'/);
      // (said at the place it stands: a step over a source's rows takes these leaves)
      assert.match(e.message, /an expression is \{ column \}, \{ property \}, \{ value \}, \{ now: true \}.* or a function \{ fn, args, … \}/);
      return true;
    },
  );
  // …and a constant renders
  const ok = renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'compute', name: 'flag', expr: { value: 1 } }], { physicalCols: new Set(['player_id_of_internal']) });
  assert.ok(ok.columns.has('flag'));
});

// a ratio of two sums is no single measure: the hint names the derived metric over two measures, never an
// aggregate of the per-row ratio (another number); a `ratio` metric is told how a derived one divides
test('a formula over aggregates in a measure is pointed at a derived metric, and a ratio metric at its expr', () => {
  const sum = (column) => ({ fn: 'sum', args: [{ column }] });
  const div = text(layer('acquisition', { measures: [{ name: 'cpc', expr: { fn: 'div', args: [sum('cost'), sum('clicks')] } }], metrics: [{ name: 'cpc', type: 'simple', measure: 'cpc' }] }));
  assert.match(div, /'div' is not taken here: it stands in a derived metric over one measure per aggregate/);
  assert.doesNotMatch(div, /args: \[\{ fn: "div"/);
  const ratio = text(layer('events', { measures: [{ name: 'rows', expr: { fn: 'count' } }], metrics: [{ name: 'r', type: 'ratio', numerator: 'rows', denominator: 'rows' }] }));
  assert.match(ratio, /Here 'ratio' is spelled 'derived' — a derived metric has no numerator \/ denominator: its expr divides one metric by the other/);
});

test('a name pattern is said in words', () => {
  assert.match(text(check('build_model', { action: 'start', name: 'x', source: 'events' })), /`name` must be a name of 3 to 41 lowercase letters, digits and underscores, a letter first/);
});
