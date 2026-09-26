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
import { retentioneeringFacts, ANALYSIS_KINDS, OFFERED_OPS, NOT_OFFERED } from '../../src/retentioneering/schema.js';
import { RETENTIONEERING_VIEW_URI } from '../../src/retentioneering/view-model.js';
import { buildToolDefs, createServices, runTool, coreInstructions } from '../../src/mcp-surface.js';
import { RUNTIME_ASSETS } from '../../src/runtime-assets.js';
import { settle } from '../helpers/settle.js';
import { dbtEnv } from '../helpers/dbt-env.js';

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
  const r = await runTool(e, 'build_retentioneering_model', { name: 'x', source: 'events' });
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
  assert.deepEqual(Object.keys(g.analyses).sort(), [...ANALYSIS_KINDS].sort());
  assert.deepEqual(Object.keys(g.preprocess), OFFERED_OPS);
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
  // resolve the folded refs, so the checks read the schema as a validator does
  const q = e.schemas.query_retentioneering_model;
  const deref = (n) => (n?.$ref ? deref(n.$ref.replace(/^#\//, '').split('/').reduce((x, k) => x[k], q)) : n);
  assert.deepEqual(e.schemas.display_retentioneering_result.properties.edge_weight.enum, f.edge_weights);
  // every analysis the library offers, each with the library's parameters under its names (path_col as path)
  const branches = deref(q.properties.analyses.items).oneOf.map(deref);
  assert.deepEqual(branches.map((b) => b.title), Object.keys(f.analyses));
  for (const b of branches) {
    const lib = f.analyses[b.title].params.map((p) => (p.name === 'path_col' ? 'path' : p.name)).filter((n) => !NOT_OFFERED.params[n]);
    assert.deepEqual(Object.keys(b.properties).filter((k) => !['kind', 'id', 'preprocess'].includes(k)).sort(), lib.sort(), b.title);
    assert.deepEqual(b.required.filter((k) => k !== 'kind').sort(), f.analyses[b.title].params.filter((p) => p.required).map((p) => p.name).sort(), `${b.title}: required as the library requires`);
  }
  const cluster = branches.find((b) => b.title === 'cluster_analysis');
  assert.deepEqual(deref(cluster.properties.method).enum, f.cluster_methods);
  assert.deepEqual(deref(cluster.properties.scaler).enum, f.cluster_scalers);
  assert.equal(branches.find((b) => b.title === 'step_matrix').properties.max_steps.default, f.analyses.step_matrix.params.find((p) => p.name === 'max_steps').default);
  // a metric config: one branch per metric of the library, each with exactly its own arguments
  const metric = deref(deref(cluster.properties.features).items);
  assert.deepEqual(metric.oneOf.map(deref).map((m) => m.properties.metric.const), f.path_metrics);
  for (const m of metric.oneOf.map(deref)) assert.deepEqual(Object.keys(deref(m.properties.metric_args)?.properties || {}).sort(), Object.keys(f.metric_args[m.properties.metric.const]).sort(), m.title);
  // every op the library registers, but the ones not offered for their stated reason
  const ops = deref(deref(q.properties.preprocess).items).oneOf.map(deref);
  assert.deepEqual(ops.map((o) => o.title), Object.keys(f.ops).filter((op) => !NOT_OFFERED.ops[op]));
  for (const o of ops) for (const p of Object.keys(NOT_OFFERED.params)) assert.ok(!(p in o.properties), `${o.title} offers no ${p}`);
  // the build: the source's events and the models' attributes are enums from the catalog
  const b = e.schemas.build_retentioneering_model;
  assert.ok(deref(deref(b.properties.events).properties.include).items.enum?.includes('level_started'));
  const seg = deref(deref(b.properties.segments).items).oneOf.map(deref).find((x) => x.title === 'users');
  assert.ok(deref(seg.properties.attribute).enum.includes('platform'));
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
  await refused('query_retentioneering_model', { context_id: 'abc', preprocess: [{ type: 'filter_events', sql: 'select * from eventstream' }], analyses: [{ kind: 'describe' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', preprocess: [{ type: 'add_start_end_events' }], analyses: [{ kind: 'describe' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', preprocess: [{ type: 'filter_paths', condition: { op: '>', metric: 'has_event_bulk', value: 1 } }], analyses: [{ kind: 'describe' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'step_matrix', anchor: { pattern: 'a' }, path_pattern: 'a->b' }] }, /invalid input/);
  await refused('display_retentioneering_result', { task_id: 'nope', analysis: 'funnel' }, /unknown task_id/);
  // a card for a client that renders none is refused like display_model_result
  const r = await runTool(e, 'display_retentioneering_result', { task_id: 'x', analysis: 'funnel' }, { renders: false });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /MCP Apps/);
});

test('the view draws and nothing else — no server call, no network — and its build is held to its sources', async () => {
  const REACHES_OUT = /\b(callServerTool|readServerResource|listServerResources|createSamplingMessage|sendMessage|updateModelContext|openLink|downloadFile|sendLog|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/;
  const dir = new URL('../../src/apps/retentioneering-view/src/', import.meta.url).pathname;
  const sources = [
    ...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f)),
    new URL('../../src/retentioneering/view-model.js', import.meta.url).pathname,
    new URL('../../src/apps/shared/ui.js', import.meta.url).pathname,
  ];
  for (const file of sources) assert.equal(readFileSync(file, 'utf8').match(REACHES_OUT), null, file);
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'rete-view-build-'));
  await build({ configFile: new URL('../../src/apps/retentioneering-view/vite.config.js', import.meta.url).pathname, build: { outDir: out, emptyOutDir: true }, logLevel: 'silent' });
  assert.ok(existsSync(RUNTIME_ASSETS.retentioneeringView.path));
  assert.equal(readFileSync(join(out, 'retentioneering-view.html'), 'utf8'), readFileSync(RUNTIME_ASSETS.retentioneeringView.path, 'utf8'), 'rebuild the view: npm run build:app');
});
