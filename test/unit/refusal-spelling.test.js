// A refusal is the only teacher the caller has at that moment, so it must name the spelling THIS
// path uses instead of only listing what is allowed.
//
// There are two vocabularies under this server and both are correct: a governed measure speaks
// MetricFlow (`average`, the quantile in `percentile`, `field: '*'` for rows), a pipeline stage
// speaks SQL (`avg`, the quantile in `q`, `count` with no column). A caller who learned one and
// used it in the other used to get a flat "must be one of: …" and had to guess which of fifteen
// names meant the function they asked for.
//
// Input-validation tests: bad input is refused, and the refusal says the right thing. Nothing here
// asserts on generated SQL/YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { renderPipeline } from '../../src/pipeline.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const validators = makeValidators(buildSchemas(catalog));
const check = (tool, input) => validateInput(validators[tool], input);
const text = (res) => (res.errors || []).join(' | ');

const stage = (st) => ({ action: 'add_step', draft_id: 'ctxabc123456', stage: st });

test("a pipeline stage refuses `average` and says it is spelled `avg` here", () => {
  const res = check('build_native_model', stage({ stage: 'aggregate', measures: [{ name: 'x', fn: 'average', column: 'price' }] }));
  assert.equal(res.ok, false);
  assert.match(text(res), /'average' is spelled 'avg'/);
  // the allowed list is still there — the hint adds to it, it does not replace it
  assert.match(text(res), /must be one of: sum, avg/);
  // …and the correct spelling is accepted
  assert.equal(check('build_native_model', stage({ stage: 'aggregate', measures: [{ name: 'x', fn: 'avg', column: 'price' }] })).ok, true);
});

test("a governed measure refuses `avg` and says it is spelled `average` here", () => {
  const payload = (agg) => ({
    name: 'spell_task',
    semantic_models: [{ from: 'events', measures: [{ name: 'm', agg, field: 'price_in_usd_of_event_data' }] }],
    metrics: [{ name: 'm', type: 'simple', measure: { name: 'm' } }],
  });
  const res = check('create_semantic_model', payload('avg'));
  assert.equal(res.ok, false);
  assert.match(text(res), /'avg' is spelled 'average'/);
  assert.equal(check('create_semantic_model', payload('average')).ok, true);
});

test('the quantile parameter names itself per path: `q` in a stage, `percentile` in a measure', () => {
  const res = check('build_native_model', stage({ stage: 'aggregate', measures: [{ name: 'p90', fn: 'percentile', percentile: 0.9, column: 'price' }] }));
  assert.equal(res.ok, false);
  assert.match(text(res), /here that field is called 'q'/);
  assert.equal(check('build_native_model', stage({ stage: 'aggregate', measures: [{ name: 'p90', fn: 'percentile', q: 0.9, column: 'price' }] })).ok, true);

  const gov = check('create_semantic_model', {
    name: 'spell_pct',
    semantic_models: [{ from: 'acquisition', measures: [{ name: 'p90', agg: 'percentile', field: 'cost', q: 0.9 }] }],
    metrics: [{ name: 'p90', type: 'simple', measure: { name: 'p90' } }],
  });
  assert.equal(gov.ok, false);
  assert.match(text(gov), /here that field is called 'percentile'/);
});

test('a name with no counterpart in this path gets the plain list, with no invented advice', () => {
  const res = check('build_native_model', stage({ stage: 'aggregate', measures: [{ name: 'x', fn: 'geomean', column: 'price' }] }));
  assert.equal(res.ok, false);
  assert.match(text(res), /must be one of/);
  assert.ok(!/is spelled/.test(text(res)), 'nothing is suggested for a function this server does not have');
});

// `count(*)` is a SQL habit; in a stage the rows are counted by leaving `column` out. The refusal
// for '*' now says that instead of listing every column available at that point.
test("a stage explains '*': count rows by omitting `column`", () => {
  const cols = new Map([['player_id_of_internal', { type: 'string' }]]);
  assert.throws(
    () => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'aggregate', measures: [{ name: 'n', fn: 'count', column: '*' }] }], { physicalCols: new Set(cols.keys()) }),
    (e) => {
      assert.match(e.message, /'\*' is not a column/);
      assert.match(e.message, /omitting `column`/);
      assert.match(e.message, /governed path/);
      return true;
    },
  );
  // and the form that works
  const ok = renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] }], { physicalCols: new Set(cols.keys()) });
  assert.ok(ok.columns.has('n'), 'count with no column is the row count');
});

// A stage object that arrived without its `stage` field is a truncated call, not an unknown stage
// type — the message used to point at the schema ("unknown pipeline stage: undefined").
test('a stage with no `stage` field says the stage never arrived', () => {
  assert.throws(
    () => renderPipeline(catalog, catalog.dialect, 'events', [{ measures: [{ name: 'n', fn: 'count' }] }], { physicalCols: new Set(['player_id_of_internal']) }),
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

// A mechanical rewrite of the schemas (`const: 'x'` → `enum: ['x']`, so the pinned value survives a
// client that rewrites the schema for strict function calling) also rewrote an error MESSAGE that
// happened to contain the word: `compute op 'const' needs a value` became `enum: [needs] value`.
// The tool schema hides it (its own if/then requires `value` first), but every internal render —
// preview, checkpoint, a recipe payload — goes through renderPipeline directly.
test("the compute op 'const' says what it is missing, in words", () => {
  assert.throws(
    () => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'compute', name: 'flag', op: 'const' }], { physicalCols: new Set(['player_id_of_internal']) }),
    (e) => {
      assert.match(e.message, /compute op 'const'/);
      assert.match(e.message, /`value`/);
      assert.ok(!/enum: \[/.test(e.message), 'the message is prose, not a mangled schema keyword');
      return true;
    },
  );
  // …and with the value it renders
  const ok = renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'compute', name: 'flag', op: 'const', value: 1 }], { physicalCols: new Set(['player_id_of_internal']) });
  assert.ok(ok.columns.has('flag'));
});
