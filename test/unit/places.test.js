// WHAT A PLACE TAKES: a concept has ONE definition in every tool's schema — `$defs.expr`, `$defs.stage`,
// `$defs.ref` — and a place that takes it accepts a subset, one table per concept (PLACES,
// src/pipeline/compute.js; STAGE_PLACES, src/pipeline/stages.js; REF_PLACES, src/schema/refs.js), checked
// when the value is built: the refusal names the place and what it takes. A feature checks a place of its
// own in the same shape, so the core never names it. The expression's places are held in
// expression-grammar.test.js; these are the stages' and the refs', and the tools that check them in the
// call. Input-validation checks; no warehouse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { stageAt, stageDef, renderPipeline, STAGE_PLACES } from '../../src/pipeline.js';
import { PLACES } from '../../src/pipeline/compute.js';
import { REFS, REF_PLACES, VALUE_REFS, refAt, refKind, refForms, refColumns, relationshipsTo } from '../../src/schema/refs.js';
import { settle } from '../helpers/settle.js';
import { tempDir } from '../helpers/temp-dir.js';
// the stages registered beside the core's (a funnel, a python model), as a server has them
import '../../src/match-recognize.js';
import '../../src/python-model.js';
import { declare } from '../helpers/declare.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const engine = () => settle(new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: tempDir('places') }) }));
const message = (f) => { try { f(); return null; } catch (e) { return e.message; } };

test('a build takes every stage, a read the ones that keep it one table — the others are named with where they are built', () => {
  assert.equal(STAGE_PLACES.build.stages, null, 'a build: every stage there is');
  for (const stage of ['where', 'compute', 'join', 'unnest', 'aggregate', 'match_recognize', 'python']) assert.equal(message(() => stageAt('build', { stage }, 'steps[0]')), null, stage);
  for (const stage of STAGE_PLACES.read.stages) assert.equal(message(() => stageAt('read', { stage }, 'steps[0]')), null, stage);
  for (const stage of ['join', 'unnest', 'match_recognize', 'python']) {
    const said = message(() => stageAt('read', { stage }, 'steps[2]'));
    assert.ok(said.startsWith(`steps[2]: a read takes ${STAGE_PLACES.read.stages.join(', ')} — `), said);
    assert.match(said, new RegExp(`an? ${stage} stage makes a new table: build it from the task, build_model\\(\\{ request: \\{ action: "start", name, from_task \\} \\}\\)`));
  }
  // a step that names no stage, or one there is not, is said so at its place
  assert.match(message(() => stageAt('read', { limit: 3 }, 'steps[0]')), /^steps\[0\]: a read takes .* — this step names no `stage`$/);
  assert.match(message(() => stageAt('read', { stage: 'nope' }, 'steps[0]')), /there is no 'nope' stage/);
  // the semantic layer's step (a metric query's metrics) is no stage of the registry: only the place that
  // offers it takes it — not a build's "every stage", not a read; it makes no table, so the refusal says
  // where it belongs instead of "build it from the task"
  const semantic = /a metrics step is what the semantic layer computes, one per metric query \(query_model\)$/;
  assert.equal(stageDef('metrics'), null, 'the metrics step is no pipeline stage');
  assert.match(message(() => stageAt('build', { stage: 'metrics' }, 'steps[0]')), /^steps\[0\]: a build takes every stage over a table's rows — /);
  assert.match(message(() => stageAt('build', { stage: 'metrics' }, 'steps[0]')), semantic);
  assert.match(message(() => stageAt('read', { stage: 'metrics' }, 'steps[0]')), /^steps\[0\]: a read takes /);
  assert.match(message(() => stageAt('read', { stage: 'metrics' }, 'steps[0]')), semantic);
  assert.doesNotMatch(message(() => stageAt('read', { stage: 'metrics' }, 'steps[0]')), /makes a new table/);
  // …and a build that meets one (a step kept in a draft or a recipe, which no schema checked) refuses it
  // by that place's check, never by building it; a stage name nothing has is told the stages there are,
  // the metrics step not among them
  const physicalCols = new Set(['player_id_of_internal']);
  assert.match(message(() => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'metrics', metrics: ['m'] }], { physicalCols })), new RegExp(`^a build takes every stage over a table's rows — ${semantic.source}`));
  const unknown = message(() => renderPipeline(catalog, catalog.dialect, 'events', [{ stage: 'transmogrify' }], { physicalCols }));
  assert.match(unknown, /^unknown pipeline stage: transmogrify \(known: where, compute, /);
  assert.doesNotMatch(unknown, /metrics/);
});

// A METRIC QUERY'S PLACES: up to its metrics step, where steps and the metrics step (metric_scope, which
// offers it: the step's one definition); after it, what a read takes, over the result (metric_result) —
// the read's list, and a stage it leaves out is built from the stored result.
test('a metric query takes where steps and its metrics step up to it, and a read\'s steps after it', () => {
  assert.deepEqual(STAGE_PLACES.metric_scope.stages, ['where', 'metrics']);
  assert.deepEqual(STAGE_PLACES.metric_scope.offers.map((s) => s.stage), ['metrics'], 'the place up to the metrics step offers it');
  assert.deepEqual(STAGE_PLACES.metric_result.stages, STAGE_PLACES.read.stages);
  for (const stage of ['where', 'metrics']) assert.equal(message(() => stageAt('metric_scope', { stage }, 'steps[0]')), null, stage);
  for (const stage of STAGE_PLACES.read.stages) assert.equal(message(() => stageAt('metric_result', { stage }, 'steps[1]')), null, stage);
  assert.match(message(() => stageAt('metric_scope', { stage: 'limit' }, 'steps[0]')), /^steps\[0\]: a step up to the metrics step takes where, metrics — a limit stage is not one of them$/);
  assert.match(message(() => stageAt('metric_result', { stage: 'join' }, 'steps[2]')), /^steps\[2\]: a step after the metrics step takes where, .* — a join stage makes a new table: store the result \(materialize: true\) and build from its task/);
  assert.match(message(() => stageAt('metric_result', { stage: 'metrics' }, 'steps[2]')), /^steps\[2\]: a step after the metrics step takes .* — a metrics step is what the semantic layer computes, one per metric query/);
});

test('a feature checks a place of its own with stageAt and refAt, in the shape of the core\'s tables', () => {
  const start = { what: 'a feature\'s start', stages: ['where', 'compute'], elsewhere: 'is built before it, from a task' };
  assert.equal(message(() => stageAt(start, { stage: 'where' }, 'steps[0]')), null);
  assert.match(message(() => stageAt(start, { stage: 'limit' }, 'steps[1]')), /^steps\[1\]: a feature's start takes where, compute — an? limit stage is built before it, from a task$/);
  assert.match(message(() => stageAt({ what: 'a feature\'s start', stages: ['where'] }, { stage: 'limit' }, 'steps[0]')), /a feature's start takes where — an? limit stage is not one of them/);
  assert.equal(refAt({ what: 'a feature\'s view', takes: ['source'] }, { source: 'users' }, 'at'), 'source');
  assert.match(message(() => refAt({ what: 'a feature\'s view', takes: ['source'] }, { source: 'users', column: 'country' }, 'at')), /^at: \{ source, column \} .*a feature's view.*it takes \{ source \}$/);
});

test('a ref says which it is by the fields that name it, and a value ref is what an expression reads as a leaf', () => {
  for (const [v, kind] of [
    [{ source: 'users' }, 'source'],
    [{ source: 'events', event: 'tutorial' }, 'source_event'],
    [{ source: 'users', column: 'country' }, 'source_column'],
    [{ source: 'users', column: 'country', via: 'user' }, 'source_column'],
    [{ source: 'events', property: 'result_of_event_data' }, 'source_property'],
    [{ semantic_model: ['users'], dimension: 'is_us' }, 'dimension'],
    [{ entity: 'user' }, 'entity'],
    [{ metric: 'revenue' }, 'metric'],
    [{ time: 'metric_time', grain: 'day' }, 'time'],
  ]) assert.equal(refKind(v), kind, JSON.stringify(v));
  // a row's own leaf, a function, a bare name: no ref
  for (const v of [{ column: 'country' }, { value: 1 }, { fn: 'eq', args: [] }, 'users', null]) assert.equal(refKind(v), null, JSON.stringify(v));
  // a source and one of its events name no value
  assert.deepEqual(VALUE_REFS, ['source_column', 'source_property', 'dimension', 'entity', 'metric', 'time']);
  assert.deepEqual(Object.keys(REFS).filter((k) => REFS[k].group === 'catalog'), ['source', 'source_event', 'source_column', 'source_property']);
});

test('each place takes the refs its row in REF_PLACES lists, and the refusal names the place and what it takes', () => {
  const catalogRefs = ['source', 'source_event', 'source_column', 'source_property'];
  assert.deepEqual(REF_PLACES.index_view.takes, catalogRefs, 'a semantic_index view: a thing of the catalog');
  assert.deepEqual(REF_PLACES.about.takes, catalogRefs, 'what a note is about: the same');
  assert.deepEqual(REF_PLACES.group_by.takes, ['source_column', 'source_property', 'dimension', 'entity', 'time'], 'a metric query\'s group_by: what a metric can be cut by');
  for (const place of ['index_view', 'about']) {
    for (const v of [{ metric: 'revenue' }, { semantic_model: ['users'], dimension: 'is_us' }, { entity: 'user' }, { time: 'metric_time' }]) {
      const said = message(() => refAt(place, v, 'at'));
      assert.ok(said.startsWith(`at: ${REFS[refKind(v)].says} `) && said.includes(REF_PLACES[place].what) && said.endsWith('it takes { source }, { source, event }, { source, column }, { source, property }'), said);
    }
    // a column is read where it is: no relationship is chosen there
    assert.match(message(() => refAt(place, { source: 'users', column: 'country', via: 'user' }, 'at')), /through no relationship — leave out via/);
  }
  for (const v of [{ source: 'users' }, { source: 'events', event: 'tutorial' }, { metric: 'revenue' }]) {
    assert.match(message(() => refAt('group_by', v, 'group_by[0]')), /^group_by\[0\]: .* is not what a metric query's group_by takes — it takes \{ source, column \}, \{ source, property \}, \{ semantic_model, dimension \}, \{ entity \}, \{ time: "metric_time" \}$/, JSON.stringify(v));
  }
  assert.equal(refAt('group_by', { source: 'users', column: 'country', via: 'user' }, 'group_by[0]'), 'source_column', 'a group_by reads a relationship chosen for a column');
  // a value that is no ref, and a field a ref's form does not take
  assert.match(message(() => refAt('group_by', { column: 'country' }, 'group_by[0]')), /a metric query's group_by takes .* — \{"column":"country"\} is none of them/);
  assert.match(message(() => refAt('group_by', { source: 'users', column: 'country', grain: 'day' }, 'group_by[0]')), /\{ source, column \} takes source, column, via, not grain/);
});

// The ref is closed per source, as semantic_index's views have always been: a name is never written
// without its owner, and a name the source does not carry cannot be written. `via` is offered only on
// a model several relationships lead to.
test('the ref is one closed form per source: its columns an enum, via only where several relationships lead to the model', () => {
  const forms = refForms(catalog);
  const users = forms.source_column.find((f) => f.properties.source.const === 'users');
  assert.deepEqual(users.properties.column.enum, refColumns(catalog, 'users'));
  assert.ok(users.properties.column.enum.includes('country'));
  assert.equal(users.additionalProperties, false);
  assert.deepEqual(relationshipsTo(catalog, 'users'), ['user']);
  assert.equal(users.properties.via, undefined, 'one relationship leads to users: no via to choose');
  // an events source's event column is one of its columns; its payload properties are its { source, property }
  const events = forms.source_column.find((f) => f.properties.source.const === 'events');
  assert.ok(events.properties.column.enum.includes('event_name'));
  assert.ok(!events.properties.column.enum.includes('result_of_event_data'), 'a payload property is no column');
  assert.ok(forms.source_property.find((f) => f.properties.source.const === 'events').properties.property.enum.includes('result_of_event_data'));
  assert.ok(!forms.source_property.some((f) => f.properties.source.const === 'users'), 'a model with no events has no event property');
  // several relationships onto one model: via is offered, with the ones there are
  const dir = tempDir('places-via');
  writeFileSync(join(dir, 'catalog.yml'), `version: 2
models:
  - name: fct_events
    config: { meta: { mcp: { role: events, primary_entity: event, known_events: [first_launch] } } }
    columns:
      - { name: player_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: foreign } } } } }
      - { name: referrer_code, data_type: string, config: { meta: { mcp: { entity: { name: referrer, type: foreign } } } } }
      - { name: device_time, data_type: timestamp, config: { meta: { mcp: { is_time: true } } } }
      - { name: event_name, data_type: string, config: { meta: { mcp: { is_event_name: true } } } }
  - name: dim_users
    config: { meta: { mcp: { role: users } } }
    columns:
      - { name: player_id, data_type: string, config: { meta: { mcp: { entity: { name: user, type: primary } } } } }
      - { name: referral_code, data_type: string, config: { meta: { mcp: { entity: { name: referrer, type: unique } } } } }
      - { name: country, data_type: string }
`);
  const two = loadCatalog(join(dir, 'catalog.yml'), {});
  const viaForm = refForms(two).source_column.find((f) => f.properties.source.const === 'users');
  assert.deepEqual([...viaForm.properties.via.enum].sort(), ['referrer', 'user']);
});

// The tools read the places in the call, before anything runs: a metric query's group_by and its where
// steps in a task's context, a pipeline step over a source's rows. A tool's definitions hold what its
// places take together (src/schema.js TOOL_PLACES): what none of them takes is no form there, refused by
// the schema; what one place of the tool takes and another does not is refused at the other's place,
// naming it.
test('a metric query refuses in the call what its group_by and its where steps do not take, naming the place', async () => {
  const e = engine();
  const { context_id } = await declare(e, { name: 'plc', semantic_models: [{ source: 'events', measures: [{ name: 'n', expr: { fn: 'count' } }] }, { source: 'users' }], metrics: [{ name: 'n', type: 'simple', measure: 'n' }] });
  const metrics = (extra = {}) => ({ stage: 'metrics', metrics: ['plc_n'], ...extra });
  const query = (...steps) => e.query_model({ context_id, steps });
  const where = (...conditions) => ({ stage: 'where', conditions });
  // a source, an event, a metric: no ref the tool's group_by takes, so no form of its $defs.ref
  for (const ref of [{ source: 'users' }, { source: 'events', event: 'tutorial' }, { metric: 'plc_n' }]) {
    await assert.rejects(() => query(metrics({ group_by: [ref] })), (err) => err.stage === 'validate' && /^invalid input: .*`steps\.0\.group_by\.0`/.test(err.message), JSON.stringify(ref));
  }
  // a metric in a where step: no leaf any place of the tool takes
  await assert.rejects(() => query(where({ fn: 'gt', args: [{ metric: 'plc_n' }, { value: 1 }] }), metrics()), (err) => err.stage === 'validate' && /^invalid input: .*`steps\.0\.conditions\.0\.args\.0`/.test(err.message));
  // a column of the rows and an aggregate: the steps' after the metrics step (a read of the result),
  // refused at the place of a where before it
  const at = PLACES.metric_where.what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [cond, said] of [
    [{ fn: 'eq', args: [{ column: 'country' }, { value: 'US' }] }, new RegExp(`\\{ column \\} is not what ${at} takes`)],
    [{ fn: 'gt', args: [{ fn: 'count' }, { value: 1 }] }, new RegExp(`count is not what ${at} takes`)],
  ]) {
    await assert.rejects(() => query(where(cond), metrics()), (err) => err.field === 'steps' && /^steps\[0\] conditions\[0\] /.test(err.message) && said.test(err.message) && err.message.includes(PLACES.metric_where.hint), JSON.stringify(cond));
  }
});

test('a pipeline step over a source\'s rows refuses a metric and another model\'s column, naming where each is read', async () => {
  const e = engine();
  const { context_id } = await e.build_model({ action: 'start', name: 'plc', source: 'events' });
  const where = (leaf) => [{ stage: 'where', conditions: [{ fn: 'eq', args: [leaf, { value: 1 }] }] }];
  const ctx = e.ctxs.get(context_id);
  for (const [leaf, said] of [[{ metric: 'revenue' }, /\{ metric \} /], [{ source: 'users', column: 'country' }, /\{ source, column \} /]]) {
    // no form of the build's expression: its schema refuses it
    await assert.rejects(() => e.build_model({ action: 'add_steps', context_id, steps: where(leaf) }), (err) => err.stage === 'validate' && /^invalid input: .*`steps\.0\.conditions\.0\.args\.0`/.test(err.message), JSON.stringify(leaf));
    // …and the step's place refuses it as it is built, for a caller past the schema
    await assert.rejects(() => (e.raw || e)._draftAddSteps(ctx, ctx.state.draft, where(leaf)),
      (err) => err.field === 'steps[0]' && said.test(err.message) && /is not what a step over a source's rows takes — it takes \{ column \}, \{ property \}, \{ value \}, \{ now: true \}, and every function\. A column of another model arrives by a join stage \(its attrs\), and a metric is query_model's/.test(err.message), JSON.stringify(leaf));
  }
  assert.equal(ctx.state.draft.stages.length, 0, 'nothing refused was added');
});
