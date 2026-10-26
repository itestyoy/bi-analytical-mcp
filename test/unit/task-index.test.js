// THE TASK INDEX (src/task-index.js) — what has been asked of this server, by meaning: every task
// started is kept as a line of text with its vector; semantic_index({ request: { tasks } }) finds the
// tasks like a phrase and clusters a period into themes. Checked on what it returns: which tasks
// come first, which fall together, what a window and a phrase keep — and that nothing it answers
// leads back to a task's data.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store.js';
import { TaskIndex, TASK_DIMS, kmeans, localVectors, taskText } from '../../src/task-index.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { tempDir } from '../helpers/temp-dir.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const opened = [];
after(() => { for (const close of opened) close(); });

// three subjects, four tasks each, on three days
const TOPICS = {
  ads: ['rewarded ad impressions and ecpm by network', 'interstitial ad revenue per network', 'banner ad impressions per placement and network', 'ad revenue ecpm of rewarded video by network'],
  retention: ['day 7 retention of new installs by country', 'retention d1 d7 cohorts of installs by week', 'retention of installs from organic by country', 'install cohort retention curve d1 d3 d7'],
  crashes: ['crash rate and anr by app version', 'fatal crashes by device model and app version', 'anr and crash counts after the update by version', 'crash free players by app version and device'],
};
const DAY = Date.UTC(2026, 9, 20);

const TASKS = Object.entries(TOPICS).flatMap(([topic, texts]) => texts.map((t) => ({ topic, t })))
  .map(({ topic, t }, i) => ({ id: `${topic}${i}`, tool: 'build_model', ctx: { state: { draft: { name: `${topic}_${i}`, description: t, source: 'events' } } }, at: DAY + (i % 3) * 86400000 }));
function seeded(index) {
  for (const task of TASKS) index.record(task);
}
const topicOf = (task) => Object.keys(TOPICS).find((k) => task.startsWith(`${k} `));

for (const [label, store] of [['in memory', () => openStore()], ['sqlite', () => openStore({ dbPath: join(tempDir('task-index'), 'store.db') })]]) {
  test(`${label}: the tasks like a phrase come first, and nothing answered leads back to a task`, async () => {
    const s = store(); opened.push(() => s.close?.());
    const index = new TaskIndex({ store: s });
    seeded(index);
    const found = await index.similar({ search: 'retention of installs by country cohorts', limit: 4 });
    assert.equal(found.searched, 12);
    assert.deepEqual(found.tasks.map((t) => topicOf(t.task)), ['retention', 'retention', 'retention', 'retention']);
    for (const t of found.tasks) for (const k of ['id', 'task_id', 'context_id', 'table']) assert.equal(k in t, false, `${k} is not said`);
  });

  test(`${label}: a period clusters into its themes, a window and a phrase narrowing what is clustered`, async () => {
    const s = store(); opened.push(() => s.close?.());
    const index = new TaskIndex({ store: s });
    seeded(index);
    const all = await index.themes({});
    assert.equal(all.tasks_in_window, 12);
    assert.equal(all.themes.length, 3);
    for (const th of all.themes) {
      assert.equal(th.tasks, 4);
      assert.equal(new Set(th.examples.map((x) => topicOf(x.task))).size, 1, 'a theme holds one subject');
    }
    // the first day only: one task of every third
    const day1 = await index.themes({ time_range: { start: '2026-10-20', end: '2026-10-20' } });
    assert.equal(day1.tasks_in_window, 4);
    const about = await index.themes({ about: 'crash anr app version' });
    assert.equal(about.tasks_about, 4);
    assert.deepEqual(about.themes.flatMap((t) => t.examples.map((x) => topicOf(x.task))).filter((x) => x !== 'crashes'), []);
  });
}

test('with an embedder: vectors are its, asked at TASK_DIMS, stored with its model, and made again for another model', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const calls = [];
  // a stand-in embedder: the local vectors over the texts the index keeps, so the subjects stay apart
  const local = localVectors(TASKS.map((t) => taskText(t)));
  const embedder = (model) => ({ model, embed: async (texts, opts) => { calls.push({ model, n: texts.length, opts }); return texts.map((t) => local.of(t)); } });
  const index = new TaskIndex({ store: s, embedder: embedder('m1') });
  seeded(index);
  const themes = await index.themes({});
  assert.equal(themes.model, `m1@${TASK_DIMS}`);
  assert.equal(themes.themes.length, 3);
  assert.ok(calls.every((c) => c.opts?.dimensions === TASK_DIMS));
  assert.equal(s.taskLog.missing(`m1@${TASK_DIMS}`).length, 0, 'every task has its vector');
  // a deployment that switches models: the rows are embedded again when the index is read
  const other = new TaskIndex({ store: s, embedder: embedder('m2') });
  const again = await other.similar({ search: 'crash by app version', limit: 2 });
  assert.equal(again.searched, 12);
  assert.deepEqual(again.tasks.map((t) => topicOf(t.task)), ['crashes', 'crashes']);
});

test('a clustering is the same on every run', () => {
  const { vectors } = localVectors(Object.values(TOPICS).flat());
  assert.deepEqual(kmeans(vectors, 3).assign, kmeans(vectors, 3).assign);
});

test('every task a tool starts is recorded as it starts; semantic_index reads the index, its two forms apart', async () => {
  const e = new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: tempDir('task-index-engine') }) });
  opened.push(() => e.close());
  const steps = [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'level_completed' }] }] }];
  const id = e.tasks.start(null, 'build_model', async () => ({ ok: true }), { input: { source: 'events', context_id: 'abc123', from_task: 'aaaaaaaaaaaa', steps } });
  assert.ok(e.store.taskLog.has(id));
  const found = await e.semantic_index({ tasks: { search: 'level completed' } });
  assert.equal(found.searched, 1);
  // how it was computed is said — its steps — and nothing that names stored work
  assert.deepEqual(found.tasks[0].how, { source: 'events', steps });
  await assert.rejects(Promise.resolve().then(() => e.semantic_index({ tasks: { search: 'x', themes: true } })), /tasks/);
  await assert.rejects(Promise.resolve().then(() => e.semantic_index({ tasks: { themes: true, limit: 3 } })), /tasks/);
});
