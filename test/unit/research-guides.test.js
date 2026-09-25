// THE RESEARCH GUIDES (src/research-guides.js): served by semantic_index({ guide: "research" |
// "research/<domain>" }), refused when unknown, rendered as the `research` skill from the same
// objects, and routed to by one exported line that every surface interpolates. Every recipe a guide
// names is a recipe this server loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../../src/catalog.js';
import { loadRecipes } from '../../src/recipes.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { RESEARCH_DOMAINS, RESEARCH_GUIDES, RESEARCH_ROUTE, researchGuide } from '../../src/research-guides.js';
import { buildSkills } from '../../src/skills.js';
import { coreInstructions } from '../../src/mcp-surface.js';
import { settle } from '../helpers/settle.js';

const CATALOG = fileURLToPath(new URL('../integration/fixtures/catalog.yml', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../config/recipes.json', import.meta.url));
const engine = () => settle(new Engine({ catalog: loadCatalog(CATALOG, {}), recipes: loadRecipes(RECIPES), contextManager: new ContextManager({ workspaceRoot: mkdtempSync(join(tmpdir(), 'research-')) }) }));
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

test('semantic_index serves the research guide and one guide per domain — exactly the objects researchGuide builds', async () => {
  const e = engine();
  const r = await e.semantic_index({ guide: 'research' });
  assert.deepEqual(r, researchGuide('research'));
  assert.ok(r.sequence.length >= 7 && r.checks.length >= 5 && r.report.length >= 3, 'a sequence, checks and a report');
  assert.deepEqual(Object.keys(r.domains), RESEARCH_DOMAINS, 'every domain is listed, derived from the guide set');
  for (const key of RESEARCH_DOMAINS) {
    const d = await e.semantic_index({ guide: key });
    assert.deepEqual(d, researchGuide(key));
    assert.ok(d.sequence.length && d.metrics.length && d.questions.length && d.pitfalls.length, `${key} has a sequence, metrics, questions and pitfalls`);
  }
  assert.deepEqual(await e.semantic_index({ guide: ' Research/UA ' }), researchGuide('research/ua'), 'the name is read in any case');
});

test('an unknown research guide is refused, not answered with an empty guide', async () => {
  await assert.rejects(engine().semantic_index({ guide: 'research/finance' }), (err) => err.field === 'guide' && err.stage === 'validate');
});

test('every recipe a research guide names is written recipe "<id>" and is loaded by this server', () => {
  const ids = new Set(loadRecipes(RECIPES).ids());
  const text = strings(RESEARCH_GUIDES).join('\n');
  const named = [...new Set([...text.matchAll(/recipe "([a-z0-9_]+)"/g)].map((m) => m[1]))];
  assert.ok(named.length >= 10, `the guides point at recipes (${named.join(', ')})`);
  for (const id of named) assert.ok(ids.has(id), `recipe "${id}" is not a loaded recipe`);
  // …and none is referenced any other way (bare, or as a pattern the model cannot fetch)
  const bare = [...ids].filter((id) => new RegExp(`(^|[^"\\w])${id}([^"\\w]|$)`).test(text));
  assert.deepEqual(bare, [], 'a recipe named without the recipe "<id>" form');
  assert.ok(!/\w_\*/.test(text), 'no glob in place of an id');
});

test('the research skill renders the same objects: SKILL.md and one file per domain', () => {
  const skills = buildSkills(engine());
  const research = skills.list().find((s) => s.frontmatter.name === 'research');
  assert.ok(research, 'the research skill is listed');
  assert.deepEqual(research.resources.map((r) => r.uri.split('/').pop()).sort(), ['SKILL.md', ...RESEARCH_DOMAINS.map((d) => `${d.split('/')[1]}.md`)].sort());
  const body = skills.read(research.uri).text;
  for (const s of RESEARCH_GUIDES.research.sequence) assert.ok(body.includes(s.do), `step "${s.step}" is rendered in full`);
  for (const key of RESEARCH_DOMAINS) {
    const file = skills.read(research.uri.replace('SKILL.md', `${key.split('/')[1]}.md`)).text;
    for (const line of strings(researchGuide(key)).filter((x) => x !== key)) assert.ok(file.includes(line), `${key}: the file carries what the tool returns`);
  }
});

test('an open question is routed to the guides by one line, which the guide and the instructions both carry', async () => {
  const g = await engine().semantic_index({ guide: true });
  assert.ok(g.routing_triggers.some((t) => t.do.includes(RESEARCH_ROUTE)), 'the guide\'s routing trigger');
  assert.ok(coreInstructions({}).includes(RESEARCH_ROUTE), 'the core instructions');
});
