/**
 * @file Query Result view — the cards inside the host's conversation: a CHART (a line or multi-line,
 * a stacked area, grouped/stacked/horizontal bars, a donut of shares or a sankey of flows — the chart
 * alone, the only table is the pivot; a declared drill lets a click open a mark into a dimension, with
 * a breadcrumb and a back button), KPI TILES (a headline number, its
 * change, a sparkline), a PIVOT (a drill-down table, each level read when its row opens), a FUNNEL
 * (steps, conversion, the biggest drop) and the A/B
 * family (the test, the split check, the sample-size plan). Any other result gets one status line.
 *
 * IT DRAWS, AND READS ONLY ITS OWN RESULT. The input is the display_model_result the host delivers
 * (ontoolresult). The one thing it asks for is more of that same result, through drill_result
 * (readResult): a drill-down's next view — its task's stored table, filtered to the pivot row opened or
 * the chart mark clicked, grouped by the dimension chosen. Nothing
 * else: no other tool, no resource, no message to the model, no link — and no network at all (the
 * page's CSP, and the resource's declared `csp`). Everything else interactive here — the
 * tooltip, the legend, fullscreen — works on the data already in the page or on the host's own
 * frame.
 *
 * WHAT to show is decided by buildViewModel (src/apps/result-view-model.js), a pure function the
 * unit tests run in node on real tool results; this file only draws it. Structure follows the
 * official MCP Apps templates: handlers are registered on the App before connect(), the host's
 * theme, style variables and fonts are applied on connect and on every context change. The pieces
 * it draws are shadcn/ui components (Card, Badge, Button, Table, Alert, Accordion, Chart),
 * styled in mcp-app.css.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Flow, SankeyController } from 'chartjs-chart-sankey';
import { buildViewModel, drillView, DRILL_ROWS, pivotRows, pivotTransform, PIVOT_LEVEL_ROWS } from '../../result-view-model.js';
import { icon } from './icons.js';
import { el, badge, card, formatNumber, formatShare, numberFormat, integerFormat, stat } from '../../shared/ui.js';
import './global.css';
import './mcp-app.css';

/**
 * The sankey drawn with rounded corners, like every other mark here (bars, slices, tiles): the nodes'
 * ends and the four corners where a flow meets its nodes, all one radius. The plugin has neither, so
 * its geometry is kept as it is and only the shapes it paints are drawn rounded — the node
 * rectangles while it paints the nodes, the flow's outline while it paints a flow.
 */
const SANKEY_RADIUS = 3;

class RoundedFlow extends Flow {
  // its own id: Chart.js registers an element's parent first and skips a second one under the same id
  static id = 'roundedFlow';

  draw(ctx) {
    const { x, x2, y, y2, height: h } = this;
    const r = Math.max(0, Math.min(SANKEY_RADIUS, h / 2, Math.abs(x2 - x) / 4));
    // the plugin's own curve (horizontal): control points at two thirds and one third of the way
    const c1 = x + ((x2 - x) * 2) / 3;
    const c2 = x + (x2 - x) / 3;
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.bezierCurveTo(c1, y, c2, y2, x2 - r, y2);
      ctx.quadraticCurveTo(x2, y2, x2, y2 + r);
      ctx.lineTo(x2, y2 + h - r);
      ctx.quadraticCurveTo(x2, y2 + h, x2 - r, y2 + h);
      ctx.bezierCurveTo(c2, y2 + h, c1, y + h, x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.closePath();
    };
    const { fill, stroke } = ctx;
    ctx.fill = () => { outline(); fill.call(ctx); };
    ctx.stroke = () => { outline(); stroke.call(ctx); };
    try {
      super.draw(ctx);
    } finally {
      delete ctx.fill; // the context's own methods again
      delete ctx.stroke;
    }
  }
}

class RoundedSankeyController extends SankeyController {
  // its own id, for the same reason; and it draws its flows with the rounded element
  static id = 'roundedSankey';
  static defaults = { ...SankeyController.defaults, dataElementType: RoundedFlow.id };

  _drawNodes() {
    const ctx = this.chart.ctx;
    const rounded = (paint) => (x, y, w, h) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, Math.max(0, Math.min(SANKEY_RADIUS, w / 2, h / 2)));
      paint();
    };
    ctx.fillRect = rounded(() => ctx.fill());
    ctx.strokeRect = rounded(() => ctx.stroke());
    try {
      super._drawNodes();
    } finally {
      delete ctx.fillRect;
      delete ctx.strokeRect;
    }
  }
}

// Only the pieces this view draws — Chart.js is tree-shakable, and the whole view ships in one file
Chart.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, RoundedFlow, LinearScale, LineController, LineElement, PointElement, RoundedSankeyController, Tooltip);

const log = {
  info: console.log.bind(console, '[APP]'),
  error: console.error.bind(console, '[APP]'),
};

// DOM element references
const mainEl = document.querySelector('.main');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const noticeEl = document.getElementById('notice');
const chartSection = document.getElementById('chart-section');
const chartTitleEl = document.getElementById('chart-title');
const chartDescriptionEl = document.getElementById('chart-description');
const chartCanvas = document.getElementById('chart');
const chartTooltip = document.getElementById('chart-tooltip');
const chartLegend = document.getElementById('chart-legend');
const cardsSection = document.getElementById('cards-section');
const notesEl = document.getElementById('notes');
const notesList = document.getElementById('notes-list');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const backBtn = document.getElementById('back-btn');
const chartCrumbs = document.getElementById('chart-crumbs');
const chartMenu = document.getElementById('chart-menu');
const chartLoading = document.getElementById('chart-loading');
const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');

// static icons
document.getElementById('notes-chevron').append(icon('chevron-down'));
document.getElementById('loading-icon').append(icon('loader-circle', 'icon spin'));

// App state
const state = {
  toolName: null,
  toolInput: null,
  chart: null,
  current: null, // the view model on screen
  drill: [], // the drill-down path: { model, crumb } from the result as it came to the view on screen
  displayMode: 'inline',
};

// ── formatting ────────────────────────────────────────────────────────────────────────────────

const formatPercent = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`);
const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
const formatPoints = (v) => `${sign(v)}${Math.abs(v * 100).toFixed(2)} pp`;
const formatSignedPercent = (v, digits = 1) => `${sign(v)}${Math.abs(v * 100).toFixed(digits)}%`;
/**
 * A time value as a reader wants it: a timestamp at midnight UTC — what a day/week/month bucket is —
 * is shown as its date ("Sep 16"), with the year when the values span more than one; a real time of
 * day keeps it. The raw value stays the sort key; only the label changes.
 */
/**
 * A warehouse time value as a Date. Warehouses spell it several ways — '2026-09-16',
 * '2026-09-16T00:00:00+00:00', '2026-09-16 00:00:00' — and the last one is not a format the
 * standard guarantees: WebKit (Safari, every iOS app) refuses it. So the value is normalised to
 * ISO 8601 first, and a time with no zone is read as UTC, which is what the warehouse means.
 */
function parseTime(v) {
  let t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00';
  t = t.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += 'Z';
  return new Date(t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

function timeFormatter(values) {
  const dates = values.map(parseTime).filter((d) => !Number.isNaN(d.getTime()));
  if (!dates.length) return (v) => String(v);
  const midnight = dates.every((d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0);
  const years = new Set(dates.map((d) => d.getUTCFullYear()));
  const fmt = new Intl.DateTimeFormat(undefined, midnight
    ? { month: 'short', day: 'numeric', ...(years.size > 1 ? { year: 'numeric' } : {}), timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return (v) => { const d = parseTime(v); return Number.isNaN(d.getTime()) ? String(v) : fmt.format(d); };
}

const formatSignedNumber = (v) => `${sign(v)}${formatNumber(Math.abs(v))}`;
const formatP = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));
/** One number format for a whole column: the same decimals down it, so the digits line up. */
function columnFormat(values) {
  const xs = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!xs.length || xs.some((x) => x !== 0 && Math.abs(x) < 0.01)) return formatNumber;
  const places = (x) => (Math.abs(x) >= 1000 ? 0 : [0, 1, 2].find((d) => Math.abs(x - Number(x.toFixed(d))) < 1e-9) ?? 2);
  const digits = Math.max(...xs.map(places));
  const f = new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (x) => (x === null || x === undefined ? '—' : f.format(x));
}
const correctionName = (c) => ({ holm: 'Holm', bh: 'Benjamini–Hochberg', bonferroni: 'Bonferroni' }[c] || c);

/**
 * A color variable RESOLVED to a concrete rgba — how the canvas chart picks up the host's theme.
 * The raw custom property can be `light-dark(…)`, `oklch(…)` or a host token; the computed color of
 * an element that uses it, painted once on a 1×1 canvas and read back, is always plain rgba.
 */
const colorProbe = document.createElement('span');
colorProbe.hidden = true;
document.body.append(colorProbe);
const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
function cssVar(name) {
  colorProbe.style.color = `var(${name})`;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = getComputedStyle(colorProbe).color;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
const seriesColor = (i) => cssVar(`--color-series-${(i % 6) + 1}`);
/** A resolved rgba color at another opacity — an area's wash is its line's color, lighter. */
const withAlpha = (rgba, a) => rgba.replace(/[\d.]+\)$/, `${a})`);

// ── building blocks ──────────────────────────────────────────────────────────────────────────

function payloadOf(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

/** shadcn Alert: an icon, a title and a description; `destructive` for a failure. */
function showAlert({ title, description, variant = 'default', iconName = 'info' }) {
  noticeEl.replaceChildren(icon(iconName), el('p', 'alert-title', title));
  if (description) {
    const d = el('div', 'alert-description');
    if (description instanceof Node) d.append(description);
    else d.textContent = description;
    noticeEl.append(d);
  }
  noticeEl.className = `alert${variant === 'destructive' ? ' alert-destructive' : ''}`;
  noticeEl.setAttribute('role', variant === 'destructive' ? 'alert' : 'status');
  noticeEl.hidden = false;
}

function setDescription(...parts) {
  subtitleEl.replaceChildren(...parts.filter(Boolean).map((p) => (p instanceof Node ? p : document.createTextNode(p))));
}

function resetSections() {
  for (const section of [noticeEl, chartSection, cardsSection, notesEl]) section.hidden = true;
  cardsSection.replaceChildren();
  cardsSection.className = '';
  notesList.replaceChildren();
  chartLegend.replaceChildren();
  chartLegend.hidden = true;
  chartTooltip.hidden = true;
  state.chart?.destroy();
  state.chart = null;
}

// ── render ───────────────────────────────────────────────────────────────────────────────────

const CARDS = { chart: (m) => renderChartResult(m), kpi: (m) => renderKpi(m), pivot: (m) => renderPivot(m), funnel: (m) => renderFunnel(m), experiment: (m) => renderExperiment(m), srm: (m) => renderSrm(m), plan: (m) => renderPlan(m) };

function render(result) {
  loadingEl.hidden = true; // the result is here: the spinner's job is done, whatever is drawn next
  const model = buildViewModel(state.toolName, payloadOf(result), state.toolInput);
  state.drill = []; // a new result starts a new drill-down path
  show(model);
}

/** Draw one view model — the result as it came, or a view of it a drill-down stepped into. */
function show(model) {
  state.current = model;
  closeDrillMenu();
  resetSections();
  updateDrillNav();
  const draw = CARDS[model.kind];
  mainEl.hidden = !draw;
  statusEl.hidden = !!draw;
  if (!draw) {
    showStatus(model);
    return;
  }
  titleEl.textContent = model.title;
  setDescription();
  draw(model);
}

// ── KPI tiles (shadcn stat cards: the value large, its change, the trend as a sparkline) ─────────

function formatKpi(value, tile) {
  if (value === null || value === undefined) return '—';
  if (tile.format === 'percent') return `${(value * 100).toFixed(Math.abs(value) < 0.1 ? 2 : 1)}%`;
  if (tile.format === 'currency') {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: tile.currency, maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }).format(value);
    } catch { return formatNumber(value); }
  }
  return formatNumber(value);
}

/** The trend under a tile: one line, no axes — its shape is the point, the numbers are in the title. */
function sparkline(values) {
  const NS = 'http://www.w3.org/2000/svg';
  const known = values.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  const lo = Math.min(...known.map(([, v]) => v));
  const hi = Math.max(...known.map(([, v]) => v));
  const W = 100;
  const H = 32;
  const x = (i) => (values.length > 1 ? (i / (values.length - 1)) * W : 0);
  const y = (v) => (hi > lo ? H - 2 - ((v - lo) / (hi - lo)) * (H - 4) : H / 2);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'kpi-sparkline');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', known.map(([i, v]) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' '));
  svg.append(line);
  return svg;
}

function renderKpi(model) {
  const asOf = model.as_of ? timeFormatter([model.as_of])(model.as_of) : null;
  setDescription(
    badge(`${model.tiles.length} ${model.tiles.length === 1 ? 'metric' : 'metrics'}`, 'secondary'),
    asOf ? badge(`as of ${asOf}`, 'outline') : null,
  );
  const vs = model.compared_to === 'previous' ? 'vs previous' : model.compared_to ? `vs ${timeFormatter([model.compared_to])(model.compared_to)}` : null;
  cardsSection.className = 'kpi-grid';
  for (const tile of model.tiles) {
    let change = null;
    if (tile.change !== null) {
      // coloured only when the caller said which way is good; otherwise the change is just stated
      const up = tile.change > 0;
      const verdict = !tile.good || tile.change === 0 ? 'neutral' : (up === (tile.good === 'up')) ? 'good' : 'bad';
      change = el('p', `kpi-change kpi-change-${verdict}`);
      change.append(icon(tile.change === 0 ? 'minus' : up ? 'trending-up' : 'trending-down'), el('span', null, formatSignedPercent(tile.change)));
      if (vs) change.append(el('span', 'kpi-vs', vs));
    } else if (tile.previous !== null) {
      change = el('p', 'kpi-change kpi-change-neutral', `${formatKpi(tile.previous, tile)} before`);
    }
    const body = el('div', 'card-content kpi-body');
    body.append(...[change, tile.trend ? sparkline(tile.trend) : null].filter(Boolean));
    cardsSection.append(card({ description: tile.label, title: formatKpi(tile.value, tile), titleClass: 'card-title card-title-stat' }, body.childElementCount ? body : null));
  }
  cardsSection.hidden = false;
}

// ── pivot: a drill-down table, each level read from the stored result when its row opens ───────

function renderPivot(model) {
  const drillable = model.levels.length > 1 && canFollow();
  setDescription(badge(`${model.levels.length} ${model.levels.length === 1 ? 'level' : 'levels'}`, 'secondary'));
  const table = el('table', 'table pivot-table');
  const head = document.createElement('tr');
  // the header names the TOP level only; a row names the level it opens into while it is open
  const first = el('th', null, model.levels[0].label);
  first.scope = 'col';
  head.append(first, ...model.values.map((v) => { const th = el('th', 'num', v.label); th.scope = 'col'; return th; }));
  table.append(document.createElement('thead'), document.createElement('tbody'));
  table.tHead.append(head);
  const body = table.tBodies[0];

  // a row's children, once read; a closed row keeps them, so reopening it reads nothing
  const opened = new Map();

  const note = (text, depth, cls = '') => {
    const tr = el('tr', `pivot-note ${cls}`);
    const td = el('td', null);
    td.colSpan = model.values.length + 1;
    td.style.setProperty('--depth', String(depth));
    td.append(el('span', null, text));
    tr.append(td);
    return tr;
  };

  // the open state shows twice: the chevron turns, and the row names the level under it
  const markOpen = (tr, open) => {
    tr.querySelector('.pivot-toggle')?.setAttribute('aria-expanded', String(open));
    const by = tr.querySelector('.pivot-by');
    if (by) by.hidden = !open;
  };

  const collapse = (tr) => {
    const state = opened.get(tr);
    if (!state?.open) return;
    for (const child of state.rows) { collapse(child); child.remove(); }
    state.open = false;
    markOpen(tr, false);
  };

  const rowEl = (row, path, depth) => {
    const tr = el('tr', 'pivot-row');
    const cell = el('td', 'pivot-label');
    cell.style.setProperty('--depth', String(depth));
    const canOpen = drillable && depth < model.levels.length - 1;
    if (canOpen) {
      const btn = el('button', 'btn btn-ghost btn-icon pivot-toggle');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', `Open ${row.label} by ${model.levels[depth + 1].label}`);
      btn.append(icon('chevron-right'));
      btn.addEventListener('click', () => toggle(tr, row, path, depth));
      cell.append(btn);
    } else {
      cell.append(el('span', 'pivot-leaf'));
    }
    cell.append(el('span', row.key === null ? 'null' : null, row.label));
    if (canOpen) {
      const by = el('span', 'pivot-by', `by ${model.levels[depth + 1].label}`);
      by.hidden = true;
      cell.append(by);
    }
    tr.append(cell, ...model.values.map((v, i) => el('td', 'num', formatKpi(row.values[i], v))));
    return tr;
  };

  const insertAfter = (anchor, nodes) => { anchor.after(...nodes); };

  async function toggle(tr, row, path, depth) {
    const state = opened.get(tr);
    if (state?.open) { collapse(tr); return; }
    const btn = tr.querySelector('.pivot-toggle');
    markOpen(tr, true);
    if (state?.rows) { insertAfter(tr, state.rows); state.open = true; return; }
    if (state?.loading) return;
    opened.set(tr, { loading: true });
    const loading = note(`Loading ${model.levels[depth + 1].label}…`, depth + 1, 'pivot-loading');
    loading.querySelector('td').prepend(icon('loader-circle', 'icon spin'));
    tr.after(loading);
    const at = [...path, row.key];
    let rows;
    try {
      const got = payloadOf(await readResult({ ...model.source, transform: pivotTransform(model.display, at), limit: PIVOT_LEVEL_ROWS }));
      if (got?.ok === false) {
        // the reason is said, so a failed level is diagnosable from the card itself
        rows = [note(got.error?.code === 'result_gone' ? 'This result is no longer available' : `Could not load this level${got.error?.message ? ` — ${String(got.error.message).split('\n')[0].slice(0, 160)}` : ''}`, depth + 1, 'pivot-error')];
      } else {
        const children = pivotRows(got, model.display, depth + 1);
        rows = children.length ? children.map((c) => rowEl(c, at, depth + 1)) : [note('No rows', depth + 1)];
        if (got?.page?.has_more) rows.push(note(`Top ${children.length} shown`, depth + 1));
      }
    } catch (e) {
      log.error('opening a pivot row failed', e);
      rows = [note(`Could not load this level${e?.message ? ` — ${String(e.message).split('\n')[0].slice(0, 160)}` : ''}`, depth + 1, 'pivot-error')];
    }
    loading.remove();
    const still = btn.getAttribute('aria-expanded') === 'true';
    opened.set(tr, { rows, open: still });
    if (still) insertAfter(tr, rows);
  }

  body.append(...model.rows.map((r) => rowEl(r, [], 0)));
  if (!model.rows.length) body.append(note('No rows', 0));
  if (model.has_more) body.append(note(`Top ${model.rows.length} shown`, 0));

  const container = el('div', 'table-container pivot-container');
  container.append(table);
  const content = el('div', 'card-content');
  content.append(container);
  cardsSection.className = 'ab-list';
  cardsSection.append(card({ title: model.values.map((v) => v.label).join(' · ') }, content));
  cardsSection.hidden = false;
}

// ── reading more of this card's own result (a drill-down's next view) ─────────────────────────

/** Whether the host proxies a view's tools/call at all — without it nothing can be drilled into. */
const canFollow = () => !!app.getHostCapabilities()?.serverTools;

/**
 * THE view's one way to the server: drill_result (a tool only a view may call), for the task this
 * card was drawn from — its stored table's next view when a drill-down steps down (a pivot row, a
 * chart mark). Read-only, and only this card's own result.
 */
const readResult = (args) => app.callServerTool({ name: 'drill_result', arguments: args });

/** The one line a result without a card gets — what happened, and that the reply carries the rest. */
function showStatus(model) {
  const lines = {
    // display_model_result draws finished results only; a running one is refused before it gets here
    running: ['clock', 'Still running'],
    // the result this card showed or waited for was deleted or expired since — not an error
    gone: ['clock', 'This result is no longer available'],
    error: ['circle-alert', 'Error'],
  };
  const [name, text, cls] = lines[model.reason] || ['info', 'Nothing to chart'];
  statusEl.replaceChildren(icon(name, cls), el('span', null, text));
  statusEl.classList.toggle('status-line-error', model.reason === 'error');
}

function renderChartResult(model) {
  // a page of a larger result says which rows it is, so a chart of one page never reads as the whole
  const page = model.page;
  const partial = page && (page.offset > 0 || page.has_more);
  const rowsText = partial
    ? `rows ${formatNumber(page.offset + 1)}–${formatNumber(page.offset + model.row_count)}${page.has_more ? ' · more exist' : ''}`
    : `${formatNumber(model.row_count)} row${model.row_count === 1 ? '' : 's'}`;
  setDescription(
    badge(rowsText, 'secondary'),
    model.sampled ? badge('random sample', 'outline') : null,
    model.approximate ? badge('approximate', 'outline') : null,
  );
  renderChart(model.chart, model.chart.y || 'Series');
}

/** What the chart left out, in the model's own numbers: series not drawn, and by what rule. */
function showFolded(chart) {
  if (!chart.folded) return;
  const bySize = chart.folded_by === 'size';
  showAlert({
    title: `${chart.folded} ${bySize ? 'smaller ' : ''}series ${chart.folded === 1 ? 'is' : 'are'} not drawn`,
    description: bySize ? `The chart keeps the largest ${chart.kept}.` : `The chart keeps the first ${chart.kept}, in column order.`,
  });
}

// ── chart (shadcn charts: horizontal grid only, no axis or tick lines, HTML tooltip and legend) ─

function renderChart(chart, title) {
  chartTitleEl.textContent = chart.type === 'line' ? `${title} over ${chart.x}`
    : chart.type === 'pie' ? `${title} · share by ${chart.x}`
      : chart.type === 'sankey' ? `${title} from ${chart.x} to ${chart.to}`
        : `${title} by ${chart.x}`;
  chartSection.hidden = false;
  const muted = cssVar('--muted-foreground');
  const grid = cssVar('--border');
  const common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, left: 4, right: 12 } },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false, external: drawTooltip },
    },
    scales: {
      x: { border: { display: false }, grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkip: true, padding: 8, font: { size: 12 } } },
      y: { border: { display: false }, grid: { color: grid, drawTicks: false }, ticks: { color: muted, padding: 8, font: { size: 12 }, callback: (v) => formatNumber(v), maxTicksLimit: 6 }, beginAtZero: true },
    },
  };

  if (chart.type === 'line') {
    // a declared non-time axis (chart.ordered) keeps the order the rows came in; time is sorted
    const seen = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p[0])))];
    const labels = chart.ordered ? seen : seen.sort();
    const timeLabel = chart.ordered ? String : timeFormatter(labels);
    state.chart = new Chart(chartCanvas, {
      type: 'line',
      data: {
        labels: labels.map(timeLabel),
        datasets: chart.series.map((s, i) => {
          const byX = new Map(s.points);
          return {
            label: s.name,
            swatch: seriesColor(i), // what the legend and the tooltip show for this series
            data: labels.map((x) => (byX.has(x) ? byX.get(x) : null)),
            borderColor: seriesColor(i),
            // an area is a wash of its line's color; stacked bands sit on the one below
            backgroundColor: chart.area ? withAlpha(seriesColor(i), chart.stacked ? 0.35 : 0.12) : seriesColor(i),
            fill: chart.area ? (chart.stacked && i > 0 ? '-1' : 'origin') : false,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: cssVar('--card'),
            cubicInterpolationMode: 'monotone', // smooth like shadcn's, never overshooting the data
            spanGaps: true,
          };
        }),
      },
      // a line reads a CHANGE, so its axis fits the data; an area (an amount, stacked or not) and a
      // bar (a length) start at zero
      options: {
        ...common,
        ...drillOptions(chart, (el) => linePointDrill(chart, labels, timeLabel, el)),
        scales: chart.area
          ? { x: common.scales.x, y: { ...common.scales.y, stacked: !!chart.stacked } }
          : { ...common.scales, y: { ...common.scales.y, beginAtZero: false, grace: '5%' } },
      },
    });
    chartDescriptionEl.textContent = `${labels.length} points · ${chart.series.length} series`;
    chartCanvas.setAttribute('aria-label', `${title}: ${chart.series.length} series over ${labels.length} points`);
    if (chart.series.length > 1) drawLegend();
    showFolded(chart);
    return;
  }

  if (chart.type === 'pie') {
    const colors = chart.slices.map((x, i) => (x.other ? cssVar('--muted-foreground') : seriesColor(i)));
    state.chart = new Chart(chartCanvas, {
      type: 'doughnut',
      data: {
        labels: chart.slices.map((x) => x.label),
        datasets: [{
          label: chart.y || 'value',
          data: chart.slices.map((x) => x.value),
          backgroundColor: colors,
          hoverBackgroundColor: colors,
          borderColor: cssVar('--card'), // the surface gap between slices
          borderWidth: 2,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: '62%',
        layout: { padding: 8 },
        interaction: { mode: 'nearest', intersect: true },
        plugins: { legend: { display: false }, tooltip: { enabled: false, external: drawTooltip } },
        ...drillOptions(chart, (el) => sliceDrill(chart, el)),
      },
    });
    chartDescriptionEl.textContent = `${chart.slices.length} slices · total ${formatNumber(chart.total)}${chart.folded ? ` · ${chart.folded} smallest in Other` : ''}`;
    chartCanvas.setAttribute('aria-label', `${title}: ${chart.slices.map((x) => `${x.label} ${formatShare(x.share)}`).join(', ')}`);
    drawSliceLegend(chart.slices);
    return;
  }

  if (chart.type === 'sankey') {
    // the largest nodes keep a series color, the rest share the muted one — never a generated 7th hue
    const colorOf = new Map(chart.nodes.map((n, i) => [n.name, i < 6 ? seriesColor(i) : muted]));
    state.chart = new Chart(chartCanvas, {
      type: RoundedSankeyController.id,
      data: {
        datasets: [{
          label: chart.y || 'flow',
          data: chart.links,
          colorFrom: (c) => colorOf.get(c.dataset.data[c.dataIndex]?.from) || muted,
          colorTo: (c) => colorOf.get(c.dataset.data[c.dataIndex]?.to) || muted,
          colorMode: 'from', // a flow wears the color of where it comes from
          alpha: 0.35,
          color: cssVar('--foreground'), // node labels wear text ink, never a series color
          font: { size: 12 },
          nodeWidth: 8,
          // a 2px surface gap between a node and the flows that meet it, like the gap between stacked
          // bars and between slices: the node's border in the card color (the plugin starts a flow
          // half a border away from the node)
          borderWidth: 3,
          borderColor: cssVar('--card'),
          size: 'max',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { top: 4, bottom: 4, left: 4, right: 4 } },
        interaction: { mode: 'nearest', intersect: true },
        plugins: { legend: { display: false }, tooltip: { enabled: false, external: drawTooltip } },
      },
    });
    const total = chart.links.reduce((a, l) => a + l.flow, 0);
    chartDescriptionEl.textContent = `${chart.nodes.length} nodes · ${chart.links.length} flows · ${formatNumber(total)} in all links`;
    chartCanvas.setAttribute('aria-label', `${title}: ${chart.links.slice(0, 20).map((l) => `${l.from} to ${l.to} ${formatNumber(l.flow)}`).join(', ')}`);
    return;
  }

  // bars: one series (a bar per category), several side by side (grouped) or stacked into one
  const series = chart.series || [{ name: chart.y || 'value', values: chart.bars.map((b) => b.value) }];
  // the model already chose the categories drawn; categories_total says how many there were
  const labels = chart.labels || chart.bars.map((b) => b.label);
  const total = chart.categories_total ?? labels.length;
  const horizontal = typeof chart.horizontal === 'boolean' ? chart.horizontal : labels.length > 8;
  const stacked = !!chart.stacked;
  state.chart = new Chart(chartCanvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.name,
        swatch: seriesColor(i),
        data: s.values.slice(0, labels.length),
        backgroundColor: seriesColor(i),
        hoverBackgroundColor: seriesColor(i),
        // stacked segments are parted by a 2px gap in the surface color, never by a drawn stroke
        borderColor: stacked ? cssVar('--card') : seriesColor(i),
        borderWidth: stacked ? 1 : 0,
        borderRadius: stacked ? 4 : 8,
        borderSkipped: stacked ? false : 'start', // the data end is rounded, the baseline stays square
        maxBarThickness: series.length > 1 && !stacked ? 24 : 48,
      })),
    },
    options: {
      ...common,
      ...drillOptions(chart, (el) => barDrill(chart, labels, series, el)),
      indexAxis: horizontal ? 'y' : 'x',
      scales: horizontal
        ? { x: { ...common.scales.y, stacked }, y: { ...common.scales.x, stacked } }
        : { x: { ...common.scales.x, stacked }, y: { ...common.scales.y, stacked } },
    },
  });
  const count = total > labels.length ? `${labels.length} of ${formatNumber(total)} categories shown` : `${labels.length} ${labels.length === 1 ? 'bar' : 'bars'}`;
  chartDescriptionEl.textContent = series.length > 1 ? `${count.replace(/bars?$/, labels.length === 1 ? 'category' : 'categories')} · ${series.length} series${stacked ? ', stacked' : ''}` : count;
  chartCanvas.setAttribute('aria-label', `${title}: ${labels.length} categories${series.length > 1 ? `, ${series.length} series` : ''}`);
  if (series.length > 1) drawLegend();
  showFolded(chart);
  // other amounts of an inferred breakdown share no axis with the drawn one: named, not drawn
  if (chart.omitted?.length) showAlert({ title: `${chart.omitted.length} more ${chart.omitted.length === 1 ? 'column is' : 'columns are'} not drawn`, description: chart.omitted.join(', ') });
}

// ── drill-down: a click on a mark offers the dimensions left, the chart redraws filtered to it ──

/**
 * Chart.js click and hover options for a chart that can be drilled into (nothing otherwise): a
 * mark under the pointer shows a hand, and a click on it opens the drill menu. `target` turns the
 * clicked element into what the menu drills into — the filters it adds, how it reads, and which
 * steps it offers — or null when the mark cannot be drilled (an "Other" slice).
 */
function drillOptions(chart, target) {
  if (!chart.drill?.levels?.length || !canFollow()) return {};
  return {
    onHover: (evt, els) => { chartCanvas.style.cursor = els.length ? 'pointer' : 'default'; },
    onClick: (evt, els) => {
      const t = els.length ? target(els[0]) : null;
      if (t) openDrillMenu(chart, t, evt.x, evt.y);
      else closeDrillMenu();
    },
  };
}

const drillFilter = (column, key, label) => ({ column, value: key ?? null, label });

function barDrill(chart, labels, series, el) {
  const d = chart.drill;
  const filters = [drillFilter(chart.x, d.keys?.[el.index], labels[el.index])];
  // a bar of a split is one category AND one value of the split
  if (d.series_column && series[el.datasetIndex]) filters.push(drillFilter(d.series_column, series[el.datasetIndex].key, series[el.datasetIndex].name));
  return { filters, steps: d.levels.map((level) => ({ level, mode: 'breakdown' })) };
}

function sliceDrill(chart, el) {
  const slice = chart.slices[el.index];
  if (!slice || slice.other) return null; // "Other" is several slices, not one value to filter by
  return { filters: [drillFilter(chart.x, slice.key, slice.label)], steps: chart.drill.levels.map((level) => ({ level, mode: 'breakdown' })) };
}

function linePointDrill(chart, labels, timeLabel, el) {
  const d = chart.drill;
  const x = labels[el.index];
  const line = chart.series[el.datasetIndex];
  const bySeries = d.series_column && line ? [drillFilter(d.series_column, line.key, line.name)] : [];
  const atX = drillFilter(chart.x, d.x_keys ? d.x_keys[x] : x, timeLabel(x));
  // a point opens into that moment broken down, or into the whole line split over time
  return {
    filters: [...bySeries, atX],
    steps: d.levels.flatMap((level) => [
      { level, mode: 'breakdown', filters: [...bySeries, atX], hint: timeLabel(x) },
      { level, mode: 'trend', filters: bySeries, hint: 'over time' },
    ]),
  };
}

function closeDrillMenu() {
  chartMenu.hidden = true;
  chartMenu.replaceChildren();
}

function openDrillMenu(chart, target, x, y) {
  clearTooltip();
  const heading = el('div', 'chart-menu-label', target.filters.map((f) => f.label).join(' · '));
  chartMenu.replaceChildren(heading, ...target.steps.map((step) => {
    const item = el('button', 'chart-menu-item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(icon(step.mode === 'trend' ? 'trending-up' : 'chevron-right'), el('span', null, `by ${step.level.label}`));
    if (step.hint) item.append(el('span', 'chart-menu-hint', step.hint));
    item.addEventListener('click', () => drillInto(chart, step.filters || target.filters, step));
    return item;
  }));
  chartMenu.hidden = false;
  // beside the click, kept inside the chart
  const box = chartCanvas.getBoundingClientRect();
  const w = chartMenu.offsetWidth;
  const h = chartMenu.offsetHeight;
  chartMenu.style.left = `${Math.max(0, Math.min(x + 8, box.width - w))}px`;
  chartMenu.style.top = `${Math.max(0, Math.min(y + 8, box.height - h))}px`;
  chartMenu.querySelector('.chart-menu-item')?.focus({ preventScroll: true });
}

/** One step down: read the view from the stored table, and draw it in place of this one. */
async function drillInto(chart, filters, step) {
  closeDrillMenu();
  const d = chart.drill;
  const path = [...d.path, ...filters.map(({ column, value }) => ({ column, value }))];
  const view = drillView(d.display, path, { level: { column: step.level.column }, mode: step.mode });
  chartLoading.replaceChildren(icon('loader-circle', 'icon spin'));
  chartLoading.hidden = false;
  let got;
  try {
    got = payloadOf(await readResult({ ...d.source, transform: view.transform, limit: DRILL_ROWS }));
  } catch (e) {
    log.error('drilling down failed', e);
    got = { ok: false, error: { message: e?.message } };
  }
  chartLoading.hidden = true;
  if (got?.ok === false) {
    const reason = got.error?.message ? String(got.error.message).split('\n')[0].slice(0, 200) : undefined;
    showAlert(got.error?.code === 'result_gone'
      ? { title: 'This result is no longer available', iconName: 'clock' }
      : { title: 'Could not load this view', description: reason, variant: 'destructive', iconName: 'circle-alert' });
    return;
  }
  const next = buildViewModel(state.toolName, { ...got, display: view.display, drill_source: d.source, drill_path: path }, null);
  if (next.kind !== 'chart') {
    showAlert({ title: 'Nothing to draw for this selection' });
    return;
  }
  next.title = state.current.title; // the card keeps its name; the path says where it is
  if (!state.drill.length) state.drill.push({ model: state.current, crumb: 'All' });
  const crumb = [...filters.map((f) => f.label), step.mode === 'trend' || !filters.length ? `by ${step.level.label}` : null].filter(Boolean).join(' · ');
  state.drill.push({ model: next, crumb });
  show(next);
}

/** The path taken, as a breadcrumb over the chart, and the back button beside fullscreen. */
function updateDrillNav() {
  const path = state.drill;
  const deep = path.length > 1 && state.current === path[path.length - 1].model;
  backBtn.hidden = !deep;
  chartCrumbs.hidden = !deep;
  if (!deep) { chartCrumbs.replaceChildren(); return; }
  chartCrumbs.replaceChildren(...path.flatMap((entry, i) => {
    const last = i === path.length - 1;
    const node = last ? el('span', null, entry.crumb) : el('button', null, entry.crumb);
    if (last) node.setAttribute('aria-current', 'page');
    else { node.type = 'button'; node.addEventListener('click', () => goBackTo(i)); }
    return i ? [icon('chevron-right'), node] : [node];
  }));
}

function goBackTo(index) {
  state.drill = state.drill.slice(0, index + 1);
  const target = state.drill[index].model;
  if (index === 0) state.drill = [];
  show(target);
}

backBtn.replaceChildren(icon('chevron-left'));
backBtn.addEventListener('click', () => { if (state.drill.length > 1) goBackTo(state.drill.length - 2); });
document.addEventListener('pointerdown', (e) => { if (!chartMenu.hidden && !chartMenu.contains(e.target) && e.target !== chartCanvas) closeDrillMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrillMenu(); });

/** shadcn ChartTooltipContent, drawn as HTML next to the canvas. */
function drawTooltip({ chart, tooltip }) {
  // an open drill menu is the answer to the click: no tooltip on top of it
  if (tooltip.opacity === 0 || !tooltip.dataPoints?.length || !chartMenu.hidden) {
    chartTooltip.hidden = true;
    return;
  }
  const items = el('div', 'chart-tooltip-items');
  const slice = chart.config.type === 'doughnut';
  if (chart.config.type === RoundedSankeyController.id) {
    // a flow: where it starts, where it goes, how much of the source it carries
    const { from, to, flow } = tooltip.dataPoints[0].raw;
    const out = chart.data.datasets[0].data.filter((l) => l.from === from).reduce((a, l) => a + l.flow, 0);
    const row = el('div', 'chart-tooltip-item');
    const value = el('div', 'chart-tooltip-value');
    value.append(el('span', 'chart-tooltip-name', `→ ${to}`), el('span', 'chart-tooltip-number', `${formatNumber(flow)} · ${formatShare(out ? flow / out : null)}`));
    row.append(value);
    items.append(row);
    chartTooltip.replaceChildren(el('div', 'chart-tooltip-label', from), items);
    placeTooltip(chart, tooltip);
    return;
  }
  for (const p of tooltip.dataPoints) {
    const row = el('div', 'chart-tooltip-item');
    const swatch = el('span', 'chart-indicator');
    // a slice wears its own color and reads as its share of the whole
    swatch.style.backgroundColor = slice ? p.dataset.backgroundColor[p.dataIndex] : p.dataset.swatch;
    const value = el('div', 'chart-tooltip-value');
    const n = slice ? p.parsed : p.parsed[chart.options.indexAxis === 'y' ? 'x' : 'y'];
    const total = slice ? p.dataset.data.reduce((a, v) => a + v, 0) : 0;
    value.append(el('span', 'chart-tooltip-name', p.dataset.label), el('span', 'chart-tooltip-number', slice ? `${formatNumber(n)} · ${formatShare(total ? n / total : null)}` : formatNumber(n)));
    row.append(swatch, value);
    items.append(row);
  }
  const heading = slice ? chart.data.labels[tooltip.dataPoints[0].dataIndex] : tooltip.title?.[0];
  chartTooltip.replaceChildren(el('div', 'chart-tooltip-label', heading ?? ''), items);
  placeTooltip(chart, tooltip);
}

function placeTooltip(chart, tooltip) {
  chartTooltip.hidden = false;
  // beside the cursor, flipped to the other side near the right edge, always inside the chart
  const { width, height } = chart.canvas.getBoundingClientRect();
  const w = chartTooltip.offsetWidth;
  const h = chartTooltip.offsetHeight;
  const x = tooltip.caretX + 12 + w > width ? tooltip.caretX - 12 - w : tooltip.caretX + 12;
  chartTooltip.style.left = `${Math.max(0, x)}px`;
  chartTooltip.style.top = `${Math.min(Math.max(0, tooltip.caretY - h / 2), Math.max(0, height - h))}px`;
}

/** shadcn ChartLegendContent: a swatch per series; a click shows or hides that series. */
function drawLegend() {
  const chart = state.chart;
  chartLegend.replaceChildren(...chart.data.datasets.map((ds, i) => {
    const item = el('button', 'chart-legend-item');
    item.type = 'button';
    item.setAttribute('aria-pressed', 'true');
    const swatch = el('span', 'chart-indicator');
    swatch.style.backgroundColor = ds.swatch;
    item.append(swatch, document.createTextNode(ds.label));
    item.addEventListener('click', () => {
      const visible = !chart.isDatasetVisible(i);
      chart.setDatasetVisibility(i, visible);
      item.setAttribute('aria-pressed', String(visible));
      chart.update();
    });
    return item;
  }));
  chartLegend.hidden = false;
}

/** The legend of a donut: a swatch, the slice and its share; a click shows or hides the slice. */
function drawSliceLegend(slices) {
  const chart = state.chart;
  const colors = chart.data.datasets[0].backgroundColor;
  chartLegend.replaceChildren(...slices.map((x, i) => {
    const item = el('button', 'chart-legend-item');
    item.type = 'button';
    item.setAttribute('aria-pressed', 'true');
    const swatch = el('span', 'chart-indicator');
    swatch.style.backgroundColor = colors[i];
    item.append(swatch, document.createTextNode(`${x.label} · ${formatShare(x.share)}`));
    item.addEventListener('click', () => {
      chart.toggleDataVisibility(i);
      item.setAttribute('aria-pressed', String(chart.getDataVisibility(i)));
      chart.update();
    });
    return item;
  }));
  chartLegend.hidden = false;
}

/**
 * The tooltip is for the moment of looking. A pointer that leaves the chart hides it at once; a
 * finger has no "leave" (Chart.js keeps the last tapped point active), so it goes a moment after the
 * touch ends — and with it the highlighted points, so the chart is back to itself.
 */
let tooltipTimer;
function clearTooltip() {
  clearTimeout(tooltipTimer);
  chartTooltip.hidden = true;
  const chart = state.chart;
  if (chart && (chart.getActiveElements().length || chart.tooltip?.getActiveElements().length)) {
    chart.setActiveElements([]);
    chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
    chart.update('none');
  }
}
// A lifted finger also fires pointerleave — and the browser then replays the touch as a mouse move,
// which Chart.js answers by showing the tooltip again. So only a MOUSE leaving hides it at once; a
// touch (or pen) schedules the hide, which lands after that replay.
const hideSoon = () => { clearTimeout(tooltipTimer); tooltipTimer = setTimeout(clearTooltip, 1200); };
chartCanvas.addEventListener('pointerleave', (e) => (e.pointerType === 'mouse' ? clearTooltip() : hideSoon()));
chartCanvas.addEventListener('pointercancel', hideSoon);
chartCanvas.addEventListener('pointerdown', () => clearTimeout(tooltipTimer));
chartCanvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') hideSoon(); });
window.addEventListener('scroll', clearTooltip, { passive: true });

// ── A/B result ────────────────────────────────────────────────────────────────────────────────
//
// One variant: a stat card (shadcn dashboard "section cards") — the comparison as the description,
// the lift as the headline, the verdict as the badge; the interval plot as the content; the key
// figures in a divided grid at the foot.
// Several variants: ONE card holding them all — the control as the baseline row, then a row per
// variant (value, lift, interval, verdict), every interval on the same scale with one shared axis
// under them, so the variants compare down a single column.

// The badge names the direction; its colour says whether that direction is good for this metric
// (outcome, from the caller's `good`): an improvement green, a regression red, no difference plain.
const VERDICTS = {
  increase: { icon: 'trending-up', text: 'Significant increase' },
  decrease: { icon: 'trending-down', text: 'Significant decrease' },
  // an interval across zero is not evidence of no effect — it is not enough evidence either way
  no_difference: { icon: 'minus', text: 'Inconclusive' },
};
const OUTCOME_VARIANT = { better: 'success', worse: 'destructive', no_difference: 'outline' };

/** The axis under an interval: the scale's ends and the no-effect line in the middle. */
function intervalAxis(scale, unit, fmt) {
  const tick = unit === 'relative' ? (x) => formatSignedPercent(x, Number.isInteger(Math.round(x * 1e6) / 1e4) ? 0 : 1) : fmt;
  const axis = el('div', 'ci-axis');
  axis.append(el('span', null, tick(-scale)), el('span', null, 'no effect'), el('span', null, tick(scale)));
  return axis;
}

/** The effect's interval on the shared scale: a range bar, the point estimate, the no-effect line. */
function intervalPlot(v, scale, fmt, confidenceLabel, { axis = true } = {}) {
  const e = v.effect;
  const pos = (x) => `${(50 + (Math.max(-scale, Math.min(scale, x)) / scale) * 50).toFixed(2)}%`;
  const plot = el('div', `ci-plot${v.outcome === 'better' ? ' ci-better' : v.outcome === 'worse' ? ' ci-worse' : ''}`);
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', `${v.variant}: ${confidenceLabel} interval ${fmt(e.lo)} to ${fmt(e.hi)}, estimate ${fmt(e.point)}; zero means no effect`);
  const track = el('div', 'ci-track');
  const range = el('div', 'ci-range');
  range.style.left = pos(e.lo);
  range.style.right = `calc(100% - ${pos(e.hi)})`;
  range.title = `${confidenceLabel} CI ${fmt(e.lo)} … ${fmt(e.hi)}`;
  const point = el('div', 'ci-point');
  point.style.left = pos(e.point);
  point.title = `estimate ${fmt(e.point)}`;
  track.append(el('div', 'ci-zero'), range, point);
  plot.append(track);
  if (axis) plot.append(intervalAxis(scale, e.unit, fmt));
  return plot;
}

function renderExperiment(model) {
  const confidenceLabel = model.confidence !== null ? `${Math.round(model.confidence * 100)}%` : '';
  const split = model.split;
  setDescription(
    confidenceLabel ? badge(`${confidenceLabel} confidence`, 'outline') : null,
    model.alternative && model.alternative !== 'two_sided' ? badge(`one-sided · ${model.alternative}`, 'outline') : null,
    model.correction ? badge(`${correctionName(model.correction)} correction`, 'outline') : null,
    // an inverted metric says so up front: a green decrease must not read as a mistake
    model.good === 'down' ? badge('lower is better', 'outline', 'trending-down') : null,
    model.variants.some((v) => v.p_value_sequential !== null) ? badge('sequential · safe to peek', 'outline') : null,
    split && !split.detected ? badge(`split as designed · p ${formatP(split.p_value)}`, 'outline', 'circle-check') : null,
  );
  // the trust gate comes first: a split that is not the designed one invalidates every lift below
  if (split?.detected) {
    showAlert({
      title: 'Sample ratio mismatch — these results cannot be trusted',
      description: `The groups are not the split the test was designed for (p ${formatP(split.p_value)}), so randomization or logging is broken. Find the cause before reading any lift.`,
      variant: 'destructive',
      iconName: 'circle-alert',
    });
  }

  const isRate = model.metric === 'proportion';
  const valueFormat = isRate ? formatPercent : columnFormat(model.variants.flatMap((v) => [v.control_value, v.variant_value]));
  const ctx = {
    model,
    confidenceLabel,
    // under a sample ratio mismatch no verdict is given: the badge says why instead
    verdictBadge: (v) => {
      if (split?.detected) return badge('Untrusted · split mismatch', 'destructive', 'circle-alert');
      const verdict = VERDICTS[v.verdict];
      return badge(verdict.text, OUTCOME_VARIANT[v.outcome] || 'outline', verdict.icon);
    },
    isRate,
    value: (x) => (x === null ? '—' : valueFormat(x)),
    size: (n) => (n === null ? null : `${integerFormat.format(n)} users`),
    // the effect's own unit: a relative lift as a signed percent, an absolute one in points or units
    fmtOf: (e) => (e?.unit === 'relative' ? (x) => formatSignedPercent(x) : isRate ? formatPoints : formatSignedNumber),
    absolute: (lift) => (isRate ? formatPoints(lift) : formatSignedNumber(lift)),
    // the p-value shown is the adjusted one when a correction ran; the raw one only when it differs
    pCaption: (v) => {
      const rawDiffers = v.p_value_adjusted !== null && v.p_value !== null && formatP(v.p_value_adjusted) !== formatP(v.p_value);
      return v.p_value_adjusted !== null ? `${correctionName(model.correction)}-adjusted${rawDiffers ? ` · raw ${formatP(v.p_value)}` : ''}` : null;
    },
    // what an inconclusive result still says: how large an effect this sample could have seen, and
    // that an interval clearing zero lost its significance only to the multiplicity correction
    evidence: (v, fmt) => {
      if (v.significant) return null;
      if (v.significant_raw && model.correction) return `significant only before the ${correctionName(model.correction)} correction`;
      return v.detectable !== null ? `could detect ±${fmt(v.detectable).replace(/^[+−-]/, '')}` : null;
    },
  };

  cardsSection.className = 'ab-list';
  const node = model.variants.length > 1 ? experimentTable(ctx) : experimentCard(ctx, model.variants[0]);
  if (split?.detected) node.classList.add('ab-untrusted');
  cardsSection.append(node);
  cardsSection.hidden = false;
  showNotes(model.notes);
}

/** One variant against the control: the stat card. */
function experimentCard({ model, confidenceLabel, verdictBadge, value, size, fmtOf, absolute, pCaption, evidence }, v) {
  const e = v.effect;
  const fmt = fmtOf(e);

  const headline = e ? fmt(e.point) : v.lift === null ? '—' : formatSignedNumber(v.lift);
  const subline = [
    v.lift !== null && e?.unit === 'relative' ? `${absolute(v.lift)} absolute` : null,
    e ? `${confidenceLabel} CI ${fmt(e.lo)} to ${fmt(e.hi)}` : null,
    evidence(v, fmt),
  ].filter(Boolean).join(' · ');

  const content = el('div', 'card-content');
  if (e) content.append(intervalPlot(v, model.scale, fmt, confidenceLabel));

  const p = v.p_value_adjusted ?? v.p_value;
  const stats = el('dl', 'stat-grid');
  stats.append(...[
    stat(model.control, value(v.control_value), size(v.n_control)),
    stat(v.variant, value(v.variant_value), size(v.n_variant)),
    p !== null ? stat('p-value', formatP(p), pCaption(v)) : null,
    v.p_value_sequential !== null ? stat('Always-valid p', formatP(v.p_value_sequential), 'safe to peek') : null,
    v.variance_reduction !== null ? stat('Variance cut', formatPercent(v.variance_reduction), 'CUPED') : null,
  ].filter(Boolean));

  const node = card({
    description: `${v.variant} vs ${model.control}`,
    title: headline,
    titleClass: 'card-title card-title-stat',
    subline,
    action: verdictBadge(v),
  }, e ? content : null, stats);
  node.classList.add('ab-card');
  return node;
}

/** A cell of the variants table: its figure, with an optional caption under it. */
function abCell(area, main, ...captions) {
  const node = el('div', `ab-cell ab-${area}`);
  node.append(main instanceof Node ? main : el('span', 'ab-main', main));
  for (const c of captions) if (c) node.append(el('span', 'ab-caption', c));
  return node;
}

/** Several variants against one control: one card, a row per group, the intervals on one axis. */
function experimentTable({ model, confidenceLabel, verdictBadge, value, size, fmtOf, absolute, pCaption, evidence }) {
  const k = model.variants.length;
  const withEffect = model.variants.filter((v) => v.effect);
  // one axis serves every row only when every interval is in the same unit
  const units = new Set(withEffect.map((v) => v.effect.unit));
  const sharedAxis = withEffect.length > 0 && units.size === 1;

  const table = el('div', 'ab-table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', `${k} variants against ${model.control}`);

  const head = el('div', 'ab-row ab-head');
  head.setAttribute('role', 'row');
  for (const [area, text] of [['group', 'Group'], ['value', model.metric_label], ['lift', 'Lift'], ['plot', `${confidenceLabel} interval`.trim()], ['result', 'Result']]) {
    const h = el('div', `ab-cell ab-${area}`, text);
    h.setAttribute('role', 'columnheader');
    head.append(h);
  }
  table.append(head);

  const row = (className, ...cells) => {
    const node = el('div', `ab-row ${className}`);
    node.setAttribute('role', 'row');
    for (const c of cells) c.setAttribute('role', 'cell');
    node.append(...cells);
    table.append(node);
  };

  // the control: the baseline every lift below is measured from
  const controlValue = model.variants.find((v) => v.control_value !== null)?.control_value ?? null;
  const nControl = model.variants[0]?.n_control ?? null;
  row('ab-control',
    abCell('group', model.control, size(nControl)),
    abCell('value', value(controlValue)),
    abCell('lift', el('span', 'ab-caption', 'baseline')),
    abCell('plot', el('span')),
    abCell('result', badge('Control', 'secondary')),
  );

  for (const v of model.variants) {
    const e = v.effect;
    const fmt = fmtOf(e);
    const p = v.p_value_adjusted ?? v.p_value;
    const lift = e ? fmt(e.point) : v.lift === null ? '—' : formatSignedNumber(v.lift);
    const plot = e ? intervalPlot(v, model.scale, fmt, confidenceLabel, { axis: !sharedAxis }) : el('span', 'ab-caption', 'no interval');
    row(`ab-variant${v.outcome === 'better' ? ' ab-better' : v.outcome === 'worse' ? ' ab-worse' : ''}`,
      abCell('group', v.variant, size(v.n_variant)),
      abCell('value', value(v.variant_value)),
      abCell('lift', lift, v.lift !== null && e?.unit === 'relative' ? `${absolute(v.lift)} absolute` : null),
      abCell('plot', plot, e ? `CI ${fmt(e.lo)} to ${fmt(e.hi)}` : null),
      abCell('result', verdictBadge(v),
        evidence(v, fmt),
        p !== null ? `p ${formatP(p)}${pCaption(v) ? ` · ${pCaption(v)}` : ''}` : null,
        v.p_value_sequential !== null ? `always-valid p ${formatP(v.p_value_sequential)}` : null,
        v.variance_reduction !== null ? `CUPED cut variance ${formatPercent(v.variance_reduction)}` : null),
    );
  }

  if (sharedAxis) {
    const foot = el('div', 'ab-row ab-foot');
    foot.setAttribute('aria-hidden', 'true');
    const e = withEffect[0].effect;
    foot.append(el('div', 'ab-cell ab-group'), el('div', 'ab-cell ab-value'), el('div', 'ab-cell ab-lift'), abCell('plot', intervalAxis(model.scale, e.unit, fmtOf(e))), el('div', 'ab-cell ab-result'));
    table.append(foot);
  }

  const content = el('div', 'card-content');
  content.append(table);
  // the verdict in one line, in the words of the rows: better, worse, inconclusive
  const count = (o) => model.variants.filter((v) => v.outcome === o).length;
  const verdictLine = [['better', 'better'], ['worse', 'worse'], ['no_difference', 'inconclusive']]
    .map(([o, word]) => [count(o), word]).filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(' · ');
  const node = card({
    description: `${k} variants vs ${model.control}`,
    title: model.split?.detected ? 'No verdict · the split is not the designed one' : verdictLine,
  }, content);
  node.classList.add('ab-card', 'ab-multi');
  return node;
}

// ── funnel ────────────────────────────────────────────────────────────────────────────────────
//
// One card: the overall conversion as the headline, then the steps in order — each with its count,
// its share of the first step and a bar of that share; between two steps, the share that carried
// on, and the step that lost the most is marked.

function renderFunnel(model) {
  const n = model.steps.length;
  const first = model.steps[0];
  const last = model.steps[n - 1];
  setDescription(badge(`${n} steps`, 'secondary'), model.measure ? badge(model.measure, 'outline') : null);

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
    head.append(
      el('span', 'funnel-index', String(i + 1)),
      el('span', 'funnel-label', step.label),
      el('span', 'funnel-value', formatNumber(step.value)),
      el('span', 'funnel-share', formatShare(step.of_first)),
    );
    const track = el('div', 'funnel-track');
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `${step.label}: ${formatShare(step.of_first)} of ${first.label}`);
    const fill = el('div', 'funnel-fill');
    fill.style.width = `${Math.max(0.5, step.of_first * 100).toFixed(2)}%`;
    track.append(fill);
    item.append(head, track);
    list.append(item);
  });

  const content = el('div', 'card-content');
  content.append(list);
  cardsSection.className = 'ab-list';
  cardsSection.append(card({
    description: 'Overall conversion',
    title: formatShare(model.overall),
    titleClass: 'card-title card-title-stat',
    subline: `${formatNumber(first.value)} → ${formatNumber(last.value)} · ${first.label} → ${last.label}`,
  }, content));
  cardsSection.hidden = false;
}

// ── A/B: the sample-ratio check and the sample-size plan — the steps before the test ──────────

/** The observed split as one bar of segments, with the INTENDED boundaries marked on it. */
function splitBar(groups) {
  const bar = el('div', 'split-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', groups.map((g) => `${g.label} ${formatShare(g.observed_share)} (expected ${formatShare(g.expected_share)})`).join(', '));
  groups.forEach((g, i) => {
    const seg = el('div', 'split-segment');
    seg.style.flexGrow = String(Math.max(0, g.observed_share ?? 0));
    seg.style.backgroundColor = seriesColor(i);
    seg.title = `${g.label}: ${formatShare(g.observed_share)} observed, ${formatShare(g.expected_share)} expected`;
    bar.append(seg);
  });
  let at = 0;
  for (const g of groups.slice(0, -1)) {
    at += g.expected_share ?? 0;
    const mark = el('div', 'split-marker');
    mark.style.left = `${(at * 100).toFixed(3)}%`;
    bar.append(mark);
  }
  return bar;
}

function renderSrm(model) {
  setDescription(
    model.p_value !== null ? badge(model.p_value < 0.001 ? 'p < 0.001' : `p = ${model.p_value.toFixed(3)}`, 'outline') : null,
    badge(`${integerFormat.format(model.total)} users`, 'outline'),
  );
  const content = el('div', 'card-content');
  const legend = el('p', 'split-legend', 'Bars: the observed split · dashed marks: the intended one');
  content.append(splitBar(model.groups), legend);
  const stats = el('dl', 'stat-grid');
  model.groups.forEach((g, i) => {
    const node = stat(g.label, formatShare(g.observed_share), `${integerFormat.format(g.observed ?? 0)} users · expected ${formatShare(g.expected_share)}`);
    const swatch = el('span', 'chart-indicator');
    swatch.style.backgroundColor = seriesColor(i);
    node.querySelector('.stat-label').prepend(swatch);
    stats.append(node);
  });
  cardsSection.className = 'ab-list';
  const node = card({
    description: 'Observed split vs the intended one',
    title: model.srm_detected ? 'Mismatch' : 'Healthy',
    titleClass: 'card-title card-title-stat',
    subline: model.srm_detected ? 'The split is off: randomization or logging is broken, so no lift from this test can be trusted.' : 'The split matches the intended one: the test result can be read.',
    action: model.srm_detected ? badge('Do not trust the lift', 'destructive', 'circle-x') : badge('Split is sound', 'success', 'circle-check'),
  }, content, stats);
  cardsSection.append(node);
  cardsSection.hidden = false;
}

function renderPlan(model) {
  const isRate = model.metric === 'proportion';
  const effect = (v) => (v === null ? '—' : isRate ? formatPoints(v) : formatSignedNumber(v));
  setDescription(
    model.power !== null ? badge(`${Math.round(model.power * 100)}% power`, 'outline') : null,
    model.confidence !== null ? badge(`${Math.round(model.confidence * 100)}% confidence`, 'outline') : null,
    model.alternative && model.alternative !== 'two_sided' ? badge(`one-sided · ${model.alternative}`, 'outline') : null,
  );
  const base = isRate ? (model.baseline !== null ? `a ${formatPercent(model.baseline)} baseline` : null) : (model.stddev !== null ? `a standard deviation of ${formatNumber(model.stddev)}` : null);
  const head = model.solved === 'n'
    ? { description: 'Users needed per group', title: integerFormat.format(model.n_per_group ?? 0), subline: [model.total_n !== null ? `${integerFormat.format(model.total_n)} in total` : null, `to detect ${effect(model.mde)}${base ? ` on ${base}` : ''}`].filter(Boolean).join(' · ') }
    : { description: 'Smallest effect this test can detect', title: effect(model.mde), subline: [`with ${integerFormat.format(model.n_per_group ?? 0)} users per group`, base ? `on ${base}` : null].filter(Boolean).join(' · ') };
  const stats = el('dl', 'stat-grid');
  stats.append(...[
    isRate ? stat('Baseline', formatPercent(model.baseline)) : stat('Std deviation', formatNumber(model.stddev)),
    stat('Detectable effect', effect(model.mde), model.relative_mde !== null ? `${formatSignedPercent(model.relative_mde)} relative` : null),
    model.power !== null ? stat('Power', `${Math.round(model.power * 100)}%`, 'chance to see a real effect') : null,
    model.confidence !== null ? stat('Confidence', `${Math.round(model.confidence * 100)}%`) : null,
  ].filter(Boolean));
  cardsSection.className = 'ab-list';
  cardsSection.append(card({ ...head, titleClass: 'card-title card-title-stat' }, stats));
  cardsSection.hidden = false;
}

/** The server's advice is for whoever acts next — kept, but folded under the result. */
function showNotes(notes) {
  if (!notes?.length) return;
  notesList.replaceChildren(...notes.map((n) => el('li', null, n)));
  notesEl.hidden = false;
}

// ── display mode ──────────────────────────────────────────────────────────────────────────────

/**
 * The container's size decides the layout, never a width baked in here. A FIXED height (fullscreen,
 * or a host that pins it) switches to the fill layout — the view takes the frame and its cards scroll
 * inside it; a flexible height lets the content size the iframe (the App reports it).
 */
function applyContainer(ctx) {
  const dims = ctx.containerDimensions;
  // a BOOLEAN: classList.toggle(token, undefined) does not switch the class off — it flips it, so a
  // host that sends no containerDimensions would put the view into the fixed-height layout
  const fixedHeight = !!(dims && 'height' in dims && typeof dims.height === 'number');
  mainEl.classList.toggle('fill', state.displayMode === 'fullscreen' || fixedHeight);
  document.documentElement.style.maxHeight = dims && 'maxHeight' in dims && dims.maxHeight ? `${dims.maxHeight}px` : '';
}

function updateFullscreenButton() {
  const modes = app.getHostContext()?.availableDisplayModes ?? [];
  const isFullscreen = state.displayMode === 'fullscreen';
  // offered only where the host can do it — the same rule as the official map and PDF views
  fullscreenBtn.hidden = !modes.includes(isFullscreen ? 'inline' : 'fullscreen');
  fullscreenBtn.replaceChildren(icon(isFullscreen ? 'minimize-2' : 'maximize-2'));
  const label = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
  fullscreenBtn.title = label;
  fullscreenBtn.setAttribute('aria-label', label);
}

async function toggleFullscreen() {
  const mode = state.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  if (!app.getHostContext()?.availableDisplayModes?.includes(mode)) return;
  try {
    const result = await app.requestDisplayMode({ mode });
    // the host answers with the mode it actually applied; the context change follows it
    handleHostContextChanged({ displayMode: result.mode });
  } catch (e) {
    log.error('Display mode change failed:', e);
  }
}

fullscreenBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.displayMode === 'fullscreen') {
    e.preventDefault();
    void toggleFullscreen();
  }
});

// ── host context ──────────────────────────────────────────────────────────────────────────────

function handleHostContextChanged(ctx) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (ctx.safeAreaInsets) {
    // the host's insets ADD to the view's own padding (the CSS reads them) — setting them as the
    // padding would put the content flush against a frame the host rounds, where it gets clipped
    const root = document.documentElement.style;
    for (const side of ['top', 'right', 'bottom', 'left']) root.setProperty(`--safe-${side}`, `${Number(ctx.safeAreaInsets[side]) || 0}px`);
  }
  if (ctx.toolInfo?.tool?.name) {
    state.toolName = ctx.toolInfo.tool.name;
  }
  if (ctx.displayMode) {
    state.displayMode = ctx.displayMode;
  }
  if (ctx.displayMode || ctx.containerDimensions) {
    applyContainer({ ...app.getHostContext(), ...ctx });
  }
  if (ctx.displayMode || ctx.availableDisplayModes) {
    updateFullscreenButton();
  }
  // colors come from CSS variables: a theme change re-draws the chart in the new ones
  if ((ctx.theme || ctx.styles) && state.chart && state.current) {
    show(state.current); // the view on screen — a drilled one stays where it is
  }
}

// 1. Create app instance
const app = new App({ name: 'Query Result', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });

// 2. Register handlers BEFORE connecting
app.onteardown = async () => {
  state.chart?.destroy();
  return {};
};

app.ontoolinput = (params) => {
  state.toolInput = params.arguments ?? null;
};

app.ontoolresult = (result) => {
  render(result);
};

app.ontoolcancelled = () => {
  // a cancelled call has no result to draw
  loadingEl.hidden = true;
  statusEl.replaceChildren(icon('circle-x'), el('span', null, 'The call was cancelled.'));
  statusEl.hidden = false;
  resetSections();
  mainEl.hidden = true;
};

app.onerror = log.error;

app.onhostcontextchanged = handleHostContextChanged;

// 3. Connect to host
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
