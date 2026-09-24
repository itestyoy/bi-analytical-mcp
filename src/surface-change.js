// TELLING A CLIENT THAT WHAT THIS SERVER OFFERS HAS CHANGED.
//
// A host caches the tool list (and the resource list, and server/discover) for as long as the
// server allows, and re-draws the cards already in a conversation from that cache — so a deploy that
// renames, adds or re-shapes a tool is invisible to it until the cache expires, and a card whose tool
// it cannot find is "Connector not found". The protocol has three ways to say it, and this server
// uses all three:
//
//   1. a SHORT cache lifetime on the cacheable results (2026-07-28, SEP-2549: `ttlMs` / `cacheScope`)
//      — LIST_TTL_MS, so a client that honours it re-reads the lists within a minute of any change;
//   2. `notifications/tools/list_changed` and `notifications/resources/list_changed` (the
//      `listChanged` capability bits) on the client's open `subscriptions/listen` stream. A deploy
//      restarts the process, and the streams reconnect AFTER it — so the change cannot be announced
//      to a stream that was open before. What the server can know is that its surface CHANGED since
//      the last process (a fingerprint of it, persisted): then every stream that subscribes within
//      CHANGE_WINDOW_MS of the start is told at once, right after its acknowledgement. A client that
//      already has the new list re-reads it once; one that holds the old list learns it is stale;
//   3. the fingerprint in `serverInfo.version` (`0.1.0+<fingerprint>`), which a client comparing the
//      version server/discover reports sees change with every change of the surface.

import { createHash } from 'node:crypto';
import { InMemoryServerEventBus } from '@modelcontextprotocol/server';

/** How long a client may cache the lists and server/discover: a change reaches it within this. */
export const LIST_TTL_MS = 60 * 1000;

/**
 * How long after a start that CHANGED the surface a new subscription is told so: the longest a
 * client may still hold a list from before — the one-hour lifetime this server used to grant.
 */
export const CHANGE_WINDOW_MS = 60 * 60 * 1000;

const FINGERPRINT_KEY = 'surface_fingerprint';

/** A short, stable fingerprint of everything a client caches about this server. */
export function surfaceFingerprint(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

/**
 * This process's surface against the one the previous process served (persisted in the store's
 * `meta`): `changed` when they differ — also on a first start, when no client can be assumed to hold
 * the current list. The new fingerprint is recorded for the next start.
 */
export function surfaceChange(store, fingerprint, now = Date.now()) {
  let previous = null;
  try { previous = store?.meta?.get(FINGERPRINT_KEY) ?? null; } catch { /* no persistent store: treat as changed */ }
  if (previous !== fingerprint) { try { store?.meta?.set(FINGERPRINT_KEY, fingerprint); } catch { /* best effort */ } }
  return { fingerprint, previous, changed: previous !== fingerprint, since: now };
}

const CHANGE_EVENTS = [{ kind: 'tools_list_changed' }, { kind: 'resources_list_changed' }];

/**
 * The event bus `subscriptions/listen` streams subscribe to (createMcpHandler's `bus`): the SDK's
 * in-process bus, plus — while the window of a changed start is open — the change announced to each
 * new subscriber the moment it subscribes. The SDK writes the subscription's acknowledgement BEFORE
 * it subscribes the stream's listener, so the announcement follows the ack on the wire, and the
 * SDK's per-stream filter still decides whether the client asked for it.
 */
export class SurfaceChangeBus {
  constructor(change, { windowMs = CHANGE_WINDOW_MS, now = () => Date.now(), onerror } = {}) {
    this.change = change;
    this.windowMs = windowMs;
    this.now = now;
    this.inner = new InMemoryServerEventBus(onerror);
  }

  publish(event) {
    this.inner.publish(event);
  }

  subscribe(listener) {
    const unsubscribe = this.inner.subscribe(listener);
    if (this.change?.changed && this.now() - this.change.since < this.windowMs) {
      for (const event of CHANGE_EVENTS) {
        try { listener(event); } catch { /* one stream's failure is not another's */ }
      }
    }
    return unsubscribe;
  }
}
