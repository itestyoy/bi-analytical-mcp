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
        if (b.$ref || b.const !== undefined || b.enum !== undefined || b.type === 'string' || b.type === 'number') continue; // a value union, not a shape union
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

// THE DOCUMENTED BUDGETS. A client that rewrites our schema for strict function calling is also
// subject to caps: ~5000 object properties per schema, 10 levels of nesting, 1000 enum values,
// 120 000 characters across property names and enum/const values, and a single enum with more than
// 250 values must stay under 15 000 characters. Our schemas are catalog-derived, so they GROW with
// the deployment's catalog — an events source with 150 payload properties is one enum per view.
// This is the only place that can notice the ceiling before a caller on the other side does, so it
// measures the real production catalog too, not just the fixture.
const BUDGET = { properties: 5000, depth: 10, enumValues: 1000, chars: 120000, bigEnum: 250, bigEnumChars: 15000 };

/** Instance nesting: only properties/items add a level; a union branch is an alternative, not a level. */
const depthOf = (n, d = 0) => {
  if (!n || typeof n !== 'object') return d;
  if (n.$ref) return d + 1; // a recursive $ref (py_block) counts one level, then repeats
  let max = d;
  for (const b of [...(n.anyOf || []), ...(n.oneOf || []), ...(n.allOf || [])]) max = Math.max(max, depthOf(b, d));
  if (n.then) max = Math.max(max, depthOf(n.then, d));
  if (n.properties) for (const v of Object.values(n.properties)) max = Math.max(max, depthOf(v, d + 1));
  if (n.items) max = Math.max(max, depthOf(n.items, d + 1));
  return max;
};

const budgetOf = (schema) => {
  const m = { properties: 0, enumValues: 0, chars: 0, worstEnum: 0, worstEnumChars: 0, depth: depthOf(schema) };
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.enum)) {
      const chars = n.enum.reduce((s, v) => s + String(v).length, 0);
      m.enumValues += n.enum.length; m.chars += chars;
      if (n.enum.length > m.worstEnum) { m.worstEnum = n.enum.length; m.worstEnumChars = chars; }
    }
    if (n.const !== undefined) m.chars += String(n.const).length;
    if (n.properties) {
      const keys = Object.keys(n.properties);
      m.properties += keys.length; m.chars += keys.join('').length;
      for (const k of keys) walk(n.properties[k]);
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'properties' && v && typeof v === 'object') walk(v);
  };
  walk(schema);
  return m;
};

for (const [label, path] of [['fixture', CATALOG], ['production', fileURLToPath(new URL('../../config/catalog.yml', import.meta.url))]]) {
  test(`every tool schema stays inside the documented budgets (${label} catalog)`, () => {
    const tools = buildSchemas(loadCatalog(path, {}));
    for (const [name, schema] of Object.entries(tools)) {
      const m = budgetOf(schema);
      const at = (metric, budget) => `${name}: ${metric} = ${m[metric]}, budget ${budget} (${label} catalog). A catalog this big has to be split or the enums narrowed — a client that rewrites this schema for strict function calling is capped here.`;
      assert.ok(m.properties <= BUDGET.properties, at('properties', BUDGET.properties));
      assert.ok(m.depth <= BUDGET.depth, at('depth', BUDGET.depth));
      assert.ok(m.enumValues <= BUDGET.enumValues, at('enumValues', BUDGET.enumValues));
      assert.ok(m.chars <= BUDGET.chars, at('chars', BUDGET.chars));
      if (m.worstEnum > BUDGET.bigEnum) {
        assert.ok(m.worstEnumChars <= BUDGET.bigEnumChars, `${name}: its largest enum has ${m.worstEnum} values and ${m.worstEnumChars} characters — over ${BUDGET.bigEnum} values the total must stay under ${BUDGET.bigEnumChars}`);
      }
    }
  });
}

// THE FOLD. Repeated subtrees are lifted into `#/$defs` before the schemas leave the process (see
// foldRepeats / foldVocabularies in src/schema.js): with the production catalog the stage union
// alone was ~49 KB of schema handed over twice in one tool, and one source's payload vocabulary
// ~5 KB handed over three times in each of two tools. Nothing a reader sees is lost — the folded
// node keeps its own description — but a ref that does not resolve IS lost, so that is checked
// here, together with the rule that a definition exists only because something repeated.
test('every $ref resolves inside its own tool, and every definition earns its place', () => {
  const refsOf = (node, out = []) => {
    if (Array.isArray(node)) node.forEach((n) => refsOf(n, out));
    else if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') out.push(node.$ref);
      for (const v of Object.values(node)) refsOf(v, out);
    }
    return out;
  };
  const at = (doc, ref) => String(ref).replace(/^#\//, '').split('/').reduce((n, k) => n?.[decodeURIComponent(k)], doc);

  for (const [name, schema] of Object.entries(schemas)) {
    const refs = refsOf(schema);
    for (const ref of refs) {
      assert.match(ref, /^#\//, `${name}: only local refs (${ref})`);
      assert.ok(at(schema, ref) !== undefined, `${name}: ${ref} points at nothing — the client would be handed a hole`);
    }
    for (const key of Object.keys(schema.$defs || {})) {
      const used = refs.filter((r) => r === `#/$defs/${key}`).length;
      assert.ok(used >= 1, `${name}: $defs.${key} is defined and never referenced`);
    }
  }
  // …and the fold actually happened where it was worth it: the stage union is ONE definition that
  // both the single-stage and the list-of-stages field point at.
  const bnm = schemas.build_native_model;
  assert.ok(bnm.$defs?.pipeline_stage, 'the stage union is a definition');
  assert.equal(bnm.properties.stage.$ref, '#/$defs/pipeline_stage');
  assert.equal(bnm.properties.stages.items.$ref, '#/$defs/pipeline_stage');
});

// The point of the fold is SIZE — what every request carries before a word of the conversation.
// The ceiling is deliberately loose (it grows with the catalog), but it is a ceiling: a tool that
// doubles because a description grew unchecked should fail here, not in production.
test('the tool surface stays within its size budget on the production catalog', () => {
  const tools = buildSchemas(loadCatalog(fileURLToPath(new URL('../../config/catalog.yml', import.meta.url)), {}));
  const total = Object.values(tools).reduce((n, s) => n + JSON.stringify(s).length, 0);
  assert.ok(total < 220000, `the tool schemas are ${total} characters — they were ~150k after the fold; something is being dumped into every request again`);
});

test('the card declaration (display) is structural: each kind is a closed branch, and what it needs is enforced by the schema', () => {
  const validators = makeValidators(schemas);
  const check = (display) => validateInput(validators.get_query_result, { query_id: 'abc123abc123', display });
  for (const ok of [
    { kind: 'line', x: 'metric_time_day', y: ['dau', 'wau'] },
    { kind: 'area', x: 'metric_time_day', y: ['dau'], series_column: 'users_platform' },
    { kind: 'bar', x: 'users_country', y: ['revenue'], series_column: 'users_platform', stacked: true },
    { kind: 'pie', label_column: 'users_country', value_column: 'revenue' },
    { kind: 'funnel', steps: [{ column: 'step1' }, { column: 'step2', label: 'Level 1' }] },
    { kind: 'funnel', steps: { label_column: 'step', value_column: 'users' } },
    { kind: 'kpi', values: [{ column: 'revenue', format: 'currency', currency: 'EUR', good: 'up' }] },
    { kind: 'sankey', source_column: 'a', target_column: 'b', value_column: 'n' },
    { kind: 'pivot', levels: ['users_country', 'users_platform'], values: [{ column: 'revenue' }, { column: 'users', agg: 'max', format: 'number' }] },
  ]) assert.equal(check(ok).ok, true, `${JSON.stringify(ok)}: ${check(ok).errors?.join(' | ')}`);
  for (const [bad, why] of [
    [{ kind: 'donut', label_column: 'a', value_column: 'b' }, 'an unknown kind'],
    [{ kind: 'line', x: 'd', y: ['a', 'b'], series_column: 'c' }, 'a split with two value columns'],
    [{ kind: 'bar', x: 'c', y: 'revenue' }, 'y is always a list'],
    [{ kind: 'funnel', label_column: 'step', value_column: 'users' }, 'the row form lives under steps'],
    [{ kind: 'funnel', steps: [{ column: 'only_one' }] }, 'a funnel of one step'],
    [{ kind: 'kpi', values: [{ column: 'r', currency: 'EUR' }] }, 'a currency code without format currency'],
    [{ kind: 'kpi', values: [{ column: 'r', good: 'sideways' }] }, 'good is up or down'],
    [{ kind: 'kpi', values: [1, 2, 3, 4, 5].map((i) => ({ column: `c${i}` })) }, 'more than four tiles'],
    [{ kind: 'pie', label_column: 'a', value_column: 'b', stacked: true }, 'a field of another kind'],
    [{ kind: 'pivot', levels: ['a', 'a'], values: [{ column: 'v' }] }, 'a level twice'],
    [{ kind: 'pivot', levels: ['a'], values: [{ column: 'v', agg: 'count_distinct' }] }, 'an agg a level cannot fold'],
  ]) assert.equal(check(bad).ok, false, why);
  // a drill-down reads a stored result: a metric query declaring one must materialize
  const q = (extra) => validateInput(validators.query_semantic_model, { context_id: 'abc123abc123', metrics: ['m'], display: { kind: 'pivot', levels: ['a'], values: [{ column: 'm' }] }, ...extra });
  assert.equal(q({}).ok, false, 'pivot without materialize');
  assert.equal(q({ materialize: true }).ok, true, `pivot with materialize: ${q({ materialize: true }).errors?.join(' | ')}`);
});
