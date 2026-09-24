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
// THE VIEW DRAWS, AND READS ONLY ITS OWN RESULT — nothing else. It gets the result the host hands
// it; the ONE thing it may ask for is more of that same result, through get_query_result: the rows
// of a query that outlasted its call (it polls THAT query_id, so the result appears in the card that
// announced it), and the next level of a drill-down when a row opens (its stored table, filtered to
// that row). Held in three places, so no single one is load-bearing:
//   * every tool declares `_meta.ui.visibility` — ["model"] (callable by the model, NOT by a view;
//     the spec's default is ["model", "app"]), except get_query_result, a read-only lookup of a
//     finished result, which is ["model", "app"]; a host refuses a view's tools/call to any other;
//   * the view resource declares an empty `csp` — no connect/resource/frame origins, i.e. no fetch,
//     XHR, WebSocket, remote script or nested frame — and the page carries the same policy itself;
//   * the view's code has exactly one server call, get_query_result, reached with its own query_id or
//     its own drill-down source and nothing else (a unit test holds its sources to that).

import { readFileSync } from 'node:fs';
import { assetPath, missingAssetMessage, RUNTIME_ASSETS } from './runtime-assets.js';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, EXTENSION_ID } from '@modelcontextprotocol/ext-apps/server';

export { RESOURCE_MIME_TYPE, EXTENSION_ID as UI_EXTENSION };
export const RESULT_VIEW_URI = 'ui://betti/result-view.html';
export const RESULT_VIEW_FILE = RUNTIME_ASSETS.resultView.path;

// The tools whose results are data a person looks at. NOT semantic_index: it is the most frequent
// call and mostly returns catalog structure — a view on every exploration step would bury the
// conversation.
const VIEWED_TOOLS = new Set(['query_semantic_model', 'get_query_result', 'experiment']);

/** Who may call a tool: the model only — never a view (see the header). */
export const TOOL_VISIBILITY = Object.freeze(['model']);
/** The one tool a view may also call: the card following its own detached query to its rows. */
export const APP_CALLABLE_TOOLS = Object.freeze(['get_query_result']);
const visibilityOf = (tool) => (APP_CALLABLE_TOOLS.includes(tool) ? [...TOOL_VISIBILITY, 'app'] : [...TOOL_VISIBILITY]);

/**
 * The `_meta` every tool carries: its visibility, and — for a viewed tool — the view, in both
 * spellings registerAppTool writes.
 */
export function viewMeta(tool) {
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
  description: 'Interactive card for a result: a chart as the caller declares it (line, multi-line, stacked area, grouped/stacked/horizontal bars, a pie of shares, a sankey of flows — rows folded underneath), KPI tiles, a drill-down pivot table, a funnel (steps, conversion, biggest drop), or the A/B family — the test (lift, interval, verdict per variant), the sample-ratio check and the sample-size plan. Other results get one status line.',
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
