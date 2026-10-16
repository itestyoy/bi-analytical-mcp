// A CALL WRITTEN WHERE A MODEL READS IT IS A CALL THE SERVER TAKES. Every tool takes its input under
// one field, `request` (src/schema/transport.js), and a text that spells a call with its fields at the
// root, with a field its tool does not have, or with a form the server retired, costs the model a
// refused call and a turn — and the refusal does not always say what replaced it. What a model reads:
// the tool definitions, the recipes, the guides, the instructions, the served skills and the client
// skill shipped in skills/. The operator docs are held to the retired forms too: they are what an
// author copies into a recipe or a catalog.
//
// What a model reads depends on the deployment, so each check runs over every surface the server can
// serve: the defaults (no feature, no python runtime) and a deployment that runs every part of it —
// the retentioneering feature on (src/features.js) and the python stage offered, on each frame its
// runtime may be (frameProfile, src/python-model.js) — each walked as it is served: the tool
// definitions, semantic_index's overview and guides, the instructions a client is handed and the
// served skills.
//
// Surface checks of the kind the project allows as non-data: what the server and its skill SAY, held
// to the schema the server checks against. Nothing here asserts on generated SQL or YAML.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildToolDefs } from '../../src/server.js';
import { RESEARCH_GUIDES } from '../../src/research-guides.js';
import { servicesFor } from '../../src/mcp-surface.js';
import { createRetentioneeringFeature } from '../../src/retentioneering/index.js';
import { forms, fieldNames } from '../helpers/schema-nav.js';
import { stageBranch, stageNames } from '../helpers/stage-schema.js';
import { tempDir } from '../helpers/temp-dir.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CATALOG = join(ROOT, 'test/integration/fixtures/catalog.yml');
const RECIPES = join(ROOT, 'config/recipes.json');
// the operator docs that teach the call forms (the design notes and eval records are history)
const OPERATOR_DOCS = ['docs/SCHEMA_AUTHORING.md', 'docs/SCHEMA_ACQUISITION_CRASHLYTICS.md', 'docs/PIPELINE_RECIPES.md', 'docs/ARCHITECTURE.md', 'docs/DOCKER.md', 'docs/CAPABILITIES.md', 'docs/memory-and-filter-guard-example.md'];

// the python runtime a profile resolves to, one per frame the stage may be written against
const PYTHON = {
  bigframes: { available: true, runtime: 'bigquery', method: 'bigframes', config: {}, packages: '' },
  pyspark: { available: true, runtime: 'bigquery', method: 'serverless', config: {}, packages: '' },
  pandas: { available: true, runtime: 'duckdb', config: {}, packages: '' },
};
const DEPLOYMENTS = [
  ['default', { python: null, feature: false }],
  ...Object.entries(PYTHON).map(([frame, python]) => [`full, python on ${frame}`, { python, feature: true }]),
];

const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? filesUnder(join(dir, x.name)) : [join(dir, x.name)]));

const opened = [];
after(() => { for (const close of opened) close(); });

async function surface([deployment, { python, feature }]) {
  const catalog = loadCatalog(CATALOG, {});
  if (python) catalog.pythonRuntime = python;
  const recipes = loadRecipes(RECIPES);
  // a dbt client that is never asked to run anything here — the feature needs only that it exists
  const features = feature ? [createRetentioneeringFeature({ runner: { pythonModelsOn: () => true } })] : [];
  const engine = new Engine({
    catalog, recipes, contextManager: new ContextManager({ workspaceRoot: tempDir('calls') }),
    features, featureStatus: features.map((f) => ({ id: f.id, available: true })),
  });
  const services = servicesFor(engine);
  opened.push(() => { services.close(); engine.close(); });
  const defs = buildToolDefs(engine);
  // every string a model may read, with where it was found (and on which deployment)
  const texts = [];
  const walk = (v, where) => {
    if (typeof v === 'string') texts.push([`${deployment} — ${where}`, v]);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, where));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const d of defs) walk({ description: d.description, title: d.title, schema: d.inputSchema }, d.name);
  for (const r of recipes.list) walk(r, `recipe ${r.id}`);
  walk(await engine.semantic_index({}), 'overview');
  walk(await engine.semantic_index({ guide: true }), 'guide');
  const guides = ['python', ...Object.keys(RESEARCH_GUIDES), ...features.map((f) => f.guide?.name).filter(Boolean)];
  for (const name of guides) walk(await engine.semantic_index({ guide: name }), `guide ${name}`);
  walk(services.instructionsFor({ apps: true, skills: true }), 'instructions');
  for (const [uri, f] of services.skills?.files || []) walk(f.text, uri);
  return { deployment, engine, names: defs.map((d) => d.name), texts };
}

let built = null;
/** Every deployment's surface, built once for the file. */
const surfaces = () => (built ||= Promise.all(DEPLOYMENTS.map(surface)));
// the client skill shipped in skills/ is the same for every deployment
const clientSkill = () => filesUnder(join(ROOT, 'skills')).map((f) => [f.slice(ROOT.length), readFileSync(f, 'utf8')]);

/** The top-level field names of the object literal that starts right after `s[i - 1]` — `{ a, b: …, "c": … }` → [a, b, c]; a `…` stands for more and names nothing, and a field written `name?` is an optional one. */
function topLevelKeys(s, i) {
  const parts = []; let cur = ''; let depth = 0; let quote = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('{[('.includes(c)) depth++;
    if ('}])'.includes(c)) { if (depth === 0) { parts.push(cur); break; } depth--; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  return parts.map((p) => p.trim()).filter((p) => p && !/^(…|\.\.\.)/.test(p))
    .map((p) => (p.match(/^\\?["']?([A-Za-z_]\w*)\\?["']?\??\s*(?::|$)/) || [])[1] || p);
}

test('a call\'s fields are read as the text writes them: shorthand, quoted, optional (`name?`), or more (…)', () => {
  const keys = (s) => topLevelKeys(s, s.indexOf('{') + 1);
  assert.deepEqual(keys('{ name, source, sessions?, sample? }'), ['name', 'source', 'sessions', 'sample']);
  assert.deepEqual(keys('{ "context_id": "x", queries: [{ a, b }], … }'), ['context_id', 'queries']);
  assert.deepEqual(keys('{ action: "start", name, from_task?: "<task_id>" }'), ['action', 'name', 'from_task']);
  assert.deepEqual(keys('{ sessions?x }'), ['sessions?x'], 'a word that is not a field name is kept whole, so the check names it');
});

test('the full deployment serves what the defaults leave out — the feature\'s tools and the python stage', async () => {
  for (const { deployment, names, engine } of await surfaces()) {
    const full = deployment !== 'default';
    assert.equal(names.includes('build_retentioneering_model'), full, deployment);
    assert.equal(stageNames(engine.schemas.build_model).includes('python'), full, deployment);
  }
});

test('every call a model reads spells its input under request', async () => {
  const bare = [];
  for (const { names, texts } of await surfaces()) {
    // the tool's name, then its argument: `tool({ … })` or `tool` ({ … }) — anything but { request: … }
    const call = new RegExp(`\\b(${names.join('|')})\`?\\s*\\(\\{(?!\\s*request\\s*:)`, 'g');
    for (const [where, text] of [...texts, ...clientSkill()]) for (const m of text.matchAll(call)) bare.push(`${where}: ${text.slice(m.index, m.index + 70)}`);
  }
  assert.deepEqual(bare, [], 'a call is written tool({ request: { … } }) — the wire refuses fields at the root');
});

test('every call a model reads names only fields its tool takes', async () => {
  const wrong = [];
  for (const { deployment, engine, names, texts } of await surfaces()) {
    const call = new RegExp(`\\b(${names.join('|')})\\(\\{\\s*request\\s*:\\s*\\{`, 'g');
    let seen = 0;
    for (const [where, text] of [...texts, ...clientSkill()]) {
      for (const m of text.matchAll(call)) {
        seen++;
        const keys = topLevelKeys(text, m.index + m[0].length);
        const schema = engine.schemas[m[1]];
        // the forms are closed: one of them has to take every field the call names
        if (!forms(schema, schema).some((f) => keys.every((k) => f?.properties && k in f.properties))) wrong.push(`${where}: ${m[1]} { ${keys.join(', ')} }`);
      }
    }
    assert.ok(seen > 50, `the texts carry calls to check (${deployment}: ${seen})`);
  }
  assert.deepEqual(wrong, [], 'a field no form of the tool takes is refused');
});

test('a stage\'s fields, where a text lists them, are the fields the stage takes', async () => {
  const wrong = [];
  for (const { deployment, engine, texts } of await surfaces()) {
    const schema = engine.schemas.build_model;
    const stages = new Set(stageNames(schema));
    // `pivot` does the reverse (group_by + on + measure + values): the words of the list that are field names
    const list = /`([a-z_]+)`[^`()]{0,40}\(([^()]*\+[^()]*)\)/g;
    let seen = 0;
    for (const [where, text] of [...texts, ...clientSkill()]) {
      for (const m of text.matchAll(list)) {
        if (!stages.has(m[1])) continue;
        const taken = new Set(fieldNames(schema, stageBranch(schema, m[1])));
        for (const f of m[2].split('+').map((x) => x.trim()).filter((x) => /^[a-z_]+$/.test(x))) {
          seen++;
          if (!taken.has(f)) wrong.push(`${where}: \`${m[1]}\` takes no '${f}'`);
        }
      }
    }
    assert.ok(seen > 0, `a stage's field list is written somewhere to check (${deployment})`);
  }
  assert.deepEqual(wrong, []);
});

test('no text teaches a form the server retired', async () => {
  const texts = (await surfaces()).flatMap((s) => s.texts);
  const docs = OPERATOR_DOCS.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]);
  // (an aggregate's name; what may stand between a field and the next, one level of braces deep; a quote or none)
  const AGG = '(?:sum|average|min|max|count|count_distinct|approx_count_distinct|median|percentile|stddev|variance)';
  const NEST = '(?:[^{}\\n]|\\{[^{}\\n]*\\})*?';
  const Q = '["\']?';
  const RETIRED = [
    // a value is of the type it is read from, cast converts it; a conditional aggregate folds a case; a
    // metric query is its steps
    ['an aggregate\'s where, now the aggregate over a case', new RegExp(`\\bfn${Q}\\s*:\\s*["']${AGG}["']\\s*,${NEST}\\bwhere${Q}\\s*:\\s*\\[`)],
    ['a property read as a type it names, now the catalog\'s type, cast to another', new RegExp(`\\{\\s*${Q}property${Q}\\s*:\\s*["'][^"'\\n]*["']\\s*(?:,\\s*${Q}field${Q}\\s*:\\s*["'][^"'\\n]*["']\\s*)?,\\s*${Q}type${Q}\\s*:`)],
    ['json_field / element_at / array_last read as a type they name, now the type read (text, an element its array\'s items), cast to another', new RegExp(`\\bfn${Q}\\s*:\\s*["'](?:json_field|element_at|array_last)["']\\s*,${NEST}\\btype${Q}\\s*:`)],
    ['an unnest naming its element\'s type, now the element, cast where it is read', new RegExp(`${Q}stage${Q}\\s*:\\s*["']unnest["']\\s*,${NEST}\\btype${Q}\\s*:`)],
    ['a metric query\'s metrics beside its context or its group_by / where / steps, now its metrics step', new RegExp(`\\bcontext_id(?:${Q}\\s*:\\s*[^,{}\\n]+)?\\s*,\\s*${Q}metrics${Q}\\s*[:,}]|\\{\\s*${Q}metrics${Q}\\s*:\\s*\\[\\s*["'][^\\]\\n]*\\]\\s*,\\s*${Q}(?:group_by|where|order_by|steps|time_range)${Q}\\s*:`)],
    ['the derive stage, folded into compute', /["'`/]derive\b|\bderive\s+(stage|column)\b|\bstage\s*["']?\s*:\s*["']?derive\b/i],
    ['an aggregate named avg, spelled average here', /\b(?:agg|fn)["']?\s*:\s*["']avg["']/], // a text may still SAY that avg is spelled average
    ['the add_step action, now add_steps with a list', /\badd_step\b/],
    ['event_scope, now the semantic model\'s where', /\bevent_scope\b/],
    ['the model_column dimension, now { column } or { property }', /\bmodel_column\b/],
    ['a measure aggregated with fn or agg beside its name, now { name, expr }', /\bname["']?\s*:\s*["'][\w]+["']\s*,\s*["']?(?:fn|agg)["']?\s*:/],
    ['a measure\'s agg beside its column or field, now an expression { fn, args }', /\bagg["']?\s*:\s*["']\w+["']\s*,\s*["']?(?:column|field)["']?\s*:/],
    // (a catalog's own `meta.mcp.measure: { agg }` is the opt-in governed measure, and stays)
    ['a pivot\'s measure written { agg }, now an aggregate expression', /["']?stage["']?\s*:\s*["']pivot["'][^\n]*?\bmeasure["']?\s*:\s*\{\s*["']?agg["']?\s*:/],
    ['a card\'s fold written agg, now fn', /\bdrill["']?\s*:\s*\{[^{}]*\bagg["']?\s*:/],
    ['a condition { column | field | property, op, value }, now a function { fn, args }', /\{\s*["']?(?:column|field|property)["']?\s*:\s*(?:[^{}]*?|\{[^{}]*\}\s*),\s*["']?op["']?\s*:\s*["'](?:eq|neq|gt|gte|lt|lte|in|not_in|between|is_null|is_not_null|like|not_like|contains|starts_with|ends_with)["']/],
    ['a group of conditions { or: [...] } / { and: [...] }, now { fn: "or" | "and", args }', /\{\s*["']?(?:or|and)["']?\s*:\s*\[/],
    ['the event_property function, now the { property } leaf', /\bevent_property\b/],
    ['a read\'s transform, now its steps', /query_model[^\n]{0,80}\btransform\b/],
    // a list a tool runs in order is `steps`, one of them `step` (each item tagged by what it is: a SQL stage by `stage`)
    ['a list of stages written stages, now steps', /\bstages["']?\s*:\s*\[/],
    ['the step edit_step puts in place written stage, now step', /\bedit_step\b[^\n]{0,80}\bstage["']?\s*:\s*\{/],
    ['a metric query\'s order_by, now an order_by step after it', /query_model[^\n]{0,120}\border_by["']?\s*:/],
    ['a retentioneering read\'s detail, now offset / limit', /query_retentioneering_model[^\n]{0,160}\bdetail\b/],
    ['a fork without the name of its own it now requires', /["']?action["']?\s*:\s*["']fork["'](?:(?!\bname\b)[^{}])*\}/],
    // (a project's own MetricFlow ratio in its YAML is the project's, and a text may SAY the spelling is gone)
    ['a ratio metric declared with numerator / denominator, now a derived metric dividing two', /\btype["']?\s*:\s*["']ratio["'][^}\n]*\bnumerator["']?\s*:/],
    ['a semantic dimension named by field, now { column } or { property }', /\bdimensions["']?\s*:\s*\[\s*\{\s*["']?field["']?\s*:/],
    ['an eventstream\'s events.include / exclude / split / groups / top, now steps, columns.event and top', /\bevents["']?\s*:\s*\{\s*["']?(?:include|exclude|split|groups|top)["']?\s*:/],
    ['an eventstream\'s segments and path as objects, now column names', /\b(?:segments|path)["']?\s*:\s*\[\s*\{/],
    ['a task read with { task_id }, now { task_ids }', /query_\w+_model`?\s*\(?\{\s*(request\s*:\s*\{\s*)?task_id\s*\}/],
    ['a metric query\'s order_by key written as an object, now the result column\'s name', /\border_by["']?\s*:\s*\[\s*\{\s*["']?key["']?\s*:\s*\{/],
    ['a project dimension named alone, now { semantic_model: [chain], dimension }', /\bgroup_by["']?\s*:\s*\[\s*\{\s*["']?dimension["']?\s*:/],
    ['memory search / one note at the top of record, now semantic_index { search } and record { notes: [...] }', /memory\(\{\s*(?:["']?request["']?\s*:\s*\{\s*)?["']?action["']?\s*:\s*["'](?:search|list|get)["']|memory\(\{\s*(?:["']?request["']?\s*:\s*\{\s*)?["']?action["']?\s*:\s*["']record["']\s*,\s*["']?note["']?\s*:/],
    ['unpivot\'s name_as / value_as, now name_column / value_column', /\bname_as\b|\bvalue_as\b/],
    ['a funnel\'s mode, now between_steps', /\bmode["']?\s*:\s*["'](?:ordered|strict)["']/],
    ['a join window\'s between.value, now between.column', /\bbetween["']?\s*:\s*\{\s*["']?value["']?\s*:/],
    ['a condition\'s left / right, now its args', /\b(?:left|right)["']?\s*:\s*\{\s*["']?(?:column|value|fn|property)["']?\s*:/],
    ['a sample\'s percent, now share', /["']?stage["']?\s*:\s*["']sample["']\s*,\s*["']?percent\b/],
    ['a limit stage\'s n, now limit', /["']?stage["']?\s*:\s*["']limit["']\s*,\s*["']?n["']?\s*:/],
    ['project\'s columns, now keep', /["']?stage["']?\s*:\s*["']project["']\s*,\s*["']?columns\b/],
    ['unnest\'s source, property or column, now its expr', /["']?stage["']?\s*:\s*["']unnest["']\s*,\s*["']?(?:source|property|column)\b/],
    ['a pivot\'s value_column and agg, now one measure', /["']?stage["']?\s*:\s*["']pivot["'][^}]*\bvalue_column\b/],
    ['an eventstream from a task naming its path in columns, now path: [column]', /\bcolumns["']?\s*:\s*\{\s*["']?path["']?\s*:/],
    ['the path words users / sessions, now the path column (user_id / session_id)', /\bpath["']?\s*:\s*["'](?:users|sessions)["']/],
    ['filter_events\' where as an { op, conditions } tree, now a condition list', /\bwhere["']?\s*:\s*\{\s*["']?op["']?\s*:\s*["'](?:and|or)["']/],
    ['an events.split case\'s where, now when', /\bcases["']?\s*:\s*\[\s*\{\s*["']?name["']?\s*:[^}]*?\bwhere\b/],
    ['an analysis named by id, now name', /\bkind["']?\s*:\s*["']\w+["']\s*,\s*["']?id["']?\s*:/],
  ];
  const found = [];
  for (const [where, text] of [...texts, ...clientSkill(), ...docs]) {
    for (const [what, rx] of RETIRED) {
      const m = text.match(rx);
      if (m) found.push(`${where}: ${what} — "${text.slice(Math.max(0, m.index - 30), m.index + 40)}"`);
    }
  }
  assert.deepEqual(found, []);
});
