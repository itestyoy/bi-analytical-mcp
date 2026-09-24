// The dbt the integration tests run: an ENVIRONMENT (src/dbt/environments.js — a venv under
// .venvs, or DBT_ENVS_DIR), `default` unless DBT_ENV names another. DBT_BIN / MF_BIN / PYTHON_BIN
// still override one binary each. A file that needs a particular dbt (the python stage: dbt 1.x)
// asks for its environment by name with dbtEnv().

import { existsSync } from 'node:fs';
import { resolveEnvironment } from '../../src/dbt/environments.js';

/** The environment `name`, or null when it is not there (the file then skips). */
export function dbtEnv(name) {
  try { return resolveEnvironment(name); } catch { return null; }
}

const ENV = dbtEnv(process.env.DBT_ENV || 'default');
export const DBT_BIN = process.env.DBT_BIN || ENV?.dbtBin || '';
export const MF_BIN = process.env.MF_BIN || ENV?.mfBin || '';
export const PY_BIN = process.env.PYTHON_BIN || ENV?.pythonBin || '';
export const HAS_DBT = !!(DBT_BIN && MF_BIN && existsSync(DBT_BIN) && existsSync(MF_BIN));
