// A tool schema is read by the host's API before the model sees it, and every API reads a SUBSET of
// JSON Schema: Anthropic's refuses a whole request whose tool schema has a union at its root, OpenAI's
// strict mode refuses `allOf`, `not` and `if/then/else`, and neither documents `oneOf`. What they all
// take is a plain object at the root, and `anyOf`, `enum`, `const`, `$ref` below it.
//
// So every tool takes ONE field, `request` (src/schema/transport.js wireSchema), and a tool with modes
// is an `anyOf` of CLOSED forms under it (src/schema-kit.js): each form exactly its own fields, told
// apart from the others by a pinned value or by the fields it requires — which is what makes the
// `anyOf` mean what a `oneOf` would. These checks hold every schema to that, on the fixture and the
// production catalog.
//
// These are input-validation checks: what the tool accepts and refuses, asserted through the
// validator the server itself uses — not string matching on generated output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { eachSchema, transportSchema } from '../../src/schema/transport.js';
import { buildSchema as eventstreamSchema, querySchema as pathQuerySchema, displaySchema as pathDisplaySchema } from '../../src/retentioneering/schema.js';
import { buildToolDefs } from '../../src/mcp-surface.js';
import { Engine } from '../../src/engine.js';
import { ContextManager } from '../../src/context-manager.js';
import { deref, forms, pinned } from '../helpers/schema-nav.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const PRODUCTION = fileURLToPath(new URL('../../config/catalog.yml', import.meta.url));
const catalog = loadCatalog(CATALOG, {});
const schemas = buildSchemas(catalog);

/** The tool list a client is handed, for a catalog. */
/** Every tool schema of a catalog: the core's, and the retentioneering feature's (built as it registers them). */
const allSchemas = (path) => {
  const c = loadCatalog(path, {});
  return { ...buildSchemas(c), build_retentioneering_model: transportSchema(eventstreamSchema(c)), query_retentioneering_model: transportSchema(pathQuerySchema()), display_retentioneering_result: transportSchema(pathDisplaySchema()) };
};
const listed = (path) => buildToolDefs(new Engine({ catalog: loadCatalog(path, {}), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'portable-')) }) }));

// the constructs outside what every host's API takes — anywhere in a schema, not only at its root
const NOT_PORTABLE = ['oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'discriminator'];

for (const [label, path] of [['fixture', CATALOG], ['production', PRODUCTION]]) {
  test(`every tool takes one field, request, at a root every API takes (${label} catalog)`, () => {
    for (const tool of listed(path)) {
      const s = tool.inputSchema;
      assert.equal(s.type, 'object', `${tool.name}: the root is an object`);
      assert.equal(s.additionalProperties, false, `${tool.name}: the root is closed`);
      assert.deepEqual(s.required, ['request'], `${tool.name}: request is required`);
      assert.deepEqual(Object.keys(s.properties), ['request'], `${tool.name}: request is the one field`);
      for (const k of ['anyOf', ...NOT_PORTABLE]) assert.ok(!(k in s), `${tool.name}: no ${k} at the root`);
      assert.ok(typeof deref(s, s.properties.request).description === 'string', `${tool.name}: request says what it holds`);
    }
  });

  // an answer's schema is listed too: an object at its root, with no union or other construct a host may refuse
  test(`every outputSchema is one object in the portable subset (${label} catalog)`, () => {
    const outputs = listed(path).filter((t) => t.outputSchema);
    assert.ok(outputs.length > 0, 'some tool declares its answer');
    for (const t of outputs) {
      assert.equal(t.outputSchema.type, 'object', `${t.name}: the root is an object`);
      eachSchema(t.outputSchema, (node) => { for (const k of ['anyOf', ...NOT_PORTABLE]) assert.ok(!(k in node), `${t.name}: its answer's schema uses ${k}`); });
    }
  });

  test(`no schema uses a construct outside the portable subset (${label} catalog)`, () => {
    const all = [...listed(path).flatMap((t) => [[t.name, t.inputSchema], ...(t.outputSchema ? [[`${t.name} (output)`, t.outputSchema]] : [])]), ...Object.entries(allSchemas(path))];
    for (const [name, schema] of all) {
      // schema positions only: a field NAMED `then` or `else` (a CASE branch) is a property, not a keyword
      eachSchema(schema, (node) => { for (const k of NOT_PORTABLE) assert.ok(!(k in node), `${name}: a schema node uses ${k}`); });
    }
  });
}

const unionsOf = (doc) => {
  const out = [];
  eachSchema(doc, (node) => { if (Array.isArray(node.anyOf)) out.push(node); });
  return out;
};

/** Whether no value can match both object forms: a field both pin to values that do not meet (and one
 *  of them requires), or a field one requires that the other does not take. */
const apart = (doc, a, b) => {
  for (const k of Object.keys(a.properties || {})) {
    const pa = pinned(doc, a, k); const pb = pinned(doc, b, k);
    if (pa.length && pb.length && !pa.some((v) => pb.includes(v)) && ((a.required || []).includes(k) || (b.required || []).includes(k))) return true;
  }
  const lacks = (x, y) => (x.required || []).some((k) => !(k in (y.properties || {})));
  return lacks(a, b) || lacks(b, a);
};

for (const [label, path] of [['fixture', CATALOG], ['production', PRODUCTION]]) {
  test(`every union of objects is closed, named and told apart — anyOf as strict as oneOf (${label} catalog)`, () => {
    for (const [name, schema] of Object.entries(allSchemas(path))) {
      for (const union of unionsOf(schema)) {
        const branches = union.anyOf.flatMap((b) => forms(schema, b));
        // a union is of FORMS (each a closed object) or of VALUES (a pattern, an enum, a type) — never a
        // bare constraint on fields beside open properties ({ required: [...] }), which no form closes
        for (const b of branches) {
          assert.ok(!(b && b.required && !b.properties), `${name}: a union branch requires fields it does not declare (${JSON.stringify(b)}) — write the modes as closed forms`);
        }
        const objects = branches.filter((b) => b && b.type === 'object' && b.properties);
        if (objects.length < 2) continue;
        for (const [i, b] of objects.entries()) {
          assert.equal(b.additionalProperties, false, `${name}: a form of a union is open — an unknown field would be accepted by SOME form (${b.title || i})`);
        }
        for (let i = 0; i < objects.length; i++) {
          for (let j = i + 1; j < objects.length; j++) {
            assert.ok(apart(schema, objects[i], objects[j]), `${name}: the forms '${objects[i].title || i}' and '${objects[j].title || j}' overlap — an input could match both`);
          }
        }
      }
    }
  });
}

test('a tool with modes names them: every form under request has a title', () => {
  for (const [name, schema] of Object.entries(allSchemas(CATALOG))) {
    for (const f of schema.anyOf ? schema.anyOf.map((b) => deref(schema, b)) : []) assert.ok(f.title, `${name}: a form with no title — a refusal could not name it`);
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
  if (n.$ref) return d + 1; // a $ref counts one level
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
  const bnm = schemas.build_pipeline_model;
  assert.ok(bnm.$defs?.pipeline_stage, 'the stage union is a definition');
  const stageField = forms(bnm, bnm).map((f) => f.properties?.stage).find(Boolean);
  const stagesField = deref(bnm, forms(bnm, bnm).map((f) => f.properties?.stages).find(Boolean));
  assert.equal(deref(bnm, stageField), bnm.$defs.pipeline_stage, 'the stage field points at it');
  assert.equal(deref(bnm, stagesField.items), bnm.$defs.pipeline_stage, 'and so does every item of the list of stages');
});

// The point of the fold is SIZE — what every request carries before a word of the conversation: the
// tool list a client is handed (the tools callable by name only are never in it). The ceiling is
// deliberately loose: it grows with the catalog, and with every name closed as an enum per model (an
// attribute, a joined column) — exactness is worth the bytes. But it is a ceiling: a tool that doubles
// because a description grew unchecked should fail here, not in production.
test('the tool list stays within its size budget on the production catalog', () => {
  const total = JSON.stringify(listed(PRODUCTION)).length;
  assert.ok(total < 260000, `the tool list is ${total} characters — it was ~206k with every form folded and the catalog's names closed per model; something is being dumped into every request again`);
});

test('the card declaration (display) is structural: each kind is a closed branch, and what it needs is enforced by the schema', () => {
  const validators = makeValidators(schemas);
  const check = (display) => validateInput(validators.display_model_result, { task_id: 'abc123abc123', display });
  for (const ok of [
    { kind: 'line', x: 'metric_time_day', y: ['dau', 'wau'] },
    { kind: 'area', x: 'metric_time_day', y: ['dau'], series_column: 'users_platform' },
    { kind: 'bar', x: 'users_country', y: ['revenue'], series_column: 'users_platform', stacked: true },
    { kind: 'pie', label_column: 'users_country', value_column: 'revenue' },
    { kind: 'funnel', steps: [{ column: 'step1' }, { column: 'step2', label: 'Level 1' }] },
    { kind: 'funnel', steps: { label_column: 'step', value_column: 'users' } },
    { kind: 'kpi', values: [{ column: 'revenue', format: 'currency', currency: 'EUR', good: 'up' }] },
    { kind: 'sankey', source_column: 'a', target_column: 'b', value_column: 'n' },
    { kind: 'pivot', levels: [{ column: 'users_country', label: 'Country' }, { column: 'users_platform' }], values: [{ column: 'revenue' }, { column: 'users', agg: 'max', format: 'number' }] },
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
    [{ kind: 'pivot', levels: ['a'], values: [{ column: 'v' }] }, 'a level is { column, label }'],
    [{ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', agg: 'count_distinct' }] }, 'an agg a level cannot fold'],
  ]) assert.equal(check(bad).ok, false, why);
  // the declaration lives on display_model_result alone: no other tool takes one
  assert.equal(validateInput(validators.query_semantic_model, { context_id: 'abc123abc123', metrics: ['m'], display: { kind: 'kpi', values: [{ column: 'm' }] } }).ok, false, 'a query does not draw');
  for (const tool of ['query_semantic_model', 'query_pipeline_model']) assert.equal(validateInput(validators[tool], { task_ids: ['abc123abc123'], display: { kind: 'kpi', values: [{ column: 'm' }] } }).ok, false, `${tool}: reading a result does not draw`);
  // a query tool either starts a query or reads a task back — never both in one call
  assert.equal(validateInput(validators.query_semantic_model, { task_ids: ['abc123abc123'], context_id: 'abc123abc123', metrics: ['m'] }).ok, false, 'task_ids with a query');
  assert.equal(validateInput(validators.query_pipeline_model, { task_ids: ['abc123abc123'], transform: {} }).ok, false, 'task_ids with a transform');
  assert.equal(validateInput(validators.query_pipeline_model, {}).ok, false, 'neither a query nor a task');
  assert.equal(validateInput(validators.query_semantic_model, { task_ids: ['abc123abc123'], offset: 10, wait_seconds: 0 }).ok, true, 'a read may page and look without waiting');
});
