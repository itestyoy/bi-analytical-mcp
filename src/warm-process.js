// A WARM PROCESS — one long-lived child that answers requests one JSON line each, a request at a time:
// what MetricFlow kept warm (src/dbt/metricflow-server.js → python/mf_server.py) and the retentioneering
// library's own check (src/retentioneering/checker.js → python/retentioneering_check.py --serve) are
// built on. This is the one place such a process is spawned, read and stopped; the plain one-shot dbt
// and Python processes are spawned by src/dbt/process.js.
//
// What it does for every owner alike:
//   * SPAWN, and a spawn that fails — at once (an invalid argument), on the next tick (ENOENT, EMFILE:
//     no standard streams then) — is a process that is gone, with its reason, never an exception;
//   * READ its stdout as JSON lines: only the new chunk is scanned for a line's end and a line is
//     joined once (an answer of several MB arrives in many chunks); a line that is not a JSON object is
//     not an answer and is skipped; its stderr's tail is kept, to say why it ended;
//   * END when its output is read ('close', not 'exit': an answer written just before it exited, or
//     the reason it wrote on stderr, is still in its pipes at 'exit');
//   * ASK one request (with an `id` of its own) and resolve with the object answered under that id —
//     or with why there is none: { ok: false, error, … } with `started: false` (it never ran),
//     `exit: { code, signal }` + `stderr` (it ended first), `timedOut` or `cancelled` (+ `killed`: it
//     was stopped). A request that has to stop STOPS THE PROCESS (a request cannot be interrupted
//     inside it), and is answered once the process has ended — so whatever it held (a DuckDB file) is
//     free by then. An answer that says `retire` is the process's last: it leaves after it, and the
//     answer, too, is given once it has ended;
//   * HOLD the event loop only while it answers: idle, it never keeps its parent (a server, a test)
//     alive by itself.
// What a request is, and what an owner does with an answer or a failure, is the owner's.

import { spawn } from 'node:child_process';

/** How long a process asked to stop (SIGTERM) has before it is killed outright. */
const KILL_GRACE_MS = 5000;
/** How much of a process's stderr is kept, to say why it ended. */
const STDERR_TAIL = 4000;
/** After 'exit', how long its pipes may stay open (a process it started still holding them) before it counts as ended. */
const DRAIN_MS = 2000;

/**
 * A reader of JSON lines: `push(chunk)` hands each complete line that is a JSON object to `onObject`
 * and keeps the unfinished rest for the next chunk. A line that is not one (a half-written line never
 * is) is skipped. Only the new chunk is scanned for a line's end, and a line's parts are joined once.
 */
export function jsonLineReader(onObject) {
  let parts = [];
  return (chunk) => {
    let from = 0;
    for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', from)) {
      parts.push(chunk.slice(from, nl));
      from = nl + 1;
      const line = parts.join('').trim();
      parts = [];
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value && typeof value === 'object' && !Array.isArray(value)) onObject(value);
    }
    if (from < chunk.length) parts.push(from ? chunk.slice(from) : chunk);
  };
}

export class WarmProcess {
  /**
   * `command args`, started now. `name` is how its failures name it ("the MetricFlow server").
   */
  constructor(command, args, { name = 'the process', killGraceMs = KILL_GRACE_MS } = {}) {
    this.command = command;
    this.name = name;
    this.killGraceMs = killGraceMs;
    this.alive = true;
    this.end = null; // once ended: { code, signal } | { error } (it never ran)
    this.stderr = '';
    this.pending = null;
    this.proc = null;
    this._hard = null;
    this._drain = null;
    /** Resolved with `end` once the process has ended and its output is read. */
    this.exited = new Promise((resolve) => { this._exited = resolve; });
    let proc;
    try {
      proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this._gone({ error });
      return;
    }
    this.proc = proc;
    // first: a spawn that fails says so with an 'error' event, and an unheard one would throw
    proc.on('error', (error) => { if (proc.pid === undefined) this._gone({ error }); });
    proc.on('exit', (code, signal) => {
      this._drain = setTimeout(() => this._gone({ code, signal }), DRAIN_MS);
      this._drain.unref?.();
    });
    proc.on('close', (code, signal) => this._gone({ code, signal }));
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      // EMFILE / ENFILE: no streams, and its 'error' comes on the next tick (this only if it never does)
      setImmediate(() => this._gone({ error: new Error('its standard streams could not be opened') }));
      return;
    }
    const read = jsonLineReader((reply) => this._reply(reply));
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', read);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL); });
    proc.stdin.on('error', () => { /* it ended: said by 'close' */ });
    this.hold(false);
  }

  /** The process keeps the event loop alive only while it is answering. */
  hold(busy) {
    const proc = this.proc;
    if (!proc || !this.alive) return;
    const how = busy ? 'ref' : 'unref';
    try {
      proc[how]();
      for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.[how]?.();
    } catch { /* gone */ }
  }

  /** Ask it to stop (SIGTERM, then SIGKILL after the grace period); resolves once it has ended. */
  kill() {
    if (this.alive && this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* gone */ }
      if (!this._hard) {
        this._hard = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, this.killGraceMs);
        this._hard.unref?.();
      }
    }
    return this.exited;
  }

  /**
   * Send `message` (it carries its own `id`) and resolve with the object answered under that id, or
   * with why there is none (above). One request at a time: the owner waits for an answer before it
   * asks again. Never throws.
   */
  ask(message, { timeout = 600000, signal } = {}) {
    return new Promise((resolve) => {
      if (this.pending) return resolve({ ok: false, error: `${this.name} is already answering a request` });
      let timer = null;
      const pending = { id: message.id, stopping: null };
      const onAbort = () => this._stop(pending, { ok: false, killed: true, cancelled: true, error: `${this.name} was stopped — the call was cancelled` });
      pending.finish = (out) => {
        if (this.pending !== pending) return;
        this.pending = null;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.hold(false);
        resolve(out);
      };
      this.pending = pending;
      if (!this.alive) return pending.finish(this._failure());
      if (signal?.aborted) return pending.finish({ ok: false, cancelled: true, error: `${this.name} was not asked — the call was cancelled` });
      timer = setTimeout(() => this._stop(pending, { ok: false, killed: true, timedOut: true, error: `${this.name} was killed — it hit the ${timeout} ms timeout before it answered` }), timeout);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.hold(true);
      if (!this.proc?.stdin) return; // its spawn is failing: answered with why when its 'error' comes
      try {
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (e) {
        // it cannot be asked (no answer can come): it is left, and the request answered once it has ended
        this._stop(pending, { ok: false, error: `${this.name} could not be asked: ${e?.message || e}` });
      }
    });
  }

  _reply(reply) {
    const pending = this.pending;
    // an answer to no one waiting (a stopped request's, written late) or to a request being stopped
    if (!pending || pending.stopping || reply.id !== pending.id) return;
    if (reply.retire) return this._stop(pending, reply); // its last answer: given once it has ended
    pending.finish(reply);
  }

  /** Stop the process for `pending`, which is answered `answer` once the process has ended. */
  _stop(pending, answer) {
    if (this.pending !== pending || pending.stopping) return;
    pending.stopping = answer;
    this.kill();
  }

  _gone(end) {
    if (!this.alive) return;
    this.alive = false;
    this.end = end;
    clearTimeout(this._hard);
    clearTimeout(this._drain);
    this._exited(end);
    const pending = this.pending;
    if (pending) pending.finish(pending.stopping || this._failure());
  }

  /** Why a request asked of this process got no answer from it. */
  _failure() {
    const end = this.end || {};
    if (end.error) return { ok: false, started: false, error: `${this.name} could not start (${this.command}): ${end.error.message || end.error}` };
    const tail = this.stderr.trim().split('\n').slice(-12).join('\n');
    const how = end.signal ? `was stopped by ${end.signal}` : `exited with code ${end.code}`;
    return { ok: false, exit: { code: end.code ?? null, signal: end.signal ?? null }, stderr: tail, error: `${this.name} ${how} before it answered${tail ? `:\n${tail}` : ''}` };
  }
}
