// The unified pipe-style transformation pipeline (src/pipeline.js), executed on
// DATA: each pipeline is lowered to Postgres SQL and run via `dbt show` against
// the seed, asserting exact numbers. Covers aggregate (group_by), pivot, and
// unpivot. (BigQuery lowers the same op IR to native pipe syntax; not run here.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadCatalog } from '../../src/catalog.js';
import { DbtRunner } from '../../src/dbt-runner.js';
import { renderPipeline } from '../../src/pipeline.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'dbt_project');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let pg; let runner; let catalog;
const run = (stages) => runner.show(BASE, renderPipeline(catalog, 'postgres', 'events', stages).sql, 1000);

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port);
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  runner = new DbtRunner({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  catalog = loadCatalog(join(process.cwd(), 'config', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
}, opts);

after(async () => { if (pg) await pg.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

// where -> derive -> join -> aggregate(group_by)
test('pipeline aggregate: IAP revenue by country = US35 / GB25 / BR25', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.rows.map((x) => [String(x.country), num(x.revenue)]));
  assert.equal(by.US, 35);
  assert.equal(by.GB, 25);
  assert.equal(by.BR, 25);
  assert.equal(r.rows.reduce((s, x) => s + num(x.revenue), 0), 85);
});

// ... |> PIVOT: country values become columns
test('pipeline pivot: revenue pivoted into per-country columns (US=35, GB=25, BR=25)', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'pivot', group_by: [], on: 'country', fn: 'sum', value_column: 'price', values: ['US', 'GB', 'BR'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1);            // one pivoted row
  const row = r.rows[0];
  assert.equal(num(row.US), 35);
  assert.equal(num(row.GB), 25);
  assert.equal(num(row.BR), 25);
});

// ... |> UNPIVOT: fold measures back into (metric, value) rows
test('pipeline unpivot: fold revenue+n into rows; US revenue row = 35', opts, async (t) => {
  if (skip(t)) return;
  const r = await run([
    { stage: 'where', conditions: [{ column: 'event_name', op: 'eq', value: 'iap_purchase_completed' }] },
    { stage: 'derive', name: 'price', op: 'extract', source: 'price_in_usd', type: 'numeric' },
    { stage: 'join', with: 'users', on: 'appsflyer_id', attrs: ['country'] },
    { stage: 'aggregate', group_by: ['country'], measures: [{ name: 'revenue', fn: 'sum', column: 'price' }, { name: 'n', fn: 'count' }] },
    { stage: 'unpivot', keep: ['country'], columns: ['revenue', 'n'], name_as: 'metric', value_as: 'value' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const usRevenue = r.rows.find((x) => String(x.country) === 'US' && String(x.metric) === 'revenue');
  assert.ok(usRevenue, 'US/revenue row present');
  assert.equal(num(usRevenue.value), 35);
  // every country contributes exactly the two folded metrics
  const usRows = r.rows.filter((x) => String(x.country) === 'US');
  assert.equal(usRows.length, 2);
});
