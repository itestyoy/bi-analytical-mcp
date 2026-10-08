// A CALL WRITTEN WHERE A MODEL READS IT IS A CALL THE SERVER TAKES. Every tool takes its input under
// one field, `request` (src/schema/transport.js), and a text that spells a call with its fields at the
// root, with a field its tool does not have, or with a form the server retired, costs the model a
// refused call and a turn — and the refusal does not always say what replaced it. What a model reads:
// the tool definitions, the recipes, the guides, the instructions, the served skills and the client
// skill shipped in skills/. The operator docs are held to the retired forms too: they are what an
// author copies into a recipe or a catalog.
//
// Surface checks of the kind the project allows as non-data: what the server and its skill SAY, held
// to the schema the server checks against. Nothing here asserts on generated SQL or YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { buildToolDefs } from '../../src/server.js';
import { buildGuide } from '../../src/guide.js';
import { RESEARCH_GUIDES, researchGuide } from '../../src/research-guides.js';
import { coreInstructions, servicesFor } from '../../src/mcp-surface.js';
import { forms, fieldNames } from '../helpers/schema-nav.js';
import { stageBranch, stageNames } from '../helpers/stage-schema.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CATALOG = join(ROOT, 'test/integration/fixtures/catalog.yml');
const RECIPES = join(ROOT, 'config/recipes.json');
// the operator docs that teach the call forms (the design notes and eval records are history)
const OPERATOR_DOCS = ['docs/SCHEMA_AUTHORING.md', 'docs/SCHEMA_ACQUISITION_CRASHLYTICS.md', 'docs/PIPELINE_RECIPES.md', 'docs/ARCHITECTURE.md', 'docs/DOCKER.md', 'docs/CAPABILITIES.md', 'docs/memory-and-filter-guard-example.md'];

const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? filesUnder(join(dir, x.name)) : [join(dir, x.name)]));

function surface() {
  const catalog = loadCatalog(CATALOG, {});
  const recipes = loadRecipes(RECIPES);
  const engine = new Engine({ catalog, recipes, contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'calls-')) }) });
  const defs = buildToolDefs(engine);
  // every string a model may read, with where it was found
  const texts = [];
  const walk = (v, where) => {
    if (typeof v === 'string') texts.push([where, v]);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, where));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const d of defs) walk({ description: d.description, title: d.title, schema: d.inputSchema }, d.name);
  for (const r of recipes.list) walk(r, `recipe ${r.id}`);
  walk(buildGuide(catalog, recipes), 'guide');
  for (const name of Object.keys(RESEARCH_GUIDES)) walk(researchGuide(name), `guide ${name}`);
  walk(coreInstructions({ apps: true, skillUris: ['skill://betti/analytics/SKILL.md'] }), 'instructions');
  for (const [uri, f] of servicesFor(engine).skills?.files || []) walk(f.text, uri);
  for (const f of filesUnder(join(ROOT, 'skills'))) texts.push([f.slice(ROOT.length), readFileSync(f, 'utf8')]);
  return { engine, names: defs.map((d) => d.name), texts };
}

/** The top-level field names of the object literal that starts right after `s[i - 1]` — `{ a, b: …, "c": … }` → [a, b, c]; a `…` stands for more and names nothing. */
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
    .map((p) => (p.match(/^\\?["']?([A-Za-z_]\w*)\\?["']?\s*(?::|$)/) || [])[1] || p);
}

test('every call a model reads spells its input under request', () => {
  const { names, texts } = surface();
  // the tool's name, then its argument: `tool({ … })` or `tool` ({ … }) — anything but { request: … }
  const call = new RegExp(`\\b(${names.join('|')})\`?\\s*\\(\\{(?!\\s*request\\s*:)`, 'g');
  const bare = texts.flatMap(([where, text]) => [...text.matchAll(call)].map((m) => `${where}: ${text.slice(m.index, m.index + 70)}`));
  assert.deepEqual(bare, [], 'a call is written tool({ request: { … } }) — the wire refuses fields at the root');
});

test('every call a model reads names only fields its tool takes', () => {
  const { engine, names, texts } = surface();
  const call = new RegExp(`\\b(${names.join('|')})\\(\\{\\s*request\\s*:\\s*\\{`, 'g');
  let seen = 0;
  const wrong = [];
  for (const [where, text] of texts) {
    for (const m of text.matchAll(call)) {
      seen++;
      const keys = topLevelKeys(text, m.index + m[0].length);
      const schema = engine.schemas[m[1]];
      // the forms are closed: one of them has to take every field the call names
      if (!forms(schema, schema).some((f) => keys.every((k) => f?.properties && k in f.properties))) wrong.push(`${where}: ${m[1]} { ${keys.join(', ')} }`);
    }
  }
  assert.ok(seen > 50, `the texts carry calls to check (${seen})`);
  assert.deepEqual(wrong, [], 'a field no form of the tool takes is refused');
});

test('a stage\'s fields, where a text lists them, are the fields the stage takes', () => {
  const { engine, texts } = surface();
  const schema = engine.schemas.build_pipeline_model;
  const stages = new Set(stageNames(schema));
  // `pivot` does the reverse (group_by + on + agg + value_column + …): the words of the list that are field names
  const list = /`([a-z_]+)`[^`()]{0,40}\(([^()]*\+[^()]*)\)/g;
  let seen = 0;
  const wrong = [];
  for (const [where, text] of texts) {
    for (const m of text.matchAll(list)) {
      if (!stages.has(m[1])) continue;
      const taken = new Set(fieldNames(schema, stageBranch(schema, m[1])));
      for (const f of m[2].split('+').map((x) => x.trim()).filter((x) => /^[a-z_]+$/.test(x))) {
        seen++;
        if (!taken.has(f)) wrong.push(`${where}: \`${m[1]}\` takes no '${f}'`);
      }
    }
  }
  assert.ok(seen > 0, 'a stage\'s field list is written somewhere to check');
  assert.deepEqual(wrong, []);
});

test('no text teaches a form the server retired', () => {
  const { texts } = surface();
  const docs = OPERATOR_DOCS.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]);
  const RETIRED = [
    ['the derive stage, folded into compute', /["'`/]derive\b|\bderive\s+(stage|column)\b|\bstage\s*["']?\s*:\s*["']?derive\b/i],
    ['agg avg, spelled average here', /\bagg["']?\s*:\s*["']avg["']/], // a text may still SAY that avg is spelled average
    ['the add_step action, now add_steps with a list', /\badd_step\b/],
    ['event_scope, now the semantic model\'s where', /\bevent_scope\b/],
    ['the model_column dimension, now { field }', /\bmodel_column\b/],
    ['a measure aggregated with fn, now agg', /\bname["']?\s*:\s*["'][\w]+["']\s*,\s*["']?fn["']?\s*:/],
    ['a task read with { task_id }, now { task_ids }', /query_\w+_model`?\s*\(?\{\s*(request\s*:\s*\{\s*)?task_id\s*\}/],
    ['a metric query\'s order_by key written as an object, now the result column\'s name', /\border_by["']?\s*:\s*\[\s*\{\s*["']?key["']?\s*:\s*\{/],
    ['memory search / one note at the top of record, now semantic_index { search } and record { notes: [...] }', /memory\(\{\s*(?:["']?request["']?\s*:\s*\{\s*)?["']?action["']?\s*:\s*["'](?:search|list|get)["']|memory\(\{\s*(?:["']?request["']?\s*:\s*\{\s*)?["']?action["']?\s*:\s*["']record["']\s*,\s*["']?note["']?\s*:/],
  ];
  const found = [];
  for (const [where, text] of [...texts, ...docs]) {
    for (const [what, rx] of RETIRED) {
      const m = text.match(rx);
      if (m) found.push(`${where}: ${what} — "${text.slice(Math.max(0, m.index - 30), m.index + 40)}"`);
    }
  }
  assert.deepEqual(found, []);
});
