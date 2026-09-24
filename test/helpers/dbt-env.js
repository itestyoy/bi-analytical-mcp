// The dbt the integration tests run: an ENVIRONMENT (src/dbt/environments.js — a venv under
// .venvs, or DBT_ENVS_DIR), `dbt-v2` unless DBT_ENV names another — built from its lock with
// `npm run dbt:env -- create <name>`, the same as the image. A file that needs a particular dbt (the python stage: dbt 1.x)
// asks for its environment by name with dbtEnv().

import { existsSync } from 'node:fs';
import { resolveEnvironment, DEFAULT_ENV } from '../../src/dbt/environments.js';

/** The environment `name`, or null when it is not there (the file then skips). */
export function dbtEnv(name) {
  try { return resolveEnvironment(name); } catch { return null; }
}

const ENV = dbtEnv(process.env.DBT_ENV || DEFAULT_ENV);
export const DBT_BIN = ENV?.dbtBin || '';
export const MF_BIN = ENV?.mfBin || '';
export const PY_BIN = ENV?.pythonBin || '';
export const HAS_DBT = !!(DBT_BIN && MF_BIN && existsSync(DBT_BIN) && existsSync(MF_BIN));
