#!/usr/bin/env node
// IDENTITY IS CARRIED, NEVER RECOVERED FROM A NAME.
//
// This project bridges two worlds: the catalog is structured (source, model, property,
// relationship) while a dbt/MetricFlow manifest is a flat identifier space — a dimension is one
// name, a joined attribute is `entity__attribute`. Crossing that border means ASSEMBLING a name,
// which is fine. Taking one APART afterwards is not: the separator is legal inside the parts, so
// the split is a guess, and every guess in this codebase has eventually guessed wrong (a task named
// `ret` swallowing `ret_v2_country`, a memory key with no source surfacing on the wrong one).
//
// The rule this guard enforces: whatever a generated name encodes must ALSO be stored next to it,
// and a caller-facing reference is a structured object or an enum — never a bare word the engine
// interprets by convention. So `src/` may assemble names; it may not dismantle them, and it may not
// compare an identifier against a hardcoded catalog name.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

// Each rule: what is forbidden, and why. `allow` lists the occurrences that are reading CALLER
// INPUT (a legacy spelling someone typed) rather than recovering discarded structure — with the
// reason, so a new one has to be argued for rather than added quietly.
const RULES = [
  {
    id: 'split-generated-name',
    re: /\.(split|indexOf|lastIndexOf)\(\s*['"`](__|_)['"`]\s*\)/g,
    why: "taking a generated name apart — carry what it encodes next to it instead",
    allow: {
      'engine.js': ["p.split('__')"], // _suggestRef: reads a path the CALLER typed, to answer with the structured form
      'server.js': ["String(name).split('_')"], // titleFromName: formatting a tool name for humans, not resolving anything
    },
  },
  {
    id: 'prefix-match-generated-name',
    re: /\.(startsWith|endsWith)\(\s*`\$\{/g,
    why: 'matching a generated name by prefix — one name may be a prefix of another',
    allow: {
      'engine.js': ['startsWith(`${tk}_`)'], // declaredAttribute: the fallback for contexts persisted before `_task`/`_attribute` existed
    },
  },
  {
    id: 'hardcoded-catalog-name',
    // a literal the catalog's AUTHOR chooses (relationship / event / property names) compared in code
    re: /[=!]==\s*['"`](user|session|country|player_id|appsflyer_id|event_name|install)['"`]/g,
    why: 'a catalog name hardcoded in src/ — derive it from a role or a declaration',
    // A ROLE comparison (`.role === 'users'`) is structural: roles are the catalog's own fixed
    // vocabulary (CLAUDE.md), while relationship and column names belong to the schema's author.
    skip: /\brole\s*===/,
    allow: {},
  },
];

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
};
walk(SRC);

const problems = [];
for (const file of files.sort()) {
  const rel = relative(ROOT, file);
  const base = rel.split('/').pop();
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const rule of RULES) {
    const allowed = rule.allow?.[base] || [];
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return; // prose
      if (rule.skip?.test(line)) return;
      for (const m of line.matchAll(rule.re)) {
        if (allowed.some((a) => line.includes(a))) return;
        problems.push({ rel, line: i + 1, rule: rule.id, why: rule.why, text: line.trim().slice(0, 120), hit: m[0] });
      }
    });
  }
}

if (!problems.length) {
  console.log(`name-identity: ${files.length} file(s) in src/ — no name taken apart, no catalog name hardcoded.`);
  process.exit(0);
}
console.error('name-identity: identity must be CARRIED, not recovered from a name.\n');
for (const p of problems) {
  console.error(`  ${p.rel}:${p.line}  [${p.rule}] ${p.why}`);
  console.error(`      ${p.text}`);
}
console.error(`\n${problems.length} occurrence(s). If one genuinely reads CALLER INPUT rather than recovering`);
console.error('discarded structure, add it to that rule\'s `allow` in scripts/check-name-identity.mjs with the reason.');
process.exit(1);
