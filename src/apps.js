// MCP APPS (extension `io.modelcontextprotocol/ui`, SEP-1865) — the result of a tool call rendered
// as an interactive view inside the host's conversation, next to the text the model reads.
//
// What this server ships: ONE view, `ui://betti/result-view`, attached to the tools whose results
// are data a person looks at — a metric query, a stored result, an A/B test.
// It shows the rows as a sortable, filterable table and adds a chart when the rows have a shape a
// chart shows better (a time series, a category breakdown), an A/B card with the interval, or the
// distribution. WHAT it shows is decided by src/apps/result-view-model.js — a pure function the
// page inlines, so the browser runs exactly the code the unit tests run.
//
// The contract, in the order the spec states it:
//   * the tool carries `_meta.ui.resourceUri`; a host without the extension ignores it and the tool
//     is exactly the text-only tool it always was (and the server only adds it for a client that
//     declared the extension — src/mcp-surface.js);
//   * the host fetches the resource with resources/read: `text/html;profile=mcp-app`, a complete
//     HTML5 document with no external origins (so the host's restrictive default CSP is enough);
//   * the page speaks the Apps dialect over postMessage: `ui/initialize` → `ui/notifications/
//     initialized`, then `ui/notifications/tool-input` and `…/tool-result` from the host; it
//     reports its size (`ui/notifications/size-changed`) and answers `ui/resource-teardown`;
//   * the data arrives as the CallToolResult's `structuredContent`, which the host gives the view
//     and does NOT add to the model's context — the model keeps reading the text.

import { buildViewModel } from './apps/result-view-model.js';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const APP_MIME = 'text/html;profile=mcp-app';
export const RESULT_VIEW_URI = 'ui://betti/result-view';

// the tools whose results the view renders. NOT semantic_index: it is the most frequent call and
// mostly returns catalog structure — a view on every exploration step would bury the conversation.
const VIEWED_TOOLS = new Set(['query_semantic_model', 'get_query_result', 'experiment']);

/** True when the client declared the Apps extension with the HTML profile this server serves. */
export function clientSupportsUi(capabilities) {
  const ext = capabilities?.extensions?.[UI_EXTENSION];
  return !!ext && Array.isArray(ext.mimeTypes) && ext.mimeTypes.includes(APP_MIME);
}

const RESOURCE = {
  uri: RESULT_VIEW_URI,
  name: 'result-view',
  title: 'Result view',
  description: 'Interactive view of a query result: sortable table, a chart when the rows form a time series or a breakdown, A/B significance with its interval, a sample-size plan, the SQL of an explained query.',
  mimeType: APP_MIME,
  _meta: { ui: { prefersBorder: true } },
};

let html; // built once: the page is static, the data arrives by message
function pageHtml() {
  html ??= renderPage();
  return html;
}

export function appsSurface() {
  return {
    viewFor: (tool) => (VIEWED_TOOLS.has(tool) ? RESULT_VIEW_URI : null),
    resources: () => [RESOURCE],
    read(uri) {
      if (uri !== RESULT_VIEW_URI) return null;
      return [{ uri, mimeType: APP_MIME, text: pageHtml(), _meta: RESOURCE._meta }];
    },
  };
}

function renderPage() {
  // The categorical slots of the reference palette (dataviz skill, validated light/dark in order);
  // text never wears a series colour.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Result view</title>
<style>
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, #fcfcfb);
  --bg2: var(--color-background-secondary, #f4f3f0);
  --ink: var(--color-text-primary, #0b0b0b);
  --ink2: var(--color-text-secondary, #52514e);
  --ink3: var(--color-text-tertiary, #7b7a75);
  --line: var(--color-border-secondary, #e3e2de);
  --good: #0ca30c; --critical: #d03b3b;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300;
  --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --mono: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #1a1a19); --bg2: var(--color-background-secondary, #242422);
  --ink: var(--color-text-primary, #ffffff); --ink2: var(--color-text-secondary, #c3c2b7); --ink3: var(--color-text-tertiary, #8f8e86);
  --line: var(--color-border-secondary, #34342f);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.45 var(--font); }
main { padding: 12px 14px 14px; }
h1 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
.sub { color: var(--ink2); font-size: 12px; margin-bottom: 10px; }
.bar { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
input[type=search] { flex: 1; min-width: 140px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); font: inherit; }
button { padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg2); color: var(--ink); font: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.wrap { overflow: auto; max-height: 420px; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 9px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--bg2); font-weight: 600; cursor: pointer; user-select: none; color: var(--ink2); }
td.n, th.n { text-align: right; }
td.null { color: var(--ink3); font-style: italic; }
.chart { margin: 6px 0 10px; position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.axis text { fill: var(--ink3); font-size: 11px; }
.grid line { stroke: var(--line); stroke-width: 1; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; color: var(--ink2); font-size: 12px; margin-top: 4px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.tip { position: absolute; pointer-events: none; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.12); display: none; white-space: nowrap; z-index: 2; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.big { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.status { font-size: 12px; font-weight: 600; }
.status.good::before { content: "✓ "; color: var(--good); }
.status.bad::before { content: "✕ "; color: var(--critical); }
.status.neutral::before { content: "• "; color: var(--ink3); }
pre { font: 12px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; margin: 0; }
.note { color: var(--ink2); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<main id="app"><div class="sub">Waiting for the result…</div></main>
<script>
"use strict";
const buildViewModel = ${buildViewModel.toString()};

// ── the Apps dialect over postMessage (JSON-RPC 2.0) ─────────────────────────────────────────
let nextId = 1;
const pending = new Map();
const post = (msg) => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
function request(method, params) {
  const id = nextId++;
  post({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const notify = (method, params) => post({ method, params });

const state = { toolName: null, toolInput: null, result: null, sort: null, filter: "", hostCaps: {} };

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const m = event.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && !m.method && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || "request failed")); else p.resolve(m.result);
    return;
  }
  switch (m.method) {
    case "ui/notifications/tool-input": state.toolInput = m.params?.arguments || null; break;
    case "ui/notifications/tool-result": state.result = m.params; render(); break;
    case "ui/notifications/tool-cancelled": renderMessage("Cancelled", m.params?.reason || "The tool call was cancelled."); break;
    case "ui/notifications/host-context-changed": applyContext(m.params || {}); break;
    case "ui/resource-teardown": post({ id: m.id, result: {} }); break;
    case "ping": post({ id: m.id, result: {} }); break;
    default: if (m.id !== undefined && m.method) post({ id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});

function applyContext(ctx) {
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  const vars = ctx.styles?.variables || {};
  for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
  if (ctx.toolInfo?.tool?.name) state.toolName = ctx.toolInfo.tool.name;
  const d = ctx.containerDimensions;
  if (d && "maxHeight" in d && d.maxHeight) document.documentElement.style.maxHeight = d.maxHeight + "px";
}

// ── rendering (all data goes in through textContent: values are never markup) ────────────────
const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const k of kids) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : String(k));
  return n;
};
const svgEl = (tag, attrs) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };
const fmt = (v) => { if (v === null || v === undefined) return "—"; const n = typeof v === "number" ? v : Number(v); if (!Number.isFinite(n)) return String(v); return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Math.abs(n) < 1 && n !== 0 ? n.toPrecision(3) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }); };
const pct = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(2) + "%");
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"].map((v) => "var(" + v + ")");

function payload(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || []).find((c) => c.type === "text")?.text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function renderMessage(title, message) {
  const app = document.getElementById("app");
  app.replaceChildren(el("h1", null, title), el("div", { class: "sub" }, message));
}

function render() {
  const model = buildViewModel(state.toolName, payload(state.result), state.toolInput);
  const app = document.getElementById("app");
  const parts = [el("h1", null, model.title)];
  if (model.kind === "running") parts.push(el("div", { class: "sub" }, model.message + " (query_id " + model.query_id + ")"));
  else if (model.kind === "error") parts.push(el("div", { class: "status bad" }, (model.stage ? model.stage + ": " : "") + model.message));
  else if (model.kind === "experiment") parts.push(...experimentView(model));
  else if (model.kind === "srm") parts.push(...srmView(model));
  else if (model.kind === "distribution") { parts.push(el("div", { class: "sub" }, [model.distinct !== null ? fmt(model.distinct) + " distinct" : null, model.total !== null ? fmt(model.total) + " rows" : null].filter(Boolean).join(" · "))); parts.push(barChart({ bars: model.bars, y: "freq" }, true)); parts.push(tableView(model)); }
  else if (model.kind === "table") parts.push(...tableSection(model));
  else if (model.kind === "plan") parts.push(el("div", { class: "cards" }, ...model.figures.map((f) => el("div", { class: "card" }, el("div", { class: "sub" }, f.label), el("div", { class: "big" }, f.percent ? pct(f.value) : fmt(f.value))))));
  else if (model.kind === "sql") parts.push(el("pre", null, model.sql));
  else parts.push(el("pre", null, JSON.stringify(model.json, null, 2)));
  app.replaceChildren(...parts);
}

function tableSection(model) {
  const out = [];
  const bits = [model.row_count + " row" + (model.row_count === 1 ? "" : "s")];
  if (model.page) bits.push("offset " + model.page.offset);
  if (model.sampled) bits.push("random sample");
  if (model.approximate) bits.push("approximate");
  out.push(el("div", { class: "sub" }, bits.join(" · ")));
  if (model.chart?.type === "line") out.push(lineChart(model.chart));
  if (model.chart?.type === "bar") out.push(barChart(model.chart, false));
  const tools = el("div", { class: "bar" });
  const search = el("input", { type: "search", placeholder: "Filter rows…", "aria-label": "Filter rows" });
  search.value = state.filter;
  search.addEventListener("input", () => { state.filter = search.value; const t = tableView(model); holder.replaceChildren(t); });
  tools.append(search);
  if (model.nextPage && state.hostCaps.serverTools) {
    const next = el("button", { type: "button" }, "Next page");
    next.addEventListener("click", async () => {
      next.disabled = true;
      try { state.toolInput = model.nextPage.arguments; state.result = await request("tools/call", model.nextPage); render(); }
      catch (e) { next.disabled = false; next.textContent = "Next page (failed: " + e.message + ")"; }
    });
    tools.append(next);
  }
  out.push(tools);
  const holder = el("div", null, tableView(model));
  out.push(holder);
  return out;
}

function tableView(model) {
  const q = state.filter.trim().toLowerCase();
  let rows = q ? model.rows.filter((r) => r.some((v) => v !== null && String(v).toLowerCase().includes(q))) : model.rows.slice();
  if (state.sort && state.sort.i < model.columns.length) {
    const { i, dir } = state.sort; const numeric = model.columns[i].type === "number";
    rows.sort((a, b) => { const x = a[i], y = b[i]; if (x === null) return 1; if (y === null) return -1; const c = numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y)); return dir * c; });
  }
  const head = el("tr", null, ...model.columns.map((c, i) => {
    const th = el("th", { class: c.type === "number" ? "n" : "", scope: "col" }, c.name + (state.sort?.i === i ? (state.sort.dir > 0 ? " ▲" : " ▼") : ""));
    th.addEventListener("click", () => { state.sort = { i, dir: state.sort?.i === i ? -state.sort.dir : 1 }; render(); });
    return th;
  }));
  const body = rows.map((r) => el("tr", null, ...r.map((v, i) => el("td", { class: (model.columns[i].type === "number" ? "n" : "") + (v === null ? " null" : "") }, v === null ? "null" : model.columns[i].type === "number" ? fmt(v) : String(v)))));
  return el("div", { class: "wrap" }, el("table", null, el("thead", null, head), el("tbody", null, ...body)));
}

function frame(width, height) {
  const svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, role: "img" });
  const box = el("div", { class: "chart" }, svg);
  const tip = el("div", { class: "tip" });
  box.append(tip);
  const show = (html, x, y) => { tip.replaceChildren(...html); tip.style.display = "block"; tip.style.left = Math.min(x + 12, box.clientWidth - tip.offsetWidth - 4) + "px"; tip.style.top = Math.max(0, y - 10) + "px"; };
  const hide = () => { tip.style.display = "none"; };
  return { svg, box, show, hide };
}

// a bar whose DATA end is rounded and whose baseline end is square
function vBar(x, y, w, h, r) { r = Math.min(r, w / 2, h); return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z"; }
function hBar(x, y, w, h, r) { r = Math.min(r, h / 2, w); return "M" + x + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h - r) + "Q" + (x + w) + "," + (y + h) + " " + (x + w - r) + "," + (y + h) + "H" + x + "Z"; }

function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

function lineChart(chart) {
  const W = 640, H = 220, L = 48, R = 12, T = 10, B = 24;
  const xs = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p[0])))].sort();
  const ymax = niceMax(Math.max(0, ...chart.series.flatMap((s) => s.points.map((p) => p[1]))));
  const ymin = Math.min(0, ...chart.series.flatMap((s) => s.points.map((p) => p[1])));
  const X = (x) => L + (xs.length === 1 ? (W - L - R) / 2 : (xs.indexOf(x) / (xs.length - 1)) * (W - L - R));
  const Y = (y) => T + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - T - B);
  const { svg, box, show, hide } = frame(W, H);
  const grid = svgEl("g", { class: "grid" }); const axis = svgEl("g", { class: "axis" });
  for (let k = 0; k <= 4; k++) { const v = ymin + ((ymax - ymin) * k) / 4; grid.append(svgEl("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) })); const t = svgEl("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end" }); t.textContent = fmt(v); axis.append(t); }
  const step = Math.max(1, Math.ceil(xs.length / 6));
  xs.forEach((x, i) => { if (i % step === 0 || i === xs.length - 1) { const anchor = xs.length > 1 && i === xs.length - 1 ? "end" : xs.length > 1 && i === 0 ? "start" : "middle"; const t = svgEl("text", { x: X(x), y: H - 6, "text-anchor": anchor }); t.textContent = String(x).slice(0, 10); axis.append(t); } });
  svg.append(grid, axis);
  chart.series.forEach((s, i) => {
    const d = s.points.map((p, j) => (j ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join("");
    svg.append(svgEl("path", { d, fill: "none", stroke: SERIES[i], "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    if (s.points.length <= 40) s.points.forEach((p) => svg.append(svgEl("circle", { cx: X(p[0]), cy: Y(p[1]), r: 3, fill: SERIES[i], stroke: "var(--bg)", "stroke-width": 2 })));
  });
  const cross = svgEl("line", { y1: T, y2: H - B, stroke: "var(--ink3)", "stroke-width": 1, visibility: "hidden" });
  const hit = svgEl("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
  svg.append(cross, hit);
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W;
    let best = xs[0]; for (const x of xs) if (Math.abs(X(x) - px) < Math.abs(X(best) - px)) best = x;
    cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best)); cross.setAttribute("visibility", "visible");
    const lines = [el("div", null, el("b", null, String(best)))];
    chart.series.forEach((s, i) => { const p = s.points.find((q) => q[0] === best); if (p) lines.push(el("div", null, el("i", { style: "display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:" + SERIES[i] }), s.name + ": " + fmt(p[1]))); });
    show(lines, e.clientX - box.getBoundingClientRect().left, e.clientY - box.getBoundingClientRect().top);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hide(); });
  if (chart.series.length > 1 || chart.folded) {
    const legend = el("div", { class: "legend" }, ...chart.series.map((s, i) => el("span", null, el("i", { style: "background:" + SERIES[i] }), s.name)));
    if (chart.folded) legend.append(el("span", null, "+" + chart.folded + " more in the table"));
    box.append(legend);
  }
  return box;
}

function barChart(chart, horizontal) {
  const bars = chart.bars.slice(0, 30);
  const W = 640, rowH = 22;
  if (horizontal || bars.length > 8) {
    const L = 150, R = 60, H = bars.length * rowH + 8;
    const max = niceMax(Math.max(0, ...bars.map((b) => b.value)));
    const { svg, box, show, hide } = frame(W, H);
    bars.forEach((b, i) => {
      const y = 4 + i * rowH; const w = Math.max(0, (b.value / max) * (W - L - R));
      const label = svgEl("text", { x: L - 8, y: y + 14, "text-anchor": "end", fill: "var(--ink2)", "font-size": 12 }); label.textContent = b.label.length > 22 ? b.label.slice(0, 21) + "…" : b.label;
      const rect = svgEl("path", { d: hBar(L, y + 3, w, rowH - 6, 4), fill: SERIES[0] });
      const val = svgEl("text", { x: L + w + 6, y: y + 14, fill: "var(--ink2)", "font-size": 11 }); val.textContent = fmt(b.value);
      const hitr = svgEl("rect", { x: 0, y, width: W, height: rowH, fill: "transparent" });
      hitr.addEventListener("mousemove", (e) => show([el("b", null, b.label), el("div", null, (chart.y || "value") + ": " + fmt(b.value))], e.clientX - box.getBoundingClientRect().left, e.clientY - box.getBoundingClientRect().top));
      hitr.addEventListener("mouseleave", hide);
      svg.append(label, rect, val, hitr);
    });
    return box;
  }
  const H = 200, L = 48, R = 12, T = 10, B = 28;
  const max = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const bw = (W - L - R) / bars.length;
  const { svg, box, show, hide } = frame(W, H);
  const grid = svgEl("g", { class: "grid" }); const axis = svgEl("g", { class: "axis" });
  for (let k = 0; k <= 4; k++) { const v = (max * k) / 4; const y = T + (1 - v / max) * (H - T - B); grid.append(svgEl("line", { x1: L, x2: W - R, y1: y, y2: y })); const t = svgEl("text", { x: L - 6, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(v); axis.append(t); }
  svg.append(grid, axis);
  bars.forEach((b, i) => {
    const h = (b.value / max) * (H - T - B); const x = L + i * bw + 2; const y = H - B - h;
    const rect = svgEl("path", { d: vBar(x, y, Math.max(1, bw - 4), Math.max(0, h), 4), fill: SERIES[0] });
    const t = svgEl("text", { x: x + (bw - 4) / 2, y: H - 10, "text-anchor": "middle" }); t.textContent = b.label.length > 12 ? b.label.slice(0, 11) + "…" : b.label; axis.append(t);
    rect.addEventListener("mousemove", (e) => show([el("b", null, b.label), el("div", null, (chart.y || "value") + ": " + fmt(b.value))], e.clientX - box.getBoundingClientRect().left, e.clientY - box.getBoundingClientRect().top));
    rect.addEventListener("mouseleave", hide);
    svg.append(rect);
  });
  return box;
}

function experimentView(m) {
  const cards = m.variants.map((v) => {
    const sig = v.significant === true ? "good" : v.significant === false ? "neutral" : "neutral";
    const isRate = m.metric === "proportion";
    return el("div", { class: "card" },
      el("div", { class: "sub" }, v.variant + " vs " + m.control),
      el("div", { class: "big" }, v.relative_lift !== null ? (v.relative_lift >= 0 ? "+" : "") + (v.relative_lift * 100).toFixed(1) + "%" : fmt(v.lift)),
      el("div", { class: "sub" }, "relative lift" + (v.relative_ci ? " · CI " + pct(v.relative_ci[0]) + " … " + pct(v.relative_ci[1]) : "")),
      intervalBar(v.ci),
      el("div", null, (isRate ? pct(v.control_value) : fmt(v.control_value)) + " → " + (isRate ? pct(v.variant_value) : fmt(v.variant_value))),
      el("div", { class: "status " + sig }, v.significant ? "significant" : "not significant", " · p = " + fmt(v.p_value_adjusted ?? v.p_value) + (m.correction && v.p_value_adjusted !== null ? " (" + m.correction + ")" : "")));
  });
  const out = [el("div", { class: "sub" }, "confidence " + (m.confidence !== null ? (m.confidence * 100).toFixed(0) + "%" : "—")), el("div", { class: "cards" }, ...cards)];
  if (m.notes.length) out.push(el("div", { class: "note" }, m.notes.join(" ")));
  return out;
}

function intervalBar(ci) {
  if (!ci || ci[0] === null || ci[1] === null) return null;
  const W = 220, H = 26, span = Math.max(Math.abs(ci[0]), Math.abs(ci[1])) * 1.25 || 1;
  const X = (v) => W / 2 + (v / span) * (W / 2 - 6);
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "confidence interval of the absolute lift" });
  svg.append(svgEl("line", { x1: X(0), x2: X(0), y1: 2, y2: H - 2, stroke: "var(--ink3)", "stroke-dasharray": "2 2" }));
  svg.append(svgEl("line", { x1: X(ci[0]), x2: X(ci[1]), y1: H / 2, y2: H / 2, stroke: "var(--s1)", "stroke-width": 4, "stroke-linecap": "round" }));
  svg.append(svgEl("circle", { cx: X((ci[0] + ci[1]) / 2), cy: H / 2, r: 4, fill: "var(--s1)", stroke: "var(--bg)", "stroke-width": 2 }));
  const pp = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + " pp";
  return el("div", { class: "chart", style: "max-width:240px" }, svg, el("div", { class: "sub" }, "absolute lift " + pp(ci[0]) + " … " + pp(ci[1]) + " (dashed line = no effect)"));
}

function srmView(m) {
  const out = [el("div", { class: "status " + (m.srm_detected ? "bad" : "good") }, m.srm_detected ? "sample-ratio mismatch — the split is broken, do not trust the lift" : "split looks healthy", " · p = " + fmt(m.p_value))];
  out.push(tableView({ columns: [{ name: "group", type: "category" }, { name: "observed", type: "number" }, { name: "expected", type: "number" }], rows: m.groups.map((g) => [g.label, g.observed, g.expected]) }));
  return out;
}

// ── lifecycle: handshake, then report size ───────────────────────────────────────────────────
new ResizeObserver(() => {
  const r = document.documentElement.getBoundingClientRect();
  notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
}).observe(document.documentElement);

request("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "betti-result-view", version: "1.0.0" },
  appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
}).then((res) => {
  state.hostCaps = res?.hostCapabilities || {};
  applyContext(res?.hostContext || {});
  notify("ui/notifications/initialized", {});
}).catch(() => notify("ui/notifications/initialized", {}));
</script>
</body>
</html>
`;
}
