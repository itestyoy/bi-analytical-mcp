// SKILLS OVER MCP — the analyst procedure and the recipes served as Agent Skills.
//
// What the extension (SEP-2640) makes a host rely on, checked from the host's side: every file a
// skills/list entry names is readable with resources/read in BOTH eras, and its bytes match the
// listed sha256 digest and size (a host MUST refuse a file that does not); the entry's frontmatter
// is the SKILL.md frontmatter verbatim; the last path segment is the skill's name; every relative
// link in SKILL.md resolves to a listed file; skills/get answers for a skill by URI and refuses a
// non-skill with -32602.
//
// And the rule that makes skills safe to add at all — ONE source of truth: a recipe file carries
// the same payload semantic_index({ recipe }) returns (compared as parsed JSON, not as text).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { z } from 'zod';
import { startServer } from '../helpers/mcp-http.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const digest = (text) => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
const frontmatterOf = (md) => yaml.load(/^---\n([\s\S]*?)\n---\n/.exec(md)[1]);

test('every listed file is readable in both eras and matches its digest and size', async () => {
  const list = (await s.modern('skills/list')).body.result.skills;
  assert.ok(list.length >= 1);
  const legacy = await s.legacyClient();
  try {
    for (const skill of list) {
      assert.ok(Array.isArray(skill.resources) && skill.resources.some((r) => r.uri === skill.uri), 'the listing includes SKILL.md itself');
      assert.ok(skill.resources.length <= 512 && skill.resources.reduce((a, r) => a + r.size, 0) <= 16 * 1024 * 1024, 'within the per-skill limits');
      for (const r of skill.resources) {
        const modern = (await s.modern('resources/read', { uri: r.uri })).body.result.contents[0].text;
        const old = (await legacy.readResource({ uri: r.uri })).contents[0].text;
        assert.equal(modern, old, `${r.uri}: the same bytes in both eras`);
        assert.equal(digest(modern), r.digest, `${r.uri}: digest`);
        assert.equal(Buffer.byteLength(modern, 'utf8'), r.size, `${r.uri}: size`);
      }
    }
  } finally { await legacy.close(); }
});

test('frontmatter is verbatim, the path ends in the name, and SKILL.md links resolve to listed files', async () => {
  for (const skill of (await s.modern('skills/list')).body.result.skills) {
    const md = (await s.modern('resources/read', { uri: skill.uri })).body.result.contents[0].text;
    assert.deepEqual(frontmatterOf(md), skill.frontmatter);
    assert.ok(skill.frontmatter.name && skill.frontmatter.description);
    assert.match(skill.frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'Agent Skills naming');
    assert.equal(skill.uri.replace(/\/SKILL\.md$/, '').split('/').pop(), skill.frontmatter.name);
    const root = skill.uri.replace(/SKILL\.md$/, '');
    const listed = new Set(skill.resources.map((r) => r.uri));
    for (const [, rel] of md.matchAll(/\]\(([^)#:]+\.md)\)/g)) assert.ok(listed.has(root + rel), `${rel} resolves to a listed file`);
  }
});

test('skills/get returns the listed entry by URI, and refuses a non-skill with -32602 (both eras)', async () => {
  const [first] = (await s.modern('skills/list')).body.result.skills;
  const got = (await s.modern('skills/get', { uri: first.uri })).body.result.skill;
  assert.deepEqual(got, first);
  const miss = await s.modern('skills/get', { uri: 'skill://nope/SKILL.md' });
  assert.equal(miss.body.error.code, -32602);
  const legacy = await s.legacyClient();
  try {
    const r = await legacy.request({ method: 'skills/get', params: { uri: first.uri } }, z.object({ skill: z.any() }).passthrough());
    assert.deepEqual(r.skill, first);
  } finally { await legacy.close(); }
});

test('a recipe file carries the same payload the recipe tool returns (one source of truth)', async () => {
  const [skill] = (await s.modern('skills/list')).body.result.skills;
  const recipeFiles = skill.resources.filter((r) => /\/recipes\/[^/]+\.md$/.test(r.uri));
  assert.ok(recipeFiles.length > 0);
  let compared = 0;
  for (const r of recipeFiles) {
    const id = r.uri.split('/').pop().replace(/\.md$/, '');
    const recipe = await s.engine.semantic_index({ recipe: id });
    const md = (await s.modern('resources/read', { uri: r.uri })).body.result.contents[0].text;
    for (const key of ['create_payload', 'register_payload', 'example_queries']) {
      if (recipe[key] === undefined) continue;
      const heading = key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
      const block = new RegExp(`## ${heading}\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(md);
      assert.ok(block, `${id}: ${key} is in the skill`);
      assert.deepEqual(JSON.parse(block[1]), recipe[key], `${id}: ${key} is the same data`);
      compared += 1;
    }
  }
  assert.ok(compared > 5, `compared ${compared} payloads`);
});

test('the server instructions point at the skills (a host without skills/list still finds them)', async () => {
  const d = (await s.modern('server/discover')).body.result;
  for (const skill of (await s.modern('skills/list')).body.result.skills) assert.ok(d.instructions.includes(skill.uri));
});
