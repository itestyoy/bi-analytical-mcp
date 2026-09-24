// dbt ENVIRONMENTS — every dbt this server runs lives in a virtualenv of its own, by name.
//
// An environment is a directory under DBT_ENVS_DIR (default: ./.venvs; the image: /opt/dbt-envs)
// holding a Python virtualenv. A dbt environment has a `dbt` in bin/: `default` is the one used
// unless DBT_ENV names another (`dbt1`, …). Each may carry a different dbt — v2 in one, 1.x in
// another — and the dbt client reads the version from the binary (src/dbt/index.js).
//
// METRICFLOW IS AN ENVIRONMENT OF ITS OWN — `metricflow`, unless MF_ENV names another. dbt's docs,
// for a setup without the dbt platform: "install MetricFlow separately and use the mf prefix". Its
// `mf` reads the semantic_manifest.json that the chosen dbt environment's `dbt parse` wrote, and the
// MetricFlow sidecar runs on its Python. It cannot share a venv with a dbt v2 binary: dbt-metricflow
// brings the Python dbt-core, whose own `dbt` command would replace it. (An environment that carries
// its own `mf` — a single all-in-one venv — uses it when there is no MetricFlow environment.)
//
// Create them with `npm run dbt:env -- create <name> -r <requirements file>` (scripts/dbt-env.mjs).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_ENV = 'default';
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
 * The dbt environment `name` (DBT_ENV, else `default`) ready to run: { name, dir, dbtBin, mfBin,
 * pythonBin, metricflowFrom } — `mfBin` / `pythonBin` from the MetricFlow environment (MF_ENV, else
 * `metricflow`), or from this environment when it carries its own `mf` and there is no MetricFlow
 * environment. Throws, naming what exists, when there is no such dbt environment or a MetricFlow
 * environment was named and is not there.
 */
export function resolveEnvironment(name, { dir = envsDir(), env = process.env } = {}) {
  const wanted = name || env.DBT_ENV || DEFAULT_ENV;
  const all = listEnvironments({ dir });
  const e = all.find((x) => x.name === wanted);
  if (!e || !e.dbtBin) {
    const have = all.filter((x) => x.dbtBin).map((x) => x.name);
    throw new Error(`dbt environment '${wanted}' not found in ${dir}${have.length ? ` (there: ${have.join(', ')})` : ' (none there)'} — create it with: npm run dbt:env -- create ${wanted} -r <requirements file>`);
  }
  const mfName = env.MF_ENV || DEFAULT_MF_ENV;
  const mf = all.find((x) => x.name === mfName && x.mfBin);
  if (mf) return { ...e, mfBin: mf.mfBin, pythonBin: mf.pythonBin, metricflowFrom: mf.name };
  if (env.MF_ENV) throw new Error(`MetricFlow environment '${env.MF_ENV}' not found in ${dir} (or it has no mf) — create it with: npm run dbt:env -- create ${env.MF_ENV} -r requirements-metricflow.txt`);
  if (e.mfBin) return { ...e, metricflowFrom: e.name };
  return { ...e, mfBin: null, metricflowFrom: null };
}
