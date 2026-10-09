#!/usr/bin/env node
// THE TEST RUNNER of `npm run test:integration`, `test:quick` and `test:all`: node's own runner
// (node:test run()), handed its files in an order of our choosing. `node --test` sorts its files by
// name whatever order they are listed in, so the longest file started a quarter of the way into the
// run and set its length; run() starts them in the order given. The slowest files go first, four side
// by side — within a file the work is serial (its dbt processes take turns on its one DuckDB file), so
// more files at once is the only parallelism there is.
//
//   node scripts/run-tests.mjs integration [name…]   every integration file, heaviest first — or only
//                                                     those whose file name contains one of the names
//   node scripts/run-tests.mjs quick                  the QUICK integration files, then the unit files
//   node scripts/run-tests.mjs all                    every integration file, then the unit files
//   --concurrency=<n>                                 files side by side (default 4)
//   --test-name-pattern=<pattern>                     only the tests whose name matches, as in node --test
//
// The run has ONE fixture cache (MCP_TEST_FIXTURE_CACHE, test/integration/warehouse-harness.js): the
// fixture warehouse buildWarehouse() makes is built once, by the first file that asks for it, and
// copied into each file. It lives as long as the run, so no run reads what an earlier one built.
// The report is node's own — spec on a terminal, TAP otherwise — and the exit code is 1 when a test failed.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { run } from 'node:test';
import { spec, tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION = join(ROOT, 'test', 'integration');
const UNIT = join(ROOT, 'test', 'unit');

// Heaviest first, by each file's time in a full run (its before() hook included: node charges a hook
// to the file's first test). A file not listed runs after these, in name order — list a new file here
// once a run shows it is slow.
const HEAVIEST_FIRST = [
  'retentioneering.test.js',
  'retentioneering-steps.test.js',
  'audit-regressions.test.js',
  'project-semantics.test.js',
  'analytics-tasks.test.js',
  'declared-joins.test.js',
  'python-stage.test.js',
  'materialize.test.js',
  'task-results.test.js',
  'value-index.test.js',
  'mcp-end-to-end.test.js',
  'behavior-funnels.test.js',
  'recipes-parse.test.js',
  'match-recognize.test.js',
  'condition-grammar.test.js',
  'crashlytics-fact.test.js',
  'batch-queries.test.js',
  'acquisition-source.test.js',
];

// `npm run test:quick` — the checks to run while working (about 5 min with the unit files): the
// integration files that cover the most per minute. Declared joins and point-in-time on both sides,
// the MCP surface end to end, the value index, the task runtime with its reads and cards, funnels and
// time ranges, the one condition grammar, a measures source, batches and cancel, the slowly-changing
// fixture, the second events source with its arrays and structs, every pipeline stage, the Jinja guard.
// Only the full run has the retentioneering feature, the project's own semantic layer, the audit
// regressions, the semantic analytics tasks, the python stage, the recipes, behavior funnels,
// materialize, the crash fact, pipeline checkpoints and the A/B test.
const QUICK = [
  'declared-joins.test.js',
  'task-results.test.js',
  'value-index.test.js',
  'mcp-end-to-end.test.js',
  'match-recognize.test.js',
  'condition-grammar.test.js',
  'batch-queries.test.js',
  'acquisition-source.test.js',
  'pipeline.test.js',
  'end-to-end.test.js',
  'crashlytics-complex-types.test.js',
  'scd-e2e.test.js',
  'jinja-inert.test.js',
  'duckdb-json-guard.test.js',
  'scd-open-window.test.js',
];

const USAGE = 'usage: node scripts/run-tests.mjs integration [name…] | quick | all  [--concurrency=<n>] [--test-name-pattern=<pattern>]';

function refuse(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { mode: null, names: [], concurrency: 4, testNamePatterns: [] };
  for (const arg of argv) {
    let m;
    if ((m = /^--concurrency=([1-9]\d*)$/.exec(arg))) args.concurrency = Number(m[1]);
    else if ((m = /^--test-name-pattern=(.+)$/.exec(arg))) args.testNamePatterns.push(m[1]);
    else if (arg.startsWith('-')) refuse(`unknown option ${arg}`);
    else if (!args.mode) args.mode = arg;
    else args.names.push(arg);
  }
  if (!['integration', 'quick', 'all'].includes(args.mode)) refuse(`which tests: ${args.mode ?? 'none named'}`);
  if (args.names.length && args.mode !== 'integration') refuse(`only 'integration' takes file names (got ${args.names.join(' ')})`);
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
