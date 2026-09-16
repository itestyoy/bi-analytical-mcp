// The guide we hand the model says which operations raise on the frame `dbt.ref()` returns. Written
// from the vendor's prose it was wrong in both directions — head(n) described as "returns different
// rows between runs" (it raises), nlargest as "orders by itself" (it needs an ordering unless
// keep='all'), unique()/drop_duplicates() as "do not work" (one does, the other has a keyword that
// makes it work), and std(ddof=0) prescribed, a parameter the library does not have.
//
// So the facts are EXTRACTED from bigframes (scripts/bigframes-facts.py → config/bigframes-facts.json)
// and this test holds the guide, the recipes and the runtime hints to them. It is the same kind of
// check as an input-validation test: the text the server emits must match a machine-readable
// contract, not a memory of a doc page. It never asserts on anything the warehouse produced —
// running BigFrames needs BigQuery, which the suites do not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { frameProfile, pythonRunHints } from '../../src/python-model.js';
import { pythonAuthoringGuide } from '../../src/python-guide.js';
import { loadRecipes } from '../../src/recipes.js';

const FACTS = JSON.parse(readFileSync(fileURLToPath(new URL('../../config/bigframes-facts.json', import.meta.url)), 'utf8'));
const recipes = loadRecipes(fileURLToPath(new URL('../../config/recipes.json', import.meta.url)));
const bq = frameProfile({ runtime: 'bigquery', method: 'bigframes' });
const guide = pythonAuthoringGuide(bq, []);
const allText = [bq.guide, JSON.stringify(guide), JSON.stringify(recipes.list.filter((r) => r.runtime === 'bigframes'))].join('\n');
const names = (kind) => [...new Set([...(FACTS[kind].DataFrame || []), ...(FACTS[kind].Series || [])])].filter((n) => !n.startsWith('_'));

test('the fact sheet is the shape the guide expects, and says which version it came from', () => {
  assert.equal(FACTS.library, 'bigframes');
  assert.match(String(FACTS.version), /^\d+\.\d+/, 'the facts are pinned to a version');
  assert.ok(names('requires_ordering').length > 10, 'the ordering list was extracted');
  assert.ok(names('requires_index').length > 5, 'the index list was extracted');
  assert.ok(FACTS.rules.every((r) => r.id && r.claim && r.evidence), 'every rule names where in the library it is decided');
});

test('the stage description carries the extracted lists, not a remembered subset', () => {
  // the operations a caller reaches for most: if the library marks them, the description says so
  for (const method of ['head', 'tail', 'rolling', 'shift', 'diff', 'cumsum', 'rank', 'sample']) {
    assert.ok(names('requires_ordering').includes(method), `precondition: ${method} is marked in the library`);
    assert.ok(bq.guide.includes(method), `the description omits ${method}, which raises without an ordering`);
  }
  for (const method of ['loc', 'at', 'idxmax', 'sort_index']) {
    assert.ok(names('requires_index').includes(method), `precondition: ${method} needs an index`);
    assert.ok(bq.guide.includes(method), `the description omits ${method}, which raises with no index`);
  }
  assert.match(bq.guide, /sort_values/, 'and says what grants the ordering');
});

test('nothing in the guide or the recipes prescribes a parameter the library does not have', () => {
  const std = FACTS.signatures.Series.std;
  assert.deepEqual(std, [], 'precondition: Series.std takes no parameters in this version');
  // Only what is PRESCRIBED counts: the `do` lines of the guide, and each recipe's approach, hack
  // and function bodies. The same form may appear in an `avoid` / `instead_of` — that is the point
  // of those fields.
  const prescribed = [
    ...(guide.examples || []).flatMap((ex) => ex.do || []),
    ...recipes.list.filter((r) => r.runtime === 'bigframes').flatMap((r) => [
      r.approach, r.hack,
      ...(r.register_payload?.pipeline?.stages || []).filter((st) => st.stage === 'python').flatMap((st) => (st.functions || []).flatMap((f) => JSON.stringify(f.body))),
    ]),
  ].join('\n');
  assert.ok(!/std\(ddof/.test(prescribed), `ddof is still prescribed: ${/[^\n]*std\(ddof[^\n]*/.exec(prescribed)?.[0]}`);
  // …and it IS still shown as the form that fails, so the caller recognises their own code
  assert.match(allText, /std\(ddof/, 'the failing form should still be named as such');
  // …and the guide says what to do instead when the population form is wanted
  assert.match(allText, /population/i);
  // the parameters that DO exist are the ones named
  assert.deepEqual(FACTS.signatures.Series.unique, ['keep_order']);
  assert.match(allText, /keep_order=False/, 'the working form of unique is named');
  assert.deepEqual(FACTS.signatures.Series.nlargest, ['n', 'keep']);
  // allText includes JSON-encoded recipe text, where a double quote arrives escaped
  assert.match(allText, /keep=\\?['"]all/, "nlargest's escape from the ordering rule is named");
});

test('head and nlargest are described as RAISING, not as returning arbitrary rows', () => {
  const topN = recipes.get('bf_top_n_needs_order');
  assert.match(topN.instead_of, /OrderRequiredError/);
  assert.match(topN.instead_of, /nlargest/, 'nlargest is on the failing side, not the working one');
  assert.ok(!/orders by itself/.test(allText), 'the old claim about nlargest is gone');
  assert.ok(!/differ between runs|vary between runs|rows differ/i.test(allText), 'the old claim about head is gone');
});

test('distinct values: drop_duplicates works, bare unique() is the one that raises', () => {
  const d = recipes.get('bf_distinct_values');
  assert.match(d.approach, /drop_duplicates/, 'the working form is the approach');
  assert.match(d.instead_of, /unique\(\)/);
  assert.ok(!/drop_duplicates\(\) (are|is) unsupported|both are unsupported/.test(allText), 'the old "neither works" claim is gone');
});

test('an estimator returns its own frame — the prediction is not assigned back', () => {
  const ml = recipes.get('bf_ml_predict_as_column');
  const fn = ml.register_payload.pipeline.stages.find((s) => s.stage === 'python').functions[0];
  const body = JSON.stringify(fn.body);
  assert.match(body, /model\.predict\(df\)/, 'predict is called on the frame…');
  assert.match(body, /return out/, '…and its result is what the stage returns');
  assert.ok(!/df\[as_\] = model\.predict/.test(body), 'the column assignment that raises is gone');
  assert.match(ml.instead_of, /NullIndexError/, 'and the recipe says why that form fails');
  // the rule it rests on is in the fact sheet, with its place in the library
  const rule = FACTS.rules.find((r) => r.id === 'ml_predict_rereads_and_keeps_input_columns');
  assert.ok(rule && /_apply_ml_tvf/.test(rule.evidence));
});

test('merge and join are distinguished, because only one of them needs an index', () => {
  const rule = FACTS.rules.find((r) => r.id === 'merge_is_a_relational_join');
  assert.ok(rule && /relational_join/.test(rule.evidence));
  assert.match(allText, /merge is a SQL join|merge is a relational|relational join/i);
  assert.match(allText, /\.join\(/, 'and the align-path twin is named so the two are not confused');
});

test('the runtime hints send a failed run to the form that works', () => {
  const nullIndex = pythonRunHints(bq, 'NullIndexError: Cannot implicitly align objects. Set an explicit index using set_index.');
  assert.equal(nullIndex.length, 1);
  assert.match(nullIndex[0], /merge/, 'the merge way out');
  assert.match(nullIndex[0], /predict|estimator/, 'and the estimator way out');
  const ordering = pythonRunHints(bq, 'OrderRequiredError: Op head requires an ordering.');
  assert.equal(ordering.length, 1);
  assert.match(ordering[0], /sort_values/);
  // a pandas runtime has a real index and a real order: it says none of this
  assert.deepEqual(pythonRunHints(frameProfile({ runtime: 'duckdb' }), 'NullIndexError'), []);
});

// The recipes are the worked form of the rule that everything SQL can compute is computed in SQL:
// each one prepares its table in SQL stages and leaves the python stage with the part SQL cannot
// say. A recipe that handed the raw source to python would teach the opposite of the guide.
test('every bigframes recipe prepares its table in SQL before the python stage', () => {
  const REDUCES = new Set(['where', 'derive', 'compute', 'join', 'aggregate', 'match_recognize', 'project', 'limit', 'unnest', 'pivot', 'unpivot', 'window', 'order_by']);
  const bf = recipes.list.filter((r) => r.runtime === 'bigframes');
  assert.ok(bf.length >= 10, 'precondition: the bigframes family is shipped');
  for (const r of bf) {
    const stages = r.register_payload.pipeline.stages;
    const at = stages.findIndex((s) => s.stage === 'python');
    assert.ok(at > 0, `${r.id}: the python stage is first — nothing prepares its input`);
    const before = stages.slice(0, at).map((s) => s.stage);
    assert.ok(before.some((s) => REDUCES.has(s)), `${r.id}: stages before python (${before.join(', ') || 'none'}) do not narrow or reduce anything`);
    // …and the python stage declares what it hands on, so the SQL stages after it have columns
    const py = stages[at];
    assert.ok(py.output?.columns?.length, `${r.id}: the python stage declares no output columns`);
  }
});
