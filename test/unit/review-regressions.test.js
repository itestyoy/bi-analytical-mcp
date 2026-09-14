// Regressions from the code review. Each test names the defect it pins, in the terms of what the
// USER would have seen. Allowed non-data checks only: input-validation guards (a bad input is
// refused) and context lifecycle (which files a context owns) — never the text of generated SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { openStore } from '../../src/store.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = (over = {}) => new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }),
  ...over,
});

// ── delete_native_model left a pipeline's other files behind ────────────────────────────────
// A pipeline is a CHAIN of generated files: `<model>.sql`, and for a python stage `<model>.py` +
// `<model>.yml`, plus `<model>_sN.*` per step. Deleting only `<model>.sql` reported removed:true
// while dbt kept compiling the rest — and with the context's state cleared, nothing could name
// them again. Lifecycle check: what the context owns on disk afterwards.
test('delete_native_model removes EVERY file of the pipeline, not just the .sql', async () => {
  const e = engine();
  const ctx = e.ctxs.create();
  const dir = e.ctxs.generatedDir(ctx.id);
  ctx.state.engine = 'pipeline';
  ctx.state.model = 'pipe_demo';
  // the shapes a pipeline actually renders, plus a file belonging to ANOTHER model
  for (const f of ['pipe_demo.sql', 'pipe_demo.py', 'pipe_demo.yml', 'pipe_demo_s1.sql', 'pipe_demo_s2.py', 'pipe_other.sql']) {
    writeFileSync(join(dir, f), '-- x\n');
  }
  const out = await e.delete_native_model({ context_id: ctx.id });
  assert.equal(out.removed, true);
  const left = readdirSync(dir).filter((f) => f.startsWith('pipe_'));
  assert.deepEqual(left, ['pipe_other.sql'], 'only the other model’s file survives');
  assert.deepEqual([...out.removed_files].sort(), ['pipe_demo.py', 'pipe_demo.sql', 'pipe_demo.yml', 'pipe_demo_s1.sql', 'pipe_demo_s2.py']);
});

// ── the { source, property } view threw TypeError instead of refusing ───────────────────────
// The schema's enum normally makes an unknown name unwritable, but a source that declares no
// columns projects no enum and the field degrades to an open string. The view then read `.type`
// off a column that was not there.
test('an unknown column name is refused by the property view, not read off undefined', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ source: 'users', property: 'no_such_column' }),
    /not a property or attribute of 'users'|`property` must be one of/);
});

// ── memory: a rewritten legacy target must be stored like every other target ────────────────
// `record` stores targets as objects; the one-time rewrite of source-less legacy keys used to
// store STRINGS ('term:foo') into the same list, so one note could hold two shapes and the
// `term:` prefix leaked into the searchable text.
test('a rewritten legacy memory target is stored in the same shape as a recorded one', async () => {
  const store = openStore({});
  const mk = () => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }), store });
  const e0 = mk();
  store.memory.add({ id: 'legacy', note: 'ad format lives in ad_type', targets: ['property:ad_type_of_event_data'], aliases: [], links: [], created_at: Date.now() });
  const e = mk(); // a fresh Engine over the same store runs the rewrite
  const rec = await e.memory({ action: 'record', note: 'a recorded one', targets: [{ term: 'ad_type_of_event_data' }] });

  const shapeOf = (id) => store.memory.get(id).targets.map((t) => (t && typeof t === 'object' ? Object.keys(t).sort().join('+') : `string:${t}`));
  assert.deepEqual(shapeOf('legacy'), shapeOf(rec.id), 'the rewritten target has the same shape as a recorded one');
  // and the prefix never becomes part of what is searched
  const found = await e.memory({ action: 'search', query: 'ad_type_of_event_data' });
  assert.ok(found.notes.some((n) => n.id === 'legacy'), 'still findable by the word itself');
  assert.ok(!JSON.stringify(store.memory.get('legacy').targets).includes('term:'), 'no "term:" prefix inside the stored target');
  e0.close(); e.close();
});

// ── meta.mcp.dimension: false was ignored on a non-fact's time axis ─────────────────────────
// The opt-out is read further down the column loop, but the time axis returns before reaching it,
// so a spend table's `spend_date` stayed a groupable attribute however it was declared.
test('meta.mcp.dimension: false takes the time axis out of the group-by surface too', () => {
  const base = (optOut) => `version: 2
models:
  - name: fct_events
    meta:
      mcp: { role: events, primary_entity: event, known_events: [login] }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
  - name: fct_spend
    meta: { mcp: { role: acquisition } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }
      - { name: spend_date, data_type: date, meta: { mcp: { is_time: true${optOut ? ', dimension: false' : ''} } } }
      - { name: cost, data_type: numeric, meta: { mcp: { measure: true } } }
`;
  const load = (yaml) => {
    const f = join(mkdtempSync(join(tmpdir(), 'rev-')), 'catalog.yml');
    writeFileSync(f, yaml);
    return loadCatalog(f, {});
  };
  const kept = load(base(false));
  assert.deepEqual(kept.modelDimensionColumns('acquisition'), ['spend_date'], 'by default the axis is groupable');
  const optedOut = load(base(true));
  assert.deepEqual(optedOut.modelDimensionColumns('acquisition'), [], 'opted out, it is not');
  // …and it is STILL the model's time axis, just not an attribute
  assert.equal(optedOut.getModel('acquisition').time?.column, 'spend_date');
});

// ── a pipeline whose only stage is `python` ran synchronously ───────────────────────────────
// The detached build was gated on the model COUNT, but a lone python stage renders as one model
// and still pays the warehouse Python runtime's cold start — minutes of a blocked call with no
// query_id to poll. Checked through the engine's own decision, with a runner stub standing in for
// the warehouse (no SQL text is asserted).
test('a single python-model pipeline is built detached, like a chain', async (t) => {
  process.env.MCP_PYTHON_MODELS = 'on'; // the fixture has no dbt profile, so the stage is hidden otherwise
  const VENV_PY = join(process.cwd(), '.dbtvenv', 'bin', 'python');
  const PY = existsSync(VENV_PY) ? VENV_PY : 'python3';
  if (spawnSync(PY, ['--version']).status !== 0) { t.skip('no python interpreter for the static gate'); return; }

  // The build is the slow part, so it is stubbed: what is under test is WHICH path the engine
  // takes, and a `run` that never returns within the timeout is exactly the situation the
  // detached path exists for.
  let ran = 0; let detached = false;
  const runner = {
    async run() { ran += 1; await new Promise((r) => setTimeout(r, 400)); return { ok: true, stdout: '', stderr: '' }; },
    async show() { return { ok: true, rows: [], columns: [] }; },
    async parse() { return { ok: true }; },
  };
  const e = new Engine({
    catalog: loadCatalog(CATALOG, {}),
    contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rev-')) }),
    runner, pythonBin: PY, queryTimeoutMs: 50, // anything slower than this hands back a query_id
  });
  const py = {
    stage: 'python',
    functions: [{ name: 'tag', params: ['df'], body: ['df["tag"] = 1', 'return df'] }],
    steps: [{ call: 'tag', args: {} }],
    output: { columns: ['tag'] },
  };
  const out = await e.register_native_model({ name: 'only_py', pipeline: { source: 'events', stages: [py] } });
  assert.ok(out.ok !== false, JSON.stringify(out.error || {}));
  detached = out.status === 'running' && !!out.query_id;
  assert.ok(detached, `a lone python model hands back a query_id instead of blocking: ${JSON.stringify(out).slice(0, 300)}`);
  assert.equal(ran, 1, 'and the build did start');
});
