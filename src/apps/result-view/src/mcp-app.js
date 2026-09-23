/**
 * @file Query Result view — renders the result of query_semantic_model, get_query_result and
 * experiment inside the host's conversation: a data table with filter, sorting and paging, a chart
 * when the rows are a time series or a breakdown, the A/B result as a stat card per variant, the
 * sample-ratio check, the sample-size plan.
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
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { buildViewModel } from '../../result-view-model.js';
import { icon } from './icons.js';
import './global.css';
import './mcp-app.css';

// Only the pieces this view draws — Chart.js is tree-shakable, and the whole view ships in one file
Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip);

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
const tableSection = document.getElementById('table-section');
const filterInput = document.getElementById('filter');
const tableCount = document.getElementById('table-count');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const tableEl = document.getElementById('table');
const rawSection = document.getElementById('raw-section');
const rawLabel = document.getElementById('raw-label');
const rawEl = document.getElementById('raw');
const copyBtn = document.getElementById('copy-btn');
const notesEl = document.getElementById('notes');
const notesList = document.getElementById('notes-list');
const fullscreenBtn = document.getElementById('fullscreen-btn');

// static icons
document.getElementById('filter-icon').append(icon('search'));
document.getElementById('notes-chevron').append(icon('chevron-down'));
copyBtn.append(icon('copy'));
prevPageBtn.prepend(icon('chevron-left'));
nextPageBtn.append(icon('chevron-right'));

// App state
const state = {
  toolName: null,
  toolInput: null,
  lastResult: null,
  model: null,
  chart: null,
  sort: null, // { index, dir: 1 | -1 }
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
const formatSignedNumber = (v) => `${sign(v)}${formatNumber(Math.abs(v))}`;
const formatP = (p) => (p < 0.001 ? '<0.001' : p.toFixed(3));
const pLabel = (p) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`);
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
function showAlert({ title, description, variant = 'default', iconName = 'info', spin = false }) {
  noticeEl.replaceChildren(icon(iconName, spin ? 'icon spin' : 'icon'), el('p', 'alert-title', title));
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
  for (const section of [noticeEl, chartSection, cardsSection, tableSection, rawSection, notesEl]) section.hidden = true;
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

function render(result) {
  const model = buildViewModel(state.toolName, payloadOf(result), state.toolInput);
  state.model = model;
  resetSections();
  titleEl.textContent = model.title;
  setDescription();

  switch (model.kind) {
    case 'running': {
      titleEl.textContent = 'Building the result';
      setDescription(badge('running', 'secondary'));
      const d = el('span', null, `${model.message} `);
      d.append(el('code', null, model.query_id));
      showAlert({ title: 'Working in the background', description: d, iconName: 'loader-circle', spin: true });
      break;
    }
    case 'error':
      titleEl.textContent = 'The call failed';
      if (model.stage) setDescription(badge(`stage: ${model.stage}`, 'outline'));
      showAlert({ title: model.stage ? `Failed at ${model.stage}` : 'Failed', description: model.message, variant: 'destructive', iconName: 'circle-alert' });
      break;
    case 'experiment':
      renderExperiment(model);
      break;
    case 'srm':
      renderSrm(model);
      break;
    case 'plan':
      renderPlan(model);
      break;
    case 'distribution':
      setDescription(
        model.distinct !== null ? badge(`${formatNumber(model.distinct)} distinct`, 'secondary') : null,
        model.total !== null ? badge(`${formatNumber(model.total)} rows`, 'secondary') : null,
      );
      renderChart({ type: 'bar', x: 'value', y: 'freq', bars: model.bars }, model.title);
      renderTable(model);
      break;
    case 'table':
      renderTableResult(model);
      break;
    case 'sql':
      renderCode('SQL', model.sql);
      break;
    default:
      renderCode('JSON', JSON.stringify(model.json, null, 2));
  }
}

function renderTableResult(model) {
  setDescription(
    badge(`${formatNumber(model.row_count)} row${model.row_count === 1 ? '' : 's'}`, 'secondary'),
    model.sampled ? badge('random sample', 'outline') : null,
    model.approximate ? badge('approximate', 'outline') : null,
  );
  if (model.chart) renderChart(model.chart, model.chart.y || 'Series');
  renderTable(model);
}

function renderCode(label, text) {
  rawLabel.textContent = label;
  rawEl.textContent = text;
  rawSection.hidden = false;
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(rawEl.textContent);
    copyBtn.replaceChildren(icon('check'));
    setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1500);
  } catch (e) {
    log.error('Copy failed:', e);
  }
});

// ── chart (shadcn charts: horizontal grid only, no axis or tick lines, HTML tooltip and legend) ─

function renderChart(chart, title) {
  chartTitleEl.textContent = chart.type === 'line' ? `${title} over ${chart.x}` : `${title} by ${chart.x}`;
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
    const labels = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p[0])))].sort();
    state.chart = new Chart(chartCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: chart.series.map((s, i) => {
          const byX = new Map(s.points);
          return {
            label: s.name,
            data: labels.map((x) => (byX.has(x) ? byX.get(x) : null)),
            borderColor: seriesColor(i),
            backgroundColor: seriesColor(i),
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
      options: common,
    });
    chartDescriptionEl.textContent = `${labels.length} points · ${chart.series.length} series`;
    chartCanvas.setAttribute('aria-label', `${title}: ${chart.series.length} series over ${labels.length} points`);
    if (chart.series.length > 1) drawLegend();
    if (chart.folded) showAlert({ title: `${chart.folded} smaller series are in the table only`, description: 'The chart keeps the largest series readable; every row is in the table below.' });
    return;
  }

  const horizontal = chart.bars.length > 8;
  const bars = chart.bars.slice(0, 30);
  state.chart = new Chart(chartCanvas, {
    type: 'bar',
    data: {
      labels: bars.map((b) => b.label),
      datasets: [{
        label: chart.y || 'value',
        data: bars.map((b) => b.value),
        backgroundColor: seriesColor(0),
        hoverBackgroundColor: seriesColor(0),
        borderRadius: 8,
        borderSkipped: 'start', // the data end is rounded, the baseline stays square
        maxBarThickness: 48,
      }],
    },
    options: {
      ...common,
      indexAxis: horizontal ? 'y' : 'x',
      scales: horizontal
        ? { x: { ...common.scales.y }, y: { ...common.scales.x } }
        : common.scales,
    },
  });
  chartDescriptionEl.textContent = chart.bars.length > bars.length ? `top ${bars.length} of ${chart.bars.length}` : `${bars.length} ${bars.length === 1 ? 'bar' : 'bars'}`;
  chartCanvas.setAttribute('aria-label', `${title}: ${bars.length} bars`);
}

/** shadcn ChartTooltipContent, drawn as HTML next to the canvas. */
function drawTooltip({ chart, tooltip }) {
  if (tooltip.opacity === 0 || !tooltip.dataPoints?.length) {
    chartTooltip.hidden = true;
    return;
  }
  const items = el('div', 'chart-tooltip-items');
  for (const p of tooltip.dataPoints) {
    const row = el('div', 'chart-tooltip-item');
    const swatch = el('span', 'chart-indicator');
    swatch.style.backgroundColor = p.dataset.borderColor || p.dataset.backgroundColor;
    const value = el('div', 'chart-tooltip-value');
    value.append(el('span', 'chart-tooltip-name', p.dataset.label), el('span', 'chart-tooltip-number', formatNumber(p.parsed[chart.options.indexAxis === 'y' ? 'x' : 'y'])));
    row.append(swatch, value);
    items.append(row);
  }
  chartTooltip.replaceChildren(el('div', 'chart-tooltip-label', tooltip.title?.[0] ?? ''), items);
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
    swatch.style.backgroundColor = ds.borderColor;
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

chartCanvas.addEventListener('mouseleave', () => { chartTooltip.hidden = true; });

// ── data table (shadcn data-table: filter input, sortable headers, count + pager footer) ──────

function renderTable(model) {
  tableSection.hidden = false;
  filterInput.value = state.filter;
  const canCall = !!app.getHostCapabilities()?.serverTools;
  nextPageBtn.hidden = !(model.nextPage && canCall);
  prevPageBtn.hidden = !(model.prevPage && canCall);
  nextPageBtn.disabled = false;
  prevPageBtn.disabled = false;
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
        tr.append(el('td', [numeric ? 'num' : '', v === null ? 'null' : ''].filter(Boolean).join(' '), v === null ? 'null' : numeric ? formatNumber(v) : String(v)));
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

async function goToPage(target, btn) {
  if (!target) return;
  btn.disabled = true;
  try {
    log.info('Fetching a page:', target.arguments);
    const result = await app.callServerTool(target);
    state.toolInput = target.arguments;
    state.lastResult = result;
    render(result);
  } catch (e) {
    log.error(e);
    btn.disabled = false;
    showAlert({ title: 'The page could not be fetched', description: e.message, variant: 'destructive', iconName: 'circle-alert' });
  }
}

nextPageBtn.addEventListener('click', () => goToPage(state.model?.nextPage, nextPageBtn));
prevPageBtn.addEventListener('click', () => goToPage(state.model?.prevPage, prevPageBtn));

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

/** The server's advice is for whoever acts next — kept, but folded under the result. */
function showNotes(notes) {
  if (!notes?.length) return;
  notesList.replaceChildren(...notes.map((n) => el('li', null, n)));
  notesEl.hidden = false;
}

// ── sample-ratio check, sample-size plan ──────────────────────────────────────────────────────

function renderSrm(model) {
  setDescription(badge(pLabel(model.p_value), 'outline'));
  cardsSection.className = 'card-grid';
  cardsSection.append(card({
    description: 'Observed split vs the expected one',
    title: model.srm_detected ? 'Mismatch' : 'Healthy',
    titleClass: 'card-title card-title-stat',
    action: model.srm_detected ? badge('Do not trust the lift', 'destructive', 'circle-x') : badge('Split is sound', 'outline', 'circle-check'),
  }));
  cardsSection.hidden = false;
  renderTable({ columns: [{ name: 'group', type: 'category' }, { name: 'observed', type: 'number' }, { name: 'expected', type: 'number' }], rows: model.groups.map((g) => [g.label, g.observed, g.expected]) });
}

function renderPlan(model) {
  cardsSection.className = 'card-grid';
  for (const f of model.figures) {
    cardsSection.append(card({ description: f.label, title: f.percent ? formatPercent(f.value) : formatNumber(f.value), titleClass: 'card-title card-title-stat' }));
  }
  cardsSection.hidden = false;
}

// ── display mode ──────────────────────────────────────────────────────────────────────────────

/**
 * The container's size decides the layout, never a width baked in here. A FIXED height (fullscreen,
 * or a host that pins it) switches to the fill layout — the table takes the remaining space and
 * scrolls inside; a flexible height lets the content size the iframe (the App reports it).
 */
function applyContainer(ctx) {
  const dims = ctx.containerDimensions;
  const fixedHeight = dims && 'height' in dims && typeof dims.height === 'number';
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
    mainEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
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
  state.chart?.destroy();
  return {};
};

app.ontoolinput = (params) => {
  state.toolInput = params.arguments ?? null;
};

app.ontoolresult = (result) => {
  state.lastResult = result;
  render(result);
};

app.ontoolcancelled = (params) => {
  showAlert({ title: 'The call was cancelled', description: params.reason || null, iconName: 'circle-x' });
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
