// MCP APPS — a tool result rendered as an interactive view in the host's conversation.
//
// Two halves. The protocol half (lifecycle): the tools whose results have a view carry
// `_meta.ui.resourceUri` for a host that declared the extension and NOT for one that did not (the
// spec asks servers to check); the resource is `text/html;profile=mcp-app` and is a complete
// document; `structuredContent` — which the host gives the view and keeps out of the model's
// context — is sent only to a host that renders it. The data half: the view model
// (src/apps/result-view-model.js, the function the page runs) turns a result into the numbers the
// chart draws, and those are the numbers in the result.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, UI_CAPS } from '../helpers/mcp-http.js';
import { buildViewModel } from '../../src/apps/result-view-model.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const VIEWED = ['query_semantic_model', 'get_query_result', 'experiment'];

test('the viewed tools carry the view only for a host that declared the extension (both eras)', async () => {
  const withUi = (await s.modern('tools/list', {}, { caps: UI_CAPS })).body.result.tools;
  const without = (await s.modern('tools/list')).body.result.tools;
  for (const t of withUi) assert.equal(t._meta?.ui?.resourceUri, VIEWED.includes(t.name) ? 'ui://betti/result-view' : undefined, t.name);
  assert.ok(without.every((t) => !t._meta?.ui), 'no view for a host that cannot render it');

  const legacyUi = await s.legacyClient(UI_CAPS);
  const legacyPlain = await s.legacyClient();
  try {
    assert.equal((await legacyUi.listTools()).tools.find((t) => t.name === 'experiment')._meta?.ui?.resourceUri, 'ui://betti/result-view');
    assert.equal((await legacyPlain.listTools()).tools.find((t) => t.name === 'experiment')._meta?.ui, undefined);
  } finally { await legacyUi.close(); await legacyPlain.close(); }
});

test('the view resource is an mcp-app HTML document', async () => {
  const [c] = (await s.modern('resources/read', { uri: 'ui://betti/result-view' })).body.result.contents;
  assert.equal(c.mimeType, 'text/html;profile=mcp-app');
  assert.ok(c.text.startsWith('<!DOCTYPE html>') && c.text.trimEnd().endsWith('</html>'));
  assert.ok((await s.modern('resources/list')).body.result.resources.some((r) => r.uri === 'ui://betti/result-view'));
});

test('structuredContent goes to a host that renders it, and equals the text the model reads', async () => {
  const args = { action: 'plan', metric: 'proportion', baseline: 0.1, mde: 0.02 };
  const ui = (await s.modern('tools/call', { name: 'experiment', arguments: args }, { caps: UI_CAPS })).body.result;
  const plain = (await s.modern('tools/call', { name: 'experiment', arguments: args })).body.result;
  assert.deepEqual(ui.structuredContent, JSON.parse(ui.content[0].text));
  assert.equal(ui.structuredContent.n_per_group, 3841);
  assert.equal(plain.structuredContent, undefined);
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
