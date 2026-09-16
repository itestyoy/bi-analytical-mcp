// A GLOBAL ANALYTIC WINDOW is the shape that killed a real query: `OVER ()` with no PARTITION BY
// keeps every row and attaches the value to each, so a single worker has to hold the whole input.
// On ~6.3M rows that came back as "Resources exceeded during query execution", with analytic
// windows accounting for all of the measured memory — and it happened AGAIN after the exact
// percentile was taken out, for plain AVG/STDDEV over the same global window.
//
// The cheap form of the same question is an `aggregate` stage with no group_by: one row with the
// statistics, applied per row afterwards as literals. So the server says that when it sees the
// shape, and refuses nothing — over an already-aggregated handful of rows a global window is
// harmless, and the row count is not knowable from here.
//
// These are the same kind of checks as the python-preparation nudge: what the server SAYS about a
// declared stage, plus input validation on the two forms of least/greatest. Nothing here asserts on
// generated SQL — the numbers are proven in test/integration/pipeline.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildSchemas } from '../../src/schema.js';
import { pipelineStageSchema } from '../../src/pipeline.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { getDialect } from '../../src/dialects/index.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = (dialect) => {
  const catalog = loadCatalog(CATALOG, dialect ? { dialect } : {});
  if (dialect) catalog.dialect = dialect;
  return new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'win-')) }) });
};

const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] };
const DERIVE = { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd_of_event_data', type: 'numeric' };

test('a window with no partition_by is named as a global window, with the aggregate way out', async () => {
  const e = engine();
  const { draft_id } = await e.build_native_model({ action: 'start', name: 'win', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id, stage: DERIVE });
  await e.build_native_model({ action: 'add_step', draft_id, stage: AGG });
  const out = await e.build_native_model({
    action: 'add_step', draft_id,
    stage: { stage: 'compute', name: 'revenue_avg', op: 'window', fn: 'avg', column: 'revenue' },
  });
  const said = [...(out.recommendations || []), ...(out.warnings || [])].join(' ');
  assert.match(said, /Global analytic window/);
  assert.match(said, /Resources exceeded/, 'it says what the failure looks like');
  assert.match(said, /aggregate` stage with no group_by/, 'and the cheap form of the same question');
  assert.match(said, /literal/, 'and how the number gets back onto the rows');
});

test('the same window PER GROUP says nothing — a partition is what a window is for', async () => {
  const e = engine();
  const { draft_id } = await e.build_native_model({ action: 'start', name: 'win2', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id, stage: DERIVE });
  const out = await e.build_native_model({
    action: 'add_step', draft_id,
    stage: { stage: 'compute', name: 'running', op: 'window', fn: 'sum', column: 'price', partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }] },
  });
  const said = [...(out.recommendations || []), ...(out.warnings || [])];
  assert.ok(!said.some((w) => /Global analytic window/.test(w)), said.join(' '));
});

// The real query wrote its statistics as raw SQL, which is the only way to say STDDEV_POP or an
// exact PERCENTILE_CONT here — so the raw escape hatch is where the nudge matters most.
test('raw SQL carrying OVER () is caught too, and a partitioned one is not', () => {
  const e = engine();
  const global = e._globalWindowWarnings({ stage: 'compute', name: 'z', op: 'raw', sql: '(revenue - AVG(revenue) OVER ()) / STDDEV_POP(revenue) OVER ()' });
  assert.equal(global.length, 1);
  assert.match(global[0], /OVER \(\) with no PARTITION BY/);
  // an exact percentile is the same shape with an ordering — still one global window
  assert.equal(e._globalWindowWarnings({ stage: 'compute', name: 'p99', op: 'raw', sql: 'PERCENTILE_CONT(revenue, 0.99) OVER (ORDER BY revenue)' }).length, 1);
  // …and a real partition is not the shape at all
  assert.deepEqual(e._globalWindowWarnings({ stage: 'compute', name: 'r', op: 'raw', sql: 'AVG(revenue) OVER (PARTITION BY player_id_of_internal)' }), []);
  assert.deepEqual(e._globalWindowWarnings({ stage: 'compute', name: 'r', op: 'raw', sql: 'revenue * 2' }), []);
  // a stage that is not a compute is none of this function's business
  assert.deepEqual(e._globalWindowWarnings(AGG), []);
});

// Pass 2 of the ladder: the numbers come back as literals, so `least` has to take one.
test('least/greatest take a literal as well as columns, and say so when given neither', () => {
  const validators = makeValidators(buildSchemas(loadCatalog(CATALOG, {})));
  const step = (stage) => validateInput(validators.build_native_model, { action: 'add_step', draft_id: 'ctxabc123456', stage });

  assert.equal(step({ stage: 'compute', name: 'capped', op: 'least', parts: [{ column: 'revenue' }, { value: 100 }] }).ok, true);
  assert.equal(step({ stage: 'compute', name: 'capped', op: 'least', columns: ['revenue', 'budget'] }).ok, true);
  assert.equal(step({ stage: 'compute', name: 'capped', op: 'greatest', parts: [{ column: 'revenue' }, { value: 0 }] }).ok, true);

  const neither = step({ stage: 'compute', name: 'capped', op: 'least' });
  assert.equal(neither.ok, false);
  const text = (neither.errors || []).join(' | ');
  assert.match(text, /columns/, 'the refusal names the all-columns form');
  assert.match(text, /parts/, 'and the form that takes a literal');

  // coalesce is unchanged: it takes columns, and its `default` is where a literal goes
  assert.equal(step({ stage: 'compute', name: 'c', op: 'coalesce', parts: [{ column: 'revenue' }] }).ok, false);
});

// A percentile that is exact on one warehouse is a sketch on another, and a caller reporting "the
// P99" has to know which one it holds. The dialect declares it; the stage says it.
test('the stage says whether this warehouse computes median/percentile exactly or approximately', () => {
  assert.deepEqual(getDialect('bigquery').approximateStats, ['median', 'percentile']);
  assert.deepEqual(getDialect('postgres').approximateStats, []);

  const describe = (dialect) => {
    const catalog = loadCatalog(CATALOG, { dialect });
    catalog.dialect = dialect;
    const stages = pipelineStageSchema(catalog);
    const branches = stages.anyOf || stages.oneOf || [];
    return branches.find((b) => b.properties?.stage?.enum?.[0] === 'aggregate').description;
  };
  assert.match(describe('bigquery'), /median\/percentile are APPROXIMATE/);
  assert.match(describe('postgres'), /every measure here is exact/);
  // …and both warn off the global window, since that part is not per warehouse
  for (const d of ['bigquery', 'postgres']) {
    assert.match(describe(d), /NO group_by/);
    assert.match(describe(d), /Resources exceeded/);
  }
});
