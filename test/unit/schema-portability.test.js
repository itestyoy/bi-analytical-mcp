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
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { buildSchemas, TOOL_PLACES } from '../../src/schema.js';
import { makeValidators, validateInput } from '../../src/validate.js';
import { eachSchema, transportSchema } from '../../src/schema/transport.js';
import { PLACES, AGGREGATE_FNS } from '../../src/pipeline/compute.js';
import { STAGE_PLACES, stageDef } from '../../src/pipeline.js';
import { REF_PLACES, refKind } from '../../src/schema/refs.js';
import { buildSchema as eventstreamSchema, querySchema as pathQuerySchema, displaySchema as pathDisplaySchema, FILTER_PLACE, LIBRARY_STEPS } from '../../src/retentioneering/schema.js';
import { buildToolDefs } from '../../src/mcp-surface.js';
import { Engine } from '../../src/engine.js';
import { ContextManager } from '../../src/context-manager.js';
import { deref, forms, pinned } from '../helpers/schema-nav.js';
import { tempDir } from '../helpers/temp-dir.js';

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
const listed = (path) => buildToolDefs(new Engine({ catalog: loadCatalog(path, {}), contextManager: new ContextManager({ workspaceRoot: tempDir('portable') }) }));

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
    { source: 'events' },
    { source: 'users' },
    { source: 'events', event: 'first_launch' },
    { source: 'events', property: 'level_id_of_event_data', limit: 5 },
    { source: 'users', column: 'country', limit: 5 },
    { source: 'events', column: 'event_name' },
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
    { property: 'level_id_of_event_data' },            // same, for an event property
    { column: 'country' },                             // and for a model's column
    { source: 'users', property: 'country' },          // a model's column is `column`, not an event property
    { source: 'events', column: 'level_id_of_event_data' }, // and an event's payload is `property`
    { model: 'events' },                               // the model view is { source }
    { source: 'events', fuzzy: true },                 // fuzzy does not apply to { source }
    { source: 'events', search: 'x' },                 // two views at once
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
  // both the one-step field and the list of steps point at.
  const bnm = schemas.build_model;
  assert.ok(bnm.$defs?.stage, 'the stage union is a definition');
  const stepField = forms(bnm, bnm).map((f) => f.properties?.step).find(Boolean);
  const stepsField = deref(bnm, forms(bnm, bnm).map((f) => f.properties?.steps).find(Boolean));
  assert.equal(deref(bnm, stepField), bnm.$defs.stage, 'the step field points at it');
  assert.equal(deref(bnm, stepsField.items), bnm.$defs.stage, 'and so does every item of the list of steps');
  // the steps are the one stage definition in both query tools, built for their places: a pipeline read's,
  // and a metric query's — its where steps, its metrics step and the read after it
  for (const tool of ['query_model', 'query_model']) {
    const s = schemas[tool];
    const steps = deref(s, forms(s, s).map((f) => f.properties?.steps).find(Boolean));
    assert.equal(deref(s, steps.items), s.$defs.stage, `${tool}: every step is the one stage`);
  }
});

// ONE DEFINITION PER CONCEPT, IN EVERY TOOL: an expression is `$defs.expr` (and, where a place takes a
// closed part of it, a kind of its own: a semantic measure's `$defs.aggregate`, a derived metric's
// `$defs.metric_expr` — src/pipeline/compute.js EXPR_KINDS), a window `$defs.over` (a window function's;
// `$defs.over_frame` an aggregate over a window's, with its frame), a step `$defs.stage`, a
// name of a thing of the catalog or the semantic layer `$defs.ref` — the same name in each tool that takes
// one, built for that tool's places, never a definition per place beside it (where two places of one kind
// take different parts, each narrows the one definition as the value is built).
test('each tool schema holds one expr of each kind, its window, one stage and one ref where it takes them, and no definition per place', () => {
  const all = allSchemas(CATALOG);
  const takes = {
    build_model: ['expr', 'aggregate', 'metric_expr', 'over', 'over_frame', 'stage'],
    'build_model.pipeline': ['expr', 'aggregate', 'metric_expr', 'over', 'over_frame', 'stage'],
    query_model: ['expr', 'over', 'over_frame', 'stage', 'ref'],
    semantic_index: ['ref'],
    memory: ['ref'],
    build_retentioneering_model: ['expr', 'stage'],
  };
  const PER_PLACE = ['pipeline_stage', 'read_stage', 'eventstream_stage', 'read_expr', 'eventstream_expr'];
  for (const [name, schema] of Object.entries(all)) {
    const defs = schema.$defs || {};
    for (const gone of PER_PLACE) assert.equal(defs[gone], undefined, `${name}: $defs.${gone} — a definition per place`);
    for (const concept of ['expr', 'aggregate', 'metric_expr', 'over', 'over_frame', 'stage', 'ref']) {
      assert.equal(concept in defs, (takes[name] || []).includes(concept), `${name}: $defs.${concept} ${(takes[name] || []).includes(concept) ? 'missing' : 'unexpected'}`);
    }
  }
  // the stage is grouped by what a step needs — SQL over rows, over a source's events, on a runtime, in
  // the semantic layer — and each group's forms are tagged by `stage`; a tool's holds the groups its
  // places take (a group left empty is left out): a metric query's steps are a read's and its metrics
  // step, which no other tool offers; the retentioneering tool takes no SQL stage (the rows are prepared
  // by build_model, read from its task): its library's ops are its one group, the runtime's
  const groups = (schema) => deref(schema, schema.$defs.stage).anyOf.map((g) => deref(schema, g).title);
  const SQL = 'SQL over rows — needs a table';
  const RUNTIME = 'on a runtime, not SQL — needs its runtime, after SQL has prepared the rows';
  const SEMANTIC = 'in the semantic layer — needs MetricFlow';
  assert.deepEqual(groups(all.build_model), [SQL, 'over a source\'s events — needs the rows still that source\'s events', SEMANTIC], 'a build\'s: its stages, and its last step, the semantic layer over them');
  assert.deepEqual(groups(all.query_model), [SQL, SEMANTIC], 'a metric query\'s: a read\'s, and its metrics step');
  const semanticGroup = deref(all.query_model, all.query_model.$defs.stage).anyOf.map((g) => deref(all.query_model, g)).find((g) => g.title === SEMANTIC);
  assert.deepEqual(forms(all.query_model, semanticGroup).flatMap((f) => pinned(all.query_model, f, 'stage')), ['metrics']);
  assert.deepEqual(groups(all.build_retentioneering_model), [RUNTIME]);
  // the ref is grouped by what it names: the catalog, the semantic layer — a tool's holding what its places take
  const refGroups = (schema) => deref(schema, schema.$defs.ref).anyOf.map((g) => deref(schema, g).title.split(':')[0]);
  assert.deepEqual(refGroups(all.query_model), ['the catalog', 'the semantic layer'], 'a metric query groups by a column, a property and the semantic layer\'s names');
  for (const tool of ['semantic_index', 'memory']) assert.deepEqual(refGroups(all[tool]), ['the catalog'], `${tool}: a view and a note's about name things of the catalog`);
});

// …and each of them holds what the tool's PLACES take, and nothing else (src/schema.js TOOL_PLACES:
// where its expressions stand, where its steps run, where it names a thing). A form no place of the tool
// takes would be shown to the model only to be refused when the value is built — and carried in every
// request. Each form is read for what it is — a leaf by the fields it requires, a function by the `fn` it
// pins, a window by its `over` (and its partition by a relationship, by `entity`), a step by its `stage`, a
// ref by its fields — and held to the tables the
// build-time checks read (PLACES, STAGE_PLACES, REF_PLACES). The retentioneering tool's places are its
// own: filter_events' where (conditions over the eventstream's columns), its library's ops its runtime
// group and no stage of the pipeline.
for (const [label, path] of [['fixture', CATALOG], ['production', PRODUCTION]]) {
  test(`each tool's $defs.expr, $defs.stage and $defs.ref offer no form none of its places take (${label} catalog)`, () => {
    const c = loadCatalog(path, {});
    const tools = [
      ...listed(path).map((t) => [t.name, t.inputSchema, TOOL_PLACES[t.name] || {}]),
      ['build_model.pipeline', transportSchema(buildSchemas(c)['build_model.pipeline']), TOOL_PLACES.build_model],
      ['build_retentioneering_model', transportSchema(eventstreamSchema(c)), { expr: [FILTER_PLACE], stage: [LIBRARY_STEPS] }],
    ];
    const placesIn = (table, names = []) => names.map((p) => (typeof p === 'string' ? table[p] : p));
    // what a form names, by the fields it requires: a ref ({ source, column } is no { column }), or a row's leaf
    const kindOf = (f) => refKind(Object.fromEntries((f.required || []).map((k) => [k, true]))) || f.required?.[0];
    for (const [name, doc, places] of tools) {
      const defs = doc.$defs || {};
      const expr = placesIn(PLACES, places.expr);
      const stage = placesIn(STAGE_PLACES, places.stage);
      const ref = placesIn(REF_PLACES, places.ref);
      // the closed kinds of the expression: a semantic measure (ONE aggregate), a derived metric's value
      const kinds = { aggregate: placesIn(PLACES, places.aggregate), metric_expr: placesIn(PLACES, places.metric_expr) };
      // a definition is there where the tool has a place for it, and only there — the window where a
      // place of its row expression takes one
      for (const [concept, ps] of [['expr', expr], ['stage', stage], ['ref', ref], ...Object.entries(kinds), ['over', expr.filter((p) => p.windows)], ['over_frame', expr.filter((p) => p.windows)]]) {
        assert.equal(concept in defs, ps.length > 0, `${name}: $defs.${concept} ${ps.length ? 'missing' : 'with no place of the tool to take it'}`);
      }
      for (const [kind, ps] of [['expr', expr], ...Object.entries(kinds)]) {
        for (const f of defs[kind] ? forms(doc, defs[kind]) : []) {
          const fns = pinned(doc, f, 'fn');
          if (!fns.length) assert.ok(kind !== 'aggregate' && ps.some((p) => p.leaves.includes(kindOf(f))), `${name}: the leaf ${f.title} in $defs.${kind} — no place of that kind takes it`);
          for (const fn of fns) assert.ok(ps.some((p) => p.fns.includes(fn)), `${name}: ${fn} (${f.title}) in $defs.${kind} — no place of that kind takes it`);
          // a measure is ONE aggregate, folding rows; where measures are their own kind, the rows take none
          if (kind === 'aggregate') assert.ok(fns.every((fn) => AGGREGATE_FNS.includes(fn)) && !f.properties?.over, `${name}: ${f.title} — a measure is an aggregate folding rows`);
          // (a tool whose rows also fold — a build's aggregate stage — keeps them in its row expression)
          if (kind === 'expr' && kinds.aggregate.length && !expr.some((p) => p.fns.some((fn) => AGGREGATE_FNS.includes(fn)))) assert.ok(!fns.some((fn) => AGGREGATE_FNS.includes(fn)), `${name}: ${f.title} — an aggregate in the row expression of a tool whose measures are their own kind`);
          if (f.properties?.over) {
            assert.ok(ps.some((p) => p.windows), `${name}: a window (${f.title}) — no place of the tool takes one`);
            // a window function reads its partition whole; an aggregate over a window also a frame of it
            const framed = fns.some((fn) => AGGREGATE_FNS.includes(fn));
            assert.equal(deref(doc, f.properties.over), framed ? defs.over_frame : defs.over, `${name}: ${f.title} — its window is $defs.${framed ? 'over_frame' : 'over'}`);
            // a window restarts per a declared relationship { entity } only over a source's rows (an
            // { entity } of the ref, after a metrics step, names the result's column a group_by item gave)
            const partition = deref(doc, deref(doc, f.properties.over).properties?.partition_by);
            const items = partition?.items?.anyOf ? partition.items.anyOf.filter((i) => i.$ref !== '#/$defs/ref') : [partition?.items];
            const byEntity = items.flatMap((i) => forms(doc, i)).some((item) => item?.properties?.entity);
            if (byEntity) assert.ok(ps.some((p) => p.entities), `${name}: a window partitioned by { entity } (${f.title}) — no place of the tool reads a source's rows`);
          }
        }
      }
      for (const f of defs.stage ? forms(doc, defs.stage) : []) {
        const [s] = pinned(doc, f, 'stage');
        // a step tagged by no stage is a feature's runtime group (its library's ops, tagged by `type`), in its own tool alone
        if (s === undefined) {
          assert.ok(name === 'build_retentioneering_model' && pinned(doc, f, 'type').length, `${name}: a step tagged by no stage (${f.title})`);
          continue;
        }
        // (a place that lists no stages takes every stage of the registry; a step no stage of it is — the
        // metrics step — is there only where a place of the tool offers it)
        assert.ok(stage.some((p) => (p.stages ? p.stages.includes(s) : stageDef(s) !== null || (p.offers || []).some((o) => o.stage === s))), `${name}: the ${s} stage — no place of the tool takes it`);
        if (!stageDef(s)) assert.ok(stage.some((p) => (p.offers || []).some((o) => o.stage === s)), `${name}: the ${s} step — no place of the tool offers it`);
      }
      for (const f of defs.ref ? forms(doc, defs.ref) : []) {
        assert.ok(ref.some((p) => p.takes.includes(kindOf(f))), `${name}: the ref ${f.title} — no place of the tool takes it`);
        if (f.properties?.via) assert.ok(ref.some((p) => p.via), `${name}: via on ${f.title} — no place of the tool reads a relationship`);
      }
    }
  });
}

// The point of the fold is SIZE — what every request carries before a word of the conversation: the
// tool list a client is handed (the tools callable by name only are never in it). The ceiling is
// deliberately loose: it grows with the catalog, and with every name closed as an enum per model (an
// attribute, a joined column) — exactness is worth the bytes. But it is a ceiling: a tool that doubles
// because a description grew unchecked should fail here, not in production.
test('the tool list stays within its size budget on the production catalog', () => {
  const total = JSON.stringify(listed(PRODUCTION)).length;
  assert.ok(total < 260000, `the tool list is ${total} characters — it was ~206k with every form folded and the catalog's names closed per model; something is being dumped into every request again`);
});

test('the card declaration (display) is structural: each kind is a closed branch, and what it needs is enforced by the schema', async () => {
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
    { kind: 'pivot', levels: [{ column: 'users_country', label: 'Country' }, { column: 'users_platform' }], values: [{ column: 'revenue' }, { column: 'users', fn: 'max', format: 'number' }] },
    // a pivot value is written as a KPI tile is: a currency goes with format currency
    { kind: 'pivot', levels: [{ column: 'users_country' }], values: [{ column: 'revenue', format: 'currency', currency: 'EUR' }, { column: 'payers', fn: 'count_distinct', format: 'percent' }] },
    // a view folds with an aggregate function, but for the percentile and a sketch's making: a median, a sketch merged
    { kind: 'bar', x: 'users_country', y: ['revenue'], drill: { levels: [{ column: 'users_platform', label: 'Platform' }], fn: 'median' } },
    { kind: 'pivot', levels: [{ column: 'users_country' }], values: [{ column: 'users_sketch', fn: 'hll_merge' }] },
  ]) assert.equal(check(ok).ok, true, `${JSON.stringify(ok)}: ${check(ok).errors?.join(' | ')}`);
  for (const [bad, why] of [
    [{ kind: 'donut', label_column: 'a', value_column: 'b' }, 'an unknown kind'],
    [{ kind: 'bar', x: 'c', y: 'revenue' }, 'y is always a list'],
    [{ kind: 'funnel', label_column: 'step', value_column: 'users' }, 'the row form lives under steps'],
    [{ kind: 'funnel', steps: [{ column: 'only_one' }] }, 'a funnel of one step'],
    [{ kind: 'kpi', values: [{ column: 'r', currency: 'EUR' }] }, 'a currency code without format currency'],
    [{ kind: 'kpi', values: [{ column: 'r', good: 'sideways' }] }, 'good is up or down'],
    [{ kind: 'kpi', values: [1, 2, 3, 4, 5].map((i) => ({ column: `c${i}` })) }, 'more than four tiles'],
    [{ kind: 'pie', label_column: 'a', value_column: 'b', stacked: true }, 'a field of another kind'],
    [{ kind: 'pivot', levels: ['a'], values: [{ column: 'v' }] }, 'a level is { column, label }'],
    [{ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', fn: 'percentile' }] }, 'a percentile names no quantile here'],
    [{ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', fn: 'hll_init' }] }, 'a view returns values, not a sketch'],
    [{ kind: 'bar', x: 'a', y: ['v'], drill: { levels: [{ column: 'b' }], fn: 'percentile' } }, 'a drill folds no percentile either'],
    [{ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', agg: 'max' }] }, 'the fold is fn: the earlier agg is refused'],
    [{ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', currency: 'EUR' }] }, 'a pivot value\'s currency without format currency'],
    [{ kind: 'pivot', levels: [{ column: 'a' }], values: [{ column: 'v', format: 'number', currency: 'EUR' }] }, 'a number takes no currency'],
  ]) assert.equal(check(bad).ok, false, why);
  // a split names ONE value column — refused at the call, by the rule, with the result's columns at hand
  const { displayProblems } = await import('../../src/display-check.js');
  assert.match(displayProblems({ kind: 'line', x: 'd', y: ['a', 'b'], series_column: 'c' }, ['d', 'a', 'b', 'c']).join(' | '), /declare a single y/, 'a split with two value columns');
  // the declaration lives on display_model_result alone: no other tool takes one
  const metrics = [{ stage: 'metrics', metrics: ['m'] }];
  assert.equal(validateInput(validators.query_model, { context_id: 'abc123abc123', steps: metrics, display: { kind: 'kpi', values: [{ column: 'm' }] } }).ok, false, 'a query does not draw');
  for (const tool of ['query_model', 'query_model']) assert.equal(validateInput(validators[tool], { task_ids: ['abc123abc123'], display: { kind: 'kpi', values: [{ column: 'm' }] } }).ok, false, `${tool}: reading a result does not draw`);
  // a query tool either starts a query or reads a task back — never both in one call
  assert.equal(validateInput(validators.query_model, { task_ids: ['abc123abc123'], context_id: 'abc123abc123', steps: metrics }).ok, false, 'task_ids with a query');
  assert.equal(validateInput(validators.query_model, { task_ids: ['abc123abc123'], steps: [{ stage: 'limit', limit: 5 }] }).ok, false, 'task_ids with steps');
  // a read is only compiled at its start, never at a read of its task
  assert.equal(validateInput(validators.query_model, { context_id: 'abc123abc123', steps: [{ stage: 'limit', limit: 5 }], dry_run: true }).ok, true, 'a query compiled only');
  assert.equal(validateInput(validators.query_model, { task_ids: ['abc123abc123'], dry_run: true }).ok, false, 'task_ids with dry_run');
  assert.equal(validateInput(validators.query_model, {}).ok, false, 'neither a query nor a task');
  assert.equal(validateInput(validators.query_model, { task_ids: ['abc123abc123'], offset: 10, wait_seconds: 0 }).ok, true, 'a read may page and look without waiting');
});
