// The dbt the integration tests run: an ENVIRONMENT (src/dbt/environments.js — a venv under
// .venvs, or DBT_ENVS_DIR), `dbt-v2` unless DBT_ENV names another (TEST_ENV below) — built from its lock with
// `npm run dbt:env -- create <name>`, the same as the image. A file that needs a particular dbt (the python stage: dbt 1.x)
// asks for its environment by name with dbtEnv().

import { existsSync } from 'node:fs';
import { resolveEnvironment } from '../../src/dbt/environments.js';
import { createDbt } from '../../src/dbt/index.js';

/**
 * The environment `name`, or null when it is not built (the file then skips). One that IS there but
 * is refused — built with other versions than the spec names, or not by this tool — throws: a stale
 * .venvs must fail the run, not skip every data test as "not installed".
 */
export function dbtEnv(name) {
  try { return resolveEnvironment(name); } catch (e) {
    if (/ not found in /.test(e.message)) return null;
    throw e;
  }
}

/**
 * The environment the tests run on: DBT_ENV, else `dbt-v2` — not the server's DEFAULT_ENV, which stays
 * `dbt-v1` only for BigQuery's sake (src/dbt/environments.js): on the DuckDB fixtures dbt v2 answers
 * each call several times faster, and the server a test builds in this process (makeEngine reads
 * DBT_ENV) runs on the same one.
 */
export const TEST_ENV = process.env.DBT_ENV || 'dbt-v2';
process.env.DBT_ENV = TEST_ENV;
const ENV = dbtEnv(TEST_ENV);
export const DBT_BIN = ENV?.dbtBin || '';
export const MF_BIN = ENV?.mfBin || '';
export const PY_BIN = ENV?.pythonBin || '';
export const HAS_DBT = !!(DBT_BIN && MF_BIN && existsSync(DBT_BIN) && existsSync(MF_BIN));

/**
 * The dbt client the SERVER runs (src/server.js makeEngine → createDbt), over this environment: a
 * data test proves the numbers of the path production queries through — `mf query` and its CSV,
 * `dbt show` and its JSON — not those of a client only the tests use.
 */
export function testDbt({ profilesDir, timeout = 600000 } = {}) {
  return createDbt({ environment: ENV, profilesDir, timeout });
}
