#!/usr/bin/env node
// Manage the dbt environments the server runs dbt in (src/dbt/environments.js).
//
//   node scripts/dbt-env.mjs create <name> -r <requirements file> [-r <another>] [--python python3]
//   node scripts/dbt-env.mjs list
//
// `create` makes <DBT_ENVS_DIR>/<name> a fresh virtualenv and installs the requirements into it:
//   dbt-v2     — requirements-dbt2.txt                        (dbt v2; the one used unless DBT_ENV)
//   dbt-v1     — requirements.txt / requirements-bigquery.txt (dbt 1.x + the adapter)
//   metricflow — requirements-metricflow.txt / -bigquery.txt  (MetricFlow's mf + dbt-core + adapter)
// `list` shows each environment: its dbt version, or that it is a MetricFlow environment, and which
// MetricFlow a dbt environment queries with.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { envsDir, listEnvironments, resolveEnvironment } from '../src/dbt/environments.js';

const [cmd, ...rest] = process.argv.slice(2);
const dir = envsDir();

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return (out.match(/installed:\s*([\d.]+)/) || out.match(/\bdbt(?:-fusion)?\s+([\d.]+)/i) || [])[1] || '?';
  } catch { return '?'; }
}

if (cmd === 'create') {
  const name = rest[0];
  if (!name || name.startsWith('-')) { console.error('usage: dbt-env create <name> -r <requirements file> [...]'); process.exit(2); }
  const reqs = [];
  let python = 'python3';
  for (let i = 1; i < rest.length; i += 1) {
    if (rest[i] === '-r') reqs.push(rest[++i]);
    else if (rest[i] === '--python') python = rest[++i];
  }
  if (!reqs.length) { console.error('dbt-env create: name at least one requirements file with -r'); process.exit(2); }
  const target = join(dir, name);
  mkdirSync(dir, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  const step = (bin, args) => { const r = spawnSync(bin, args, { stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status ?? 1); };
  step(python, ['-m', 'venv', target]);
  step(join(target, 'bin', 'pip'), ['install', '--quiet', '--upgrade', 'pip']);
  step(join(target, 'bin', 'pip'), ['install', '--quiet', ...reqs.flatMap((r) => ['-r', r])]);
  const made = listEnvironments({ dir }).find((x) => x.name === name);
  if (made?.dbtBin) {
    const e = resolveEnvironment(name, { dir });
    console.log(`${name}: dbt ${versionOf(e.dbtBin)} at ${e.dbtBin}; MetricFlow ${e.metricflowFrom ? `from '${e.metricflowFrom}'` : 'none yet — create it: node scripts/dbt-env.mjs create metricflow -r requirements-metricflow.txt'}`);
  } else if (made?.mfBin) {
    console.log(`${name}: MetricFlow at ${made.mfBin}`);
  } else {
    console.log(`${name}: created, but it has neither dbt nor mf in bin/`);
  }
} else if (cmd === 'list' || !cmd) {
  const all = listEnvironments({ dir });
  if (!all.length) console.log(`no dbt environments in ${dir} — create one: node scripts/dbt-env.mjs create dbt-v2 -r requirements-dbt2.txt`);
  for (const e of all) {
    // a MetricFlow environment carries the Python dbt-core too (MetricFlow queries through it)
    if (e.mfBin) { console.log(`${e.name.padEnd(12)} MetricFlow (mf)${e.dbtBin ? ` on dbt-core ${versionOf(e.dbtBin)}` : ''}`); continue; }
    let mf = '';
    try { mf = resolveEnvironment(e.name, { dir }).metricflowFrom; } catch (err) { mf = `! ${err.message}`; }
    console.log(`${e.name.padEnd(12)} dbt ${versionOf(e.dbtBin).padEnd(10)} queries with MetricFlow from: ${mf || '-'}`);
  }
} else {
  console.error(`unknown command '${cmd}' (create | list)`);
  process.exit(2);
}
