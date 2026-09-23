// MCP 2026-07-28 — the STATELESS protocol revision, served next to the legacy session protocol.
//
// A modern request carries everything the server needs in itself: `_meta` names the protocol
// version and the client's capabilities, the HTTP headers mirror the method and the target so an
// intermediary can route without parsing the body, and there is no initialize, no session, no GET
// stream. src/server.js decides the era per request (an `initialize` or a live Mcp-Session-Id →
// legacy; per-request `_meta` or a modern MCP-Protocol-Version header → here); what the server
// OFFERS is shared (src/mcp-surface.js), so the two eras differ only in wire format.
//
// Implemented here, each where the spec puts it:
//   * validation — MCP-Protocol-Version / Mcp-Method / Mcp-Name against the body (HeaderMismatch
//     -32020, 400), required `_meta` fields (-32602, 400), an unsupported version
//     (UnsupportedProtocolVersion -32022 with the supported list, 400), an unknown method (404,
//     -32601 — the JSON-RPC body is what tells a modern client this is not a legacy server);
//   * every result carries `resultType` and the server's identity in `_meta`; list/read/discover
//     results carry caching hints (`ttlMs`, `cacheScope`);
//   * server/discover (MUST), tools/*, resources/*, and the extensions: Tasks (server-decided
//     tasks, tasks/get|update|cancel), Skills (skills/list|get), Apps (tool `_meta.ui`);
//   * subscriptions/listen — the one long-lived stream (acknowledgement first, keep-alives, task
//     status notifications for the tasks a client asked about);
//   * progress on the request's own SSE stream when the request carries a progressToken, and
//     cancellation when the client closes that stream (the transport's cancellation signal).

import { SUPPORTED_PROTOCOL_VERSIONS as LEGACY_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { buildToolDefs, isCallableTool, runTool, runToCompletion, clientSupportsUi, SERVER_INFO, logLine } from './mcp-surface.js';
import { UI_EXTENSION, APP_MIME } from './apps.js';
import { SKILLS_EXTENSION } from './skills.js';
import { isTerminal } from './tasks.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
};
const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, headerMismatch: -32020, missingCapability: -32021, unsupportedVersion: -32022 };

// The tool list, the resources and the skills never change while this process runs: a client may
// hold them for an hour. Nothing in them depends on who asks.
const STATIC_TTL_MS = 3600000;
const cacheable = { ttlMs: STATIC_TTL_MS, cacheScope: 'public' };
const KEEPALIVE_MS = 25000;

/** Does this request speak the modern revision? (src/server.js routes on it.) */
export function isModernRequest(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.method === 'server/discover') return true;
  if (body.params?._meta && Object.prototype.hasOwnProperty.call(body.params._meta, META.version)) return true;
  const header = req.headers['mcp-protocol-version'];
  return typeof header === 'string' && header >= MODERN_VERSIONS[0];
}

class RpcError extends Error {
  constructor(code, message, { status = 400, data } = {}) { super(message); this.code = code; this.status = status; this.data = data; }
}

// `=?base64?…?=` — the sentinel a client uses for a header value that is not plain ASCII.
function decodeHeader(v) {
  if (typeof v !== 'string') return v;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

const NAME_SOURCE = {
  'tools/call': (p) => p?.name,
  'resources/read': (p) => p?.uri,
  'prompts/get': (p) => p?.name,
};
const TASK_METHODS = new Set(['tasks/get', 'tasks/update', 'tasks/cancel']);

function validate(req, body) {
  const meta = body.params?._meta;
  const headerVersion = req.headers['mcp-protocol-version'];
  const version = meta?.[META.version];
  if (!meta || typeof version !== 'string') throw new RpcError(ERR.invalidParams, `every request carries its protocol version in params._meta["${META.version}"] (this server speaks ${MODERN_VERSIONS.join(', ')} statelessly, or the legacy versions after initialize)`);
  if (!MODERN_VERSIONS.includes(version)) {
    throw new RpcError(ERR.unsupportedVersion, 'Unsupported protocol version', { data: { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version } });
  }
  if (typeof headerVersion !== 'string') throw new RpcError(ERR.headerMismatch, 'Header mismatch: the MCP-Protocol-Version header is required');
  if (headerVersion !== version) throw new RpcError(ERR.headerMismatch, `Header mismatch: MCP-Protocol-Version header '${headerVersion}' does not match body value '${version}'`);
  const caps = meta[META.caps];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new RpcError(ERR.invalidParams, `params._meta["${META.caps}"] is required on every request (an empty object when the client declares nothing)`);
  const hMethod = req.headers['mcp-method'];
  if (typeof hMethod !== 'string') throw new RpcError(ERR.headerMismatch, 'Header mismatch: the Mcp-Method header is required');
  if (hMethod !== body.method) throw new RpcError(ERR.headerMismatch, `Header mismatch: Mcp-Method header '${hMethod}' does not match body value '${body.method}'`);
  const hName = decodeHeader(req.headers['mcp-name']);
  const nameOf = NAME_SOURCE[body.method] || (TASK_METHODS.has(body.method) ? (p) => p?.taskId : null);
  if (NAME_SOURCE[body.method] && typeof hName !== 'string') throw new RpcError(ERR.headerMismatch, `Header mismatch: the Mcp-Name header is required for ${body.method}`);
  if (nameOf && typeof hName === 'string' && hName !== String(nameOf(body.params) ?? '')) {
    throw new RpcError(ERR.headerMismatch, `Header mismatch: Mcp-Name header value '${hName}' does not match body value '${nameOf(body.params)}'`);
  }
  return caps;
}

const withEnvelope = (result, resultType = 'complete') => ({
  ...result,
  resultType,
  _meta: { ...(result?._meta || {}), [META.serverInfo]: { name: SERVER_INFO.name, version: SERVER_INFO.version } },
});

/** One request/response exchange: JSON by default, an SSE stream when there is something to stream. */
function exchange(res, id) {
  let sse = false;
  const open = () => {
    if (sse) return;
    sse = true;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders?.();
  };
  const write = (msg) => { if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); };
  return {
    notify(method, params) { open(); write({ jsonrpc: '2.0', method, params }); },
    comment() { if (sse && !res.writableEnded) res.write(':\n\n'); },
    open,
    result(result) {
      const msg = { jsonrpc: '2.0', id, result };
      if (sse) { write(msg); res.end(); } else res.status(200).json(msg);
    },
    error(e) {
      const msg = { jsonrpc: '2.0', id, error: { code: e.code ?? ERR.internal, message: e.message || String(e), ...(e.data !== undefined ? { data: e.data } : {}) } };
      if (sse) { write(msg); res.end(); } else res.status(e.status || (e.code === ERR.methodNotFound ? 404 : e.code === ERR.internal ? 500 : 400)).json(msg);
    },
  };
}

export function modernHandler(services) {
  const { engine, tasks } = services;

  const capabilities = () => ({
    tools: {},
    resources: {},
    extensions: {
      [TASKS_EXTENSION]: {},
      [UI_EXTENSION]: { mimeTypes: [APP_MIME] },
      ...(services.skills ? { [SKILLS_EXTENSION]: {} } : {}),
    },
  });

  const needTasks = (caps) => {
    if (!caps.extensions?.[TASKS_EXTENSION]) {
      throw new RpcError(ERR.missingCapability, 'Missing required client capability', { data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } } });
    }
  };
  const taskOf = (params) => {
    const t = typeof params?.taskId === 'string' ? tasks.get(params.taskId) : null;
    if (!t) throw new RpcError(ERR.invalidParams, 'Failed to retrieve task: Task not found (it never existed, or it ended more than its TTL ago)');
    return t;
  };

  async function callTool(req, res, body, caps, ex) {
    const { name, arguments: args } = body.params || {};
    if (!isCallableTool(engine, name)) throw new RpcError(ERR.invalidParams, `Unknown tool: ${name}`);
    const structured = clientSupportsUi(caps);
    const token = body.params?._meta?.progressToken;
    const ctl = new AbortController();
    let handedOff = false; // once the call is a task, the client's disconnect no longer cancels it
    res.on('close', () => { if (!res.writableEnded && !handedOff) ctl.abort(new Error('the client closed the request')); });

    if (caps.extensions?.[TASKS_EXTENSION]) {
      const work = runToCompletion(engine, name, args, { signal: ctl.signal, structured, pollMs: tasks.pollIntervalMs });
      // a call that has not finished within services.taskAfterMs becomes a task: long enough that a
      // quick call answers inline, short enough that no client timeout is anywhere near
      const finished = await Promise.race([work.then((r) => r.result), new Promise((r) => { setTimeout(() => r(null), services.taskAfterMs).unref?.(); })]);
      if (finished) return ex.result(withEnvelope(finished));
      handedOff = true;
      const t = tasks.create({ ctl, run: () => work.then((r) => r.result) });
      logLine(name, `↪ task ${t.taskId}`);
      return ex.result(withEnvelope({ ...tasks.modern(t), statusMessage: 'The call is running; poll tasks/get.' }, 'task'));
    }

    const onProgress = token !== undefined ? (p) => ex.notify('notifications/progress', { progressToken: token, ...p }) : undefined;
    if (onProgress) ex.open(); // the response is a stream, so progress can precede it
    const { result } = await runTool(engine, name, args, { signal: ctl.signal, structured, onProgress, progressEveryMs: services.progressEveryMs });
    return ex.result(withEnvelope(result));
  }

  function listen(req, res, body, caps, ex) {
    const want = body.params?.notifications || {};
    if (Array.isArray(want.taskIds) && want.taskIds.length) needTasks(caps);
    // what this server honours: its lists never change, so "changed" never fires — honest to
    // acknowledge; task ids it knows get their status pushed when it changes
    const ack = {};
    if (want.toolsListChanged) ack.toolsListChanged = true;
    if (want.resourcesListChanged) ack.resourcesListChanged = true;
    if (Array.isArray(want.resourceSubscriptions)) ack.resourceSubscriptions = want.resourceSubscriptions.filter((u) => services.read(u));
    const watched = Array.isArray(want.taskIds) ? want.taskIds.filter((id) => tasks.get(id)) : [];
    if (Array.isArray(want.taskIds)) ack.taskIds = watched;
    const subMeta = { [META.subscriptionId]: body.id };
    ex.notify('notifications/subscriptions/acknowledged', { _meta: subMeta, notifications: ack });
    const keep = setInterval(() => ex.comment(), KEEPALIVE_MS);
    let closed = false;
    const pending = new Set(watched);
    const watch = async (id) => {
      let t = tasks.get(id);
      while (t && !closed) {
        const before = t.lastUpdatedAt;
        await tasks.waitForChange(t, 30000);
        if (closed) return;
        t = tasks.get(id);
        if (t && t.lastUpdatedAt !== before) ex.notify('notifications/tasks', { _meta: subMeta, ...tasks.modern(t) });
        if (!t || isTerminal(t.status)) { pending.delete(id); return; }
      }
    };
    for (const id of watched) watch(id);
    res.on('close', () => { closed = true; clearInterval(keep); });
    services.onShutdown(() => { if (!closed) { closed = true; clearInterval(keep); ex.result(withEnvelope({ _meta: subMeta })); } });
  }

  const methods = {
    'server/discover': () => withEnvelope({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: capabilities(), instructions: services.instructions, ...cacheable }),
    'tools/list': (body, caps) => withEnvelope({ tools: buildToolDefs(engine, { ui: clientSupportsUi(caps) }), ...cacheable }),
    'resources/list': () => withEnvelope({ resources: services.resources(), ...cacheable }),
    'resources/templates/list': () => withEnvelope({ resourceTemplates: services.templates(), ...cacheable }),
    'resources/read': (body) => {
      const contents = services.read(body.params?.uri);
      if (!contents) throw new RpcError(ERR.invalidParams, `Resource not found: ${body.params?.uri}`, { data: { uri: body.params?.uri } });
      return withEnvelope({ contents, ...cacheable });
    },
    'skills/list': () => {
      if (!services.skills) throw new RpcError(ERR.methodNotFound, 'Method not found: skills/list (no skills on this server)', { status: 404 });
      return withEnvelope({ skills: services.skills.list(), ...cacheable });
    },
    'skills/get': (body) => {
      const s = services.skills?.get(body.params?.uri);
      if (!s) throw new RpcError(ERR.invalidParams, `Not a skill this server serves: ${body.params?.uri}`);
      return withEnvelope({ skill: s });
    },
    'tasks/get': (body, caps) => { needTasks(caps); return withEnvelope(tasks.modern(taskOf(body.params))); },
    // this server never asks for input mid-task: a response is acknowledged and ignored (the spec
    // tells servers to ignore responses to keys that are not outstanding)
    'tasks/update': (body, caps) => { needTasks(caps); taskOf(body.params); return withEnvelope({}); },
    'tasks/cancel': (body, caps) => { needTasks(caps); const t = taskOf(body.params); tasks.cancel(t.taskId, null, 'Cancelled by the client (tasks/cancel).'); return withEnvelope({}); },
  };

  return async function handle(req, res) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: ERR.invalidRequest, message: 'Invalid Request: the body must be ONE JSON-RPC 2.0 request or notification (batches are not part of this revision)' } });
    }
    // a notification: accepted, nothing to answer (this revision defines none client→server on HTTP)
    if (body.id === undefined) return res.status(202).end();
    const ex = exchange(res, body.id);
    if (body.id === null) return ex.error(new RpcError(ERR.invalidRequest, 'Invalid Request: a request id must not be null'));
    try {
      const caps = validate(req, body);
      if (body.method === 'tools/call') return await callTool(req, res, body, caps, ex);
      if (body.method === 'subscriptions/listen') return listen(req, res, body, caps, ex);
      const fn = methods[body.method];
      if (!fn) throw new RpcError(ERR.methodNotFound, `Method not found: ${body.method}`, { status: 404 });
      return ex.result(await fn(body, caps));
    } catch (e) {
      if (!(e instanceof RpcError)) logLine(body.method, `✗ internal error: ${e?.stack || e}`);
      return ex.error(e instanceof RpcError ? e : new RpcError(ERR.internal, `Internal error: ${e?.message || e}`, { status: 500 }));
    }
  };
}
