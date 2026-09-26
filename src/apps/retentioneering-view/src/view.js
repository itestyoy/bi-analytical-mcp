/**
 * @file Path Analysis view — the card display_retentioneering_result draws: ONE analysis of a
 * query_retentioneering_model task.
 *
 *   transition graph   events as nodes where the library laid them out, transitions as arrows whose
 *                      width is the chosen weight; the weight and the smallest arrow shown are
 *                      switched here, over every weight the analysis computed (no server call)
 *   step matrix        the share of paths at each event, step by step — a heatmap table
 *   step sankey        the same shares as columns of nodes, with the flows between steps
 *   funnel             the steps, their share of all paths and of the previous step, the biggest drop
 *   clusters / segment overview   each group's size and its metrics side by side
 *
 * IT DRAWS AND NOTHING ELSE: its input is the result the host hands over (ontoolresult); it makes no
 * server call, reads no resource and opens no link, and the page's CSP forbids any network. WHAT to
 * show is decided by retentioneeringViewModel (src/retentioneering/view-model.js), the same function
 * the server runs; this file only draws it, with the result view's shadcn pieces and theme.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { retentioneeringViewModel } from '../../../retentioneering/view-model.js';
import { el, badge, card, formatNumber, formatShare } from '../../shared/ui.js';
import { icon } from '../../result-view/src/icons.js';
import '../../result-view/src/global.css';
import '../../result-view/src/mcp-app.css';
import './view.css';

const mainEl = document.querySelector('.main');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const contentEl = document.getElementById('content');
const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');
document.getElementById('loading-icon').append(icon('loader-circle', 'icon spin'));

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};
const series = (i) => `var(--color-series-${(i % 6) + 1})`;

const formatDuration = (s) => {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};
const formatWeight = (unit, v) => (unit === 'share' ? formatShare(v) : unit === 'duration' ? formatDuration(v) : formatNumber(v));

const state = { toolInput: null };

function payloadOf(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function showStatus(text) {
  loadingEl.hidden = true;
  mainEl.hidden = true;
  statusEl.replaceChildren(icon('info'), el('span', null, text));
  statusEl.hidden = false;
}

function render(result) {
  loadingEl.hidden = true;
  const model = retentioneeringViewModel(payloadOf(result), state.toolInput || {});
  if (model.kind === 'none') { showStatus(model.reason === 'error' ? 'The analysis could not be drawn.' : 'Nothing to draw for this analysis.'); return; }
  statusEl.hidden = true;
  mainEl.hidden = false;
  titleEl.textContent = model.title;
  subtitleEl.replaceChildren(
    ...(model.eventstream ? [badge(model.eventstream, 'secondary')] : []),
    ...(model.analysis && model.analysis !== model.kind ? [badge(model.analysis, 'outline')] : []),
  );
  const draw = { transition_graph: renderGraph, step_matrix: renderStepMatrix, step_sankey: renderSankey, funnel: renderFunnel, cluster_analysis: renderOverview, segment_overview: renderOverview }[model.kind];
  contentEl.replaceChildren(draw(model));
}

// ── transition graph ──────────────────────────────────────────────────────────────────────────

function renderGraph(model) {
  const W = 760; const H = 440; const PAD = 48;
  const nodes = model.nodes.map((n, i) => ({ ...n, i }));
  const placed = nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  // the library's layout when it gave one, else a circle — either way deterministic
  if (placed.length !== nodes.length) nodes.forEach((n, i) => { n.x = Math.cos((2 * Math.PI * i) / nodes.length); n.y = Math.sin((2 * Math.PI * i) / nodes.length); });
  const xs = nodes.map((n) => n.x); const ys = nodes.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (x) => PAD + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * PAD);
  const sy = (y) => PAD + ((y - y0) / (y1 - y0 || 1)) * (H - 2 * PAD);
  const pos = new Map(nodes.map((n) => [n.event, { x: sx(n.x), y: sy(n.y) }]));
  const maxCount = Math.max(...nodes.map((n) => n.count || 0), 1);
  const radius = (n) => 6 + 14 * Math.sqrt((n.count || 0) / maxCount);

  const view = { weight: model.weight, threshold: 0 };
  const figure = el('div', 'rt-graph');
  const tooltip = el('div', 'chart-tooltip rt-tooltip');
  tooltip.hidden = true;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rt-graph-svg', role: 'img', 'aria-label': 'Transition graph' });
  const defs = svg('defs');
  // a fixed-size head (userSpaceOnUse): a thick arrow must not grow a huge one
  const marker = svg('marker', { id: 'rt-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'rt-arrow' }));
  defs.append(marker);
  const edgeLayer = svg('g');
  const nodeLayer = svg('g');
  root.append(defs, edgeLayer, nodeLayer);
  figure.append(root, tooltip);

  const tip = (evt, lines) => {
    tooltip.replaceChildren(...lines.map((l, i) => el(i ? 'div' : 'strong', null, l)));
    tooltip.hidden = false;
    const box = figure.getBoundingClientRect();
    tooltip.style.left = `${Math.min(evt.clientX - box.left + 12, box.width - 200)}px`;
    tooltip.style.top = `${evt.clientY - box.top + 12}px`;
  };
  const untip = () => { tooltip.hidden = true; };

  const unit = () => model.units[view.weight];
  const drawEdges = () => {
    edgeLayer.replaceChildren();
    const values = model.edges.map((e) => e[view.weight]).filter((v) => v != null);
    const max = Math.max(...values, 0) || 1;
    const shown = model.edges.filter((e) => (e[view.weight] ?? 0) >= view.threshold * max);
    for (const e of shown) {
      const a = pos.get(e.source); const b = pos.get(e.target);
      if (!a || !b) continue;
      const w = 1 + 6 * ((e[view.weight] ?? 0) / max);
      let d;
      if (e.source === e.target) {
        const r = radius(nodes.find((n) => n.event === e.source));
        d = `M ${a.x - r * 0.6} ${a.y - r * 0.8} C ${a.x - r * 2.2} ${a.y - r * 3.2}, ${a.x + r * 2.2} ${a.y - r * 3.2}, ${a.x + r * 0.6} ${a.y - r * 0.8}`;
      } else {
        // a gentle bend, so A→B and B→A are two arrows, not one line
        const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
        const dx = b.x - a.x; const dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(40, len * 0.18);
        const cx = mx - (dy / len) * bend; const cy = my + (dx / len) * bend;
        // stop at the target's rim so the arrowhead shows
        const rb = radius(nodes.find((n) => n.event === e.target)) + 2;
        const tx = b.x - ((b.x - cx) / Math.hypot(b.x - cx, b.y - cy)) * rb;
        const ty = b.y - ((b.y - cy) / Math.hypot(b.x - cx, b.y - cy)) * rb;
        d = `M ${a.x} ${a.y} Q ${cx} ${cy} ${tx} ${ty}`;
      }
      const path = svg('path', { d, class: 'rt-edge', 'stroke-width': w.toFixed(2), 'marker-end': 'url(#rt-arrow)' });
      const hit = svg('path', { d, class: 'rt-edge-hit' });
      const lines = [`${e.source} → ${e.target}`, `${model.labels[view.weight]}: ${formatWeight(unit(), e[view.weight])}`, `Transitions: ${formatNumber(e.count)} · paths: ${formatNumber(e.unique_paths)}`, `Median time: ${formatDuration(e.time_median)}`];
      hit.addEventListener('pointermove', (evt) => { path.classList.add('rt-edge-on'); tip(evt, lines); });
      hit.addEventListener('pointerleave', () => { path.classList.remove('rt-edge-on'); untip(); });
      edgeLayer.append(path, hit);
    }
    caption.textContent = `${shown.length} of ${model.edges.length} transitions · arrow width = ${model.labels[view.weight].toLowerCase()}`;
  };

  for (const n of nodes) {
    const p = pos.get(n.event);
    const g = svg('g', { class: `rt-node${n.synthetic ? ' rt-node-synthetic' : ''}`, transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` });
    g.append(svg('circle', { r: radius(n).toFixed(1) }));
    const label = svg('text', { y: (radius(n) + 13).toFixed(1), 'text-anchor': 'middle' });
    label.textContent = n.event;
    g.append(label);
    g.addEventListener('pointermove', (evt) => tip(evt, [n.event, `Occurrences: ${formatNumber(n.count)}`]));
    g.addEventListener('pointerleave', untip);
    nodeLayer.append(g);
  }

  // controls: the weight, and the smallest arrow shown (a share of the largest)
  const controls = el('div', 'rt-controls');
  const select = el('select', 'rt-select');
  select.setAttribute('aria-label', 'Edge weight');
  for (const w of model.weights) {
    const o = el('option', null, model.labels[w]);
    o.value = w;
    if (w === view.weight) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => { view.weight = select.value; drawEdges(); });
  const range = el('input', 'rt-range');
  Object.assign(range, { type: 'range', min: '0', max: '0.9', step: '0.05', value: '0' });
  range.setAttribute('aria-label', 'Hide transitions smaller than this share of the largest');
  const rangeValue = el('span', 'rt-range-value', 'all');
  range.addEventListener('input', () => { view.threshold = Number(range.value); rangeValue.textContent = view.threshold ? `≥ ${Math.round(view.threshold * 100)}% of the largest` : 'all'; drawEdges(); });
  const weightLabel = el('label', 'rt-control', 'Weight');
  weightLabel.append(select);
  const rangeLabel = el('label', 'rt-control', 'Show');
  rangeLabel.append(range, rangeValue);
  controls.append(weightLabel, rangeLabel);
  const caption = el('p', 'card-description rt-caption');
  drawEdges();

  const content = el('div', 'card-content');
  content.append(controls, figure, caption);
  return card({ title: `${model.nodes.length} events · ${model.edges.length} transitions`, description: 'Which event follows which' }, content);
}

// ── step matrix ───────────────────────────────────────────────────────────────────────────────

function renderStepMatrix(model) {
  const wrap = el('div', 'rt-stack');
  model.blocks.forEach((b, i) => {
    const table = el('table', 'table rt-heat');
    const head = el('tr');
    head.append(el('th', null, 'Event'), ...b.steps.map((s) => el('th', 'num', String(s))));
    const thead = el('thead'); thead.append(head);
    const tbody = el('tbody');
    for (const r of b.rows) {
      const tr = el('tr');
      tr.append(el('td', 'rt-event', r.event));
      for (const v of r.values) {
        const td = el('td', 'num rt-cell', v ? formatShare(v) : '');
        if (v) td.style.setProperty('--share', String(Math.min(1, v)));
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const scroll = el('div', 'table-container');
    scroll.append(table);
    const content = el('div', 'card-content');
    content.append(scroll);
    const anchored = b.steps.some((s) => s < 0);
    wrap.append(card({ title: model.blocks.length > 1 ? `Block ${i + 1}` : `${b.rows.length} events · ${b.steps.length} steps`, description: anchored ? 'Share of paths at each step before (−) and after (+) the anchor' : 'Share of paths at each step from the start' }, content));
  });
  return wrap;
}

// ── step sankey ───────────────────────────────────────────────────────────────────────────────

function renderSankey(model) {
  const wrap = el('div', 'rt-stack');
  for (const b of model.blocks) {
    const W = Math.max(640, b.steps.length * 150); const H = 380; const NODE_W = 12; const GAP = 6; const PAD = 16;
    // one colour per event, the most frequent first; the rest share a neutral one
    const totals = new Map();
    for (const col of b.columns) for (const n of col) totals.set(n.event, (totals.get(n.event) || 0) + n.share);
    const ranked = [...totals.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0])).map(([e]) => e);
    const color = (e) => (ranked.indexOf(e) < 6 ? series(ranked.indexOf(e)) : 'var(--muted-foreground)');
    const xOf = (i) => PAD + (i * (W - 2 * PAD - NODE_W)) / Math.max(1, b.steps.length - 1);
    const layout = new Map();
    b.columns.forEach((col, i) => {
      const gaps = GAP * Math.max(0, col.length - 1);
      const scale = (H - 2 * PAD - gaps);
      let y = PAD;
      for (const n of col) { const h = Math.max(1.5, n.share * scale); layout.set(`${b.steps[i]}|${n.event}`, { x: xOf(i), y, h, used0: 0, used1: 0, share: n.share }); y += h + GAP; }
    });
    const root = svg('svg', { viewBox: `0 0 ${W} ${H + 24}`, class: 'rt-sankey', role: 'img', 'aria-label': 'Step sankey' });
    const tip = el('div', 'chart-tooltip rt-tooltip'); tip.hidden = true;
    const figure = el('div', 'rt-graph'); figure.append(root, tip);
    const show = (evt, lines) => { tip.replaceChildren(...lines.map((l, i) => el(i ? 'div' : 'strong', null, l))); tip.hidden = false; const box = figure.getBoundingClientRect(); tip.style.left = `${Math.min(evt.clientX - box.left + 12, box.width - 200)}px`; tip.style.top = `${evt.clientY - box.top + 12}px`; };
    const hide = () => { tip.hidden = true; };
    const scaleOf = (key) => { const n = layout.get(key); return n ? n.h / (n.share || 1) : 0; };
    for (const l of b.links) {
      const s = layout.get(`${l.step}|${l.source}`); const t = layout.get(`${l.step + 1}|${l.target}`);
      if (!s || !t) continue;
      const hs = l.share * scaleOf(`${l.step}|${l.source}`); const ht = l.share * scaleOf(`${l.step + 1}|${l.target}`);
      const y0 = s.y + s.used0; s.used0 += hs; const y1 = t.y + t.used1; t.used1 += ht;
      const x0 = s.x + NODE_W; const x1 = t.x; const mx = (x0 + x1) / 2;
      const d = `M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1} L ${x1} ${y1 + ht} C ${mx} ${y1 + ht}, ${mx} ${y0 + hs}, ${x0} ${y0 + hs} Z`;
      const p = svg('path', { d, class: 'rt-flow', fill: color(l.source) });
      p.addEventListener('pointermove', (evt) => show(evt, [`${l.source} → ${l.target}`, `step ${l.step} → ${l.step + 1}: ${formatShare(l.share)} of paths`]));
      p.addEventListener('pointerleave', hide);
      root.append(p);
    }
    b.columns.forEach((col, i) => {
      for (const n of col) {
        const box = layout.get(`${b.steps[i]}|${n.event}`);
        const r = svg('rect', { x: box.x, y: box.y, width: NODE_W, height: box.h, rx: 3, fill: color(n.event), class: 'rt-sankey-node' });
        r.addEventListener('pointermove', (evt) => show(evt, [n.event, `step ${b.steps[i]}: ${formatShare(n.share)} of paths`]));
        r.addEventListener('pointerleave', hide);
        root.append(r);
        if (box.h >= 14) {
          // the last column's labels sit on its left, inside the frame
          const last = i === b.columns.length - 1;
          const t = svg('text', { x: last ? box.x - 4 : box.x + NODE_W + 4, y: box.y + box.h / 2 + 4, class: 'rt-sankey-label', 'text-anchor': last ? 'end' : 'start' });
          t.textContent = `${n.event} ${formatShare(n.share)}`;
          root.append(t);
        }
      }
      const s = svg('text', { x: xOf(i) + NODE_W / 2, y: H + 16, 'text-anchor': 'middle', class: 'rt-sankey-step' });
      s.textContent = `step ${b.steps[i]}`;
      root.append(s);
    });
    const content = el('div', 'card-content');
    const scroll = el('div', 'rt-scroll'); scroll.append(figure);
    const legend = el('div', 'chart-legend');
    for (const e of ranked.slice(0, 6)) { const item = el('span', 'chart-legend-item'); const sw = el('span', 'chart-indicator'); sw.style.background = color(e); item.append(sw, el('span', null, e)); legend.append(item); }
    content.append(scroll, legend);
    wrap.append(card({ title: `${b.steps.length} steps`, description: b.links.length ? 'The share of paths at each step, and where they go next' : 'The share of paths at each step around the anchor' }, content));
  }
  return wrap;
}

// ── funnel ────────────────────────────────────────────────────────────────────────────────────

function renderFunnel(model) {
  const n = model.steps.length;
  const list = el('ol', 'funnel');
  model.steps.forEach((step, i) => {
    const worst = i === model.biggest_drop;
    const item = el('li', `funnel-step${worst ? ' funnel-step-worst' : ''}`);
    if (i > 0) {
      const link = el('div', 'funnel-link');
      link.append(icon('arrow-down'), el('span', null, `${formatShare(step.of_previous)} continued`));
      if (worst) link.append(badge(`Biggest drop · −${formatShare(1 - step.of_previous)}`, 'destructive'));
      item.append(link);
    }
    const head = el('div', 'funnel-head');
    head.append(el('span', 'funnel-index', String(i + 1)), el('span', 'funnel-label', step.label), el('span', 'funnel-value', formatNumber(step.value)), el('span', 'funnel-share', formatShare(step.of_first)));
    const track = el('div', 'funnel-track');
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `${step.label}: ${formatShare(step.of_first)} of all paths`);
    const fill = el('div', 'funnel-fill');
    fill.style.width = `${Math.max(0.5, step.of_first * 100).toFixed(2)}%`;
    track.append(fill);
    item.append(head, track);
    list.append(item);
  });
  const content = el('div', 'card-content');
  content.append(list);
  return card({ title: formatShare(model.steps[n - 1].of_first), titleClass: 'card-title card-title-stat', description: `${model.steps[0].label} → ${model.steps[n - 1].label}`, subline: `${formatNumber(model.steps[n - 1].value)} of the paths reach the last step` }, content);
}

// ── clusters / segment overview ───────────────────────────────────────────────────────────────

function renderOverview(model) {
  const clusters = model.kind === 'cluster_analysis';
  const table = el('table', 'table rt-heat');
  const head = el('tr');
  head.append(el('th', null, clusters ? 'Metric' : 'Metric'), ...model.levels.map((l) => el('th', 'num', l.name)));
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  const sizeRow = el('tr', 'rt-size');
  sizeRow.append(el('td', 'rt-event', 'Paths'), ...model.levels.map((l) => el('td', 'num', `${formatNumber(l.size)} · ${formatShare(l.share)}`)));
  tbody.append(sizeRow);
  for (const m of model.metrics) {
    const tr = el('tr');
    const name = el('td', 'rt-event', m.label || m.metric);
    name.title = m.metric;
    tr.append(name);
    const vals = m.values.filter((v) => v != null);
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    const fmt = m.format === 'share' ? formatShare : m.format === 'duration' ? formatDuration : formatNumber;
    for (const v of m.values) {
      const td = el('td', 'num rt-cell', v == null ? '—' : fmt(v));
      // shaded within the row: where the group stands on this metric among the groups
      if (v != null && hi > lo) td.style.setProperty('--share', String(((v - lo) / (hi - lo)) * 0.85));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const scroll = el('div', 'table-container');
  scroll.append(table);
  const content = el('div', 'card-content');
  content.append(scroll);
  if (model.silhouette?.length) {
    const sil = el('p', 'card-description rt-caption', `Silhouette: ${model.silhouette.map((s) => `${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(', ')} → ${s.score?.toFixed(3)}${s.best ? ' (best)' : ''}`).join(' · ')}`);
    content.append(sil);
  }
  return card({ title: `${model.levels.length} ${clusters ? 'clusters' : 'levels'}`, description: clusters ? 'Groups of similar paths — size and profile (shading: highest to lowest within a row)' : 'Path metrics across the segment (shading within a row)' }, content);
}

// ── host wiring (the official MCP Apps template) ─────────────────────────────────────────────

function handleHostContextChanged(ctx) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const root = document.documentElement.style;
    for (const side of ['top', 'right', 'bottom', 'left']) root.setProperty(`--safe-${side}`, `${Number(ctx.safeAreaInsets[side]) || 0}px`);
  }
}

const app = new App({ name: 'Path Analysis', version: '1.0.0' });
app.ontoolinput = (params) => { state.toolInput = params.arguments ?? null; };
app.ontoolresult = (result) => render(result);
app.ontoolcancelled = () => showStatus('The call was cancelled.');
app.onhostcontextchanged = handleHostContextChanged;
app.onerror = () => {};
app.connect().then(() => { const ctx = app.getHostContext(); if (ctx) handleHostContextChanged(ctx); });
