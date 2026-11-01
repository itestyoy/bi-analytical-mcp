// EXPORT — a finished task's stored table written as CSV by the warehouse itself, and a link to each file.
// On the DuckDB fixture the export location is a folder of this machine: the file is read back and held
// to the table it was written from — every row, every value (the project's rule: data, not text).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { parseCsv } from '../../src/dbt/output.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, startAndBuild, taskResult } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project');
const opts = { timeout: 600000 };
let wh; let engine;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE);
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('export-ws'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }), exportUri: tempDir('export-files') }));
}, opts);

after(async () => { engine?.runner?.close?.(); if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

const PER_EVENT = { action: 'start', name: 'Per event: Jan', source: 'events', time_range: { start: '2026-01-01', end: '2026-01-31' }, steps: [{ stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', expr: { fn: 'count' } }, { name: 'players', expr: { fn: 'count_distinct', args: [{ column: 'player_id_of_internal' }] } }] }] };

test('a build\'s table is written as one CSV file — its rows the table\'s, every value', opts, async (t) => {
  if (skip(t)) return;
  const build = await startAndBuild(engine, PER_EVENT);
  assert.equal(build.status, 'done', JSON.stringify(build));
  const out = await engine.export({ task_id: build.task_id });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.files.length, 1);
  // the file is named after what the build was for, never its context's id
  assert.equal(out.files[0].file, 'per_event_jan-0.csv');
  const csv = parseCsv(readFileSync(fileURLToPath(out.url), 'utf8'));
  const [header, ...rows] = csv;
  assert.deepEqual(header, ['event_name', 'n', 'players']);
  const fromFile = Object.fromEntries(rows.map(([e, n, p]) => [e, [Number(n), Number(p)]]));
  const fromTable = Object.fromEntries(build.rows.map((r) => [r.event_name, [Number(r.n), Number(r.players)]]));
  assert.deepEqual(fromFile, fromTable, 'every row of the table, every value');
  assert.equal(out.exported_rows, build.rows.length);
  assert.equal(out.files[0].rows, build.rows.length);
});

test('a result that is not stored as a table is refused, saying what holds one', opts, async (t) => {
  if (skip(t)) return;
  const build = await startAndBuild(engine, { ...PER_EVENT, name: 'per_event_read' });
  // a read of the build's table stores nothing of its own
  const raw = engine.raw;
  const started = await raw.query_model({ context_id: build.context_id, steps: [{ stage: 'order_by', keys: [{ key: 'n', direction: 'desc' }] }] });
  await taskResult(raw, started.task_id);
  await assert.rejects(raw.export({ task_id: started.task_id }), (e) => e.field === 'task_id' && /holds no stored table to export/.test(e.message));
  await assert.rejects(raw.export({ task_id: 'aaaaaaaaaaaa' }), (e) => e.field === 'task_id' && /unknown task_id/.test(e.message));
});
