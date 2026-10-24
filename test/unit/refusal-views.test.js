// A REFUSAL OF A LIST OF FORMS (src/validate.js explain): a { views } or { queries } request whose item is
// wrong is refused as that list's form, at the item — the value's own fields decide which form it meant,
// before whatever is wrong inside them, so an item's extra field never reads as "`views` is not a field".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { tempDir } from '../helpers/temp-dir.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const engine = () => new Engine({ resultCards: true, catalog: loadCatalog(CATALOG), contextManager: new ContextManager({ workspaceRoot: tempDir('refusal-views') }) });
const refusal = (e, tool, input) => { try { e._validate(tool, input); return null; } catch (err) { return err.message; } };

test('semantic_index({ views }): an item with a field its view does not take is refused at that item', async () => {
  const e = engine();
  await assert.rejects(() => e.semantic_index({ views: [{ source: 'users', fuzzy: true }, { source: 'events' }] }), (err) => {
    assert.match(err.message, /`views\.0` has an unexpected property 'fuzzy' — \{ source \} takes source/);
    assert.doesNotMatch(err.message, /unexpected property 'views'/);
    assert.doesNotMatch(err.message, /overview \(an empty request\) takes no fields/);
    return true;
  });
  const second = refusal(e, 'semantic_index', { views: [{ source: 'events', event: 'ad_finished' }, { source: 'users', fuzzy: true }] });
  assert.match(second, /`views\.1` has an unexpected property 'fuzzy' — \{ source \} takes source/);
  assert.doesNotMatch(second, /unexpected property 'views'/);
  const event = refusal(e, 'semantic_index', { views: [{ source: 'events', event: 'ad_finished', limit: 5 }, { source: 'users' }] });
  assert.match(event, /`views\.0` has an unexpected property 'limit' — \{ source, event \} takes source, event/);
});

test('semantic_index({ views }): an item that is not a drill-in view is refused at that item', () => {
  const e = engine();
  for (const item of [{ status: true }, { guide: true }]) {
    const msg = refusal(e, 'semantic_index', { views: [item, { source: 'users' }] });
    assert.match(msg, new RegExp(`\`views\\.0\` has an unexpected property '${Object.keys(item)[0]}'`));
    assert.match(msg, /`views\.0` must be exactly one of: \{ source \}/);
    assert.doesNotMatch(msg, /unexpected property 'views'/);
  }
});

test('a field the value gives at its own level still decides first', () => {
  const e = engine();
  // a single view keeps its refusal: fuzzy is not a field of { source }
  assert.match(refusal(e, 'semantic_index', { source: 'users', fuzzy: true }), /request has an unexpected property 'fuzzy' — \{ source \} takes source/);
  // a model with a paging field beside it meant the column view, and is told which column it lacks
  assert.match(refusal(e, 'semantic_index', { source: 'users', limit: 5 }), /request is missing required property 'column' — one of: .*country/);
  // a misspelt column is refused within the { source, column } form, not as a stray field of { source }
  const misspelt = refusal(e, 'semantic_index', { source: 'users', column: 'countryy' });
  assert.match(misspelt, /`column` must be one of: .*Did you mean 'country'\?/);
  assert.doesNotMatch(misspelt, /\{ source \} takes source/);
  // a field beside views is said as the { views } form's own
  const beside = refusal(e, 'semantic_index', { views: [{ source: 'users' }, { source: 'events' }], limit: 5 });
  assert.match(beside, /request has an unexpected property 'limit' — \{ views \} takes views/);
});

test('a batch of queries with one bad item is refused at that item, not as a single query', () => {
  const e = engine();
  for (const tool of ['query_model', 'query_model']) {
    const item = tool === 'query_model' ? { steps: [{ stage: 'metrics', metrics: ['x'] }] } : { steps: [{ stage: 'limit', limit: 5 }] };
    const msg = refusal(e, tool, { context_id: 'abc123', queries: [{ ...item, bogus: 1 }, item] });
    assert.match(msg, /`queries\.0` has an unexpected property 'bogus'/, tool);
    assert.doesNotMatch(msg, /unexpected property 'queries'/, tool);
  }
});

test('a field only one form takes, with a wrong value, is refused as that form, not as unknown to the default one', () => {
  const e = engine();
  const msg = refusal(e, 'context', { action: 'delete', context_id: 'abc123', semantic_model: 12345 });
  assert.match(msg, /`semantic_model` must be string/);
  assert.match(msg, /missing required property 'what'/);
  assert.doesNotMatch(msg, /unexpected property 'semantic_model'/);
});

// A field written as another tool spells it (CROSS_PATH_SPELLING) stands for the field a form calls
// it: { model } meant the { source } view, and the refusal names the field there — not "the overview
// takes no fields", which every form with one unknown field would otherwise tie with and the empty one win.
test('a field in another path\'s spelling is refused as the form that names it, with its name there', () => {
  const e = engine();
  for (const input of [{ model: 'users' }, { model: 'users', column: 'country' }, { model: 'users', property: 'country' }]) {
    const msg = refusal(e, 'semantic_index', input);
    assert.match(msg, /request has an unexpected property 'model' — here that field is called 'source'/, JSON.stringify(input));
    assert.doesNotMatch(msg, /overview \(an empty request\) takes no fields/, JSON.stringify(input));
    // the field it stands for is not reported missing as well
    assert.doesNotMatch(msg, /missing required property 'source'/, JSON.stringify(input));
  }
  // a model's column named as an event property is named too: there it is `column`
  assert.match(refusal(e, 'semantic_index', { model: 'users', property: 'country' }), /unexpected property 'property' — here that field is called 'column'/);
  assert.match(refusal(e, 'semantic_index', { source: 'users', property: 'country' }), /unexpected property 'property' — here that field is called 'column'/);
  // …and only where `column` takes the name: an event property stays `property`
  assert.equal(refusal(e, 'semantic_index', { source: 'events', property: 'result_of_event_data' }), null);
});

// …and only where that field means the same thing. explore_errors' `source` is where an error came from
// (tool | task | startup), not a catalog model: { model: 'events' } there is refused as a field the page
// of errors does not take, not sent on to `source: 'events'`, which would be refused next.
test('a field in another path\'s spelling is told its name only where that field takes the value written', () => {
  const e = engine();
  const errors = refusal(e, 'explore_errors', { model: 'events' });
  assert.match(errors, /request has an unexpected property 'model' — a page of errors takes time_range, source,/);
  assert.doesNotMatch(errors, /here that field is called 'source'/);
  // where `source` names a catalog model, the same spelling is told its name — a view, a note's about, a pipeline
  assert.match(refusal(e, 'semantic_index', { model: 'events' }), /request has an unexpected property 'model' — here that field is called 'source'/);
  assert.match(refusal(e, 'memory', { action: 'record', notes: [{ note: 'x', about: [{ model: 'users', column: 'country' }] }] }), /`notes\.0\.about\.0` has an unexpected property 'model' — here that field is called 'source'/);
  assert.match(refusal(e, 'build_model', { name: 'm', model: 'events', steps: [{ stage: 'limit', limit: 1 }] }), /request has an unexpected property 'model' — here that field is called 'source'/);
});

// A list a tool runs in order is `steps` (one of them `step`), in every builder and query tool: the
// earlier `stages` / `stage` is told its name where that name is taken — and only there, so a stage's
// own `stage` tag, and a form with no list of steps, are refused as they were.
test('stages and stage are told their name, steps and step, where the form takes it', () => {
  const e = engine();
  const limit = { stage: 'limit', limit: 1 };
  for (const [tool, input, field] of [
    ['build_model', { action: 'add_steps', context_id: 'abc123', stages: [limit] }, 'stages'],
    ['build_model', { name: 'started', source: 'events', stages: [limit] }, 'stages'],
    ['build_model', { action: 'edit_step', context_id: 'abc123', index: 1, stage: limit }, 'stage'],
    ['build_model', { action: 'edit_step', context_id: 'abc123', index: 1, stage: limit }, 'stage'],
    ['query_model', { context_id: 'abc123', stages: [limit] }, 'stages'],
    ['query_model', { context_id: 'abc123', stages: [{ stage: 'metrics', metrics: ['x'] }, limit] }, 'stages'],
  ]) {
    const msg = refusal(e, tool, input);
    assert.match(msg, new RegExp(`request has an unexpected property '${field}' — here that field is called '${field === 'stages' ? 'steps' : 'step'}'`), `${tool} ${JSON.stringify(input)}`);
  }
  // in a batch, at the query that wrote it
  assert.match(refusal(e, 'query_model', { context_id: 'abc123', queries: [{ stages: [limit] }] }), /`queries\.0` has an unexpected property 'stages' — here that field is called 'steps'/);
  // a step's own tag is its kind, never the field's earlier name
  assert.equal(refusal(e, 'build_model', { action: 'add_steps', context_id: 'abc123', steps: [limit] }), null);
  // where no list of steps is taken, `stages` is a field the form does not take — no name to tell
  const drill = refusal(e, 'drill_result', { task_id: 'abcdef123456', stages: [limit] });
  assert.match(drill, /unexpected property 'stages'/);
  assert.doesNotMatch(drill, /here that field is called/);
  // and the earlier name and the current one together are not one list told twice: the earlier is refused
  assert.match(refusal(e, 'query_model', { context_id: 'abc123', steps: [limit], stages: [limit] }), /unexpected property 'stages'/);
});

// A form pinned to one source is further off than the form of the source named that lacks a field:
// a stray field beside a users column is said as that, not as "`source` must be events".
test('a field a source\'s form does not take is refused as that source\'s form, not steered to another source', () => {
  const e = engine();
  const msg = refusal(e, 'semantic_index', { source: 'users', column: 'country', include: ['coverage'] });
  assert.match(msg, /request has an unexpected property 'include' — \{ source, column \} takes source, column, limit, offset, order_by, recent/);
  assert.doesNotMatch(msg, /`source` must be "events"/);
});
