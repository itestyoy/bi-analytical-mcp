// CHECKPOINTS on DATA: a pipeline continued on top of a materialized prefix must return exactly
// the numbers the same pipeline returns when built in one go — and must actually READ that prefix
// instead of recomputing it. The only honest proof of reuse is with numbers: we change the DATA in
// the checkpoint's table and continue; if the continuation reflects the change, it read the table.
// Data-only assertions (no SQL/YAML text anywhere).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { MfEngineBackend } from '../../src/backends/mf-engine.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, readTable } from '../helpers/settle.js';
import { DBT_BIN, MF_BIN, PY_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let wh; let engine; let backend;

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'cpt-')), timeSpineDialect: 'duckdb' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// The pipeline used throughout: completed levels → their score → per-player totals → a filter on
// the totals. Steps 1..3 are the "expensive prefix" a checkpoint stands for; step 4 is the
// continuation. The prefix changes the grain (one row per player), so a checkpoint after it
// carries no event columns — exactly the case worth proving.
const STEPS = [
  { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] },
  { stage: 'derive', name: 'score', op: 'extract', source: 'daily_level_score_of_event_data', type: 'numeric' },
  { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'levels', fn: 'count' }, { name: 'total_score', fn: 'sum', column: 'score' }] },
  { stage: 'where', conditions: [{ column: 'levels', op: 'gte', value: 2 }] },
];

const byPlayer = (rows) => Object.fromEntries(rows.map((r) => [String(r.player_id_of_internal), [num(r.levels), num(r.total_score)]]));

/** Build a draft from `steps`, materializing after each index listed in `pointsAt` (1-based). */
async function build(name, steps, pointsAt = []) {
  const { draft_id } = await engine.build_pipeline_model({ action: 'start', name, source: 'events' });
  let last = null;
  for (let i = 0; i < steps.length; i += 1) {
    await engine.build_pipeline_model({ action: 'add_step', draft_id, stage: steps[i] });
    if (pointsAt.includes(i + 1)) {
      last = await engine.build_pipeline_model({ action: 'materialize', draft_id });
      assert.notEqual(last.ok, false, JSON.stringify(last.error));
    }
  }
  if (!pointsAt.includes(steps.length)) {
    last = await engine.build_pipeline_model({ action: 'materialize', draft_id });
    assert.notEqual(last.ok, false, JSON.stringify(last.error));
  }
  return { draft_id, result: last };
}

test('a pipeline continued on a materialized prefix returns the same rows as one built in one go', opts, async (t) => {
  if (skip(t)) return;
  const whole = await build('cp_whole', STEPS);
  const continued = await build('cp_split', STEPS, [3]); // checkpoint after the aggregate, then step 4
  assert.equal(continued.result.from_checkpoint.at, 3);
  assert.equal(continued.result.steps_recomputed, 1, 'only the step after the prefix was built');
  assert.ok(whole.result.row_count > 0, 'the pipeline returns rows at all');
  assert.deepEqual(byPlayer(continued.result.rows), byPlayer(whole.result.rows));
});

test('editing a step AFTER the prefix keeps it: the numbers still match a full recompute', opts, async (t) => {
  if (skip(t)) return;
  // Two checkpoints (after 3 and after 4), then step 4 is edited: only the second is retired.
  const { draft_id, result: before } = await build('cp_edit', STEPS, [3, 4]);
  assert.equal(before.from_checkpoint.at, 3);
  const edited = { stage: 'where', conditions: [{ column: 'levels', op: 'gte', value: 3 }] };
  const ed = await engine.build_pipeline_model({ action: 'edit_step', draft_id, index: 4, stage: edited });
  assert.equal(ed.from_checkpoint.at, 3, 'the prefix survived an edit below it');
  const after = await engine.build_pipeline_model({ action: 'materialize', draft_id });
  assert.notEqual(after.ok, false, JSON.stringify(after.error));
  assert.equal(after.steps_recomputed, 1);
  const fresh = await build('cp_edit_ref', [...STEPS.slice(0, 3), edited]);
  assert.deepEqual(byPlayer(after.rows), byPlayer(fresh.result.rows));
});

test('the prefix is READ, not recomputed: changing the data in its table changes the continuation', opts, async (t) => {
  if (skip(t)) return;
  const { draft_id, result: built } = await build('cp_reuse', STEPS.slice(0, 3), [3]);
  const before = byPlayer(built.rows);
  const players = Object.keys(before);
  assert.ok(players.length >= 2, 'several players in the prefix');
  // Rewrite the prefix's OWN table: one player's totals become unmistakable values. Recomputing
  // from the source would wipe this out; reading the table carries it through.
  const victim = players.sort()[0];
  await wh.query(`UPDATE main.${built.model} SET levels = 99, total_score = 4242 WHERE player_id_of_internal = '${victim}'`);
  const cont = await engine.build_pipeline_model({ action: 'add_step', draft_id, stage: { stage: 'where', conditions: [{ column: 'levels', op: 'gte', value: 2 }] } });
  assert.equal(cont.from_checkpoint.at, 3);
  const out = await engine.build_pipeline_model({ action: 'materialize', draft_id });
  assert.notEqual(out.ok, false, JSON.stringify(out.error));
  const rows = byPlayer(out.rows);
  assert.deepEqual(rows[victim], [99, 4242], 'the continuation read the materialized prefix');
  // every other player keeps the real numbers the prefix computed
  for (const p of players.filter((x) => x !== victim && before[x][0] >= 2)) assert.deepEqual(rows[p], before[p]);
  // …and the prefix itself was NOT re-materialized: its table still holds exactly what it held
  // before the continuation ran (a recompute would have restored the real totals).
  const prefix = await readTable(engine, draft_id, built.model);
  assert.equal(prefix.ok, true, JSON.stringify(prefix.error));
  assert.deepEqual(byPlayer(prefix.rows)[victim], [99, 4242], 'the prefix table was left alone');
  assert.notEqual(out.model, built.model, 'the continuation built its own model');
});

// A prefix that only FILTERED events still carries the source's own columns, so the stages that read
// them — a funnel, a payload read — keep working on top of it. The numbers must be identical to the
// same pipeline computed in one go.
test('a funnel and a payload read run on top of a materialized event slice, with the same numbers', opts, async (t) => {
  if (skip(t)) return;
  const SLICE = { stage: 'where', conditions: [{ column: 'event_name', op: 'in', value: ['level_started', 'level_completed'] }] };
  const FUNNEL = {
    stage: 'match_recognize',
    partition_by: ['player_id_of_internal'],
    steps: [{ name: 'started', event_name: ['level_started'] }, { name: 'completed', event_name: ['level_completed'] }],
  };
  const COUNT = { stage: 'aggregate', group_by: ['completed'], measures: [{ name: 'players', fn: 'count' }] };

  const whole = await build('cp_fn_whole', [SLICE, FUNNEL, COUNT]);
  const split = await build('cp_fn_split', [SLICE, FUNNEL, COUNT], [1]); // the slice is the prefix
  assert.equal(split.result.from_checkpoint.at, 1);
  assert.equal(split.result.steps_recomputed, 2);
  const tally = (r) => Object.fromEntries(r.rows.map((x) => [String(x.completed), num(x.players)]));
  assert.ok(Object.keys(tally(whole.result)).length > 0, 'the funnel returns rows at all');
  assert.deepEqual(tally(split.result), tally(whole.result));

  // The payload column survived the slice too, so a derive on top of the prefix reads it.
  const wholeScore = await build('cp_pl_whole', [SLICE, STEPS[1], { stage: 'aggregate', group_by: [], measures: [{ name: 'total', fn: 'sum', column: 'score' }] }]);
  const splitScore = await build('cp_pl_split', [SLICE, STEPS[1], { stage: 'aggregate', group_by: [], measures: [{ name: 'total', fn: 'sum', column: 'score' }] }], [1]);
  assert.equal(splitScore.result.from_checkpoint.at, 1);
  assert.equal(num(splitScore.result.rows[0].total), num(wholeScore.result.rows[0].total));
  assert.ok(num(wholeScore.result.rows[0].total) > 0, 'the payload actually carried values');
});

test('a fork inherits the prefix: same numbers as an independent recompute, and the table is only read', opts, async (t) => {
  if (skip(t)) return;
  const { draft_id, result: built } = await build('cp_parent', STEPS.slice(0, 3), [3]);
  const fork = await engine.build_pipeline_model({ action: 'fork', draft_id, after: 3, name: 'cp_fork' });
  assert.deepEqual(fork.inherited_checkpoints, [{ at: 3, model: built.model, owner: draft_id }]);
  const tail = { stage: 'where', conditions: [{ column: 'total_score', op: 'gte', value: 1 }] };
  await engine.build_pipeline_model({ action: 'add_step', draft_id: fork.draft_id, stage: tail });
  const forked = await engine.build_pipeline_model({ action: 'materialize', draft_id: fork.draft_id });
  assert.notEqual(forked.ok, false, JSON.stringify(forked.error));
  assert.equal(forked.from_checkpoint.model, built.model, "the fork read the parent's table");
  const independent = await build('cp_fork_ref', [...STEPS.slice(0, 3), tail]);
  assert.deepEqual(byPlayer(forked.rows), byPlayer(independent.result.rows));

  // And the inherited model is NOT rebuilt in the fork: change the DATA in the parent's table, then
  // branch a second fork over it. Recomputing the prefix would wipe the change out; reading the
  // inherited table carries it into the fork's own result.
  const victim = Object.keys(byPlayer(built.rows)).sort()[0];
  await wh.query(`UPDATE main.${built.model} SET total_score = 7777 WHERE player_id_of_internal = '${victim}'`);
  const fork2 = await engine.build_pipeline_model({ action: 'fork', draft_id, after: 3, name: 'cp_fork2' });
  assert.deepEqual(fork2.inherited_checkpoints, [{ at: 3, model: built.model, owner: draft_id }]);
  await engine.build_pipeline_model({ action: 'add_step', draft_id: fork2.draft_id, stage: tail });
  const tampered = await engine.build_pipeline_model({ action: 'materialize', draft_id: fork2.draft_id });
  assert.notEqual(tampered.ok, false, JSON.stringify(tampered.error));
  assert.equal(byPlayer(tampered.rows)[victim][1], 7777, 'the inherited table was read, never rebuilt');
});
