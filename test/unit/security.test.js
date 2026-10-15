import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { compileDeclaration } from '../../src/compile.js';
import { renderPipeline, renderRead } from '../../src/pipeline.js';

const catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'));
const validators = makeValidators(buildSchemas(catalog));
const v = (tool, input) => validateInput(validators[tool], input);

test('a task is addressed by its id alone — no table name or path reaches a read', () => {
  for (const tool of ['query_model', 'query_model', 'display_model_result']) {
    const id = (x) => (tool === 'display_model_result' ? { task_id: x } : { task_ids: [x] });
    assert.equal(v(tool, id("x') }} ; drop table dim_users -- ")).ok, false, `${tool}: a task id is hex`);
    assert.equal(v(tool, { ...id('aabbccddeeff'), table: 'fct_analytics_events' }).ok, false, `${tool}: no table to name`);
    assert.ok(v(tool, id('aabbccddeeff')).ok);
  }
  assert.equal(v('drill_result', { task_id: 'aabbccddeeff', steps: [{ stage: 'limit', limit: 1 }], table: 'qr_aabbccddeeff' }).ok, false);
});
test('context_id is pattern-constrained (no path traversal) on all context tools', () => {
  for (const tool of ['query_model', 'delete_context.context', 'context.describe']) {
    const base = tool === 'query_model' ? { steps: [{ stage: 'metrics', metrics: ['m'] }] } : {};
    assert.equal(v(tool, { ...base, context_id: '../../../etc/passwd' }).ok, false, `${tool} should reject traversal`);
    assert.equal(v(tool, { ...base, context_id: 'a/b' }).ok, false, `${tool} should reject slashes`);
  }
});

// A derived metric is an expression of { metric } leaves, numbers and arithmetic: no text of the call's
// own reaches MetricFlow's expr — a name is a metric's or refused, a constant a number, no raw SQL, no
// other leaf (the place, PLACES.derived_metric, names what it takes).
test('derived metric expr is restricted to a safe arithmetic grammar', () => {
  const decl = (bad) => ({
    name: 'evil',
    semantic_models: [{ source: 'events', measures: [{ name: 'r', expr: { fn: 'sum', args: [{ column: 'price_in_usd_of_event_data' }] } }] }],
    metrics: [{ name: 'r', type: 'simple', measure: 'r' }, { name: 'bad', type: 'derived', ...bad }],
  });
  for (const [bad, rule] of [
    [{ expr: "r) as x, (select 1 from creds--", metrics: ['r'] }, /expr is an expression of the metrics it reads/],
    [{ expr: { fn: 'add', args: [{ metric: "r) as x, (select 1 from creds--" }, { value: 1 }] } }, /no metric named/],
    [{ expr: { fn: 'add', args: [{ metric: 'r' }, { value: '1) as x, (select 1--' }] } }, /a derived metric computes with numbers/],
    [{ expr: { fn: 'raw', sql: 'select 1 from creds' } }, /raw is not what a derived metric's expr takes — it takes \{ metric \}, \{ value \}, and add/],
    [{ expr: { fn: 'add', args: [{ metric: 'r' }, { column: 'price_in_usd_of_event_data' }] } }, /\{ column \} is not what a derived metric's expr takes/],
  ]) {
    assert.throws(() => compileDeclaration(catalog, decl(bad)), (e) => e.field === 'metrics.expr' && rule.test(e.message), JSON.stringify(bad));
  }
  // the schema refuses the text before anything compiles (the constant is the one expression's { value },
  // refused by the place as it compiles, above) — and raw SQL, which no place of the tool takes: the
  // tool's one expression holds no raw
  assert.equal(v('build_semantic_model', decl({ expr: "r) as x, (select 1 from creds--" })).ok, false);
  assert.match(v('build_semantic_model', decl({ expr: { fn: 'raw', sql: 'select 1 from creds' } })).errors.join(' | '), /`metrics\.1\.expr\.fn` must be one of/);
});

// A read runs under a tool that only reads, which a client calls without asking first: it takes no SQL
// of the caller's (raw is a build's) — the read tools' one expression, built for a read's place, holds no
// raw, and a read's place (PLACES.stored_rows) refuses it as the step is built, for what comes straight to
// the builder (a drill). And no raw SQL anywhere carries a Jinja opener: the model file is rendered by
// dbt, which would run it.
test('a read takes no raw SQL, and no raw SQL carries a Jinja opener', () => {
  const nested = [{ stage: 'aggregate', measures: [{ name: 'x', expr: { fn: 'sum', args: [{ fn: 'raw', sql: '{1} * 2', args: [{ column: 'a' }] }] } }] }];
  assert.throws(() => renderRead(catalog, "{{ ref('t') }}", [{ name: 'a', type: 'numeric' }], nested), /steps\[0\]: .*raw is not what a read of stored rows takes .*from_task/);
  const raw = [{ stage: 'compute', name: 'x', expr: { fn: 'raw', sql: "{{ run_query('drop table users') }}" } }];
  assert.throws(() => renderRead(catalog, "{{ ref('t') }}", [{ name: 'a', type: 'numeric' }], raw), /raw is not what a read of stored rows takes/);
  // the read tools' schemas refuse it in the call, at any depth — a pipeline read's steps, and a metric
  // query's steps after its metrics step and its where steps before it — while a build's takes it
  const metrics = { stage: 'metrics', metrics: ['m'] };
  for (const [at, steps] of [['measures.0.expr.args.0', nested], ['expr', raw]]) {
    const fn = (i) => new RegExp(`\`steps\\.${i}\\.${at.replace(/\./g, '\\.')}\\.fn\` must be one of`);
    assert.match(v('query_model', { context_id: 'abcdef123456', steps }).errors.join(' | '), fn(0), at);
    assert.match(v('query_model', { context_id: 'abcdef123456', steps: [metrics, ...steps] }).errors.join(' | '), fn(1), at);
  }
  assert.match(v('query_model', { context_id: 'abcdef123456', steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ fn: 'raw', sql: '1' }, { value: 1 }] }] }, metrics] }).errors.join(' | '), /`steps\.0\.conditions\.0\.args\.0\.fn` must be one of/);
  assert.equal(v('build_pipeline_model', { action: 'add_steps', context_id: 'abcdef123456', steps: [{ stage: 'compute', name: 'x', expr: { fn: 'raw', sql: 'upper({1})', args: [{ column: 'event_name' }] } }] }).ok, true, 'raw is a build\'s');
  const build = (sql) => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'compute', name: 'x', expr: { fn: 'raw', sql, args: [{ column: 'event_name' }] } }], { physicalCols: new Set(['event_name']) });
  for (const sql of ["upper({1}) || '{{ env_var(\"X\") }}'", '{% if true %}{1}{% endif %}', '{1} {# a note #}']) assert.throws(() => build(sql), /may not hold \{\{, \{% or \{#/, sql);
  assert.ok(build('upper({1})').columns.has('x'));
});

// A column a measure names is one of its model's — never SQL of the call's: an unknown one is refused
// when it is compiled, before any YAML is written.
test('a measure\'s column is a column of its model, refused otherwise', () => {
  assert.throws(() => compileDeclaration(catalog, { name: 'evil', semantic_models: [{ source: 'events', measures: [{ name: 'r', expr: { fn: 'sum', args: [{ column: 'price) from x; --' }] } }] }], metrics: [] }),
    (e) => e.field === 'measures.expr' && /is not a column, entity key or aggregatable amount of 'events'/.test(e.message));
});
