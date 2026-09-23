// MCP APPS — a tool result rendered as an interactive view in the host's conversation.
//
// Two halves. The protocol half (lifecycle): the viewed tools carry the view in both spellings the
// official ext-apps `registerAppTool` writes (`_meta.ui.resourceUri` and the flat `ui/resourceUri`
// older hosts read), for every client in either protocol revision; the resource is one
// `text/html;profile=mcp-app` document; the result carries `structuredContent` next to its text;
// and the checked-in build of the view is the build of its sources. The data half: the view model
// (src/apps/result-view-model.js, the function the page runs) turns a result into the numbers the
// chart draws, and those are the numbers in the result.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../helpers/mcp-http.js';
import { buildViewModel } from '../../src/apps/result-view-model.js';
import { RESULT_VIEW_URI, RESULT_VIEW_FILE } from '../../src/apps.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const VIEWED = ['query_semantic_model', 'get_query_result', 'experiment'];

test('the viewed tools carry the view in both spellings, for every client in both eras', async () => {
  for (const era of ['legacy', 'modern']) {
    const c = await s.client({ era });
    for (const t of (await c.listTools()).tools) {
      const want = VIEWED.includes(t.name) ? RESULT_VIEW_URI : undefined;
      assert.equal(t._meta?.ui?.resourceUri, want, `${era} ${t.name}`);
      assert.equal(t._meta?.['ui/resourceUri'], want, `${era} ${t.name} (flat key)`);
    }
  }
});

test('the view resource is one mcp-app HTML document, listed and readable in both eras', async () => {
  for (const era of ['legacy', 'modern']) {
    const c = await s.client({ era });
    assert.ok((await c.listResources()).resources.some((r) => r.uri === RESULT_VIEW_URI && r.mimeType === 'text/html;profile=mcp-app'), era);
    const [content] = (await c.readResource({ uri: RESULT_VIEW_URI })).contents;
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.ok(content.text.startsWith('<!DOCTYPE html>') && /<\/html>\s*$/.test(content.text), `${era}: a complete document`);
  }
});

test('the result carries structuredContent equal to the text the model reads (both eras)', async () => {
  const args = { action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 };
  for (const era of ['legacy', 'modern']) {
    const r = await (await s.client({ era })).callTool({ name: 'experiment', arguments: args });
    assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text), era);
    assert.equal(r.structuredContent.n_per_group, 3841, era);
  }
});

test('the checked-in view is the build of its sources (npm run build:app)', async () => {
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'view-build-'));
  await build({ configFile: new URL('../../src/apps/result-view/vite.config.js', import.meta.url).pathname, build: { outDir: out, emptyOutDir: true }, logLevel: 'silent' });
  assert.equal(readFileSync(join(out, 'mcp-app.html'), 'utf8'), readFileSync(RESULT_VIEW_FILE, 'utf8'), 'rebuild the view: npm run build:app');
});

test('view model: a time series by segment is one line per segment, with the rows\' numbers', () => {
  const rows = [
    { metric_time__day: '2024-01-02', country: 'DE', dau: '5' },
    { metric_time__day: '2024-01-01', country: 'DE', dau: '3' },
    { metric_time__day: '2024-01-01', country: 'US', dau: '9' },
    { metric_time__day: '2024-01-02', country: 'US', dau: '11' },
  ];
  const m = buildViewModel('query_semantic_model', { columns: [{ name: 'metric_time__day' }, { name: 'country' }, { name: 'dau' }], rows });
  assert.equal(m.kind, 'table');
  assert.deepEqual(m.columns.map((c) => c.type), ['time', 'category', 'number']);
  assert.equal(m.chart.type, 'line');
  const byName = Object.fromEntries(m.chart.series.map((x) => [x.name, x.points]));
  assert.deepEqual(byName.US, [['2024-01-01', 9], ['2024-01-02', 11]]);
  assert.deepEqual(byName.DE, [['2024-01-01', 3], ['2024-01-02', 5]], 'sorted by time');
  assert.equal(m.rows.length, 4);
});

test('view model: a category and an amount is a bar per category; paging carries the next offset', () => {
  const m = buildViewModel('get_query_result', { status: 'ready', columns: [{ name: 'step' }, { name: 'users' }], rows: [{ step: 'start', users: 100 }, { step: 'finish', users: 37 }], page: { limit: 2, offset: 0, has_more: true } }, { query_id: 'q-9', limit: 2 });
  assert.deepEqual(m.chart.bars, [{ label: 'start', value: 100 }, { label: 'finish', value: 37 }]);
  assert.deepEqual(m.nextPage, { name: 'get_query_result', arguments: { query_id: 'q-9', limit: 2, offset: 2 } });
});

test('view model: the A/B card carries the test\'s own numbers', async () => {
  const r = await s.engine.experiment({ action: 'analyze', metric: 'proportion', control: { n: 5000, conversions: 500 }, variants: [{ label: 'b', n: 5020, conversions: 580 }] });
  const m = buildViewModel('experiment', r);
  assert.equal(m.kind, 'experiment');
  const [v] = m.variants;
  assert.equal(v.variant, 'b');
  assert.equal(v.control_value, 0.1);
  assert.equal(v.variant_value, r.results[0].variant_rate);
  assert.deepEqual(v.ci, r.results[0].confidence_interval);
  assert.equal(v.p_value, r.results[0].p_value);
});

test('view model: each A/B variant carries its verdict, its interval in the headline\'s unit, its group sizes, on one shared scale', async () => {
  const args = { action: 'analyze', metric: 'proportion', control: { n: 5000, conversions: 500 }, variants: [{ label: 'b', n: 5020, conversions: 580 }, { label: 'c', n: 4980, conversions: 470 }] };
  const r = await s.engine.experiment(args);
  const m = buildViewModel('experiment', r, args);
  const [b, c] = m.variants;
  const [rb, rc] = r.results;
  assert.equal(m.significant_count, r.results.filter((x) => x.significant_adjusted).length);
  // the verdict follows the multiplicity-corrected significance and the sign of the lift
  assert.equal(b.verdict, rb.significant_adjusted ? (rb.absolute_lift >= 0 ? 'increase' : 'decrease') : 'no_difference');
  assert.equal(c.verdict, rc.significant_adjusted ? (rc.absolute_lift >= 0 ? 'increase' : 'decrease') : 'no_difference');
  // the plotted interval is the RELATIVE one, the same unit as the headline lift
  assert.deepEqual(b.effect, { unit: 'relative', point: rb.relative_lift, lo: rb.relative_lift_ci[0], hi: rb.relative_lift_ci[1] });
  // group sizes come from the call's input, matched to the variant
  assert.deepEqual([b.n_control, b.n_variant, c.n_variant], [5000, 5020, 4980]);
  // one scale holds every interval of every variant
  for (const v of m.variants) assert.ok(Math.abs(v.effect.lo) <= m.scale && Math.abs(v.effect.hi) <= m.scale);
});

test('view model: a mean with no relative interval plots the absolute one', async () => {
  const args = { action: 'analyze', metric: 'mean', control: { n: 4000, mean: 0, stddev: 1 }, variants: [{ label: 'v', n: 4000, mean: 0.1, stddev: 1 }] };
  const r = await s.engine.experiment(args);
  const [v] = buildViewModel('experiment', r, args).variants;
  assert.equal(r.results[0].relative_lift_ci, null);
  assert.deepEqual(v.effect, { unit: 'absolute', point: r.results[0].absolute_lift, lo: r.results[0].confidence_interval[0], hi: r.results[0].confidence_interval[1] });
});

test('view model: a sample-size plan carries the plan\'s own numbers', async () => {
  const r = await s.engine.experiment({ action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 });
  const m = buildViewModel('experiment', r);
  assert.equal(m.kind, 'plan');
  const fig = Object.fromEntries(m.figures.map((f) => [f.label, f.value]));
  assert.equal(fig['users per group'], r.n_per_group);
  assert.equal(fig['users in total'], r.total_n);
  assert.equal(fig.baseline, 0.1);
});

test('view model: a value distribution, a running build and an error are shown as what they are', () => {
  const d = buildViewModel('semantic_index', { property: 'country', source: 'users', samples: [{ value: 'DE', freq: 7 }, { value: null, freq: 2 }], value_stats: { total_count: 9, distinct_count: 2 } });
  assert.equal(d.kind, 'distribution');
  assert.deepEqual(d.bars.map((b) => b.value), [7, 2]);
  assert.equal(d.total, 9);
  assert.equal(buildViewModel('get_query_result', { status: 'running', query_id: 'q' }).kind, 'running');
  assert.equal(buildViewModel('get_query_result', { ok: false, status: 'error', error: { stage: 'fetch', message: 'boom' } }).kind, 'error');
});
