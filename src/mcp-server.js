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
// The tools are registered on the low-level `Server`, the SDK's documented path for a JSON Schema
// you already have (docs: "Low-level Server"): our input schemas are built from the catalog, and
// the engine validates arguments itself so a refusal comes back as a tool error the model can fix,
// naming the field and the branch.
//
// The three extensions, each declared in `capabilities.extensions`:
//   * Apps  (io.modelcontextprotocol/ui)     — `_meta.ui` on the viewed tools, the `ui://` view;
//   * Skills (io.modelcontextprotocol/skills) — skills/list, skills/get, files via resources/read;
//   * Tasks (io.modelcontextprotocol/tasks)   — a call that outgrows its window comes back as a
//     task (`resultType: "task"`); tasks/update here; tasks/get and tasks/cancel are served in
//     front of the SDK (src/mcp-tasks.js) until the SDK serves the extension itself.

import { z } from 'zod';
import { Server, ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/server';
import { SERVER_INFO, isCallableTool, runTool, runToCompletion, logLine, unknownToolMessage } from './mcp-surface.js';
import { releasableSignal } from './request-context.js';
import { UI_EXTENSION, RESOURCE_MIME_TYPE, rendersApps } from './apps.js';
import { clientCapabilities, declaresExtension } from './client-extensions.js';
import { SKILLS_EXTENSION } from './skills.js';
import { LIST_TTL_MS } from './surface-change.js';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

// Nothing this server lists changes while it runs. What it lists and says depends on which
// extensions the client declared (src/client-extensions.js), so those answers are its own to cache.
const STATIC = { ttlMs: 3600000, cacheScope: 'public' };
// A client may cache the lists and server/discover for LIST_TTL_MS — short, so a deploy that changes
// them reaches it within a minute even when no subscription stream is open (src/surface-change.js).
const PER_CLIENT = { ttlMs: LIST_TTL_MS, cacheScope: 'private' };

const SkillsListParams = z.object({ cursor: z.string().optional() }).passthrough();
const SkillsGetParams = z.object({ uri: z.string() }).passthrough();
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
 * Which extensions a server built for this request offers: each only if the client declared it IN
 * this request (a 2026-07-28 envelope) — a 2025 client carries no capabilities past initialize
 * (src/client-extensions.js). Apps also needs the view's MIME type among the declared ones.
 */
export function offeredExtensions(services, { era } = {}) {
  const caps = era === 'modern' ? clientCapabilities() : null;
  return {
    apps: rendersApps(caps),
    skills: !!services.skills && declaresExtension(caps, SKILLS_EXTENSION),
    tasks: declaresExtension(caps, TASKS_EXTENSION),
  };
}

const missingExtension = (id) => new ProtocolError(-32021, 'Missing required client capability', { requiredCapabilities: { extensions: { [id]: {} } } });

export function createMcpServer(services, { era, offer = offeredExtensions(services, { era }) } = {}) {
  const { engine, tasks } = services;
  const renders = offer.apps;
  const variant = renders ? 'apps' : 'plain';
  const server = new Server(services.serverInfo || SERVER_INFO, {
    capabilities: serverCapabilities(services),
    instructions: services.instructionsFor(offer),
    cacheHints: { 'server/discover': PER_CLIENT, 'tools/list': PER_CLIENT, 'resources/list': PER_CLIENT, 'resources/templates/list': PER_CLIENT, 'resources/read': PER_CLIENT },
  });

  server.setRequestHandler('tools/list', async () => {
    logLine('rpc', `tools/list → ${services.toolDefs[variant].length} tools (${era || '?'}, apps=${renders})`);
    return { tools: services.toolDefs[variant] };
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

  server.setRequestHandler('resources/list', async () => {
    const resources = services.resources(offer);
    logLine('rpc', `resources/list → ${resources.length} (${era || '?'}, apps=${renders})`);
    return { resources };
  });
  server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: services.templates(offer) }));
  server.setRequestHandler('resources/read', async (request) => {
    const contents = services.read(request.params.uri, offer);
    // what a host fetches to (re-)draw a card is one line away from its answer
    logLine('rpc', `resources/read ${String(request.params.uri).slice(0, 120)} → ${contents ? 'ok' : 'NOT FOUND'} (${era || '?'}, apps=${renders})`);
    // the SDK puts this on the wire as each revision spells it (-32002 in 2025, -32602 in 2026-07-28)
    if (!contents) throw new ResourceNotFoundError(request.params.uri);
    return { contents };
  });

  if (services.skills) {
    // served to a client that declared the Skills extension in this request, refused to any other
    server.setRequestHandler('skills/list', { params: SkillsListParams, result: AnyResult }, async () => {
      if (!offer.skills) throw missingExtension(SKILLS_EXTENSION);
      return { skills: services.skills.list(), ...STATIC };
    });
    server.setRequestHandler('skills/get', { params: SkillsGetParams, result: AnyResult }, async ({ uri }) => {
      if (!offer.skills) throw missingExtension(SKILLS_EXTENSION);
      const s = services.skills.get(uri);
      if (!s) throw new ProtocolError(-32602, `Not a skill this server serves: ${uri}`);
      return { skill: s };
    });
  }

  // tasks/update carries input for a task waiting on the client; this server never asks for any,
  // so a response is acknowledged and ignored (the extension tells servers to ignore responses to
  // keys that are not outstanding). tasks/get and tasks/cancel: src/mcp-tasks.js.
  server.setRequestHandler('tasks/update', { params: TaskUpdateParams, result: AnyResult }, async ({ taskId }) => {
    if (!offer.tasks) throw missingExtension(TASKS_EXTENSION);
    if (!tasks.get(taskId)) throw new ProtocolError(-32602, 'Failed to retrieve task: Task not found');
    return {};
  });

  return server;
}

