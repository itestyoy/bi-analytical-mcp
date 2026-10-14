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

import { mkdtempSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  made.add(dir);
  return dir;
}
