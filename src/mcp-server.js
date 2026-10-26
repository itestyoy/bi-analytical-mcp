// THE MCP SERVER — built on the official SDK (@modelcontextprotocol/server v2), which implements
// protocol revision 2026-07-28 and serves the earlier revisions from the same code.
//
// `createMcpServer` is the factory `createMcpHandler` calls for every request (src/server.js). The
// SDK owns the protocol: which revision a request speaks (the initialize handshake of 2025, or the
// per-request `_meta` envelope of 2026-07-28), headers, `server/discover`, `resultType`, caching
// hints on the wire, error codes. This file only says WHAT the server offers — the same for every
// client, except its extensions (Apps, Skills, Tasks), each offered only to a client that declares
// it in the request being served (src/client-extensions.js).
//
// The tools are registered on the low-level `Server` (`mcp.server`), the SDK's documented path for a
// JSON Schema you already have (docs: "Low-level Server"): our input schemas are built from the
// catalog, and the engine validates arguments itself so a refusal comes back as a tool error the
// model can fix, naming the field and the branch. The resources — the view pages, the skill files —
// are the high-level `McpServer`'s (registerResource, and the SDK's Skills extension attached to it).
//
// The three extensions, each declared in `capabilities.extensions`:
//   * Apps  (io.modelcontextprotocol/ui)     — `_meta.ui` on the viewed tools, the `ui://` view;
//   * Skills (io.modelcontextprotocol/skills) — the SDK's SkillsExtension: skills/list, skills/get,
//     the skill:// template and its files via resources/read;
//   * Tasks (io.modelcontextprotocol/tasks)   — a call that outgrows its window comes back as a
//     task (`resultType: "task"`); tasks/get, tasks/update, tasks/cancel here. The SDK checks their
//     routing headers (Mcp-Name is the taskId) and passes tasks/get and tasks/cancel — names it also
//     knows as the 2025 experimental tasks' — to a handler registered with its own schema.

import { z } from 'zod';
import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { SERVER_INFO, isCallableTool, runTool, runToCompletion, logLine, unknownToolMessage } from './mcp-surface.js';
import { releasableSignal } from './request-context.js';
import { RESOURCE_MIME_TYPE, rendersApps } from './apps.js';
import { clientCapabilities, declaresExtension, UI_EXTENSION, SKILLS_EXTENSION, TASKS_EXTENSION } from './client-extensions.js';
import { PER_CLIENT } from './surface-change.js';

const TaskParams = z.object({ taskId: z.string() }).passthrough();
const TaskUpdateParams = z.object({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()).optional() }).passthrough();
const AnyResult = z.object({}).passthrough();

/** The capabilities this server declares (also what server/discover and initialize report). */
export function serverCapabilities(services) {
  return {
    // a change of either list is announced on an open subscriptions/listen stream (src/surface-change.js)
    tools: { listChanged: true },
    resources: { listChanged: true },
    extensions: {
      [TASKS_EXTENSION]: {},
      [UI_EXTENSION]: { mimeTypes: [RESOURCE_MIME_TYPE] },
      ...(services.skills ? { [SKILLS_EXTENSION]: {} } : {}),
    },
  };
}

/**
 * Which extensions a server built for this request offers — each only to a client that declared it:
 * a 2026-07-28 client in THIS request's envelope (a stateless revision: nothing carries over from an
 * earlier request), a 2025 client in its `initialize`, for the session it opens (`capabilities`; a
 * 2025 request served outside a session declared nothing this server saw). Apps also needs the view's
 * MIME type among the declared ones; Tasks is 2026-07-28's alone — the 2025 revision's experimental
 * tasks are another wire (src/client-extensions.js).
 */
export function offeredExtensions(services, { era, capabilities = null } = {}) {
  const caps = era === 'modern' ? clientCapabilities() : capabilities;
  return {
    apps: rendersApps(caps),
    skills: !!services.skills && declaresExtension(caps, SKILLS_EXTENSION),
    tasks: era === 'modern' && declaresExtension(caps, TASKS_EXTENSION),
  };
}

const missingExtension = (id) => new ProtocolError(-32021, 'Missing required client capability', { requiredCapabilities: { extensions: { [id]: {} } } });

export function createMcpServer(services, { era, offer = offeredExtensions(services, { era }) } = {}) {
  const { engine, tasks } = services;
  const renders = offer.apps;
  const mcp = new McpServer(services.serverInfo || SERVER_INFO, {
    capabilities: serverCapabilities(services),
    instructions: services.instructionsFor(offer),
    cacheHints: { 'server/discover': PER_CLIENT, 'tools/list': PER_CLIENT, 'resources/list': PER_CLIENT, 'resources/templates/list': PER_CLIENT, 'resources/read': PER_CLIENT },
  });
  const server = mcp.server;

  server.setRequestHandler('tools/list', async () => {
    logLine('rpc', `tools/list → ${services.toolDefs.length} tools (${era || '?'}, apps=${renders})`);
    return { tools: services.toolDefs };
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args } = request.params;
    // an unknown tool is a protocol error (-32602) in every revision; a private engine method is
    // an unknown tool — a name never dispatches to anything but a tool
    if (!isCallableTool(engine, name)) throw new ProtocolError(-32602, unknownToolMessage(name).replace(/^unknown tool/, 'Unknown tool'));

    // The call's cancellation reaches its dbt processes only while the call is in flight: a task it
    // started is meant to outlive the call (the per-request transport closes when the response is
    // sent, which aborts this signal).
    const cancel = releasableSignal(ctx.mcpReq.signal);
    try {
      if (offer.tasks) return await callAsTask(name, args, cancel);
      const token = ctx.mcpReq._meta?.progressToken;
      const { result } = await runTool(engine, name, args, {
        signal: cancel.signal,
        renders,
        progressEveryMs: services.progressEveryMs,
        onProgress: token !== undefined ? (p) => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, ...p } }) : undefined,
      });
      return result;
    } finally {
      cancel.release();
    }
  });

  /**
   * The Tasks extension: a call that has not finished within services.taskAfterMs becomes a task
   * the client polls; one that has, answers inline. The work keeps its own cancellation from the
   * moment it becomes a task — the request that started it is over, tasks/cancel is the way to
   * stop it now. A call that waits on an engine task is followed to its end (runToCompletion).
   */
  async function callAsTask(name, args, requestCancel) {
    const ctl = new AbortController();
    const forward = () => ctl.abort(requestCancel.signal.reason);
    requestCancel.signal.addEventListener('abort', forward, { once: true });
    const work = runToCompletion(engine, name, args, { signal: ctl.signal, renders });
    const finished = await Promise.race([work.then((r) => r.result), new Promise((r) => { setTimeout(() => r(null), services.taskAfterMs).unref?.(); })]);
    requestCancel.signal.removeEventListener('abort', forward);
    if (finished) return finished;
    const t = tasks.create({ ctl, run: () => work.then((r) => r.result) });
    logLine(name, `↪ task ${t.taskId}`);
    return { resultType: 'task', ...tasks.detailed(t), statusMessage: 'The call is running; poll tasks/get.' };
  }

  // The view pages: listed and read for every client. A card already in a conversation is re-drawn by
  // the host when the chat is reopened — on this device or another — and that fetch need not carry
  // the Apps declaration; refusing it broke every stored card ("Connector not found"). A page is
  // static and draws only the result the host hands it: reading it offers nothing. What is OFFERED —
  // the tools that draw, the instructions — stays for a client that declares the extension.
  for (const { uri, name, ...meta } of services.apps.resources()) {
    mcp.registerResource(name, uri, meta, async () => {
      // what a host fetches to (re-)draw a card is one line away from its answer
      logLine('rpc', `resources/read ${uri} (${era || '?'}, apps=${renders})`);
      return { contents: services.apps.read(uri) };
    });
  }

  // Skills: the SDK's extension, served to every client — skills/list needs nothing of the client, and
  // the extension's clients call it once they see the server declare it (SEP-2640); what a client that
  // declared it gets beyond that is the pointer in the instructions (offer.skills)
  services.skillsExtension?.attach(mcp);

  // The Tasks extension's methods, for a client that declared it in this request. A task this server
  // does not know is the handler's answer (in-band); the SDK answers the entry checks (headers, the
  // envelope) before it.
  const taskOf = (taskId) => {
    if (!offer.tasks) throw missingExtension(TASKS_EXTENSION);
    const t = tasks.get(taskId);
    if (!t) throw new ProtocolError(-32602, 'Failed to retrieve task: Task not found (it never existed, or it ended more than its TTL ago)');
    return t;
  };
  server.setRequestHandler('tasks/get', { params: TaskParams, result: AnyResult }, async ({ taskId }) => tasks.detailed(taskOf(taskId)));
  server.setRequestHandler('tasks/cancel', { params: TaskParams, result: AnyResult }, async ({ taskId }) => {
    tasks.cancel(taskOf(taskId).taskId, 'Cancelled by the client (tasks/cancel).');
    return {};
  });
  // tasks/update carries input for a task waiting on the client; this server never asks for any,
  // so a response is acknowledged and ignored (the extension tells servers to ignore responses to
  // keys that are not outstanding)
  server.setRequestHandler('tasks/update', { params: TaskUpdateParams, result: AnyResult }, async ({ taskId }) => {
    taskOf(taskId);
    return {};
  });

  return mcp;
}

