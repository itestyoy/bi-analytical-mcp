// WHAT A FUNNEL STAGE OUTPUTS — its columns and their types, and the names a capture may not take.
//
// Allowed non-data tests: the column set a match_recognize stage leaves for the next stage (column
// propagation, no warehouse) and what a capture is refused with (input validation). No SQL text is
// asserted; the funnel's numbers are proven against the warehouse in test/integration/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));

function engine() {
  return new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'mro-')) }) });
}

const funnel = (extra = {}) => ({
  stage: 'match_recognize', partition_by: ['player_id_of_internal'],
  steps: [{ name: 'a', event_name: ['first_launch'] }, { name: 'b', event_name: ['tutorial'] }],
  ...extra,
});

async function columnsAfter(e, stage) {
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  const added = await e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [stage], include_columns: true });
  return { draft_id, types: new Map(added.available_columns.map((c) => [c.name, c.type])) };
}

test('a capture cannot take the name of a column the funnel outputs anyway', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  // the fixed columns, the partition key, each step's own, and a capture taken twice
  for (const name of ['completed', 'first_seen_at', 'furthest_step_name', 'player_id_of_internal', 'reached_a', 'at_b']) {
    await assert.rejects(
      () => e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [funnel({ capture: [{ name, step: 'b', column: 'level_id_of_event_data' }] })] }),
      (err) => err.field === 'stages[0]' && new RegExp(`capture '${name}': the funnel already outputs a column of that name`).test(err.message),
      name,
    );
  }
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [funnel({ capture: [{ name: 'lvl', step: 'a', column: 'level_id_of_event_data' }, { name: 'lvl', step: 'b', column: 'level_id_of_event_data' }] })] }),
    /capture 'lvl': the funnel already outputs a column of that name/,
  );
  // nor the name of a working column of the match itself (each step's time and flag)
  for (const name of ['ts', 't1', 'is2']) {
    await assert.rejects(
      () => e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [funnel({ capture: [{ name, step: 'b', column: 'level_id_of_event_data' }] })] }),
      new RegExp(`capture '${name}': the funnel uses that name for a working column of its own`),
      name,
    );
  }
  // a name of its own is a column of its own, of the captured column's type — the fixed ones keep theirs
  const { types } = await columnsAfter(e, funnel({ capture: [{ name: 'lvl', step: 'b', column: 'level_id_of_event_data' }] }));
  assert.deepEqual([types.get('lvl'), types.get('completed'), types.get('first_seen_at')], ['numeric', 'boolean', 'time']);
});

test('a capture naming a step the funnel does not have is refused as the capture it is', async () => {
  const e = engine();
  const { draft_id } = await e.build_pipeline_model({ action: 'start', name: 'mro', source: 'events' });
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [funnel({ capture: [{ name: 'x', step: 'zz', column: 'level_id_of_event_data' }] })] }),
    (err) => /capture 'x' names step 'zz'/.test(err.message) && /steps: a, b/.test(err.message) && !/metric/.test(err.message),
  );
});

test('at_<step> and first_seen_at are of the sequence axis\'s type: a moment by default, a number when ordered by one', async () => {
  const e = engine();
  const byTime = (await columnsAfter(e, funnel())).types;
  assert.deepEqual(['first_seen_at', 'at_a', 'at_b'].map((c) => byTime.get(c)), ['time', 'time', 'time']);
  const { draft_id, types } = await columnsAfter(e, funnel({ order_by: 'session_number' }));
  assert.deepEqual(['first_seen_at', 'at_a', 'at_b'].map((c) => types.get(c)), ['numeric', 'numeric', 'numeric']);
  // two of them compare as numbers: a constant is written as one, and a date is refused as the number column it is
  const ok = await e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [{ stage: 'where', conditions: [{ left: { column: 'at_b' }, op: 'gt', right: { column: 'at_a' } }, { column: 'at_a', op: 'gte', value: '2' }] }] });
  assert.equal(ok.steps_count, 2);
  await assert.rejects(
    () => e.build_pipeline_model({ action: 'add_steps', draft_id, stages: [{ stage: 'where', conditions: [{ column: 'at_a', op: 'gte', value: '2026-01-01' }] }] }),
    /'at_a' is a numeric column/,
  );
});
