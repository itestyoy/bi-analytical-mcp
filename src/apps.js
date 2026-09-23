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

/** The `_meta` a viewed tool carries (both spellings, as registerAppTool writes them), or null. */
export function viewMeta(tool) {
  return VIEWED_TOOLS.has(tool) ? { ui: { resourceUri: RESULT_VIEW_URI }, [RESOURCE_URI_META_KEY]: RESULT_VIEW_URI } : null;
}

const RESOURCE = {
  uri: RESULT_VIEW_URI,
  name: 'result-view',
  title: 'Query Result',
  description: 'Interactive card for a result: a chart (time series or breakdown, rows folded underneath), an A/B test (lift, interval, verdict per variant), or a funnel (steps, conversion, biggest drop). Other results draw nothing.',
  mimeType: RESOURCE_MIME_TYPE,
  _meta: { ui: { prefersBorder: true } },
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
