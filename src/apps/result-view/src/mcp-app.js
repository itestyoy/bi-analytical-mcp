/**
 * @file Query Result view — the cards inside the host's conversation: a CHART (a line or multi-line,
 * a stacked area, grouped/stacked/horizontal bars, a donut of shares or a sankey of flows, its rows
 * folded underneath as a data table with filter and sorting), KPI TILES (a headline number, its
 * change, a sparkline), a FUNNEL (steps, conversion, the biggest drop) and the A/B
 * family (the test, the split check, the sample-size plan). Any other result gets one status line.
 *
 * IT DRAWS, AND FOLLOWS ITS OWN QUERY. The input is the tool result the host delivers
 * (ontoolresult). The one thing it asks for is the rest of that result: a query that outlasted its
 * call answers { status: 'running', query_id }, and the card polls get_query_result for that
 * query_id (followQuery) until the rows are there, then draws them in place. Nothing else: no other
 * tool, no resource, no message to the model, no link — and no network at all (the page's CSP, and
 * the resource's declared `csp`). Everything interactive here —
 * sorting, filtering, the legend, fullscreen — works on the data already in the page or on the
 * host's own frame.
 *
 * WHAT to show is decided by buildViewModel (src/apps/result-view-model.js), a pure function the
 * unit tests run in node on real tool results; this file only draws it. Structure follows the
 * official MCP Apps templates: handlers are registered on the App before connect(), the host's
 * theme, style variables and fonts are applied on connect and on every context change. The pieces
 * it draws are shadcn/ui components (Card, Badge, Button, Input, Table, Alert, Accordion, Chart),
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
import { buildViewModel } from '../../result-view-model.js';
import { icon } from './icons.js';
import './global.css';
import './mcp-app.css';

// Only the pieces this view draws — Chart.js is tree-shakable, and the whole view ships in one file
Chart.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Flow, LinearScale, LineController, LineElement, PointElement, SankeyController, Tooltip);

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
const dataLabel = document.getElementById('data-label');
const filterInput = document.getElementById('filter');
const tableCount = document.getElementById('table-count');
const tableEl = document.getElementById('table');
const notesEl = document.getElementById('notes');
const notesList = document.getElementById('notes-list');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');

// static icons
document.getElementById('filter-icon').append(icon('search'));
document.getElementById('notes-chevron').append(icon('chevron-down'));
document.getElementById('data-chevron').append(icon('chevron-down'));
document.getElementById('loading-icon').append(icon('loader-circle', 'icon spin'));

// App state
const state = {
  toolName: null,
  toolInput: null,
  lastResult: null,
  model: null,
  chart: null,
  sort: null, // { index, dir: 1 | -1 }
  follow: 0, // bumps on every new result, so a stale poll loop stops
  filter: '',
  displayMode: 'inline',
};

// ── formatting ────────────────────────────────────────────────────────────────────────────────

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 1000) return integerFormat.format(n);
  if (n !== 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
  return numberFormat.format(n);
}

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

const formatShare = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const formatSignedNumber = (v) => `${sign(v)}${formatNumber(Math.abs(v))}`;
const formatP = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text; // data goes in as text, never as markup
  return node;
}

function badge(text, variant = 'outline', iconName = null) {
  const node = el('span', `badge badge-${variant}`);
  if (iconName) node.append(icon(iconName));
  node.append(document.createTextNode(text));
  return node;
}

/** shadcn Card: header (description, title, optional action) and any content blocks. */
function card({ title, description, action, subline, titleClass = 'card-title' }, ...content) {
  const node = el('article', 'card');
  const header = el('div', 'card-header');
  if (description !== undefined) header.append(el('p', 'card-description', description));
  header.append(title instanceof Node ? title : el('p', titleClass, title));
  if (action) {
    const a = el('div', 'card-action');
    a.append(action);
    header.append(a);
  }
  if (subline) header.append(el('p', 'card-description card-subline', subline));
  node.append(header);
  for (const c of content) if (c) node.append(c);
  return node;
}

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

const CARDS = { chart: (m) => renderChartResult(m), kpi: (m) => renderKpi(m), funnel: (m) => renderFunnel(m), experiment: (m) => renderExperiment(m), srm: (m) => renderSrm(m), plan: (m) => renderPlan(m) };

function render(result) {
  loadingEl.hidden = true; // the result is here: the spinner's job is done, whatever is drawn next
  const model = buildViewModel(state.toolName, payloadOf(result), state.toolInput);
  state.model = model;
  resetSections();
  const draw = CARDS[model.kind];
  mainEl.hidden = !draw;
  statusEl.hidden = !!draw;
  if (!draw) {
    const following = model.reason === 'running' && model.query_id && canFollow();
    showStatus(following ? { ...model, reason: 'following' } : model);
    if (following) followQuery(model.query_id);
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

// ── following a detached query to its rows ───────────────────────────────────────────────────

const FOLLOW_EVERY_MS = 3000;
const FOLLOW_FOR_MS = 30 * 60 * 1000; // a detached result is kept for an hour; half of it is plenty

/** Whether the host proxies a view's tools/call at all — without it the card stays a hand-off. */
const canFollow = () => !!app.getHostCapabilities()?.serverTools;

/**
 * Poll get_query_result for THIS card's query_id until it is no longer running, then draw what came
 * back in place of the status line. The only server call the view makes. A newer result, teardown,
 * a refused call or the time limit ends the loop; the card then says the result comes separately.
 */
async function followQuery(queryId) {
  const token = ++state.follow;
  const until = Date.now() + FOLLOW_FOR_MS;
  const handOff = () => { if (token === state.follow) showStatus({ reason: 'running' }); };
  while (token === state.follow) {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_EVERY_MS));
    if (token !== state.follow) return;
    if (Date.now() > until) { handOff(); return; }
    let next;
    try {
      next = await app.callServerTool({ name: 'get_query_result', arguments: { query_id: queryId } });
    } catch (e) {
      log.error('following the query failed', e);
      handOff();
      return;
    }
    if (token !== state.follow) return;
    if (payloadOf(next)?.status === 'running') continue;
    state.follow++; // this loop is done; the result below may not start another one for the same id
    state.lastResult = next;
    render(next);
    return;
  }
}

/** The one line a result without a card gets — what happened, and that the reply carries the rest. */
function showStatus(model) {
  const lines = {
    // the card is following its query: this line is replaced by the result when it is ready
    following: ['loader-circle', 'Running in the warehouse…', 'icon spin'],
    // a detached query the card cannot follow (the host proxies no tools/call, or following ended):
    // a HAND-OFF, not a live state, so no spinner — the rows arrive through the model's own
    // get_query_result call, which draws its own card
    running: ['clock', 'The result comes in a separate card'],
    error: ['circle-alert', 'Error'],
  };
  const [name, text, cls] = lines[model.reason] || ['info', 'Nothing to chart'];
  statusEl.replaceChildren(icon(name, cls), el('span', null, text));
  statusEl.classList.toggle('status-line-error', model.reason === 'error');
}

function renderChartResult(model) {
  setDescription(
    badge(`${formatNumber(model.row_count)} row${model.row_count === 1 ? '' : 's'}`, 'secondary'),
    model.sampled ? badge('random sample', 'outline') : null,
    model.approximate ? badge('approximate', 'outline') : null,
  );
  renderChart(model.chart, model.chart.y || 'Series');
  renderTable(model);
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
        scales: chart.area
          ? { x: common.scales.x, y: { ...common.scales.y, stacked: !!chart.stacked } }
          : { ...common.scales, y: { ...common.scales.y, beginAtZero: false, grace: '5%' } },
      },
    });
    chartDescriptionEl.textContent = `${labels.length} points · ${chart.series.length} series`;
    chartCanvas.setAttribute('aria-label', `${title}: ${chart.series.length} series over ${labels.length} points`);
    if (chart.series.length > 1) drawLegend();
    if (chart.folded) showAlert({ title: `${chart.folded} smaller series are in the table only`, description: 'The chart keeps the largest series readable; every row is in the table below.' });
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
      type: 'sankey',
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
          borderWidth: 0,
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
  const allLabels = chart.labels || chart.bars.map((b) => b.label);
  const labels = allLabels.slice(0, 30);
  const horizontal = typeof chart.horizontal === 'boolean' ? chart.horizontal : allLabels.length > 8;
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
      indexAxis: horizontal ? 'y' : 'x',
      scales: horizontal
        ? { x: { ...common.scales.y, stacked }, y: { ...common.scales.x, stacked } }
        : { x: { ...common.scales.x, stacked }, y: { ...common.scales.y, stacked } },
    },
  });
  const count = allLabels.length > labels.length ? `top ${labels.length} of ${allLabels.length}` : `${labels.length} ${labels.length === 1 ? 'bar' : 'bars'}`;
  chartDescriptionEl.textContent = series.length > 1 ? `${count.replace(/bars?$/, labels.length === 1 ? 'category' : 'categories')} · ${series.length} series${stacked ? ', stacked' : ''}` : count;
  chartCanvas.setAttribute('aria-label', `${title}: ${labels.length} categories${series.length > 1 ? `, ${series.length} series` : ''}`);
  if (series.length > 1) drawLegend();
  if (chart.folded) showAlert({ title: `${chart.folded} smaller series are in the table only`, description: 'The chart keeps the largest series readable; every row is in the table below.' });
}

/** shadcn ChartTooltipContent, drawn as HTML next to the canvas. */
function drawTooltip({ chart, tooltip }) {
  if (tooltip.opacity === 0 || !tooltip.dataPoints?.length) {
    chartTooltip.hidden = true;
    return;
  }
  const items = el('div', 'chart-tooltip-items');
  const slice = chart.config.type === 'doughnut';
  if (chart.config.type === 'sankey') {
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

// ── data table (shadcn data-table: filter input, sortable headers, count + pager footer) ──────

function renderTable(model) {
  dataLabel.textContent = `Data · ${integerFormat.format(model.rows.length)} row${model.rows.length === 1 ? '' : 's'}`;
  filterInput.value = state.filter;
  drawRows(model);
}

function drawRows(model) {
  const q = state.filter.trim().toLowerCase();
  const rows = q ? model.rows.filter((r) => r.some((v) => v !== null && String(v).toLowerCase().includes(q))) : model.rows.slice();
  if (state.sort && state.sort.index < model.columns.length) {
    const { index, dir } = state.sort;
    const numeric = model.columns[index].type === 'number';
    rows.sort((a, b) => {
      const x = a[index];
      const y = b[index];
      if (x === null) return 1;
      if (y === null) return -1;
      return dir * (numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y)));
    });
  }

  const head = document.createElement('tr');
  model.columns.forEach((c, index) => {
    const th = el('th', c.type === 'number' ? 'num' : '');
    th.scope = 'col';
    const sorted = state.sort?.index === index;
    if (sorted) th.setAttribute('aria-sort', state.sort.dir > 0 ? 'ascending' : 'descending');
    const btn = el('button', 'btn btn-ghost btn-sm sort-btn');
    btn.type = 'button';
    btn.append(el('span', null, c.name), icon(sorted ? (state.sort.dir > 0 ? 'arrow-up' : 'arrow-down') : 'arrow-up-down'));
    btn.addEventListener('click', () => {
      state.sort = { index, dir: state.sort?.index === index ? -state.sort.dir : 1 };
      drawRows(model);
    });
    th.append(btn);
    head.append(th);
  });
  tableEl.tHead.replaceChildren(head);

  const timeLabels = model.columns.map((c, i) => (c.type === 'time' ? timeFormatter(model.rows.map((r) => r[i]).filter((v) => v !== null)) : null));
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'empty-cell', model.rows.length ? 'No rows match the filter.' : 'No rows.');
    td.colSpan = Math.max(1, model.columns.length);
    tr.append(td);
    tableEl.tBodies[0].replaceChildren(tr);
  } else {
    tableEl.tBodies[0].replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      r.forEach((v, i) => {
        const numeric = model.columns[i].type === 'number';
        const text = v === null ? 'null' : numeric ? formatNumber(v) : timeLabels[i] ? timeLabels[i](v) : String(v);
        tr.append(el('td', [numeric ? 'num' : '', v === null ? 'null' : ''].filter(Boolean).join(' '), text));
      });
      return tr;
    }));
  }

  const offset = model.page?.offset ?? 0;
  const range = model.rows.length ? `Rows ${integerFormat.format(offset + 1)}–${integerFormat.format(offset + model.rows.length)}` : 'No rows';
  tableCount.textContent = q ? `${integerFormat.format(rows.length)} of ${integerFormat.format(model.rows.length)} rows match` : range;
}

filterInput.addEventListener('input', () => {
  state.filter = filterInput.value;
  if (state.model?.columns) drawRows(state.model);
});

// ── A/B result ────────────────────────────────────────────────────────────────────────────────
//
// A stat card per variant (shadcn dashboard "section cards"): the comparison as the description,
// the lift as the headline, the verdict as the badge; the interval plot as the content; the key
// figures in a divided grid at the foot. All variants share one interval scale, so the stacked
// cards compare at a glance.

const VERDICTS = {
  increase: { icon: 'trending-up', text: 'Significant increase', variant: 'accent' },
  decrease: { icon: 'trending-down', text: 'Significant decrease', variant: 'accent' },
  no_difference: { icon: 'minus', text: 'Not significant', variant: 'outline' },
};

function stat(label, value, caption) {
  const node = el('div', 'stat');
  node.append(el('dt', 'stat-label', label), el('dd', 'stat-value', value));
  if (caption) node.append(el('dd', 'stat-caption', caption));
  return node;
}

/** The effect's interval on the shared scale: a range bar, the point estimate, the no-effect line. */
function intervalPlot(v, scale, fmt, confidenceLabel) {
  const e = v.effect;
  const pos = (x) => `${(50 + (Math.max(-scale, Math.min(scale, x)) / scale) * 50).toFixed(2)}%`;
  const plot = el('div', `ci-plot${v.significant ? ' ci-significant' : ''}`);
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', `${confidenceLabel} interval ${fmt(e.lo)} to ${fmt(e.hi)}, estimate ${fmt(e.point)}; zero means no effect`);
  const track = el('div', 'ci-track');
  const range = el('div', 'ci-range');
  range.style.left = pos(e.lo);
  range.style.right = `calc(100% - ${pos(e.hi)})`;
  range.title = `${confidenceLabel} CI ${fmt(e.lo)} … ${fmt(e.hi)}`;
  const point = el('div', 'ci-point');
  point.style.left = pos(e.point);
  point.title = `estimate ${fmt(e.point)}`;
  track.append(el('div', 'ci-zero'), range, point);
  const tick = e.unit === 'relative' ? (x) => formatSignedPercent(x, Number.isInteger(Math.round(x * 1e6) / 1e4) ? 0 : 1) : fmt;
  const axis = el('div', 'ci-axis');
  axis.append(el('span', null, tick(-scale)), el('span', null, 'no effect'), el('span', null, tick(scale)));
  plot.append(track, axis);
  return plot;
}

function renderExperiment(model) {
  const confidenceLabel = model.confidence !== null ? `${Math.round(model.confidence * 100)}%` : '';
  const k = model.variants.length;
  setDescription(
    confidenceLabel ? badge(`${confidenceLabel} confidence`, 'outline') : null,
    model.alternative && model.alternative !== 'two_sided' ? badge(`one-sided · ${model.alternative}`, 'outline') : null,
    model.correction ? badge(`${correctionName(model.correction)} correction`, 'outline') : null,
    k > 1 ? badge(`${model.significant_count} of ${k} significant`, model.significant_count ? 'accent' : 'secondary') : null,
  );

  const isRate = model.metric === 'proportion';
  const value = (x) => (x === null ? '—' : isRate ? formatPercent(x) : formatNumber(x));
  const size = (n) => (n === null ? null : `${integerFormat.format(n)} users`);

  cardsSection.className = 'ab-list';
  for (const v of model.variants) {
    const e = v.effect;
    const fmt = e?.unit === 'relative' ? (x) => formatSignedPercent(x) : isRate ? formatPoints : formatSignedNumber;
    const verdict = VERDICTS[v.verdict];

    const headline = e ? fmt(e.point) : v.lift === null ? '—' : formatSignedNumber(v.lift);
    const subline = [
      v.lift !== null && e?.unit === 'relative' ? `${isRate ? formatPoints(v.lift) : formatSignedNumber(v.lift)} absolute` : null,
      e ? `${confidenceLabel} CI ${fmt(e.lo)} to ${fmt(e.hi)}` : null,
    ].filter(Boolean).join(' · ');

    const content = el('div', 'card-content');
    if (e) content.append(intervalPlot(v, model.scale, fmt, confidenceLabel));

    const p = v.p_value_adjusted ?? v.p_value;
    const rawDiffers = v.p_value_adjusted !== null && v.p_value !== null && formatP(v.p_value_adjusted) !== formatP(v.p_value);
    const stats = el('dl', 'stat-grid');
    stats.append(...[
      stat(model.control, value(v.control_value), size(v.n_control)),
      stat(v.variant, value(v.variant_value), size(v.n_variant)),
      p !== null ? stat('p-value', formatP(p), v.p_value_adjusted !== null ? `${correctionName(model.correction)}-adjusted${rawDiffers ? ` · raw ${formatP(v.p_value)}` : ''}` : null) : null,
      v.p_value_sequential !== null ? stat('Always-valid p', formatP(v.p_value_sequential), 'safe to peek') : null,
      v.variance_reduction !== null ? stat('Variance cut', formatPercent(v.variance_reduction), 'CUPED') : null,
    ].filter(Boolean));

    const node = card({
      description: `${v.variant} vs ${model.control}`,
      title: headline,
      titleClass: 'card-title card-title-stat',
      subline,
      action: badge(verdict.text, verdict.variant, verdict.icon),
    }, e ? content : null, stats);
    node.classList.add('ab-card');
    cardsSection.append(node);
  }
  cardsSection.hidden = false;
  showNotes(model.notes);
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
    action: model.srm_detected ? badge('Do not trust the lift', 'destructive', 'circle-x') : badge('Split is sound', 'accent', 'circle-check'),
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
 * or a host that pins it) switches to the fill layout — the table takes the remaining space and
 * scrolls inside; a flexible height lets the content size the iframe (the App reports it).
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
  if ((ctx.theme || ctx.styles) && state.chart && state.lastResult) {
    render(state.lastResult);
  }
}

// 1. Create app instance
const app = new App({ name: 'Query Result', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });

// 2. Register handlers BEFORE connecting
app.onteardown = async () => {
  state.follow++; // stop following a query
  state.chart?.destroy();
  return {};
};

app.ontoolinput = (params) => {
  state.toolInput = params.arguments ?? null;
};

app.ontoolresult = (result) => {
  state.follow++; // a new result replaces whatever the card was following
  state.lastResult = result;
  render(result);
};

app.ontoolcancelled = () => {
  // a cancelled call has no result to draw
  state.follow++;
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
