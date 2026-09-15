// A tool schema is read by TWO kinds of client, and only one of them reads all of JSON Schema.
//
// An MCP client that passes the schema through keeps everything. A client that rewrites it for
// OpenAI-style function calling keeps a SUBSET: a union at the ROOT is not in it, so such a client
// drops the union — and if the root had nothing but the union, the model is shown an object with no
// fields at all. That is how "the server demanded `source` and it was not in the schema" happens on
// a schema where `source` is declared in every branch that takes it.
//
// So the shape of every tool's input is a flat root `properties` map (what survives the rewrite)
// PLUS the union (what narrows it, for clients that keep it). The union's branches must be CLOSED,
// which is what makes `anyOf` reject exactly what `oneOf` would.
//
// These are input-validation checks: what the tool accepts and refuses, asserted through the
// validator the server itself uses — not string matching on generated output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const schemas = buildSchemas(catalog);

// The two tools that genuinely take no input; everything else has to name its fields.
const NO_PARAMS = new Set(['list_contexts', 'list_query_jobs']);

const unionsOf = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => unionsOf(n, out));
  else if (node && typeof node === 'object') {
    for (const key of ['anyOf', 'oneOf']) if (Array.isArray(node[key])) out.push({ key, branches: node[key], owner: node });
    for (const v of Object.values(node)) unionsOf(v, out);
  }
  return out;
};

test('every tool declares its fields at the ROOT, so a client that strips unions still sees them', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.type, 'object', `${name}: the root of a tool input must be an object`);
    const props = Object.keys(schema.properties || {});
    if (NO_PARAMS.has(name)) continue;
    assert.ok(props.length > 0, `${name}: the root has no properties — a client that drops root unions would show the model an object with no fields`);
  }
});

test('a schema stripped to the function-calling subset still names every field its tool needs', () => {
  // What such a client keeps: type/properties/required/enum/description. What it drops here:
  // anyOf/oneOf/allOf/if/then/not at the root. After that the fields must still be there.
  const strip = (schema) => {
    const { anyOf, oneOf, allOf, if: _if, then: _then, not, ...rest } = schema;
    return rest;
  };
  for (const [name, schema] of Object.entries(schemas)) {
    if (NO_PARAMS.has(name)) continue;
    const stripped = strip(schema);
    assert.ok(Object.keys(stripped.properties || {}).length > 0, `${name}: nothing left to call the tool with`);
    assert.ok(typeof stripped.description === 'string' && stripped.description.length > 0, `${name}: no description left to say how the fields combine`);
  }
  // semantic_index is the one this was found on: the fields of its views must be in that map.
  const si = strip(schemas.semantic_index).properties;
  for (const f of ['source', 'event', 'property', 'model', 'search', 'recipe', 'guide', 'status', 'run', 'limit']) {
    assert.ok(si[f], `semantic_index: '${f}' is not visible without the union`);
  }
  // …and a name is STILL not offered without its owner: no source-less enum of event names.
  assert.ok(!si.event.enum, 'event names must not be enumerated outside their source');
  assert.ok(!si.property.enum, 'property names must not be enumerated outside their source');
  assert.deepEqual(si.source.enum, catalog.modelKeys(), 'the root `source` is the list of sources');
});

test('every union branch is closed and named, which is what makes anyOf as strict as oneOf', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    for (const { key, branches } of unionsOf(schema)) {
      for (const [i, b] of branches.entries()) {
        if (b.$ref || b.const !== undefined || b.type === 'string' || b.type === 'number') continue; // a value union, not a shape union
        if (b.type !== 'object') continue;
        assert.equal(b.additionalProperties, false, `${name}: ${key}[${i}] is an open object branch — an unknown field would be accepted by SOME branch`);
      }
    }
  }
  // A refusal has to be able to NAME the modes. Two ways to make that possible, and a root union
  // must use one: a `title` per branch (semantic_index), or a `discriminator` field whose value
  // picks the branch (ab_test / sample_size pick on `metric`), which ajv reports by itself.
  for (const tool of ['semantic_index', 'memory', 'ab_test', 'sample_size']) {
    const root = schemas[tool];
    const branches = root.anyOf || root.oneOf || [];
    assert.ok(branches.length > 1, `${tool}: expected a root union`);
    const tagged = !!root.discriminator;
    for (const [i, b] of branches.entries()) {
      assert.ok(b.title || tagged, `${tool}: root branch ${i} is neither titled nor picked by a discriminator`);
    }
  }
});

// The narrowing must still REFUSE what it refused before the union was renamed — including the
// call that started this: a name passed without its source.
test('semantic_index accepts one view at a time and refuses a name without its source', () => {
  const validators = makeValidators(schemas);
  const check = (input) => validateInput(validators.semantic_index, input);

  for (const ok of [
    {},
    { model: 'events' },
    { source: 'events', event: 'first_launch' },
    { source: 'events', property: 'level_id_of_event_data', limit: 5 },
    { search: 'retention' },
    { status: true },
    { guide: true },
    { recipe: 'ratio_metric' },
  ]) assert.equal(check(ok).ok, true, `should accept ${JSON.stringify(ok)}: ${JSON.stringify(check(ok).errors)}`);

  const noSource = check({ event: 'first_launch' });
  assert.equal(noSource.ok, false, 'an event name alone is not an address');
  const text = noSource.errors.join(' | ');
  assert.match(text, /source/, 'the refusal must name the field that is missing');
  assert.match(text, /\{ source, event \}/, 'and the mode the caller was closest to');

  for (const bad of [
    { property: 'level_id_of_event_data' },            // same, for a column
    { source: 'events' },                              // a source alone is not a view
    { model: 'events', limit: 5 },                     // limit does not apply to { model }
    { model: 'events', search: 'x' },                  // two views at once
    { source: 'events', event: 'no_such_event' },      // a name that source does not declare
    { source: 'users', event: 'first_launch' },        // an events name on a non-events source
  ]) assert.equal(check(bad).ok, false, `should refuse ${JSON.stringify(bad)}`);
});
