// THE LIBRARY'S OWN CHECK, KEPT WARM — one Python process on the feature's environment
// (python/retentioneering_check.py --serve) that answers, one JSON line each, whether the library
// accepts a draft's steps and a query's analyses on stand-in eventstreams of the eventstream's shape,
// and what shape each step leaves. Started on the first request (loading the library takes seconds;
// every later answer is a fraction of one), asked one request at a time, and never holding the server
// up: a check that cannot run — no environment, the process gone or unable to start, the timeout —
// answers null, which refuses nothing (the run on the warehouse is still the judge). The process itself
// (spawning it, reading its answers, stopping one that hangs) is src/warm-process.js's.

import { existsSync } from 'node:fs';
import { assetPath } from '../runtime-assets.js';
import { WarmProcess } from '../warm-process.js';

/**
 * The library's errors that are the CALL's — raised by what a step or an analysis was given, not by
 * the rows (the data's own — EmptyEventstreamError, PatternNoMatchError, PathIdNotFoundError — and a
 * widget's export are left out). A level the library does not find (SegmentLevelNotFoundError) counts
 * only where the shape knows every level of that segment: elsewhere the stand-in carries the call's own
 * constants as levels, so it is never raised. Each is one of the library's own error classes (the
 * facts sheet's `errors`, which a test holds this list to); every request carries the list.
 */
export const CONFIG_ERRORS = [
  'AmbiguousGridPointError', 'DiffConfigError', 'GridPointNotFoundError', 'InvalidMetricConfigError', 'InvalidParameterError',
  'InvalidSegmentSelectionError', 'MetricDistributionError', 'PatternSyntaxError', 'PreprocessingColumnNotFoundError',
  'PreprocessingConfigError', 'SchemaConfigError', 'SegmentLevelNotFoundError',
];

/** How long one answer may take (the first includes loading the library). */
const ANSWER_TIMEOUT_MS = 90000;

export class LibraryChecker {
  constructor(python) {
    this.python = python;
    this.proc = null;
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  /** Whether a check can run here at all. */
  get available() {
    return !!(this.python && existsSync(this.python) && assetPath('retentioneeringCheck'));
  }

  /** The answer to one request ({ shape, steps, analyses, constants?, edge_weights }), or null when none came. */
  check(request) {
    if (!this.available) return Promise.resolve(null);
    const next = this.queue.then(() => this._ask(request));
    this.queue = next.catch(() => null);
    return next;
  }

  async _ask(request) {
    // a process that ended (or hung and was stopped) is not asked again: the next request starts a fresh one
    if (!this.proc?.alive) this.proc = new WarmProcess(this.python, [assetPath('retentioneeringCheck'), '--serve'], { name: 'the library\'s check' });
    const reply = await this.proc.ask({ ...request, config_errors: CONFIG_ERRORS, id: ++this.seq }, { timeout: ANSWER_TIMEOUT_MS });
    // the check's own failure (a request it could not carry) or no answer at all: no check
    return reply.ok === false || reply.error ? null : reply;
  }

  close() {
    this.proc?.kill();
    this.proc = null;
  }
}
