// dbt ENVIRONMENTS — every dbt this server runs lives in a virtualenv of its own, by name.
//
// An environment is a directory under DBT_ENVS_DIR (default: ./.venvs; the image: /opt/dbt-envs)
// holding a Python virtualenv with a `dbt` in bin/: `default` is the one used unless DBT_ENV names
// another (`dbt1`, `bigquery`, …). Each may carry a different dbt — v2 in one, 1.x in another — and
// the dbt client reads the version from the binary (src/dbt/index.js).
//
// MetricFlow's `mf` (and the Python the MetricFlow sidecar runs on) is taken from the environment
// itself, or — for an environment without one, like a dbt v2 venv, whose `dbt` is a standalone
// binary — from another environment that has it (`dbt1` first, then any), since `mf` only reads the
// semantic manifest the chosen dbt writes.
//
// Create one with `npm run dbt:env -- create <name> -r <requirements file>` (scripts/dbt-env.mjs).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_ENV = 'default';

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
 * The environment `name` (DBT_ENV, else `default`) ready to run: { name, dir, dbtBin, mfBin,
 * pythonBin, metricflowFrom }. `mfBin`/`pythonBin` come from the environment itself or from the
 * one named in `metricflowFrom`. Throws, naming what exists, when there is no such environment.
 */
export function resolveEnvironment(name, { dir = envsDir(), env = process.env } = {}) {
  const wanted = name || env.DBT_ENV || DEFAULT_ENV;
  const all = listEnvironments({ dir });
  const e = all.find((x) => x.name === wanted);
  if (!e || !e.dbtBin) {
    const have = all.filter((x) => x.dbtBin).map((x) => x.name);
    throw new Error(`dbt environment '${wanted}' not found in ${dir}${have.length ? ` (there: ${have.join(', ')})` : ' (none there)'} — create it with: npm run dbt:env -- create ${wanted} -r <requirements file>`);
  }
  if (e.mfBin) return { ...e, metricflowFrom: e.name };
  const donor = [all.find((x) => x.name === 'dbt1'), ...all].find((x) => x?.mfBin && x.name !== e.name);
  return { ...e, mfBin: donor?.mfBin || null, pythonBin: donor?.pythonBin || e.pythonBin, metricflowFrom: donor?.name || null };
}
