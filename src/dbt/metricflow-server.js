// METRICFLOW, KEPT WARM — every metric query (its rows, or with explain its SQL and dataflow plan) and
// every list of what a metric can be grouped by is asked of a long-lived Python process on the MetricFlow
// environment (python/mf_server.py), never of a fresh `mf`: `mf query` spends 3–4 s importing MetricFlow
// and dbt, running `dbt debug` over the project and loading the semantic manifest, and a tenth of a
// second on the query. The process keeps what can be kept, per project directory, and runs the CLI's own
// `query` command in-process with the arguments built for the CLI — so the CSV it writes, the SQL and
// plan it prints, an error as it prints it and its exit code are `mf query`'s.
//
// One pool per MetricFlow environment (its Python), shared by every dbt client of this process and kept
// as long as it runs. A request takes the idle process, or starts one (the first answer includes the
// imports); requests that come together run side by side, each on a process of its own, as `mf`
// processes did — at most MAX_WORKERS at once (each holds MetricFlow and dbt, ~170 MB), the rest
// waiting for one to be free. One process is kept warm between requests; any other is retired as soon
// as it is idle. The processes themselves — spawning, reading their answers, a request stopped by its
// call's cancellation or its timeout (the process is killed: MetricFlow cannot interrupt a query, and
// the answer waits until it has exited, so the DuckDB file it held is free for whatever runs next), a
// process that ends or cannot start — are src/warm-process.js's. Idle, a process holds nothing open:
// not the warehouse (it lets go after every request, and leaves when it cannot) and not the event loop
// (the server, or a test, exits with it running).
//
// The warehouse's turn, the call's cancellation, a task's progress and DBT_TIMING_LOG are applied around
// each request by src/dbt/process.js (runWarm), exactly as around a process.

import { availableParallelism } from 'node:os';
import { assetPath, missingAssetMessage } from '../runtime-assets.js';
import { WarmProcess } from '../warm-process.js';

/**
 * At most this many MetricFlow processes at once, per environment: the CPU count, at least 2 and at
 * most 8. A query's plan is built, and on DuckDB run, inside the process (CPU-bound), and every process
 * holds ~170 MB — so more processes than CPUs buy little and cost memory; on DuckDB one database takes
 * one request at a time anyway (the warehouse's turn), and a BigQuery batch beyond the cap waits for a
 * free process instead of starting another.
 */
export const MAX_WORKERS = Math.max(2, Math.min(8, availableParallelism()));

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

/** The warm MetricFlow processes of ONE MetricFlow environment (its Python). */
export class MetricFlowServer {
  constructor(python, { script = assetPath('mfServer'), maxWorkers = MAX_WORKERS } = {}) {
    this.python = python;
    this.script = script;
    this.maxWorkers = Math.max(1, maxWorkers);
    this.workers = new Set(); // running: idle or answering
    this.idle = null; // the one kept warm between requests
    this.waiting = []; // requests waiting for a free process
    this.seq = 0;
  }

  /** How many processes are running (idle or answering). */
  get size() { return this.workers.size; }

  /**
   * One request ({ op, … } — python/mf_server.py), answered with the process's own answer, or with
   * { ok: false, error, … } when it gave none (src/warm-process.js: it could not start, it ended, or the
   * request was stopped — by `signal`, or after `timeout` ms). Never throws.
   */
  async request(request, { signal, timeout = 600000 } = {}) {
    if (!this.python) return { ok: false, error: 'no MetricFlow Python to run the query on: the dbt environment names no MetricFlow environment (MF_ENV)' };
    if (!this.script) return { ok: false, error: missingAssetMessage('mfServer') };
    if (signal?.aborted) return { ok: false, cancelled: true, error: 'MetricFlow not asked — the tool call was cancelled' };
    let worker = null;
    try {
      worker = await this._take(signal);
      if (!worker) return { ok: false, cancelled: true, error: 'MetricFlow not asked — the tool call was cancelled while it waited for a free MetricFlow process' };
      return await worker.ask({ ...request, id: ++this.seq }, { signal, timeout });
    } catch (e) {
      return { ok: false, error: `the MetricFlow server could not be asked: ${e?.message || e}` };
    } finally {
      if (worker) this._give(worker);
    }
  }

  /** A process for one request: the idle one, a new one under the cap, or the next one freed (null: cancelled while waiting). */
  _take(signal) {
    const idle = this.idle;
    this.idle = null;
    if (idle?.alive) return Promise.resolve(idle);
    if (this.workers.size < this.maxWorkers) return Promise.resolve(this._start());
    return new Promise((resolve) => {
      const waiter = {
        take: (worker) => { signal?.removeEventListener?.('abort', waiter.abort); resolve(worker); },
        abort: () => { this.waiting = this.waiting.filter((w) => w !== waiter); resolve(null); },
      };
      signal?.addEventListener?.('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  _start() {
    const worker = new WarmProcess(this.python, [this.script], { name: 'the MetricFlow server' });
    this.workers.add(worker);
    worker.exited.then(() => this._forget(worker));
    return worker;
  }

  /** A process back from a request: to the next request waiting, else kept warm if none is, else retired. */
  _give(worker) {
    // ended, or put out of the pool while it answered (close)
    if (!worker.alive || !this.workers.has(worker)) return this._forget(worker);
    const next = this.waiting.shift();
    if (next) return next.take(worker);
    if (!this.idle) { this.idle = worker; return; }
    this._forget(worker);
    worker.kill();
  }

  /** A process out of the pool (ended, or retired): a request waiting for a free one may start one now. */
  _forget(worker) {
    this.workers.delete(worker);
    if (this.idle === worker) this.idle = null;
    this._serveWaiting();
  }

  _serveWaiting() {
    while (this.waiting.length && this.workers.size < this.maxWorkers) this.waiting.shift().take(this._start());
  }

  /** Stop every process (a request asked after this starts a new one). */
  close() {
    const all = [...this.workers];
    this.workers.clear();
    this.idle = null;
    for (const worker of all) worker.kill();
    this._serveWaiting();
  }
}

const SERVERS = new Map();

/** The warm MetricFlow of the environment whose Python is `python` — one per environment, shared. */
export function metricflowServer(python) {
  if (!SERVERS.has(python)) SERVERS.set(python, new MetricFlowServer(python));
  return SERVERS.get(python);
}
