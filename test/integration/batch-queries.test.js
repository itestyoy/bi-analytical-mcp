// A BATCH OF QUERIES — one call starts several queries on a context, they run side by side, and
// one read returns them all. Run with the production runner (the `mf` CLI and `dbt`, each member its
// own process), proven on DATA against DuckDB: SEED_DATA's total IAP revenue 85, by country US 35 /
// GB 25 / BR 25; 184 event rows, 11 of them priced (8 completed purchases = 85, 3 failed = 35).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { createDbt } from '../../src/dbt/index.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle, one } from '../helpers/settle.js';
import { DBT_BIN, MF_BIN, HAS_DBT } from '../helpers/dbt-env.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v);

let wh; let engine;
// The context the first test declares; the ordering and cancel tests run on it rather than declaring
// TASK again (what they prove does not depend on a fresh context). A run that skips the first test
// declares one for itself.
let monCtx;
const monContext = async () => monCtx ?? (monCtx = (await engine.build_semantic_model(TASK)).context_id);
const TASK = {
  name: 'mon',
  semantic_models: [{ source: 'events', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ property: 'price_in_usd_of_event_data' }] } }], where: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }, { source: 'users' }],
  metrics: [{ name: 'revenue', type: 'simple', measure: 'revenue' }],
};
const byCountry = [{ source: 'users', column: 'country' }];
// a where step before the metrics step, on a dimension the result is not grouped by
const iosOnly = { stage: 'where', conditions: [{ fn: 'eq', args: [{ source: 'users', column: 'platform' }, { value: 'ios' }] }] };
const largestFirst = { stage: 'order_by', keys: [{ key: 'mon_revenue', direction: 'desc' }, { key: 'users_country' }] };
const revenueBy = (rows) => Object.fromEntries(rows.map((r) => [String(r.users_country), num(r.mon_revenue)]));

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: mkdtempSync(join(tmpdir(), 'batch-')), timeSpineDialect: 'duckdb' });
  const runner = createDbt({ dbtBin: DBT_BIN, mfBin: MF_BIN, profilesDir: BASE });
  engine = settle(new Engine({ catalog: loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE }), contextManager: ctxs, runner }));
}, opts);

after(async () => { if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** Read a batch back until none of it is running. */
async function readAll(tool, taskIds) {
  const byId = new Map();
  let left = taskIds;
  while (left.length) {
    const r = await engine.raw[tool]({ task_ids: left });
    for (const x of r.results) if (x.status !== 'running') byId.set(x.task_id, x);
    left = r.results.filter((x) => x.status === 'running').map((x) => x.task_id);
  }
  return taskIds.map((id) => byId.get(id));
}

test('a batch started right after the declaration waits for its parse, runs every query, and one read returns the warehouse\'s numbers in order', opts, async (t) => {
  if (skip(t)) return;
  // the declaration is still being parsed when the batch is started
  const created = await engine.raw.build_semantic_model(TASK);
  monCtx = created.context_id;
  const started = await engine.raw.query_semantic_model({
    context_id: created.context_id,
    queries: [
      { steps: [{ stage: 'metrics', metrics: ['mon_revenue'] }] },
      { steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }] },
      { steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }], materialize: true },
      { steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ source: 'users', column: 'country' }, { value: 'US' }] }] }, { stage: 'metrics', metrics: ['mon_revenue'] }] },
      // steps after the metrics step, over its result: the countries whose revenue reaches 25 (a having), the largest first
      { steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }, { stage: 'where', conditions: [{ fn: 'gte', args: [{ column: 'mon_revenue' }, { value: 25 }] }] }, largestFirst] },
      // grouped by an entity the measure source carries: one row per value of its key there
      { steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: [{ entity: 'user' }] }] },
      // steps on both sides of the metrics step: a where before it (the iOS players' purchases — the rows
      // the metric folds), a where after it on the result (a having) and an order_by
      { steps: [iosOnly, { stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }, { stage: 'where', conditions: [{ fn: 'gte', args: [{ column: 'mon_revenue' }, { value: 20 }] }] }, largestFirst] },
      // the metrics step and only an order_by after it: MetricFlow orders it itself (mf query)
      { steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }, largestFirst] },
    ],
  });
  assert.deepEqual(Object.keys(started).sort(), ['context_id', 'next', 'read_with', 'task_ids']);
  assert.equal(started.task_ids.length, 8);
  const [total, grouped, stored, us, ranked, byUser, iosRanked, mfOrdered] = await readAll('query_semantic_model', started.task_ids);
  for (const r of [total, grouped, stored, us, ranked, byUser, iosRanked, mfOrdered]) assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(num(total.rows[0].mon_revenue), 85);
  const g = revenueBy(grouped.rows);
  assert.deepEqual([g.US, g.GB, g.BR], [35, 25, 25]);
  // the truth, read from the warehouse by hand: each completed purchase's price under the country of
  // the install version valid at its time (dim_users is slowly changing) — what { source: 'users',
  // column: 'country' } groups and filters by
  const truth = Object.fromEntries((await wh.query(`select u.country, sum(e.price_in_usd_of_event_data) as revenue
    from fct_analytics_events e join dim_users u on u.player_id_of_internal = e.player_id_of_internal
      and e.device_time between u.install_time_valid_from and u.install_time_valid_until
    where e.event_name = 'iap_purchase_completed' group by 1`)).rows.map((r) => [String(r.country), num(r.revenue)]));
  // (a country with no purchase has no revenue there — a NULL here)
  assert.deepEqual(Object.fromEntries(Object.entries(g).filter(([, v]) => v !== 0)), truth, '[grouped by users.country] the warehouse\'s revenue per country');
  assert.equal(num(us.rows[0].mon_revenue), truth.US, '[filtered by users.country] the warehouse\'s US revenue');
  // { entity: 'user' }: the user key events carry (player_id_of_internal), the column named for the entity
  const perPlayer = Object.fromEntries((await wh.query(`select player_id_of_internal as player, sum(price_in_usd_of_event_data) as revenue
    from fct_analytics_events where event_name = 'iap_purchase_completed' group by 1`)).rows.map((r) => [String(r.player), num(r.revenue)]));
  assert.deepEqual(Object.fromEntries(byUser.rows.map((r) => [String(r.user), num(r.mon_revenue)]).filter(([, v]) => v !== 0)), perPlayer, '[grouped by { entity: user }] the warehouse\'s revenue per player');
  // the materialized member left its table, which pages like any stored result
  assert.equal(stored.table, `qr_${stored.task_id}`);
  const s = revenueBy(stored.rows);
  assert.deepEqual([s.US, s.GB, s.BR], [35, 25, 25]);
  const page = await one(engine.query_semantic_model({ task_ids: [stored.task_id], limit: 2 }));
  assert.equal(page.rows.length, 2);
  assert.equal(page.page.has_more, true);
  assert.equal(num(us.rows[0].mon_revenue), 35);
  // the member with steps: the grouped rows, those under 25 (DE, with none) dropped, ranked
  assert.deepEqual(ranked.rows.map((r) => [String(r.users_country), num(r.mon_revenue)]), [['US', 35], ['BR', 25], ['GB', 25]]);
  // the same question asked of the warehouse by hand, for the members with steps on both sides of the
  // metrics step and with a lone order_by after it: the purchases, each under the country (and the
  // platform) of the install version valid at its time
  const ranks = async (filter, having) => (await wh.query(`select u.country, sum(e.price_in_usd_of_event_data) as revenue
    from fct_analytics_events e join dim_users u on u.player_id_of_internal = e.player_id_of_internal
      and e.device_time between u.install_time_valid_from and u.install_time_valid_until
    where e.event_name = 'iap_purchase_completed' ${filter} group by 1 ${having} order by 2 desc, 1`)).rows.map((r) => [String(r.country), num(r.revenue)]);
  const iosTruth = await ranks(`and u.platform = 'ios'`, 'having sum(e.price_in_usd_of_event_data) >= 20');
  assert.deepEqual(iosTruth, [['BR', 25], ['GB', 25]], '[the truth] iOS revenue per country: US 15 under the having, BR and GB 25');
  assert.deepEqual(iosRanked.rows.map((r) => [String(r.users_country), num(r.mon_revenue)]), iosTruth, '[where → metrics → where → order_by] the warehouse\'s iOS revenue per country reaching 20, the largest first');
  // MetricFlow's own order: every country with revenue as the warehouse ranks it, the one with none (a NULL) after them
  const priced = mfOrdered.rows.filter((r) => r.mon_revenue != null);
  assert.deepEqual(priced.map((r) => [String(r.users_country), num(r.mon_revenue)]), await ranks('', ''), '[metrics → order_by] the warehouse\'s revenue per country, the largest first');
  assert.ok(mfOrdered.rows.slice(priced.length).every((r) => r.mon_revenue == null), '[metrics → order_by] a NULL revenue sorts last');
  // each member is a task of its own: it is drawn on its own, once
  const card = await engine.display_model_result({ task_id: grouped.task_id, display: { kind: 'bar', x: 'users_country', y: ['mon_revenue'] } });
  assert.deepEqual(card.rows.map((r) => num(r.mon_revenue)).sort((a, b) => a - b), [0, 25, 25, 35]);
});

test('a batch of reads over a built pipeline model, each in steps of the pipeline\'s own stages: count, non-NULL count, sums, a where on a measure, a count and a sum over a case, and a share and an any over a case with an else, read back together', opts, async (t) => {
  if (skip(t)) return;
  const s = await engine.build_pipeline_model({ action: 'start', name: 'priced', source: 'events' });
  // a numeric property, read as the catalog declares it (no cast)
  await engine.build_pipeline_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'compute', name: 'price', expr: { property: 'price_in_usd_of_event_data' } }] });
  const mat = await engine.build_pipeline_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(mat.build?.ok, true, JSON.stringify(mat.error || mat.build));
  const priced = { stage: 'where', conditions: [{ fn: 'is_not_null', args: [{ column: 'price' }] }] };
  const completed = { fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] };
  const purchaseFlag = { fn: 'case', cases: [{ when: [completed], then: { value: 1 } }], else: { value: 0 } };
  const amountByEvent = { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'amount', expr: { fn: 'sum', args: [{ column: 'price' }] } }] };
  const started = await engine.raw.query_pipeline_model({
    context_id: s.context_id,
    queries: [
      { steps: [{ stage: 'aggregate', measures: [{ name: 'rows', expr: { fn: 'count' } }] }] },
      { steps: [{ stage: 'aggregate', measures: [{ name: 'priced', expr: { fn: 'count', args: [{ column: 'price' }] } }] }] },
      { steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'event_name' }, { value: 'iap_purchase_completed' }] }] }, { stage: 'aggregate', measures: [{ name: 'revenue', expr: { fn: 'sum', args: [{ column: 'price' }] } }] }] },
      { steps: [priced, amountByEvent, { stage: 'order_by', keys: [{ key: 'event_name' }] }] },
      // where → aggregate → a where on the measure it made → order_by: the groups whose amount passes 50
      { steps: [priced, amountByEvent, { stage: 'where', conditions: [{ fn: 'gt', args: [{ column: 'amount' }, { value: 50 }] }] }, { stage: 'order_by', keys: [{ key: 'amount', direction: 'desc' }] }] },
      // a conditional count and a conditional sum over every row: each aggregate over a case that yields
      // its value on the completed purchases alone (1 for the count) and nothing on any other row
      { steps: [{ stage: 'aggregate', measures: [
        { name: 'purchases', expr: { fn: 'count', args: [{ fn: 'case', cases: [{ when: [completed], then: { value: 1 } }] }] } },
        { name: 'purchase_revenue', expr: { fn: 'sum', args: [{ fn: 'case', cases: [{ when: [completed], then: { column: 'price' } }] }] } },
      ] }] },
      // per player, the average and the max of a case that is 1 on a completed purchase and 0 (its else)
      // on every other row: the share of the player's rows that are one, and whether any is
      { steps: [{ stage: 'aggregate', group_by: ['player_id_of_internal'], measures: [
        { name: 'purchase_share', expr: { fn: 'average', args: [purchaseFlag] } },
        { name: 'any_purchase', expr: { fn: 'max', args: [purchaseFlag] } },
      ] }] },
    ],
  });
  assert.equal(started.read_with, 'query_pipeline_model');
  const [rows, nonNull, revenue, byEvent, over50, conditional, perPlayer] = await readAll('query_pipeline_model', started.task_ids);
  for (const r of [rows, nonNull, revenue, byEvent, over50, conditional, perPlayer]) assert.equal(r.status, 'done', JSON.stringify(r.error));
  assert.equal(num(rows.rows[0].rows), 184);
  assert.equal(num(nonNull.rows[0].priced), 11);
  assert.equal(num(revenue.rows[0].revenue), 85);
  // the truth, read from the warehouse by hand
  const [truth] = (await wh.query(`select count(*) filter (where event_name = 'iap_purchase_completed') as purchases,
    sum(price_in_usd_of_event_data) filter (where event_name = 'iap_purchase_completed') as revenue from fct_analytics_events`)).rows;
  assert.deepEqual([num(truth.purchases), num(truth.revenue)], [8, 85], '[the truth] 8 completed purchases, 85 of revenue');
  assert.equal(num(revenue.rows[0].revenue), num(truth.revenue), '[a numeric property read with no cast, summed] the warehouse\'s revenue');
  assert.deepEqual([num(conditional.rows[0].purchases), num(conditional.rows[0].purchase_revenue)], [num(truth.purchases), num(truth.revenue)], '[count / sum over a case] the warehouse\'s completed purchases and their revenue');
  // each player's share of rows that are a completed purchase, and whether any is — as the warehouse
  // counts them by its own SQL (a mix of players with and without one: the any is 0 and 1)
  const round = (v) => Math.round(num(v) * 1e9) / 1e9;
  const shares = Object.fromEntries((await wh.query(`select player_id_of_internal as player,
      count(*) filter (where event_name = 'iap_purchase_completed') * 1.0 / count(*) as share,
      bool_or(event_name = 'iap_purchase_completed') as any_purchase
    from fct_analytics_events group by 1`)).rows.map((r) => [String(r.player), [round(r.share), r.any_purchase === true ? 1 : 0]]));
  assert.deepEqual(new Set(Object.values(shares).map(([, any]) => any)), new Set([0, 1]), '[the truth] players with a completed purchase and players without one');
  assert.deepEqual(Object.fromEntries(perPlayer.rows.map((r) => [String(r.player_id_of_internal), [round(r.purchase_share), num(r.any_purchase)]])), shares,
    '[average / max over a case with else 0] the warehouse\'s share of each player\'s rows that are a completed purchase, and whether any is');
  assert.deepEqual(byEvent.rows.map((r) => [r.event_name, num(r.amount)]), [['iap_purchase_completed', 85], ['iap_purchase_failed', 35]]);
  // the completed purchases' 85 passes 50, the failed ones' 35 does not
  assert.deepEqual(over50.rows.map((r) => [r.event_name, num(r.amount)]), [['iap_purchase_completed', 85]]);
});

// A CANCEL, THEN A BATCH AND A QUERY AFTER IT, on the same context: the cancelled tasks end as
// cancelled and the context goes on — the next work (a batch, then a query issued after it) reads the
// warehouse's numbers, and the later query runs once the whole batch is done.
test('a cancelled query ends as cancelled and the context goes on; a query issued after a batch runs once the whole batch is done — each reads the warehouse\'s numbers', opts, async (t) => {
  if (skip(t)) return;
  const context_id = await monContext();
  const doomed = await engine.raw.query_semantic_model({ context_id, queries: [{ steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }] }, { steps: [{ stage: 'metrics', metrics: ['mon_revenue'] }] }] });
  const out = await engine.raw.query_semantic_model({ task_ids: doomed.task_ids, cancel: true });
  assert.deepEqual(out.results.map((r) => r.status), ['cancelled', 'cancelled'], '[cancel] both end as cancelled');
  const read = await engine.raw.query_semantic_model({ task_ids: doomed.task_ids, wait_seconds: 0 });
  assert.deepEqual(read.results.map((r) => r.status), ['cancelled', 'cancelled'], '[cancel] and read back as cancelled');
  // the context goes on: a batch, and a query issued after it
  const batch = await engine.raw.query_semantic_model({ context_id, queries: [{ steps: [{ stage: 'metrics', metrics: ['mon_revenue'] }] }, { steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }] }] });
  const after = await engine.query_semantic_model({ context_id, steps: [{ stage: 'metrics', metrics: ['mon_revenue'], group_by: byCountry }] });
  // by the time the later query is done, every member of the batch is too
  const peek = await engine.raw.query_semantic_model({ task_ids: batch.task_ids, wait_seconds: 0 });
  assert.equal(peek.status, 'done', '[after a batch] the batch is done');
  assert.deepEqual(peek.results.map((r) => r.status), ['done', 'done'], '[after a batch] every member is done');
  assert.equal(num(peek.results[0].rows[0].mon_revenue), 85, '[after a batch] the batch total');
  const g = revenueBy(after.rows);
  assert.deepEqual([g.US, g.GB, g.BR], [35, 25, 25], '[cancel] the next query reads the warehouse\'s numbers');
  assert.deepEqual(revenueBy(peek.results[1].rows), g, '[after a batch] the batch member grouped the same way reads the same numbers');
});
