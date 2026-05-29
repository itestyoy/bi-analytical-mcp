// Reference-correctness test: dbt's OWN documented Semantic Layer example
// (Jaffle orders/customers) must parse and query correctly in our harness.
// This validates our dbt Core + MetricFlow + PGlite setup against dbt canon,
// independent of the MCP server's YAML generation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DbtRunner, formatDbtError } from '../../src/dbt-runner.js';
import { startPglite } from './pglite-harness.js';

const execFileP = promisify(execFile);
const BASE = join(process.cwd(), 'test', 'integration', 'fixtures', 'jaffle_sl');
const DBT_BIN = process.env.DBT_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'dbt');
const MF_BIN = process.env.MF_BIN || join(process.cwd(), '.dbtvenv', 'bin', 'mf');
const HAS_DBT = existsSync(DBT_BIN) && existsSync(MF_BIN);
const opts = { timeout: 300000 };

let pg;
let runner;

before(async () => {
  if (!HAS_DBT) return;
  pg = await startPglite();
  process.env.DBT_PG_PORT = String(pg.port); // inherited by DbtRunner (mf/dbt parse)
  const env = { ...process.env, DBT_PROFILES_DIR: BASE, DBT_PROJECT_DIR: BASE, DBT_PG_PORT: String(pg.port) };
  await execFileP(DBT_BIN, ['seed'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  await execFileP(DBT_BIN, ['run'], { cwd: BASE, env, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  runner = new DbtRunner({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  const parsed = await runner.parse(BASE);
  assert.equal(parsed.ok, true, `parse failed: ${parsed.stderr || parsed.stdout}`);
}, opts);

after(async () => { if (pg) await pg.stop(); });

const num = (r) => Number(Object.values(r).at(-1));

test('canonical: order_total totals to 100', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total'] });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(res.rows.reduce((s, r) => s + num(r), 0), 100);
});

test('canonical: order_total by customer__customer_type (entity join) = 50/50', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total'], groupBy: ['customer__customer_type'] });
  assert.equal(res.ok, true, res.stderr);
  const byType = Object.fromEntries(res.rows.map((r) => [r.customer__customer_type, Number(r.order_total)]));
  assert.equal(byType.new, 50);
  assert.equal(byType.returning, 50);
});

test('canonical: order_total by metric_time__month spans two months summing to 100', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total'], groupBy: ['metric_time__month'] });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows.reduce((s, r) => s + num(r), 0), 100);
});

test('canonical: average_order_value (ratio) = 100/3', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['average_order_value'] });
  assert.equal(res.ok, true, res.stderr);
  assert.ok(Math.abs(num(res.rows[0]) - 100 / 3) < 0.01, `got ${num(res.rows[0])}`);
});

test('canonical: food_orders (metric-level filter) counts 2 food orders', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['food_orders'] });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(num(res.rows[0]), 2);
});

test('canonical: --explain returns compiled SQL', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total'], groupBy: ['metric_time__month'], explain: true });
  assert.equal(res.ok, true, res.stderr);
  assert.match((res.sql || '').toLowerCase(), /select|with/);
});

// --- additional tests mirroring dbt's documented `mf query` examples ---
// (https://docs.getdbt.com/docs/build/metricflow-commands)

// docs example: `mf query --metrics order_total,order_count --group-by metric_time`
test('docs example: multiple metrics in one query', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total', 'order_count'], groupBy: ['metric_time__month'] });
  assert.equal(res.ok, true, res.stderr);
  assert.ok(res.columns.some((c) => /order_total/.test(c.name)));
  assert.ok(res.columns.some((c) => /order_count/.test(c.name)));
  assert.equal(res.rows.reduce((s, r) => s + Number(r.order_total), 0), 100);
});

// docs example: `--where "{{ Dimension('order_id__is_food_order') }} = True"`
test('docs example: query-time --where on a boolean dimension', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total'], where: ["{{ Dimension('order_id__is_food_order') }} = true"] });
  assert.equal(res.ok, true, res.stderr);
  // food orders: 20 (101) + 50 (103) = 70
  assert.equal(num(res.rows[0]), 70);
});

// docs example: `--group-by order_id__is_food_order`
test('docs example: group by a boolean dimension splits true/false', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, { metrics: ['order_total'], groupBy: ['order_id__is_food_order'] });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows.reduce((s, r) => s + Number(r.order_total), 0), 100);
});

// error surfacing: a real dbt parse error comes back clean (no ANSI / log
// timestamps) with the meaningful dbt message.
test('errors: a real dbt parse error is surfaced clearly', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const tmp = mkdtempSync(join(tmpdir(), 'jaffle-bad-'));
  cpSync(BASE, tmp, { recursive: true, filter: (s) => !/(\/target(\/|$)|\/logs(\/|$))/.test(s) });
  // a metric referencing a measure that does not exist -> dbt parsing/validation error
  writeFileSync(join(tmp, 'models', '_broken.yml'),
    'metrics:\n  - name: broken_metric\n    label: Broken\n    type: simple\n    type_params:\n      measure:\n        name: does_not_exist_measure\n');
  const r = await runner.parse(tmp);
  assert.equal(r.ok, false, 'parse should fail');
  const msg = formatDbtError(r.stdout, r.stderr);
  t.diagnostic(msg);
  assert.ok(!msg.includes(String.fromCharCode(27)) && !msg.includes('[0m'), 'no ANSI escapes');
  assert.ok(!/^\d{2}:\d{2}:\d{2}/m.test(msg), 'no leading log timestamps');
  assert.match(msg, /Error/);
  assert.match(msg, /does_not_exist_measure/);
});

// docs example: `--start-time ... --end-time ... --order ... --limit ...`
test('docs example: time range + order + limit', opts, async (t) => {
  if (!HAS_DBT) return t.skip('dbt/mf not installed');
  const res = await runner.query(BASE, {
    metrics: ['order_total'], groupBy: ['metric_time__day'],
    startTime: '2030-01-01', endTime: '2030-01-31', orderBy: ['-metric_time__day'], limit: 10,
  });
  assert.equal(res.ok, true, res.stderr);
  // only January orders: 20 + 30 = 50
  assert.equal(res.rows.reduce((s, r) => s + num(r), 0), 50);
});
