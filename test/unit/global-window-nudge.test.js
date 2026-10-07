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
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = (dialect) => {
  const catalog = loadCatalog(CATALOG, dialect ? { dialect } : {});
  if (dialect) catalog.dialect = dialect;
  return settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'win-')) }) }));
};

const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', agg: 'sum', column: 'price' }] };
const DERIVE = { stage: 'compute', name: 'price', expr: { fn: 'event_property', property: 'price_in_usd_of_event_data', type: 'numeric' } };

test('a window with no partition_by is named as a global window, with the aggregate way out', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'win', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: DERIVE });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: AGG });
  const out = await e.build_pipeline_model({
    action: 'add_step', draft_id,
    stage: { stage: 'compute', name: 'revenue_avg', expr: { fn: 'average', args: [{ column: 'revenue' }], over: {} } },
  });
  const said = [...(out.recommendations || []), ...(out.warnings || [])].join(' ');
  assert.match(said, /Global analytic window/);
  assert.match(said, /Resources exceeded/, 'it says what the failure looks like');
  assert.match(said, /aggregate` stage with no group_by/, 'and the cheap form of the same question');
  assert.match(said, /literal/, 'and how the number gets back onto the rows');
});

test('the same window PER GROUP says nothing — a partition is what a window is for', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'win2', source: 'events' });
  await e.build_pipeline_model({ action: 'add_step', draft_id, stage: DERIVE });
  const out = await e.build_pipeline_model({
    action: 'add_step', draft_id,
    stage: { stage: 'compute', name: 'running', expr: { fn: 'sum', args: [{ column: 'price' }], over: { partition_by: ['player_id_of_internal'], order_by: [{ key: 'device_time' }] } } },
  });
  const said = [...(out.recommendations || []), ...(out.warnings || [])];
  assert.ok(!said.some((w) => /Global analytic window/.test(w)), said.join(' '));
});

// The real query wrote its statistics as raw SQL, which is the only way to say STDDEV_POP or an
// exact PERCENTILE_CONT here — so the raw escape hatch is where the nudge matters most.
test('raw SQL carrying OVER () is caught too, and a partitioned one is not', () => {
  const e = engine();
  const global = e.advisor.globalWindowWarnings({ stage: 'compute', name: 'z', expr: { fn: 'raw', sql: '(revenue - AVG(revenue) OVER ()) / STDDEV_POP(revenue) OVER ()' } });
  assert.equal(global.length, 1);
  assert.match(global[0], /OVER \(\) with no PARTITION BY/);
  // an exact percentile is the same shape with an ordering — still one global window
  assert.equal(e.advisor.globalWindowWarnings({ stage: 'compute', name: 'p99', expr: { fn: 'raw', sql: 'PERCENTILE_CONT(revenue, 0.99) OVER (ORDER BY revenue)' } }).length, 1);
  // …and a real partition is not the shape at all
  assert.deepEqual(e.advisor.globalWindowWarnings({ stage: 'compute', name: 'r', expr: { fn: 'raw', sql: 'AVG(revenue) OVER (PARTITION BY player_id_of_internal)' } }), []);
  assert.deepEqual(e.advisor.globalWindowWarnings({ stage: 'compute', name: 'r', expr: { fn: 'raw', sql: 'revenue * 2' } }), []);
  // a stage that is not a compute is none of this function's business
  assert.deepEqual(e.advisor.globalWindowWarnings(AGG), []);
});

// Pass 2 of the ladder: the numbers come back as literals, so `least` has to take one.
test('least/greatest take their arguments as expressions — columns and literals alike — and say how many they need', () => {
  const validators = makeValidators(buildSchemas(loadCatalog(CATALOG, {})));
  const step = (stage) => validateInput(validators.build_pipeline_model, { action: 'add_step', draft_id: 'ctxabc123456', stage });

  assert.equal(step({ stage: 'compute', name: 'capped', expr: { fn: 'least', args: [{ column: 'revenue' }, { value: 100 }] } }).ok, true);
  assert.equal(step({ stage: 'compute', name: 'capped', expr: { fn: 'least', args: [{ column: 'revenue' }, { column: 'budget' }] } }).ok, true);
  assert.equal(step({ stage: 'compute', name: 'capped', expr: { fn: 'greatest', args: [{ column: 'revenue' }, { value: 0 }] } }).ok, true);
  // a threshold computed in the same expression: least(revenue, budget * 2)
  assert.equal(step({ stage: 'compute', name: 'capped', expr: { fn: 'least', args: [{ column: 'revenue' }, { fn: 'mul', args: [{ column: 'budget' }, { value: 2 }] }] } }).ok, true);
  // the old field-per-op spelling is not taken
  assert.equal(step({ stage: 'compute', name: 'capped', op: 'least', columns: ['revenue', 'budget'] }).ok, false, 'one spelling: expr');

  const one = step({ stage: 'compute', name: 'capped', expr: { fn: 'least', args: [{ column: 'revenue' }] } });
  assert.equal(one.ok, false);
  assert.match((one.errors || []).join(' | '), /args.*at least 2/, 'the refusal says how many arguments it needs');
});

// A percentile that is exact on one warehouse is a sketch on another, and a caller reporting "the
// P99" has to know which one it holds. The dialect declares it; the stage says it.
test('the stage says whether this warehouse computes median/percentile exactly or approximately', () => {
  assert.deepEqual(getDialect('bigquery').approximateStats, ['median', 'percentile']);
  assert.deepEqual(getDialect('duckdb').approximateStats, []);

  const describe = (dialect) => {
    const catalog = loadCatalog(CATALOG, { dialect });
    catalog.dialect = dialect;
    const stages = pipelineStageSchema(catalog);
    const branches = stages.anyOf || stages.oneOf || [];
    return branches.find((b) => b.properties?.stage?.enum?.[0] === 'aggregate').description;
  };
  assert.match(describe('bigquery'), /median\/percentile are APPROXIMATE/);
  assert.match(describe('duckdb'), /every measure here is exact/);
  // …and both warn off the global window, since that part is not per warehouse
  for (const d of ['bigquery', 'duckdb']) {
    assert.match(describe(d), /NO group_by/);
    assert.match(describe(d), /Resources exceeded/);
  }
});
