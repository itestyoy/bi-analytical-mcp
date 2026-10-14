// Every temporary directory the tests and the evals make: `tempDir(prefix)` makes it under the system
// temp dir and removes it when the process that made it ends — for a test file, when the file ends
// (node --test runs each file in a process of its own). Nothing made here outlives its run.
//
// The removal waits for the process's 'exit', not for an after() hook, for two reasons:
//   * by then every hook of the file has run — the after() hooks that close an engine's store or stop
//     the warehouse — and the event loop is empty, so no dbt / MetricFlow process is still writing
//     into a directory when it goes;
//   * an after() registered by a helper called inside a before() hook belongs to that hook and runs
//     as soon as it ends — the workspace a before() sets up would be gone before the first test.
// A caller that is done with a directory sooner (an eval case, the warehouse) removes it with
// removeTempDir, after closing what holds files in it.
//
// Around them, ONE TEMPORARY DIRECTORY PER RUN — of the test runner (scripts/run-tests.mjs) and of an
// eval (evals/harness.mjs startEval): `runTempDir()` makes it the run's TMPDIR, which every process of
// the run inherits — each test file's, and the dbt, MetricFlow and Python processes under it — so what
// a run makes in the temporary directory and no tempDir() removed (a process's own files, a file a test
// killed part-way left) goes with it when the run ends. A run killed before it could remove its
// directory (SIGKILL, an eval stopped with Ctrl-C) leaves it behind; the next run that starts removes
// it — a directory whose run's process is gone, never the directory of a run still going.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set();

/** Remove a directory tempDir made, now. Close what holds files in it (a store, an engine) first. */
export function removeTempDir(dir) {
  made.delete(dir);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the exit must not fail on it */ }
}

process.once('exit', () => { for (const dir of [...made]) removeTempDir(dir); });

/** A fresh directory `<tmpdir>/<prefix>-XXXXXX`, removed when this process ends. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tempRoot(), `${prefix}-`));
  made.add(dir);
  return dir;
}

/** Where tempDir makes its directories (the process's TMPDIR) — to read what a run leaves there. */
export function tempRoot() {
  return tmpdir();
}

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
