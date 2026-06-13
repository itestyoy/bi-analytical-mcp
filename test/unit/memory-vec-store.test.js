import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';

// The vector store behind semantic memory search. With a real SQLite file the backend loads
// sqlite-vec (a vec0 KNN table, cosine metric); if the extension is unavailable it falls back
// to in-SQL cosine. EITHER way the repository contract (vectorPut/vectorIds/vectorSearch)
// returns the same shape + ordering — proven here on real stored vectors (no mocks).
test('sqlite memory vector store: KNN ordering + model isolation + delete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vecstore-'));
  const store = openStore({ dbPath: join(dir, 'vec.sqlite') });
  try {
    assert.equal(store.kind, 'sqlite', 'a real db path selects the sqlite backend');
    // (informational) whether the sqlite-vec extension actually loaded in this environment.
    assert.equal(typeof store._vec, 'boolean');

    for (const id of ['mon', 'tut', 'ads']) store.memory.add({ id, note: id, targets: [], aliases: [], links: [] });
    const model = 'm3';
    store.memory.vectorPut('mon', [3, 0, 0], model);
    store.memory.vectorPut('tut', [0, 2, 0], model);
    store.memory.vectorPut('ads', [0, 0, 1], model);

    // vectorIds reflects exactly the embedded notes for this model.
    const ids = store.memory.vectorIds(model);
    assert.equal(ids.size, 3);
    assert.ok(ids.has('mon') && ids.has('tut') && ids.has('ads'));
    assert.equal(store.memory.vectorIds('other-model').size, 0, 'a different model sees no vectors');

    // KNN for [1,0,0] → 'mon' is the closest (cosine ≈ 1), the orthogonal ones far below.
    const hits = store.memory.vectorSearch([1, 0, 0], { limit: 3, model });
    assert.equal(hits[0].id, 'mon');
    assert.ok(hits[0].score > 0.99, `mon cosine ~1 (got ${hits[0].score})`);
    const tut = hits.find((h) => h.id === 'tut');
    assert.ok(tut && tut.score < 0.01, 'orthogonal note scores ~0');

    // delete clears the vector too (no orphan in the index).
    store.memory.remove('mon');
    assert.ok(!store.memory.vectorIds(model).has('mon'), 'removed note drops out of the vector set');
    assert.ok(!store.memory.vectorSearch([1, 0, 0], { limit: 3, model }).some((h) => h.id === 'mon'));
  } finally {
    store.close();
  }
});
