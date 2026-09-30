// THE dbt PROJECT AND ITS PROFILE — the model paths and files a project declares, the macros it must
// carry, the warehouse (dialect) its profile targets, and whether that warehouse runs Python models
// (the python stage is offered only where it does).

import yaml from 'js-yaml';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SUPPORTED_DIALECTS } from '../dialect.js';
import { setting } from '../settings.js';

/** A configured path list from dbt_project.yml (e.g. model-paths), with a default. */
export function readPaths(projectDir, key, dflt) {
  try {
    const dp = yaml.load(readFileSync(join(projectDir, 'dbt_project.yml'), 'utf8')) || {};
    const v = dp[key] ?? dflt;
    return Array.isArray(v) ? v : [v];
  } catch {
    return dflt;
  }
}

export function readModelPaths(projectDir) {
  return readPaths(projectDir, 'model-paths', readPaths(projectDir, 'source-paths', ['models']));
}

/** Basenames (without extension) of files matching `extRe` under the given dirs. */
export function collectBasenames(projectDir, paths, extRe, acc = new Set()) {
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extRe.test(e.name)) acc.add(e.name.replace(extRe, ''));
    }
  };
  for (const mp of paths) walk(join(projectDir, mp));
  return acc;
}

/** Concatenated text of every .sql under the given dirs (for macro scanning). */
export function readAllSql(projectDir, paths) {
  let text = '';
  const walk = (dir) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.sql$/i.test(e.name)) { try { text += `\n${readFileSync(p, 'utf8')}`; } catch { /* skip */ } }
    }
  };
  for (const mp of paths) walk(join(projectDir, mp));
  return text;
}

// dbt macros the server shells out to (run-operation) and therefore REQUIRES.
export const REQUIRED_MACROS = ['mcp_relation_columns'];

/**
 * Validate that a dbt project implements the components the server needs:
 *   - dbt_project.yml present
 *   - the required macro(s) defined (column introspection)
 *   - each catalog role's dbt node exists as a model (.sql) or seed (.csv)
 * Throws a single, actionable error listing everything missing.
 */
export function validateDbtProject(projectDir, catalog) {
  const problems = [];
  if (!existsSync(join(projectDir, 'dbt_project.yml'))) problems.push('dbt_project.yml not found (is this a dbt project?)');

  const macroText = readAllSql(projectDir, readPaths(projectDir, 'macro-paths', ['macros']));
  for (const name of REQUIRED_MACROS) {
    if (!new RegExp(`macro\\s+${name}\\s*\\(`).test(macroText)) {
      problems.push(`required macro '${name}' is not defined (needed for warehouse column introspection)`);
    }
  }

  const nodes = collectBasenames(projectDir, readModelPaths(projectDir), /\.sql$/i);
  collectBasenames(projectDir, readPaths(projectDir, 'seed-paths', ['seeds']), /\.csv$/i, nodes);
  for (const key of catalog.modelKeys()) {
    const name = catalog.getModel(key).dbt_model;
    if (name && !nodes.has(name)) problems.push(`role '${key}' references dbt node '${name}', which is not a model (.sql) or seed (.csv) in the project`);
  }

  if (problems.length) {
    throw new Error(`dbt project at ${projectDir} is missing required components:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Recursively collect `models:` entries from every *.yml/*.yaml under dir. */
export function collectSchemaModels(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { collectSchemaModels(p, acc); continue; }
    if (!/\.ya?ml$/i.test(e.name)) continue;
    try {
      const doc = yaml.load(readFileSync(p, 'utf8'));
      if (Array.isArray(doc?.models)) for (const m of doc.models) if (m && m.name) acc.push(m);
    } catch { /* skip unparseable YAML */ }
  }
}

/**
 * Resolve the warehouse dialect (runtime config). Precedence:
 *   1. explicit `dialect` argument
 *   2. WAREHOUSE_DIALECT env var
 *   3. the active dbt profile's output `type` (what dbt actually connects with)
 *   4. `fallback` (legacy catalogs) / 'duckdb'
 */
export function resolveDialect({ dialect, profilesDir, projectDir, fallback, report } = {}) {
  const fromProfile = dialectFromProfile(profilesDir, projectDir);
  const d = dialect || setting('WAREHOUSE_DIALECT') || fromProfile || fallback || 'duckdb';
  if (!SUPPORTED_DIALECTS.has(d)) {
    throw new Error(`unsupported warehouse dialect '${d}' (supported: ${[...SUPPORTED_DIALECTS].join(', ')}). Set WAREHOUSE_DIALECT or fix the dbt profile output type.`);
  }
  // dbt connects with an adapter this server writes no SQL for (snowflake, redshift…), and nothing
  // said otherwise: the SQL is then written in `d`'s dialect against that engine. It may well work
  // — but it is a fact about this deployment, not a detail, so it is reported rather than assumed.
  const profileType = String(profileOutput(profilesDir, projectDir)?.type || '').toLowerCase();
  if (report && profileType && !fromProfile) report({ profile_type: profileType, rendering_as: d, explicit: !!(dialect || setting('WAREHOUSE_DIALECT')) });
  return d;
}

/** The ACTIVE output of the dbt profile (the connection dbt runs with), or undefined. */
export function profileOutput(profilesDir, projectDir) {
  try {
    let profileName;
    if (projectDir) {
      const pj = join(projectDir, 'dbt_project.yml');
      if (existsSync(pj)) profileName = yaml.load(readFileSync(pj, 'utf8'))?.profile;
    }
    const dir = profilesDir || setting('DBT_PROFILES_DIR') || join(homedir(), '.dbt');
    const pp = join(dir, 'profiles.yml');
    if (!existsSync(pp)) return undefined;
    const profiles = yaml.load(readFileSync(pp, 'utf8')) || {};
    const prof = (profileName && profiles[profileName]) || profiles[Object.keys(profiles).filter((k) => k !== 'config')[0]];
    if (!prof) return undefined;
    const target = setting('DBT_TARGET') || prof.target || Object.keys(prof.outputs || {})[0];
    return prof.outputs?.[target] || undefined;
  } catch {
    return undefined; // best-effort
  }
}

/**
 * The python submission the PROJECT configures. `submission_method` is a MODEL config, not a
 * profile setting — dbt's bigquery macro reads it with `config.get("submission_method",
 * "serverless")` and nothing else. So the profile's compute_region / gcs_bucket say who may submit
 * a job, never how: a project with those settings and no submission config runs on the DEFAULT
 * submission, which is how a BigFrames-shaped model ended up as a Dataproc job (a Colab notebook
 * holding PySpark code, or a 403 on dataproc.batches.create when that path is not granted).
 *
 * dbt_project.yml is therefore the authoritative place, and it nests: `models: <project>: <dir>:
 * +submission_method`. The value is taken from anywhere in that tree — the deepest one wins, since
 * a more specific path overrides a broader one in dbt, and this server writes the SAME value into
 * every python model it generates.
 */
export function submissionFromProject(projectDir) {
  if (!projectDir) return undefined;
  try {
    const pj = join(projectDir, 'dbt_project.yml');
    if (!existsSync(pj)) return undefined;
    const doc = yaml.load(readFileSync(pj, 'utf8')) || {};
    let found;
    const walk = (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      if (typeof node['+submission_method'] === 'string') found = node['+submission_method'];
      else if (typeof node.submission_method === 'string') found = node.submission_method;
      for (const v of Object.values(node)) walk(v);
    };
    walk(doc.models);
    return found;
  } catch {
    return undefined; // best-effort, like every other read of the operator's files
  }
}

/** Read the adapter `type` from the dbt profile (the dialect dbt runs with). */
export function dialectFromProfile(profilesDir, projectDir) {
  const type = profileOutput(profilesDir, projectDir)?.type;
  return type && SUPPORTED_DIALECTS.has(type) ? type : undefined;
}

/**
 * The adapter may run Python models while the installed dbt does not (dbt v2 on DuckDB): the dbt
 * client (src/dbt/) says so, and the python stage is then not offered. Applied to the catalog
 * before anything reads its python runtime (the recipes, the tool schemas).
 */
export function gatePythonRuntime(catalog, runner) {
  const rt = catalog.pythonRuntime;
  if (rt?.available && typeof runner?.pythonModelsOn === 'function' && !runner.pythonModelsOn(rt.runtime)) {
    catalog.pythonRuntime = { ...rt, available: false, reason: `dbt ${runner.major}.x runs no dbt Python models on ${rt.runtime}` };
  }
  return catalog.pythonRuntime;
}

/**
 * Can dbt run PYTHON models on this profile? Decided the way dbt itself would decide — from the
 * adapter and its settings in the active profile output — so the `python` pipeline stage is
 * offered only where it can actually run:
 *   - duckdb: the adapter runs Python models as such;
 *   - bigquery: only with a submission set up — `submission_method`, or a Dataproc/BigFrames region
 *     (`dataproc_region` / `compute_region`) or cluster (`dataproc_cluster_name`);
 *   - everything else: no Python models at all.
 * MCP_PYTHON_MODELS=on|off overrides (on: the operator sets the submission per model via
 * MCP_PYTHON_MODEL_CONFIG; off: hide the stage regardless). Returns { available, runtime?, reason? }.
 */
export function resolvePythonRuntime({ profilesDir, projectDir, env = process.env } = {}) {
  // The operator's settings are read ONCE, here, and travel on the runtime: the tool schema, the
  // stage's own validation and the compiled model then describe and do the same thing. (An embedder
  // may override `config` on the catalog before the schemas are built — see Engine.)
  let config = {};
  try { config = JSON.parse(env.MCP_PYTHON_MODEL_CONFIG || '{}'); } catch { /* an unparseable pin is no pin */ }
  const packages = String(env.MCP_PYTHON_PACKAGES || '');
  const decided = (r) => ({ ...r, config, packages });
  const force = String(env.MCP_PYTHON_MODELS || '').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(force)) return decided({ available: false, reason: 'disabled by MCP_PYTHON_MODELS=off' });
  // No gate script in this build — no python stage. Every body must pass the static gate before a
  // model is submitted, so without it the stage cannot be admitted at all: say that HERE, where it
  // takes the stage out of the tool schema, instead of letting a caller write one and fail on the
  // spawn. An operator's MCP_PYTHON_MODELS=on cannot override a file that is not there.
  if (!assetPath('astGate')) return decided({ available: false, reason: missingAssetMessage('astGate') });
  const out = profileOutput(profilesDir, projectDir);
  const type = String(out?.type || '').toLowerCase();
  if (/^(on|1|true|yes)$/.test(force)) return decided({ available: true, runtime: type || 'unknown', forced: true });
  if (!out) return decided({ available: false, reason: 'no dbt profile found — dbt Python models need an adapter that runs them (BigQuery with a submission set up, or DuckDB)' });
  if (type === 'duckdb') return decided({ available: true, runtime: type });
  if (type === 'bigquery') {
    // Where the submission comes from, most authoritative first:
    //   project  — dbt_project.yml `+submission_method`: a MODEL config, which is the only thing
    //              dbt's macro actually reads (config.get("submission_method", "serverless"));
    //   profile  — `submission_method` written in the profile output: not read by the macro, but
    //              an unambiguous statement of intent by the operator;
    //   inferred — only that method's SETTINGS are present (compute_region → bigframes,
    //              dataproc_region → serverless, a cluster name → cluster). A guess.
    // Whatever the source, the value is written into every generated model's dbt.config, so the
    // frame API the code is written against and the runtime it lands on cannot disagree — that
    // mismatch is what produced a Colab notebook full of PySpark, and a 403 on Dataproc.
    const fromProject = submissionFromProject(projectDir);
    const fromProfile = out.submission_method || null;
    const inferred = out.dataproc_cluster_name ? 'cluster' : (out.dataproc_region ? 'serverless' : (out.compute_region ? 'bigframes' : null));
    const method = fromProject || fromProfile || inferred;
    const method_source = fromProject ? 'dbt_project.yml' : (fromProfile ? 'profile' : (inferred ? 'inferred from the profile\'s settings' : null));
    if (method) return decided({ available: true, runtime: 'bigquery', method, method_source, method_declared: !!(fromProject || fromProfile) });
    return decided({ available: false, reason: 'the BigQuery profile has no Python submission set up: add submission_method (bigframes | serverless | cluster) with gcs_bucket and dataproc_region / compute_region to the profile output' });
  }
  return decided({ available: false, reason: `the '${type || 'unknown'}' adapter runs no dbt Python models` });
}
