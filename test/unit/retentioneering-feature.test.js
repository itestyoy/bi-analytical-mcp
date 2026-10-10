// THE RETENTIONEERING FEATURE AS A SWITCH (src/features.js): off, the server's surface is exactly
// what it is without it — no tool, no view, no guide, no skill, no line of instructions; on, all of
// it, each piece held to the budgets every tool meets and to the library's facts sheet. The data
// path is test/integration/retentioneering.test.js (the analyses) and retentioneering-steps.test.js (an
// eventstream's steps, a start's spec). These are surface and input-validation checks.

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
  await assert.rejects(Promise.resolve().then(() => e.semantic_index({ guide: 'retentioneering' })), /`guide` must be one of/, 'its guide is no name the schema offers');
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
    const taken = [...new Set(fs.flatMap((x) => Object.keys(x.properties)))].filter((k) => !['kind', 'name'].includes(k));
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
  const segs = forms(b0, field(b0, start, 'segments').items);
  const seg = segs.find((x) => x.title === 'users');
  assert.ok(field(b0, seg, 'attribute').enum.includes('platform'));
  // a segment of a related model is offered for a model another source reaches — never the source itself
  // (its columns are { column }) — and `via` only where several relationships lead to the model
  for (const src of e.catalog.facts) assert.ok(!segs.some((x) => x.title === src), `no join of ${src} onto itself`);
  assert.equal(seg.properties.via, undefined, 'one relationship leads to users: no via');
  // a start from a task's table: its path named by its own columns, its event and time in columns, no window
  const fromTask = forms(b0, b0).find((x) => x.title === 'start from a task\'s table');
  assert.deepEqual([...fromTask.required].sort(), ['columns', 'from_task', 'name', 'path']);
  assert.deepEqual(Object.keys(field(b0, fromTask, 'columns').properties).sort(), ['event', 'time']);
  assert.ok(!('time_range' in fromTask.properties));
  assert.deepEqual(forms(b0, field(b0, fromTask, 'path').items).map((x) => Object.keys(x.properties)), [['column']]);
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
  const step = (st) => ({ action: 'add_steps', context_id: 'abc', steps: [st] });
  await refused('build_retentioneering_model', step({ type: 'filter_events', sql: 'select * from eventstream' }), /invalid input/);
  await refused('build_retentioneering_model', step({ type: 'add_start_end_events' }), /invalid input/);
  await refused('build_retentioneering_model', step({ type: 'filter_paths', condition: { op: '>', metric: 'has_event_bulk', value: 1 } }), /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'step_matrix', anchor: { pattern: 'a' }, path_pattern: 'a->b' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', preprocess: [{ type: 'collapse_events', loops: true }], analyses: [{ kind: 'describe' }] }, /invalid input/); // steps belong to the eventstream
  // each action takes its own fields: a step with a start, a start's field with a step
  await refused('build_retentioneering_model', { name: 'x', source: 'events', step: { type: 'collapse_events', loops: true } }, /invalid input/);
  await refused('build_retentioneering_model', { action: 'add_steps', context_id: 'abc', source: 'events', steps: [{ type: 'collapse_events', loops: true }] }, /invalid input/);
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
  // filter_events' where is the one condition grammar: a list of conditions, the operators every where takes
  const where = (w) => step({ type: 'filter_events', where: w });
  await refused('build_retentioneering_model', where({ op: 'and', conditions: [{ column: 'platform', op: '=', value: 'ios' }] }), /invalid input/);
  await refused('build_retentioneering_model', where([{ column: 'platform', op: '==', value: 'ios' }]), /invalid input/);
  await refused('build_retentioneering_model', where([{ not: { column: 'platform', op: 'eq', value: 'ios' } }]), /invalid input/);
  await refused('build_retentioneering_model', where([{ column: 'platform', op: 'eq', value: 'ios' }, { or: [{ column: 'level', op: 'between', value: [1, 3] }, { and: [{ column: 'event', op: 'starts_with', value: 'level' }, { column: 'level', op: 'is_null' }] }] }]), pastSchema);
  // a path is a path column of the eventstream, named as it is there: the schema takes the name, the
  // eventstream decides (below); an analysis's own name is `name`
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'describe', id: 'shape' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'describe', name: 'shape' }, { kind: 'transition_graph', path: 'session_id' }] }, pastSchema);
  // a start from a task's table names its path in path ([{ column }]) and takes no window
  const fromTask = { name: 'x', from_task: 'a0a0a0a0a0a0', path: [{ column: 'u' }], columns: { event: 'e', time: 't' } };
  await refused('build_retentioneering_model', fromTask, /unknown task_id/);
  const { path: _path, ...noPath } = fromTask;
  await refused('build_retentioneering_model', { ...noPath, columns: { path: 'u', event: 'e', time: 't' } }, /invalid input/);
  await refused('build_retentioneering_model', noPath, /invalid input/);
  await refused('build_retentioneering_model', { ...fromTask, path: [{ property: 'level_id_of_event_data' }] }, /invalid input/);
  await refused('build_retentioneering_model', { ...fromTask, time_range: { start: '2026-01-01' } }, /invalid input/);
  await refused('build_pipeline_model', { name: 'x', from_task: 'a0a0a0a0a0a0', time_range: { start: '2026-01-01' } }, /invalid input/);
  // the eventstream's own name goes into its models' file names: bounded as the core's names are
  await refused('build_retentioneering_model', { name: `e${'x'.repeat(41)}`, source: 'events' }, /invalid input/);
  await refused('build_retentioneering_model', { action: 'fork', context_id: 'abc', name: `e${'x'.repeat(41)}` }, /invalid input/);
  // …while an eventstream a context already holds is addressed by the name it has: an earlier version
  // took longer ones, and a kept context still holds them
  const longer = `e${'x'.repeat(41)}`;
  await refused('build_retentioneering_model', { action: 'preview', context_id: 'abc', eventstream: longer }, pastSchema);
  await refused('build_retentioneering_model', { action: 'fork', context_id: 'abc', eventstream: longer, name: 'variant' }, pastSchema);
  await refused('query_retentioneering_model', { context_id: 'abc', eventstream: longer, analyses: [{ kind: 'describe' }] }, pastSchema);
  await refused('build_retentioneering_model', { action: 'preview', context_id: 'A-B' }, /invalid input/);
  // a split case's conditions are its `when`, as a compute case's
  await refused('build_retentioneering_model', { name: 'x', source: 'events', events: { split: [{ event: 'level_completed', cases: [{ name: 'lost', where: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }] }] } }, /invalid input/);
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', analysis: 'funnel', title: 'Onboarding funnel, Sep 1–23' }, /unknown task_id/);
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
  assert.equal(resultOrigin(state, 'q_new').gone, undefined);
  for (const t of ['q_old', 'q_str', 'q_none']) assert.match(resultOrigin(state, t).gone, /stored by an earlier version .* run the same query again/);
});

// A path-analysis context is seen in context() for what it holds — its eventstreams, their steps and
// how far they are materialized — in the listing as in describe; the core asks the feature, by name of
// nothing (src/features.js describeContext). Context lifecycle; no warehouse.
test('context() lists and describes a path-analysis context by its eventstreams and their steps', async () => {
  const e = on();
  const { contextFor } = await import('../../src/retentioneering/contexts.js');
  const ctx = contextFor(e, {});
  ctx.state.retentioneering.description = 'onboarding paths';
  ctx.state.retentioneering.eventstreams.es = {
    model: 'm', source: 'events', spec: {}, columns: [], segments: [], steps: [{ step: { type: 'add_start_end_events' }, library: 'add_start_end_events', checked: true, shape: null }], checkpoint: null,
    base: { model: 'm', task_id: null, summary: { events: ['a'], users: 3 }, shape: null }, summary: null,
  };
  // a description is kept with its eventstream (a context stored before kept one for the context: shown as it was)
  ctx.state.retentioneering.eventstreams.es2 = { ...ctx.state.retentioneering.eventstreams.es, description: 'level paths', steps: [] };
  const listed = (await e.context({ action: 'list' })).contexts.find((c) => c.context_id === ctx.id);
  assert.equal(listed.description, 'onboarding paths');
  assert.deepEqual(listed.eventstreams, [{ name: 'es', source: 'events', steps: 1, materialized_through: 0 }, { name: 'es2', description: 'level paths', source: 'events', steps: 0, materialized_through: 0 }]);
  const d = await e.context({ action: 'describe', context_id: ctx.id });
  assert.equal(d.engine, 'retentioneering');
  assert.deepEqual(d.eventstreams.map((x) => [x.name, x.source, x.steps.map((s) => s.library), x.base.users, x.description]), [['es', 'events', ['add_start_end_events'], 3, undefined], ['es2', 'events', [], 3, 'level paths']]);
  assert.equal(d.brief, undefined, 'the listing line is not repeated in describe');
  e.close();
});

// What the model reads of a distribution and of a long result: the numbers in the metric's own units,
// the curve and every path's label left to the card. Pure functions over a result; no warehouse.
test('a log-binned distribution is read in the metric\'s own units, without its density curve; long lists are cut', async () => {
  const { summarize } = await import('../../src/retentioneering/results.js');
  const curve = [Array.from({ length: 1000 }, (_, i) => i / 100), Array.from({ length: 1000 }, () => 0.1)];
  const s = summarize({ kind: 'metric_distribution', values: { distribution_1: { bins: [0, 1, 2], counts: [3, 4], counts_normalized: [0.43, 0.57], kde: curve, mean: 1, median: 2 }, distance: 0.5, log_scale: true } });
  assert.deepEqual(s.values.distribution_1, { bins: [1, 10, 100], counts: [3, 4], counts_normalized: [0.43, 0.57], median: 100, geometric_mean: 10 });
  assert.equal(s.values.scale, 'log10');
  assert.equal(s.values.distance_log10, 0.5);
  assert.ok(s.scale_note);
  // not log-binned: as the library gave it, the curve still left out
  const plain = summarize({ kind: 'metric_distribution', values: { distribution_1: { bins: [0, 5, 10], counts: [1, 2], kde: curve, mean: 4, median: 3 }, log_scale: false } });
  assert.deepEqual(plain.values.distribution_1, { bins: [0, 5, 10], counts: [1, 2], mean: 4, median: 3 });
  // any other long list among the values: its first items and how many there were
  const g = summarize({ kind: 'describe', values: { labels: Array.from({ length: 1684 }, (_, i) => i % 3) } });
  assert.equal(g.values.labels.total, 1684);
  assert.equal(g.values.labels.first.length, 20);
});

test('a read of several path-analysis tasks says how long it waited for them', async () => {
  const e = on();
  const { contextFor } = await import('../../src/retentioneering/contexts.js');
  const { QUERY } = await import('../../src/retentioneering/names.js');
  const ctx = contextFor(e, {});
  const id = e.tasks.start(ctx, QUERY, () => new Promise((resolve) => { setTimeout(() => resolve({ ok: true, kind: 'analyses', analyses: {} }), 400); }));
  const r = await e.query_retentioneering_model({ task_ids: [id], wait_seconds: 0 });
  assert.equal(r.results[0].status, 'running');
  assert.equal(r.results[0].waited_seconds, 0, 'asked not to wait');
  const id2 = e.tasks.start(ctx, QUERY, () => new Promise((resolve) => { setTimeout(() => resolve({ ok: false, error: { message: 'x' } }), 5000); }));
  // a wait is a number of seconds, as every read's is
  const r2 = await e.query_retentioneering_model({ task_ids: [id2], wait_seconds: 1.5 });
  assert.ok(r2.waited_seconds >= 1.4 && r2.results[0].waited_seconds >= 1.4, JSON.stringify(r2));
  e.close();
});

// A segment joined from a related model is compared in the type the warehouse stores it in, as a
// pipeline's joined column is: the start grounds every model its joins bring in, not the source alone.
// The stub is what the warehouse says of each relation (every column text); a refusal, no run.
test('a segment joined from a related model is compared in the type the warehouse stores it in', async () => {
  const e = on();
  const asText = (k) => {
    const names = [...e.catalog.modelColumns(k).map((c) => c.name), ...(e.catalog.getModel(k).event_data_column ? [e.catalog.getModel(k).event_data_column] : [])].map((c) => c.toLowerCase());
    return Object.assign(new Set(names), { types: new Map(names.map((c) => [c, 'VARCHAR'])) });
  };
  e.probe.physicalColumns = async (k) => asText(k);
  // users.country kept as text, filtered as a flag: a boolean is compared with text by its spellings
  // alone, so one mixed with another constant is refused at the start, naming the segment as the call does
  const start = { name: 'x', source: 'events', segments: [{ model: 'users', attribute: 'country', name: 'flag' }], where: [{ column: 'flag', op: 'in', value: [true, 'x'] }] };
  await assert.rejects(e.build_retentioneering_model(start), (err) => err.stage === 'validate' && /'flag' is a text column in the warehouse/.test(err.message));
  e.close();
});

// What add_steps answers: every added step under `added`, with what it changed and, when it was not
// checked, why; the top-level step / changed are an edit's or an insert's. The library's check is a stub.
test('add_steps lists each added step with what it changed and why one was not checked', async () => {
  const { commitSteps } = await import('../../src/retentioneering/steps.js');
  const shape = (events) => ({ events, paths: ['user_id'], segments: {}, columns: [] });
  const commit = (reply, action, input, steps = []) => {
    const feature = { checker: { check: async () => ({ steps: reply }) } };
    const es = { base: { shape: shape(['a', 'shop_opened', 'tutorial']), model: 'm', summary: {} }, steps, checkpoint: null };
    return commitSteps({ ctxs: { touch() {} } }, feature, { id: 'c1', state: {} }, 'es', es, action, input);
  };
  const two = [{ type: 'rename_events', mapping: { shop_opened: 'shop' } }, { type: 'drop_events', names: ['tutorial'] }];
  const a = await commit([{ ok: true, shape: shape(['a', 'shop', 'tutorial']) }, { ok: true, shape: shape(['a', 'shop']) }], 'add_steps', { steps: two });
  assert.deepEqual(a.added, [
    { index: 1, type: 'rename_events', checked: true, changed: { events_added: ['shop'], events_removed: ['shop_opened'] } },
    { index: 2, type: 'drop_events', checked: true, changed: { events_removed: ['tutorial'] } },
  ]);
  assert.deepEqual([a.step, a.changed, a.shape.events], [undefined, undefined, ['a', 'shop']]);
  // the first step the stand-ins could not carry: its own reason, and the next one's
  const b = await commit([{ ok: null, note: 'the stand-ins could not carry it' }], 'add_steps', { steps: two });
  assert.deepEqual(b.added.map((s) => [s.index, s.checked, typeof s.note]), [[1, false, 'string'], [2, false, 'string']]);
  assert.equal(b.added[0].note, 'the stand-ins could not carry it');
  assert.deepEqual(b.unchecked_steps, [1, 2]);
  // an edit names the step it put in place and what that step changed
  const c = await commit([{ ok: true, shape: shape(['a', 'shop_opened']) }], 'edit_step', { index: 1, step: two[1] }, [{ step: two[0], library: {}, checked: true, shape: shape(['a', 'shop', 'tutorial']) }]);
  assert.deepEqual([c.step, c.changed, c.added], [{ index: 1, type: 'drop_events', checked: true }, { events_removed: ['tutorial'] }, undefined]);
});

// What a path names and what a filter_events condition holds are checked against the eventstream as
// the step is added — before the library's check, before anything runs. Input guards; no warehouse.
test('a path is one of the eventstream\'s path columns, and a condition\'s constant is what its operator takes', async () => {
  const { validateAnalyses } = await import('../../src/retentioneering/query.js');
  const { commitSteps } = await import('../../src/retentioneering/steps.js');
  const shape = { events: ['a', 'b'], paths: ['user_id', 'session_id'], segments: { level: { levels: ['1', '2'], complete: true } }, columns: [] };
  const es = { name: 'es', segments: ['level'], sessions: true, spec: {}, steps: [] };
  // the path columns, as the eventstream's shape lists them: no word stands for one
  assert.deepEqual(validateAnalyses(es, shape, [{ kind: 'transition_graph', path: 'session_id' }]).map((a) => a.path_col), ['session_id']);
  for (const path of ['users', 'sessions', 'visit']) {
    assert.throws(() => validateAnalyses(es, shape, [{ kind: 'transition_graph', path }]), (e) => e.field === 'analyses.path' && /user_id, session_id/.test(e.message), path);
  }
  // an eventstream started without sessions has one path column, and the refusal says where sessions come from
  const plain = { name: 'plain', segments: [], sessions: false, spec: {}, steps: [] };
  for (const path of ['session_id', 'users']) {
    assert.throws(() => validateAnalyses(plain, { events: ['a', 'b'], paths: ['user_id'], segments: {}, columns: [] }, [{ kind: 'transition_graph', path }]), (e) => e.field === 'analyses.path' && /its path columns: user_id/.test(e.message) && /started with sessions/.test(e.message), path);
  }
  // two analyses of one name are refused, the name said as the caller gives it
  assert.throws(() => validateAnalyses(es, shape, [{ kind: 'describe', name: 'x' }, { kind: 'transition_graph', name: 'x' }]), (e) => e.field === 'analyses.name');
  const add = (where) => commitSteps({ ctxs: { touch() {} } }, { checker: { check: async () => null } }, { id: 'c1', state: {} }, 'es', { base: { shape, model: 'm', summary: {} }, steps: [], checkpoint: null }, 'add_steps', { steps: [{ type: 'filter_events', where }] });
  for (const [where, re] of [
    [[{ column: 'level', op: 'in', value: 3 }], /in takes a list/],
    [[{ column: 'level', op: 'eq', value: [3] }], /one constant/],
    [[{ column: 'level', op: 'between', value: [1] }], /\[low, high\]/],
    [[{ column: 'level', op: 'in', value: [1, '2'] }], /one kind/],
    [[{ column: 'level', op: 'contains', value: 1 }], /a string/],
    [[{ column: 'level', op: 'eq', value: null }], /is_null/],
    [[{ column: 'level', op: 'is_null', value: 1 }], /takes no value/],
    [[{ column: 'level', op: 'gt' }], /needs a value/],
  ]) await assert.rejects(add(where), (e) => e.field === 'steps[0].where' && re.test(e.message), JSON.stringify(where));
  // …and one that is, is taken (the check could not run here: nothing refused, nothing ran)
  const ok = await add([{ column: 'level', op: 'gte', value: 2 }, { or: [{ column: 'event', op: 'not_in', value: ['a'] }, { column: 'level', op: 'is_null' }] }]);
  assert.equal(ok.steps, 1);
});

// A start's where and a split case's `when` hold a constant to the same rule as filter_events' where
// (one rule, src/retentioneering/schema.js checkConstant), each refusal at its own field. Input guards;
// no warehouse.
test('a start\'s where and a split case take a constant by the rule filter_events\' where takes it', async () => {
  const e = on();
  const start = (extra) => e.build_retentioneering_model({ name: 'x', source: 'events', ...extra });
  for (const [cond, re] of [
    [{ column: 'bundle_id', op: 'in', value: 'a' }, /in takes a list/],
    [{ column: 'bundle_id', op: 'eq', value: ['a'] }, /one constant/],
    [{ column: 'bundle_id', op: 'between', value: ['a'] }, /\[low, high\]/],
    [{ column: 'bundle_id', op: 'eq', value: null }, /is_null/],
    [{ column: 'bundle_id', op: 'is_null', value: 'a' }, /takes no value/],
    [{ column: 'bundle_id', op: 'gt' }, /needs a value/],
    [{ column: 'bundle_id', op: 'starts_with', value: 1 }, /a string/],
  ]) {
    await assert.rejects(start({ where: [cond] }), (err) => err.field === 'where.value' && re.test(err.message), `where ${JSON.stringify(cond)}`);
    await assert.rejects(start({ events: { split: [{ event: 'level_completed', cases: [{ name: 'lost', when: [cond] }] }] } }), (err) => err.field === 'events.split.0.cases.when' && re.test(err.message), `when ${JSON.stringify(cond)}`);
  }
  e.close();
});

// A step kept by an eventstream an earlier version stored — filter_events' where as its own tree — is
// re-checked, and kept from then on, in today's spelling: what a call can write. Context lifecycle; the
// rows it keeps are proved in test/integration/retentioneering.test.js.
test('a filter_events step stored in the earlier tree is carried over: re-checked and kept as the condition list', async () => {
  const e = on();
  const { commitSteps, preview } = await import('../../src/retentioneering/steps.js');
  const shape = { events: ['a', 'b'], paths: ['user_id'], segments: { level: { levels: ['1', '2'], complete: true } }, columns: [] };
  const tree = { op: 'or', conditions: [{ column: 'level', op: '>', value: 5 }, { not: { op: 'and', conditions: [{ column: 'level', op: '>=', value: 2 }, { column: 'event', op: 'in', value: ['a'] }] } }] };
  const es = { base: { shape, model: 'm', summary: {} }, steps: [{ step: { type: 'drop_events', names: ['b'] } }, { step: { type: 'filter_events', where: tree } }], checkpoint: null };
  const feature = { checker: { check: async (req) => ({ steps: req.steps.map(() => ({ ok: true, shape })) }) } };
  const ctx = { id: 'c1', state: {} };
  // deleting the step before it re-checks it — in today's spelling, which the schema takes as a call's step
  await commitSteps({ ctxs: { touch() {} } }, feature, ctx, 'es', es, 'delete_step', { index: 1 });
  const kept = es.steps[0].step;
  assert.ok(Array.isArray(kept.where), 'kept as a condition list');
  e.host.validate('build_retentioneering_model', { action: 'edit_step', context_id: 'abcdef012345', index: 1, step: kept });
  assert.deepEqual(preview(ctx, 'es', es).steps.map((x) => x.step), [kept]);
  // a step not yet re-checked is shown in today's spelling too
  const stored = { base: { shape, model: 'm', summary: {} }, steps: [{ step: { type: 'filter_events', where: tree }, library: {}, checked: true, shape }], checkpoint: null };
  e.host.validate('build_retentioneering_model', { action: 'edit_step', context_id: 'abcdef012345', index: 1, step: preview(ctx, 'es', stored).steps[0].step });
  e.close();
});

test('a step stored with an earlier path word is carried over: re-checked and shown with the path column it meant', async () => {
  const e = on();
  const { commitSteps, preview } = await import('../../src/retentioneering/steps.js');
  const shape = { events: ['a', 'b'], paths: ['user_id', 'session_id'], segments: {}, columns: [] };
  const es = { base: { shape, model: 'm', summary: {} }, steps: [{ step: { type: 'drop_events', names: ['b'] } }, { step: { type: 'collapse_events', loops: true, path: 'sessions' } }], checkpoint: null };
  const feature = { checker: { check: async (req) => ({ steps: req.steps.map(() => ({ ok: true, shape })) }) } };
  const ctx = { id: 'c1', state: {} };
  // deleting the step before it re-checks it — kept with the column the word named
  await commitSteps({ ctxs: { touch() {} } }, feature, ctx, 'es', es, 'delete_step', { index: 1 });
  assert.deepEqual(es.steps[0].step, { type: 'collapse_events', loops: true, path: 'session_id' });
  e.host.validate('build_retentioneering_model', { action: 'edit_step', context_id: 'abcdef012345', index: 1, step: es.steps[0].step });
  assert.deepEqual(preview(ctx, 'es', es).steps.map((x) => x.step), [es.steps[0].step]);
  // a step not yet re-checked is shown with the column too
  const stored = { base: { shape, model: 'm', summary: {} }, steps: [{ step: { type: 'collapse_events', loops: true, path: 'users' }, library: { loops: true, path_col: 'user_id' }, checked: true, shape }], checkpoint: null };
  assert.equal(preview(ctx, 'es', stored).steps[0].step.path, 'user_id');
  e.close();
});

// A start from a task's table an earlier version stored names its path in columns.path: it is read as
// today's path: [{ column }] — the key a summary says, whatever the steps materialized after it. Pure
// translation; the rows of such an eventstream are proved in test/integration/retentioneering.test.js.
test('a start stored with columns.path is read as path: [{ column }]', async () => {
  const { currentSpec } = await import('../../src/retentioneering/earlier.js');
  const { pathKey } = await import('../../src/retentioneering/query.js');
  const { summarizeEventstream } = await import('../../src/retentioneering/steps.js');
  const stored = { name: 'from_pipe', from_task: 'a0a0a0a0a0a0', columns: { path: 'player_id_of_internal', event: 'ev', time: 'device_time' }, segments: [{ column: 'bundle_id', name: 'app' }] };
  const now = currentSpec(stored);
  assert.deepEqual(now.path, [{ column: 'player_id_of_internal' }]);
  assert.deepEqual(now.columns, { event: 'ev', time: 'device_time' });
  assert.deepEqual(pathKey(stored), ['player_id_of_internal']);
  // the summary a materialize answers with says the path as the stored spec meant it (the warehouse's
  // answers are stubs: one event, two paths)
  const runner = { show: async () => ({ ok: true, rows: [{ events: 3, users: 2, names: 1, event: 'a' }] }) };
  const summary = await summarizeEventstream(runner, '/nowhere', 'm', { segments: [], paths: ['user_id'], spec: stored, dialect: 'duckdb' });
  assert.deepEqual([summary.path, summary.users], [['player_id_of_internal'], 2]);
});
