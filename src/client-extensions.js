// WHAT THE CLIENT OF THE REQUEST BEING SERVED DECLARED — the one source every extension is gated on.
//
// An extension of this server (MCP Apps, Skills, Tasks) is OFFERED only to a client that declares
// it, IN THE REQUEST BEING SERVED: `capabilities.extensions[<id>]` in the request's envelope. That
// is a 2026-07-28 client, whose every request carries its capabilities. A 2025 client declares them
// once, in `initialize`, and this server serves it statelessly (no sessions), so its later requests
// carry nothing to go by: it is offered none of them — not declared in the request, not offered.
//
// The HTTP layer (src/server.js) reads the envelope and serves the request inside
// `withClientCapabilities`; the server factory (src/mcp-server.js) reads it back to decide what the
// server it builds offers.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** The client capabilities a JSON-RPC request carries in its envelope (2026-07-28), or null. */
export function envelopeCapabilities(body, capabilitiesKey) {
  const msg = Array.isArray(body) ? body[0] : body;
  const caps = msg?.params?._meta?.[capabilitiesKey];
  return caps && typeof caps === 'object' ? caps : null;
}

/**
 * Serve `fn` knowing the capabilities the request's client declared (null: none) and, as technical
 * information, which client it is (`client`: { name, version, userAgent } — the envelope's
 * clientInfo and the User-Agent header; nothing verified).
 */
export function withClientCapabilities(capabilities, fn, client = null) {
  return storage.run({ capabilities: capabilities || null, client }, fn);
}

/** The client application a request came from (a 2026-07-28 envelope's clientInfo), or null. */
export function envelopeClientInfo(body, clientInfoKey) {
  const msg = Array.isArray(body) ? body[0] : body;
  const info = msg?.params?._meta?.[clientInfoKey];
  return info && typeof info === 'object' ? info : null;
}

/** Which client the request being served came from: { name?, version?, userAgent? }, or null. */
export function requestClient() {
  return storage.getStore()?.client ?? null;
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
