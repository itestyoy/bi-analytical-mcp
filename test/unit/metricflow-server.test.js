// METRICFLOW KEPT WARM (src/dbt/metricflow-server.js, python/mf_server.py): the protocol and the
// lifecycle of the long-lived process every metric query runs in — no warehouse. The process here is
// a stand-in that speaks the same JSON-lines protocol (a node script); the numbers MetricFlow returns
// through the real one are proven against DuckDB in test/integration, and the real script's own
// channel is checked at the end when the MetricFlow environment is built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbt } from '../../src/dbt/index.js';
import { MetricFlowServer, metricflowServer, readReplies, mfOutcome } from '../../src/dbt/metricflow-server.js';
import { withSignal } from '../../src/request-context.js';
import { assetPath } from '../../src/runtime-assets.js';
import { resolveEnvironment } from '../../src/dbt/environments.js';

/**
 * A stand-in server: one answer per request line, under the request's id. `op` says what it does —
 * echo (its pid), sleep (ms, then answer), exit (without answering, after a line on stderr), noise
 * (a line that is not an answer, then the answer split across two writes), mf (as `mf`: notes its
 * start and end in the request's STANDIN_LOG, writes a CSV to the path after --csv, exits 0).
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
  if (req.op === 'exit') { process.stderr.write('the reason it ended\\n'); process.exit(3); }
  if (req.op === 'noise') {
    process.stdout.write('not an answer\\n');
    const text = JSON.stringify({ id: req.id, ok: true, pid: process.pid }) + '\\n';
    process.stdout.write(text.slice(0, 5));
    await sleep(50);
    return process.stdout.write(text.slice(5));
  }
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

test('answers are read line by line: an unfinished line waits, a line that is not an answer is skipped', () => {
  const { replies, rest } = readReplies('{"id":1,"ok":true}\nnot json\n[1,2]\n\n{"id":2,');
  assert.deepEqual(replies, [{ id: 1, ok: true }], 'only whole JSON objects are answers');
  assert.equal(rest, '{"id":2,', 'the unfinished line is kept for the next chunk');
  assert.deepEqual(readReplies(`${rest}"ok":false}\n`).replies, [{ id: 2, ok: false }], 'and read once it is complete');
});

test('a `mf` answer reads as the process it stands for; no answer reads as a failure whose reason is in stderr', () => {
  assert.deepEqual(mfOutcome({ code: 0, stdout: 'out', stderr: '' }), { ok: true, code: 0, stdout: 'out', stderr: '' });
  const failed = mfOutcome({ code: 1, stdout: 'ERROR: x', stderr: 'e' });
  assert.deepEqual([failed.ok, failed.code, failed.stdout, failed.stderr, !!failed.error], [false, 1, 'ERROR: x', 'e', true], 'MetricFlow\'s own failure keeps its output');
  const stopped = mfOutcome({ ok: false, error: 'stopped', cancelled: true, killed: true });
  assert.deepEqual([stopped.ok, stopped.code, stopped.stderr, stopped.error, stopped.cancelled, stopped.killed], [false, null, 'stopped', 'stopped', true, true], 'a request that never ran: its reason is what a caller reads as the message');
});

test('one process answers request after request, and a line that is not an answer does not end one', async () => {
  const s = server();
  try {
    const a = await s.request({ op: 'echo' });
    const b = await s.request({ op: 'noise' });
    const c = await s.request({ op: 'echo' });
    assert.ok(a.ok && b.ok && c.ok, 'every request answered');
    assert.equal(new Set([a.pid, b.pid, c.pid]).size, 1, 'by the same process, kept warm');
    assert.equal(s.size, 1);
  } finally { s.close(); }
});

test('requests that come together run side by side, and a process left idle beside another is retired', async () => {
  const s = server({ idleRetireMs: 150 });
  try {
    const [a, b] = await Promise.all([s.request({ op: 'sleep', ms: 300 }), s.request({ op: 'sleep', ms: 300 })]);
    assert.notEqual(a.pid, b.pid, 'two processes at once');
    assert.equal(s.size, 2);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(s.size, 1, 'the extra one is retired once idle; one stays warm');
    const c = await s.request({ op: 'echo' });
    assert.ok([a.pid, b.pid].includes(c.pid), 'the one kept answers the next request');
  } finally { s.close(); }
});

test('a request past its timeout stops its process, answered once it has exited; the next starts another', async () => {
  const s = server();
  try {
    const first = await s.request({ op: 'echo' });
    const t0 = Date.now();
    const late = await s.request({ op: 'sleep', ms: 10000 }, { timeout: 200 });
    assert.equal(late.ok, false);
    assert.equal(late.killed, true);
    assert.match(late.error, /timeout/);
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
    assert.deepEqual([r.ok, r.cancelled], [false, true]);
    assert.equal(s.size, 0, 'its process is gone');
    const again = await s.request({ op: 'echo' }, { signal: ctl.signal });
    assert.deepEqual([again.ok, again.cancelled, s.size], [false, true, 0], 'nothing started for it');
  } finally { s.close(); }
});

test('a process that ends without answering, or cannot start, answers with why', async () => {
  const s = server();
  try {
    const r = await s.request({ op: 'exit' });
    assert.equal(r.ok, false);
    assert.match(r.error, /exited with code 3 before it answered/);
    assert.match(r.error, /the reason it ended/, 'with the end of what it said on stderr');
    assert.ok((await s.request({ op: 'echo' })).ok, 'and the next request is served');
  } finally { s.close(); }
  const none = new MetricFlowServer(join(tmpdir(), 'no-such-python'), { script: 'x.py' });
  const r = await none.request({ op: 'echo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not start/);
  assert.match((await new MetricFlowServer(null).request({ op: 'echo' })).error, /no MetricFlow Python/);
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
  process.env.STANDIN_LOG = log;
  process.env.DUCKDB_PATH = join(dir, 'w.duckdb');
  writeFileSync(join(dir, 'dbt_project.yml'), 'name: p\nprofile: p\n');
  writeFileSync(join(dir, 'profiles.yml'), 'p:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: "{{ env_var(\'DUCKDB_PATH\') }}"\n');
  // the MetricFlow environment: `mf` and, beside it, the Python the warm process runs on (the stand-in)
  const { script } = standin();
  for (const [name, body] of [['mf', 'exit 0'], ['python', `exec "${process.execPath}" "${script}"`], ['dbt', `echo start >> ${log}; sleep 0.3; echo end >> ${log}; echo '{"show": []}'`]]) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const c = createDbt({ version: 1, dbtBin: join(dir, 'dbt'), mfBin: join(dir, 'mf'), profilesDir: dir });
  try {
    const [q1, , q2] = await Promise.all([c.query(dir, { metrics: ['m'], groupBy: ['g'] }), c.show(dir, 'select 1'), c.query(dir, { metrics: ['m'], groupBy: ['g'] })]);
    const order = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(order, ['start', 'end', 'start', 'end', 'start', 'end'], 'strictly one after another');
    assert.deepEqual([q1.ok, q1.rows, q2.ok], [true, [{ g: 'a', m: 1.5 }], true], 'the rows of the CSV the command wrote, read as before');
  } finally { metricflowServer(c.metricflowPython).close(); }
});

// The real script, when the MetricFlow environment is built: it answers on its own channel, a request
// it cannot serve is answered (not fatal), and it runs no `mf` command but `query`.
const MF_PYTHON = (() => { try { return resolveEnvironment(process.env.DBT_ENV || 'dbt-v2').pythonBin; } catch { return null; } })();

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
  assert.match(answers[0].error, /unknown op/);
  assert.deepEqual([answers[2].code, answers[3].code], [2, 2], 'a command other than `mf query` is refused as a usage error');
  assert.match(answers[2].stderr, /runs only: mf query/);
});
