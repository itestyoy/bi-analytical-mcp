/**
 * @file Path Analysis view — the card display_retentioneering_result draws: ONE analysis of a
 * query_retentioneering_model task.
 *
 *   transition graph   events where the library laid them out (size = occurrences), transitions as
 *                      arrows (width = the chosen weight). It opens as retentioneering's own map —
 *                      each event's strongest exits plus every event's strongest arrival — and the
 *                      weight and how many exits per event are switched here; hovering an event
 *                      shows only its arrivals and exits; the transitions are also a table
 *   step matrix        where all the paths are at each step — a heatmap, each column 100%
 *   step sankey        the same shares as columns, the flows between consecutive steps, and the paths
 *                      that ended as one block at the bottom of each step
 *   funnel             the steps, their share of all paths and of the previous step, the biggest drop
 *   clusters / segment overview   each group's size, then the metrics that set the groups apart most
 *
 * Every card says what its numbers are about — the users, the period, a sample — and gives counts
 * next to shares. IT DRAWS AND NOTHING ELSE: its input is the result the host hands over
 * (ontoolresult); no server call, no resource, no link, and the page's CSP forbids any network. WHAT
 * to show is decided by retentioneeringViewModel (src/retentioneering/view-model.js), the function the
 * server runs too; this file only draws it, with the result view's shadcn pieces and theme.
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
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const formatDate = (v) => { const d = new Date(String(v).replace(' ', 'T').replace(/(\d)$/, '$1Z')); return Number.isNaN(d.getTime()) ? String(v) : dateFormat.format(d); };
/** "33.3% · 4 paths" — a share with the count it stands for, when the number of paths is known. */
const shareWithCount = (share, paths) => (paths ? `${formatShare(share)} · ${formatNumber(Math.round(share * paths))} paths` : formatShare(share));

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

/** The scope line under the title: which eventstream, how many users, which period, a sample. */
function scopeBadges(model) {
  const s = model.scope;
  return [
    ...(model.eventstream ? [badge(model.eventstream, 'secondary')] : []),
    ...(s?.users != null ? [badge(`${formatNumber(s.users)} users`, 'outline')] : []),
    ...(s?.period?.first_event && s?.period?.last_event ? [badge(`${formatDate(s.period.first_event)} – ${formatDate(s.period.last_event)}`, 'outline')] : []),
    ...(s?.sample != null ? [badge(`sample · ${formatShare(s.sample)} of users`, 'outline', 'info')] : []),
    ...(model.analysis && model.analysis !== model.kind ? [badge(model.analysis, 'outline')] : []),
  ];
}

function render(result) {
  loadingEl.hidden = true;
  const model = retentioneeringViewModel(payloadOf(result), state.toolInput || {});
  if (model.kind === 'none') { showStatus(model.reason === 'error' ? 'The analysis could not be drawn.' : 'Nothing to draw for this analysis.'); return; }
  statusEl.hidden = true;
  mainEl.hidden = false;
  titleEl.textContent = model.title;
  subtitleEl.replaceChildren(...scopeBadges(model));
  const draw = { transition_graph: renderGraph, step_matrix: renderStepMatrix, step_sankey: renderSankey, funnel: renderFunnel, cluster_analysis: renderOverview, segment_overview: renderOverview }[model.kind];
  contentEl.replaceChildren(draw(model));
}

/** A tooltip inside a figure, placed at the pointer. */
function tooltipFor(figure) {
  const tip = el('div', 'chart-tooltip rt-tooltip');
  tip.hidden = true;
  figure.append(tip);
  return {
    show(evt, lines) {
      tip.replaceChildren(...lines.map((l, i) => el(i ? 'div' : 'strong', null, l)));
      tip.hidden = false;
      const box = figure.getBoundingClientRect();
      tip.style.left = `${Math.max(0, Math.min(evt.clientX - box.left + 12, box.width - 220))}px`;
      tip.style.top = `${evt.clientY - box.top + 12}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/** A table behind a disclosure — the same numbers as the figure, for reading exactly and for a screen reader. */
function tableView(summary, headers, rows) {
  const details = el('details', 'collapsible rt-table-view');
  const s = el('summary', 'collapsible-trigger');
  s.append(el('span', null, summary), icon('chevron-down', 'icon collapsible-chevron'));
  const table = el('table', 'table');
  const tr = el('tr');
  headers.forEach(([h, num]) => tr.append(el('th', num ? 'num' : null, h)));
  const thead = el('thead'); thead.append(tr);
  const tbody = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    r.forEach((v, i) => row.append(el('td', headers[i][1] ? 'num' : null, v)));
    tbody.append(row);
  }
  table.append(thead, tbody);
  const scroll = el('div', 'table-container');
  scroll.append(table);
  details.append(s, scroll);
  return details;
}

// ── transition graph ──────────────────────────────────────────────────────────────────────────

/** The transitions a view shows: each event's `per` strongest exits and every event's strongest arrival. */
function visibleEdges(edges, weight, rankBy, per) {
  if (!per) return edges;
  const keep = new Set();
  const bySource = new Map(); const byTarget = new Map();
  for (const e of edges) {
    (bySource.get(e.source) || bySource.set(e.source, []).get(e.source)).push(e);
    (byTarget.get(e.target) || byTarget.set(e.target, []).get(e.target)).push(e);
  }
  const strength = (e) => e[rankBy] ?? 0;
  for (const list of bySource.values()) list.sort((a, b) => strength(b) - strength(a)).slice(0, per).forEach((e) => keep.add(e));
  for (const list of byTarget.values()) keep.add(list.sort((a, b) => strength(b) - strength(a))[0]);
  return edges.filter((e) => keep.has(e));
}

function renderGraph(model) {
  const W = 760; const H = 440; const PAD = 52;
  const nodes = model.nodes.map((n, i) => ({ ...n, i }));
  // the library's layout when it gave one, else a circle — either way the same picture every time
  if (!nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))) nodes.forEach((n, i) => { n.x = Math.cos((2 * Math.PI * i) / nodes.length); n.y = Math.sin((2 * Math.PI * i) / nodes.length); });
  const xs = nodes.map((n) => n.x); const ys = nodes.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pos = new Map(nodes.map((n) => [n.event, { x: PAD + ((n.x - x0) / (x1 - x0 || 1)) * (W - 2 * PAD), y: PAD + ((n.y - y0) / (y1 - y0 || 1)) * (H - 2 * PAD) }]));
  const maxCount = Math.max(...nodes.map((n) => n.count || 0), 1);
  const radius = new Map(nodes.map((n) => [n.event, 6 + 14 * Math.sqrt((n.count || 0) / maxCount)]));
  const labelOf = new Map(nodes.map((n) => [n.event, n.label || n.event]));

  const view = { weight: model.weight, per: model.per_event, focus: null };
  const figure = el('div', 'rt-graph');
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rt-graph-svg', role: 'img', 'aria-label': 'Transition graph — the transitions are also listed in the table below' });
  const defs = svg('defs');
  // a fixed-size head (userSpaceOnUse): a thick arrow must not grow a huge one
  const marker = svg('marker', { id: 'rt-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'rt-arrow' }));
  defs.append(marker);
  const edgeLayer = svg('g');
  const nodeLayer = svg('g');
  root.append(defs, edgeLayer, nodeLayer);
  figure.append(root);
  const tip = tooltipFor(figure);
  const unit = () => model.units[view.weight];
  // for a time weight a larger value is not a stronger transition: rank by volume there
  const rankBy = () => (unit() === 'duration' ? 'count' : view.weight);
  const tableSlot = el('div');
  const caption = el('p', 'card-description rt-caption');
  const nodeEls = new Map();

  const edgePath = (e) => {
    const a = pos.get(e.source); const b = pos.get(e.target);
    if (e.source === e.target) {
      const r = radius.get(e.source);
      return `M ${a.x - r * 0.6} ${a.y - r * 0.8} C ${a.x - r * 2.2} ${a.y - r * 3.2}, ${a.x + r * 2.2} ${a.y - r * 3.2}, ${a.x + r * 0.6} ${a.y - r * 0.8}`;
    }
    // a gentle bend, so A→B and B→A are two arrows, not one line; stop at the target's rim for the head
    const dx = b.x - a.x; const dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(40, len * 0.18);
    const cx = (a.x + b.x) / 2 - (dy / len) * bend; const cy = (a.y + b.y) / 2 + (dx / len) * bend;
    const rb = radius.get(e.target) + 2; const back = Math.hypot(b.x - cx, b.y - cy) || 1;
    return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x - ((b.x - cx) / back) * rb} ${b.y - ((b.y - cy) / back) * rb}`;
  };

  const draw = () => {
    edgeLayer.replaceChildren();
    const shown = visibleEdges(model.edges, view.weight, rankBy(), view.per);
    const max = Math.max(...shown.map((e) => e[view.weight] ?? 0), 0) || 1;
    const touched = new Set(shown.flatMap((e) => [e.source, e.target]));
    for (const e of shown) {
      const d = edgePath(e);
      const onFocus = view.focus && (e.source === view.focus || e.target === view.focus);
      const path = svg('path', { d, class: `rt-edge${view.focus ? (onFocus ? ' rt-edge-on' : ' rt-edge-dim') : ''}`, 'stroke-width': (1 + 6 * ((e[view.weight] ?? 0) / max)).toFixed(2), 'marker-end': 'url(#rt-arrow)' });
      const hit = svg('path', { d, class: 'rt-edge-hit' });
      const lines = [`${labelOf.get(e.source)} → ${labelOf.get(e.target)}`, `${model.labels[view.weight]}: ${formatWeight(unit(), e[view.weight])}`, `${formatNumber(e.count)} transitions · ${formatNumber(e.unique_paths)} paths`, `median time ${formatDuration(e.time_median)}`];
      hit.addEventListener('pointermove', (evt) => { path.classList.add('rt-edge-on'); tip.show(evt, lines); });
      hit.addEventListener('pointerleave', () => { if (!onFocus) path.classList.remove('rt-edge-on'); tip.hide(); });
      edgeLayer.append(path, hit);
    }
    for (const [event, g] of nodeEls) {
      const related = !view.focus || event === view.focus || shown.some((e) => (e.source === view.focus && e.target === event) || (e.target === view.focus && e.source === event));
      g.classList.toggle('rt-node-dim', !touched.has(event) || !related);
    }
    caption.textContent = `Circle size = occurrences · arrow width = ${model.labels[view.weight].toLowerCase()} · ${shown.length} of ${model.edges.length} transitions shown${view.per ? ` (the ${view.per} strongest exits of each event, plus each event's strongest arrival)` : ''}. Hover an event to see only its arrivals and exits.`;
    const sorted = [...shown].sort((a, b) => (b[rankBy()] ?? 0) - (a[rankBy()] ?? 0));
    tableSlot.replaceChildren(tableView(`The ${shown.length} transitions shown, as a table`, [['From'], ['To'], [model.labels[view.weight], true], ['Transitions', true], ['Paths', true], ['Median time', true]],
      sorted.map((e) => [labelOf.get(e.source), labelOf.get(e.target), formatWeight(unit(), e[view.weight]), formatNumber(e.count), formatNumber(e.unique_paths), formatDuration(e.time_median)])));
  };

  // labels placed so they do not overlap: the biggest events first, each under its circle, else above,
  // else to the right or the left — the first place no earlier label or circle takes
  const placed = [];
  const circles = nodes.map((n) => ({ ...pos.get(n.event), r: radius.get(n.event) }));
  const hits = (b) => placed.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
    || circles.some((c) => b.x0 < c.x + c.r && b.x1 > c.x - c.r && b.y0 < c.y + c.r && b.y1 > c.y - c.r);
  const labelAt = new Map();
  for (const n of [...nodes].sort((a, b) => (b.count || 0) - (a.count || 0))) {
    const p = pos.get(n.event); const r = radius.get(n.event); const w = (n.label || n.event).length * 6.2; const h = 13;
    const options = [
      { dx: 0, dy: r + 13, anchor: 'middle', box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y + r + 2, y1: p.y + r + 2 + h } },
      { dx: 0, dy: -r - 5, anchor: 'middle', box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - r - 4 - h, y1: p.y - r - 4 } },
      { dx: r + 4, dy: 4, anchor: 'start', box: { x0: p.x + r + 4, x1: p.x + r + 4 + w, y0: p.y - h / 2, y1: p.y + h / 2 } },
      { dx: -r - 4, dy: 4, anchor: 'end', box: { x0: p.x - r - 4 - w, x1: p.x - r - 4, y0: p.y - h / 2, y1: p.y + h / 2 } },
    ];
    const pick = options.find((o) => !hits(o.box)) || options[0];
    placed.push(pick.box);
    labelAt.set(n.event, pick);
  }

  for (const n of nodes) {
    const p = pos.get(n.event);
    const g = svg('g', { class: `rt-node${n.synthetic ? ' rt-node-synthetic' : ''}`, transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`, tabindex: 0, role: 'button', 'aria-label': `${n.label}: ${n.count} occurrences — show only its transitions` });
    g.append(svg('circle', { r: radius.get(n.event).toFixed(1) }));
    const at = labelAt.get(n.event);
    const label = svg('text', { x: at.dx.toFixed(1), y: at.dy.toFixed(1), 'text-anchor': at.anchor });
    label.textContent = n.label;
    g.append(label);
    const exits = () => model.edges.filter((e) => e.source === n.event).sort((a, b) => (b.proba_out ?? 0) - (a.proba_out ?? 0)).slice(0, 3);
    const arrivals = () => model.edges.filter((e) => e.target === n.event).sort((a, b) => (b.proba_in ?? 0) - (a.proba_in ?? 0)).slice(0, 3);
    const focusOn = (evt) => {
      view.focus = n.event; draw();
      tip.show(evt, [n.label, `${formatNumber(n.count)} occurrences`,
        ...(exits().length ? [`next: ${exits().map((e) => `${labelOf.get(e.target)} ${formatShare(e.proba_out)}`).join(', ')}`] : []),
        ...(arrivals().length ? [`from: ${arrivals().map((e) => `${labelOf.get(e.source)} ${formatShare(e.proba_in)}`).join(', ')}`] : [])]);
    };
    g.addEventListener('pointerenter', focusOn);
    g.addEventListener('focus', () => { view.focus = n.event; draw(); });
    g.addEventListener('pointerleave', () => { view.focus = null; draw(); tip.hide(); });
    g.addEventListener('blur', () => { view.focus = null; draw(); });
    nodeEls.set(n.event, g);
    nodeLayer.append(g);
  }

  // controls: the weight, and how many exits of each event are drawn
  const controls = el('div', 'rt-controls');
  const select = el('select', 'rt-select');
  select.setAttribute('aria-label', 'Arrow width');
  for (const w of model.weights) {
    const o = el('option', null, model.labels[w]);
    o.value = w;
    if (w === view.weight) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => { view.weight = select.value; draw(); });
  const per = el('select', 'rt-select');
  per.setAttribute('aria-label', 'Transitions shown');
  for (const [v, text] of [[1, 'strongest exit of each event'], [2, '2 strongest exits'], [3, '3 strongest exits'], [5, '5 strongest exits'], [0, 'every transition']]) {
    const o = el('option', null, text);
    o.value = String(v);
    if (v === view.per) o.selected = true;
    per.append(o);
  }
  per.addEventListener('change', () => { view.per = Number(per.value); draw(); });
  const weightLabel = el('label', 'rt-control', 'Arrow width');
  weightLabel.append(select);
  const perLabel = el('label', 'rt-control', 'Show');
  perLabel.append(per);
  controls.append(weightLabel, perLabel);
  draw();

  const content = el('div', 'card-content');
  content.append(controls, figure, caption, tableSlot);
  return card({ title: `${model.nodes.length} events · ${model.edges.length} transitions`, description: `Which event follows which${model.paths ? ` in ${formatNumber(model.paths)} paths` : ''}` }, content);
}

// ── step matrix ───────────────────────────────────────────────────────────────────────────────

function renderStepMatrix(model) {
  const wrap = el('div', 'rt-stack');
  model.blocks.forEach((b, i) => {
    const table = el('table', 'table rt-heat');
    const head = el('tr');
    head.append(el('th', null, 'Event \\ step'), ...b.steps.map((s) => el('th', 'num', String(s))));
    const thead = el('thead'); thead.append(head);
    const tbody = el('tbody');
    for (const r of b.rows) {
      const tr = el('tr', r.synthetic ? 'rt-synthetic' : null);
      tr.append(el('td', 'rt-event', r.label));
      r.values.forEach((v, j) => {
        const td = el('td', 'num rt-cell', v ? formatShare(v) : '');
        if (v) {
          td.style.setProperty('--share', String(Math.min(1, v)));
          td.title = `${r.label} at step ${b.steps[j]}: ${shareWithCount(v, model.paths)}`;
        }
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const scroll = el('div', 'table-container');
    scroll.append(table);
    const content = el('div', 'card-content');
    content.append(scroll);
    const anchored = b.steps.some((s) => s < 0);
    const of = model.paths ? `all ${formatNumber(model.paths)} paths` : 'all paths';
    wrap.append(card({
      title: model.blocks.length > 1 ? `Block ${i + 1}` : `${b.rows.length} events · ${b.steps.length} steps`,
      description: anchored ? `Where the paths are before (−) and after (+) the anchor — each column is ${of} that reach it, 100%` : `Where ${of} are at each step from the start — each column adds up to 100%`,
    }, content));
  });
  return wrap;
}

// ── step sankey ───────────────────────────────────────────────────────────────────────────────

function renderSankey(model) {
  const wrap = el('div', 'rt-stack');
  for (const b of model.blocks) {
    const LABEL_ROOM = 140; // the last column's labels stay on its right, like every other column's
    const W = Math.max(640, b.steps.length * 150) + LABEL_ROOM; const H = 380; const NODE_W = 12; const GAP = 6; const PAD = 16;
    // one colour per event, the most frequent first (never cycled); the rest share a neutral one, and
    // the paths that ended have their own, darker, neutral
    const totals = new Map();
    const BOUNDARY = new Set(['path_start', 'path_end']);
    for (const col of b.columns) for (const n of col) if (!BOUNDARY.has(n.event)) totals.set(n.event, (totals.get(n.event) || 0) + n.share);
    const ranked = [...totals.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0])).map(([e]) => e);
    // where a path begins and where it has ended are boundaries, not behaviour: one neutral for both
    const color = (e) => (BOUNDARY.has(e) ? 'var(--rt-ended)' : ranked.indexOf(e) < 6 ? series(ranked.indexOf(e)) : 'var(--muted-foreground)');
    const labelOf = new Map(b.columns.flat().map((n) => [n.event, n.label || n.event]));
    const xOf = (i) => PAD + (i * (W - LABEL_ROOM - 2 * PAD - NODE_W)) / Math.max(1, b.steps.length - 1);
    const layout = new Map();
    b.columns.forEach((col, i) => {
      const scale = H - 2 * PAD - GAP * Math.max(0, col.length - 1);
      let y = PAD;
      for (const n of col) { const h = Math.max(1.5, n.share * scale); layout.set(`${b.steps[i]}|${n.event}`, { x: xOf(i), y, h, used0: 0, used1: 0, share: n.share }); y += h + GAP; }
    });
    const root = svg('svg', { viewBox: `0 0 ${W} ${H + 24}`, class: 'rt-sankey', role: 'img', 'aria-label': 'Step sankey — the shares are also listed in the table below' });
    const figure = el('div', 'rt-graph');
    figure.append(root);
    const tip = tooltipFor(figure);
    const flows = [];
    const scaleOf = (key) => { const n = layout.get(key); return n ? n.h / (n.share || 1) : 0; };
    for (const l of b.links) {
      const s = layout.get(`${l.step}|${l.source}`); const t = layout.get(`${l.step + 1}|${l.target}`);
      if (!s || !t) continue;
      const hs = l.share * scaleOf(`${l.step}|${l.source}`); const ht = l.share * scaleOf(`${l.step + 1}|${l.target}`);
      const y0 = s.y + s.used0; s.used0 += hs; const y1 = t.y + t.used1; t.used1 += ht;
      const x0 = s.x + NODE_W; const x1 = t.x; const mx = (x0 + x1) / 2;
      const d = `M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1} L ${x1} ${y1 + ht} C ${mx} ${y1 + ht}, ${mx} ${y0 + hs}, ${x0} ${y0 + hs} Z`;
      const p = svg('path', { d, class: 'rt-flow', fill: color(l.source) });
      p.addEventListener('pointermove', (evt) => tip.show(evt, [`${labelOf.get(l.source)} → ${labelOf.get(l.target)}`, `step ${l.step} → ${l.step + 1}: ${shareWithCount(l.share, model.paths)}`]));
      p.addEventListener('pointerleave', () => tip.hide());
      flows.push({ el: p, from: `${l.step}|${l.source}`, to: `${l.step + 1}|${l.target}` });
      root.append(p);
    }
    // hovering a block keeps only the flows into and out of it
    const highlight = (key) => { for (const f of flows) f.el.classList.toggle('rt-flow-dim', !!key && f.from !== key && f.to !== key); };
    b.columns.forEach((col, i) => {
      col.forEach((n) => {
        const key = `${b.steps[i]}|${n.event}`;
        const box = layout.get(key);
        const r = svg('rect', { x: box.x, y: box.y, width: NODE_W, height: box.h, rx: 3, fill: color(n.event), class: 'rt-sankey-node' });
        r.addEventListener('pointermove', (evt) => { highlight(key); tip.show(evt, [n.label, `step ${b.steps[i]}: ${shareWithCount(n.share, model.paths)}`]); });
        r.addEventListener('pointerleave', () => { highlight(null); tip.hide(); });
        root.append(r);
        if (box.h >= 14) {
          const t = svg('text', { x: box.x + NODE_W + 4, y: box.y + box.h / 2 + 4, class: 'rt-sankey-label' });
          t.textContent = `${n.label} ${formatShare(n.share)}`;
          root.append(t);
        }
      });
      const s = svg('text', { x: xOf(i) + NODE_W / 2, y: H + 16, 'text-anchor': 'middle', class: 'rt-sankey-step' });
      s.textContent = `step ${b.steps[i]}`;
      root.append(s);
    });
    const content = el('div', 'card-content');
    const scroll = el('div', 'rt-scroll');
    scroll.append(figure);
    const legend = el('div', 'chart-legend');
    const swatch = (text, c) => { const item = el('span', 'chart-legend-item'); const sw = el('span', 'chart-indicator'); sw.style.background = c; item.append(sw, el('span', null, text)); legend.append(item); };
    ranked.slice(0, 6).forEach((e) => swatch(labelOf.get(e), color(e)));
    if (ranked.length > 6) swatch('other events', 'var(--muted-foreground)');
    swatch(b.columns.some((col) => col.some((n) => n.event === 'path_end')) ? 'Path start / Ended' : 'Path start', 'var(--rt-ended)');
    const rows = b.columns.flatMap((col, i) => col.map((n) => [String(b.steps[i]), n.label, formatShare(n.share), model.paths ? formatNumber(Math.round(n.share * model.paths)) : '—']));
    content.append(scroll, legend, tableView('The shares, as a table', [['Step'], ['Event'], ['Share of paths', true], ['Paths', true]], rows));
    const of = model.paths ? `${formatNumber(model.paths)} paths` : 'the paths';
    wrap.append(card({ title: `${b.steps.length} steps`, description: b.links.length ? `Where ${of} are at each step and where they go next${b.columns.some((col) => col.some((n) => n.event === 'path_end')) ? '; "Ended" is the paths that stopped' : ''}. A flow is one step to the next — it does not follow a path further` : `Where ${of} are at each step around the anchor` }, content));
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
    track.setAttribute('aria-label', `${step.label}: ${formatNumber(step.value)} paths, ${formatShare(step.of_first)} of all paths`);
    const fill = el('div', 'funnel-fill');
    fill.style.width = `${Math.max(0.5, step.of_first * 100).toFixed(2)}%`;
    track.append(fill);
    item.append(head, track);
    list.append(item);
  });
  const content = el('div', 'card-content');
  content.append(list);
  const last = model.steps[n - 1];
  const total = model.paths ?? (last.of_first ? Math.round(last.value / last.of_first) : null);
  return card({
    title: formatShare(last.of_first), titleClass: 'card-title card-title-stat',
    description: `${model.steps[0].label} → ${last.label}, in this order`,
    subline: total ? `${formatNumber(last.value)} of ${formatNumber(total)} paths reach the last step; the shares are of all paths` : `${formatNumber(last.value)} paths reach the last step`,
  }, content);
}

// ── clusters / segment overview ───────────────────────────────────────────────────────────────

function renderOverview(model) {
  const clusters = model.kind === 'cluster_analysis';
  const table = el('table', 'table rt-heat');
  const head = el('tr');
  head.append(el('th', null, clusters ? 'Profile' : 'Metric'));
  for (const l of model.levels) { const th = el('th', 'num', l.label || l.name); th.title = l.name; head.append(th); }
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
    m.values.forEach((v, j) => {
      const td = el('td', 'num rt-cell', v == null ? '—' : fmt(v));
      // shaded within the row: where the group stands on this metric among the groups
      if (v != null && hi > lo) td.style.setProperty('--share', String(((v - lo) / (hi - lo)) * 0.85));
      td.title = `${model.levels[j].label || model.levels[j].name} · ${m.label || m.metric}: ${v == null ? '—' : fmt(v)}`;
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const scroll = el('div', 'table-container');
  scroll.append(table);
  const content = el('div', 'card-content');
  content.append(scroll);
  if (model.silhouette?.length) {
    content.append(el('p', 'card-description rt-caption', `Silhouette (how well the groups separate, higher is better): ${model.silhouette.map((s) => `${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(', ')} → ${s.score?.toFixed(3)}${s.best ? ' (chosen)' : ''}`).join(' · ')}`));
  }
  const of = model.paths ? ` of ${formatNumber(model.paths)} paths` : '';
  return card({
    title: `${model.levels.length} ${clusters ? 'clusters' : 'levels'}${of}`,
    description: clusters ? 'Groups of similar paths: their size, then the metrics that set them apart most. Shading marks the highest value in a row' : 'Path metrics across the segment, the ones that differ most first. Shading marks the highest value in a row',
  }, content);
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
