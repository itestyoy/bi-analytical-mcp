// INPUT-VALIDATION GUARD (the one non-data test kind the project rules allow): every tool schema
// must COMPILE, for any catalog shape the schema language itself admits — not just the well-stocked
// fixture. `enum: []` and `oneOf: []` are invalid JSON Schema, ajv refuses them, and because the
// Engine compiles every tool schema in its constructor, one empty vocabulary means the SERVER DOES
// NOT START. The catalogs below are the shapes that produce empty vocabularies.
//
// Nothing here asserts what a schema ACCEPTS — that is proven by the refusal/acceptance tests and,
// for behaviour, by the warehouse runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { assertSchemaSound } from '../../src/schema-kit.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';

const engineFor = (yaml) => {
  const dir = mkdtempSync(join(tmpdir(), 'snd-'));
  const file = join(dir, 'catalog.yml');
  writeFileSync(file, yaml);
  const catalog = loadCatalog(file, {});
  return { catalog, engine: new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: dir }) }) };
};

const EVENTS = (extra = '') => `  - name: fct_events
    meta:
      mcp: { role: events, primary_entity: event, known_events: [login] }
    columns:
${extra}      - { name: ts, data_type: timestamp, meta: { mcp: { is_time: true } } }
      - { name: event_name, data_type: string, meta: { mcp: { is_event_name: true } } }
`;
const USER_KEY = '      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: foreign } } } }\n';

// An events source with no relationship at all: nothing to partition a funnel BY, by name.
const NO_RELATIONSHIPS = `version: 2
models:
${EVENTS('      - { name: event_id, data_type: string }\n')}  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
      - { name: country, data_type: string }
`;

// A dimension model carrying ONLY its key: a real shape (attributes arrive later), and one with
// no groupable column to offer.
const NO_DIMENSIONS = `version: 2
models:
${EVENTS(USER_KEY)}  - name: dim_users
    meta: { mcp: { role: users } }
    columns:
      - { name: user_id, data_type: string, meta: { mcp: { entity: { name: user, type: primary } } } }
`;

test('every tool schema compiles for a catalog whose sources declare no relationship', () => {
  const { engine } = engineFor(NO_RELATIONSHIPS); // constructing the Engine IS the compile
  assert.ok(engine.schemas.build_native_model, 'the pipeline tool is still offered');
});

test('every tool schema compiles for a model with no groupable dimension', () => {
  const { catalog, engine } = engineFor(NO_DIMENSIONS);
  assert.deepEqual(catalog.modelDimensionColumns('users'), []);
  // the branch exists, minus the field there is nothing to fill in
  const branch = engine.schemas.create_semantic_model.properties.semantic_models.items.oneOf
    .find((b) => b.properties?.from?.const === 'users');
  assert.ok(branch, 'the users model can still carry a semantic model');
  assert.equal(branch.properties.dimensions, undefined, 'no dimension to add → no field to fill in');
  assert.ok(branch.properties.measures, 'measures are unaffected');
});

// The backstop: whatever the catalog, no built schema may carry an empty enum/oneOf/anyOf/allOf.
test('no shipped or degenerate catalog produces an empty enum or choice anywhere', () => {
  const shipped = ['config/catalog.yml', 'test/integration/fixtures/catalog.yml']
    .map((p) => fileURLToPath(new URL(`../../${p}`, import.meta.url)))
    .map((p) => loadCatalog(p, {}));
  const degenerate = [NO_RELATIONSHIPS, NO_DIMENSIONS].map((y) => {
    const f = join(mkdtempSync(join(tmpdir(), 'snd-')), 'catalog.yml');
    writeFileSync(f, y);
    return loadCatalog(f, {});
  });
  for (const catalog of [...shipped, ...degenerate]) {
    for (const [tool, schema] of Object.entries(buildSchemas(catalog))) {
      assert.deepEqual(assertSchemaSound(schema, `#/${tool}`), [], `${tool} carries an empty construct`);
    }
  }
});
