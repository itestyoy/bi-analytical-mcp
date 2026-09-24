#!/usr/bin/env node
// Build the dbt environments the server runs dbt in (src/dbt/environments.js) — ONLY the ones this
// tool defines, ONLY with the exact versions it names (src/dbt/environment-specs.js). The image runs
// `create` at `docker build`; locally it builds .venvs for the tests.
//
//   node scripts/dbt-env.mjs create <name>   build it from its spec
//   node scripts/dbt-env.mjs list            what is there
//
// `create` makes <DBT_ENVS_DIR>/<name> a fresh virtualenv, installs the spec's pip, then exactly the
// spec's packages, checks that each is installed at its version, and records what it was built with
// (mcp-env.json) — the server refuses an environment whose record differs from the spec.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envsDir, listEnvironments, notOurs, resolveEnvironment } from '../src/dbt/environments.js';
import { ENVIRONMENT_SPECS, INSTALLER, environmentPackages } from '../src/dbt/environment-specs.js';

const [cmd, ...rest] = process.argv.slice(2);
const dir = envsDir();
const positional = rest.filter((a) => !a.startsWith('--'));

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return (out.match(/installed:\s*([\d.]+)/) || out.match(/\bdbt(?:-fusion)?\s+([\d.]+)/i) || [])[1] || '?';
  } catch { return '?'; }
}

if (cmd === 'create') {
  const name = positional[0];
  if (!name) { console.error(`usage: dbt-env create <name>   (names: ${Object.keys(ENVIRONMENT_SPECS).join(', ')})`); process.exit(2); }
  const packages = environmentPackages(name); // refuses a name the specs do not define
  const target = join(dir, name);
  const python = join(target, 'bin', 'python');
  const step = (bin, args) => { const r = spawnSync(bin, args, { stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status ?? 1); };
  mkdirSync(dir, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  step('python3', ['-m', 'venv', target]);
  const pip = (args) => step(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-cache-dir', ...args]);
  pip([INSTALLER]);
  pip(packages);
  // installed exactly as named?
  const installed = new Map(execFileSync(python, ['-m', 'pip', 'list', '--format=freeze', '--disable-pip-version-check'], { encoding: 'utf8' })
    .split('\n').map((l) => l.split('==')).filter((p) => p.length === 2).map(([n, v]) => [n.toLowerCase().replace(/_/g, '-'), v]));
  const wrong = packages.filter((p) => { const [n, v] = p.split('=='); return installed.get(n.toLowerCase().replace(/_/g, '-')) !== v; });
  if (wrong.length) { console.error(`${name}: not installed as named: ${wrong.join(', ')}`); process.exit(1); }
  writeFileSync(join(target, 'mcp-env.json'), `${JSON.stringify({ name, packages }, null, 2)}\n`);
  const made = listEnvironments({ dir }).find((x) => x.name === name);
  const what = made?.mfBin ? `MetricFlow at ${made.mfBin}` : `dbt ${versionOf(made.dbtBin)} at ${made.dbtBin}`;
  console.log(`${name}: ${what} — ${packages.join(' ')}`);
} else if (cmd === 'list' || !cmd) {
  const all = listEnvironments({ dir });
  if (!all.length) console.log(`no dbt environments in ${dir} — build one: node scripts/dbt-env.mjs create dbt-v2`);
  for (const e of all) {
    const theirs = notOurs(e.name, e.dir);
    const tag = theirs ? `REFUSED: ${theirs}` : 'built from its spec';
    if (e.mfBin) { console.log(`${e.name.padEnd(12)} MetricFlow (mf)${e.dbtBin ? ` on dbt-core ${versionOf(e.dbtBin)}` : ''} — ${tag}`); continue; }
    let mf = '';
    try { mf = resolveEnvironment(e.name, { dir }).metricflowFrom; } catch (err) { mf = `! ${err.message}`; }
    console.log(`${e.name.padEnd(12)} dbt ${versionOf(e.dbtBin).padEnd(10)} queries with MetricFlow from: ${mf || '-'} — ${tag}`);
  }
} else {
  console.error(`unknown command '${cmd}' (create | list)`);
  process.exit(2);
}
