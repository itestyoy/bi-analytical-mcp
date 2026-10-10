// THE dbt CLIENT — one set of methods over dbt, whatever its version. The engine, the value index
// and the MetricFlow group-by script talk to dbt ONLY through this contract; what a given dbt version needs
// (its CLI, its output format, how metrics are queried) lives in its own implementation next to it.
//
//   parse(projectDir)                     → { ok, stdout, stderr, manifest }   (semantic manifest written?)
//   run(projectDir, select, { empty })    → { ok, stdout, stderr, error?, cancelled? }  (empty: --empty, no data read)
//   seed(projectDir)                      → { ok, stdout, stderr, error? }
//   show(projectDir, sql, limit, timeout) → { ok, rows, columns, stdout?, stderr?, error? }
//   relationColumns(projectDir, model)    → { ok, columns: [{ name, dtype }] }  (the project's mcp_relation_columns
//                                           macro; dtype an array's own type — ARRAY<…> — not its element's)
//   query(projectDir, opts)               → { ok, command, columns, rows } | explain: { ok, sql, plan? }
//                                           (`mf query`, run by MetricFlow kept warm — below)
//   validate(projectDir)                  → { ok, stdout, stderr }  (`mf validate-configs`, a process of its own)
//   warehouse(projectDir)                 → { adapter, singleWriter, turn }
//   semanticSpec                          → 'legacy' | 'latest'   (the semantic YAML this dbt reads)
//   semanticManifest(projectDir)          → the semantic manifest the last parse wrote, or null
//   semanticModelSources(projectDir)      → { <semantic model>: <dbt model it reads> }
//   groupBys(projectDir, metrics)         → { ok, group_bys: { <metric>: [item] } }  (MetricFlow's list)
//   pythonModelsOn(adapter)               → can this dbt run Python models there
//   unparsedSqlConfig()                   → the config a model whose SQL dbt's parser cannot read needs
//
// Every method takes the project it works on (a context's overlay project) and never throws for a
// dbt failure: `ok: false` with what dbt printed. The cancellation of the call or task in progress
// stops its process (src/request-context.js), and a warehouse that takes one process at a time is
// given one (src/dbt/process.js).
//
// METRICFLOW IS KEPT WARM (src/dbt/metricflow-server.js → python/mf_server.py): a metric query, its
// compiled SQL and plan, and the list of what a metric can be grouped by are requests to a long-lived
// Python process on the MetricFlow environment — not a fresh `mf` each, whose start (imports, `dbt
// debug`, the manifest) is seconds against a query's tenth of one. It runs the CLI's own `query`
// command with the arguments built for the CLI, so its output and exit code are `mf query`'s, read
// back here exactly as before; it is the only way a metric query runs (no fallback to a process), and
// one that cannot start fails the query with the reason. It takes the warehouse's turn and the call's
// cancellation like a process (a stopped request kills its process: MetricFlow cannot interrupt a
// query), keeps each project's setup and manifest (reloaded when the file changes) and lets go of the
// warehouse after every request. It is shared by every client on that MetricFlow environment and lives
// as long as the server: idle, it holds neither the warehouse nor the event loop.
//
// Implemented: dbt 1.x (src/dbt/v1.js — the latest semantic YAML spec from 1.12, the legacy one
// before it) and dbt v2 (src/dbt/v2.js, the latest spec).

import { DbtV1 } from './v1.js';
import { DbtV2 } from './v2.js';
import { resolveEnvironment } from './environments.js';

export { resolveEnvironment, listEnvironments, envsDir, DEFAULT_ENV, DEFAULT_MF_ENV } from './environments.js';

export { formatDbtError, dbtFailure, parseShowJson, parseCsv } from './output.js';
export { dbtVersion } from './version.js';
import { knownDbtVersion } from './version.js';

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
  const version = knownDbtVersion(dbtBin);
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
    opts = { dbtBin: env.dbtBin, ...(env.mfBin ? { mfBin: env.mfBin } : {}), ...(env.pythonBin ? { pythonBin: env.pythonBin } : {}), ...opts };
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
