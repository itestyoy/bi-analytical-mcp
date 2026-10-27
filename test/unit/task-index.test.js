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

test('nothing kept or answered hands an id on: a checkpoint, a context, an id spelled in a note are blanked', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const index = new TaskIndex({ store: s });
  const ID = 'abcdef123456';
  index.record({
    id: 't1', tool: 'build_model',
    ctx: { state: { draft: { name: 'retention_rerun', description: `retention, rerun of ${ID}`, source: 'events' } } },
    input: { action: 'materialize', context_id: ID, name: 'retention_rerun', steps: [{ stage: 'limit', limit: 1 }], from_checkpoint: { at: 2, model: `pipe_retention_${ID}_c2` }, note: `see pipe_x_${ID}` },
  });
  const found = await index.similar({ search: 'retention rerun' });
  assert.equal(found.tasks.length, 1);
  assert.equal(JSON.stringify(found).includes(ID), false, 'the id is nowhere in the answer');
  assert.deepEqual(found.tasks[0].how.steps, [{ stage: 'limit', limit: 1 }], 'the method is still said');
});

test('a long string of a task\'s steps is kept cut', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const index = new TaskIndex({ store: s });
  index.record({ id: 't1', tool: 'build_model', ctx: { state: { draft: { name: 'scoring', source: 'events' } } }, input: { steps: [{ stage: 'python', functions: [{ name: 'f', params: ['df'], body: 'x'.repeat(30000) }] }] } });
  const [t] = (await index.similar({ search: 'scoring' })).tasks;
  assert.ok(t.how.steps[0].functions[0].body.length < 1100);
});

test('an embedder that cannot be reached: the tasks are compared by their words, and the answer says so', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const embedder = { model: 'down', embed: async () => { throw new Error('embeddings HTTP 503'); } };
  const index = new TaskIndex({ store: s, embedder });
  seeded(index);
  const found = await index.similar({ search: 'crash by app version', limit: 2 });
  assert.match(found.note, /could not be reached/);
  assert.deepEqual(found.tasks.map((t) => topicOf(t.task)), ['crashes', 'crashes']);
  const themes = await index.themes({});
  assert.equal(themes.themes.length, 3);
});

test('a task is sent to the embedder once, however many reads wait for it', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const local = localVectors(TASKS.map((t) => taskText(t)));
  let embedded = 0;
  const embedder = { model: 'm', embed: async (texts) => { embedded += texts.length; await new Promise((r) => { setTimeout(r, 20); }); return texts.map((t) => local.of(t)); } };
  const index = new TaskIndex({ store: s, embedder });
  seeded(index);
  await Promise.all([index.similar({ search: 'crash' }), index.similar({ search: 'retention' }), index.themes({})]);
  assert.equal(embedded - 2, 12, 'twelve tasks, plus the two phrases searched for');
});

test('a task whose context is gone, or says nothing of what it was for, is not taken from the registry', () => {
  const s = openStore(); opened.push(() => s.close?.());
  const index = new TaskIndex({ store: s });
  const ctxs = { a: { state: { draft: { name: 'kept_one', source: 'events' } } }, b: { state: {} } };
  index.backfill([{ id: 'j1', tool: 'query_model', contextId: 'a' }, { id: 'j2', tool: 'query_model', contextId: 'b' }, { id: 'j3', tool: 'query_model', contextId: 'gone' }, { id: 'j4', tool: 'query_model' }], (id) => ctxs[id] || null);
  assert.deepEqual(['j1', 'j2', 'j3', 'j4'].filter((id) => s.taskLog.has(id)), ['j1']);
});

test('a theme\'s share is of the tasks clustered, one or many', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const index = new TaskIndex({ store: s });
  seeded(index);
  const one = await index.themes({ about: 'fatal crashes by device model and app version', min_similarity: 0.6 });
  assert.equal(one.tasks_about, 1);
  assert.equal(one.themes[0].share, 1);
});

test('clustering a long window runs in a thread of its own: the server\'s thread keeps answering meanwhile', async () => {
  const s = openStore(); opened.push(() => s.close?.());
  const index = new TaskIndex({ store: s });
  for (let i = 0; i < 1500; i += 1) {
    const [topic, texts] = Object.entries(TOPICS)[i % 3];
    index.record({ id: `x${i}`, tool: 'build_model', ctx: { state: { draft: { name: `${topic}_${i}`, description: texts[i % 4], source: 'events' } } }, at: DAY + i * 1000 });
  }
  let ticks = 0;
  const beat = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  const themes = await index.themes({});
  const took = Date.now() - t0;
  clearInterval(beat);
  assert.equal(themes.tasks_in_window, 1500);
  // the interval kept firing while the thread worked: at least half of the ticks the time allowed
  assert.ok(ticks >= Math.floor(took / 10 / 2), `${ticks} ticks in ${took} ms`);
});
