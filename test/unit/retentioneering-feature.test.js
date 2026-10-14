// THE RETENTIONEERING FEATURE AS A SWITCH (src/features.js): off, the server's surface is exactly
// what it is without it — no tool, no view, no guide, no skill, no line of instructions; on, all of
// it, each piece held to the budgets every tool meets and to the library's facts sheet. The data
// path is test/integration/retentioneering.test.js (the analyses) and retentioneering-steps.test.js (an
// eventstream's steps, a start's spec). These are surface and input-validation checks.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { resolveFeatures, flagOn } from '../../src/features.js';
import { createRetentioneeringFeature, retentioneeringDefinition } from '../../src/retentioneering/index.js';
import { retentioneeringFacts, analysisKinds, offeredOps, NOT_OFFERED, startPlace } from '../../src/retentioneering/schema.js';
import { checkStepPlaces } from '../../src/retentioneering/build-input.js';
import { RETENTIONEERING_VIEW_URI, retentioneeringViewModel, hasCard, CARD_KINDS, DIFF_CARD_KINDS, CHARTED_DIFF_KINDS } from '../../src/retentioneering/view-model.js';
import { buildToolDefs, createServices, runTool, coreInstructions } from '../../src/mcp-surface.js';
import { RUNTIME_ASSETS } from '../../src/runtime-assets.js';
import { CONFIG_ERRORS } from '../../src/retentioneering/checker.js';
import { settle } from '../helpers/settle.js';
import { dbtEnv } from '../helpers/dbt-env.js';
import { deref, field, fieldNames, forms, formWhere, pinned } from '../helpers/schema-nav.js';
import { tempDir } from '../helpers/temp-dir.js';

/** Every script of the views' shared layer (src/apps/shared/), which both views bundle. */
function sharedSources() {
  const dir = new URL('../../src/apps/shared/', import.meta.url).pathname;
  return readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f));
}


const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const TOOLS = ['build_retentioneering_model', 'query_retentioneering_model', 'display_retentioneering_result'];
// a dbt client that is never asked to run anything here — the surface needs only that it exists
const RUNNER = { pythonModelsOn: () => true };

// each engine holds its store's file open: closed when the file ends, before its directory goes
const engines = [];
after(() => { for (const e of engines) e.close(); });
const engine = (features = []) => {
  const e = settle(new Engine({
    catalog: loadCatalog(CATALOG, {}),
    contextManager: new ContextManager({ workspaceRoot: tempDir('rete-u') }),
    dbPath: join(tempDir('rete-u-db'), 'x.sqlite'),
    features, featureStatus: features.map((f) => ({ id: f.id, available: true })),
  }));
  engines.push(e);
  return e;
};
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
  assert.deepEqual(field(d, field(d, d, 'display'), 'edge_weight').enum, f.edge_weights);
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
  // every op the library registers — an eventstream's steps — but the ones not offered for their stated
  // reason: the runtime group of the tool's one stage definition, beside the core's SQL stages ({ stage })
  const b0 = e.schemas.build_retentioneering_model;
  const libraryOps = (node) => forms(b0, node).filter((x) => !pinned(b0, x, 'stage').length);
  const opsOf = (node) => { const groups = new Map(); for (const x of libraryOps(node)) for (const v of pinned(b0, x, 'type')) (groups.get(v) || groups.set(v, []).get(v)).push(x); return groups; };
  const ops = opsOf(field(b0, b0, 'step'));
  const addSteps = formWhere(b0, b0, 'action', 'add_steps');
  assert.deepEqual([...opsOf(field(b0, addSteps, 'steps').items).keys()], [...ops.keys()], 'add_steps offers the same steps');
  assert.ok(!fieldNames(q, q).includes('preprocess'), 'a query reads the eventstream as materialized: it takes no steps of its own');
  assert.deepEqual([...ops.keys()], Object.keys(f.ops).filter((op) => !NOT_OFFERED.ops[op]));
  for (const [op, fs] of ops) for (const x of fs) for (const p of Object.keys(NOT_OFFERED.params)) assert.ok(!(p in x.properties), `${op} offers no ${p}`);
  // metric_bins: the metrics that give one value per path, and the fewest equal quantiles, as the library has them
  const bins = field(b0, ops.get('add_segment')[0], 'metric_bins');
  assert.deepEqual([...byTag(b0, field(b0, bins, 'metric'), 'metric').keys()], f.metric_bins.metrics);
  assert.equal(forms(b0, field(b0, bins, 'bins')).find((x) => x.title === 'equal quantiles').minItems, f.metric_bins.min_quantile_bins);
  // the build: ONE stage definition ($defs.stage) — the core's, built for this tool's places (the stages a
  // start takes), and the library's ops as its runtime group — that a start's steps, add_steps' steps and
  // edit_step / insert_step's step all
  // point at; what each place takes of it is the place's (a start: the pipeline's own stages that keep
  // the rows events — a where, a compute, a join; a step after it: the library's ops), checked as each
  // step is added. Then the eventstream's roles, each named as a column of the rows the start's stages leave.
  const start = forms(b0, b0).find((x) => x.title === 'start from an events source');
  const stage = deref(b0, b0.$defs.stage);
  assert.equal(deref(b0, field(b0, start, 'steps').items), stage, 'a start\'s steps are the one stage');
  assert.equal(deref(b0, field(b0, addSteps, 'steps').items), stage, 'and so are add_steps\'');
  assert.equal(deref(b0, field(b0, b0, 'step')), stage, 'and an edit\'s step');
  assert.deepEqual(startPlace(e.catalog).stages, ['where', 'compute', 'join']);
  // the core's join forms, one per model, as build_pipeline_model offers them
  const bp = e.schemas.build_pipeline_model;
  assert.deepEqual(forms(b0, stage).filter((x) => pinned(b0, x, 'stage')[0] === 'join').map((x) => x.title), forms(bp, bp.$defs.stage).filter((x) => pinned(bp, x, 'stage')[0] === 'join').map((x) => x.title));
  assert.deepEqual(Object.keys(field(b0, start, 'columns').properties).sort(), ['event', 'time']);
  for (const k of ['path', 'segments']) assert.equal(deref(b0, field(b0, start, k).items).type, 'string', `${k}: column names`);
  assert.equal(field(b0, start, 'top').type, 'integer');
  for (const k of ['where', 'events', 'stages']) assert.ok(!fieldNames(b0, b0).includes(k), `the earlier ${k} is no field of the build`);
  for (const k of ['eventstream_stage', 'eventstream_expr']) assert.equal(b0.$defs[k], undefined, `no ${k}: one stage, one expression`);
  // what a step action answers with beyond what it changed: the one list `include`, as the pipeline
  // builder takes it, on the actions that change the steps (and fork) — not on a start (a task),
  // preview (it lists all) or materialize
  const listed = forms(b0, b0).filter((x) => 'include' in x.properties);
  assert.deepEqual(listed.flatMap((x) => pinned(b0, x, 'action')).sort(), ['add_steps', 'delete_step', 'edit_step', 'fork', 'insert_step', 'truncate']);
  for (const x of listed) assert.deepEqual(field(b0, x, 'include').items.enum, ['columns', 'steps'], x.title);
  assert.ok(!fieldNames(b0, b0).some((k) => /^include_/.test(k)), 'no flag per thing');
  assert.ok(formWhere(b0, b0, 'action', 'fork').required.includes('name'), 'a fork is a new eventstream with a name of its own');
  // filter_events' where is the one expression; its place (the eventstream's rows) is the writer's check
  assert.equal(deref(b0, field(b0, ops.get('filter_events')[0], 'where').items), deref(b0, b0.$defs.expr));
  // a start from a task's table: its path and its event and time named by its own columns, no window
  const fromTask = forms(b0, b0).find((x) => x.title === 'start from a task\'s table');
  assert.deepEqual([...fromTask.required].sort(), ['columns', 'from_task', 'name', 'path']);
  assert.deepEqual(Object.keys(field(b0, fromTask, 'columns').properties).sort(), ['event', 'time']);
  assert.deepEqual([...field(b0, fromTask, 'columns').required].sort(), ['event', 'time']);
  assert.ok(!('time_range' in fromTask.properties));
  assert.equal(deref(b0, field(b0, fromTask, 'path').items).type, 'string');
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
  // a start in an earlier spelling is refused with the start written today, at the first earlier field
  const earlier = (field, today) => (err) => err.field === field && err.message.includes(`the start is written in an earlier spelling — write ${JSON.stringify(today)}`);
  const events = { name: 'x', source: 'events' };
  await refused('build_retentioneering_model', { ...events, events: { include: ['level_started'] } }, earlier('events', { ...events, steps: [{ stage: 'where', conditions: [{ fn: 'in', args: [{ column: 'event_name' }, { value: 'level_started' }] }] }] }));
  await refused('build_retentioneering_model', { ...events, where: [{ column: 'bundle_id', op: 'eq', value: 'a' }] }, earlier('where', { ...events, steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'bundle_id' }, { value: 'a' }] }] }] }));
  // a users attribute as a segment is the join stage it was, point-in-time on the slowly-changing model
  const between = { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' };
  await refused('build_retentioneering_model', { ...events, segments: [{ model: 'users', attribute: 'platform' }] }, earlier('segments', { ...events, steps: [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'platform' }], between }], segments: ['platform'] }));
  // a start's list of stages is its steps: the earlier name is told the field's name, the stages unchanged
  await refused('build_retentioneering_model', { ...events, stages: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'bundle_id' }, { value: 'a' }] }] }] }, /request has an unexpected property 'stages' — here that field is called 'steps'/);
  // a column the start names that its rows do not have is refused with the columns there are — and how one is brought in
  await refused('build_retentioneering_model', { ...events, segments: ['country'] }, (err) => err.field === 'segments' && /'country' is not a column of 'events' — a related model's attribute is brought in by a join stage/.test(err.message));
  await refused('build_retentioneering_model', { ...events, path: ['nope'] }, (err) => err.field === 'path' && /'nope' is not a column of 'events'/.test(err.message));
  await refused('build_retentioneering_model', { ...events, columns: { event: 'ev' } }, (err) => err.field === 'columns.event' && /'ev' is not a column of 'events' — did you mean/.test(err.message));
  await refused('build_retentioneering_model', { ...events, segments: ['event_time'] }, (err) => err.field === 'segments' && /a name the eventstream uses for its own column/.test(err.message));
  // an event of a sample the source does not have is refused with the near one (the source names its events itself)
  await refused('build_retentioneering_model', { ...events, sample: { events: { levl_started: 0.5 } } }, (err) => err.field === 'sample.events' && /did you mean 'level_started'/.test(err.message));
  // a start's steps keep the rows events: a stage that changes the grain, or draws rows at random, is not
  // one — no stage of the tool's one definition (built for its places: a start's stages and the library's
  // ops), so its schema refuses it; the start's place refuses it as the step is built too, naming what a
  // start takes, for a caller past the schema
  for (const stage of [{ stage: 'aggregate', measures: [{ name: 'n', expr: { fn: 'count' } }] }, { stage: 'sample', share: 0.5 }]) {
    await refused('build_retentioneering_model', { ...events, steps: [stage] }, (err) => err.stage === 'validate' && /^invalid input: `steps\.0\.stage` must be one of: where, compute, join$/.test(err.message));
    assert.throws(() => checkStepPlaces(e.catalog, { ...events, steps: [stage] }, 'start'), (err) => err.field === 'steps[0]' && /^steps\[0\]: an eventstream's start takes where, compute, join — an? \w+ stage is not one of them/.test(err.message) && /from_task/.test(err.message));
  }
  // …and a join of a slowly-changing model states the version it reads: without it each event would repeat per version
  await refused('build_retentioneering_model', { ...events, steps: [{ stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'platform' }] }], segments: ['platform'] }, (err) => err.field === 'steps[0]' && err.message.includes(`between: { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' }`));
  // a start's steps are SQL stages, and the steps added after it the library's ops: neither place takes
  // the other's items — each refused at its place, saying where the item belongs
  await refused('build_retentioneering_model', { ...events, steps: [{ type: 'collapse_events', loops: true }] }, (err) => err.field === 'steps[0]' && /an eventstream's start takes where, compute, join — \{ type: "collapse_events" \} is one of the library's steps, added once the eventstream is built/.test(err.message));
  await refused('build_retentioneering_model', { action: 'add_steps', context_id: 'abc', steps: [{ stage: 'where', conditions: [{ fn: 'eq', args: [{ column: 'bundle_id' }, { value: 'a' }] }] }] }, (err) => err.field === 'steps[0]' && /the library's steps \(add_steps, edit_step, insert_step\) take the library's own steps — .*\{ stage: "where" \} is a SQL stage/.test(err.message));
  for (const action of ['edit_step', 'insert_step']) {
    // a SQL stage no place of the tool takes is no form of its definition: the schema refuses it; the
    // place refuses it too, for a caller past the schema
    await refused('build_retentioneering_model', { action, context_id: 'abc', index: 1, step: { stage: 'limit', limit: 3 } }, (err) => err.stage === 'validate' && /^invalid input: `step\.stage` must be one of: where, compute, join$/.test(err.message));
    assert.throws(() => checkStepPlaces(e.catalog, { action, context_id: 'abc', index: 1, step: { stage: 'limit', limit: 3 } }, action), (err) => err.field === 'step' && /the library's steps \(add_steps, edit_step, insert_step\) take the library's own steps/.test(err.message));
  }
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
  await refused('build_retentioneering_model', { action: 'fork', context_id: 'abc' }, /invalid input.*missing required property 'name'/);
  // what an answer includes goes with the actions that change the steps, never with a start, a preview or a build
  for (const input of [{ ...events, include: ['columns'] }, { action: 'preview', context_id: 'abc', include: ['steps'] }, { action: 'materialize', context_id: 'abc', include: ['columns'] }]) {
    await refused('build_retentioneering_model', input, /invalid input: .*unexpected property 'include'/);
  }
  // …and the earlier flags are refused with the one list they are now
  await refused('build_retentioneering_model', { action: 'add_steps', context_id: 'abc', steps: [{ type: 'collapse_events', loops: true }], include_columns: true, include_steps: true },
    (err) => err.message.includes(`is written in an earlier spelling — write ${JSON.stringify({ action: 'add_steps', context_id: 'abc', steps: [{ type: 'collapse_events', loops: true }], include: ['columns', 'steps'] })}`));
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
  for (const input of [{ action: 'edit_step', index: 1, step: { type: 'collapse_events', loops: true }, include: ['columns'] }, { action: 'delete_step', index: 1, include: ['steps'] }, { action: 'truncate', after: 0 }, { action: 'fork', name: 'variant', after: 1, include: ['columns', 'steps'] }, { action: 'preview' }, { action: 'materialize' }]) {
    await refused('build_retentioneering_model', { context_id: 'abc', ...input }, pastSchema);
  }
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'cluster_analysis', features: [{ metric: 'length' }], method: 'hdbscan', method_args: { min_cluster_size: 3 } }] }, pastSchema);
  // filter_events' where is the one expression grammar: a list of conditions over the eventstream's
  // columns — the functions every where takes, and / or / not nested
  const where = (w) => step({ type: 'filter_events', where: w });
  const col = (column) => ({ column });
  const val = (value) => ({ value });
  await refused('build_retentioneering_model', where([{ fn: 'eq', args: [col('platform'), val('ios')] }, { fn: 'or', args: [{ fn: 'between', args: [col('level'), val(1), val(3)] }, { fn: 'and', args: [{ fn: 'starts_with', args: [col('event'), val('level')] }, { fn: 'is_null', args: [col('level')] }] }] }, { fn: 'not', args: [{ fn: 'in', args: [col('event'), val('a'), val('b')] }] }]), pastSchema);
  // the earlier tree and list are refused with the conditions written today — a negation as not(…),
  // which keeps a missing value as the earlier one did (neq is present-and-different now)
  const earlierWhere = (today) => (err) => err.field === 'steps[0].where' && err.message.includes(`steps[0].where is written in an earlier spelling — write ${JSON.stringify(today)}`);
  await refused('build_retentioneering_model', where({ op: 'and', conditions: [{ column: 'platform', op: '=', value: 'ios' }] }), earlierWhere([{ fn: 'eq', args: [col('platform'), val('ios')] }]));
  await refused('build_retentioneering_model', where([{ column: 'platform', op: 'neq', value: 'ios' }]), earlierWhere([{ fn: 'not', args: [{ fn: 'eq', args: [col('platform'), val('ios')] }] }]));
  // the library runs it as SQL: no SQL of the call's own, no event property — a start's steps take them,
  // so they pass the tool's one expression, and this place (the eventstream's rows) refuses them, naming
  // what it takes; no ref of the catalog, which no place of the tool takes (no form of its expression:
  // the schema), no window in a condition, and no operator of another language (the schema)
  const place = /is not what filter_events' where takes — it takes \{ column \}, \{ value \}, \{ now: true \}, and every function but raw/;
  for (const [w, said] of [
    [[{ fn: 'raw', sql: '1=1' }], /raw /],
    [[{ fn: 'eq', args: [{ property: 'result_of_event_data' }, val('win')] }], /\{ property \} /],
  ]) await refused('build_retentioneering_model', where(w), (err) => err.field === 'steps[0].where' && said.test(err.message) && place.test(err.message));
  await refused('build_retentioneering_model', where([{ fn: 'eq', args: [{ source: 'users', column: 'country' }, val('US')] }]), /invalid input: `steps\.0\.where\.0\.args\.0`/);
  await refused('build_retentioneering_model', where([{ fn: 'gt', args: [{ fn: 'row_number', over: {} }, val(1)] }]), (err) => err.field === 'steps[0].where' && /cannot stand in a condition/.test(err.message));
  await refused('build_retentioneering_model', where([{ fn: '==', args: [col('platform'), val('ios')] }]), /invalid input/);
  await refused('build_retentioneering_model', where([{ fn: 'eq', args: [{ property: 'platform' }, val('ios')] }]), /invalid input/); // not an event property of the catalog
  // the current time is a leaf there, as in every read of rows
  await refused('build_retentioneering_model', where([{ fn: 'gt', args: [col('event_time'), { now: true }] }]), pastSchema);
  // a path is a path column of the eventstream, named as it is there: the schema takes the name, the
  // eventstream decides (below); an analysis's own name is `name`
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'describe', id: 'shape' }] }, /invalid input/);
  await refused('query_retentioneering_model', { context_id: 'abc', analyses: [{ kind: 'describe', name: 'shape' }, { kind: 'transition_graph', path: 'session_id' }] }, pastSchema);
  // a start from a task's table names its path (column names) and its event and time columns, and takes no window
  const fromTask = { name: 'x', from_task: 'a0a0a0a0a0a0', path: ['u'], columns: { event: 'e', time: 't' } };
  await refused('build_retentioneering_model', fromTask, /unknown task_id/);
  const { path: _path, ...noPath } = fromTask;
  await refused('build_retentioneering_model', noPath, /invalid input.*missing required property 'path'/);
  await refused('build_retentioneering_model', { ...fromTask, columns: { event: 'e' } }, /invalid input.*missing required property 'time'/);
  await refused('build_retentioneering_model', { ...fromTask, time_range: { start: '2026-01-01' } }, /invalid input/);
  // the path an earlier version named in columns, or as [{ column }], is refused with the start written today
  await refused('build_retentioneering_model', { ...noPath, columns: { path: 'u', event: 'e', time: 't' } }, earlier('columns', { name: 'x', from_task: 'a0a0a0a0a0a0', columns: { event: 'e', time: 't' }, path: ['u'] }));
  await refused('build_retentioneering_model', { ...fromTask, path: [{ column: 'u' }] }, earlier('path', { name: 'x', from_task: 'a0a0a0a0a0a0', columns: { event: 'e', time: 't' }, path: ['u'] }));
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
  // an event split by a parameter is a compute stage's case, the column it makes the event column
  await refused('build_retentioneering_model', { ...events, events: { split: [{ event: 'level_completed', cases: [{ name: 'lost', when: [{ property: 'result_of_event_data', op: 'eq', value: 'lose' }] }] }] } }, earlier('events', {
    ...events,
    steps: [{ stage: 'compute', name: 'es_event', expr: { fn: 'case', cases: [{ when: [{ fn: 'eq', args: [col('event_name'), val('level_completed')] }, { fn: 'eq', args: [{ property: 'result_of_event_data' }, val('lose')] }], then: val('lost') }], else: col('event_name'), type: 'string' } }],
    columns: { event: 'es_event' },
  }));
  // a card is { task_id, display } — what it draws under `display`, as display_model_result takes it
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', display: { analysis: 'funnel', title: 'Onboarding funnel, Sep 1–23' } }, /unknown task_id/);
  await refused('display_retentioneering_result', { task_id: 'nope', display: { analysis: 'funnel' } }, /invalid input/); // not a task id at all
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', display: { analysis: 'funnel' } }, /unknown task_id/);
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', display: { analysis: 'funnel', edge_weight: 'nope' } }, /invalid input/);
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', display: { analysis: 'funnel', kind: 'bar' } }, /invalid input/);
  // the earlier flat shape is refused with the card it is now, never drawn
  await refused('display_retentioneering_result', { task_id: 'a0a0a0a0a0a0', analysis: 'funnel', title: 'Onboarding' },
    (err) => err.field === 'display' && err.message.includes(`request is written in an earlier spelling — write ${JSON.stringify({ task_id: 'a0a0a0a0a0a0', display: { analysis: 'funnel', title: 'Onboarding' } })}`));
  // a card for a client that renders none is refused like display_model_result
  const r = await runTool(e, 'display_retentioneering_result', { request: { task_id: 'a0a0a0a0a0a0', display: { analysis: 'funnel' } } }, { renders: false });
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
  const out = tempDir('rete-view-build');
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
  const { readView } = await import('../../src/retentioneering/results.js');
  const edge = (source) => ({ source, target: 'x', count: 1, unique_paths: 1, proba_out: 1, proba_in: 1, time_median: 0 });
  const s = readView({ kind: 'transition_graph', nodes: [], edges: [edge('a'), edge('B'), edge('_c')] });
  const transitions = s.tables.find((t) => t.name === 'transitions');
  assert.deepEqual(transitions.rows.map((r) => r[0]), ['B', '_c', 'a']);
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
  assert.deepEqual(listed.eventstreams, [{ name: 'es', source: 'events', steps_count: 1, materialized_through: 0 }, { name: 'es2', description: 'level paths', source: 'events', steps_count: 0, materialized_through: 0 }]);
  const d = await e.context({ action: 'describe', context_id: ctx.id });
  assert.equal(d.engine, 'retentioneering');
  assert.deepEqual(d.eventstreams.map((x) => [x.name, x.source, x.steps.map((s) => s.library), x.base.users, x.description]), [['es', 'events', ['add_start_end_events'], 3, undefined], ['es2', 'events', [], 3, 'level paths']]);
  assert.equal(d.brief, undefined, 'the listing line is not repeated in describe');
  e.close();
});

// What the model reads of a distribution and of a long result: the numbers in the metric's own units,
// the curve left to the card, a long list paged as a table's rows are. Pure functions over a result; no
// warehouse.
test('a log-binned distribution is read in the metric\'s own units, without its density curve; a long list is paged', async () => {
  const { readView } = await import('../../src/retentioneering/results.js');
  const { READ_PAGE } = await import('../../src/schema/fields.js');
  const curve = [Array.from({ length: 1000 }, (_, i) => i / 100), Array.from({ length: 1000 }, () => 0.1)];
  const s = readView({ kind: 'metric_distribution', values: { distribution_1: { bins: [0, 1, 2], counts: [3, 4], counts_normalized: [0.43, 0.57], kde: curve, mean: 1, median: 2 }, distance: 0.5, log_scale: true } });
  assert.deepEqual(s.values.distribution_1, { bins: [1, 10, 100], counts: [3, 4], counts_normalized: [0.43, 0.57], median: 100, geometric_mean: 10 });
  assert.equal(s.values.scale, 'log10');
  assert.equal(s.values.distance_log10, 0.5);
  assert.ok(s.scale_note);
  // not log-binned: as the library gave it, the curve still left out
  const plain = readView({ kind: 'metric_distribution', values: { distribution_1: { bins: [0, 5, 10], counts: [1, 2], kde: curve, mean: 4, median: 3 }, log_scale: false } });
  assert.deepEqual(plain.values.distribution_1, { bins: [0, 5, 10], counts: [1, 2], mean: 4, median: 3 });
  // any other long list among the values: a page of it, by the same offset / limit as a table's rows
  const labels = Array.from({ length: 1684 }, (_, i) => i % 3);
  const g = readView({ kind: 'describe', values: { labels } });
  assert.deepEqual([g.values.labels.items.length, g.values.labels.page.total_rows, g.values.labels.page.next_offset], [READ_PAGE, 1684, READ_PAGE]);
  const last = readView({ kind: 'describe', values: { labels } }, { offset: 1680, limit: 10 });
  assert.deepEqual([last.values.labels.items, last.values.labels.page.has_more], [labels.slice(1680), false]);
  // a short one is as it is on the first page, and past its end holds no items, as a table's page does —
  // paging to the end reads every item once; what an item holds comes whole with it
  assert.deepEqual(readView({ kind: 'describe', values: { labels: [1, 2] } }).values.labels, [1, 2]);
  const past = readView({ kind: 'describe', values: { labels: [1, 2], pairs: Array.from({ length: 60 }, (_, i) => [i, i + 1]) } }, { offset: 50, limit: 50 }).values;
  assert.deepEqual([past.labels.items, past.labels.page.total_rows, past.labels.page.has_more], [[], 2, false]);
  assert.deepEqual([past.pairs.items.length, past.pairs.items[0]], [10, [50, 51]]);
});

// ONE READ OF A TASK IN EVERY QUERY TOOL: an analysis is read as pages of its tables, by their row
// numbers — its own tables first, in the order that answers (the biggest transitions, the events by
// their peak share, a funnel's steps in order, the metrics that tell the groups apart most), then the
// library's — each with the page block every query tool's page carries; what it computes beyond rows (a
// group's profile) is beside them, whole. Pure functions over a result; no warehouse.
test('a read pages each table of an analysis by its row numbers, the biggest first, with what it computes beside them', async () => {
  const { readView, holdsPage } = await import('../../src/retentioneering/results.js');
  const { READ_PAGE } = await import('../../src/schema/fields.js');
  // a transition graph: the transitions by count, the events by count — every weight, rounded to 4 decimals
  const edges = Array.from({ length: 60 }, (_, i) => ({ source: `e${i}`, target: 'x', count: i + 1, unique_paths: i, share_of_total: 0.123456, avg_per_path: 1.5, proba_out: 1 / 3, proba_in: 0.5, time_median: 12.345, time_q95: 61.04 }));
  const graph = { kind: 'transition_graph', nodes: [{ event: 'x', count: 60 }, { event: 'e1', count: 2 }], edges };
  const first = readView(graph);
  const transitions = first.tables.find((t) => t.name === 'transitions');
  // every weight the analysis computes (the facts sheet's edge_weights), a duration's in seconds
  const { edge_weights: weights } = retentioneeringFacts();
  assert.deepEqual(transitions.columns, ['from', 'to', ...weights.map((w) => (w.startsWith('time_') ? `${w}_s` : w))]);
  const top = Object.fromEntries(transitions.columns.map((c, i) => [c, transitions.rows[0][i]]));
  assert.deepEqual(top, { from: 'e59', to: 'x', count: 60, unique_paths: 59, share_of_total: 0.1235, avg_per_path: 1.5, proba_in: 0.5, proba_out: 0.3333, time_median_s: 12.3, time_q95_s: 61 });
  assert.deepEqual([transitions.rows.length, transitions.page.offset, transitions.page.limit, transitions.page.has_more, transitions.page.next_offset, transitions.page.total_rows], [READ_PAGE, 0, READ_PAGE, true, READ_PAGE, 60]);
  assert.deepEqual(first.tables.find((t) => t.name === 'events').rows, [['x', 60], ['e1', 2]]);
  const next = readView(graph, { offset: 50, limit: 50 }).tables.find((t) => t.name === 'transitions');
  assert.deepEqual([next.rows.length, next.rows[0][0], next.page.has_more], [10, 'e9', false]);
  // a step matrix: a row per event, its share at each step, the events by the highest share they reach
  const matrix = readView({ kind: 'step_matrix', blocks: [{ block: 0, steps: [1, 2], cells: [{ event: 'a', step: 1, share: 0.2 }, { event: 'b', step: 1, share: 0.8 }, { event: 'a', step: 2, share: 0.9 }] }] });
  assert.deepEqual(matrix.tables.map((t) => [t.name, t.columns, t.rows]), [['step_matrix', ['event', '1', '2'], [['a', 0.2, 0.9], ['b', 0.8, 0]]]]);
  // a funnel: its steps in order
  const funnel = readView({ kind: 'funnel', steps: [{ step: 'a', unique_paths: 10, conversion_rate: 1, step_conversion_rate: 1 }, { step: 'b', unique_paths: 4, conversion_rate: 0.4, step_conversion_rate: 0.4 }] });
  assert.deepEqual(funnel.tables[0].rows.map((r) => [r[0], r[1]]), [['a', 10], ['b', 4]]);
  // a group overview: each group with its size, share and profile, whole; the metrics as a paged table,
  // the one that tells the groups apart most first
  const overview = readView({
    kind: 'segment_overview', levels: ['ios', 'web'],
    metrics: [
      { metric: 'segment_size', label: 'paths', values: [30, 10] }, { metric: 'segment_share', label: 'share of paths', values: [0.75, 0.25] },
      { metric: 'length', label: 'length', values: [10, 10.5] }, { metric: 'has_event_shop', label: 'share with shop', values: [0.1, 0.9] },
    ],
  });
  assert.deepEqual(overview.levels.map((l) => [l.name, l.size, l.share]), [['ios', 30, 0.75], ['web', 10, 0.25]]);
  assert.deepEqual(overview.levels[0].profile.map((p) => [p.metric, p.vs_others]), [['share with shop', -0.8], ['length', -0.5]], 'what it stands out on most first');
  const metrics = overview.tables.find((t) => t.name === 'metrics');
  assert.deepEqual(metrics.columns, ['metric', 'label', 'ios', 'web']);
  assert.deepEqual(metrics.rows.map((r) => r[0]), ['has_event_shop', 'length']);
  // the library's own tables, each a page in its own order, with its role — and whether a page needs more
  // rows than the task holds (the rest is read from the stored table)
  const held = { kind: 'describe', tables: [{ name: 'labels', columns: ['path', 'cluster'], rows: Array.from({ length: 20 }, (_, i) => [i, i % 2]), total_rows: 1000, truncated: true, role: 'per_path' }] };
  const lib = readView(held, { offset: 5, limit: 10 }).tables[0];
  assert.deepEqual([lib.name, lib.role, lib.rows[0], lib.rows.length, lib.page.total_rows, lib.page.has_more], ['labels', 'per_path', [5, 1], 10, 1000, true]);
  assert.equal(holdsPage(held, { offset: 5, limit: 10 }), true, 'a page within the rows held');
  assert.equal(holdsPage(held, { offset: 15, limit: 10 }), false, 'a page past them');
  assert.equal(holdsPage(held, { offset: 2000, limit: 10 }), true, 'a page past the last row needs none');
  // an analysis the library raised on is its error alone
  assert.deepEqual(readView({ kind: 'funnel', error: { type: 'ValueError', message: 'x' } }), { kind: 'funnel', error: { type: 'ValueError', message: 'x' } });
});

test('a read of an eventstream pages each segment\'s levels; the read refuses detail, telling how to page', async () => {
  const { withLevels } = await import('../../src/retentioneering/query.js');
  const out = { kind: 'eventstream', events: 5, segment_levels: { platform: { count: 3, levels: ['ios', 'android', 'web'], users: [5, 3, 1], complete: true } } };
  const page = withLevels(out, { offset: 1, limit: 1 }).segment_levels.platform;
  assert.deepEqual([page.count, page.levels, page.page.total_rows, page.page.has_more, page.page.next_offset, page.complete], [3, [{ level: 'android', users: 3 }], 3, true, 2, undefined]);
  assert.deepEqual(withLevels(out).segment_levels.platform.levels.map((l) => l.level), ['ios', 'android', 'web']);
  // `detail` is no read's: refused before anything is waited on, with the read that pages instead
  const e = on();
  for (const detail of ['full', 'summary']) {
    await assert.rejects(e.query_retentioneering_model({ task_ids: ['a0a0a0a0a0a0'], detail }), (err) => err.field === 'detail' && /offset/.test(err.message) && /limit/.test(err.message));
  }
  // the read's own fields pass the schema (and stop only at the task, which does not exist)
  await assert.rejects(e.query_retentioneering_model({ task_ids: ['a0a0a0a0a0a0'], offset: 50, limit: 10, wait_seconds: 0 }), (err) => !/invalid input/.test(err.message));
  await assert.rejects(e.query_retentioneering_model({ task_ids: ['a0a0a0a0a0a0'], cancel: true, offset: 50 }), /invalid input/, 'a cancel does not page');
  e.close();
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
  // alone, so one mixed with another constant is refused at the start, naming the column as the call does
  const between = { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' };
  const start = {
    name: 'x', source: 'events', segments: ['flag'],
    steps: [
      { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'country', name: 'flag' }], between },
      { stage: 'where', conditions: [{ fn: 'in', args: [{ column: 'flag' }, { value: true }, { value: 'x' }] }] },
    ],
  };
  await assert.rejects(e.build_retentioneering_model(start), (err) => err.stage === 'validate' && err.field === 'steps[1]' && /'flag' is a text column in the warehouse/.test(err.message));
  e.close();
});

// delete_context has one form per kind of build a context holds: the feature contributes the eventstream's
// through the feature registry (src/features.js deletes) — off, the form does not exist. It removes the
// eventstream's name and nothing else of the context; its tables stay until the context is dropped.
// Context lifecycle; no warehouse.
test('delete_context removes one eventstream in the feature\'s own form, which exists only with the feature on', async () => {
  const e = on();
  const { contextFor } = await import('../../src/retentioneering/contexts.js');
  const ctx = contextFor(e, {});
  const es = (name) => ({ spec: { name, source: 'events' }, base: { model: `rete_${name}`, shape: { events: ['a'], paths: ['user_id'], segments: {}, columns: [] } }, steps: [], checkpoint: null });
  ctx.state.retentioneering.eventstreams = { es: es('es'), other: es('other') };
  const out = await e.delete_context({ what: 'eventstream', context_id: ctx.id, eventstream: 'es' });
  assert.deepEqual([out.removed, out.context_id, out.eventstream], [true, ctx.id, 'es']);
  assert.deepEqual(Object.keys(ctx.state.retentioneering.eventstreams), ['other'], 'the others are kept');
  assert.ok(e.ctxs.get(ctx.id), 'and so is the context');
  await assert.rejects(Promise.resolve().then(() => e.delete_context({ what: 'eventstream', context_id: ctx.id, eventstream: 'nope' })), (err) => err.field === 'eventstream' && /no eventstream 'nope'.*it holds other/.test(err.message));
  await assert.rejects(Promise.resolve().then(() => e.delete_context({ what: 'eventstream', context_id: ctx.id })), /invalid input: .*missing required property 'eventstream'/);
  const plain = (await e.build_pipeline_model({ action: 'start', name: 'plain', source: 'events' })).context_id;
  await assert.rejects(Promise.resolve().then(() => e.delete_context({ what: 'eventstream', context_id: plain, eventstream: 'es' })), (err) => err.field === 'context_id' && /is not a path-analysis context/.test(err.message));
  assert.equal(e.schemas.delete_context.anyOf.map((b) => deref(e.schemas.delete_context, b)).filter((f) => pinned(e.schemas.delete_context, f, 'what').includes('eventstream')).length, 1);
  // off: no such form, and `what` is one of the core's
  const offEngine = engine();
  assert.ok(!offEngine.schemas.delete_context.anyOf.map((b) => deref(offEngine.schemas.delete_context, b)).some((f) => pinned(offEngine.schemas.delete_context, f, 'what').includes('eventstream')));
  await assert.rejects(Promise.resolve().then(() => offEngine.delete_context({ what: 'eventstream', context_id: ctx.id, eventstream: 'other' })), /`what` must be one of: context, pipeline_model, semantic_model/);
  e.close(); offEngine.close?.();
});

// What a step action answers — as the pipeline builder answers: the steps just added (or the one an edit
// or an insert put in place), each with what it changed and, when it was not checked, why, and
// steps_count; an edit's, an insert's, a delete's or a truncate's `changed` is what the call changed of
// the shape at the end; include: ['steps'] gives every step instead, include: ['columns'] the whole shape
// after them. The library's check is a stub.
test('a step action answers with each step it added and what it changed, and steps_count — every step and the whole shape when asked', async () => {
  const { commitSteps, fork } = await import('../../src/retentioneering/steps.js');
  const shape = (events) => ({ events, paths: ['user_id'], segments: {}, columns: [] });
  const base = { shape: shape(['a', 'shop_opened', 'tutorial']), model: 'm', summary: {} };
  const commit = (reply, action, input, steps = []) => {
    const feature = { checker: { check: async () => ({ steps: reply }) } };
    const es = { base, steps, checkpoint: null };
    return commitSteps({ ctxs: { touch() {} } }, feature, { id: 'c1', state: {} }, 'es', es, action, input);
  };
  const two = [{ type: 'rename_events', mapping: { shop_opened: 'shop' } }, { type: 'drop_events', names: ['tutorial'] }];
  const checkedTwo = [{ ok: true, shape: shape(['a', 'shop', 'tutorial']) }, { ok: true, shape: shape(['a', 'shop']) }];
  const a = await commit(checkedTwo, 'add_steps', { steps: two });
  assert.deepEqual(a.steps_added, [
    { index: 1, type: 'rename_events', checked: true, changed: { events_added: ['shop'], events_removed: ['shop_opened'] } },
    { index: 2, type: 'drop_events', checked: true, changed: { events_removed: ['tutorial'] } },
  ]);
  assert.deepEqual([a.steps_count, a.steps, a.step, a.changed, a.shape], [2, undefined, undefined, undefined, undefined], 'each added step says its change: no total beside them, no shape unless asked');
  // asked for: every step (as preview lists them), and the whole shape after them
  const all = await commit(checkedTwo, 'add_steps', { steps: two, include: ['steps', 'columns'] });
  assert.deepEqual(all.steps.map((s) => [s.index, s.step.type, s.checked, s.materialized, s.changed]), [
    [1, 'rename_events', true, false, { events_added: ['shop'], events_removed: ['shop_opened'] }],
    [2, 'drop_events', true, false, { events_removed: ['tutorial'] }],
  ]);
  assert.deepEqual([all.steps_added, all.steps_count], [undefined, undefined], 'the list stands for both');
  assert.deepEqual([all.shape.events, all.shape.paths], [['a', 'shop'], ['user_id']]);
  // the whole shape is whole: no cut of the events a listing makes
  const many = Array.from({ length: 250 }, (_, i) => `e${i}`);
  const wide = await commit([{ ok: true, shape: shape(many) }], 'add_steps', { steps: [two[0]], include: ['columns'] });
  assert.deepEqual([wide.shape.events.length, wide.shape.events_more], [250, undefined]);
  // the first step the stand-ins could not carry: its own reason, and the next one's
  const b = await commit([{ ok: null, note: 'the stand-ins could not carry it' }], 'add_steps', { steps: two });
  assert.deepEqual(b.steps_added.map((s) => [s.index, s.checked, typeof s.note]), [[1, false, 'string'], [2, false, 'string']]);
  assert.equal(b.steps_added[0].note, 'the stand-ins could not carry it');
  assert.deepEqual(b.unchecked_steps, [1, 2]);
  // an edit names the step it put in place with what that step changed, and what the call changed at the end
  const kept = [{ step: two[0], library: {}, checked: true, shape: shape(['a', 'shop', 'tutorial']) }];
  const c = await commit([{ ok: true, shape: shape(['a', 'shop_opened']) }], 'edit_step', { index: 1, step: two[1] }, kept);
  assert.deepEqual(c.step, { index: 1, type: 'drop_events', checked: true, changed: { events_removed: ['tutorial'] } });
  assert.deepEqual(c.changed, { events_added: ['shop_opened'], events_removed: ['shop', 'tutorial'] });
  assert.deepEqual([c.steps_added, c.steps_count], [undefined, 1]);
  // a delete and a truncate: the count, and the change at the end
  const d = await commit([], 'delete_step', { index: 2 }, [...kept, { step: two[1], library: {}, checked: true, shape: shape(['a', 'shop']) }]);
  assert.deepEqual([d.steps_count, d.changed, d.step], [1, { events_added: ['tutorial'] }, undefined]);
  const t = await commit([], 'truncate', { after: 0 }, kept);
  assert.deepEqual([t.steps_count, t.changed], [0, { events_added: ['shop_opened'], events_removed: ['shop'] }]);
  // a fork: its own name, the count of the steps it copied — every step and the whole shape when asked
  const ctx = () => ({ id: 'c1', state: { retentioneering: { eventstreams: { es: { base, steps: structuredClone(kept), checkpoint: null } } } } });
  const engine = { ctxs: { touch() {} } };
  const lean = fork(engine, ctx(), { name: 'variant' });
  assert.deepEqual([lean.eventstream, lean.steps_count, lean.steps, lean.shape], ['variant', 1, undefined, undefined]);
  const rich = fork(engine, ctx(), { name: 'variant', after: 1, include: ['steps', 'columns'] });
  assert.deepEqual([rich.steps.map((s) => s.index), rich.steps_count, rich.shape.events], [[1], undefined, ['a', 'shop', 'tutorial']]);
});

// What a path names and what a filter_events condition holds are checked against the eventstream as
// the step is added — before the library's check, before anything runs — by the one writer every where
// is written by. Input guards; no warehouse.
test('a path is one of the eventstream\'s path columns, and a condition\'s constant is what its function takes', async () => {
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
  const level = (fn, ...values) => ({ fn, args: [{ column: 'level' }, ...values.map((value) => ({ value }))] });
  for (const [where, re] of [
    [[level('in', 1, '2')], /takes constants of one kind — the column is compared as that kind/],
    [[{ fn: 'eq', args: [{ column: 'level' }, { value: [3] }] }], /a list is written as arguments of their own/],
    [[level('between', 1)], /between takes 3 arguments \[a, low, high\]/],
    [[level('contains', 1)], /contains takes text as its second argument/],
    [[level('eq', null)], /a missing value is tested with is_null/],
    [[level('is_null', 1)], /is_null takes 1 argument/],
    [[level('gt')], /gt takes 2 arguments/],
    [[level('eq', 1), { value: 1 }], /a where takes conditions/],
  ]) await assert.rejects(add(where), (e) => e.field === 'steps[0].where' && re.test(e.message), JSON.stringify(where));
  // …and one that is, is taken (the check could not run here: nothing refused, nothing ran)
  const ok = await add([level('gte', 2), { fn: 'or', args: [{ fn: 'not', args: [{ fn: 'in', args: [{ column: 'event' }, { value: 'a' }] }] }, level('is_null')] }]);
  assert.equal(ok.steps_count, 1);
});

// A start's steps are the pipeline's stages: a where and a compute case's `when` hold a constant to the
// rule every where is written by (the one writer, src/pipeline/compute.js), each refusal at its step.
// Input guards; no warehouse.
test('a start\'s where and a compute case take a constant by the rule every where takes it', async () => {
  const e = on();
  const start = (steps) => e.build_retentioneering_model({ name: 'x', source: 'events', steps });
  const bundle = (fn, ...values) => ({ fn, args: [{ column: 'bundle_id' }, ...values.map((value) => ({ value }))] });
  for (const [cond, re] of [
    [bundle('eq', null), /a missing value is tested with is_null/],
    [bundle('in', 'a', null), /a missing value is tested with is_null/],
    [bundle('starts_with', 1), /starts_with takes text as its second argument/],
    [{ fn: 'gt', args: [{ column: 'session_number' }, { value: 'many' }] }, /'session_number' is a number: compare it with a number/],
    [{ column: 'bundle_id' }, /a where takes conditions/],
  ]) {
    await assert.rejects(start([{ stage: 'where', conditions: [cond] }]), (err) => err.field === 'steps[0]' && /^steps\[0\] \(where\): /.test(err.message) && re.test(err.message), `where ${JSON.stringify(cond)}`);
    const split = { stage: 'compute', name: 'ev', expr: { fn: 'case', cases: [{ when: [cond], then: { value: 'lost' } }], else: { column: 'event_name' } } };
    await assert.rejects(start([split]), (err) => err.field === 'steps[0]' && /^steps\[0\] \(compute\): /.test(err.message) && re.test(err.message), `when ${JSON.stringify(cond)}`);
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
// today's path: [column] — the key a summary says, whatever the steps materialized after it. Pure
// translation; the rows of such an eventstream are proved in test/integration/retentioneering.test.js.
test('a start stored with columns.path is read as path: [column]', async () => {
  const { currentSpec } = await import('../../src/retentioneering/earlier.js');
  const { pathKey } = await import('../../src/retentioneering/query.js');
  const { summarizeEventstream } = await import('../../src/retentioneering/steps.js');
  const stored = { name: 'from_pipe', from_task: 'a0a0a0a0a0a0', columns: { path: 'player_id_of_internal', event: 'ev', time: 'device_time' }, segments: [{ column: 'bundle_id', name: 'app' }] };
  const now = currentSpec(stored, loadCatalog(CATALOG, {}));
  assert.deepEqual(now.path, ['player_id_of_internal']);
  assert.deepEqual(now.columns, { event: 'ev', time: 'device_time' });
  // a segment renamed is a compute copy, carried under its name
  assert.deepEqual(now.segments, ['app']);
  assert.deepEqual(now.steps, [{ stage: 'compute', name: 'app', expr: { column: 'bundle_id' } }]);
  assert.deepEqual(pathKey(now), ['player_id_of_internal']);
  // the summary a materialize answers with says the path as the stored spec meant it (the warehouse's
  // answers are stubs: one event, two paths)
  const runner = { show: async () => ({ ok: true, rows: [{ events: 3, users: 2, names: 1, event: 'a' }] }) };
  const summary = await summarizeEventstream(runner, '/nowhere', 'm', { segments: [], paths: ['user_id'], spec: now, dialect: 'duckdb' });
  assert.deepEqual([summary.path, summary.users], [['player_id_of_internal'], 2]);
});

// A start an earlier version stored is read in today's spelling at the one point a path-analysis context
// is opened (pathContext): its rows' fields as the pipeline's stages, its list of them as `steps` (it
// was `stages`), its segments and path as column names — so every reader after it reads one spelling.
// One in today's spelling is left as it is. Context lifecycle and pure translation; the rows such a
// start keeps are proved in test/integration/.
test('a start stored in an earlier spelling is carried over when its context is opened; one written today is left as it is', async () => {
  const e = on();
  const { currentSpec, currentStep, currentWhere } = await import('../../src/retentioneering/earlier.js');
  const { contextFor, pathContext } = await import('../../src/retentioneering/contexts.js');
  const catalog = e.catalog;
  const between = { column: 'device_time', from: 'install_time_valid_from', to: 'install_time_valid_until' };
  const eq = (column, value) => ({ fn: 'eq', args: [{ column }, { value }] });
  const stored = {
    name: 'paths', source: 'events',
    events: { include: ['level_started', 'level_completed'], top: 5 },
    segments: [{ model: 'users', attribute: 'platform' }],
    where: [{ column: 'bundle_id', op: 'eq', value: 'com.omg.wordsearch' }],
    sessions: { gap_minutes: 30 },
  };
  const today = currentSpec(stored, catalog);
  assert.deepEqual(today.steps, [
    { stage: 'where', conditions: [{ fn: 'in', args: [{ column: 'event_name' }, { value: 'level_started' }, { value: 'level_completed' }] }] },
    { stage: 'where', conditions: [eq('bundle_id', 'com.omg.wordsearch')] },
    { stage: 'join', with: 'users', via: 'user', attrs: [{ column: 'platform' }], between },
  ]);
  assert.deepEqual([today.segments, today.top, today.sessions], [['platform'], 5, { gap_minutes: 30 }]);
  for (const k of ['where', 'events', 'stages']) assert.equal(today[k], undefined, k);
  // a start converted is one the tool takes, and converting it again changes nothing — by identity
  e.host.validate('build_retentioneering_model', today);
  assert.equal(currentSpec(today, catalog), today);
  // a start that named its list `stages` is read with it as its steps, the stages as they were
  const listed = { name: 'listed', source: 'events', stages: [{ stage: 'where', conditions: [eq('bundle_id', 'x')] }], segments: ['bundle_id'] };
  const relisted = currentSpec(listed, catalog);
  assert.deepEqual(relisted, { name: 'listed', source: 'events', steps: listed.stages, segments: ['bundle_id'] });
  e.host.validate('build_retentioneering_model', relisted);
  assert.equal(currentSpec(relisted, catalog), relisted);
  // the context: its kept starts converted in place when it is opened, a start written today left alone
  const ctx = contextFor(e, {});
  const written = { name: 'today', source: 'events', steps: [{ stage: 'where', conditions: [eq('bundle_id', 'x')] }], segments: ['bundle_id'] };
  ctx.state.retentioneering.eventstreams.old = { model: 'm', source: 'events', spec: stored, steps: [] };
  ctx.state.retentioneering.eventstreams.listed = { model: 'm1', source: 'events', spec: listed, steps: [] };
  ctx.state.retentioneering.eventstreams.now = { model: 'm2', source: 'events', spec: written, steps: [] };
  pathContext(e, ctx.id);
  assert.deepEqual(ctx.state.retentioneering.eventstreams.old.spec, today);
  assert.deepEqual(ctx.state.retentioneering.eventstreams.listed.spec, relisted);
  assert.equal(ctx.state.retentioneering.eventstreams.now.spec, written);
  // a kept step: filter_events' earlier list in the grammar (a negation as not(…), which keeps a missing
  // value as it did), the earlier path word as its column — and a step written today as it is
  const step = { type: 'filter_events', where: [{ column: 'platform', op: 'not_in', value: ['ios'] }, { or: [{ column: 'level', op: 'gt', value: 2 }, { column: 'level', op: 'is_null' }] }] };
  assert.deepEqual(currentStep(step), { type: 'filter_events', where: [
    { fn: 'not', args: [{ fn: 'in', args: [{ column: 'platform' }, { value: 'ios' }] }] },
    { fn: 'or', args: [{ fn: 'gt', args: [{ column: 'level' }, { value: 2 }] }, { fn: 'is_null', args: [{ column: 'level' }] }] },
  ] });
  assert.deepEqual(currentStep({ type: 'collapse_events', loops: true, path: 'sessions' }), { type: 'collapse_events', loops: true, path: 'session_id' });
  const now = currentStep(step);
  assert.equal(currentStep(now), now);
  assert.equal(currentWhere(now.where), now.where);
  e.close();
});
