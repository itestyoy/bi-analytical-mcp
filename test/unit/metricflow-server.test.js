// METRICFLOW KEPT WARM (src/dbt/metricflow-server.js, python/mf_server.py): the pool of long-lived
// processes every metric query runs in, and the discipline around a request — no warehouse. The process
// here is a stand-in that speaks the same JSON-lines protocol (a node script; the process itself is
// src/warm-process.js's, test/unit/warm-process.test.js); the numbers MetricFlow returns through the
// real one are proven against DuckDB in test/integration, and the real script's own channel is checked
// at the end when the MetricFlow environment is built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbt } from '../../src/dbt/index.js';
import { MetricFlowServer, metricflowServer, mfOutcome } from '../../src/dbt/metricflow-server.js';
import { runWarm, warehouseTurns } from '../../src/dbt/process.js';
import { withSignal } from '../../src/request-context.js';
import { assetPath } from '../../src/runtime-assets.js';
import { dbtEnv, TEST_ENV } from '../helpers/dbt-env.js';

/**
 * A stand-in server: one answer per request line, under the request's id. `op` says what it does —
 * echo (its pid), sleep (ms, then answer), exit (without answering), mf (as `mf`: notes its start and
 * end in the request's STANDIN_LOG, writes a CSV to the path after --csv, exits 0).
 */
const STANDIN = `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const answer = (req, out) => process.stdout.write(JSON.stringify({ id: req.id, ...out }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line);
  if (req.op === 'echo') return answer(req, { ok: true, pid: process.pid });
  if (req.op === 'sleep') { await sleep(req.ms); return answer(req, { ok: true, pid: process.pid }); }
  if (req.op === 'exit') process.exit(3);
  if (req.op === 'mf') {
    const log = req.env.STANDIN_LOG;
    appendFileSync(log, 'start\\n');
    await sleep(300);
    appendFileSync(log, 'end\\n');
    const csv = req.argv[req.argv.indexOf('--csv') + 1];
    if (req.argv.includes('--csv')) writeFileSync(csv, 'g,m\\na,1.5\\n');
    return answer(req, { ok: true, code: 0, stdout: '', stderr: '' });
  }
  answer(req, { ok: false, error: 'unknown op' });
});
`;

function standin() {
  const dir = mkdtempSync(join(tmpdir(), 'mfs-'));
  const script = join(dir, 'standin.mjs');
  writeFileSync(script, STANDIN);
  return { dir, script };
}

const server = (opts = {}) => new MetricFlowServer(process.execPath, { script: standin().script, ...opts });

/** `fn` with the environment variables `vars` set, restored after. */
async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('a `mf` answer reads as the process it stands for; no answer reads as a failure whose reason is in stderr', () => {
  assert.deepEqual(mfOutcome({ code: 0, stdout: 'out', stderr: '' }), { ok: true, code: 0, stdout: 'out', stderr: '' });
  const failed = mfOutcome({ code: 1, stdout: 'ERROR: x', stderr: 'e' });
  assert.deepEqual([failed.ok, failed.code, failed.stdout, failed.stderr, !!failed.error], [false, 1, 'ERROR: x', 'e', true], 'MetricFlow\'s own failure keeps its output');
  const stopped = mfOutcome({ ok: false, error: 'stopped', cancelled: true, killed: true });
  assert.deepEqual([stopped.ok, stopped.code, stopped.stderr, stopped.error, stopped.cancelled, stopped.killed], [false, null, 'stopped', 'stopped', true, true], 'a request that never ran: its reason is what a caller reads as the message');
});

test('one process answers request after request, kept warm', async () => {
  const s = server();
  try {
    const answers = [await s.request({ op: 'echo' }), await s.request({ op: 'sleep', ms: 10 }), await s.request({ op: 'echo' })];
    assert.deepEqual(answers.map((a) => a.ok), [true, true, true]);
    assert.equal(new Set(answers.map((a) => a.pid)).size, 1, 'by the same process');
    assert.equal(s.size, 1);
  } finally { s.close(); }
});

test('requests that come together run side by side; once idle, all but one process are retired at once', async () => {
  const s = server();
  try {
    const [a, b] = await Promise.all([s.request({ op: 'sleep', ms: 300 }), s.request({ op: 'sleep', ms: 300 })]);
    assert.notEqual(a.pid, b.pid, 'two processes at once');
    assert.equal(s.size, 1, 'the extra one is retired as soon as it is idle; one stays warm');
    const c = await s.request({ op: 'echo' });
    assert.ok([a.pid, b.pid].includes(c.pid), 'the one kept answers the next request');
  } finally { s.close(); }
});

test('at most maxWorkers processes at once: a request beyond them waits for one to be free, and one cancelled while waiting is not asked', async () => {
  const s = server({ maxWorkers: 2 });
  try {
    let most = 0;
    const watch = setInterval(() => { most = Math.max(most, s.size); }, 5);
    const answers = await Promise.all([1, 2, 3, 4].map(() => s.request({ op: 'sleep', ms: 200 })));
    clearInterval(watch);
    assert.deepEqual(answers.map((a) => a.ok), [true, true, true, true]);
    assert.equal(new Set(answers.map((a) => a.pid)).size, 2, 'four requests on two processes');
    assert.ok(most <= 2, `never more than two running (${most})`);
    const ctl = new AbortController();
    const busy = [s.request({ op: 'sleep', ms: 400 }), s.request({ op: 'sleep', ms: 400 })];
    const waiting = s.request({ op: 'echo' }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    const w = await waiting;
    assert.deepEqual([w.ok, w.cancelled, w.pid], [false, true, undefined], 'cancelled while it waited: never sent');
    assert.deepEqual((await Promise.all(busy)).map((a) => a.ok), [true, true], 'the requests it waited behind are answered');
  } finally { s.close(); }
});

test('a request past its timeout stops its process, answered once it has exited; the next starts another', async () => {
  const s = server();
  try {
    const first = await s.request({ op: 'echo' });
    const t0 = Date.now();
    const late = await s.request({ op: 'sleep', ms: 10000 }, { timeout: 200 });
    assert.deepEqual([late.ok, late.killed, late.timedOut], [false, true, true]);
    assert.ok(Date.now() - t0 < 3000, `stopped at the timeout (${Date.now() - t0} ms)`);
    assert.equal(s.size, 0, 'its process is gone');
    const next = await s.request({ op: 'echo' });
    assert.ok(next.ok);
    assert.notEqual(next.pid, first.pid, 'a new process');
  } finally { s.close(); }
});

test('a cancelled call stops its request\'s process; one already cancelled is not sent', async () => {
  const s = server();
  try {
    const ctl = new AbortController();
    const p = s.request({ op: 'sleep', ms: 10000 }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 200);
    const r = await p;
    assert.deepEqual([r.ok, r.cancelled, r.killed], [false, true, true]);
    assert.equal(s.size, 0, 'its process is gone');
    const again = await s.request({ op: 'echo' }, { signal: ctl.signal });
    assert.deepEqual([again.ok, again.cancelled, s.size], [false, true, 0], 'nothing started for it');
  } finally { s.close(); }
});

test('a process that ends without answering, or cannot start, is a failure with its exit — never a throw, never a cancellation', async () => {
  const s = server();
  try {
    const r = await s.request({ op: 'exit' });
    assert.deepEqual([r.ok, r.exit, r.cancelled], [false, { code: 3, signal: null }, undefined]);
    assert.ok((await s.request({ op: 'echo' })).ok, 'and the next request is served');
  } finally { s.close(); }
  const missing = await new MetricFlowServer(join(tmpdir(), 'no-such-python'), { script: 'x.py' }).request({ op: 'echo' });
  assert.deepEqual([missing.ok, missing.started, missing.cancelled], [false, false, undefined]);
  // a spawn that throws (here: not a command at all) is answered the same way
  const thrown = await new MetricFlowServer(42, { script: 'x.py' }).request({ op: 'echo' });
  assert.deepEqual([thrown.ok, thrown.started, thrown.cancelled], [false, false, undefined]);
  const none = await new MetricFlowServer(null).request({ op: 'echo' });
  assert.deepEqual([none.ok, none.cancelled], [false, undefined], 'no MetricFlow Python: a failure');
});

test('a warm request whose start throws is a failure with its reason, under a turn or not; only a call cancelled while it waits is a cancellation', async () => {
  const boom = () => { throw new Error('spawn EMFILE'); };
  for (const turn of [null, 'test-db']) {
    const r = await runWarm('mf', ['query'], boom, { turn });
    assert.deepEqual([r.ok, r.cancelled, r.code], [false, undefined, null], `turn: ${turn}`);
    assert.ok(r.stderr.includes('spawn EMFILE'), 'its reason is what a caller reads (stderr)');
  }
  // a call cancelled while another holds the warehouse's turn: cancelled, and never asked
  let release;
  const holder = warehouseTurns.run('test-db', () => new Promise((r) => { release = r; }));
  const ctl = new AbortController();
  let asked = false;
  const waiting = withSignal(ctl.signal, () => runWarm('mf', ['query'], async () => { asked = true; return { ok: true }; }, { turn: 'test-db' }));
  ctl.abort();
  const w = await waiting;
  release();
  await holder;
  assert.deepEqual([w.ok, w.cancelled, asked], [false, true, false]);
});

test('an idle process does not keep its parent alive', async () => {
  const { script } = standin();
  const code = `import(${JSON.stringify(new URL('../../src/dbt/metricflow-server.js', import.meta.url).href)}).then(async (m) => {
    const s = new m.MetricFlowServer(process.execPath, { script: ${JSON.stringify(script)} });
    const r = await s.request({ op: 'echo' });
    process.stdout.write(r.ok ? 'answered' : 'no answer');
  });`;
  const t0 = Date.now();
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  assert.equal(out, 'answered');
  assert.ok(Date.now() - t0 < 10000, 'the parent exited with its MetricFlow process still running');
});

test('a metric query takes the warehouse\'s turn like a dbt process: on DuckDB one after another', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfturn-'));
  const log = join(dir, 'log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'dbt_project.yml'), 'name: p\nprofile: p\n');
  writeFileSync(join(dir, 'profiles.yml'), 'p:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: "{{ env_var(\'DUCKDB_PATH\') }}"\n');
  // the MetricFlow environment: `mf` and, beside it, the Python the warm process runs on (the stand-in)
  const { script } = standin();
  for (const [name, body] of [['mf', 'exit 0'], ['python', `exec "${process.execPath}" "${script}"`], ['dbt', `echo start >> ${log}; sleep 0.3; echo end >> ${log}; echo '{"show": []}'`]]) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  // the stand-in reads its log from the environment the request carries (the process's own, as `mf` gets it)
  await withEnv({ STANDIN_LOG: log, DUCKDB_PATH: join(dir, 'w.duckdb') }, async () => {
    const c = createDbt({ version: 1, dbtBin: join(dir, 'dbt'), mfBin: join(dir, 'mf'), profilesDir: dir });
    try {
      const [q1, , q2] = await Promise.all([c.query(dir, { metrics: ['m'], groupBy: ['g'] }), c.show(dir, 'select 1'), c.query(dir, { metrics: ['m'], groupBy: ['g'] })]);
      const order = readFileSync(log, 'utf8').trim().split('\n');
      assert.deepEqual(order, ['start', 'end', 'start', 'end', 'start', 'end'], 'strictly one after another');
      assert.deepEqual([q1.ok, q1.rows, q2.ok], [true, [{ g: 'a', m: 1.5 }], true], 'the rows of the CSV the command wrote, read as before');
    } finally { metricflowServer(c.metricflowPython).close(); }
  });
});

test('the MetricFlow Python is the one the client was given; the one beside its `mf` only when none was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfpy-'));
  writeFileSync(join(dir, 'python'), '');
  const mfBin = join(dir, 'mf');
  assert.equal(createDbt({ version: 1, dbtBin: 'dbt', mfBin, pythonBin: '/given/python' }).metricflowPython, '/given/python');
  assert.equal(createDbt({ version: 1, dbtBin: 'dbt', mfBin }).metricflowPython, join(dir, 'python'));
  assert.equal(createDbt({ version: 1, dbtBin: 'dbt', mfBin: join(tmpdir(), 'nowhere', 'mf') }).metricflowPython, null);
});

// The real script, when the MetricFlow environment is built (dbtEnv: a refused or stale one fails the
// file): it answers on its own channel, a request it cannot serve is answered (not fatal), and it runs
// no `mf` command but `query`.
const MF_PYTHON = dbtEnv(TEST_ENV)?.pythonBin || null;

test('python/mf_server.py answers every request on its own channel and runs only `mf query`', { skip: !MF_PYTHON && 'the MetricFlow environment is not built' }, async () => {
  const lines = [
    JSON.stringify({ id: 1, op: 'nope' }),
    'not json',
    JSON.stringify({ id: 2, op: 'mf', argv: ['validate-configs'], cwd: tmpdir(), env: {} }),
    JSON.stringify({ id: 3, op: 'mf', argv: [], cwd: tmpdir(), env: {} }),
  ];
  const out = await new Promise((resolve, reject) => {
    const child = execFile(MF_PYTHON, [assetPath('mfServer')], { timeout: 120000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin.end(`${lines.join('\n')}\n`);
  });
  const answers = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((a) => a.id), [1, null, 2, 3], 'one answer per request line, each under its id, nothing else on the channel');
  assert.deepEqual(answers.map((a) => a.ok), [false, false, false, false]);
  assert.deepEqual(answers.map((a) => a.code), [undefined, undefined, 2, 2], 'an unknown op and a line that is no request are refused unrun; a command other than `mf query` as a usage error');
  assert.deepEqual(answers.map((a) => a.retire), [undefined, undefined, undefined, undefined], 'and nothing held: the process stays');
});
