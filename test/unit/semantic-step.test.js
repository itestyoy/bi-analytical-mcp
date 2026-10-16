// THE SEMANTIC_MODEL STEP — a build's last step, the semantic layer over its source (src/pipeline/
// semantic-stage.js). Input-validation and lifecycle checks with no warehouse: where the step may stand,
// what its join's `on` must say (the key MetricFlow joins the model on, the main model's time axis), and
// how edit_step and fork treat it. What a layer computes is proven against the
// warehouse by the integration tests that declare one (test/helpers/declare.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { tempDir } from '../helpers/temp-dir.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => new Engine({ catalog: loadCatalog(CATALOG, {}), contextManager: new ContextManager({ workspaceRoot: tempDir('semstep') }) });

const COUNT = { name: 'rows', expr: { fn: 'count' } };
const N = [{ name: 'rows', type: 'simple', measure: 'rows' }];
const USERS = { source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } };
const step = (extra = {}) => ({ stage: 'semantic_model', measures: [COUNT], metrics: N, ...extra });
const start = (e, steps, source = 'events') => e.build_model({ action: 'start', name: 'lay', source, ...(steps.length ? { steps } : {}) });

test('the step is a build\'s last, and one: refused before another step and twice', async () => {
  const e = engine();
  await assert.rejects(() => start(e, [step(), { stage: 'limit', limit: 1 }]), /a semantic_model step is the build's last — put it after the others/);
  await assert.rejects(() => start(e, [step(), step()]), /a build has one semantic_model step/);
  // added after a start, it is the last step, and nothing is added after it
  const s = await start(e, []);
  const added = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [step()] });
  assert.deepEqual(added.step_effects.map((x) => [x.stage, x.metrics]), [['semantic_model', ['rows']]]);
  await assert.rejects(() => e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [{ stage: 'limit', limit: 1 }] }), /ends in its semantic_model step \(step 1\): nothing comes after it/);
});

test('a join names its contract and MetricFlow\'s key: the main model\'s key column, the main model\'s time axis', async () => {
  const e = engine();
  const ok = await start(e, [step({ join: [USERS] })]);
  assert.deepEqual(ok.step_effects[0].semantic_models.sort(), ['events', 'users']);
  // the key part is the main model's column of the key MetricFlow joins on
  await assert.rejects(() => start(e, [step({ join: [{ source: 'users', on: { user: 'session_number', time: 'device_time' } }] })]), /MetricFlow joins 'users' onto 'events' by the key 'user' — user: 'player_id_of_internal'/);
  // the time part is the main model's time axis: MetricFlow matches the version valid at the metric's time
  await assert.rejects(() => start(e, [step({ join: [{ source: 'users', on: { user: 'player_id_of_internal', time: 'install_date' } }] })]), /on\.time is 'device_time', the main model's time axis/);
  // a model nothing points at a key of is no join: its measures are computed beside the main model's
  await assert.rejects(() => start(e, [step({ join: [{ source: 'acquisition', on: { user: 'player_id_of_internal', time: 'device_time' } }] })]), /`steps\.0\.join\.0/);
  const beside = await start(e, [step({ measures: [COUNT, { name: 'spend', source: 'acquisition', expr: { fn: 'sum', args: [{ column: 'cost' }] } }], metrics: [...N, { name: 'spend', type: 'simple', measure: 'spend' }] })]);
  assert.deepEqual(beside.step_effects[0].metrics.sort(), ['rows', 'spend']);
  // the main model is no source of a measure, nor joined to itself
  await assert.rejects(() => start(e, [step({ measures: [{ ...COUNT, source: 'events' }] })]), /'events' is the main model — leave source out/);
});

test('a catalog source is read on its own time axis; a time the step names must be that one', async () => {
  const e = engine();
  assert.ok(await start(e, [step({ time: 'device_time' })]));
  await assert.rejects(() => start(e, [step({ time: 'install_date' })]), /'events' is read on its own time axis, 'device_time'/);
});

test('preview shows the layer; edit_step replaces the step, a whole fork carries it and a fork before it does not', async () => {
  const e = engine();
  const s = await start(e, [step()]);
  const shown = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.deepEqual(shown.metrics, ['rows']);
  assert.ok(shown.yaml.includes('rows'), 'the YAML it writes');
  const { index } = shown.steps.find((x) => x.stage === 'semantic_model');
  // an edit replaces it with another semantic_model step, never with a stage
  await assert.rejects(() => e.build_model({ action: 'edit_step', context_id: s.context_id, index, step: { stage: 'limit', limit: 1 } }), /is the build's semantic_model step/);
  const edited = await e.build_model({ action: 'edit_step', context_id: s.context_id, index, step: step({ metrics: [{ name: 'events', type: 'simple', measure: 'rows' }] }) });
  assert.deepEqual(edited.step_effects[0].metrics, ['events']);
  // a whole fork carries it, a fork of the steps before it does not
  const whole = await e.build_model({ action: 'fork', context_id: s.context_id, name: 'lay_copy', include: ['steps'] });
  assert.deepEqual(whole.steps.map((x) => x.stage), ['semantic_model']);
  const none = await e.build_model({ action: 'fork', context_id: s.context_id, name: 'lay_none', after: 0, include: ['steps'] });
  assert.deepEqual(none.steps, []);
});

// OVER A TABLE THE STEPS BEFORE IT BUILT: the table is a model of the context, read on the time axis the
// step names, its foreign keys the ones its joins name — each part a column of the table, the time the
// axis. The build's name is the model's, so it is named apart from the catalog's models and keys.
test('over the table of the steps before it: its time axis named, its joins keyed by its columns', async () => {
  const e = engine();
  const sessions = [
    { stage: 'aggregate', group_by: ['player_id_of_internal', 'session_number'], measures: [{ name: 'session_start', expr: { fn: 'min', args: [{ column: 'device_time' }] } }, { name: 'n_events', expr: { fn: 'count' } }] },
  ];
  const over = (st) => e.build_model({ action: 'start', name: 'sess', source: 'events', steps: [...sessions, st] });
  await assert.rejects(() => over(step()), /time: name the column of the table the steps before this one built that is its time axis/);
  await assert.rejects(() => over(step({ time: 'no_such' })), /time: 'no_such' is no column of the table/);
  await assert.rejects(() => over(step({ time: 'n_events' })), /time: 'n_events' is int, not a moment/);
  const join = (on) => ({ source: 'users', on: { user: 'player_id_of_internal', time: 'session_start', ...on } });
  await assert.rejects(() => over(step({ time: 'session_start', join: [join({ time: 'n_events' })] })), /on\.time is 'session_start', the main model's time axis/);
  await assert.rejects(() => over(step({ time: 'session_start', join: [join({ user: 'no_such' })] })), /on\.user names 'no_such', which is no column of the table/);
  const ok = await over(step({ time: 'session_start', join: [join()], measures: [COUNT, { name: 'per_session', expr: { fn: 'average', args: [{ column: 'n_events' }] } }], metrics: [...N, { name: 'per_session', type: 'simple', measure: 'per_session' }] }));
  const effect = ok.step_effects.find((x) => x.stage === 'semantic_model');
  assert.deepEqual(effect.semantic_models.sort(), ['sess', 'users']);
  assert.deepEqual(effect.metrics.sort(), ['per_session', 'rows']);
  // a build named as a model or a key of the catalog would name its table so
  await assert.rejects(() => e.build_model({ action: 'start', name: 'users', source: 'events', steps: [...sessions, step({ time: 'session_start' })] }), /the build's name 'users' is a model or a key of the catalog/);
});

// NAMES AS DECLARED: a metric, a measure and a computed dimension are stored under the name the step gives
// them, so what MetricFlow refuses of a name is refused when the step is added, naming it as declared.
test('names are stored as declared: a grain, a governed measure\'s name and another element\'s are refused', async () => {
  const e = engine();
  const named = (name) => step({ measures: [{ name, expr: { fn: 'count' } }], metrics: [{ name: 'rows', type: 'simple', measure: name }] });
  // the schema holds MetricFlow's spelling: two characters at least, no `__`, no `_` at the end
  for (const bad of ['n', 'a__b', 'rows_']) await assert.rejects(() => start(e, [named(bad)]), /must match pattern/, bad);
  await assert.rejects(() => start(e, [named('week')]), /measure 'week': a time grain is no name/);
  await assert.rejects(() => start(e, [step({ metrics: [{ name: 'metric_time', type: 'simple', measure: 'rows' }] })]), /MetricFlow reserves the name 'metric_time'/);
  await assert.rejects(() => start(e, [named('total_spend')]), /the catalog governs a measure of that name on 'acquisition'/);
  // a measure named as a dimension or an entity of the layer
  await assert.rejects(() => start(e, [named('event_name')]), /measure 'event_name': 'event_name' is already a dimension of 'events'/);
  await assert.rejects(() => start(e, [named('session')]), /measure 'session': 'session' is already an entity of 'events'/);
  // the stored name is the declared one, and a governed measure is read by its own
  const ok = await start(e, [step({ metrics: [...N, { name: 'spend', type: 'simple', measure: 'total_spend' }] })]);
  assert.deepEqual(ok.step_effects[0].metrics.sort(), ['rows', 'spend']);
});
