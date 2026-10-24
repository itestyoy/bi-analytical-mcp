// A WHERE ON THE TIME AXIS WITH AN OFFSET OF ITS OWN READS THE ROWS OF THAT INSTANT. The events source is
// partitioned by event_date, the day next to device_time, so a where that bounds device_time gets a bound on
// event_date too — the days the instant touches on the warehouse clock (UTC). '2026-01-05T00:00:00+14:00'
// is 2026-01-04 10:00 UTC: its partition day is the 4th, and a bound at the 5th (the day the text starts
// with) would drop the rows of 2026-01-04 10:00–24:00 (SEED_DATA: 10 events of the 4th's 10:00 and 11:00
// hours). Proven on DATA against DuckDB: the count with the offset (±hh:mm, or the hour alone) equals the
// count of the same instant written in UTC, and the warehouse's own count of it; and the fraction of a
// second written with an offset is kept to the microsecond.
// Auto-skips when dbt/mf are not installed (HAS_DBT gate).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildWarehouse, fixtureProject } from './warehouse-harness.js';
import { settle } from '../helpers/settle.js';
import { HAS_DBT, testDbt } from '../helpers/dbt-env.js';
import { tempDir } from '../helpers/temp-dir.js';

const BASE = fixtureProject('dbt_project'); // a private copy: the test files run side by side
const opts = { timeout: 300000 };
const num = (v) => Number(v === '' || v == null ? NaN : v);

let wh;
let engine;
let seq = 0;

before(async () => {
  if (!HAS_DBT) return;
  wh = await buildWarehouse(BASE); // the run's one build of the fixture, copied
  const catalog = loadCatalog(join(process.cwd(), 'test', 'integration', 'fixtures', 'catalog.yml'), { profilesDir: BASE, projectDir: BASE });
  const ctxs = new ContextManager({ baseProjectDir: BASE, workspaceRoot: tempDir('sql-review-b'), timeSpineDialect: 'duckdb' });
  engine = settle(new Engine({ catalog, contextManager: ctxs, runner: testDbt({ profilesDir: BASE }) }));
}, opts);

after(async () => { if (wh) await wh.stop(); });
const skip = (t) => { if (!HAS_DBT) { t.skip('dbt/mf not installed'); return true; } return false; };

/** The events a pipeline keeps with one where on device_time (the first step: the rows are the source's,
 *  so the partition bound is added to it), counted. */
async function countWhere(fn, ...values) {
  const s = await engine.build_model({ action: 'start', name: `bound_${seq++}`, source: 'events' });
  await engine.build_model({ action: 'add_steps', context_id: s.context_id, steps: [
    { stage: 'where', conditions: [{ fn, args: [{ column: 'device_time' }, ...values.map((value) => ({ value }))] }] },
    { stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] },
  ] });
  const c = await engine.build_model({ action: 'materialize', context_id: s.context_id });
  assert.equal(c.build?.ok, true, JSON.stringify(c.error || c.build));
  return num(c.rows[0].n);
}

test('a where on the time axis with an offset keeps the rows of its UTC instant: the partition day is the instant\'s, not the one the text starts with', opts, async (t) => {
  if (skip(t)) return;
  const [want] = (await wh.query(`select
      count(*) filter (where device_time >= timestamp '2026-01-04 10:00:00') as since,
      count(*) filter (where device_time >= timestamp '2026-01-05 00:00:00') as next_day,
      count(*) filter (where device_time between timestamp '2026-01-04 10:00:00' and timestamp '2026-01-05 09:30:00') as within
    from fct_analytics_events`)).rows;
  // the window starts on the 4th in UTC and holds rows of that day: a bound at the 5th would lose them
  assert.ok(num(want.since) > num(want.next_day), 'the fixture has rows between the instant and the next UTC midnight');

  const utc = await countWhere('gte', '2026-01-04 10:00:00');
  assert.equal(utc, num(want.since), '[UTC] the instant written in UTC');
  // the same instant with an offset of its own: one hour into the next day at +14:00 — and the 4th in UTC
  assert.equal(await countWhere('gte', '2026-01-05T00:00:00+14:00'), utc, '[offset] the same instant, written at +14:00');
  // both ends of a between, each an instant with its own offset
  const within = await countWhere('between', '2026-01-05T00:00:00+14:00', '2026-01-05T14:30:00+05:00');
  assert.equal(within, num(want.within), '[offset] between two instants with offsets');
  assert.equal(within, await countWhere('between', '2026-01-04 10:00:00', '2026-01-05 09:30:00'), '[UTC] the same window written in UTC');
});

// An offset of the hour alone (±hh) is the same instant: '2026-01-05T00:00:00+14' is 2026-01-04 10:00 UTC,
// and its partition day the 4th.
test('a where on the time axis with an hour-only offset keeps the rows of its UTC instant', opts, async (t) => {
  if (skip(t)) return;
  const utc = await countWhere('gte', '2026-01-04 10:00:00');
  assert.equal(await countWhere('gte', '2026-01-05T00:00:00+14'), utc, '[+14] the same instant');
  assert.equal(await countWhere('gte', '2026-01-04T00:00:00-10'), utc, '[-10] the same instant');
});

// The fraction of a second written with an offset is kept to the microsecond: a bound one microsecond after
// an event's time leaves that event out (cut to the millisecond, the bound would be the event's own time and
// keep it). The event is the fixture's e1 (a whole second); its neighbours at the same second count alike.
test('a where on the time axis with an offset keeps the microseconds of its bound', opts, async (t) => {
  if (skip(t)) return;
  const [e1] = (await wh.query(`select strftime(device_time, '%Y-%m-%d') as day, strftime(device_time, '%H:%M:%S') as tod,
      strftime(device_time + interval 5 hour, '%Y-%m-%dT%H:%M:%S') as plus5, epoch_us(device_time) % 1000000 as us
    from fct_analytics_events where event_id = 'e1'`)).rows;
  assert.equal(num(e1.us), 0, 'e1 is at a whole second');
  const [want] = (await wh.query(`select count(*) filter (where device_time > t) as after, count(*) filter (where device_time >= t) as since
    from fct_analytics_events, (select device_time as t from fct_analytics_events where event_id = 'e1')`)).rows;
  assert.ok(num(want.since) > num(want.after), 'rows at e1\'s own time tell the two bounds apart');
  assert.equal(await countWhere('gte', `${e1.day}T${e1.tod}.000001Z`), num(want.after), '[Z] a microsecond after e1');
  assert.equal(await countWhere('gte', `${e1.plus5}.000001+05:00`), num(want.after), '[+05:00] the same instant');
  assert.equal(await countWhere('gt', `${e1.day}T${e1.tod}.000000Z`), num(want.after), '[gt, a zero fraction] e1\'s own time');
  assert.equal(await countWhere('gte', `${e1.day}T${e1.tod}Z`), num(want.since), '[Z] e1\'s own time');
});
