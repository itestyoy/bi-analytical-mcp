// ONE TEMPORARY DIRECTORY PER RUN — of the test runner (scripts/run-tests.mjs) and of an eval
// (evals/harness.mjs startEval). It becomes the run's TMPDIR, which every process of the run inherits:
// a test file's, and the dbt, MetricFlow and Python processes under it. So everything a run makes in
// the temporary directory — a test's workspace and store, a fixture copy, a tool's own temporary
// files — is removed with it when the run ends. The tests do not remove what they make one by one,
// and a machine that kept running them filled its disk with what each run left.
//
// A run killed before it could remove its directory (SIGKILL, an eval stopped with Ctrl-C) leaves it
// behind; the next run that starts removes it — a directory whose run's process is gone, never the
// directory of a run still going.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN_DIR = /^mcp-run-(\d+)-/;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** The run's temporary directory, made and set as TMPDIR; removed when the process exits. */
export function runTempDir() {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    const pid = Number(RUN_DIR.exec(name)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* another user's: theirs to remove */ }
  }
  const dir = mkdtempSync(join(root, `mcp-run-${process.pid}-`));
  process.env.TMPDIR = dir;
  process.on('exit', () => {
    // a run stopped part-way may leave a dbt process still writing there: its directory then waits for
    // the next run's sweep, and the run's exit code stays its own
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the next run removes it */ }
  });
  return dir;
}
