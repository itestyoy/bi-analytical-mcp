// A TOOL CALL NEVER WAITS ON THE WAREHOUSE LONGER THAN THE CALLER DOES.
//
// Several answers are enriched from the warehouse: the physical column set a source is grounded
// to, the freshness of its time column, a row estimate. They are extras — every one of them has a
// documented "could not be known" path — but each is a dbt round trip, and dbt's own timeout is
// the BUILD timeout (10 minutes by default). So the first such call after a restart, with a cold
// dbt process and an untouched warehouse, could outlive the timeout of the client in front of it:
// the client reported a generic tool failure, the caller retried, the retry hit the cache the
// abandoned call had primed, and the difference looked like whichever argument happened to change
// between the two attempts (this was observed as `build_native_model({ action: 'start' })` failing
// with description + include_columns and passing without them).
//
// Context-lifecycle tests (the non-data kind this project allows): how long a call may hold, what
// it answers when the enrichment does not arrive in time, and that a burst of calls spawns one
// introspection rather than one per call. The stub runner never touches a warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const GRACE = 200; // the grace under test — a real deployment's is 20s, capped at 30s

/** A runner whose introspection hangs until the test releases it, counting how often it was called. */
function hangingRunner() {
  const state = { calls: 0, release: null };
  return {
    state,
    relationColumns() {
      state.calls += 1;
      return new Promise((resolve) => { state.release = (columns) => resolve({ ok: true, columns }); });
    },
    show() { return new Promise(() => {}); }, // freshness/estimate: never answers
  };
}

function engineWith(runner) {
  const catalog = loadCatalog(CATALOG, {});
  const ctxs = new ContextManager({
    workspaceRoot: mkdtempSync(join(tmpdir(), 'deadline-ws-')),
    baseProjectDir: mkdtempSync(join(tmpdir(), 'deadline-proj-')),
  });
  return settle(new Engine({ catalog, contextManager: ctxs, runner, queryTimeoutMs: GRACE }));
}

test('build_native_model({ start }) answers within the grace when introspection hangs — with the declared columns', async () => {
  const runner = hangingRunner();
  const e = engineWith(runner);
  const t0 = Date.now();
  const r = await e.build_native_model({ action: 'start', name: 'slow_start', source: 'events', description: 'a description', include_columns: true, time_range: { start: '2024-01-01', end: '2024-01-31' } });
  const held = Date.now() - t0;

  assert.ok(held < GRACE * 5, `the call held ${held}ms — it must hand back at the grace, not at dbt's own timeout`);
  assert.equal(r.action, 'start');
  assert.equal(r.description, 'a description');
  // the documented fallback: grounding is skipped, so what the catalog declares is what is offered
  assert.equal(r.column_count, e.catalog.modelColumns('events').length);
  assert.equal(r.available_columns.length, r.column_count);
  assert.equal(runner.state.calls, 1);
  runner.state.release([]); // let the abandoned introspection finish
});

test('the abandoned introspection primes the cache: the NEXT call is grounded to it', async () => {
  const runner = hangingRunner();
  const e = engineWith(runner);
  const declared = e.catalog.modelColumns('events').map((c) => c.name);

  await e.build_native_model({ action: 'start', name: 'first', source: 'events' }); // times out
  // the warehouse answers late — with one declared column missing from the real relation
  runner.state.release(declared.slice(1).map((name) => ({ name })));
  await new Promise((resolve) => setImmediate(resolve));

  const second = await e.build_native_model({ action: 'start', name: 'second', source: 'events', include_columns: true });
  assert.equal(runner.state.calls, 1, 'the cached set is reused — no second dbt round trip');
  assert.equal(second.column_count, declared.length - 1, 'the column the relation lacks is not offered');
  assert.ok(!second.available_columns.some((c) => c.name === declared[0]));
});

test('concurrent calls share ONE introspection instead of spawning a dbt process each', async () => {
  const runner = hangingRunner();
  const e = engineWith(runner);
  const results = await Promise.all([
    e.build_native_model({ action: 'start', name: 'concurrent_a', source: 'events' }),
    e.build_native_model({ action: 'start', name: 'concurrent_b', source: 'events' }),
    e.semantic_index({ model: 'events' }),
  ]);
  assert.equal(runner.state.calls, 1, 'one in-flight read serves every caller waiting on it');
  assert.ok(results.every((r) => r), 'and each of them got an answer');
  runner.state.release([]);
});

test('a hanging freshness query does not hold semantic_index either', async () => {
  const runner = hangingRunner();
  const e = engineWith(runner);
  const t0 = Date.now();
  const r = await e.semantic_index({ model: 'events' });
  assert.ok(Date.now() - t0 < GRACE * 5, 'the overview hands back at the grace');
  assert.equal(r.data_freshness, undefined, 'freshness that did not arrive is simply absent');
  assert.ok(r.columns.length > 0, 'and the columns are still there');
  runner.state.release([]);
});
