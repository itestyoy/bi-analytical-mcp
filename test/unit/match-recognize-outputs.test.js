// WHAT A FUNNEL STAGE OUTPUTS — its columns and their types, and the names a capture may not take.
//
// Allowed non-data tests: the column set a match_recognize stage leaves for the next stage (column
// propagation, no warehouse — with the type and the text mark the next stage compares in) and what a
// capture or a condition on one is refused with (input validation). No SQL text is asserted; the
// funnel's numbers are proven against the warehouse in test/integration/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { renderPipeline } from '../../src/pipeline.js';
import '../../src/match-recognize.js';
import { deref, field } from '../helpers/schema-nav.js';
import { stageBranch } from '../helpers/stage-schema.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});

function engine() {
  return new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mro-')) }) });
}

// What the warehouse says the events relation holds (a stub of its column listing): each column in
// the type the catalog declares it — a flag the catalog calls a string is kept as text.
const WAREHOUSE_TYPE = { time: 'TIMESTAMP', numeric: 'BIGINT', string: 'VARCHAR' };
const SOURCE_COLS = (() => {
  const cols = catalog.modelColumns('events').filter((c) => WAREHOUSE_TYPE[c.type]);
  return Object.assign(new Set(cols.map((c) => c.name)), { types: new Map(cols.map((c) => [c.name, WAREHOUSE_TYPE[c.type]])) });
})();

const funnel = (extra = {}) => ({
  stage: 'match_recognize', partition_by: ['player_id_of_internal'],
  steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }],
  ...extra,
});

async function columnsAfter(e, stage) {
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  const added = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [stage], include_columns: true });
  return { context_id, types: new Map(added.available_columns.map((c) => [c.name, c.type])) };
}

test('a capture cannot take the name of a column the funnel outputs anyway', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  // the fixed columns, the partition key, each step's own, and a capture taken twice
  for (const name of ['completed', 'first_seen_at', 'furthest_step_name', 'player_id_of_internal', 'reached_a', 'at_b']) {
    await assert.rejects(
      () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [funnel({ capture: [{ name, step: 'b', column: 'level_id_of_event_data' }] })] }),
      (err) => err.field === 'stages[0]' && new RegExp(`capture '${name}': the funnel already outputs a column of that name`).test(err.message),
      name,
    );
  }
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [funnel({ capture: [{ name: 'lvl', step: 'a', column: 'level_id_of_event_data' }, { name: 'lvl', step: 'b', column: 'level_id_of_event_data' }] })] }),
    /capture 'lvl': the funnel already outputs a column of that name/,
  );
  // nor the name of a working column of the match itself (the axis, each step's time and flag)
  for (const name of ['ts', 't1', 't2', 'is1', 'is2']) {
    await assert.rejects(
      () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [funnel({ capture: [{ name, step: 'b', column: 'level_id_of_event_data' }] })] }),
      new RegExp(`capture '${name}': the funnel uses that name for a working column of its own`),
      name,
    );
  }
  // a name of its own is a column of its own, of the captured column's type — the fixed ones keep theirs
  const { types } = await columnsAfter(e, funnel({ capture: [{ name: 'lvl', step: 'b', column: 'level_id_of_event_data' }] }));
  assert.deepEqual([types.get('lvl'), types.get('completed'), types.get('first_seen_at')], ['numeric', 'boolean', 'time']);
});

test('only the working columns THIS funnel makes are refused as a capture name — one per step it has', async () => {
  const e = engine();
  // two steps: t1, t2, is1, is2 are the match's own; a step it does not have makes no column
  const two = (await columnsAfter(e, funnel({ capture: ['t3', 'is3', 't30', 'is5'].map((name) => ({ name, step: 'b', column: 'level_id_of_event_data' })) }))).types;
  assert.deepEqual(['t3', 'is3', 't30', 'is5'].map((c) => two.get(c)), ['numeric', 'numeric', 'numeric', 'numeric']);
  // three steps: t3 and is3 are now its own
  const three = funnel({ steps: [...funnel().steps, { name: 'c', event_name: ['level_started'] }] });
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  for (const name of ['t3', 'is3']) {
    await assert.rejects(
      () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ ...three, capture: [{ name, step: 'c', column: 'level_id_of_event_data' }] }] }),
      new RegExp(`capture '${name}': the funnel uses that name for a working column of its own`),
      name,
    );
  }
});

test('a capture or a partition column named like an SQL keyword is a column like any other, in both lowerings', async () => {
  // the names are written into the funnel's SQL quoted by the warehouse's dialect, so a keyword
  // (group, order, select) is a column name there; the rows it holds are the integration tests' to show
  const keywords = ['group', 'order', 'select'];
  const capture = keywords.map((name, i) => ({ name, step: i ? 'b' : 'a', column: 'level_id_of_event_data' }));
  const { types } = await columnsAfter(engine(), funnel({ capture }));
  assert.deepEqual(keywords.map((c) => types.get(c)), ['numeric', 'numeric', 'numeric']);
  for (const dialect of ['duckdb', 'bigquery']) {
    const { columns } = renderPipeline(catalog, dialect, 'events', [
      { stage: 'compute', name: 'from', expr: { column: 'player_id_of_internal' } },
      funnel({ partition_by: ['from'], between_steps: 'gap', capture }),
    ], { physicalCols: SOURCE_COLS });
    assert.deepEqual(['from', ...keywords].map((c) => columns.get(c)?.type), ['string', 'numeric', 'numeric', 'numeric'], dialect);
  }
});

test('a capture of a column the warehouse stores as text keeps that mark, as a copy of a column does', async () => {
  // is_clicked_of_event_data is a flag kept as text: a boolean is compared with it by its spellings,
  // and a comparison text cannot spell is refused — on the capture as on the column it copies
  const e = engine();
  e.probe.physicalColumns = async () => SOURCE_COLS;
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  const captured = funnel({ capture: [{ name: 'clicked', step: 'b', column: 'is_clicked_of_event_data' }] });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [captured, { stage: 'where', conditions: [{ column: 'clicked', op: 'gt', value: true }] }] }),
    /'clicked' is a text column in the warehouse/,
  );
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [captured, { stage: 'where', conditions: [{ column: 'clicked', op: 'eq', value: true }] }] });
  assert.equal(ok.steps_count, 2);
  // the column map the next stage reads: the capture is marked as the compute copy of the same column is
  for (const dialect of ['duckdb', 'bigquery']) {
    const { columns } = renderPipeline(catalog, dialect, 'events', [
      { stage: 'compute', name: 'copied', expr: { column: 'is_clicked_of_event_data' } },
      { ...captured, capture: [...captured.capture, { name: 'copied_at_a', step: 'a', column: 'copied' }] },
    ], { physicalCols: SOURCE_COLS });
    assert.deepEqual(['clicked', 'copied_at_a'].map((c) => columns.get(c)), [{ type: 'string', physical: true }, { type: 'string', physical: true }], dialect);
    // a kept draft's value at a step (agg_at_step) is the same copy
    const kept = renderPipeline(catalog, dialect, 'events', [funnel({ metrics: [{ type: 'agg_at_step', name: 'clk', step: 'b', property: 'is_clicked_of_event_data' }] })], { physicalCols: SOURCE_COLS });
    assert.deepEqual(kept.columns.get('pv_clk'), { type: 'string', physical: true }, dialect);
  }
});

test('a capture naming a step the funnel does not have is refused as the capture it is', async () => {
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [funnel({ capture: [{ name: 'x', step: 'zz', column: 'level_id_of_event_data' }] })] }),
    (err) => /capture 'x' names step 'zz'/.test(err.message) && /steps: a, b/.test(err.message) && !/metric/.test(err.message),
  );
});

test('at_<step> and first_seen_at are of the sequence axis\'s type: a moment by default, a number when ordered by one', async () => {
  const e = engine();
  const byTime = (await columnsAfter(e, funnel())).types;
  assert.deepEqual(['first_seen_at', 'at_a', 'at_b'].map((c) => byTime.get(c)), ['time', 'time', 'time']);
  const { context_id, types } = await columnsAfter(e, funnel({ order_by: 'session_number' }));
  assert.deepEqual(['first_seen_at', 'at_a', 'at_b'].map((c) => types.get(c)), ['numeric', 'numeric', 'numeric']);
  // two of them compare as numbers: a constant is written as one, and a date is refused as the number column it is
  const ok = await e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'at_b', op: 'gt', right: { column: 'at_a' } }, { column: 'at_a', op: 'gte', value: '2' }] }] });
  assert.equal(ok.steps_count, 2);
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [{ stage: 'where', conditions: [{ column: 'at_a', op: 'gte', value: '2026-01-01' }] }] }),
    /'at_a' is a numeric column/,
  );
});

test('between_steps is the one choice of what lies between steps: any by default, none only where the warehouse matches adjacent events', async () => {
  const choices = (options) => {
    const e = new Engine({ catalog: loadCatalog(CATALOG, options), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mro-')) }) });
    const bpm = e.schemas.build_pipeline_model;
    return deref(bpm, field(bpm, stageBranch(bpm, 'match_recognize'), 'between_steps'));
  };
  const duck = choices({}); const bq = choices({ dialect: 'bigquery' });
  assert.deepEqual(duck.enum, ['any', 'gap']);
  assert.deepEqual(bq.enum, ['any', 'gap', 'none']);
  assert.equal(duck.default, 'any');
  // `mode` is gone: the choice it made is between_steps' — refused, not read beside it
  const e = engine();
  const { context_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [funnel({ mode: 'strict' })] }), /unexpected property 'mode'/);
  await assert.rejects(() => e.build_pipeline_model({ action: 'add_steps', context_id, stages: [funnel({ between_steps: 'none' })] }), /between_steps/);
  // where a row-pattern match runs it, the adjacent-events funnel builds the same columns as any other
  const cols = (between) => [...renderPipeline(catalog, 'bigquery', 'events', [funnel({ between_steps: between })], { physicalCols: SOURCE_COLS }).columns.keys()];
  assert.deepEqual(cols('none'), cols('any'));
  assert.deepEqual(cols(undefined), cols('gap'));
});
