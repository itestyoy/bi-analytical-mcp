// THE RESEARCH GUIDES (src/research-guides.js): served by semantic_index({ guide: "research" |
// "research/<domain>" }), rendered as the `research` skill from the same objects, and routed to from
// the guide, the tool description and the instructions. Every recipe a guide names is a shipped one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { RESEARCH_GUIDES } from '../../src/research-guides.js';
import { buildSkills } from '../../src/skills.js';
import { coreInstructions, TOOL_DESCRIPTIONS } from '../../src/mcp-surface.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
const engine = () => settle(new Engine({ catalog: loadCatalog(CATALOG, {}), recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'research-')) }) }));

test('semantic_index serves the research guide and one guide per domain', async () => {
  const e = engine();
  const r = await e.semantic_index({ guide: 'research' });
  assert.ok(r.sequence.length >= 7 && r.checks.length >= 5 && r.report.length >= 3, 'a sequence, checks and a report');
  assert.deepEqual(Object.keys(r.domains), ['research/product', 'research/monetization', 'research/ua']);
  for (const key of Object.keys(r.domains)) {
    const d = await e.semantic_index({ guide: key });
    assert.equal(d.guide, key);
    assert.ok(d.sequence.length && d.metrics.length && d.questions.length && d.pitfalls.length, `${key} has a sequence, metrics, questions and pitfalls`);
    assert.match(d.start_with, /guide: "research"/, `${key} plugs into the research sequence`);
  }
  const unknown = await e.semantic_index({ guide: 'research/finance' });
  assert.match(unknown.note, /No research guide 'research\/finance'.*research\/ua/);
});

test('every recipe a research guide names is a shipped recipe', () => {
  const ids = new Set(JSON.parse(readFileSync(RECIPES, 'utf8')).recipes?.map((r) => r.id) ?? JSON.parse(readFileSync(RECIPES, 'utf8')).map((r) => r.id));
  const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  const text = strings(RESEARCH_GUIDES).join('\n');
  // a snake_case name of three parts or more is a recipe id — tool names aside
  const named = [...new Set(text.match(/\b[a-z0-9]+(?:_[a-z0-9]+){2,}\b/g) || [])].filter((n) => !(n in TOOL_DESCRIPTIONS));
  assert.ok(named.length >= 8, `the guides point at recipes (${named.join(', ')})`);
  for (const id of named) assert.ok(ids.has(id), `${id} is not a shipped recipe`);
});

test('the research skill is rendered from the same guides, one reference per domain', () => {
  const skills = buildSkills(engine());
  const research = skills.list().find((s) => s.frontmatter.name === 'research');
  assert.ok(research, 'the research skill is listed');
  const files = research.resources.map((r) => r.uri.split('/').pop()).sort();
  assert.deepEqual(files, ['SKILL.md', 'monetization.md', 'product.md', 'ua.md']);
  const body = skills.read(research.uri).text;
  for (const s of RESEARCH_GUIDES.research.sequence) assert.ok(body.includes(s.step), `step ${s.step} is in the skill`);
  const ua = skills.read(research.uri.replace('SKILL.md', 'ua.md')).text;
  for (const m of RESEARCH_GUIDES['research/ua'].metrics) assert.ok(ua.includes(m.metric), `${m.metric} is in ua.md`);
});

test('an open question is routed to the research guide — by the guide, the tool description and the instructions', async () => {
  const g = await engine().semantic_index({ guide: true });
  assert.ok(g.routing_triggers.some((t) => /guide: "research"/.test(t.do)), 'a routing trigger');
  assert.match(TOOL_DESCRIPTIONS.semantic_index, /guide: "research"/);
  assert.match(coreInstructions({}), /guide: "research"/);
});
