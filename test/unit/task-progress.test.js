// A RUNNING TASK SAYS HOW FAR IT IS (src/task-runner.js progressOf): how long since it was started,
// whether it still waits behind earlier work on its context, and which process it is on — reported
// by the one place that spawns processes (src/dbt/process.js). And a where bounding a timestamp by a
// bare date is told what that date means (src/engine/pipeline-warnings.js). Lifecycle and advice only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { JobManager } from '../../src/jobs.js';
import { TaskRunner } from '../../src/task-runner.js';
import { runProcess } from '../../src/dbt/process.js';

const sides = { query_pipeline_model: 'pipeline' };
const ctxs = { acquire() {}, release() {} };
const ctx = { id: 'c1' };

test('a read of a running task names its phase — queued behind the work before it, then running the process it is on', async () => {
  const jobs = new JobManager();
  const runner = new TaskRunner({ jobs, ctxs, sideOf: (tool) => sides[tool] || null, readers: { pipeline: 'query_pipeline_model' } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runner.start(ctx, 'query_pipeline_model', () => gate.then(() => runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 400)'])).then(() => ({ ok: true })));
  const second = runner.start(ctx, 'query_pipeline_model', async () => ({ ok: true }));
  await new Promise((r) => setTimeout(r, 20));

  const running = runner.status(first).pending;
  assert.equal(running.status, 'running');
  assert.equal(running.phase, 'running');
  assert.equal(typeof running.elapsed_seconds, 'number');
  assert.equal(running.step, undefined, 'no process yet');
  assert.equal(runner.status(second).pending.phase, 'queued', 'the second waits for the first on the same context');

  release();
  await new Promise((r) => setTimeout(r, 100));
  const onProcess = runner.status(first).pending;
  assert.equal(onProcess.step, basename(process.execPath));
  assert.equal(onProcess.step_state, 'running');

  await runner.runs.get(first);
  await runner.runs.get(second);
  assert.equal(runner.status(first).pending, null, 'finished: nothing pending');
  assert.equal(runner.progress.size, 0, 'progress is dropped with the run');
  jobs.close();
});

test('a where that bounds a time column from above by a bare date is told so; a full timestamp or a lower bound is not', async () => {
  const { PipelineAdvisor } = await import('../../src/engine/pipeline-warnings.js');
  const advisor = new PipelineAdvisor({ catalog: null, valueIndex: null });
  const cols = [{ name: 'event_at', type: 'time' }, { name: 'event_name', type: 'categorical' }];
  const warned = (conditions) => advisor.dateBoundWarnings({ stage: 'where', conditions }, cols).length;
  assert.equal(warned([{ column: 'event_at', op: 'between', value: ['2026-01-01', '2026-01-31'] }]), 1);
  assert.equal(warned([{ or: [{ column: 'event_at', op: 'lte', value: '2026-01-31' }] }]), 1);
  assert.equal(warned([{ column: 'event_at', op: 'lte', value: '2026-01-31 23:59:59' }]), 0);
  assert.equal(warned([{ column: 'event_at', op: 'gte', value: '2026-01-01' }, { column: 'event_at', op: 'lt', value: '2026-02-01' }]), 0);
  assert.equal(warned([{ column: 'event_name', op: 'lte', value: '2026-01-31' }]), 0, 'not a time column');
});
