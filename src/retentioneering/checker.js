// THE LIBRARY'S OWN CHECK, KEPT WARM — one Python process on the feature's environment
// (python/retentioneering_check.py --serve) that answers, one JSON line each, whether the library
// accepts a draft's steps and a query's analyses on stand-in eventstreams of the eventstream's shape,
// and what shape each step leaves. Started on the first request (loading the library takes seconds;
// every later answer is a fraction of one), asked one request at a time, and never holding the server
// up: a check that cannot run — no environment, the process gone, the timeout — answers null, which
// refuses nothing (the run on the warehouse is still the judge).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { assetPath } from '../runtime-assets.js';

/** How long one answer may take (the first includes loading the library). */
const ANSWER_TIMEOUT_MS = 90000;

export class LibraryChecker {
  constructor(python) {
    this.python = python;
    this.proc = null;
    this.pending = new Map();
    this.buffer = '';
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  /** Whether a check can run here at all. */
  get available() {
    return !!(this.python && existsSync(this.python) && assetPath('retentioneeringCheck'));
  }

  _start() {
    const proc = spawn(this.python, [assetPath('retentioneeringCheck'), '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        let reply = null;
        try { reply = JSON.parse(line); } catch { continue; }
        const waiting = this.pending.get(reply.id);
        if (waiting) { this.pending.delete(reply.id); waiting(reply.error ? null : reply); }
      }
      this._hold();
    });
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    const gone = () => {
      if (this.proc === proc) this.proc = null;
      for (const done of this.pending.values()) done(null);
      this.pending.clear();
      this.buffer = '';
    };
    proc.on('exit', gone);
    proc.on('error', gone);
    this.proc = proc;
    this._hold();
  }

  /** The process keeps the event loop alive only while an answer is awaited: idle, it never holds the
   *  server (or a test) open by itself. */
  _hold() {
    const proc = this.proc;
    if (!proc) return;
    const how = this.pending.size ? 'ref' : 'unref';
    proc[how]();
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.[how]?.();
  }

  /** The answer to one request ({ shape, steps, analyses, constants?, edge_weights }), or null when none came. */
  check(request) {
    if (!this.available) return Promise.resolve(null);
    const next = this.queue.then(() => this._ask(request));
    this.queue = next.catch(() => null);
    return next;
  }

  _ask(request) {
    if (!this.proc) this._start();
    const id = ++this.seq;
    const proc = this.proc;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // a request that hangs is not waited on twice: the next one starts a fresh process
        try { proc.kill(); } catch { /* gone already */ }
        resolve(null);
      }, ANSWER_TIMEOUT_MS);
      this.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      this._hold();
      proc.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  close() {
    try { this.proc?.kill(); } catch { /* gone already */ }
    this.proc = null;
  }
}
