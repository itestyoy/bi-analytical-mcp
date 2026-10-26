// WHAT THE CLIENT OF THE REQUEST BEING SERVED DECLARED — the one source every extension is gated on.
//
// An extension of this server (MCP Apps, Skills, Tasks) is OFFERED only to a client that declares it
// (`capabilities.extensions[<id>]`), where its revision has the client declare:
//   * a 2026-07-28 client — in THIS request's envelope: the revision is stateless, so nothing an
//     earlier request declared carries over (a client may declare only what a request needs);
//   * a 2025 client — once, in its `initialize`, for the session it opens (src/legacy-sessions.js);
//     a 2025 request served outside a session declared nothing this server saw, and is offered none.
// Tasks is 2026-07-28's alone (the 2025 revision's experimental tasks are another wire). Skills are
// served to any client that asks — skills/list needs nothing of the client — and a declaring one is
// pointed at them in the instructions.
//
// The HTTP layer (src/server.js) reads the envelope and serves the request inside
// `withClientCapabilities`; the server factory (src/mcp-server.js) reads it back to decide what the
// server it builds offers.

import { AsyncLocalStorage } from 'node:async_hooks';
import { EXTENSION_ID } from '@modelcontextprotocol/ext-apps/server';

/** The extensions this server offers, by id: MCP Apps (the id is the official package's), Skills, Tasks. */
export const UI_EXTENSION = EXTENSION_ID;
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const storage = new AsyncLocalStorage();

/** The client capabilities a JSON-RPC request carries in its envelope (2026-07-28), or null. */
export function envelopeCapabilities(body, capabilitiesKey) {
  const msg = Array.isArray(body) ? body[0] : body;
  const caps = msg?.params?._meta?.[capabilitiesKey];
  return caps && typeof caps === 'object' ? caps : null;
}

/** Serve `fn` knowing the capabilities the request's client declared (null: none). */
export function withClientCapabilities(capabilities, fn) {
  return storage.run({ capabilities: capabilities || null }, fn);
}

/** The capabilities the client of the request being served declared, or null. */
export function clientCapabilities() {
  return storage.getStore()?.capabilities ?? null;
}

/** Whether a set of capabilities declares the extension `id`. */
export function declaresExtension(capabilities, id) {
  const ext = capabilities?.extensions?.[id];
  return ext !== undefined && ext !== null && ext !== false;
}
