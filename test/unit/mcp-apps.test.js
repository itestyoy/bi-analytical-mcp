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
import { startServer, APPS_CAPS } from '../helpers/mcp-http.js';
import { buildViewModel, drillView, pivotRows, pivotTransform } from '../../src/apps/result-view-model.js';
import { RESULT_VIEW_URI, RESULT_VIEW_FILE } from '../../src/apps.js';
import { runTool, toCallToolResult } from '../../src/mcp-surface.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const VIEWED = ['display_model_result', 'experiment'];
const APPS_ONLY = ['display_model_result', 'drill_result'];

test('the two drawing tools carry the view, in both spellings — for a client that declares MCP Apps in its request', async () => {
  const c = await s.client({ era: 'modern', capabilities: APPS_CAPS });
  const tools = (await c.listTools()).tools;
  for (const t of tools) {
    const want = VIEWED.includes(t.name) ? RESULT_VIEW_URI : undefined;
    assert.equal(t._meta?.ui?.resourceUri, want, t.name);
    assert.equal(t._meta?.['ui/resourceUri'], want, `${t.name} (flat key)`);
  }
  assert.ok(tools.find((t) => t.name === 'display_model_result').inputSchema.properties.display, 'display is declared on display_model_result');
  for (const name of ['query_semantic_model', 'query_pipeline_model', 'experiment']) assert.equal(tools.find((t) => t.name === name).inputSchema.properties.display, undefined, `${name} takes no model card declaration`);
  assert.ok(tools.find((t) => t.name === 'experiment').inputSchema.properties.card, 'experiment asks for its own card with card: true');
  assert.ok(c.getInstructions().includes('RESULT CARDS'), 'and the instructions tell how cards work');
});

test('a client that does not declare MCP Apps in its request gets none of it: no view, no display_model_result, no card hints — and a call to it is refused', async () => {
  // a 2025 client declares its capabilities once, in initialize: its later requests carry none, so
  // even a declaration there does not turn the feature on; a 2026 client that declares nothing neither
  for (const [era, capabilities] of [['legacy', APPS_CAPS], ['legacy', {}], ['modern', {}]]) {
    const label = `${era} ${capabilities.extensions ? 'declaring at initialize' : 'declaring nothing'}`;
    const c = await s.client({ era, capabilities });
    const tools = (await c.listTools()).tools;
    for (const t of tools) assert.equal(t._meta?.ui, undefined, `${label}: ${t.name} carries no _meta.ui`);
    for (const name of APPS_ONLY) assert.equal(tools.find((t) => t.name === name), undefined, `${label}: ${name} is not offered`);
    assert.equal(tools.find((t) => t.name === 'experiment').inputSchema.properties.card, undefined, `${label}: experiment offers no card`);
    const card = await c.callTool({ name: 'experiment', arguments: { action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02, card: true } });
    assert.equal(card.isError, true, `${label}: card is refused`);
    assert.equal(JSON.parse(card.content[0].text).error.field, 'card', label);
    assert.ok(!(await c.listResources()).resources.some((r) => r.uri === RESULT_VIEW_URI), `${label}: the view is not listed`);
    // …but a card already in a conversation is re-drawn when the chat is reopened, on a fetch that
    // need not carry the declaration: the page itself is readable by its URI
    const [page] = (await c.readResource({ uri: RESULT_VIEW_URI })).contents;
    assert.equal(page.mimeType, 'text/html;profile=mcp-app', `${label}: the page of a stored card is served`);
    assert.ok(!c.getInstructions().includes('RESULT CARDS'), `${label}: no card instructions`);
    const r = await c.callTool({ name: 'display_model_result', arguments: { task_id: 'ffffffffffff' } });
    assert.equal(r.isError, true, label);
    assert.match(JSON.parse(r.content[0].text).error.message, /MCP Apps/, label);
  }
});

test('the hint to show a result as a card reaches only a client that renders cards', async () => {
  // a stand-in tool answering the way a query tool's read ({ task_id }) does for a finished result with rows
  const engine = { schemas: { result_like: {} }, result_like: () => ({ ok: true, rows: [{ n: 1 }], show_to_user: { tool: 'display_model_result', arguments: { task_id: 'aabbccddeeff' } } }) };
  const withCards = await runTool(engine, 'result_like', {}, { renders: true });
  const without = await runTool(engine, 'result_like', {}, { renders: false });
  assert.deepEqual(withCards.raw.show_to_user.arguments, { task_id: 'aabbccddeeff' });
  assert.equal('show_to_user' in without.raw, false);
  assert.deepEqual(without.raw.rows, [{ n: 1 }], 'the answer itself is the same');
});

test('the view reads only its own result: one tool is app-callable (and only by the app), no network, one server call in its code', async () => {
  {
    const c = await s.client({ era: 'modern', capabilities: APPS_CAPS });
    // a host refuses a view's tools/call to a tool that is not visible to "app": only the card's read of its own task is,
    // and the model never sees that one
    for (const t of (await c.listTools()).tools) assert.deepEqual(t._meta?.ui?.visibility, t.name === 'drill_result' ? ['app'] : ['model'], t.name);
    const [content] = (await c.readResource({ uri: RESULT_VIEW_URI })).contents;
    assert.deepEqual(content._meta?.ui?.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, 'no origin of any kind');
  }
  // the view's own code: no App method that reaches the model or other server methods, no network API
  const REACHES_OUT = /\b(readServerResource|listServerResources|createSamplingMessage|sendMessage|updateModelContext|openLink|downloadFile|sendLog|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/;
  const dir = new URL('../../src/apps/result-view/src/', import.meta.url).pathname;
  const sources = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f)), new URL('../../src/apps/result-view-model.js', import.meta.url).pathname];
  const toolCalls = [];
  const reads = [];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const hit = text.match(REACHES_OUT);
    assert.equal(hit, null, `${file} calls ${hit?.[1]}`);
    for (const m of text.matchAll(/callServerTool\s*\(([^)]*)\)/g)) toolCalls.push(m[1]);
    for (const m of text.matchAll(/\breadResult\s*\(((?:[^()]|\([^()]*\))*)\)/g)) reads.push(m[1].replace(/\s+/g, ' ').trim());
  }
  // exactly one tools/call site: drill_result…
  assert.equal(toolCalls.length, 1, `server tool calls: ${toolCalls.join(' | ')}`);
  assert.deepEqual(toolCalls[0].replace(/\s+/g, ' ').trim(), "{ name: 'drill_result', arguments: args }");
  // …reached for the card's OWN task only: its stored table's next view when a drill-down steps
  // down (a pivot row, a chart mark — each read built by the view model)
  assert.deepEqual(reads.filter((r) => r !== 'args').sort(), [
    '{ ...d.source, transform: view.transform, limit: DRILL_ROWS }',
    '{ ...model.source, transform: pivotTransform(model.display, at), limit: PIVOT_LEVEL_ROWS }',
  ]);
});

test('a task that is gone reaches the model as result_gone over MCP, and a card of it would say "no longer available"', async () => {
  for (const era of ['legacy', 'modern']) {
    const r = await (await s.client({ era })).callTool({ name: 'query_semantic_model', arguments: { task_id: 'ffffffffffff' } });
    assert.equal(r.isError, true, era);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.error.code, 'result_gone', era);
    assert.deepEqual(buildViewModel('display_model_result', payload), { kind: 'none', reason: 'gone' }, era);
  }
});

test('structured output only for a card that is DRAWN — display_model_result\'s answer, experiment with card: true — and the same view model decides', () => {
  const rows = { ok: true, columns: [{ name: 'c' }, { name: 'v' }], rows: [{ c: 'US', v: 3 }, { c: 'DE', v: 1 }] };
  const display = { kind: 'bar', x: 'c', y: ['v'] };
  const drawn = { ...rows, display, drawn_from: { tool: 'query_semantic_model' }, drawn: true };
  assert.ok(toCallToolResult(drawn, 'display_model_result').structuredContent);
  // the same rows from any other tool — a query, a read — are text alone
  for (const name of ['query_semantic_model', 'query_pipeline_model', 'build_pipeline_model', 'experiment']) assert.equal(toCallToolResult({ ...rows, display }, name).structuredContent, undefined, name);
  // experiment: its own card when the call asks for it, and only then
  const plan = { metric: 'proportion', n_per_group: 3841, total_n: 7682, baseline: 0.1, mde: 0.02 };
  assert.ok(toCallToolResult(plan, 'experiment', { action: 'plan', card: true }).structuredContent);
  assert.equal(toCallToolResult(plan, 'experiment', { action: 'plan' }).structuredContent, undefined);
  // display_model_result that drew nothing: refused, failed, empty
  for (const nothing of [{ ...drawn, drawn: false }, { ok: false, error: { message: 'x' }, display }, { ...drawn, rows: [] }]) {
    const r = toCallToolResult(nothing, 'display_model_result');
    assert.equal(r.structuredContent, undefined, JSON.stringify(nothing));
    assert.deepEqual(JSON.parse(r.content[0].text), nothing, 'the model still reads the whole answer');
  }
});

test('the view resource is one mcp-app HTML document, listed and readable for a client that declares MCP Apps', async () => {
  const c = await s.client({ era: 'modern', capabilities: APPS_CAPS });
  assert.ok((await c.listResources()).resources.some((r) => r.uri === RESULT_VIEW_URI && r.mimeType === 'text/html;profile=mcp-app'));
  const [content] = (await c.readResource({ uri: RESULT_VIEW_URI })).contents;
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert.ok(content.text.startsWith('<!DOCTYPE html>') && /<\/html>\s*$/.test(content.text), 'a complete document');
});

test('an experiment is its own process: card: true draws its card, equal to the text; without it, text alone — and no task, nothing for display_model_result', async () => {
  const args = { action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 };
  const c = await s.client({ era: 'modern', capabilities: APPS_CAPS });
  const asked = await c.callTool({ name: 'experiment', arguments: { ...args, card: true } });
  assert.deepEqual(asked.structuredContent, JSON.parse(asked.content[0].text));
  assert.equal(asked.structuredContent.n_per_group, 3841, 'the card carries the plan\'s own numbers');
  assert.equal(buildViewModel('experiment', asked.structuredContent, args).kind, 'plan');
  const plain = await c.callTool({ name: 'experiment', arguments: args });
  assert.equal(plain.structuredContent, undefined, 'no card asked for: no structured output');
  const answer = JSON.parse(plain.content[0].text);
  assert.equal(answer.n_per_group, 3841, 'the same answer, as text');
  assert.equal(answer.task_id, undefined, 'statistics are no task');
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
  assert.equal(m.row_count, 4);
});

test('view model: a category and an amount is a bar per category', () => {
  const m = buildViewModel('build_pipeline_model', { status: 'ready', columns: [{ name: 'country' }, { name: 'users' }], rows: [{ country: 'US', users: 100 }, { country: 'DE', users: 37 }], page: { limit: 2, offset: 0, has_more: true } }, null);
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
  const m = buildViewModel('build_pipeline_model', { status: 'ready', table: 'pipe_tutorial', columns: [{ name: 'step' }, { name: 'users' }], rows });
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
  assert.equal(buildViewModel('build_pipeline_model', { columns: [{ name: 'step' }, { name: 'users' }], rows: [{ step: 'a', users: 5 }, { step: 'b', users: 9 }] }).kind, 'chart');
});

test('view model: a DECLARED funnel draws the declared steps with their labels, whatever the columns are called', () => {
  const row = { installs: 1000, first_level: 640, day2: 380, spend: 12.5 };
  const m = buildViewModel('build_pipeline_model', { columns: Object.keys(row).map((name) => ({ name })), rows: [row], display: { kind: 'funnel', title: 'Onboarding', steps: [{ column: 'installs', label: 'Install' }, { column: 'first_level', label: 'Level 1' }, { column: 'day2' }] } });
  assert.equal(m.kind, 'funnel');
  assert.equal(m.title, 'Onboarding');
  assert.deepEqual(m.steps.map((x) => [x.label, x.value]), [['Install', 1000], ['Level 1', 640], ['day2', 380]]);
  assert.equal(m.overall, 0.38);
});

test('view model: a DECLARED line over a non-time axis keeps the row order; series_column splits one value into lines', () => {
  const rows = [{ level: 'L3', country: 'US', users: 90 }, { level: 'L1', country: 'US', users: 200 }, { level: 'L3', country: 'GB', users: 30 }, { level: 'L1', country: 'GB', users: 80 }];
  const m = buildViewModel('build_pipeline_model', { columns: [{ name: 'level' }, { name: 'country' }, { name: 'users' }], rows, display: { kind: 'line', x: 'level', y: ['users'], series_column: 'country' } });
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
  const m = buildViewModel('build_pipeline_model', { columns: cols, rows, display: { kind: 'bar', x: 'c', y: ['v'], series_column: 'p', stacked: true, horizontal: true } });
  assert.equal(m.chart.type, 'bar');
  assert.deepEqual(m.chart.labels, ['US', 'BR'], 'categories in the order they first appear');
  // the largest series first (android 490 > ios 465); a category × series seen twice is summed
  assert.deepEqual(m.chart.series.map(({ name, values }) => ({ name, values })), [{ name: 'android', values: [310, 180] }, { name: 'ios', values: [420, 45] }]);
  assert.equal(m.chart.stacked, true);
  assert.equal(m.chart.horizontal, true);
  // several y columns: a bar each per category, grouped
  const g = buildViewModel('build_pipeline_model', { columns: [{ name: 'c' }, { name: 'a' }, { name: 'b' }], rows: [{ c: 'x', a: 1, b: 2 }, { c: 'y', a: 3, b: 4 }], display: { kind: 'bar', x: 'c', y: ['a', 'b'] } });
  assert.deepEqual(g.chart.series, [{ name: 'a', values: [1, 3] }, { name: 'b', values: [2, 4] }]);
  assert.equal(g.chart.stacked, false);
});

test('view model: a DECLARED area stacks its series; a single line stays a line', () => {
  const rows = [{ d: '2026-09-01', p: 'ios', n: 5 }, { d: '2026-09-01', p: 'web', n: 1 }, { d: '2026-09-02', p: 'ios', n: 6 }, { d: '2026-09-02', p: 'web', n: 2 }];
  const m = buildViewModel('build_pipeline_model', { columns: [{ name: 'd' }, { name: 'p' }, { name: 'n' }], rows, display: { kind: 'area', x: 'd', y: ['n'], series_column: 'p' } });
  assert.equal(m.chart.area, true);
  assert.equal(m.chart.stacked, true);
  assert.deepEqual(m.chart.series.map((x) => [x.name, x.points.map((p) => p[1])]), [['ios', [5, 6]], ['web', [1, 2]]]);
  const l = buildViewModel('build_pipeline_model', { columns: [{ name: 'd' }, { name: 'p' }, { name: 'n' }], rows, display: { kind: 'line', x: 'd', y: ['n'], series_column: 'p' } });
  assert.equal(l.chart.area, undefined);
});

test('view model: a DECLARED pie is slices in size order with their shares; past six the smallest fold into Other', () => {
  const vals = [['US', 730], ['GB', 270], ['BR', 220], ['DE', 160], ['FR', 95], ['JP', 60], ['KR', 40], ['IN', 25]];
  const m = buildViewModel('build_pipeline_model', { columns: [{ name: 'c' }, { name: 'v' }], rows: vals.map(([c, v]) => ({ c, v })).reverse(), display: { kind: 'pie', label_column: 'c', value_column: 'v' } });
  assert.equal(m.chart.type, 'pie');
  assert.equal(m.chart.total, 1600);
  assert.deepEqual(m.chart.slices.map((x) => [x.label, x.value]), [['US', 730], ['GB', 270], ['BR', 220], ['DE', 160], ['FR', 95], ['Other', 125]]);
  assert.equal(m.chart.folded, 3);
  assert.ok(Math.abs(m.chart.slices.reduce((a, x) => a + x.share, 0) - 1) < 1e-12, 'the slices make up the whole');
});

test('view model: KPI tiles read one row, with the change against a previous column', () => {
  const row = { revenue: 184230.5, revenue_prev: 171020, crash_rate: 0.0041, crash_rate_prev: 0.0052 };
  const m = buildViewModel('build_pipeline_model', { columns: Object.keys(row).map((name) => ({ name })), rows: [row], display: { kind: 'kpi', values: [{ column: 'revenue', label: 'Revenue', format: 'currency', previous_column: 'revenue_prev', good: 'up' }, { column: 'crash_rate', format: 'percent', previous_column: 'crash_rate_prev', good: 'down' }] } });
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
  const m = buildViewModel('build_pipeline_model', { columns: [{ name: 'a' }, { name: 'b' }, { name: 'v' }], rows, display: { kind: 'sankey', source_column: 'a', target_column: 'b', value_column: 'v' } });
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
  assert.equal(s.engine._displayProblems({ kind: 'pivot', levels: [{ column: 'a' }, { column: 'a', label: 'again' }], values: [{ column: 'v' }] }, ['a', 'b', 'v']).length, 1, 'a level twice');
});

test('pivot: one level is the rows under a path, grouped by the next level; its rows keep the key as it came', () => {
  const display = { kind: 'pivot', levels: [{ column: 'country' }, { column: 'platform' }, { column: 'channel' }], values: [{ column: 'revenue' }, { column: 'users', agg: 'max' }] };
  const t = pivotTransform(display, ['US', null]);
  assert.deepEqual(t.where, [{ column: 'country', op: 'eq', value: 'US' }, { column: 'platform', op: 'is_null' }]);
  assert.deepEqual(t.group_by, ['channel']);
  assert.deepEqual(t.aggregations, [{ fn: 'sum', column: 'revenue', as: 'revenue' }, { fn: 'max', column: 'users', as: 'users' }]);
  const rows = pivotRows({ columns: [{ name: 'platform' }, { name: 'revenue' }, { name: 'users' }], rows: [{ platform: 'ios', revenue: '12.5', users: 3 }, { platform: null, revenue: 4, users: null }] }, display, 1);
  assert.deepEqual(rows, [{ key: 'ios', label: 'ios', values: [12.5, 3] }, { key: null, label: '∅', values: [4, null] }]);
});

test('view model: what a chart leaves out is said in numbers — categories past the cap, series by size or by column order, amounts not drawn', () => {
  // a declared bar over 120 categories: 30 drawn, 120 counted
  const many = Array.from({ length: 120 }, (_, i) => ({ c: `c${i}`, v: i }));
  const bar = buildViewModel('build_pipeline_model', { columns: [{ name: 'c' }, { name: 'v' }], rows: many, display: { kind: 'bar', x: 'c', y: ['v'] } });
  assert.deepEqual([bar.chart.labels.length, bar.chart.categories_total], [30, 120]);
  assert.deepEqual(bar.chart.bars.at(-1), { label: 'c29', value: 29 });
  // split by a column: a series' total counts every row, also those past the drawn categories
  const split = Array.from({ length: 70 }, (_, i) => ({ c: `c${i}`, p: i < 60 ? 'ios' : 'web', v: i < 60 ? 1 : 100 }));
  const byP = buildViewModel('build_pipeline_model', { columns: [{ name: 'c' }, { name: 'p' }, { name: 'v' }], rows: split, display: { kind: 'bar', x: 'c', y: ['v'], series_column: 'p' } });
  assert.equal(byP.chart.series[0].name, 'web', 'web (10 rows × 100) outweighs ios (60 × 1), though its rows come last');
  assert.equal(byP.chart.categories_total, 70);
  // eight value columns over time: the first six in column order, and the card is told so
  const wide = ['2026-09-01', '2026-09-02'].map((d, k) => Object.fromEntries([['day', d], ...Array.from({ length: 8 }, (_, i) => [`m${i}`, (i + 1) * 10 + k])]));
  const line = buildViewModel('query_semantic_model', { columns: Object.keys(wide[0]).map((name) => ({ name })), rows: wide });
  assert.deepEqual([line.chart.series.length, line.chart.kept, line.chart.folded, line.chart.folded_by], [6, 6, 2, 'order']);
  assert.deepEqual(line.chart.series.map((x) => x.name), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  // nine segments over time: the largest six, by size
  const seg = Array.from({ length: 9 }, (_, i) => [{ day: '2026-09-01', country: `k${i}`, dau: i }, { day: '2026-09-02', country: `k${i}`, dau: i }]).flat();
  const bySeg = buildViewModel('query_semantic_model', { columns: [{ name: 'day' }, { name: 'country' }, { name: 'dau' }], rows: seg });
  assert.deepEqual([bySeg.chart.folded, bySeg.chart.folded_by, bySeg.chart.series[0].name], [3, 'size', 'k8']);
  // an inferred breakdown draws its first amount and names the others
  const brk = buildViewModel('build_pipeline_model', { columns: [{ name: 'platform' }, { name: 'users' }, { name: 'revenue' }, { name: 'arpu' }], rows: [{ platform: 'ios', users: 10, revenue: 50, arpu: 5 }, { platform: 'web', users: 4, revenue: 8, arpu: 2 }] });
  assert.deepEqual([brk.chart.y, brk.chart.omitted], ['users', ['revenue', 'arpu']]);
});

test('drill: a view is the stored rows under the path, grouped by what it draws; a pie stays a pie, a line can split over time', () => {
  const levels = [{ column: 'platform', label: 'Platform' }, { column: 'channel' }];
  const bar = { kind: 'bar', x: 'country', y: ['revenue', 'users'], drill: { levels, agg: 'max' } };
  // the chart as declared: folded over the drill levels
  assert.deepEqual(drillView(bar).transform.group_by, ['country']);
  assert.deepEqual(drillView(bar).transform.aggregations, [{ fn: 'max', column: 'revenue', as: 'revenue' }, { fn: 'max', column: 'users', as: 'users' }]);
  // a bar of US opened by Platform: filtered to US, one bar per platform, Channel left to step into
  const step = drillView(bar, [{ column: 'country', value: 'US' }], { level: { column: 'platform' }, mode: 'breakdown' });
  assert.deepEqual(step.transform.where, [{ column: 'country', op: 'eq', value: 'US' }]);
  assert.deepEqual(step.transform.group_by, ['platform']);
  assert.deepEqual([step.display.kind, step.display.x, step.display.y], ['bar', 'platform', ['revenue', 'users']]);
  assert.deepEqual(step.display.drill.levels, [{ column: 'channel' }]);
  // a slice opens into slices
  const pie = drillView({ kind: 'pie', label_column: 'country', value_column: 'revenue', drill: { levels } }, [{ column: 'country', value: null }], { level: { column: 'channel' }, mode: 'breakdown' });
  assert.deepEqual([pie.display.kind, pie.display.label_column, pie.transform.where[0].op], ['pie', 'channel', 'is_null']);
  // a line: that moment broken down into bars, or the line split over time
  const line = { kind: 'line', x: 'day', y: ['dau'], series_column: 'country', drill: { levels } };
  assert.deepEqual(drillView(line).transform.group_by, ['day', 'country']);
  const trend = drillView(line, [{ column: 'country', value: 'US' }], { level: { column: 'platform' }, mode: 'trend' });
  assert.deepEqual([trend.display.kind, trend.display.x, trend.display.series_column], ['line', 'day', 'platform']);
  assert.deepEqual(trend.transform.group_by, ['day', 'platform']);
  const moment = drillView(line, [{ column: 'country', value: 'US' }, { column: 'day', value: '2026-09-01' }], { level: { column: 'platform' }, mode: 'breakdown' });
  assert.equal(moment.display.kind, 'bar');
});

test('view model: a drillable chart carries each mark\'s own value to filter by, and where to read the next view', () => {
  const display = { kind: 'bar', x: 'country', y: ['v'], series_column: 'p', drill: { levels: [{ column: 'channel' }] } };
  const m = buildViewModel('build_pipeline_model', { columns: [{ name: 'country' }, { name: 'p' }, { name: 'v' }], rows: [{ country: null, p: 'ios', v: 3 }, { country: 'US', p: 7, v: 5 }], display, drill_source: { task_id: 'aabbccddeeff' } });
  assert.deepEqual(m.chart.labels, ['∅', 'US']);
  assert.deepEqual(m.chart.drill.keys, [null, 'US'], 'the empty category filters by null, not by its label');
  assert.deepEqual(m.chart.series.map((x) => x.key).sort(), [7, 'ios'], 'a numeric split value stays a number');
  assert.deepEqual(m.chart.drill.source, { task_id: 'aabbccddeeff' });
  // without a source to read from there is nothing to drill
  assert.equal(buildViewModel('build_pipeline_model', { columns: [{ name: 'country' }, { name: 'v' }], rows: [{ country: 'US', v: 1 }], display: { kind: 'bar', x: 'country', y: ['v'], drill: { levels: [{ column: 'p' }] } } }).chart.drill, undefined);
});

test('view model: a declaration the rows cannot fill falls back to the inferred card', () => {
  // step counts with a NULL first step cannot be a funnel; the step-per-row shape is still a bar chart
  const m = buildViewModel('build_pipeline_model', { columns: [{ name: 'step' }, { name: 'users' }], rows: [{ step: 'a', users: null }, { step: 'b', users: 4 }], display: { kind: 'funnel', steps: { label_column: 'step', value_column: 'users' } } });
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
    ['display_model_result', { status: 'running', task_id: 'aabbccddeeff' }, 'running'],
    ['display_model_result', { ok: false, status: 'error', error: { stage: 'fetch', message: 'boom\nsecond line' } }, 'error'],
    ['query_semantic_model', { ok: true, sql: 'select 1' }, 'sql'],
    ['query_semantic_model', { columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], rows: [{ a: 'x', b: 'y', c: 'z' }] }, 'no_chart_shape'],
  ]) {
    const m = buildViewModel(tool, result);
    assert.equal(m.kind, 'none', JSON.stringify(result).slice(0, 80));
    assert.equal(m.reason, reason);
  }
});
