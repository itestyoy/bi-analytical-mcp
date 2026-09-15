// A TEXT column holding JSON is read through the jsonb operators, and the `::jsonb` cast RAISES on
// a row whose text is not JSON — one such row fails the WHOLE statement. Every read must therefore
// guard the cast, or a single malformed row turns a working query into an error.
//
// This asserts DATA: the expressions run against a real Postgres (PGlite) over a table that holds
// one good row and one malformed one, and the test reads the VALUES that come back. It does not
// look at the SQL text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPglite } from './pglite-harness.js';
import { getDialect } from '../../src/dialects/index.js';

const d = getDialect('postgres');
let pg;

test('postgres JSON reads: a malformed row yields NULL instead of failing the query', async (t) => {
  pg = await startPglite();
  t.after(async () => { await pg.stop(); });

  await pg.db.exec(`
    CREATE TABLE payloads (id int, tags text, obj text);
    INSERT INTO payloads VALUES
      (1, '["rewarded","banner"]', '{"mode":"a","n":"7"}'),
      (2, 'not json at all',       'also not json'),
      (3, '{"not":"an array"}',    '{"mode":"b","n":"9"}');
  `);

  // array length: good row counts, malformed and wrong-shape rows read as absent
  const len = await pg.db.query(`SELECT id, ${d.jsonColumnArrayLength('tags')} AS n FROM payloads ORDER BY id`);
  assert.deepEqual(len.rows.map((r) => [r.id, r.n]), [[1, 2], [2, null], [3, null]]);

  // array containment: true on the good row, NULL (not an error) on the others
  const has = await pg.db.query(`SELECT id, ${d.jsonColumnArrayContains('tags', 'banner')} AS hit FROM payloads ORDER BY id`);
  assert.deepEqual(has.rows.map((r) => [r.id, r.hit]), [[1, true], [2, null], [3, null]]);
  const missing = await pg.db.query(`SELECT id, ${d.jsonColumnArrayContains('tags', 'nope')} AS hit FROM payloads WHERE id = 1`);
  assert.equal(missing.rows[0].hit, false, 'a value that is not in the array is false, not NULL');

  // struct field: the field on the good rows, NULL on the malformed one
  const field = await pg.db.query(`SELECT id, ${d.jsonColumnStructField('obj', 'mode')} AS mode FROM payloads ORDER BY id`);
  assert.deepEqual(field.rows.map((r) => [r.id, r.mode]), [[1, 'a'], [2, null], [3, 'b']]);

  // …and a typed read casts only what parsed
  const typed = await pg.db.query(`SELECT id, ${d.jsonColumnStructField('obj', 'n', 'numeric')} AS n FROM payloads ORDER BY id`);
  assert.deepEqual(typed.rows.map((r) => [r.id, r.n == null ? null : Number(r.n)]), [[1, 7], [2, null], [3, 9]]);

  // the whole point: every one of those statements returned ROWS rather than raising
  const count = await pg.db.query('SELECT count(*)::int AS n FROM payloads');
  assert.equal(count.rows[0].n, 3);
});

// The JSON was valid, the VALUE was not a number: `::numeric` on a word aborts the whole statement
// on Postgres, while BigQuery's SAFE_CAST returns NULL for that row and results for the rest. Both
// dialects must answer the same question the same way, so every typed read goes through the safe
// cast. Asserted on the values that come back (and on the aggregate over them).
test('postgres typed reads: a non-numeric value reads as NULL and the query still returns rows', async (t) => {
  const db = (await startPglite());
  t.after(async () => { await db.stop(); });
  await db.db.exec(`
    CREATE TABLE amounts (id int, blob jsonb, flat text, arr text);
    INSERT INTO amounts VALUES
      (1, '{"amount":"12.5"}', '{"amount":"12.5"}', '["1","2"]'),
      (2, '{"amount":"n/a"}',  '{"amount":"n/a"}',  '["3","x"]');
  `);

  // a blob property read as a number: the word becomes NULL, 12.5 still arrives
  const blob = await db.db.query(`SELECT id, ${d.jsonExtract('blob', 'amount', 'numeric')} AS v FROM amounts ORDER BY id`);
  assert.deepEqual(blob.rows.map((r) => [r.id, r.v == null ? null : Number(r.v)]), [[1, 12.5], [2, null]]);

  // the same through a FLATTENED text column holding JSON
  const flat = await db.db.query(`SELECT id, ${d.jsonColumnStructField('flat', 'amount', 'numeric')} AS v FROM amounts ORDER BY id`);
  assert.deepEqual(flat.rows.map((r) => [r.id, r.v == null ? null : Number(r.v)]), [[1, 12.5], [2, null]]);

  // and through an unnested array of strings read as numbers
  const un = d.arrayUnnest('a', 'arr', null, 'el', null, 'int', 'json');
  const arr = await db.db.query(`SELECT a.id, ${un.element} AS v FROM amounts a ${un.join} ORDER BY a.id, v NULLS LAST`);
  assert.deepEqual(arr.rows.map((r) => [r.id, r.v == null ? null : Number(r.v)]), [[1, 1], [1, 2], [2, 3], [2, null]]);

  // an aggregate over the mixed column still works — that is what a pipeline actually does
  const sum = await db.db.query(`SELECT sum(${d.jsonExtract('blob', 'amount', 'numeric')}) AS total FROM amounts`);
  assert.equal(Number(sum.rows[0].total), 12.5);
});
