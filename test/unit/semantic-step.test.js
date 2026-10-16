// THE SEMANTIC_MODEL STEP — a build's last step, the semantic layer over its source (src/pipeline/
// semantic-stage.js). Input-validation and lifecycle checks with no warehouse: where the step may stand,
// what its join's `on` must say (the key MetricFlow joins the model on, the main model's time axis), and
// how edit_step / delete_step / truncate / fork treat it. What a layer computes is proven against the
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

const COUNT = { name: 'n', expr: { fn: 'count' } };
const N = [{ name: 'n', type: 'simple', measure: 'n' }];
const USERS = { source: 'users', on: { user: 'player_id_of_internal', time: 'device_time' } };
const step = (extra = {}) => ({ stage: 'semantic_model', measures: [COUNT], metrics: N, ...extra });
const start = (e, steps, source = 'events') => e.build_model({ action: 'start', name: 'lay', source, ...(steps.length ? { steps } : {}) });

test('the step is a build\'s last, and one: refused before another step, twice, and with steps before it (until a table can carry it)', async () => {
  const e = engine();
  await assert.rejects(() => start(e, [step(), { stage: 'limit', limit: 1 }]), /a semantic_model step is the build's last — put it after the others/);
  await assert.rejects(() => start(e, [step(), step()]), /a build has one semantic_model step/);
  await assert.rejects(() => start(e, [{ stage: 'limit', limit: 1 }, step()]), /over the rows of steps before it is not built yet/);
  // added after a start, it is the last step, and nothing is added after it
  const s = await start(e, []);
  const added = await e.build_model({ action: 'add_steps', context_id: s.context_id, steps: [step()] });
  assert.deepEqual(added.step_effects.map((x) => [x.stage, x.metrics]), [['semantic_model', ['lay_n']]]);
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
  assert.deepEqual(beside.step_effects[0].metrics.sort(), ['lay_n', 'lay_spend']);
  // the main model is no source of a measure, nor joined to itself
  await assert.rejects(() => start(e, [step({ measures: [{ ...COUNT, source: 'events' }] })]), /'events' is the main model — leave source out/);
});

test('a catalog source is read on its own time axis; a time the step names must be that one', async () => {
  const e = engine();
  assert.ok(await start(e, [step({ time: 'device_time' })]));
  await assert.rejects(() => start(e, [step({ time: 'install_date' })]), /'events' is read on its own time axis, 'device_time'/);
});

test('preview shows the layer; edit_step replaces the step, delete_step and truncate remove it, a whole fork carries it', async () => {
  const e = engine();
  const s = await start(e, [step()]);
  const shown = await e.build_model({ action: 'preview', context_id: s.context_id });
  assert.deepEqual(shown.metrics, ['lay_n']);
  assert.ok(shown.yaml.includes('lay_n'), 'the YAML it writes');
  const { index } = shown.steps.find((x) => x.stage === 'semantic_model');
  // an edit replaces it with another semantic_model step, never with a stage
  await assert.rejects(() => e.build_model({ action: 'edit_step', context_id: s.context_id, index, step: { stage: 'limit', limit: 1 } }), /is the build's semantic_model step/);
  const edited = await e.build_model({ action: 'edit_step', context_id: s.context_id, index, step: step({ metrics: [{ name: 'events', type: 'simple', measure: 'n' }] }) });
  assert.deepEqual(edited.step_effects[0].metrics, ['lay_events']);
  // a whole fork carries it, a fork of fewer steps does not
  const whole = await e.build_model({ action: 'fork', context_id: s.context_id, name: 'lay_copy', include: ['steps'] });
  assert.deepEqual(whole.steps.map((x) => x.stage), ['semantic_model']);
  const none = await e.build_model({ action: 'fork', context_id: s.context_id, name: 'lay_none', after: 0, include: ['steps'] });
  assert.deepEqual(none.steps, []);
  // truncate before it, and delete_step, take it away
  const cut = await e.build_model({ action: 'truncate', context_id: whole.context_id, after: 0, include: ['steps'] });
  assert.deepEqual(cut.steps, []);
  const gone = await e.build_model({ action: 'delete_step', context_id: s.context_id, index });
  assert.equal(gone.steps_count, 0);
});
