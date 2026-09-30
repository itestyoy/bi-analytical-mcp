// The context a call works in: a new one for a first build, or the one named — which must hold the
// feature's state (an eventstream built here); one build action at a time on it (`serially`); and the
// path columns a build's spec declares.

import { ToolError } from '../validate.js';
import { ES_COLUMNS } from './eventstream.js';
import { BUILD } from './names.js';

export function contextFor(engine, input) {
  if (!input.context_id) {
    const ctx = engine.ctxs.create();
    ctx.state.retentioneering = { eventstreams: {}, queries: 0, drawn: {} };
    return ctx;
  }
  return pathContext(engine, input.context_id);
}

/** A path-analysis context the call names. */
export function pathContext(engine, id) {
  if (!id) throw new ToolError('context_id is needed: the context the eventstream was built in', { stage: 'validate', field: 'context_id' });
  const ctx = engine.host.context(id);
  if (!ctx.state.retentioneering) throw new ToolError(`context '${id}' is not a path-analysis context — build an eventstream with ${BUILD} first (without context_id to start one)`, { stage: 'validate', field: 'context_id' });
  return ctx;
}

/** `fn` after whatever else changes this context's draft — one at a time, in order. What is locked is
 *  only a read-check-write of the draft (a step's, a materialize's commit): waiting for a build to
 *  finish happens before it, so a preview or a fork never queues behind that wait. */
export function serially(feature, key, fn) {
  const locks = (feature.locks ||= new Map());
  const before = locks.get(key) || Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** The path columns an eventstream built in SQL has: the user, and the session when asked for. */
export function basePaths(spec) {
  return [ES_COLUMNS.user, ...(spec.sessions?.gap_minutes ? [ES_COLUMNS.session] : [])];
}
