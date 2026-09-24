// THE VERSION A dbt CLI REPORTS — the one reader of `dbt --version`, for the dbt client (which picks
// its implementation by the major version) and for scripts/dbt-env.mjs. It needs nothing but node, so
// the image's environment-building step can use it before the server's own dependencies exist.

import { execFileSync } from 'node:child_process';

/** The version the dbt CLI at `dbtBin` reports (`dbt --version`, e.g. '1.11.11'), or null. */
export function dbtVersion(dbtBin) {
  try {
    const out = execFileSync(dbtBin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    const m = out.match(/installed:\s*(\d+\.\d+(?:\.\d+)?)/) || out.match(/\bdbt(?:-fusion)?\s+(\d+\.\d+(?:\.\d+)?)/i) || out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
