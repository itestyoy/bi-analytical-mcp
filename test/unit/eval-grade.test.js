// The eval's grader (evals/grade.mjs) and its golden set (evals/cases.js): the checks a paid run
// rests on. The truths themselves come from the warehouse — `npm run eval:check` proves every case
// against the fixture data and through the tools; this file holds what needs neither.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../../evals/cases.js';
import { answerStates, numbersIn, sameAnswer, toolsMeet } from '../../evals/grade.mjs';
import { buildToolDefs } from '../../src/mcp-surface.js';
import { makeEngine } from '../helpers/mcp-http.js';

test('a number is read out of prose in any of the ways an answer writes it', () => {
  assert.deepEqual(numbersIn('Revenue was $1,234.50 from 7 payers (-3 refunds).'), [1234.5, 7, -3]);
  const n = { kind: 'number' };
  assert.equal(answerStates(n, 85, 'Total IAP revenue: **$85** USD.'), true);
  assert.equal(answerStates(n, 17.5, 'Spend came to 17.50.'), true);
  assert.equal(answerStates(n, 85, 'Total IAP revenue: $58.'), false);
});

test('a label is a whole word of the answer, and a map needs every key with its value', () => {
  assert.equal(answerStates({ kind: 'label' }, 'p3', 'Product p3 earns the most.'), true);
  assert.equal(answerStates({ kind: 'label' }, 'p3', 'Product p31 earns the most.'), false);
  const m = { kind: 'map' };
  assert.equal(answerStates(m, { control: 6, variant_b: 6 }, 'control has 6 players and variant_b 6.'), true);
  assert.equal(answerStates(m, { control: 6, variant_b: 5 }, 'control has 6 players and variant_b 6.'), false);
  assert.equal(answerStates(m, { control: 6, variant_b: 6 }, 'control has 6 players.'), false);
  assert.equal(sameAnswer(m, { a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(sameAnswer(m, { a: 1, b: 2 }, { a: 1, b: 2, c: 0 }), false);
});

test('the tools a run called are held to the case: required, forbidden, budget', () => {
  const calls = (...names) => names.map((name) => ({ name }));
  assert.equal(toolsMeet({ any: ['query_pipeline_model'] }, calls('semantic_index', 'query_pipeline_model')).ok, true);
  assert.equal(toolsMeet({ any: ['query_pipeline_model'] }, calls('semantic_index')).ok, false);
  assert.equal(toolsMeet({ forbid: '*' }, calls()).ok, true);
  assert.equal(toolsMeet({ forbid: '*' }, calls('time')).ok, false);
  assert.equal(toolsMeet({ forbid: ['build_pipeline_model'] }, calls('semantic_index')).ok, true);
  assert.equal(toolsMeet({ forbid: ['build_pipeline_model'] }, calls('build_pipeline_model')).ok, false);
  assert.equal(toolsMeet({ max_calls: 2 }, calls('a', 'b', 'c')).ok, false);
});

test('the golden set is well-formed: unique ids, every kind present, only listed tools named', () => {
  const listed = new Set(buildToolDefs(makeEngine()).map((d) => d.name));
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const kind of ['direct', 'indirect', 'negative']) assert.ok(CASES.some((c) => c.kind === kind), `a ${kind} case`);
  for (const c of CASES) {
    for (const name of [...(c.expect.any || []), ...(Array.isArray(c.expect.forbid) ? c.expect.forbid : [])]) assert.ok(listed.has(name), `${c.id} names ${name}`);
    if (c.kind === 'negative') assert.equal(c.answer.kind, 'none', c.id);
    else assert.ok(c.ref?.source && c.ref.stages?.length && c.answer.sql, `${c.id} has a truth and a reference path`);
  }
});
