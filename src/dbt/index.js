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
//
// Every method takes the project it works on (a context's overlay project) and never throws for a
// dbt failure: `ok: false` with what dbt printed. The cancellation of the call or task in progress
// stops its process (src/request-context.js), and a warehouse that takes one process at a time is
// given one (src/dbt/process.js).
//
// Implemented: dbt 1.x (src/dbt/v1.js). dbt v2 is refused with the reason — see
// docs/DBT_V2_MIGRATION.md for what it needs (the new semantic-model YAML above all).

import { execFileSync } from 'node:child_process';
import { DbtV1 } from './v1.js';

export { formatDbtError, parseShowJson, parseCsv } from './output.js';

const IMPLEMENTATIONS = { 1: DbtV1 };

/** The major version of the dbt CLI at `dbtBin` (`dbt --version`), or null when it cannot be told. */
export function detectDbtMajor(dbtBin = 'dbt') {
  try {
    const out = execFileSync(dbtBin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const m = out.match(/installed:\s*(\d+)\.\d+/) || out.match(/\bdbt(?:-fusion)?\s+(\d+)\.\d+/i) || out.match(/(\d+)\.\d+\.\d+/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The dbt client for `version` (1, or 'auto' to ask the CLI; default 1). An unsupported version is
 * refused here, with what it would take — never half-served.
 */
export function createDbt({ version = 1, ...opts } = {}) {
  const major = version === 'auto' ? detectDbtMajor(opts.dbtBin) ?? 1 : Number(version);
  const Impl = IMPLEMENTATIONS[major];
  if (!Impl) {
    throw new Error(`dbt ${major}.x is not supported by this server yet (supported: ${Object.keys(IMPLEMENTATIONS).map((v) => `${v}.x`).join(', ')}). For dbt v2 see docs/DBT_V2_MIGRATION.md — it needs the new semantic-model YAML.`);
  }
  return new Impl(opts);
}
