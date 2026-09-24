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
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

test('the view draws and follows only its own query: one tool is app-callable, no network, one server call in its code', async () => {
  for (const era of ['legacy', 'modern']) {
    const c = await s.client({ era });
    // a host refuses a view's tools/call to a tool that is not visible to "app": only the read of a result is
    for (const t of (await c.listTools()).tools) assert.deepEqual(t._meta?.ui?.visibility, t.name === 'get_query_result' ? ['model', 'app'] : ['model'], `${era} ${t.name}`);
    const [content] = (await c.readResource({ uri: RESULT_VIEW_URI })).contents;
    assert.deepEqual(content._meta?.ui?.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, `${era}: no origin of any kind`);
  }
  // the view's own code: no App method that reaches the model or other server methods, no network API
  const REACHES_OUT = /\b(readServerResource|listServerResources|createSamplingMessage|sendMessage|updateModelContext|openLink|downloadFile|sendLog|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/;
  const dir = new URL('../../src/apps/result-view/src/', import.meta.url).pathname;
  const sources = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f)), new URL('../../src/apps/result-view-model.js', import.meta.url).pathname];
  const toolCalls = [];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const hit = text.match(REACHES_OUT);
    assert.equal(hit, null, `${file} calls ${hit?.[1]}`);
    for (const m of text.matchAll(/callServerTool\s*\(([^)]*)\)/g)) toolCalls.push(m[1]);
  }
  // exactly one tools/call: get_query_result, with nothing but the query_id of the card's own result
  assert.equal(toolCalls.length, 1, `server tool calls: ${toolCalls.join(' | ')}`);
  assert.deepEqual(toolCalls[0].replace(/\s+/g, ' ').trim(), "{ name: 'get_query_result', arguments: { query_id: queryId } }");
});

test('view model: a result that moved to the background carries the query_id the card follows', () => {
  const m = buildViewModel('query_semantic_model', { ok: true, status: 'running', query_id: 'abc123abc123' });
  assert.deepEqual(m, { kind: 'none', reason: 'running', query_id: 'abc123abc123' });
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
  assert.equal(m.kind, 'chart');
  assert.deepEqual(m.columns.map((c) => c.type), ['time', 'category', 'number']);
  assert.equal(m.chart.type, 'line');
  const byName = Object.fromEntries(m.chart.series.map((x) => [x.name, x.points]));
  assert.deepEqual(byName.US, [['2024-01-01', 9], ['2024-01-02', 11]]);
  assert.deepEqual(byName.DE, [['2024-01-01', 3], ['2024-01-02', 5]], 'sorted by time');
  assert.equal(m.rows.length, 4);
});

test('view model: a category and an amount is a bar per category', () => {
  const m = buildViewModel('get_query_result', { status: 'ready', columns: [{ name: 'country' }, { name: 'users' }], rows: [{ country: 'US', users: 100 }, { country: 'DE', users: 37 }], page: { limit: 2, offset: 0, has_more: true } }, { query_id: 'q-9', limit: 2 });
  assert.equal(m.kind, 'chart', 'a breakdown sorted by size is a chart, not a funnel');
  assert.deepEqual(m.chart.bars, [{ label: 'US', value: 100 }, { label: 'DE', value: 37 }]);
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

test('A/B outcome: the same significant rise is an improvement where up is good and a regression where down is', async () => {
  // crash sessions: 400 of 10 000 in control, 520 of 10 000 in the variant — a clear rise
  const args = { action: 'analyze', metric: 'proportion', control: { n: 10000, conversions: 400 }, variants: [{ label: 'new_sdk', n: 10000, conversions: 520 }] };
  const up = await s.engine.experiment(args);
  const down = await s.engine.experiment({ ...args, good: 'down' });
  // no statistic changes with the reading
  assert.equal(down.results[0].p_value, up.results[0].p_value);
  assert.equal(down.results[0].absolute_lift, 0.052 - 0.04);
  assert.equal(up.results[0].significant_adjusted, true);
  assert.deepEqual([up.good, up.results[0].outcome], ['up', 'better']);
  assert.deepEqual([down.good, down.results[0].outcome], ['down', 'worse']);
  assert.ok(down.recommendations.some((x) => x.startsWith('new_sdk is significantly WORSE')));
  // the card carries it: the direction stays "increase", its reading flips
  const m = buildViewModel('experiment', down, { ...args, good: 'down' });
  assert.equal(m.good, 'down');
  assert.deepEqual([m.variants[0].verdict, m.variants[0].outcome], ['increase', 'worse']);
  // a result with no significance reads as no difference either way
  const flat = await s.engine.experiment({ ...args, good: 'down', variants: [{ label: 'same', n: 10000, conversions: 402 }] });
  assert.equal(flat.results[0].outcome, 'no_difference');
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

test('view model: a funnel from a row per step carries each step\'s share of the first and of the previous', () => {
  const rows = [{ step: '1_start', users: 10000 }, { step: '2_move', users: 7400 }, { step: '3_match', users: 5100 }, { step: '4_finish', users: 3900 }];
  const m = buildViewModel('get_query_result', { status: 'ready', table: 'pipe_tutorial', columns: [{ name: 'step' }, { name: 'users' }], rows });
  assert.equal(m.kind, 'funnel');
  assert.equal(m.measure, 'users');
  assert.deepEqual(m.steps.map((x) => [x.label, x.value]), rows.map((r) => [r.step, r.users]));
  assert.deepEqual(m.steps.map((x) => x.of_first), [1, 0.74, 0.51, 0.39]);
  assert.deepEqual(m.steps.map((x) => x.of_previous), [null, 0.74, 5100 / 7400, 3900 / 5100]);
  assert.equal(m.overall, 0.39);
  assert.equal(m.biggest_drop, 2, '7400 → 5100 keeps the smallest share');
});

test('view model: a funnel from one row of step counts keeps the metrics\' names and skips the ratios', () => {
  const m = buildViewModel('query_semantic_model', { columns: [{ name: 'tut_funnel_step1' }, { name: 'tut_funnel_step2' }, { name: 'tut_funnel_step3' }, { name: 'tut_funnel_conv_1_2' }], rows: [{ tut_funnel_step1: 1000, tut_funnel_step2: 700, tut_funnel_step3: 420, tut_funnel_conv_1_2: 0.7 }] });
  assert.equal(m.kind, 'funnel');
  assert.deepEqual(m.steps.map((x) => [x.label, x.value]), [['tut_funnel_step1', 1000], ['tut_funnel_step2', 700], ['tut_funnel_step3', 420]]);
  assert.equal(m.overall, 0.42);
});

test('view model: counts that merely decrease, or steps that grow, are not a funnel', () => {
  // two unrelated metrics in one row: no step-like names
  assert.equal(buildViewModel('query_semantic_model', { columns: [{ name: 'dau' }, { name: 'new_users' }], rows: [{ dau: 1000, new_users: 300 }] }).kind, 'none');
  // step-named rows whose counts grow: a bar chart, not a funnel
  assert.equal(buildViewModel('get_query_result', { columns: [{ name: 'step' }, { name: 'users' }], rows: [{ step: 'a', users: 5 }, { step: 'b', users: 9 }] }).kind, 'chart');
});

test('view model: a DECLARED funnel draws the declared steps with their labels, whatever the columns are called', () => {
  const row = { installs: 1000, first_level: 640, day2: 380, spend: 12.5 };
  const m = buildViewModel('get_query_result', { columns: Object.keys(row).map((name) => ({ name })), rows: [row], display: { kind: 'funnel', title: 'Onboarding', steps: [{ column: 'installs', label: 'Install' }, { column: 'first_level', label: 'Level 1' }, { column: 'day2' }] } });
  assert.equal(m.kind, 'funnel');
  assert.equal(m.title, 'Onboarding');
  assert.deepEqual(m.steps.map((x) => [x.label, x.value]), [['Install', 1000], ['Level 1', 640], ['day2', 380]]);
  assert.equal(m.overall, 0.38);
});

test('view model: a DECLARED line over a non-time axis keeps the row order; series_column splits one value into lines', () => {
  const rows = [{ level: 'L3', country: 'US', users: 90 }, { level: 'L1', country: 'US', users: 200 }, { level: 'L3', country: 'GB', users: 30 }, { level: 'L1', country: 'GB', users: 80 }];
  const m = buildViewModel('get_query_result', { columns: [{ name: 'level' }, { name: 'country' }, { name: 'users' }], rows, display: { kind: 'line', x: 'level', y: ['users'], series_column: 'country' } });
  assert.equal(m.kind, 'chart');
  assert.equal(m.chart.ordered, true);
  assert.deepEqual(m.chart.series.map((x) => [x.name, x.points]), [['US', [['L3', 90], ['L1', 200]]], ['GB', [['L3', 30], ['L1', 80]]]]);
  // a time axis is put in time order even when the rows are not
  const t = buildViewModel('query_semantic_model', { columns: [{ name: 'metric_time_day' }, { name: 'dau' }], rows: [{ metric_time_day: '2026-09-02', dau: 5 }, { metric_time_day: '2026-09-01', dau: 3 }], display: { kind: 'line', x: 'metric_time_day', y: ['dau'] } });
  assert.equal(t.chart.ordered, false);
  assert.deepEqual(t.chart.series[0].points, [['2026-09-01', 3], ['2026-09-02', 5]]);
});

test('view model: a DECLARED bar split by a column groups (or stacks) a bar per value inside each category', () => {
  const rows = [{ c: 'US', p: 'ios', v: 420 }, { c: 'US', p: 'android', v: 310 }, { c: 'BR', p: 'android', v: 180 }, { c: 'BR', p: 'ios', v: 40 }, { c: 'BR', p: 'ios', v: 5 }];
  const cols = [{ name: 'c' }, { name: 'p' }, { name: 'v' }];
  const m = buildViewModel('get_query_result', { columns: cols, rows, display: { kind: 'bar', x: 'c', y: ['v'], series_column: 'p', stacked: true, horizontal: true } });
  assert.equal(m.chart.type, 'bar');
  assert.deepEqual(m.chart.labels, ['US', 'BR'], 'categories in the order they first appear');
  // the largest series first (android 490 > ios 465); a category × series seen twice is summed
  assert.deepEqual(m.chart.series, [{ name: 'android', values: [310, 180] }, { name: 'ios', values: [420, 45] }]);
  assert.equal(m.chart.stacked, true);
  assert.equal(m.chart.horizontal, true);
  // several y columns: a bar each per category, grouped
  const g = buildViewModel('get_query_result', { columns: [{ name: 'c' }, { name: 'a' }, { name: 'b' }], rows: [{ c: 'x', a: 1, b: 2 }, { c: 'y', a: 3, b: 4 }], display: { kind: 'bar', x: 'c', y: ['a', 'b'] } });
  assert.deepEqual(g.chart.series, [{ name: 'a', values: [1, 3] }, { name: 'b', values: [2, 4] }]);
  assert.equal(g.chart.stacked, false);
});

test('view model: a DECLARED area stacks its series; a single line stays a line', () => {
  const rows = [{ d: '2026-09-01', p: 'ios', n: 5 }, { d: '2026-09-01', p: 'web', n: 1 }, { d: '2026-09-02', p: 'ios', n: 6 }, { d: '2026-09-02', p: 'web', n: 2 }];
  const m = buildViewModel('get_query_result', { columns: [{ name: 'd' }, { name: 'p' }, { name: 'n' }], rows, display: { kind: 'area', x: 'd', y: ['n'], series_column: 'p' } });
  assert.equal(m.chart.area, true);
  assert.equal(m.chart.stacked, true);
  assert.deepEqual(m.chart.series.map((x) => [x.name, x.points.map((p) => p[1])]), [['ios', [5, 6]], ['web', [1, 2]]]);
  const l = buildViewModel('get_query_result', { columns: [{ name: 'd' }, { name: 'p' }, { name: 'n' }], rows, display: { kind: 'line', x: 'd', y: ['n'], series_column: 'p' } });
  assert.equal(l.chart.area, undefined);
});

test('view model: a DECLARED pie is slices in size order with their shares; past six the smallest fold into Other', () => {
  const vals = [['US', 730], ['GB', 270], ['BR', 220], ['DE', 160], ['FR', 95], ['JP', 60], ['KR', 40], ['IN', 25]];
  const m = buildViewModel('get_query_result', { columns: [{ name: 'c' }, { name: 'v' }], rows: vals.map(([c, v]) => ({ c, v })).reverse(), display: { kind: 'pie', label_column: 'c', value_column: 'v' } });
  assert.equal(m.chart.type, 'pie');
  assert.equal(m.chart.total, 1600);
  assert.deepEqual(m.chart.slices.map((x) => [x.label, x.value]), [['US', 730], ['GB', 270], ['BR', 220], ['DE', 160], ['FR', 95], ['Other', 125]]);
  assert.equal(m.chart.folded, 3);
  assert.ok(Math.abs(m.chart.slices.reduce((a, x) => a + x.share, 0) - 1) < 1e-12, 'the slices make up the whole');
});

test('view model: KPI tiles read one row, with the change against a previous column', () => {
  const row = { revenue: 184230.5, revenue_prev: 171020, crash_rate: 0.0041, crash_rate_prev: 0.0052 };
  const m = buildViewModel('get_query_result', { columns: Object.keys(row).map((name) => ({ name })), rows: [row], display: { kind: 'kpi', values: [{ column: 'revenue', label: 'Revenue', format: 'currency', previous_column: 'revenue_prev', good: 'up' }, { column: 'crash_rate', format: 'percent', previous_column: 'crash_rate_prev', good: 'down' }] } });
  assert.equal(m.kind, 'kpi');
  assert.deepEqual(m.tiles.map((t) => [t.label, t.value, t.previous, t.good]), [['Revenue', 184230.5, 171020, 'up'], ['crash_rate', 0.0041, 0.0052, 'down']]);
  assert.equal(m.tiles[0].change, (184230.5 - 171020) / 171020);
  assert.equal(m.tiles[1].change, (0.0041 - 0.0052) / 0.0052);
  assert.equal(m.tiles[0].trend, null);
});

test('view model: KPI tiles over a time axis show the LAST row, its change from the row before and the trend', () => {
  const rows = [{ d: '2026-09-03', dau: 130 }, { d: '2026-09-01', dau: 100 }, { d: '2026-09-02', dau: 120 }];
  const m = buildViewModel('query_semantic_model', { columns: [{ name: 'd' }, { name: 'dau' }], rows, display: { kind: 'kpi', x: 'd', values: [{ column: 'dau' }] } });
  assert.equal(m.as_of, '2026-09-03');
  assert.equal(m.compared_to, '2026-09-02');
  assert.deepEqual([m.tiles[0].value, m.tiles[0].previous], [130, 120]);
  assert.deepEqual(m.tiles[0].trend, [100, 120, 130], 'in time order, whatever order the rows came in');
});

test('view model: a sankey sums a link seen twice, drops empty flows and sizes each node by what passes through', () => {
  const rows = [['organic', 'ios', 40], ['organic', 'ios', 2], ['organic', 'android', 60], ['ios', 'payer', 5], ['android', 'payer', 4], ['android', 'x', null]].map(([a, b, v]) => ({ a, b, v }));
  const m = buildViewModel('get_query_result', { columns: [{ name: 'a' }, { name: 'b' }, { name: 'v' }], rows, display: { kind: 'sankey', source_column: 'a', target_column: 'b', value_column: 'v' } });
  assert.equal(m.chart.type, 'sankey');
  assert.deepEqual(m.chart.links, [{ from: 'organic', to: 'ios', flow: 42 }, { from: 'organic', to: 'android', flow: 60 }, { from: 'ios', to: 'payer', flow: 5 }, { from: 'android', to: 'payer', flow: 4 }]);
  assert.deepEqual(m.chart.nodes.map((n) => [n.name, n.size]), [['organic', 102], ['android', 60], ['ios', 42], ['payer', 9]]);
});

test('display guard: a sankey that loops back, or KPI tiles over many rows with no axis, are refused', () => {
  const links = [{ a: 'menu', b: 'level' }, { a: 'level', b: 'shop' }, { a: 'shop', b: 'menu' }].map((r) => ({ ...r, v: 1 }));
  const loop = s.engine._displayProblems({ kind: 'sankey', source_column: 'a', target_column: 'b', value_column: 'v' }, ['a', 'b', 'v'], links);
  assert.equal(loop.length, 1);
  assert.equal(s.engine._displayProblems({ kind: 'sankey', source_column: 'a', target_column: 'b', value_column: 'v' }, ['a', 'b', 'v'], links.slice(0, 2)).length, 0, 'a chain is fine');
  assert.equal(s.engine._displayProblems({ kind: 'kpi', values: [{ column: 'v' }] }, ['a', 'b', 'v'], links).length, 1);
  assert.equal(s.engine._displayProblems({ kind: 'kpi', x: 'a', values: [{ column: 'v' }] }, ['a', 'b', 'v'], links).length, 0);
});

test('view model: a declaration the rows cannot fill falls back to the inferred card', () => {
  // step counts with a NULL first step cannot be a funnel; the step-per-row shape is still a bar chart
  const m = buildViewModel('get_query_result', { columns: [{ name: 'step' }, { name: 'users' }], rows: [{ step: 'a', users: null }, { step: 'b', users: 4 }], display: { kind: 'funnel', steps: { label_column: 'step', value_column: 'users' } } });
  assert.equal(m.kind, 'chart');
  assert.equal(m.chart.type, 'bar');
});

test('view model: the sample-ratio check carries each group\'s observed and intended share, from the engine\'s own test', async () => {
  const r = await s.engine.experiment({ action: 'check_split', groups: [{ label: 'base', n: 41164 }, { label: 'a', n: 41585 }] });
  const m = buildViewModel('experiment', r);
  assert.equal(m.kind, 'srm');
  assert.equal(m.srm_detected, r.srm_detected);
  assert.equal(m.p_value, r.p_value);
  assert.equal(m.total, 41164 + 41585);
  assert.deepEqual(m.groups.map((g) => [g.label, g.observed]), [['base', 41164], ['a', 41585]]);
  assert.deepEqual(m.groups.map((g) => g.observed_share), [41164 / 82749, 41585 / 82749]);
  assert.deepEqual(m.groups.map((g) => g.expected_share), [0.5, 0.5]);
});

test('view model: a sample-size plan says which side it solved and carries the plan\'s own numbers', async () => {
  const forN = await s.engine.experiment({ action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 });
  const n = buildViewModel('experiment', forN);
  assert.equal(n.kind, 'plan');
  assert.equal(n.solved, 'n');
  assert.deepEqual([n.n_per_group, n.total_n, n.baseline, n.mde], [forN.n_per_group, forN.total_n, 0.1, 0.02]);
  const forMde = await s.engine.experiment({ action: 'plan', metric: 'proportion', baseline: 0.1, n: 5000 });
  const d = buildViewModel('experiment', forMde);
  assert.equal(d.solved, 'mde');
  assert.equal(d.mde, forMde.mde);
  assert.equal(d.n_per_group, 5000);
});

test('view model: a result with no card is none, with its reason', () => {
  for (const [tool, result, reason] of [
    ['get_query_result', { status: 'running', query_id: 'q' }, 'running'],
    ['get_query_result', { ok: false, status: 'error', error: { stage: 'fetch', message: 'boom\nsecond line' } }, 'error'],
    ['query_semantic_model', { ok: true, sql: 'select 1' }, 'sql'],
    ['query_semantic_model', { columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], rows: [{ a: 'x', b: 'y', c: 'z' }] }, 'no_chart_shape'],
  ]) {
    const m = buildViewModel(tool, result);
    assert.equal(m.kind, 'none', JSON.stringify(result).slice(0, 80));
    assert.equal(m.reason, reason);
  }
});
