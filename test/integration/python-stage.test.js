// The `python` pipeline stage, END TO END on a warehouse that runs dbt Python models locally:
// DuckDB (the adapter dbt's own docs recommend for developing Python models). One declaration →
// dbt builds the prep TABLE from the SQL stages, then runs the generated `def model(dbt, session)`
// that reads it through dbt.ref — and we assert on the ROWS of the result table, computed
// independently from the seed. The same files go to BigQuery/Snowflake unchanged; only the
// profile decides where the Python runtime is.
//
// Needs the separate venv with dbt-duckdb + pandas (.duckvenv); skipped when absent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { DbtRunner } from '../../src/dbt-runner.js';
import { Engine } from '../../src/engine.js';

const execFileP = promisify(execFile);
const ROOT = process.cwd();
const PROJECT = join(ROOT, 'test', 'integration', 'fixtures', 'duckdb_project');
const DBT_BIN = process.env.DUCK_DBT_BIN || join(ROOT, '.duckvenv', 'bin', 'dbt');
const PY_BIN = process.env.DUCK_PYTHON_BIN || join(ROOT, '.duckvenv', 'bin', 'python');
const HAS = existsSync(DBT_BIN) && existsSync(PY_BIN);
const opts = { timeout: 600000 };
const skip = (t) => { if (!HAS) { t.skip('dbt-duckdb venv not installed (.duckvenv)'); return true; } return false; };

let engine; let work;
before(async () => {
  if (!HAS) return;
  work = mkdtempSync(join(tmpdir(), 'pystage-duck-'));
  process.env.DUCKDB_PATH = join(work, 'wh.duckdb');
  const env = { ...process.env, DBT_PROFILES_DIR: PROJECT, DBT_PROJECT_DIR: PROJECT };
  await execFileP(DBT_BIN, ['seed'], { cwd: PROJECT, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const runner = new DbtRunner({ dbtBin: DBT_BIN, profilesDir: PROJECT, timeout: 600000 });
  const ctxs = new ContextManager({ baseProjectDir: PROJECT, workspaceRoot: join(work, 'ctx'), timeSpineDialect: 'postgres' });
  const catalog = loadCatalog(join(ROOT, 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: PROJECT, projectDir: PROJECT });
  engine = new Engine({ catalog, contextManager: ctxs, runner, pythonBin: PY_BIN, queryTimeoutMs: 600000, dbPath: join(work, 'index.sqlite') });
}, opts);
after(() => { try { engine?.close(); } catch { /* noop */ } if (work) rmSync(work, { recursive: true, force: true }); });

// The seed (fixtures/duckdb_project/seeds/fct_analytics_events.csv): purchases p1 = 10 + 20,
// p2 = 5, p3 = 40 + 25; p4 has only a level_completed row (no price). Per-player revenue after the
// SQL aggregate: p1 30, p2 5, p3 65, p4 NULL. z-score over the three priced players (pandas skips
// NaN; ddof = 0): mean 33.333…, std 24.607… → p1 −0.1355, p2 −1.1514, p3 +1.2869; p4 stays NaN.
const Z = { p1: (30 - 100 / 3) / Math.sqrt(1816.6666667 / 3), p2: (5 - 100 / 3) / Math.sqrt(1816.6666667 / 3), p3: (65 - 100 / 3) / Math.sqrt(1816.6666667 / 3) };

const AGG = { stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [{ name: 'n', fn: 'count' }, { name: 'revenue', fn: 'sum', column: 'price_in_usd_of_event_data' }] };
const PY = {
  stage: 'python',
  imports: [{ package: 'numpy' }],
  functions: [
    { name: 'zscore', params: ['df', 'column', 'as_'], body: ['df[as_] = (df[column] - df[column].mean()) / df[column].std(ddof=0)', 'return df'] },
    // a nested block: the tier is assigned only when the column exists — structure IS the indentation
    { name: 'tier', params: ['df', 'column', 'threshold'], body: ['if column in df.columns:', ["df['tier'] = numpy.where(df[column] > threshold, 'high', 'low')"], 'else:', ["df['tier'] = 'low'"], 'return df'] },
  ],
  steps: [
    { call: 'zscore', args: { column: 'revenue', as_: 'revenue_z' } },
    { call: 'tier', args: { column: 'revenue_z', threshold: 0 } },
  ],
  output: { columns: ['player_id_of_internal', 'n', 'revenue', 'revenue_z', 'tier'] },
};
const num = (v) => (v == null || v === '' ? null : Number(v));

test('python stage: dbt builds the prep table, runs the Python model, and its ROWS are the pipeline result', opts, async (t) => {
  if (skip(t)) return;
  const r = await engine.register_native_model({ name: 'seg', pipeline: { source: 'events', stages: [AGG, PY] } });
  assert.equal(r.ok ?? r.build?.ok, true, JSON.stringify(r.error || r));
  assert.equal(r.build.executed, true, 'dbt actually ran both models');
  assert.equal(r.python.prep_model, `${r.model}_prep`);
  assert.deepEqual(r.columns.map((c) => c.name ?? c), PY.output.columns);
  const rows = r.rows.map((x) => ({ ...x, n: num(x.n), revenue: num(x.revenue), revenue_z: num(x.revenue_z) })).sort((a, b) => a.player_id_of_internal.localeCompare(b.player_id_of_internal));
  assert.equal(rows.length, 4, 'one row per player, incl. the player with no purchases');
  assert.deepEqual(rows.map((x) => [x.player_id_of_internal, x.n, x.revenue]), [['p1', 2, 30], ['p2', 1, 5], ['p3', 3, 65], ['p4', 1, null]], 'the SQL prep numbers');
  for (const p of ['p1', 'p2', 'p3']) assert.ok(Math.abs(rows.find((x) => x.player_id_of_internal === p).revenue_z - Z[p]) < 1e-6, `${p} z = ${rows.find((x) => x.player_id_of_internal === p).revenue_z}`);
  const p4 = rows.find((x) => x.player_id_of_internal === 'p4');
  assert.ok(p4.revenue_z == null || Number.isNaN(p4.revenue_z), 'no revenue → no z-score');
  assert.deepEqual(rows.map((x) => x.tier), ['low', 'low', 'high', 'low'], 'the second function ran on the first one\'s output');

  // The result IS a table in the warehouse: re-read it through get_query_result, and re-slice it.
  const again = await engine.get_query_result({ context_id: r.context_id, table: r.model });
  assert.equal(again.rows.length, 4);
  const byTier = await engine.get_query_result({ context_id: r.context_id, table: r.model, transform: { group_by: ['tier'], aggregations: [{ fn: 'count', as: 'players' }], order_by: [{ key: 'tier' }] } });
  assert.deepEqual(byTier.rows.map((x) => [x.tier, num(x.players)]), [['high', 1], ['low', 3]]);
  // and so is the prep table, under its own name
  const prep = await engine.get_query_result({ context_id: r.context_id, table: r.python.prep_model });
  assert.equal(prep.rows.length, 4);
  assert.ok(!Object.keys(prep.rows[0]).includes('tier'), 'the prep table is the SQL part only');
});

test('python stage: the incremental builder materializes the same split and returns the rows', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_native_model({ action: 'start', name: 'seg2', source: 'events' });
  await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: AGG });
  await engine.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { ...PY, steps: [PY.steps[0]], output: { columns: ['player_id_of_internal', 'revenue_z'] } } });
  const m = await engine.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(m.build?.executed, true, JSON.stringify(m.error || m));
  assert.equal(m.row_count, 4);
  assert.deepEqual(Object.keys(m.rows[0]).sort(), ['player_id_of_internal', 'revenue_z']);
  const p3 = m.rows.find((x) => x.player_id_of_internal === 'p3');
  assert.ok(Math.abs(num(p3.revenue_z) - Z.p3) < 1e-6);
});

// A Python failure at run time (not caught by the gate — a wrong column name) comes back as the
// dbt error, not as a silent empty table.
test('python stage: a runtime error in the Python model is reported from dbt, nothing is materialized as the result', opts, async (t) => {
  if (skip(t)) return;
  const bad = { ...PY, steps: [{ call: 'zscore', args: { column: 'no_such_column', as_: 'z' } }], output: { columns: ['player_id_of_internal', 'z'] } };
  const r = await engine.register_native_model({ name: 'seg3', pipeline: { source: 'events', stages: [AGG, bad] } });
  assert.equal(r.ok, false);
  assert.equal(r.error.stage, 'run');
  assert.match(r.error.message, /no_such_column/);
  await assert.rejects(() => engine.get_query_result({ context_id: r.context_id, table: r.model }).then((x) => { if (x.ok === false) throw new Error(x.error?.message || 'not ok'); }));
});
