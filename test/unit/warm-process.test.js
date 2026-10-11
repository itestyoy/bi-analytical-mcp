// A WARM PROCESS (src/warm-process.js): the JSON-lines channel and the lifecycle shared by MetricFlow kept
// warm and the retentioneering check — no warehouse. The process here is a stand-in that speaks the
// protocol (a node script).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WarmProcess, jsonLineReader } from '../../src/warm-process.js';

/**
 * One answer per request line, under the request's id. `op`: echo (its pid), big (an answer of `size`
 * characters), retire (an answer that says it leaves, and it stays until it is killed), deaf (ignores
 * SIGTERM, never answers) — and, for output still in the pipes when it exits: late (it exits at once,
 * and a process it started, holding its stdout, writes the answer 100 ms later), exit (it exits with 3
 * at once, and a process it started writes the reason on its stderr 100 ms later).
 */
const STANDIN = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const answer = (req, out, then) => process.stdout.write(JSON.stringify({ id: req.id, ...out }) + '\\n', then);
const later = (code) => spawn(process.execPath, ['-e', 'setTimeout(() => {' + code + '}, 100)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.op === 'echo') return answer(req, { ok: true, pid: process.pid });
  if (req.op === 'late') { later('process.stdout.write(' + JSON.stringify(JSON.stringify({ id: req.id, ok: true, late: true }) + '\\n') + ')'); process.exit(0); }
  if (req.op === 'exit') { later('process.stderr.write("the reason it ended\\\\n")'); process.exit(3); }
  if (req.op === 'big') return answer(req, { ok: true, text: 'x'.repeat(req.size) });
  if (req.op === 'retire') return answer(req, { ok: true, pid: process.pid, retire: 'it cannot let go' });
  if (req.op === 'deaf') { process.on('SIGTERM', () => {}); return; }
});
`;

function standin() {
  const dir = mkdtempSync(join(tmpdir(), 'warm-'));
  const script = join(dir, 'standin.mjs');
  writeFileSync(script, STANDIN);
  return script;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('JSON lines: a line split over chunks is read once whole; what is not a JSON object is skipped', () => {
  const got = [];
  const push = jsonLineReader((o) => got.push(o));
  for (const chunk of ['{"id":1,', '"ok":true}\nnot json\n[1,2]\n\nnull\n{"id"', ':2}\n{"id":3}']) push(chunk);
  assert.deepEqual(got, [{ id: 1, ok: true }, { id: 2 }], 'the unfinished last line waits for its end');
  push('\n');
  assert.deepEqual(got.at(-1), { id: 3 });
  // one character at a time, and a large line in many chunks
  const each = [];
  const one = jsonLineReader((o) => each.push(o));
  const text = `${JSON.stringify({ id: 4, text: 'é'.repeat(100000) })}\n`;
  for (const ch of text) one(ch);
  assert.deepEqual([each.length, each[0].id, each[0].text.length], [1, 4, 100000]);
});

test('an answer of several MB is read whole, and the same process answers the next request', async () => {
  const p = new WarmProcess(process.execPath, [standin()]);
  const size = 8 * 1024 * 1024;
  const r = await p.ask({ id: 1, op: 'big', size }, { timeout: 30000 });
  assert.deepEqual([r.ok, r.id, r.text.length], [true, 1, size]);
  const next = await p.ask({ id: 2, op: 'echo' });
  assert.deepEqual([next.ok, next.pid], [true, p.proc.pid]);
  p.kill();
});

test('an answer still in its pipes when the process exits is read: it ends when its output is drained, not at its exit', async () => {
  const p = new WarmProcess(process.execPath, [standin()]);
  const r = await p.ask({ id: 1, op: 'late' });
  assert.deepEqual([r.ok, r.id, r.late], [true, 1, true]);
});

test('a process that ends without answering: its exit and the end of its stderr, read before it counts as ended', async () => {
  const p = new WarmProcess(process.execPath, [standin()]);
  const r = await p.ask({ id: 1, op: 'exit' });
  assert.deepEqual([r.ok, r.exit, r.stderr], [false, { code: 3, signal: null }, 'the reason it ended']);
  assert.equal(p.alive, false);
  const again = await p.ask({ id: 2, op: 'echo' });
  assert.deepEqual([again.ok, again.exit], [false, { code: 3, signal: null }], 'an ended process answers no one');
});

test('a process that cannot start is gone at once, with why — the spawn throwing or failing on its next tick — and nothing throws', async () => {
  const thrown = new WarmProcess(42, ['x']); // not a command: spawn itself throws
  assert.equal(thrown.alive, false);
  const r1 = await thrown.ask({ id: 1, op: 'echo' });
  assert.deepEqual([r1.ok, r1.started], [false, false]);
  const missing = new WarmProcess(join(tmpdir(), 'no-such-binary'), []);
  const r2 = await missing.ask({ id: 1, op: 'echo' });
  assert.deepEqual([r2.ok, r2.started], [false, false]);
  assert.equal((await missing.exited).error.code, 'ENOENT');
});

test('an answer that says it is the last is given once the process has ended', async () => {
  const p = new WarmProcess(process.execPath, [standin()]);
  const r = await p.ask({ id: 1, op: 'retire' });
  assert.deepEqual([r.ok, r.retire !== undefined, p.alive, alive(r.pid)], [true, true, false, false]);
});

test('a request past its timeout, or cancelled, stops the process — killed outright when it ignores SIGTERM — and is answered once it has ended', async () => {
  const deaf = new WarmProcess(process.execPath, [standin()], { killGraceMs: 300 });
  const pid = deaf.proc.pid;
  assert.ok((await deaf.ask({ id: 1, op: 'echo' })).ok);
  const late = await deaf.ask({ id: 2, op: 'deaf' }, { timeout: 200 });
  assert.deepEqual([late.ok, late.killed, late.timedOut, deaf.alive, alive(pid)], [false, true, true, false, false]);
  assert.equal((await deaf.exited).signal, 'SIGKILL');

  const p = new WarmProcess(process.execPath, [standin()], { killGraceMs: 300 });
  const ctl = new AbortController();
  const asked = p.ask({ id: 1, op: 'deaf' }, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 100);
  const r = await asked;
  assert.deepEqual([r.ok, r.killed, r.cancelled, p.alive], [false, true, true, false]);
  const before = new WarmProcess(process.execPath, [standin()]);
  const notAsked = await before.ask({ id: 1, op: 'echo' }, { signal: AbortSignal.abort() });
  assert.deepEqual([notAsked.ok, notAsked.cancelled, before.alive], [false, true, true], 'one already cancelled is not sent');
  before.kill();
});
