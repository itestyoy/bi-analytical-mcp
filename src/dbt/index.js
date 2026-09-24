// THE dbt CLIENT — one set of methods over dbt, whatever its version. The engine, the value index
// and the MetricFlow sidecar talk to dbt ONLY through this contract; what a given dbt version needs
// (its CLI, its output format, how metrics are queried) lives in its own implementation next to it.
//
//   parse(projectDir)                     → { ok, stdout, stderr, manifest }   (semantic manifest written?)
//   run(projectDir, select)               → { ok, stdout, stderr, error?, cancelled? }
//   seed(projectDir)                      → { ok, stdout, stderr, error? }
//   show(projectDir, sql, limit, timeout) → { ok, rows, columns, stdout?, stderr?, error? }
//   relationColumns(projectDir, model)    → { ok, columns: [{ name, dtype }] }
//   query(projectDir, opts)               → { ok, command, columns, rows } | explain: { ok, sql, plan? }
//   validate(projectDir)                  → { ok, stdout, stderr }
//   warehouse(projectDir)                 → { adapter, singleWriter, turn }
//   semanticSpec                          → 'legacy' | 'latest'   (the semantic YAML this dbt reads)
//   pythonModelsOn(adapter)               → can this dbt run Python models there
//
// Every method takes the project it works on (a context's overlay project) and never throws for a
// dbt failure: `ok: false` with what dbt printed. The cancellation of the call or task in progress
// stops its process (src/request-context.js), and a warehouse that takes one process at a time is
// given one (src/dbt/process.js).
//
// Implemented: dbt 1.x (src/dbt/v1.js) and dbt v2 (src/dbt/v2.js, the latest semantic YAML spec).

import { DbtV1 } from './v1.js';
import { DbtV2 } from './v2.js';
import { resolveEnvironment } from './environments.js';

export { resolveEnvironment, listEnvironments, envsDir, DEFAULT_ENV, DEFAULT_MF_ENV } from './environments.js';

export { formatDbtError, parseShowJson, parseCsv } from './output.js';
export { dbtVersion } from './version.js';
import { dbtVersion } from './version.js';

const IMPLEMENTATIONS = { 1: DbtV1, 2: DbtV2 };

/** The major version of the dbt CLI at `dbtBin` (`dbt --version`), or null when it cannot be told. */
const detected = new Map(); // a binary's version does not change while the server runs

export function detectDbtMajor(dbtBin) {
  if (detected.has(dbtBin)) return detected.get(dbtBin);
  const major = askVersion(dbtBin);
  if (major != null) detected.set(dbtBin, major);
  return major;
}

function askVersion(dbtBin) {
  const version = dbtVersion(dbtBin);
  return version ? Number(version.split('.')[0]) : null;
}


/**
 * The dbt client for `version` (a major version, or 'auto' — the default — to ask the CLI), in the
 * dbt `environment` named (a venv under DBT_ENVS_DIR) or with the binaries given. An unsupported version is
 * refused here, with what it would take — never half-served.
 */
export function createDbt({ version = 'auto', environment, ...opts } = {}) {
  // a named environment (src/dbt/environments.js) supplies the binaries; explicit ones still win
  let env = null;
  if (environment) {
    env = typeof environment === 'string' ? resolveEnvironment(environment) : environment;
    opts = { dbtBin: env.dbtBin, ...(env.mfBin ? { mfBin: env.mfBin } : {}), ...opts };
  }
  const major = version === 'auto' ? detectDbtMajor(opts.dbtBin) ?? 1 : Number(version);
  const Impl = IMPLEMENTATIONS[major];
  if (!Impl) {
    throw new Error(`dbt ${major}.x is not supported by this server (supported: ${Object.keys(IMPLEMENTATIONS).map((v) => `${v}.x`).join(', ')}).`);
  }
  // nothing is taken from PATH: a dbt comes from an environment (or, for a test, is named)
  if (!opts.dbtBin) throw new Error('no dbt to run: name a dbt environment (createDbt({ environment })) — nothing is taken from PATH');
  const client = new Impl(opts);
  if (env) client.environment = { name: env.name, dir: env.dir, metricflowFrom: env.metricflowFrom, pythonBin: env.pythonBin };
  return client;
}
