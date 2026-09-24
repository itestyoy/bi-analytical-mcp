// STARTING A dbt / MetricFlow PROCESS — the one place the dbt clients spawn one.
//
// Two things ride along with every process:
//   * the CANCELLATION of the call or task it works for (src/request-context.js): a call the client
//     abandoned, or a task cancelled with { task_id, cancel: true }, stops its process instead of
//     letting it scan the warehouse to the end — and one asked for after that is not started;
//   * the WAREHOUSE'S TURN, where the warehouse takes one process at a time. A DuckDB database is a
//     file that ONE process may hold open ("Could not set lock on file … Conflicting lock is held"):
//     two dbt processes on it at once — a batch of queries, a card's drill-down during a build, the
//     value index — fail. Such a warehouse gets one FIFO turn per database, shared by every client
//     on it (a context's queries, the indexer, the MetricFlow sidecar), and a process waits for it.

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { currentSignal } from '../request-context.js';

/**
 * One process at a time per key, in the order asked; a waiter whose call is cancelled leaves the
 * queue. `run(key, fn)` resolves with what fn returns.
 */
class Turns {
  constructor() { this.tails = new Map(); }

  async run(key, fn, signal) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    try {
      await waitFor(prev, signal);
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('cancelled while waiting for the warehouse'), { cancelled: true }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('cancelled while waiting for the warehouse'), { cancelled: true }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, reject);
  });
}

/** The turns of every single-writer warehouse this process talks to, by database key. */
export const warehouseTurns = new Turns();

/**
 * Run `bin args` and collect what it printed. `turn` (a database key) makes it wait for that
 * warehouse's turn first. Never throws: the outcome is { ok, code, killed, signal, cancelled?,
 * stdout, stderr, error }.
 */
export function runProcess(bin, args, { cwd, env, timeout = 600000, turn = null } = {}) {
  const signal = currentSignal();
  const asked = Date.now();
  let began = asked;
  const start = () => { began = Date.now(); return spawnOnce(bin, args, { cwd, env, timeout, signal }); };
  const done = (r) => { timing(bin, args, asked, began, r); return r; };
  if (!turn) return start().then(done);
  return warehouseTurns.run(turn, start, signal).catch((e) => cancelledResult(e?.message || 'cancelled')).then(done);
}

/**
 * DBT_TIMING_LOG=<file>: one JSON line per process — which command, how long it WAITED for the
 * warehouse's turn and how long it RAN — to see where the time of a run (a test suite) goes.
 */
export function timing(bin, args, asked, began, r) {
  const file = process.env.DBT_TIMING_LOG;
  if (!file) return;
  const end = Date.now();
  const cmd = args[0] === 'run-operation' ? `run-operation ${args[1]}` : args[0];
  try {
    appendFileSync(file, `${JSON.stringify({ bin: basename(bin), dir: bin.split('/').slice(-3, -2)[0], cmd, waited_ms: began - asked, ran_ms: end - began, ok: !!r?.ok, pid: process.pid })}\n`);
  } catch { /* timing is best effort */ }
}

function cancelledResult(message) {
  return { ok: false, code: null, killed: true, signal: 'SIGTERM', cancelled: true, stdout: '', stderr: '', error: message };
}

function spawnOnce(bin, args, { cwd, env, timeout, signal }) {
  if (signal?.aborted) return Promise.resolve(cancelledResult('dbt not started — the tool call was cancelled'));
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      // The useful failure fact JS gives us is killed/signal/code — NOT err.message/err.stack,
      // which is just the "Command failed: <whole command>" + node-internal-stack wrapper.
      // A killed/SIGTERM exit means the runner timeout fired (the query never finished) — unless
      // the call was cancelled, which kills it the same way; a non-zero exit means dbt itself
      // failed and printed the real reason to stdout/stderr.
      const cancelled = !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || !!signal?.aborted);
      let error;
      if (err) {
        error = cancelled
          ? 'dbt stopped — the tool call was cancelled'
          : (err.killed || err.signal)
            ? `dbt killed by ${err.signal || 'signal'} — hit the ${timeout}ms runner timeout (query did not finish)`
            : `dbt exited with code ${err.code}`;
      }
      resolve({ ok: !err, code: err?.code ?? 0, killed: !!err?.killed || cancelled, signal: err?.signal ?? null, ...(cancelled ? { cancelled: true } : {}), stdout: stdout || '', stderr: stderr || '', error });
    });
  });
}
