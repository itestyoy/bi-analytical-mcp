// tasks/get AND tasks/cancel OF THE TASKS EXTENSION — the two methods the SDK does not serve yet.
//
// The official SDK (@modelcontextprotocol/server 2.x) serves every method of the 2026-07-28 core
// and lets a server add extension methods (tasks/update and skills/* are registered on it, in
// src/mcp-server.js). These two are the exception: `tasks/get` and `tasks/cancel` were also the
// names of the 2025-11-25 experimental tasks, so the SDK's method registry treats them as methods
// of that older revision and answers -32601 on 2026-07-28 even when a handler is registered. The
// Tasks extension (SEP-2663) reuses the names with a new meaning, and the TypeScript SDK does not
// implement the extension yet (its reference implementation is Go's mcpkit).
//
// So these two requests are answered in front of the SDK, and nothing else is: the request is
// classified by the SDK's OWN entry classifier (`classifyInboundRequest` — protocol version, header
// vs body, the `_meta` envelope), a rejection goes out exactly as the SDK would send it, and the
// routing headers SEP-2663 adds for these methods are checked here. Everything that is not a
// 2026-07-28 tasks/get|cancel falls through to the SDK. When the SDK serves the extension, this
// file goes and the two handlers move next to tasks/update.

import { classifyInboundRequest, CLIENT_CAPABILITIES_META_KEY, SERVER_INFO_META_KEY } from '@modelcontextprotocol/server';
import { SERVER_INFO } from './mcp-surface.js';
import { TASKS_EXTENSION } from './mcp-server.js';
import { envelopeCapabilities, declaresExtension } from './client-extensions.js';

const METHODS = new Set(['tasks/get', 'tasks/cancel']);

// `=?base64?…?=` — the sentinel a client uses for a header value outside plain ASCII
function decodeHeader(v) {
  if (typeof v !== 'string') return v;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/**
 * Answer a 2026-07-28 tasks/get or tasks/cancel. Returns true when it answered, false when the
 * request is not one (the caller hands it to the SDK).
 */
export function answerTaskRequest(tasks, req, res) {
  const body = req.body;
  if (req.method !== 'POST' || !body || Array.isArray(body) || !METHODS.has(body.method)) return false;
  const outcome = classifyInboundRequest({
    httpMethod: req.method,
    protocolVersionHeader: req.headers['mcp-protocol-version'],
    mcpMethodHeader: req.headers['mcp-method'],
    mcpNameHeader: req.headers['mcp-name'],
    body,
  });
  if (outcome.kind === 'legacy') return false; // not this revision's method: the SDK answers
  const reply = (status, payload) => { res.status(status).json({ jsonrpc: '2.0', id: body.id ?? null, ...payload }); return true; };
  const fail = (status, code, message, data) => reply(status, { error: { code, message, ...(data !== undefined ? { data } : {}) } });
  if (outcome.kind === 'reject') return fail(outcome.httpStatus, outcome.code, outcome.message, outcome.data);

  // the routing headers SEP-2663 adds: Mcp-Method is the method, Mcp-Name is params.taskId
  const taskId = body.params?.taskId;
  if (req.headers['mcp-method'] !== body.method) return fail(400, -32020, `Header mismatch: Mcp-Method header '${req.headers['mcp-method']}' does not match body value '${body.method}'`);
  if (decodeHeader(req.headers['mcp-name']) !== taskId) return fail(400, -32020, `Header mismatch: Mcp-Name header '${req.headers['mcp-name']}' does not match params.taskId '${taskId}'`);

  // offered only to a client that declares the extension in this request (src/client-extensions.js)
  if (!declaresExtension(envelopeCapabilities(body, CLIENT_CAPABILITIES_META_KEY), TASKS_EXTENSION)) {
    return fail(400, -32021, 'Missing required client capability', { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
  }
  const t = typeof taskId === 'string' ? tasks.get(taskId) : null;
  if (!t) return fail(400, -32602, 'Failed to retrieve task: Task not found (it never existed, or it ended more than its TTL ago)');

  if (body.method === 'tasks/cancel') tasks.cancel(t.taskId, 'Cancelled by the client (tasks/cancel).');
  const result = body.method === 'tasks/get' ? tasks.detailed(t) : {};
  return reply(200, { result: { ...result, resultType: 'complete', _meta: { [SERVER_INFO_META_KEY]: { name: SERVER_INFO.name, version: SERVER_INFO.version } } } });
}
