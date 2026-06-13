import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localToUtc, resolveTimeRange, timeRangeWarnings, isValidTimezone } from '../../src/time-range.js';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

// Pure boundary math (no warehouse): wall-clock → UTC instants, incl. DST edges.
test('localToUtc converts wall-clock boundaries to UTC instants (incl. DST)', () => {
  // Berlin is UTC+1 in winter: local midnight Jan 15 = 23:00 UTC the day before.
  assert.equal(localToUtc('2026-01-15', 'Europe/Berlin'), '2026-01-14 23:00:00');
  // ...and UTC+2 in summer.
  assert.equal(localToUtc('2026-07-15 12:00:00', 'Europe/Berlin'), '2026-07-15 10:00:00');
  // UTC passthrough.
  assert.equal(localToUtc('2026-01-15 08:30:00', 'UTC'), '2026-01-15 08:30:00');
  // East of UTC: Tokyo local midnight is 15:00 UTC the previous day.
  assert.equal(localToUtc('2026-01-15', 'Asia/Tokyo'), '2026-01-14 15:00:00');
  // not a date → null.
  assert.equal(localToUtc('nope', 'UTC'), null);
  assert.ok(isValidTimezone('Europe/Berlin'));
  assert.ok(!isValidTimezone('Mars/Olympus'));
});

test('resolveTimeRange: date-only end = WHOLE local day (exclusive next midnight)', () => {
  const r = resolveTimeRange({ start: '2026-01-01', end: '2026-01-31', timezone: 'Europe/Berlin' });
  assert.equal(r.start, '2025-12-31 23:00:00');           // Jan 1 00:00 Berlin
  assert.equal(r.endExclusive, '2026-01-31 23:00:00');    // Feb 1 00:00 Berlin
  // without a timezone the values pass through (warehouse-native semantics).
  const plain = resolveTimeRange({ start: '2026-01-01', end: '2026-01-31' });
  assert.equal(plain.start, '2026-01-01');
  assert.equal(plain.endExclusive, '2026-02-01'); // date-only end is still whole-day
  // datetime end stays inclusive.
  const dt = resolveTimeRange({ end: '2026-01-31 12:00:00', timezone: 'UTC' });
  assert.equal(dt.end, '2026-01-31 12:00:00');
  assert.equal(dt.endExclusive, null);
});

test('timeRangeWarnings: unbounded and incomplete-period windows are flagged', () => {
  const now = new Date('2026-06-09T12:00:00Z');
  assert.equal(timeRangeWarnings(null, now).length, 1);                                  // unbounded
  assert.equal(timeRangeWarnings({}, now).length, 1);                                    // unbounded
  assert.equal(timeRangeWarnings({ start: '2026-06-01' }, now).length, 1);               // open end → incomplete
  assert.equal(timeRangeWarnings({ start: '2026-06-01', end: '2026-06-09' }, now).length, 1); // includes today
  assert.equal(timeRangeWarnings({ start: '2026-05-01', end: '2026-05-31' }, now).length, 0); // complete window
});

// Guard (input validation): require_time_range blocks unbounded pipelines at registration.
test('require_time_range rejects an unbounded pipeline; a bounded one passes validation', async () => {
  const CATALOG = new URL('../integration/fixtures/catalog.yml', import.meta.url).pathname;
  const catalog = loadCatalog(CATALOG, { requireTimeRange: true });
  assert.equal(catalog.requireTimeRange, true);
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'tr-')) }) });
  const s = await e.build_native_model({ action: 'start', name: 'guard', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] } });
  // commit without a time window → blocked by the guardrail.
  await assert.rejects(() => e.build_native_model({ action: 'materialize', draft_id: s.draft_id }), /require_time_range/);
  // the same pipeline WITH a window passes validation (fails later only because no runner is wired).
  const s2 = await e.build_native_model({ action: 'start', name: 'guarded', source: 'events', time_range: { start: '2026-01-01', end: '2026-01-31' } });
  await e.build_native_model({ action: 'add_step', draft_id: s2.draft_id, stage: { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] } });
  const out = await e.build_native_model({ action: 'materialize', draft_id: s2.draft_id });
  assert.equal(out.kind, 'pipeline'); // reached registration (no time-range rejection)
  // a stage-level where on the time column ALSO satisfies the guard.
  const s3 = await e.build_native_model({ action: 'start', name: 'wherebound', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s3.draft_id, stage: { stage: 'where', conditions: [{ column: 'device_time', op: 'gte', value: '2026-01-01' }] } });
  await e.build_native_model({ action: 'add_step', draft_id: s3.draft_id, stage: { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] } });
  const out3 = await e.build_native_model({ action: 'materialize', draft_id: s3.draft_id });
  assert.equal(out3.kind, 'pipeline');
});

// Default: no flag → unbounded pipelines still allowed (backwards-safe).
test('without require_time_range an unbounded pipeline is not rejected', async () => {
  const CATALOG = new URL('../integration/fixtures/catalog.yml', import.meta.url).pathname;
  const catalog = loadCatalog(CATALOG, {});
  assert.equal(catalog.requireTimeRange, false);
  const e = new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'tr0-')) }) });
  const s = await e.build_native_model({ action: 'start', name: 'free', source: 'events' });
  await e.build_native_model({ action: 'add_step', draft_id: s.draft_id, stage: { stage: 'aggregate', group_by: ['event_name'], measures: [{ name: 'n', fn: 'count' }] } });
  const out = await e.build_native_model({ action: 'materialize', draft_id: s.draft_id });
  assert.equal(out.kind, 'pipeline');
});
