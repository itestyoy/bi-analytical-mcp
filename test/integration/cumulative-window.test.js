// A CUMULATIVE METRIC OVER A PARTITIONED SOURCE READS THE DAYS BEFORE ITS RANGE. The fixture's
// events source is partitioned by event_date (the day of device_time), and a time_range prunes those
// partitions with a filter of its own — applied to the rows BEFORE they accumulate. Its lower bound
// reaches back by the metric's window, or a 2-day window on the range's first day holds that day
// alone. Proven on DATA: each value below is the warehouse's own count of the same events, read with
// SQL written by hand in the test (events by day: 01-01 33, 01-02 42, 01-03 27, 01-04 39, 01-05 37).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { startWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { DBT_BIN, HAS_DBT, testDbt } from '../helpers/dbt-env.js';

const execFileP = promisify(execFile);
const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v);
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

let wh;
let engine;
const TASK = {
  name: 'cum',
  semantic_models: [{ from: 'events', measures: [{ name: 'events_n', agg: 'count', field: '*' }] }],
  metrics: [
    { name: 'daily', type: 'simple', measure: { name: 'events_n' } },
    { name: 'two_day', type: 'cumulative', measure: { name: 'events_n' }, window: '2 days' },
    { name: 'to_date', type: 'cumulative', measure: { name: 'events_n' } },
  ],
};

before(async () => {
  if (!HAS_DBT) return;
  wh = await startWarehouse();
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DUCKDB_PATH: wh.path };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'mcpit-cum-')), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }) }));
}, opts);
after(async () => { try { engine?.close(); } catch { /* noop */ } if (wh) await wh.stop(); });

/** The warehouse's own count per day of device_time, by hand. */
async function perDay() {
  const { rows } = await wh.query('select cast(device_time as date) as d, count(*) as n from fct_analytics_events group by 1');
  return new Map(rows.map((r) => [String(r.d instanceof Date ? r.d.toISOString() : r.d).slice(0, 10), num(r.n)]));
}

test('a cumulative metric over a time_range sums the days before the range that its window covers — and one with no window, every day before', opts, async (t) => {
  if (skip(t)) return;
  const day = await perDay();
  const at = (d) => day.get(d) || 0;
  const created = await engine.build_semantic_model(TASK);
  const r = await engine.query_semantic_model({
    context_id: created.context_id,
    metrics: ['cum_daily', 'cum_two_day', 'cum_to_date'],
    group_by: [{ time: 'metric_time', grain: 'day' }],
    order_by: [{ key: 'metric_time' }],
    time_range: { start: '2026-01-03', end: '2026-01-05' },
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const got = r.rows.map((x) => [num(x.cum_daily), num(x.cum_two_day), num(x.cum_to_date)]);
  const days = ['2026-01-03', '2026-01-04', '2026-01-05'];
  const prev = { '2026-01-03': '2026-01-02', '2026-01-04': '2026-01-03', '2026-01-05': '2026-01-04' };
  const upTo = (d) => [...day].filter(([k]) => k <= d).reduce((a, [, n]) => a + n, 0);
  assert.ok(at('2026-01-02') > 0, 'the fixture has events the day before the range');
  assert.deepEqual(got, days.map((d) => [at(d), at(prev[d]) + at(d), upTo(d)]));
});
