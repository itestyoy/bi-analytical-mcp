// SESSIONS FOR A 2025 CLIENT — the SDK's own sessionful Streamable HTTP transport, routed to in front
// of the per-request handler, as the SDK documents for serving 2025 traffic next to 2026-07-28.
//
// A 2025 client that opens with `initialize` gets an Mcp-Session-Id, and the requests that carry it
// are served by the ONE server of that session (src/mcp-server.js, built for the 2025 era — it offers
// no extension: they are 2026-07-28's). What a session gives that a stateless request cannot:
//   * cancellation — `notifications/cancelled` reaches the request it names, within its session (a
//     request id means nothing across clients), and the work of that call stops;
//   * the GET stream the 2025 transport keeps for the server's own messages.
// A session id this process does not know — the server restarted, or the session was closed — is
// NEVER answered 404: hosts were seen stuck on that answer until the connector was re-added by hand.
// Such a request, and one without a session id, is served statelessly by the per-request handler as
// before, so a client keeps working across a restart; its next initialize opens a session again. A
// session idle for MCP_SESSION_IDLE_SECONDS is closed.

import { randomUUID } from 'node:crypto';
import { classifyInboundRequest, isInitializeRequest } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { setting } from './settings.js';
import { createMcpServer } from './mcp-server.js';
import { logLine } from './mcp-surface.js';

export class LegacySessions {
  constructor(services, { idleMs = setting('MCP_SESSION_IDLE_SECONDS') * 1000 } = {}) {
    this.services = services;
    this.idleMs = idleMs;
    this.sessions = new Map(); // session id → { transport, server, at }
    this._sweep = setInterval(() => this.sweep(), Math.min(idleMs, 60000));
    this._sweep.unref?.();
  }

  /** Whether this request is a 2025 session's to serve: it names a live session, or it opens one. */
  claims(req) {
    const body = req.body;
    if (!(body && !Array.isArray(body) && isInitializeRequest(body)) && this.sessions.has(req.headers['mcp-session-id'])) return true;
    if (req.method !== 'POST' || !body || Array.isArray(body) || !isInitializeRequest(body)) return false;
    // an initialize that carries a 2026-07-28 envelope claim is the modern path's to refuse
    return classifyInboundRequest({ httpMethod: req.method, protocolVersionHeader: req.headers['mcp-protocol-version'], mcpMethodHeader: req.headers['mcp-method'], mcpNameHeader: req.headers['mcp-name'], body }).kind === 'legacy';
  }

  async handle(req, res) {
    const live = isInitializeRequest(req.body) ? null : this.sessions.get(req.headers['mcp-session-id']);
    if (live) {
      live.at = Date.now();
      return live.transport.handleRequest(req, res, req.body);
    }
    // an initialize opens a session — one sent with an id from before is a new client start, the id dropped
    delete req.headers['mcp-session-id'];
    const entry = { at: Date.now() };
    entry.transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { this.sessions.set(sid, entry); logLine('session', `opened ${sid} (${this.sessions.size} open)`); },
    });
    entry.transport.onclose = () => { const sid = entry.transport.sessionId; if (sid && this.sessions.delete(sid)) logLine('session', `closed ${sid}`); };
    entry.server = createMcpServer(this.services, { era: 'legacy' });
    await entry.server.connect(entry.transport);
    return entry.transport.handleRequest(req, res, req.body);
  }

  sweep(now = Date.now()) {
    for (const s of this.sessions.values()) if (now - s.at > this.idleMs) void s.transport.close();
  }

  async close() {
    clearInterval(this._sweep);
    await Promise.all([...this.sessions.values()].map((s) => s.transport.close().catch(() => {})));
  }
}
