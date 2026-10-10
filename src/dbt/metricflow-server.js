// METRICFLOW, KEPT WARM — every metric query (its rows, or with explain its SQL and dataflow plan) and
// every list of what a metric can be grouped by is asked of a long-lived Python process on the MetricFlow
// environment (python/mf_server.py), never of a fresh `mf`: `mf query` spends 3–4 s importing MetricFlow
// and dbt, running `dbt debug` over the project and loading the semantic manifest, and a tenth of a
// second on the query. The process keeps all of that, per project directory, and runs the CLI's own
// `query` command in-process with the arguments built for the CLI — so the CSV it writes, the SQL and
// plan it prints, an error as it prints it and its exit code are `mf query`'s.
//
// One pool per MetricFlow environment (its Python), shared by every dbt client of this process and kept
// as long as it runs: a request takes an idle process, or starts one (the first answer includes the
// imports). Requests that come together run side by side, each on a process of its own, as `mf`
// processes did; a process left idle while another is alive is retired after IDLE_RETIRE_MS. A request that has to stop — its call cancelled, past its timeout — stops its process
// (MetricFlow cannot interrupt a query): it is killed, and the answer waits until it has exited, so the
// DuckDB file it held is free for whatever runs next. Idle, a process holds nothing open — not the
// warehouse (it lets go after every request) and not the event loop (the server, or a test, exits with
// it running).
//
// The warehouse's turn, the call's cancellation, a task's progress and DBT_TIMING_LOG are applied around
// each request by src/dbt/process.js (runWarm), exactly as around a process.

import { spawn } from 'node:child_process';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';

/** How long a process may sit idle while another is alive before it is retired. */
export const IDLE_RETIRE_MS = 60000;
/** How long a process asked to stop (SIGTERM) has before it is killed outright. */
const KILL_GRACE_MS = 5000;
/** How much of a process's stderr is kept, to say why it ended. */
const STDERR_TAIL = 4000;

/**
 * The complete lines of `buffer` read as answers — one JSON object per line; a line that is not one
 * (nothing else writes to the channel, but a half-written line must never be read as an answer) is
 * skipped — and the unfinished rest. → { replies, rest }
 */
export function readReplies(buffer) {
  const replies = [];
  let rest = buffer;
  let nl;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      const reply = JSON.parse(line);
      if (reply && typeof reply === 'object' && !Array.isArray(reply)) replies.push(reply);
    } catch { /* not an answer */ }
  }
  return { replies, rest };
}

/**
 * What a `mf` request answered, as runProcess reports a process: { ok, code, stdout, stderr, error? }.
 * A request the process never ran — it could not start, it died, it was stopped — has no output of its
 * own: its reason is its error AND its stderr, where a caller reading MetricFlow's message
 * (formatDbtError) finds it.
 */
export function mfOutcome(reply) {
  if (reply && Number.isInteger(reply.code)) {
    const ok = reply.code === 0;
    return { ok, code: reply.code, stdout: reply.stdout || '', stderr: reply.stderr || '', ...(ok ? {} : { error: `mf exited with code ${reply.code}` }) };
  }
  const error = reply?.error || 'the MetricFlow server gave no answer';
  return { ok: false, code: null, stdout: '', stderr: error, error, ...(reply?.cancelled ? { cancelled: true } : {}), ...(reply?.killed ? { killed: true } : {}) };
}

class Worker {
  constructor(pool) {
    this.pool = pool;
    this.alive = true;
    this.leaving = false;
    this.pending = null;
    this.buffer = '';
    this.stderr = '';
    this.retire = null;
    this.exited = new Promise((resolve) => { this._exited = resolve; });
    const proc = spawn(pool.python, [pool.script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      const { replies, rest } = readReplies(this.buffer + chunk);
      this.buffer = rest;
      for (const reply of replies) if (this.pending && reply.id === this.pending.id) this.pending.answer(reply);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL); });
    proc.stdin.on('error', () => { /* it exited: said by 'exit' */ });
    proc.on('error', (e) => this._gone(`could not start (${pool.python}): ${e.message}`));
    proc.on('exit', (code, signal) => this._gone(signal ? `was stopped by ${signal}` : `exited with code ${code}`));
    this.hold(false);
  }

  /** The process keeps the event loop alive only while it is answering. */
  hold(busy) {
    const how = busy ? 'ref' : 'unref';
    try {
      this.proc[how]();
      for (const s of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) s?.[how]?.();
    } catch { /* gone */ }
  }

  _gone(how) {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.retire);
    this.pool._forget(this);
    this._exited();
    // a request it was answering, and was not asked to stop, gets why it ended
    if (this.pending && !this.pending.stopping) {
      const tail = this.stderr.trim().split('\n').slice(-12).join('\n');
      this.pending.answer({ ok: false, error: `the MetricFlow server ${how} before it answered${tail ? `:\n${tail}` : ''}` });
    }
  }

  kill() {
    this.leaving = true;
    if (!this.alive) return;
    try { this.proc.kill('SIGTERM'); } catch { /* gone */ }
    const hard = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
    hard.unref?.();
    this.exited.then(() => clearTimeout(hard));
  }

  /** Send one request; its answer, or why there is none. */
  ask(request, { signal, timeout }) {
    return new Promise((resolve) => {
      let timer = null;
      const finish = (out) => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.pending = null;
        this.hold(false);
        resolve(out);
      };
      // stopped: killed, and answered once it has exited (a DuckDB file it held is free by then)
      const stop = (out) => {
        if (!this.pending || this.pending.stopping) return;
        this.pending.stopping = true;
        this.kill();
        this.exited.then(() => finish(out));
      };
      const onAbort = () => stop({ ok: false, cancelled: true, killed: true, error: 'MetricFlow stopped — the tool call was cancelled' });
      this.pending = { id: request.id, stopping: false, answer: (reply) => { if (!this.pending?.stopping) finish(reply); } };
      if (!this.alive) return finish({ ok: false, error: 'the MetricFlow server is not running' });
      timer = setTimeout(() => stop({ ok: false, killed: true, error: `MetricFlow killed — hit the ${timeout}ms runner timeout (query did not finish)` }), timeout);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.hold(true);
      this.proc.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }
}

/** The warm MetricFlow processes of ONE MetricFlow environment (its Python). */
export class MetricFlowServer {
  constructor(python, { script = assetPath('mfServer'), idleRetireMs = IDLE_RETIRE_MS } = {}) {
    this.python = python;
    this.script = script;
    this.idleRetireMs = idleRetireMs;
    this.workers = new Set();
    this.idle = [];
    this.seq = 0;
  }

  /** How many processes are running (idle or answering). */
  get size() { return this.workers.size; }

  /**
   * One request ({ op, … } — python/mf_server.py), answered with the process's own answer, or with
   * { ok: false, error, cancelled?, killed? } when it gave none: it could not start, it ended, or the
   * request was stopped — by `signal`, or after `timeout` ms. Never throws.
   */
  async request(request, { signal, timeout = 600000 } = {}) {
    if (!this.python) return { ok: false, error: 'no MetricFlow Python to run the query on: the dbt environment names no MetricFlow environment (MF_ENV)' };
    if (!this.script) return { ok: false, error: missingAssetMessage('mfServer') };
    if (signal?.aborted) return { ok: false, cancelled: true, killed: true, error: 'MetricFlow not asked — the tool call was cancelled' };
    const worker = this.idle.pop() || this._start();
    clearTimeout(worker.retire);
    const out = await worker.ask({ ...request, id: ++this.seq }, { signal, timeout });
    if (worker.alive && !worker.leaving) this._rest(worker);
    return out;
  }

  _start() {
    const worker = new Worker(this);
    this.workers.add(worker);
    return worker;
  }

  /** A worker back from a request waits for the next one; one of several is retired if it waits long. */
  _rest(worker) {
    this.idle.push(worker);
    worker.retire = setTimeout(() => {
      // out of the pool at once, not at its exit: the next one to wait as long counts it gone
      if (this.workers.size > 1 && this.idle.includes(worker)) {
        this._forget(worker);
        worker.kill();
      }
    }, this.idleRetireMs);
    worker.retire.unref?.();
  }

  _forget(worker) {
    this.workers.delete(worker);
    this.idle = this.idle.filter((w) => w !== worker);
  }

  /** Stop every process (a request asked after this starts a new one). */
  close() {
    for (const worker of [...this.workers]) {
      this._forget(worker);
      worker.kill();
    }
  }
}

const SERVERS = new Map();

/** The warm MetricFlow of the environment whose Python is `python` — one per environment, shared. */
export function metricflowServer(python) {
  if (!SERVERS.has(python)) SERVERS.set(python, new MetricFlowServer(python));
  return SERVERS.get(python);
}
