// dbt ENVIRONMENTS — every dbt this server runs lives in a virtualenv of its own, by name.
//
// An environment is a directory under DBT_ENVS_DIR (default: ./.venvs; the image: /opt/dbt-envs)
// holding a Python virtualenv, named for what is in it: `dbt-v2` (dbt v2 — used unless DBT_ENV names
// another), `dbt-v1` (dbt 1.x), `metricflow`. The dbt client reads the version from the binary
// (src/dbt/index.js), so the name is for the reader, not a switch.
//
// METRICFLOW IS AN ENVIRONMENT OF ITS OWN — `metricflow`, unless MF_ENV names another. dbt's docs,
// for a setup without the dbt platform: "install MetricFlow separately and use the mf prefix". Its
// `mf` reads the semantic_manifest.json that the chosen dbt environment's `dbt parse` wrote, and the
// MetricFlow sidecar runs on its Python. It cannot share a venv with a dbt v2 binary: dbt-metricflow
// brings the Python dbt-core, whose own `dbt` command would replace it.
//
// ONLY OUR ENVIRONMENTS RUN. A name must be one src/dbt/environment-specs.js defines, and the
// spec's `role` must be the one it is asked for (DBT_ENV: dbt, MF_ENV: metricflow), and the
// directory must have been built by `npm run dbt:env -- create <name>`
// (scripts/dbt-env.mjs — in the image, at `docker build`) from that spec as it is now: its
// mcp-env.json names the pip and the exact packages it was built with. A venv put there by hand, or built from
// other versions, is refused — as is any dbt named from outside (the server has no DBT_BIN / MF_BIN /
// PYTHON_BIN and no PATH fallback).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ENVIRONMENT_SPECS, environmentBuild } from './environment-specs.js';

/**
 * Why the environment directory `envDir` is not the one this tool builds as `name` for `role`
 * (`dbt` | `metricflow`) — null when it is: defined for that role, and built by `create` with the
 * pip and the packages the spec names now.
 */
export function notOurs(name, envDir, role) {
  const spec = ENVIRONMENT_SPECS[name];
  if (!spec) return `'${name}' is not an environment this tool defines (defined: ${Object.keys(ENVIRONMENT_SPECS).join(', ')} — src/dbt/environment-specs.js)`;
  if (role && spec.role !== role) return `'${name}' is a ${spec.role} environment, not a ${role} one (${role} environments: ${Object.keys(ENVIRONMENT_SPECS).filter((n) => ENVIRONMENT_SPECS[n].role === role).join(', ')})`;
  let meta;
  try { meta = JSON.parse(readFileSync(join(envDir, 'mcp-env.json'), 'utf8')); } catch { return `'${name}' in ${dirname(envDir)} was not built by this tool (no mcp-env.json) — build it with: npm run dbt:env -- create ${name}`; }
  const wanted = environmentBuild(name);
  const had = { installer: meta.installer, packages: [...(meta.packages || [])].sort() };
  if (meta.name !== name || JSON.stringify(had) !== JSON.stringify(wanted)) {
    return `'${name}' in ${dirname(envDir)} was built with ${[had.installer, ...had.packages].filter(Boolean).join(' ') || 'other packages'}, the spec says ${[wanted.installer, ...wanted.packages].join(' ')} — rebuild it with: npm run dbt:env -- create ${name}`;
  }
  return null;
}

export const DEFAULT_ENV = 'dbt-v2';
export const DEFAULT_MF_ENV = 'metricflow';

/** Where the environments live. */
export function envsDir(env = process.env) {
  return resolve(env.DBT_ENVS_DIR || join(process.cwd(), '.venvs'));
}

const binOf = (dir, name) => { const p = join(dir, 'bin', name); return existsSync(p) ? p : null; };

/** Every environment under `dir`: { name, dir, dbtBin, mfBin, pythonBin } (a null bin: not in it). */
export function listEnvironments({ dir = envsDir() } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => { try { return statSync(join(dir, name)).isDirectory(); } catch { return false; } })
    .map((name) => {
      const d = join(dir, name);
      return { name, dir: d, dbtBin: binOf(d, 'dbt'), mfBin: binOf(d, 'mf'), pythonBin: binOf(d, 'python') };
    })
    .filter((e) => e.dbtBin || e.mfBin)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The dbt environment `name` (DBT_ENV, else `dbt-v2`) ready to run: { name, dir, dbtBin, mfBin,
 * pythonBin, metricflowFrom } — `mfBin` / `pythonBin` from the MetricFlow environment (MF_ENV, else
 * `metricflow`). Throws, naming what to do, when either is missing or is not one of ours.
 */
export function resolveEnvironment(name, { dir = envsDir(), env = process.env } = {}) {
  const wanted = name || env.DBT_ENV || DEFAULT_ENV;
  const all = listEnvironments({ dir });
  const e = all.find((x) => x.name === wanted);
  if (!e || !e.dbtBin) {
    const have = all.filter((x) => x.dbtBin).map((x) => x.name);
    throw new Error(`dbt environment '${wanted}' not found in ${dir}${have.length ? ` (there: ${have.join(', ')})` : ' (none there)'} — create it with: npm run dbt:env -- create ${wanted}`);
  }
  const theirs = notOurs(wanted, e.dir, 'dbt');
  if (theirs) throw new Error(`dbt environment refused: ${theirs}`);
  const mfName = env.MF_ENV || DEFAULT_MF_ENV;
  const mf = all.find((x) => x.name === mfName && x.mfBin);
  if (!mf) throw new Error(`MetricFlow environment '${mfName}' not found in ${dir} (or it has no mf) — create it with: npm run dbt:env -- create ${mfName}`);
  const mfTheirs = notOurs(mfName, mf.dir, 'metricflow');
  if (mfTheirs) throw new Error(`MetricFlow environment refused: ${mfTheirs}`);
  return { ...e, mfBin: mf.mfBin, pythonBin: mf.pythonBin, metricflowFrom: mf.name };
}
