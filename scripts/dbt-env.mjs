#!/usr/bin/env node
// Build and check the dbt environments the server runs dbt in (src/dbt/environments.js) — ONLY the
// ones this tool defines (src/dbt/environment-specs.js), ONLY from their hash-locked files.
//
//   node scripts/dbt-env.mjs create <name> [--adapter duckdb|bigquery]   build it from its lock
//   node scripts/dbt-env.mjs verify [<name> ...]                          installed == locked?
//   node scripts/dbt-env.mjs list                                         what is there
//   node scripts/dbt-env.mjs lock                                         (maintainers) re-resolve
//                                                                         every lock from the specs
//
// `create` makes <DBT_ENVS_DIR>/<name> a fresh virtualenv, removes what the venv came with beyond
// the locked installer, and installs its lock with `pip install --require-hashes --only-binary :all:
// --no-deps`: every file must match a SHA-256 in the lock, nothing unlisted is installed, and
// nothing is built from source but what the spec names in `sourceBuilds`. The adapter it was built
// for is recorded in the environment (mcp-env.json) and `verify` compares what is installed with the
// lock. `lock` needs `uv`, `curl` and network; the result is committed and reviewed.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envsDir, listEnvironments, resolveEnvironment } from '../src/dbt/environments.js';
import { ADAPTERS, ENVIRONMENT_SPECS, INSTALLER, INSTALLER_LOCK, LOCK_PLATFORM, LOCK_PYTHON, LOCK_WHEEL_TAG, environmentPackages, environmentSpec, lockFile } from '../src/dbt/environment-specs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const dir = envsDir();
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return (out.match(/installed:\s*([\d.]+)/) || out.match(/\bdbt(?:-fusion)?\s+([\d.]+)/i) || [])[1] || '?';
  } catch { return '?'; }
}

const normal = (name) => name.toLowerCase().replace(/_/g, '-');

/**
 * The requirement a lock line starts: { name, version } for `name==version` and for a locked wheel
 * `name @ https://…/<name>-<version>-<tags>.whl`; null for a hash or comment line.
 */
function requirementOf(line) {
  const pinned = line.match(/^([A-Za-z0-9._-]+)==([^\s;\\]+)/);
  if (pinned) return { name: normal(pinned[1]), version: pinned[2] };
  const wheel = line.match(/^([A-Za-z0-9._-]+) @ \S+\/[A-Za-z0-9_.]+-([^-/\s]+)-[^/\s]+\.whl\b/);
  if (wheel) return { name: normal(wheel[1]), version: wheel[2] };
  return null;
}

/** name==version pairs of a lock file (lowercased names, `-` for `_`). */
function lockedPackages(file) {
  const out = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const r = requirementOf(line);
    if (r) out.set(r.name, r.version);
  }
  return out;
}

/** name==version pairs installed in an environment. */
function installedPackages(envDir) {
  const out = new Map();
  const text = execFileSync(join(envDir, 'bin', 'python'), ['-m', 'pip', 'list', '--format=freeze', '--disable-pip-version-check'], { encoding: 'utf8' });
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9._-]+)==(\S+)/);
    if (m) out.set(normal(m[1]), m[2]);
  }
  return out;
}

/** A lock's requirement blocks (`name==v \\` + its `--hash` lines), split by whether `pick` takes the name. */
function splitLock(file, pick) {
  const blocks = readFileSync(file, 'utf8').split(/\n(?=[A-Za-z0-9])/);
  const out = { picked: [], rest: [] };
  for (const b of blocks) {
    const r = requirementOf(b);
    if (!r) continue;
    (pick(r.name) ? out.picked : out.rest).push(b.trim());
  }
  return out;
}

function readMeta(envDir) {
  try { return JSON.parse(readFileSync(join(envDir, 'mcp-env.json'), 'utf8')); } catch { return null; }
}

/** Differences between what an environment has and its lock: [] when they are the same. */
function verify(name) {
  const envDir = join(dir, name);
  if (!existsSync(envDir)) return [`not built (node scripts/dbt-env.mjs create ${name})`];
  const meta = readMeta(envDir);
  if (!meta || meta.name !== name) return ['not built by this tool (no mcp-env.json) — rebuild it with create'];
  const locked = lockedPackages(join(ROOT, meta.lock));
  const installed = installedPackages(envDir);
  const problems = [];
  for (const [pkg, v] of locked) if (installed.get(pkg) !== v) problems.push(`${pkg}: locked ${v}, installed ${installed.get(pkg) || 'nothing'}`);
  // (pip itself is the installer's lock, not the environment's)
  for (const [pkg, v] of installed) if (!locked.has(pkg) && pkg !== 'pip') problems.push(`${pkg}==${v}: installed, not in the lock`);
  return problems;
}

if (cmd === 'create') {
  const name = positional[0];
  if (!name) { console.error(`usage: dbt-env create <name> [--adapter ${ADAPTERS.join('|')}]   (names: ${Object.keys(ENVIRONMENT_SPECS).join(', ')})`); process.exit(2); }
  const spec = environmentSpec(name);
  const adapter = spec.packages ? null : (flag('--adapter') || 'duckdb');
  environmentPackages(name, adapter); // refuses an adapter the spec does not build
  const lock = lockFile(name, adapter);
  if (!existsSync(join(ROOT, lock))) { console.error(`${lock} is missing — a maintainer runs: node scripts/dbt-env.mjs lock`); process.exit(1); }
  const step = (bin, args) => { const r = spawnSync(bin, args, { stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status ?? 1); };
  // the locks hold the files of ONE platform: another Python or machine is another lock, not a build
  const python = flag('--python') || 'python3';
  const [pyVersion, machine] = execFileSync(python, ['-c', 'import sys, platform; print("%d.%d" % sys.version_info[:2], platform.machine())'], { encoding: 'utf8' }).trim().split(' ');
  if (pyVersion !== LOCK_PYTHON || machine !== LOCK_PLATFORM.split('-')[0]) {
    console.error(`the locks are for Python ${LOCK_PYTHON} on ${LOCK_PLATFORM}; ${python} is Python ${pyVersion} on ${machine} — change LOCK_PYTHON / LOCK_PLATFORM in src/dbt/environment-specs.js and re-lock`);
    process.exit(1);
  }
  const target = join(dir, name);
  mkdirSync(dir, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  step(python, ['-m', 'venv', target]);
  const pip = (args) => step(join(target, 'bin', 'python'), ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-cache-dir', '--require-hashes', '--no-deps', ...args]);
  // 1. the locked installer, checked by the venv's own pip — and nothing else the venv came with
  //    (Python 3.11's venv also brings a setuptools of its own): what an environment holds is its lock
  pip(['--only-binary', ':all:', '-r', join(ROOT, INSTALLER_LOCK)]);
  const locked = lockedPackages(join(ROOT, lock));
  const bundled = [...installedPackages(target).keys()].filter((pkg) => pkg !== 'pip' && !locked.has(pkg));
  if (bundled.length) step(join(target, 'bin', 'python'), ['-m', 'pip', 'uninstall', '--quiet', '--yes', '--disable-pip-version-check', ...bundled]);
  // 2. exactly the locked files: each one's hash checked, nothing unlisted, wheels only…
  const sources = new Set(spec.sourceBuilds || []);
  const { picked: fromSource, rest: wheels } = splitLock(join(ROOT, lock), (pkg) => sources.has(pkg));
  const work = mkdtempSync(join(tmpdir(), 'dbt-env-'));
  writeFileSync(join(work, 'wheels.txt'), `${wheels.join('\n')}\n`);
  pip(['--only-binary', ':all:', '-r', join(work, 'wheels.txt')]);
  // 3. …and the few the spec names as source-only, built from their hash-checked source with the
  //    locked build tools just installed (no isolated build fetching tools of its own)
  if (fromSource.length) {
    writeFileSync(join(work, 'sources.txt'), `${fromSource.join('\n')}\n`);
    pip(['--no-binary', [...sources].join(','), '--no-build-isolation', '-r', join(work, 'sources.txt')]);
  }
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(target, 'mcp-env.json'), `${JSON.stringify({ name, adapter, lock, packages: environmentPackages(name, adapter) }, null, 2)}\n`);
  const problems = verify(name);
  if (problems.length) { console.error(`${name}: built, but it does not match ${lock}:\n  ${problems.join('\n  ')}`); process.exit(1); }
  const made = listEnvironments({ dir }).find((x) => x.name === name);
  const what = made?.mfBin ? `MetricFlow at ${made.mfBin}` : `dbt ${versionOf(made.dbtBin)} at ${made.dbtBin}`;
  console.log(`${name}${adapter ? ` (${adapter})` : ''}: ${what} — installed exactly ${lock}`);
} else if (cmd === 'verify') {
  const names = positional.length ? positional : listEnvironments({ dir }).map((e) => e.name);
  let bad = 0;
  for (const name of names) {
    const problems = verify(name);
    if (problems.length) bad += 1;
    console.log(problems.length ? `${name}: DOES NOT MATCH its lock\n  ${problems.join('\n  ')}` : `${name}: matches its lock`);
  }
  process.exit(bad ? 1 : 0);
} else if (cmd === 'lock') {
  const uv = flag('--uv') || 'uv';
  mkdirSync(join(ROOT, 'config', 'dbt-environments'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'dbt-lock-'));
  const curl = (url, out) => { const r = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', out, url], { stdio: 'inherit' }); if (r.status !== 0) { console.error(`could not download ${url}`); process.exit(1); } };
  const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  // A download-at-install sdist (spec.wheelsFromSdist): its version's sdist from PyPI, checked
  // against PyPI's digest; the assets.json inside names the wheel of every platform with its SHA-256.
  // The requirement becomes that wheel for the lock platform, and the lock must carry that SHA-256.
  const wheelFromSdist = (pin) => {
    const [name, version] = pin.split('==');
    if (!version) { console.error(`${pin}: a wheelsFromSdist package is pinned name==version`); process.exit(1); }
    curl(`https://pypi.org/pypi/${name}/${version}/json`, join(work, 'pypi.json'));
    const sdist = JSON.parse(readFileSync(join(work, 'pypi.json'), 'utf8')).urls.find((u) => u.packagetype === 'sdist');
    if (!sdist) { console.error(`${pin}: PyPI has no sdist`); process.exit(1); }
    const archive = join(work, sdist.filename);
    curl(sdist.url, archive);
    if (sha256(archive) !== sdist.digests.sha256) { console.error(`${sdist.filename}: SHA-256 differs from PyPI's`); process.exit(1); }
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').find((f) => f.endsWith('/assets.json'));
    if (!listing) { console.error(`${sdist.filename}: no assets.json — not a download-at-install sdist`); process.exit(1); }
    const assets = JSON.parse(execFileSync('tar', ['-xzOf', archive, listing], { encoding: 'utf8' }));
    const wheel = assets.wheels?.[LOCK_WHEEL_TAG];
    if (assets.version !== version || !wheel) { console.error(`${sdist.filename}: no ${version} wheel for ${LOCK_WHEEL_TAG}`); process.exit(1); }
    return { name, requirement: `${name} @ ${assets.base_url.replace(/\/$/, '')}/${wheel.filename}`, sha256: wheel.sha256 };
  };
  const compile = (label, pins, out, fromSdist = []) => {
    const wheels = pins.filter((p) => fromSdist.includes(normal(p.split('==')[0]))).map(wheelFromSdist);
    const packages = pins.map((p) => wheels.find((w) => normal(w.name) === normal(p.split('==')[0]))?.requirement || p);
    const input = join(work, 'in.txt');
    writeFileSync(input, `${packages.join('\n')}\n`);
    // resolved afresh: uv keeps the pins (and hashes) of an existing output file
    rmSync(join(ROOT, out), { force: true });
    // one version of every package for the lock platform, with the hash of each of its files
    const r = spawnSync(uv, ['pip', 'compile', input, '--generate-hashes', '--python-version', LOCK_PYTHON, '--python-platform', LOCK_PLATFORM, '--no-header', '--no-annotate', '--quiet', '-o', join(ROOT, out)], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
    const body = readFileSync(join(ROOT, out), 'utf8');
    for (const w of wheels) {
      if (!body.includes(`${w.requirement} \\\n    --hash=sha256:${w.sha256}\n`)) { console.error(`${out}: ${w.name} is not locked to the wheel its sdist names (${w.sha256})`); process.exit(1); }
    }
    writeFileSync(join(ROOT, out), `# ${label} — generated by \`node scripts/dbt-env.mjs lock\` from src/dbt/environment-specs.js\n# for Python ${LOCK_PYTHON} on ${LOCK_PLATFORM}. Do not edit: change the spec and re-lock.\n${body}`);
    console.log(`locked ${out}`);
  };
  compile('the installer', INSTALLER, INSTALLER_LOCK);
  for (const [name, spec] of Object.entries(ENVIRONMENT_SPECS)) {
    for (const adapter of spec.packages ? [null] : Object.keys(spec.adapters)) {
      compile(`${name}${adapter ? ` (${adapter})` : ''}`, environmentPackages(name, adapter), lockFile(name, adapter), spec.wheelsFromSdist);
    }
  }
  rmSync(work, { recursive: true, force: true });
} else if (cmd === 'list' || !cmd) {
  const all = listEnvironments({ dir });
  if (!all.length) console.log(`no dbt environments in ${dir} — build one: node scripts/dbt-env.mjs create dbt-v2`);
  for (const e of all) {
    const meta = readMeta(e.dir);
    const tag = meta ? `${meta.adapter ? `${meta.adapter}, ` : ''}${verify(e.name).length ? 'DRIFTED from its lock' : 'matches its lock'}` : 'not built by this tool';
    if (e.mfBin) { console.log(`${e.name.padEnd(12)} MetricFlow (mf)${e.dbtBin ? ` on dbt-core ${versionOf(e.dbtBin)}` : ''} — ${tag}`); continue; }
    let mf = '';
    try { mf = resolveEnvironment(e.name, { dir }).metricflowFrom; } catch (err) { mf = `! ${err.message}`; }
    console.log(`${e.name.padEnd(12)} dbt ${versionOf(e.dbtBin).padEnd(10)} queries with MetricFlow from: ${mf || '-'} — ${tag}`);
  }
} else {
  console.error(`unknown command '${cmd}' (create | verify | list | lock)`);
  process.exit(2);
}
