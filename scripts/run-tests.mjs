#!/usr/bin/env node
// THE TEST RUNNER of `npm test`, `npm run test:integration`, `test:quick` and `test:all`: node's own
// runner (node:test run()), handed its files in an order of our choosing. `node --test` sorts its files
// by name whatever order they are listed in, so the longest file started a quarter of the way into the
// run and set its length; run() starts them in the order given. The slowest files go first, four side
// by side — within a file the work is serial (its dbt processes take turns on its one DuckDB file), so
// more files at once is the only parallelism there is.
//
// Every file runs in a process of its own. Measured on the unit files (4 cores, 733 tests): in ONE
// process (node's --experimental-test-isolation=none) they took 424 s against 186 s for node's default,
// a process per file with cores − 1 side by side — their tests are CPU work (an engine and its schemas
// each), which one process runs one at a time; in four shared processes 146 s against 162 s for a
// process per file four side by side — 10 % bought by making each test's result depend on what the
// files before it in its process left behind (a file that sets an environment variable for its own
// tests already breaks another's there). So a unit file keeps its process, one per core.
//
//   node scripts/run-tests.mjs unit                   every unit file (`npm test`)
//   node scripts/run-tests.mjs integration [name…]   every integration file, heaviest first — or only
//                                                     those whose file name contains one of the names
//   node scripts/run-tests.mjs quick                  the QUICK integration files, then the unit files
//   node scripts/run-tests.mjs all                    every integration file, then the unit files
//   --concurrency=<n>                                 files side by side (default 4; for `unit`, the
//                                                     machine's cores)
//   --test-name-pattern=<pattern>                     only the tests whose name matches, as in node --test
//
// The run has ONE fixture cache (MCP_TEST_FIXTURE_CACHE, test/integration/warehouse-harness.js): the
// fixture warehouse buildWarehouse() makes is built once, by the first file that asks for it, and
// copied into each file. It lives as long as the run, so no run reads what an earlier one built.
// The report is node's own — spec on a terminal, TAP otherwise — and the exit code is 1 when a test failed.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { run } from 'node:test';
import { spec, tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION = join(ROOT, 'test', 'integration');
const UNIT = join(ROOT, 'test', 'unit');

// Heaviest first, by each file's summed test time in a full run (its before() hook included: node
// charges a hook to the file's first test) — the minutes beside each, of the last run that measured it
// (a merged file: the sum of the files it absorbed, less the setup they each paid). A file not listed
// runs after these, in name order — list a new file here once a run shows what it takes.
const HEAVIEST_FIRST = [
  'retentioneering.test.js', // 10.9
  'retentioneering-steps.test.js', // 10.0
  'project-semantics.test.js', // 6.1
  'model-results.test.js', // ~4.2: materialize, behavior-funnels, ab-test, recipes-parse (4.5)
  'audit-regressions.test.js', // 3.7
  'pipeline-stages.test.js', // ~3.5: pipeline, pipeline-checkpoint, condition-grammar, match-recognize, crashlytics-complex-types, jinja-inert, duckdb-json-guard, scd-open-window (4.0)
  'analytics-tasks.test.js', // 3.3
  'declared-joins.test.js', // 3.0
  'python-stage.test.js', // 2.9
  'task-results.test.js', // 1.3
  'value-index.test.js', // 1.0
  'mcp-end-to-end.test.js', // 1.0
  'crashlytics-fact.test.js', // 0.9
  'batch-queries.test.js', // 0.9
  'acquisition-source.test.js', // 0.8
  'end-to-end.test.js', // 0.6
  'scd-e2e.test.js', // 0.5
];

// `npm run test:quick` — the checks to run while working (about 5 min with the unit files): the
// integration files that cover the most per minute. Declared joins and point-in-time on both sides,
// the MCP surface end to end, the value index, the task runtime with its reads and cards, every
// pipeline stage with funnels, time ranges, checkpoints and the one condition grammar, the second
// events source with its arrays and structs, the Jinja guard, a measures source, batches and cancel,
// the slowly-changing fixture. Only the full run has the retentioneering feature, the project's own
// semantic layer, the audit regressions, the semantic analytics tasks, the python stage, the crash
// fact and model-results (behavior funnels, materialize, the recipes and the A/B test).
const QUICK = [
  'declared-joins.test.js',
  'pipeline-stages.test.js',
  'task-results.test.js',
  'value-index.test.js',
  'mcp-end-to-end.test.js',
  'batch-queries.test.js',
  'acquisition-source.test.js',
  'end-to-end.test.js',
  'scd-e2e.test.js',
];

const USAGE = 'usage: node scripts/run-tests.mjs unit | integration [name…] | quick | all  [--concurrency=<n>] [--test-name-pattern=<pattern>]';

function refuse(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { mode: null, names: [], concurrency: null, testNamePatterns: [] };
  for (const arg of argv) {
    let m;
    if ((m = /^--concurrency=([1-9]\d*)$/.exec(arg))) args.concurrency = Number(m[1]);
    else if ((m = /^--test-name-pattern=(.+)$/.exec(arg))) args.testNamePatterns.push(m[1]);
    else if (arg.startsWith('-')) refuse(`unknown option ${arg}`);
    else if (!args.mode) args.mode = arg;
    else args.names.push(arg);
  }
  if (!['unit', 'integration', 'quick', 'all'].includes(args.mode)) refuse(`which tests: ${args.mode ?? 'none named'}`);
  if (args.names.length && args.mode !== 'integration') refuse(`only 'integration' takes file names (got ${args.names.join(' ')})`);
  // the unit files alone: one per core (measured 162 s on 4 cores, against 186 s at node's default of
  // one fewer); with the integration files, four, as their DuckDB and dbt processes are sized for
  args.concurrency ??= args.mode === 'unit' ? availableParallelism() : 4;
  return args;
}

const testFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

/** The integration files, heaviest first; those whose name contains one of `names` when any are given. */
function integrationFiles(names) {
  const present = testFiles(INTEGRATION);
  const ordered = [...HEAVIEST_FIRST.filter((f) => present.includes(f)), ...present.filter((f) => !HEAVIEST_FIRST.includes(f))];
  if (!names.length) return ordered;
  // a path is taken as its file name, so `test/integration/x.test.js` names x.test.js
  const picked = ordered.filter((f) => names.some((n) => f.includes(basename(n))));
  if (!picked.length) refuse(`no integration test file's name contains ${names.join(' or ')}`);
  return picked;
}

function filesOf({ mode, names }) {
  const units = testFiles(UNIT).map((f) => join(UNIT, f));
  if (mode === 'unit') return units;
  if (mode === 'integration') return integrationFiles(names).map((f) => join(INTEGRATION, f));
  if (mode === 'all') return [...integrationFiles([]).map((f) => join(INTEGRATION, f)), ...units];
  const present = testFiles(INTEGRATION);
  const missing = QUICK.filter((f) => !present.includes(f));
  if (missing.length) console.error(`test:quick: not found, left out — update QUICK in scripts/run-tests.mjs: ${missing.join(', ')}`);
  return [...integrationFiles([]).filter((f) => QUICK.includes(f)).map((f) => join(INTEGRATION, f)), ...units];
}

const args = parseArgs(process.argv.slice(2));
const files = filesOf(args);

// the tests find their fixtures from the working directory, as under `npm run`
process.chdir(ROOT);
const cache = mkdtempSync(join(tmpdir(), 'mcp-test-fixtures-'));
process.env.MCP_TEST_FIXTURE_CACHE = cache;
process.on('exit', () => rmSync(cache, { recursive: true, force: true }));

// Ctrl-C or a kill ends the files' processes and still removes the cache
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.exitCode = 1; abort.abort(); });

const stream = run({
  files,
  concurrency: args.concurrency,
  signal: abort.signal,
  ...(args.testNamePatterns.length ? { testNamePatterns: args.testNamePatterns } : {}),
});
stream.on('test:fail', (data) => { if (!data.todo) process.exitCode = 1; });
stream.compose(process.stdout.isTTY ? spec : tap).pipe(process.stdout);
