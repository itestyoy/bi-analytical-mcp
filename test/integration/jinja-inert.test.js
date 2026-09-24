// A caller's text lands in files dbt renders as Jinja — every generated .sql model (its header
// comment records the whole declaration, and filter values are string literals in its body) and
// the prose of the YAML it writes. dbt evaluates `{{ … }}` / `{% … %}` wherever they appear, so
// such text must reach the warehouse as the plain characters the caller typed, never as template.
//
// Asserted on DATA against DuckDB: the same pipeline is built with a normal filter value and with
// one that is a Jinja expression evaluating to that value. Were the template evaluated, both would
// count the 12 first_launch events (SEED_DATA §11); inert, the second compares the literal text and
// counts none. The draft's description carries a `run_query` that would fail the build if it ran,
// and an unbalanced `{%` that would fail compilation — the build must succeed regardless.

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
import { startWarehouse } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, MF_BIN, PY_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const opts = { timeout: 300000 };

let wh; let engine; let backend;

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-jinja-')), timeSpineDialect: 'duckdb' });
  backend = new MfEngineBackend({ pythonBin: PY_BIN, dbtBin: DBT_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: backend }));
}, opts);

after(async () => { backend?.close(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

async function countWhere(name, value, description) {
  const s = await engine.build_pipeline_model({ action: 'start', name, source: 'events', ...(description ? { description } : {}) });
  assert.ok(s.draft_id, JSON.stringify(s));
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value }] } });
  await engine.build_pipeline_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', measures: [{ name: 'n', fn: 'count' }] } });
  const c = await engine.build_pipeline_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return Number(c.rows[0].n);
}

test('a filter value that is a Jinja expression is compared as the literal text, never evaluated', opts, async (t) => {
  if (skip(t)) return;
  assert.equal(await countWhere('jinja_plain', 'first_launch'), 12, 'the control: 12 first_launch events');
  assert.equal(await countWhere('jinja_expr', '{{ "first_launch" }}'), 0, 'evaluated, this would have matched the same 12');
  // an unbalanced opener in a value would fail compilation were it read as Jinja
  assert.equal(await countWhere('jinja_open', 'a {% b {# c'), 0);
});

test('Jinja in the declaration (the model header) neither runs nor breaks the build', opts, async (t) => {
  if (skip(t)) return;
  const n = await countWhere('jinja_header', 'first_launch', "{{ run_query('select 1/0') }} and an unbalanced {% if");
  assert.equal(n, 12, 'built and counted as usual');
});

// The governed path writes the same caller text into context.yml (a measure's filter literal inside
// its expr, a label) and MetricFlow renders its own filters as Jinja too. SEED_DATA: 8 distinct
// players reached tutorial step_1.
test('governed path: a Jinja filter value is literal, a Jinja label neither runs nor breaks dbt parse', opts, async (t) => {
  if (skip(t)) return;
  const out = await engine.build_semantic_model({
    name: 'jtut',
    semantic_models: [{
      from: 'events',
      measures: [
        { name: 's1', agg: 'count_distinct', field: 'player_id_of_internal', event_name: ['tutorial'], where: [{ property: 'element_of_event_data', op: 'eq', value: 'step_1' }], label: "{{ run_query('select 1/0') }} {% if" },
        { name: 'sj', agg: 'count_distinct', field: 'player_id_of_internal', event_name: ['tutorial'], where: [{ property: 'element_of_event_data', op: 'eq', value: '{{ "step_1" }}' }] },
      ],
    }],
    metrics: [{ name: 's1', type: 'simple', measure: { name: 's1' } }, { name: 'sj', type: 'simple', measure: { name: 'sj' } }],
  });
  assert.equal(out.parse?.ok, true, JSON.stringify(out.parse || out.error));
  const r = await engine.query_semantic_model({ context_id: out.context_id, metrics: ['jtut_s1', 'jtut_sj'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(Number(r.rows[0].jtut_s1), 8, 'the control: 8 players at step_1');
  assert.equal(Number(r.rows[0].jtut_sj ?? 0), 0, 'evaluated, the Jinja value would have counted the same 8');
});
