// THE RETENTIONEERING FEATURE AS A SWITCH (src/features.js): off, the server's surface is exactly
// what it is without it — no tool, no view, no guide, no skill, no line of instructions; on, all of
// it, each piece held to the budgets every tool meets and to the library's facts sheet. The data
// path is test/integration/retentioneering.test.js. These are surface and input-validation checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { resolveFeatures, flagOn } from '../../src/features.js';
import { createRetentioneeringFeature, retentioneeringDefinition } from '../../src/retentioneering/index.js';
import { retentioneeringFacts, analysisKinds, offeredOps, NOT_OFFERED } from '../../src/retentioneering/schema.js';
import { RETENTIONEERING_VIEW_URI, retentioneeringViewModel, hasCard, CARD_KINDS, DIFF_CARD_KINDS, CHARTED_DIFF_KINDS } from '../../src/retentioneering/view-model.js';
import { buildToolDefs, createServices, runTool, coreInstructions } from '../../src/mcp-surface.js';
import { RUNTIME_ASSETS } from '../../src/runtime-assets.js';
import { CONFIG_ERRORS } from '../../src/retentioneering/checker.js';
import { settle } from '../helpers/settle.js';
import { dbtEnv } from '../helpers/dbt-env.js';
import { deref, field, fieldNames, forms, pinned } from '../helpers/schema-nav.js';

/** Every script of the views' shared layer (src/apps/shared/), which both views bundle. */
function sharedSources() {
  const dir = new URL('../../src/apps/shared/', import.meta.url).pathname;
  return readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f));
}


const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const TOOLS = ['build_retentioneering_model', 'query_retentioneering_model', 'display_retentioneering_result'];
// a dbt client that is never asked to run anything here — the surface needs only that it exists
const RUNNER = { pythonModelsOn: () => true };

const engine = (features = []) => settle(new Engine({
  catalog: loadCatalog(CATALOG, {}),
  contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'rete-u-')) }),
  dbPath: join(mkdtempSync(join(tmpdir(), 'rete-u-db-')), 'x.sqlite'),
  features, featureStatus: features.map((f) => ({ id: f.id, available: true })),
}));
const on = () => engine([createRetentioneeringFeature({ runner: RUNNER })]);

test('off by default: only an explicit yes turns the feature on', () => {
  for (const v of [undefined, '', 'off', '0', 'false', 'maybe']) assert.equal(flagOn(v), false, String(v));
  for (const v of ['on', '1', 'true', 'YES']) assert.equal(flagOn(v), true, v);
  assert.deepEqual(resolveFeatures({ env: {}, catalog: loadCatalog(CATALOG, {}) }), { features: [], status: [] });
});

test('asked for where it cannot run, it is left out with its reason — never half-offered', () => {
  const r = resolveFeatures({ env: { MCP_RETENTIONEERING: 'on' }, catalog: loadCatalog(CATALOG, {}) });
  assert.equal(r.features.length, 0);
  assert.equal(r.status[0].available, false);
  assert.match(r.status[0].reason, /dbt project/);
  const noEnv = retentioneeringDefinition.resolve({ env: { MCP_RETENTIONEERING_ENV: 'no-such-env' }, catalog: loadCatalog(CATALOG, {}), baseProjectDir: '/tmp' });
  assert.match(noEnv.reason, /environment/);
});

test('off: no tool, no view, no guide, no skill, no instruction line, nothing in the overview', async () => {
  const e = engine();
  const defs = buildToolDefs(e);
  for (const t of TOOLS) assert.ok(!defs.some((d) => d.name === t), `${t} is not listed`);
  const s = createServices(e);
  assert.ok(!s.resources({ skills: true }).some((r) => r.uri === RETENTIONEERING_VIEW_URI));
  assert.equal(s.read(RETENTIONEERING_VIEW_URI), null);
  assert.ok(!s.skills.list().some((k) => k.frontmatter.name === 'retentioneering'));
  assert.ok(!s.instructionsFor({ apps: true, skills: true }).includes('build_retentioneering_model'));
  const g = await e.semantic_index({ guide: 'retentioneering' });
  assert.equal(g.recipes?.length ?? 0, 0, 'an unknown family, not the guide');
  const ov = await e.semantic_index({});
  assert.equal(ov.features, undefined);
  const r = await runTool(e, 'build_retentioneering_model', { request: { name: 'x', source: 'events' } });
  assert.equal(r.unknown, true, 'not callable');
  s.close();
});

test('on: three tools within the budgets, the drawing one pointing at its own view', async () => {
  const e = on();
  const defs = buildToolDefs(e);
  for (const t of TOOLS) {
    const d = defs.find((x) => x.name === t);
    assert.ok(d, `${t} is listed`);
    assert.ok(d.description.length <= 2048 && d.title && d.annotations.openWorldHint === false, t);
    assert.equal(typeof d.annotations.readOnlyHint, 'boolean');
  }
  assert.equal(defs.find((d) => d.name === 'display_retentioneering_result')._meta.ui.resourceUri, RETENTIONEERING_VIEW_URI);
  assert.equal(defs.find((d) => d.name === 'build_retentioneering_model')._meta.ui.resourceUri, undefined, 'only the drawing tool carries a view');
  const s = createServices(e);
  assert.ok(s.resources({}).some((r) => r.uri === RETENTIONEERING_VIEW_URI));
  const [page] = s.read(RETENTIONEERING_VIEW_URI);
  assert.equal(page.uri, RETENTIONEERING_VIEW_URI);
  assert.deepEqual(page._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
  // the guide, its routing trigger, the skill, one line of the core instructions
  const g = await e.semantic_index({ guide: 'retentioneering' });
  assert.deepEqual(Object.keys(g.analyses).sort(), [...analysisKinds()].sort());
  assert.deepEqual(Object.keys(g.steps), offeredOps());
  const all = await e.semantic_index({ guide: true });
  assert.ok(all.routing_triggers.some((t) => t.do.includes('build_retentioneering_model')));
  assert.ok(s.skills.list().some((k) => k.frontmatter.name === 'retentioneering'));
  const core = coreInstructions({ apps: true, skillUris: ['skill://a/SKILL.md'], featureLines: e.features.map((f) => f.instructions) });
  assert.ok(core.length <= 2048 && core.includes('build_retentioneering_model'), `${core.length} characters`);
  assert.ok(s.instructionsFor({}).includes('build_retentioneering_model'));
  const ov = await e.semantic_index({});
  assert.equal(ov.features.retentioneering.available, true);
  s.close();
});

test('the schemas offer exactly what the library does — every choice from the facts sheet', () => {
  const e = on();
  const f = retentioneeringFacts();
  // the forms of a union and a field of a form, read through the fold (test/helpers/schema-nav.js)
  const q = e.schemas.query_retentioneering_model;
  const d = e.schemas.display_retentioneering_result;
  assert.deepEqual(field(d, d, 'edge_weight').enum, f.edge_weights);
  /** A union's forms grouped by what they pin `key` to, in order: one entry per analysis (or op). */
  const byTag = (doc, union, key) => {
    const groups = new Map();
    for (const form of forms(doc, union)) for (const v of pinned(doc, form, key)) (groups.get(v) || groups.set(v, []).get(v)).push(form);
    return groups;
  };
  const common = (lists) => lists.reduce((acc, l) => acc.filter((x) => l.includes(x)));
  // every analysis the library offers, each with the library's parameters under its names (path_col as
  // path): its forms together take them, and what every form requires is what the library requires
  const analyses = byTag(q, field(q, q, 'analyses').items, 'kind');
  assert.deepEqual([...analyses.keys()], Object.keys(f.analyses));
  for (const [kind, fs] of analyses) {
    const lib = f.analyses[kind].params.map((p) => (p.name === 'path_col' ? 'path' : p.name)).filter((n) => !NOT_OFFERED.params[n]);
    const taken = [...new Set(fs.flatMap((x) => Object.keys(x.properties)))].filter((k) => !['kind', 'id'].includes(k));
    assert.deepEqual(taken.sort(), lib.sort(), kind);
    assert.deepEqual(common(fs.map((x) => x.required)).filter((k) => k !== 'kind').sort(), f.analyses[kind].params.filter((p) => p.required).map((p) => p.name).sort(), `${kind}: required as the library requires`);
    assert.ok(fs.every((x) => !('preprocess' in x.properties)), `${kind} takes no steps of its own`);
  }
  // a clustering: a form per method of the library, each with that method's own arguments
  const cluster = analyses.get('cluster_analysis');
  assert.deepEqual(cluster.flatMap((x) => pinned(q, x, 'method')).sort(), [...f.cluster_methods].sort());
  for (const x of cluster) assert.deepEqual(Object.keys(field(q, x, 'method_args').properties).sort(), [...f.cluster_method_args[pinned(q, x, 'method')[0]]].sort());
  assert.deepEqual(field(q, cluster[0], 'scaler').enum, f.cluster_scalers);
  assert.equal(field(q, analyses.get('step_matrix')[0], 'max_steps').default, f.analyses.step_matrix.params.find((p) => p.name === 'max_steps').default);
  // a metric config: one form per metric of the library, each with exactly its own arguments
  const metrics = byTag(q, field(q, cluster[0], 'features').items, 'metric');
  assert.deepEqual([...metrics.keys()], f.path_metrics);
  for (const [m, [form]] of metrics) assert.deepEqual(Object.keys(field(q, form, 'metric_args')?.properties || {}).sort(), Object.keys(f.metric_args[m]).sort(), m);
  // every op the library registers — an eventstream's steps — but the ones not offered for their stated reason
  const b0 = e.schemas.build_retentioneering_model;
  const ops = byTag(b0, field(b0, b0, 'step'), 'type');
  assert.deepEqual([...byTag(b0, field(b0, b0, 'steps').items, 'type').keys()], [...ops.keys()], 'add_steps offers the same steps');
  assert.ok(!fieldNames(q, q).includes('preprocess'), 'a query reads the eventstream as materialized: it takes no steps of its own');
  assert.deepEqual([...ops.keys()], Object.keys(f.ops).filter((op) => !NOT_OFFERED.ops[op]));
  for (const [op, fs] of ops) for (const x of fs) for (const p of Object.keys(NOT_OFFERED.params)) assert.ok(!(p in x.properties), `${op} offers no ${p}`);
  // metric_bins: the metrics that give one value per path, and the fewest equal quantiles, as the library has them
  const bins = field(b0, ops.get('add_segment')[0], 'metric_bins');
  assert.deepEqual([...byTag(b0, field(b0, bins, 'metric'), 'metric').keys()], f.metric_bins.metrics);
  assert.equal(forms(b0, field(b0, bins, 'bins')).find((x) => x.title === 'equal quantiles').minItems, f.metric_bins.min_quantile_bins);
  // the build: the source's events and the models' attributes are enums from the catalog
  const start = forms(b0, b0).find((x) => x.title === 'start from an events source');
  assert.ok(deref(b0, field(b0, field(b0, start, 'events'), 'include').items).enum?.includes('level_started'), 'an events source: its events, as an enum');
  const seg = forms(b0, field(b0, start, 'segments').items).find((x) => x.title === 'users');
  assert.ok(field(b0, seg, 'attribute').enum.includes('platform'));
});

test('the facts sheet is what the installed library says (where the feature\'s environment is built)', (t) => {
  const env = dbtEnv('retentioneering');
  if (!env) { t.skip('dbt environment retentioneering not installed'); return; }
  const script = fileURLToPath(new URL('../../scripts/retentioneering-facts.py', import.meta.url));
  // the environment's own interpreter (its pythonBin is MetricFlow's, which runs the AST gate)
  execFileSync(join(env.dir, 'bin', 'python'), [script, '--check'], { stdio: 'pipe' }); // exit 1 if the sheet is stale
});

test('input the schema refuses is refused before anything starts', async () => {
  const e = on();
  const refused = async (tool, input, re) => { await assert.rejects(Promise.resolve().then(() => e[tool](input)), re); };
  await refused('build_retentioneering_model', { name: 'x', source: 'nope' }, /invalid input/);
  await refused('build_retentioneering_model', { name: 'Bad Name', source: 'events' }, /invalid input/);
  await refused('build_retentioneering_model', { name: 'x', source: 'events', sample: { share: 0 } }, /invalid input/);
  // a typo in an event or an attribute is refused by the schema itself, which lists what exists
  await refused('build_retentioneering_model', { name: 'x', source: 'events', events: { include: ['levl_started'] } }, /invalid input.*level_started/);
  await refused('build_retentioneering_model', { name: 'x', source: 'events', segments: [{ model: 'users', attribute: 'no_such' }] }, /invalid input.*platform/);
  await refused('build_retentioneering_model', { name: 'x', source: 'events', where: [{ column: 'country', op: 'eq', value: 'US' }] }, (err) => err.field === 'where.column');
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'cluster_analysis' }] }, /invalid input/); // features: required by the library
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'path_metrics', metrics: [{ metric: 'has_event', metric_args: { events: ['a'] } }] }] }, /invalid input/);
  // a step is one of the library's own ops, checked by the schema first
  const step = (st) => ({ action: 'add_step', context_id: 'abc', step: st });
  await refused('build_retentioneering_model', step({ type: 'filter_events', sql: 'select * from eventstream' }), /invalid input/);
  await refused('build_retentioneering_model', step({ type: 'add_start_end_events' }), /invalid input/);
  await refused('build_retentioneering_model', step({ type: 'filter_paths', condition: { op: '>', metric: 'has_event_bulk', value: 1 } }), /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'step_matrix', anchor: { pattern: 'a' }, path_pattern: 'a->b' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', preprocess: [{ type: 'collapse_events', loops: true }], analyses: [{ kind: 'describe' }] }, /invalid input/); // steps belong to the eventstream
  // each action takes its own fields: a step with a start, a start's field with a step
  await refused('build_retentioneering_model', { name: 'x', source: 'events', step: { type: 'collapse_events', loops: true } }, /invalid input/);
  await refused('build_retentioneering_model', { action: 'add_step', context_id: 'abc', source: 'events', step: { type: 'collapse_events', loops: true } }, /invalid input/);
  await refused('build_retentioneering_model', { action: 'edit_step', context_id: 'abc', step: { type: 'collapse_events', loops: true } }, /invalid input/); // which step
  await refused('build_retentioneering_model', { action: 'truncate', context_id: 'abc' }, /invalid input/);
  await refused('build_retentioneering_model', { action: 'fork', context_id: 'abc' }, /invalid input/);
  // a condition compares a metric with a constant of the metric's own kind: a date is not a time metric's value
  await refused('build_retentioneering_model', step({ type: 'filter_paths', condition: { op: '<', metric: 'first_event_time', value: '2026-09-26' } }), /invalid input/);
  // metric_bins is one list of bins, so a level count that disagrees with the cut points cannot be written
  const segment = (metric_bins) => step({ type: 'add_segment', name: 'by_length', metric_bins });
  await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, edges: [3, 6, 10], segment_levels: ['short', 'long'] }), /invalid input/);
  await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, bins: [{ level: 'short', from: 0 }, { level: 'long', from: 6 }] }), /invalid input/); // the lowest bin has no start
  await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'mid', from: 3 }, { level: 'long', from_quantile: 0.9 }] }), /invalid input/); // values or quantiles, not both
  await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, bins: [{ level: 'all' }] }), /invalid input/);
  await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: 'long', from_quantile: 1 }] }), /invalid input/);
  await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, bins: [{ level: 'short' }, { level: retentioneeringFacts().metric_bins.undefined_level, from: 3 }] }), /invalid input/);
  await refused('build_retentioneering_model', segment({ metric: { metric: 'event_count_bulk' }, bins: [{ level: 'a' }, { level: 'b' }] }), /invalid input/); // a value per event, not per path
  // 'in' takes a list, a comparison one constant
  const cond = (condition) => step({ type: 'filter_paths', condition });
  await refused('build_retentioneering_model', cond({ op: 'in', metric: 'length', value: 3 }), /invalid input/);
  await refused('build_retentioneering_model', cond({ op: '=', metric: 'length', value: [3] }), /invalid input/);
  // a clustering's method_args are the chosen method's own (kmeans is the default)
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'cluster_analysis', features: [{ metric: 'length' }], method: 'hdbscan', method_args: { n_clusters: 3 } }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'cluster_analysis', features: [{ metric: 'length' }], method_args: { min_cluster_size: 3 } }] }, /invalid input/);
  // rules are cases the tool quotes: no operator or value becomes SQL of the call's own
  const rules = (r) => step({ type: 'add_segment', name: 'store', rules: r });
  await refused('build_retentioneering_model', rules([['platform', "= 'a' OR 1=1 OR platform =", "'q'", 'hit'], ['other']]), /invalid input/);
  await refused('build_retentioneering_model', rules({ cases: [{ column: 'platform', op: "= 'a' OR 1=1 --", value: 'x', level: 'hit' }], else: 'other' }), /invalid input/);
  await refused('build_retentioneering_model', rules({ cases: [{ column: 'platform', op: 'in', value: "('a') OR 1=1", level: 'hit' }], else: 'other' }), /invalid input/);
  // ...while each written form passes the schema (and stops only at the context, which does not exist)
  const pastSchema = (err) => !/invalid input/.test(err.message) && /abc/.test(err.message);
  for (const bins of [[{ level: 'short' }, { level: 'long', from: 6 }, { level: 'mid', from: 3 }], [{ level: 'low' }, { level: 'top', from_quantile: 0.9 }], [{ level: 'q1' }, { level: 'q2' }, { level: 'q3' }]]) {
    await refused('build_retentioneering_model', segment({ metric: { metric: 'length' }, bins }), pastSchema);
  }
  await refused('build_retentioneering_model', cond({ op: '<', metric: 'first_event_time', value: 1790380800 }), pastSchema);
  await refused('build_retentioneering_model', cond({ op: 'in', metric: 'length', value: [3, 4] }), pastSchema);
  await refused('build_retentioneering_model', rules({ cases: [{ column: 'platform', op: 'in', value: ['ios', "it's"], level: 'apple' }, { column: 'platform', op: '=', value: 'web', level: 'web' }], else: 'other' }), pastSchema);
  await refused('build_retentioneering_model', { action: 'add_steps', context_id: 'abc', steps: [{ type: 'collapse_events', loops: true }, { type: 'split_sessions', timeout: '30m', session_col: 'visit' }] }, pastSchema);
  for (const input of [{ action: 'edit_step', index: 1, step: { type: 'collapse_events', loops: true } }, { action: 'delete_step', index: 1 }, { action: 'truncate', after: 0 }, { action: 'fork', name: 'variant', after: 1 }, { action: 'preview' }, { action: 'materialize' }]) {
    await refused('build_retentioneering_model', { context_id: 'abc', ...input }, pastSchema);
  }
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'cluster_analysis', features: [{ metric: 'length' }], method: 'hdbscan', method_args: { min_cluster_size: 3 } }] }, pastSchema);
  await refused('display_retentioneering_result', { task_id: 'nope', analysis: 'funnel' }, /invalid input/); // not a task id at all
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', analysis: 'funnel' }, /unknown task_id/);
  // a card for a client that renders none is refused like display_model_result
  const r = await runTool(e, 'display_retentioneering_result', { request: { task_id: 'a0a0a0a0a0a0', analysis: 'funnel' } }, { renders: false });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /MCP Apps/);
});

test('the view draws and nothing else — no server call, no network — and its build is held to its sources', async () => {
  const REACHES_OUT = /\b(callServerTool|readServerResource|listServerResources|createSamplingMessage|sendMessage|updateModelContext|openLink|downloadFile|sendLog|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/;
  const dir = new URL('../../src/apps/retentioneering-view/src/', import.meta.url).pathname;
  const sources = [
    ...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f)),
    new URL('../../src/retentioneering/view-model.js', import.meta.url).pathname,
    ...sharedSources(),
  ];
  for (const file of sources) assert.equal(readFileSync(file, 'utf8').match(REACHES_OUT), null, file);
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'rete-view-build-'));
  await build({ configFile: new URL('../../src/apps/retentioneering-view/vite.config.js', import.meta.url).pathname, build: { outDir: out, emptyOutDir: true }, logLevel: 'silent' });
  assert.ok(existsSync(RUNTIME_ASSETS.retentioneeringView.path));
  assert.equal(readFileSync(join(out, 'retentioneering-view.html'), 'utf8'), readFileSync(RUNTIME_ASSETS.retentioneeringView.path, 'utf8'), 'rebuild the view: npm run build:app');
});

test('a card is decided by kind: an analysis of a card kind with nothing in it is empty, one of another kind has no card', () => {
  for (const kind of CARD_KINDS) assert.equal(hasCard(kind), true, kind);
  for (const kind of ['describe', 'conversion_rate', 'path_metrics']) assert.equal(hasCard(kind), false, kind);
  // a diff has its card in the form its kind is stored in: a funnel's in its own shape, the others' as tables
  assert.deepEqual(DIFF_CARD_KINDS.map((k) => hasCard(k, CHARTED_DIFF_KINDS.includes(k) ? 'charted' : 'tables')), DIFF_CARD_KINDS.map(() => true));
  assert.deepEqual(CHARTED_DIFF_KINDS, ['funnel']);
  assert.equal(hasCard('funnel', 'charted'), true, 'a funnel diff has its card: both groups on the same steps');
  assert.equal(hasCard('step_matrix', 'charted'), false);
  assert.equal(hasCard('cluster_analysis', 'tables'), false, 'the library draws no diff of clusters');
  // a funnel diff is drawn in its own shape: both groups on the same steps
  const funnelDiff = (extra) => retentioneeringViewModel({ ok: true, analysis: 'funnel', result: { kind: 'funnel', diff: true, ...extra } });
  const drawn = funnelDiff({ diff_charted: true, diff_groups: { segment: 'platform', first: 'ios', second: '<REST>' }, steps: [{ step: 'a', funnel1_unique_paths: 4, funnel2_unique_paths: 3, delta_unique_paths: 1, funnel1_conversion_rate: 1, funnel2_conversion_rate: 1, delta_conversion_rate: 0, funnel1_step_conversion_rate: 1, funnel2_step_conversion_rate: 1, delta_step_conversion_rate: 0 }] });
  assert.deepEqual([drawn.kind, drawn.analysis_kind, drawn.groups.second], ['funnel_diff', 'funnel', 'the other levels']);
  assert.deepEqual(retentioneeringViewModel({ ok: true, result: { kind: 'transition_graph', nodes: [], edges: [] } }), { kind: 'none', reason: 'empty' });
  assert.deepEqual(retentioneeringViewModel({ ok: true, result: { kind: 'describe', values: {} } }), { kind: 'none', reason: 'no_card' });
});

test('a request the library\'s check cannot carry is answered at once, under its own id — not at the timeout', async (t) => {
  const env = dbtEnv('retentioneering');
  if (!env) { t.skip('dbt environment retentioneering not installed'); return; }
  const { LibraryChecker } = await import('../../src/retentioneering/checker.js');
  const checker = new LibraryChecker(join(env.dir, 'bin', 'python'));
  try {
    const started = Date.now();
    // a shape with no path columns: the stand-in cannot be built
    assert.equal(await checker.check({ shape: { events: ['a'], segments: {} }, steps: [{ type: 'collapse_events', loops: true }] }), null);
    assert.ok(Date.now() - started < 30000, 'answered, not waited out');
    // and the same process answers the next request
    const ok = await checker.check({ shape: { events: ['a', 'b'], paths: ['user_id'], segments: {}, columns: [] }, steps: [{ type: 'collapse_events', loops: true }] });
    assert.equal(ok.steps[0].ok, true);
  } finally {
    checker.close();
  }
});

test('ties are ordered by code point, the same on every machine — not by the locale', async () => {
  const { summarize } = await import('../../src/retentioneering/results.js');
  const edge = (source) => ({ source, target: 'x', count: 1, unique_paths: 1, proba_out: 1, proba_in: 1, time_median: 0 });
  const s = summarize({ kind: 'transition_graph', nodes: [], edges: [edge('a'), edge('B'), edge('_c')] });
  assert.deepEqual(s.top_transitions.map((e) => e.from), ['B', '_c', 'a']);
});

test('with the feature off, loading the server never opens the library\'s sheet', async () => {
  const { execFileSync } = await import('node:child_process');
  const probe = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => { if (String(p).endsWith('retentioneering-facts.json')) { console.log('READ'); } return read(p, ...rest); };
    syncBuiltinESMExports();
    await import('./src/features.js');
    await import('./src/engine.js');
    await import('./src/mcp-surface.js');
    console.log('LOADED');
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, MCP_RETENTIONEERING: 'off' }, encoding: 'utf8' });
  assert.ok(out.includes('LOADED'), out);
  assert.ok(!out.includes('READ'), 'the sheet was read at import');
});

test('the synthetic events a card marks are the library\'s — the ones the server hands over, and without them the ones the sheet names', () => {
  const sheet = retentioneeringFacts().synthetic_events;
  const events = [...sheet, 'level_start'];
  const r = { kind: 'transition_graph', nodes: events.map((event) => ({ event, count: 1 })), edges: [{ source: sheet[0], target: 'level_start', count: 1, proba_out: 1 }] };
  const marked = (drawn) => retentioneeringViewModel({ ok: true, analysis: 'g', ...drawn, result: r }).nodes.filter((n) => n.synthetic).map((n) => n.event).sort();
  // a card drawn before the server sent the list reads the ones the view labels — the sheet's own
  assert.deepEqual(marked({}), [...sheet].sort());
  assert.deepEqual(marked({ synthetic_events: sheet }), [...sheet].sort());
  assert.deepEqual(marked({ synthetic_events: ['level_start'] }), ['level_start'], 'the list handed over decides');
});

test('the errors the library check counts as the call\'s are the library\'s own error classes', () => {
  const errors = retentioneeringFacts().errors;
  const unknown = CONFIG_ERRORS.filter((name) => !Object.hasOwn(errors, name));
  assert.deepEqual(unknown, [], 'every counted error is one the library defines (regenerate the sheet if it renamed one)');
  assert.ok(CONFIG_ERRORS.every((name) => name !== 'RetentioneeringError'), 'the base class would count every error the library raises, the rows\' own too');
});

test('a query result stored before its rows were numbered within their tables is refused, never cut across them', async () => {
  const { resultOrigin } = await import('../../src/retentioneering/query.js');
  const state = { results: { q_new: { eventstream: 'es', table: 'rete_es', analyses: ['a'], rows_per_table: true }, q_old: { eventstream: 'es', table: 'rete_es', analyses: ['a'] }, q_str: 'es' } };
  assert.equal(resultOrigin(state, 'q_new').eventstream, 'es');
  assert.deepEqual(resultOrigin(state, 'q_none'), { eventstream: null, table: null });
  for (const t of ['q_old', 'q_str']) assert.throws(() => resultOrigin(state, t), /stored by an earlier version .* run the same query again/);
});
