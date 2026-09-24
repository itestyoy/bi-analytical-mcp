// WHAT THE CURRENT TOOL CALL CARRIES DOWN TO THE PROCESSES IT STARTS — its cancellation, and its
// QUERY TAG: technical facts about where the call came from (the client application, the tool, the
// task), which every warehouse query it causes carries as a leading SQL comment (src/dbt/query-tag.js).
//
// A tool call can be abandoned: the client cancels it, the caller disconnects, a task is cancelled.
// The work it started is a dbt process on the warehouse, several layers below the handler, and
// threading a signal through every engine method would put a parameter on each of them that none
// of them uses. So the signal rides the ASYNC CONTEXT instead: the server runs the call inside
// `withSignal(signal, …)`, and the one place that spawns processes (src/dbt/process.js) reads it.
//
// Two rules keep that honest:
//   * work SHARED between callers (the enrichment reads of Engine._bestEffort: one in-flight read
//     serves every caller waiting on it) must not die with the first caller — it runs `detached`;
//   * work that deliberately OUTLIVES its call (a task: a query or a build started by it) runs `detached`, and is protected by
//     the server, which stops forwarding the call's cancellation the moment the call returns.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run `fn` with `signal` as the cancellation of everything it starts (what else the call carries stays). */
export function withSignal(signal, fn) {
  return storage.run({ ...(storage.getStore() || {}), signal }, fn);
}

/**
 * Run `fn` with `fields` added to the call's query tag — technical facts about where the work came
 * from (client, tool, task, context), not an identity: nothing here is verified.
 */
export function withTag(fields, fn) {
  const store = storage.getStore() || {};
  return storage.run({ ...store, tag: { ...(store.tag || {}), ...fields } }, fn);
}

/** The query tag of the call this code runs for (a plain object), or null outside one. */
export function currentTag() {
  return storage.getStore()?.tag || null;
}

/** The cancellation signal of the call this code runs for, or undefined outside one. */
export function currentSignal() {
  return storage.getStore()?.signal;
}

/** Run `fn` outside any call's cancellation — for work that serves more than one caller. */
export function detached(fn) {
  return storage.exit(fn);
}

/**
 * Run `fn` as one of several tasks working on ONE context at the same time (a batch of queries):
 * every dbt process it starts writes its artifacts to a target directory of its own, so two of
 * them never write the same target/ files at once (src/dbt/v1.js reads this).
 */
export function isolatedTarget(fn) {
  return storage.run({ ...(storage.getStore() || {}), isolated: true }, fn);
}

/** Whether the code runs as one of several concurrent tasks on a context (isolatedTarget). */
export function inIsolatedTarget() {
  return !!storage.getStore()?.isolated;
}

/**
 * A signal that follows `source` only until `release()` is called. The server hands this to a
 * call instead of the transport's own signal: a cancellation that arrives while the call is in
 * flight stops its work; one that arrives after the call has returned (a build already handed
 * back as a task, a session torn down later) no longer reaches it.
 */
export function releasableSignal(source) {
  const ctl = new AbortController();
  const forward = () => ctl.abort(source.reason);
  if (source?.aborted) ctl.abort(source.reason);
  else source?.addEventListener?.('abort', forward, { once: true });
  return { signal: ctl.signal, abort: (reason) => ctl.abort(reason), release: () => source?.removeEventListener?.('abort', forward) };
}
