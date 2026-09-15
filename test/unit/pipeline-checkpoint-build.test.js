// A materialized prefix and a build that takes MINUTES meet here. A pipeline with a python stage
// builds detached: the call returns a query_id and the table appears later. That leaves a window in
// which the prefix EXISTS as a plan but not yet as a table — and a caller who lost the response
// (dropped connection) retries the same materialize. Nothing in that window may build the same
// model twice, and nothing may wait forever on a build whose builder is gone.
//
// Allowed non-data tests: what a second materialize is REFUSED with (input validation) and what the
// draft/registry/job records hold (context lifecycle). No SQL/YAML text is asserted anywhere; the
// numbers a continued pipeline returns are proven in test/integration/pipeline-checkpoint.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
process.env.MCP_PYTHON_MODELS = 'on'; // the fixture loads without a dbt profile; a python stage is what makes a build detach
const VENV_PY = join(process.cwd(), '.dbtvenv', 'bin', 'python');
const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';
const HAS_PY = spawnSync(PY, ['--version']).status === 0;
const skipNoPy = (t) => { if (!HAS_PY) { t.skip('no python interpreter for the static gate'); return true; } return false; };

const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'revenue', fn: 'sum', column: 'price_in_usd_of_event_data' }] };
const PY_STAGE = {
  stage: 'python',
  imports: [{ package: 'numpy' }],
  functions: [{ name: 'zscore', params: ['df', 'column', 'as_'], body: ['df[as_] = (df[column] - df[column].mean()) / df[column].std(ddof=0)', 'return df'] }],
  steps: [{ call: 'zscore', args: { column: 'revenue', as_: 'revenue_z' } }],
  output: { columns: ['player_id_of_internal', 'revenue', 'revenue_z'] },
};
const TAIL = { stage: 'where', conditions: [{ column: 'revenue_z', op: 'gte', value: 0 }] };

/** A runner whose builds finish WHEN THE TEST SAYS SO — that is the long-running model. */
function heldRunner() {
  const r = {
    held: [],
    async run() { return new Promise((resolve) => { r.held.push(resolve); }); },
    async show() { return { ok: true, rows: [], columns: [] }; },
    async parse() { return { ok: true }; },
    async relationColumns() { return { ok: false }; },
    /** Let the oldest in-flight build finish (ok) or fail. */
    finish(ok = true) {
      const resolve = r.held.shift();
      assert.ok(resolve, 'a build was in flight');
      resolve(ok ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: 'boom' });
    },
  };
  return r;
}

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });
const settled = async () => { for (let i = 0; i < 20; i += 1) await tick(); };
/** Wait until a build is actually in flight (compiling + gating a python stage takes a moment). */
const untilHeld = async (runner) => { for (let i = 0; i < 400 && !runner.held.length; i += 1) await tick(5); };
/** Run a SYNCHRONOUS build (no python stage after the prefix → one model, awaited) to completion. */
const runSync = async (promise, runner, ok = true) => { await untilHeld(runner); runner.finish(ok); return promise; };

function engine(runner, { workspaceRoot, registryPath } = {}) {
  const ctxs = new ContextManager({ workspaceRoot: workspaceRoot || mkdtempSync(join(tmpdir(), 'cpb-')), registryPath });
  // A tiny window on purpose: any real build is "slow" then, so every build here takes the
  // detached path a minutes-long model takes in production.
  return new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: ctxs, runner, pythonBin: PY, queryTimeoutMs: 20 });
}

const draftOf = (e, id) => e.ctxs.get(id).state.draft;
const add = (e, draft_id, stage) => e.build_native_model({ action: 'add_step', draft_id, stage });
const materialize = (e, draft_id) => e.build_native_model({ action: 'materialize', draft_id });

async function startedDraft(e, name = 'seg') {
  const { draft_id } = await e.build_native_model({ action: 'start', name, source: 'events' });
  await add(e, draft_id, AGG);
  await add(e, draft_id, PY_STAGE);
  return draft_id;
}

test('a slow build goes to the background; the retried materialize builds nothing new and names the job', async (t) => {
  if (skipNoPy(t)) return;
  const runner = heldRunner();
  const e = engine(runner);
  const draft_id = await startedDraft(e);

  const bg = await materialize(e, draft_id);
  assert.equal(bg.status, 'running', 'a build past the window hands back a query_id');
  assert.match(bg.query_id, /^[a-f0-9]{8,16}$/);
  assert.equal(bg.read_with.table, bg.model);
  // The prefix is already a PLAN (its columns are known) but not yet a table.
  const cp = draftOf(e, draft_id).checkpoints;
  assert.equal(cp.length, 1);
  assert.deepEqual([cp[0].at, cp[0].model, cp[0].query_id], [2, bg.model, bg.query_id]);
  assert.equal(runner.held.length, 1, 'exactly one build in flight');

  // The caller lost the response and retries the SAME materialize: refused, pointing at the job.
  await assert.rejects(() => materialize(e, draft_id), (err) => {
    assert.match(err.message, /still being materialized/);
    assert.match(err.message, new RegExp(bg.query_id));
    return true;
  });
  assert.equal(runner.held.length, 1, 'no second build was started');
  assert.equal(draftOf(e, draft_id).checkpoints.length, 1, 'and no second prefix was recorded');
  // A client that lost the query_id can still find it.
  assert.ok(e.list_query_jobs().jobs.some((j) => j.query_id === bg.query_id && j.table === bg.model));
  assert.deepEqual(await e.get_query_result({ query_id: bg.query_id }), { ok: true, status: 'running', query_id: bg.query_id, table: bg.model });

  // Meanwhile the draft keeps growing — validation needs the prefix's COLUMNS, not its table.
  const step = await add(e, draft_id, TAIL);
  assert.equal(step.from_checkpoint.model, bg.model);
  assert.equal(step.steps_recomputed, 1);
  // …but building on a table that does not exist yet is still refused.
  await assert.rejects(() => materialize(e, draft_id), /still being materialized/);

  // The background build lands. Now the continuation runs, and ONLY the new step.
  runner.finish(true);
  await settled();
  // the continuation is plain SQL → one model, built synchronously
  const done = await runSync(materialize(e, draft_id), runner);
  assert.equal(done.from_checkpoint.at, 2);
  assert.equal(done.steps_recomputed, 1);
  assert.notEqual(done.model, bg.model, 'a rebuild never overwrites the table it reads');
  assert.deepEqual(draftOf(e, draft_id).checkpoints.map((c) => c.at), [2, 3]);
  assert.ok(e.ctxs.hasPipelineModel(draft_id, bg.model), 'the prefix is still there to be read again');
});

test('two materialize calls at once: the second is refused and the draft keeps ONE prefix', async (t) => {
  if (skipNoPy(t)) return;
  const runner = heldRunner();
  const e = engine(runner);
  const draft_id = await startedDraft(e);

  const first = materialize(e, draft_id); // in flight before the second call is made
  await assert.rejects(() => materialize(e, draft_id), /already in flight/);
  const bg = await first;
  assert.equal(bg.status, 'running');
  assert.equal(runner.held.length, 1, 'one build, not two');
  assert.equal(draftOf(e, draft_id).checkpoints.length, 1);
  runner.finish(true);
  await settled();
});

test('a background build that FAILED retires the prefix, and the next materialize rebuilds from the source', async (t) => {
  if (skipNoPy(t)) return;
  const runner = heldRunner();
  const e = engine(runner);
  const draft_id = await startedDraft(e);
  const bg = await materialize(e, draft_id);
  assert.equal(bg.status, 'running');
  runner.finish(false); // dbt failed on the warehouse
  await settled();
  assert.equal((await e.get_query_result({ query_id: bg.query_id })).status, 'error');

  const out = await materialize(e, draft_id); // the whole pipeline again → detached again
  assert.equal(out.status, 'running');
  assert.equal(out.from_checkpoint, undefined, 'nothing was reused');
  assert.match(out.checkpoints_dropped[0].reason, /failed/);
  assert.equal(out.steps_recomputed, undefined);
  assert.deepEqual(draftOf(e, draft_id).checkpoints.map((c) => c.at), [2], 'exactly one prefix — the new one');
  assert.notEqual(draftOf(e, draft_id).checkpoints[0].model, bg.model, 'and it is a new model, not the failed one');
  runner.finish(true);
  await settled();
});

test('a build whose builder is gone does not wedge the draft: the restart retires it and rebuilds', async (t) => {
  if (skipNoPy(t)) return;
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'cpb-'));
  const registryPath = join(workspaceRoot, 'registry.json');
  const runner = heldRunner();
  const e = engine(runner, { workspaceRoot, registryPath });
  const draft_id = await startedDraft(e);
  const bg = await materialize(e, draft_id);
  assert.equal(bg.status, 'running');
  // Pretend the response was being written when the process died mid-build.
  draftOf(e, draft_id).building = { started_at: new Date().toISOString(), model: bg.model };
  e.ctxs.touch(draft_id);

  // A new process reads the same registry: no in-flight marker survives it…
  const runner2 = heldRunner();
  const e2 = engine(runner2, { workspaceRoot, registryPath });
  assert.equal(draftOf(e2, draft_id).building, undefined);
  assert.equal(draftOf(e2, draft_id).checkpoints.length, 1, 'the prefix record itself survived');
  // …and the prefix whose build nobody is driving any more is retired instead of waited on.
  const out = await materialize(e2, draft_id); // the whole pipeline again → detached again
  assert.equal(out.status, 'running');
  assert.equal(out.from_checkpoint, undefined, 'the unfinished prefix was not read');
  assert.match(out.checkpoints_dropped[0].reason, /did not finish|no job record/);
  assert.deepEqual(draftOf(e2, draft_id).checkpoints.map((c) => c.at), [2]);
  runner2.finish(true);
  runner.finish(true); // release the abandoned build of the first "process"
  await settled();
});

test('a view prefix is called out (reading it re-runs its SQL), and describe_context shows the open draft', async (t) => {
  if (skipNoPy(t)) return;
  const runner = heldRunner();
  const e = engine(runner);
  const { draft_id } = await e.build_native_model({ action: 'start', name: 'slice', source: 'events', materialized: 'view' });
  await add(e, draft_id, { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'level_completed' }] });
  const r = await runSync(materialize(e, draft_id), runner);
  assert.equal(r.materialized, 'view');
  assert.ok(r.warnings.some((w) => /VIEW/.test(w)), 'a view is not a computed prefix — said once, here');
  assert.equal(r.checkpoint.carries_source, 'events', 'a filtered slice is still the source\'s events');

  const d = await e.describe_context({ context_id: draft_id });
  assert.deepEqual(d.draft.checkpoints.map((c) => [c.at, c.model, c.carries_source]), [[1, r.model, 'events']]);
  assert.equal(d.draft.steps.length, 1);
  // preview says what materialize would actually build now (nothing — everything is the table).
  const pv = await e.build_native_model({ action: 'preview', draft_id });
  assert.equal(pv.steps_recomputed, 0);
  assert.match(pv.checkpoint_note, /Every step is already materialized/);
  await assert.rejects(() => materialize(e, draft_id), /nothing to build/);
});

// Editing a step retires the prefixes at or after it and removes their files — but a build that is
// STILL RUNNING hands its table back through get_query_result, which reads it by ref. Removing the
// definition mid-build would make that result unreadable for good.
test('an edit during a background build does not remove the files that build is producing', async (t) => {
  if (skipNoPy(t)) return;
  const runner = heldRunner();
  const e = engine(runner);
  const draft_id = await startedDraft(e);
  const bg = await materialize(e, draft_id);
  assert.equal(bg.status, 'running');

  // an edit BELOW the pending prefix retires it (its table is not to be read as a prefix)…
  const ed = await e.build_native_model({ action: 'edit_step', draft_id, index: 1, stage: AGG });
  assert.deepEqual(ed.checkpoints_dropped.map((d) => d.model), [bg.model]);
  assert.deepEqual(draftOf(e, draft_id).checkpoints, []);
  // …but the model it is building stays on disk, so the job's own result is still readable
  assert.ok(e.ctxs.hasPipelineModel(draft_id, bg.model), 'the running build keeps its definition');
  runner.finish(true);
  await settled();
  assert.equal((await e.get_query_result({ query_id: bg.query_id })).status !== 'error', true);
});
