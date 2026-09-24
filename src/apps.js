// MCP APPS (extension `io.modelcontextprotocol/ui`, SEP-1865) — the result of a tool call rendered
// as an interactive view inside the host's conversation, next to the text the model reads.
//
// The server half, done the way the official ext-apps SDK does it (`registerAppTool` /
// `registerAppResource` in @modelcontextprotocol/ext-apps/server — our tools are registered on the
// low-level Server because their input schemas are catalog-built JSON Schema, so the same two
// pieces are applied here from that package's own constants):
//   * the tool carries `_meta.ui.resourceUri` AND the flat `_meta["ui/resourceUri"]` key older
//     hosts read — `registerAppTool` writes both, and so does `viewMeta` below;
//   * the view is a `ui://` resource of type `text/html;profile=mcp-app`: ONE self-contained HTML
//     file, built from src/apps/result-view/ by vite + vite-plugin-singlefile exactly like the
//     official examples (`npm run build:app`); the built file is checked in and a test holds it
//     to its sources.
// A host without the extension ignores `_meta.ui`: the tool is the plain tool it always was.
//
// TWO TOOLS DRAW, EACH ITS OWN KIND OF RESULT. display_model_result draws a FINISHED model task's
// result — a semantic query or a pipeline — read the way the query tools read a task, each task at
// most once: one question gets one card by construction, and starting, reading and showing a result
// stay three separate calls. experiment is a process of its own — statistics over numbers the
// caller brings, no task — and draws its own card when the call asks for it (card: true).
//
// THE VIEW DRAWS, AND READS ONLY ITS OWN RESULT — nothing else. It gets the result the host hands
// it; the ONE thing it may ask for is more of that same result, through drill_result: a
// drill-down's next view — a pivot row opened, a chart mark clicked (its task's stored table,
// filtered to the path taken). Held in three places, so no single one is load-bearing:
//   * every tool declares `_meta.ui.visibility` — ["model"] (callable by the model, NOT by a view;
//     the spec's default is ["model", "app"]), except drill_result, which is ["app"]: the view's
//     read of its own drawn task, which the model never sees; a host refuses a view's tools/call to
//     any other;
//   * the view resource declares an empty `csp` — no connect/resource/frame origins, i.e. no fetch,
//     XHR, WebSocket, remote script or nested frame — and the page carries the same policy itself;
//   * the view's code has exactly one server call, drill_result, reached with its own drill-down
//     source and nothing else (a unit test holds its sources to that); the server serves it only
//     for a task that was drawn.

import { readFileSync } from 'node:fs';
import { assetPath, missingAssetMessage, RUNTIME_ASSETS } from './runtime-assets.js';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, EXTENSION_ID, getUiCapability } from '@modelcontextprotocol/ext-apps/server';

// OFFERED ONLY TO A CLIENT THAT SAYS IT RENDERS THEM (src/client-extensions.js): `_meta.ui` on the
// tools, the view resource, the `display` declaration, the instructions and hints about cards —
// only for a client that declares this extension WITH this view's MIME type in the request served.

/** Whether a set of client capabilities declares that it renders this view. */
export function rendersApps(clientCapabilities) {
  const ui = getUiCapability(clientCapabilities);
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE);
}

export { RESOURCE_MIME_TYPE, EXTENSION_ID as UI_EXTENSION };
export const RESULT_VIEW_URI = 'ui://betti/result-view.html';
export const RESULT_VIEW_FILE = RUNTIME_ASSETS.resultView.path;

// The tools whose result is drawn: display_model_result (a model's rows) and experiment (the test, the
// split check, the plan). Nothing else carries the view — not a query, not a build, not a query
// tool's read of a task — so no read, no poll and no intermediate step ever draws.
export const VIEWED_TOOLS = new Set(['display_model_result', 'experiment']);

/** Who may call a tool: the model only — never a view (see the header). */
export const TOOL_VISIBILITY = Object.freeze(['model']);
/** The one tool a view calls, and ONLY a view: the card reading the next view of its own drawn task. */
export const APP_CALLABLE_TOOLS = Object.freeze(['drill_result']);
/** Tools that exist only with the view: offered to a client that renders MCP Apps, and to no other. */
export const APPS_ONLY_TOOLS = new Set(['display_model_result', 'drill_result']);
const visibilityOf = (tool) => (APP_CALLABLE_TOOLS.includes(tool) ? ['app'] : [...TOOL_VISIBILITY]);

/**
 * The `_meta` every tool carries: its visibility, and — for a viewed tool — the view, in both
 * spellings registerAppTool writes.
 */
export function viewMeta(tool, renders = true) {
  if (!renders) return undefined; // a client without the extension gets no `_meta.ui` at all
  return VIEWED_TOOLS.has(tool)
    ? { ui: { resourceUri: RESULT_VIEW_URI, visibility: visibilityOf(tool) }, [RESOURCE_URI_META_KEY]: RESULT_VIEW_URI }
    : { ui: { visibility: visibilityOf(tool) } };
}

/** The view's network policy: nothing. Maps to CSP connect-src / resource / frame-src 'none'. */
export const VIEW_CSP = Object.freeze({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });

const RESOURCE = {
  uri: RESULT_VIEW_URI,
  name: 'result-view',
  title: 'Query Result',
  description: 'Interactive card for a result: a chart as the caller declares it (line, multi-line, stacked area, grouped/stacked/horizontal bars, a pie of shares, a sankey of flows — drillable where declared: a click opens a mark into a dimension), KPI tiles, a drill-down pivot table (the only table), a funnel (steps, conversion, biggest drop), or the A/B family — the test (lift, interval, verdict per variant), the sample-ratio check and the sample-size plan. Other results get one status line.',
  mimeType: RESOURCE_MIME_TYPE,
  _meta: { ui: { prefersBorder: true, csp: VIEW_CSP } },
};

let html; // read once: the page is static, the data arrives by message
export const appsSurface = () => ({
  resources: () => [RESOURCE],
  read(uri) {
    if (uri !== RESULT_VIEW_URI) return null;
    if (html === undefined) {
      const file = assetPath('resultView');
      if (!file) throw new Error(missingAssetMessage('resultView'));
      html = readFileSync(file, 'utf8');
    }
    return [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: RESOURCE._meta }];
  },
});
