// Files the SERVER needs at run time that are not JavaScript — and therefore do not arrive by
// `import`. Nothing links to them, so a build that copies only `src/` looks complete and fails
// later, at the first call that shells out to one:
//
//   ast gate failed (python3 exit 2): can't open file '/app/python/ast_gate.py'
//
// The path was right; the file was never in the image. So the set is declared HERE, once, and
// every consumer resolves its path through it — which gives the build check something to read
// (test/unit/runtime-assets.test.js asserts each one exists AND that the image copies it) and lets
// a missing file be reported as what it is: a packaging defect, not a bad request.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RUNTIME_ASSETS = {
  astGate: {
    path: join(ROOT, 'python', 'ast_gate.py'),
    repoPath: 'python/ast_gate.py',
    why: 'the static gate over a python stage\'s function bodies — without it no python stage can be admitted',
  },
  systemRecipes: {
    path: join(ROOT, 'config', 'recipes.json'),
    repoPath: 'config/recipes.json',
    why: 'the SYSTEM recipes — the technical, universal task templates every deployment gets, merged under the deployment\'s own file (RECIPES_PATH). Resolved from the server\'s directory so it survives being started from another cwd.',
  },
  mfSidecar: {
    path: join(ROOT, 'python', 'mf_sidecar.py'),
    repoPath: 'python/mf_sidecar.py',
    why: 'the warm MetricFlow process the mf-engine backend talks to over stdio',
  },
};

/** The asset's absolute path, or null when it is not in this build. */
export function assetPath(name) {
  const a = RUNTIME_ASSETS[name];
  if (!a) throw new Error(`unknown runtime asset '${name}'`);
  return existsSync(a.path) ? a.path : null;
}

/** Why a missing asset is not the caller's fault, said in one sentence they can act on. */
export function missingAssetMessage(name) {
  const a = RUNTIME_ASSETS[name];
  return `${a.repoPath} is missing from this installation (expected at ${a.path}) — ${a.why}. `
    + 'This is a PACKAGING defect, not a problem with the request or the data: the build shipped '
    + `src/ without ${a.repoPath.split('/')[0]}/. Rebuild the image with that directory included.`;
}
