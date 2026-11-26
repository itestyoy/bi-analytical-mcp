// The value index's CRON SCHEDULE (src/cron.js): which instants an expression names in its time zone,
// what it refuses, and the indexer's syncs on it — one at start, then at each named time, a time that
// comes while a sync still runs passed over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CronSchedule, parseCron } from '../../src/cron.js';
import { BackgroundIndexer } from '../../src/value-indexer.js';

const at = (iso) => new Date(iso);
const nexts = (s, fromIso, n) => {
  const out = []; let t = at(fromIso);
  for (let i = 0; i < n; i += 1) { t = s.next(t); out.push(t.toISOString()); }
  return out;
};

test('a daily time, in UTC and in a zone', () => {
  assert.deepEqual(nexts(new CronSchedule('30 3 * * *'), '2026-11-26T10:00:00Z', 2), ['2026-11-27T03:30:00.000Z', '2026-11-28T03:30:00.000Z']);
  // 03:30 in Moscow (UTC+3) is 00:30 UTC
  assert.deepEqual(nexts(new CronSchedule('30 3 * * *', 'Europe/Moscow'), '2026-11-26T10:00:00Z', 1), ['2026-11-27T00:30:00.000Z']);
  // an exact match of `after` is not repeated: the next one is the day after
  assert.deepEqual(nexts(new CronSchedule('30 3 * * *'), '2026-11-27T03:30:00Z', 1), ['2026-11-28T03:30:00.000Z']);
});

test('steps, ranges, lists, names and macros', () => {
  assert.deepEqual(nexts(new CronSchedule('*/20 * * * *'), '2026-11-26T10:05:00Z', 4), ['2026-11-26T10:20:00.000Z', '2026-11-26T10:40:00.000Z', '2026-11-26T11:00:00.000Z', '2026-11-26T11:20:00.000Z']);
  // weekdays at 06:00 and 18:00: 2026-11-27 is a Friday, so Monday follows
  assert.deepEqual(nexts(new CronSchedule('0 6,18 * * mon-fri'), '2026-11-27T12:00:00Z', 3), ['2026-11-27T18:00:00.000Z', '2026-11-30T06:00:00.000Z', '2026-11-30T18:00:00.000Z']);
  assert.deepEqual(nexts(new CronSchedule('@monthly'), '2026-11-26T00:00:00Z', 2), ['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  // Sunday is 0 or 7
  assert.deepEqual(nexts(new CronSchedule('0 0 * * 7'), '2026-11-26T00:00:00Z', 1), nexts(new CronSchedule('0 0 * * sun'), '2026-11-26T00:00:00Z', 1));
  assert.deepEqual(nexts(new CronSchedule('0 0 * * 7'), '2026-11-26T00:00:00Z', 1), ['2026-11-29T00:00:00.000Z']);
  // a day of month and a day of week both restricted: either one (the 1st, or a Monday)
  assert.deepEqual(nexts(new CronSchedule('0 0 1 * 1'), '2026-11-26T00:00:00Z', 3), ['2026-11-30T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '2026-12-07T00:00:00.000Z']);
  // February 29 comes in a leap year
  assert.deepEqual(nexts(new CronSchedule('0 12 29 2 *'), '2026-11-26T00:00:00Z', 1), ['2028-02-29T12:00:00.000Z']);
});

test('a clock change: a skipped wall minute is not run, a repeated one runs once', () => {
  // Berlin, 2026-03-29: 02:00 → 03:00 (02:30 does not exist); 2026-10-25: 03:00 → 02:00 (02:30 twice)
  const s = new CronSchedule('30 2 * * *', 'Europe/Berlin');
  assert.deepEqual(nexts(s, '2026-03-28T12:00:00Z', 2), ['2026-03-30T00:30:00.000Z', '2026-03-31T00:30:00.000Z']);
  assert.deepEqual(nexts(s, '2026-10-24T12:00:00Z', 2), ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
});

test('what is not a schedule is refused, naming what is wrong', () => {
  for (const [expr, re] of [
    ['30 3 * *', /five are needed/],
    ['60 3 * * *', /minute field '60' has 60, outside 0-59/],
    ['0 25 * * *', /hour field/],
    ['0 0 5-1 * *', /runs backwards/],
    ['*/0 * * * *', /step of 0/],
    ['0 0 * foo *', /month field 'foo'/],
    ['0 0 31 2 *', /never comes/],
    ['@sometimes', /five are needed/],
  ]) assert.throws(() => new CronSchedule(expr), re, expr);
  assert.throws(() => new CronSchedule('0 3 * * *', 'Mars/Olympus'), /not an IANA time zone/);
  assert.equal(parseCron('0 3 * * *').hour.has(3), true);
});

test('the indexer syncs at start, then at each time the schedule names, passing over one that comes mid-sync', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: at('2026-11-26T10:00:00Z').getTime() });
  const logs = [];
  const bi = new BackgroundIndexer({ catalog: {}, runner: {}, index: {}, baseProjectDir: '/tmp/none', intervalMs: 60000, schedule: new CronSchedule('0 * * * *'), logger: (m) => logs.push(m) });
  const runs = [];
  bi.refresh = async () => { runs.push(new Date().toISOString()); };
  bi.start();
  assert.deepEqual(runs, ['2026-11-26T10:00:00.000Z'], 'a sync at start');
  t.mock.timers.tick(30 * 60000); // the interval of a minute is not used
  assert.equal(runs.length, 1);
  t.mock.timers.tick(30 * 60000);
  assert.deepEqual(runs.slice(1), ['2026-11-26T11:00:00.000Z']);
  bi._running = true; // a sync still runs at 12:00
  t.mock.timers.tick(60 * 60000);
  assert.equal(runs.length, 2);
  assert.ok(logs.some((m) => /12:00:00.000Z is skipped/.test(m)));
  bi._running = false;
  t.mock.timers.tick(60 * 60000);
  assert.deepEqual(runs.slice(2), ['2026-11-26T13:00:00.000Z']);
  bi.stop();
  t.mock.timers.tick(60 * 60000);
  assert.equal(runs.length, 3, 'stopped');
});

test('a time further off than a timer holds is waited for in steps', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at('2026-11-26T10:00:00Z').getTime() });
  const bi = new BackgroundIndexer({ catalog: {}, runner: {}, index: {}, baseProjectDir: '/tmp/none', schedule: new CronSchedule('0 0 1 3 *'), logger: () => {} });
  const runs = [];
  bi.refresh = async () => { runs.push(new Date().toISOString()); };
  bi.start();
  t.mock.timers.tick(at('2027-03-01T00:00:00Z').getTime() - at('2026-11-26T10:00:00Z').getTime() - 1);
  assert.equal(runs.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(runs, ['2026-11-26T10:00:00.000Z', '2027-03-01T00:00:00.000Z']);
  bi.stop();
});

