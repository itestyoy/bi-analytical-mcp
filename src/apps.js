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
//     the spec's default is ["model", "app"]), except drill_result, which is ["model", "app"]: the
//     view's read of its own drawn task, served by the server only for a drawn task; a host refuses a
//     view's tools/call to any other;
//   * the view resource declares an empty `csp` — no connect/resource/frame origins, i.e. no fetch,
//     XHR, WebSocket, remote script or nested frame — and the page carries the same policy itself;
//   * the view's code has exactly one server call, drill_result, reached with its own drill-down
//     source and nothing else (a unit test holds its sources to that); the server serves it only
//     for a task that was drawn.

import { readFileSync } from 'node:fs';
import { assetPath, missingAssetMessage, RUNTIME_ASSETS } from './runtime-assets.js';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, EXTENSION_ID, getUiCapability } from '@modelcontextprotocol/ext-apps/server';

// WHAT DEPENDS ON THE CLIENT DECLARING THIS EXTENSION (with this view's MIME type, in the request
// served — src/client-extensions.js): what speaks to its MODEL — the card instructions and the
// show_to_user hint — and what would DRAW — a call to display_model_result, `card` on experiment.
// The tool list, `_meta.ui` and the view page are the same for every client, as the official
// ext-apps registerAppTool serves them: a host re-drawing a card already in a conversation
// (reopened, or on another device) finds its tool and page on requests that need not carry the
// declaration, and hiding them broke every stored card ("Connector not found").

/** Whether a set of client capabilities declares that it renders this view. */
export function rendersApps(clientCapabilities) {
  const ui = getUiCapability(clientCapabilities);
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE);
}

export { RESOURCE_MIME_TYPE, EXTENSION_ID as UI_EXTENSION };
export const RESULT_VIEW_URI = 'ui://betti/result-view.html';
export const RESULT_VIEW_FILE = RUNTIME_ASSETS.resultView.path;

// The tools whose result is drawn: display_model_result (a model's rows) and experiment (the A/B test;
// its split check and plan are answered in words — a card only for a visual shape, buildViewModel). Nothing else carries the view — not a query, not a build, not a query
// tool's read of a task — so no read, no poll and no intermediate step ever draws.
export const VIEWED_TOOLS = new Set(['display_model_result', 'experiment']);

/** Who may call a tool: the model only — never a view (see the header). */
export const TOOL_VISIBILITY = Object.freeze(['model']);
/**
 * The one tool a view calls: the card reading the next view of its own drawn task. Its visibility is
 * ["model", "app"] — the spec's default — and not ["app"] alone: a host refused the card's call to an
 * app-only tool ("Could not load this level"), while this pair is what hosts serve. What keeps it the
 * card's own read is the server: it answers only for a task that was DRAWN.
 */
export const APP_CALLABLE_TOOLS = Object.freeze(['drill_result']);
/** Tools that exist only with the view: a call that draws is accepted only from a client that renders MCP Apps (drill_result: only for a drawn task). */
export const APPS_ONLY_TOOLS = new Set(['display_model_result', 'drill_result']);
const visibilityOf = (tool) => (APP_CALLABLE_TOOLS.includes(tool) ? [...TOOL_VISIBILITY, 'app'] : [...TOOL_VISIBILITY]);

/**
 * The `_meta` every tool carries: its visibility, and — for a viewed tool — the view, in both
 * spellings registerAppTool writes. `featureView` is the view of a feature's drawing tool (its own
 * page, src/features.js); a core viewed tool draws into the result view.
 */
export function viewMeta(tool, featureView = null) {
  const uri = featureView?.uri || (VIEWED_TOOLS.has(tool) ? RESULT_VIEW_URI : null);
  return uri
    ? { ui: { resourceUri: uri, visibility: visibilityOf(tool) }, [RESOURCE_URI_META_KEY]: uri }
    : { ui: { visibility: visibilityOf(tool) } };
}

/** The view's network policy: nothing. Maps to CSP connect-src / resource / frame-src 'none'. */
export const VIEW_CSP = Object.freeze({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });

const RESOURCE = {
  uri: RESULT_VIEW_URI,
  name: 'result-view',
  title: 'Query Result',
  description: 'Interactive card for a result: a chart as the caller declares it (line, multi-line, stacked area, grouped/stacked/horizontal bars, a pie of shares, a sankey of flows — drillable where declared: a click opens a mark into a dimension), KPI tiles with a trend, a drill-down pivot table (the only table), a funnel (steps, conversion, biggest drop), or an A/B test (lift, interval, verdict per variant). Drawn only for a visual shape; a single number, a row or two, a verdict or a plan is answered in words, and gets one status line.',
  mimeType: RESOURCE_MIME_TYPE,
  _meta: { ui: { prefersBorder: true, csp: VIEW_CSP } },
};

const pages = new Map(); // asset → html, read once: a page is static, the data arrives by message
function page(asset) {
  if (!pages.has(asset)) {
    const file = assetPath(asset);
    if (!file) throw new Error(missingAssetMessage(asset));
    pages.set(asset, readFileSync(file, 'utf8'));
  }
  return pages.get(asset);
}

/**
 * The view pages this server serves: the result view, and the view of each feature that draws
 * (src/features.js) — each its own `ui://` page with the same empty network policy.
 */
export const appsSurface = (features = []) => {
  const views = [
    { resource: RESOURCE, asset: 'resultView' },
    ...features.filter((f) => f.view).map((f) => ({
      resource: { uri: f.view.uri, name: f.view.name, title: f.view.title, description: f.view.description, mimeType: RESOURCE_MIME_TYPE, _meta: RESOURCE._meta },
      asset: f.view.asset,
    })),
  ];
  return {
    resources: () => views.map((v) => v.resource),
    read(uri) {
      const v = views.find((x) => x.resource.uri === uri);
      return v ? [{ uri, mimeType: RESOURCE_MIME_TYPE, text: page(v.asset), _meta: v.resource._meta }] : null;
    },
  };
};
