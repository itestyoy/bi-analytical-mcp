/**
 * @file Query Result view — renders the result of query_semantic_model, get_query_result and
 * experiment inside the host's conversation: a sortable, filterable table with paging, a chart
 * when the rows are a time series or a breakdown, the A/B result with its interval, the
 * sample-size plan.
 *
 * WHAT to show is decided by buildViewModel (src/apps/result-view-model.js), a pure function the
 * unit tests run in node on real tool results; this file only draws it. Structure follows the
 * official MCP Apps templates: handlers are registered on the App before connect(), the host's
 * theme, style variables and fonts are applied on connect and on every context change.
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
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { buildViewModel } from '../../result-view-model.js';
import './global.css';
import './mcp-app.css';

// Only the pieces this view draws — Chart.js is tree-shakable, and the whole view ships in one file
Chart.register(BarController, BarElement, CategoryScale, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip);

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
const chartCanvas = document.getElementById('chart');
const cardsSection = document.getElementById('cards-section');
const tableSection = document.getElementById('table-section');
const filterInput = document.getElementById('filter');
const nextPageBtn = document.getElementById('next-page-btn');
const tableEl = document.getElementById('table');
const rawEl = document.getElementById('raw');

// App state
const state = {
  toolName: null,
  toolInput: null,
  model: null,
  chart: null,
  sort: null, // { index, dir: 1 | -1 }
  filter: '',
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
const formatPoints = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)} pp`;

/**
 * A color variable RESOLVED to a concrete color — how the canvas chart picks up the host's theme.
 * The raw custom property can be `light-dark(…)` or a host token, which a canvas cannot paint;
 * the computed `color` of an element that uses it is always a plain rgb().
 */
const colorProbe = document.createElement('span');
colorProbe.hidden = true;
document.body.append(colorProbe);
function cssVar(name) {
  colorProbe.style.color = `var(${name})`;
  return getComputedStyle(colorProbe).color;
}
const seriesColor = (i) => cssVar(`--color-series-${(i % 6) + 1}`);

// ── rendering ─────────────────────────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // data goes in as text, never as markup
  return node;
}

function payloadOf(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function showNotice(message, { error = false } = {}) {
  noticeEl.textContent = message;
  noticeEl.classList.toggle('notice-error', error);
  noticeEl.hidden = false;
}

function resetSections() {
  for (const section of [noticeEl, chartSection, cardsSection, tableSection, rawEl]) section.hidden = true;
  cardsSection.replaceChildren();
  state.chart?.destroy();
  state.chart = null;
}

function render(result) {
  const model = buildViewModel(state.toolName, payloadOf(result), state.toolInput);
  state.model = model;
  resetSections();
  titleEl.textContent = model.title;
  subtitleEl.textContent = '';

  switch (model.kind) {
    case 'running':
      subtitleEl.textContent = `Building in the background (query_id ${model.query_id})`;
      showNotice(model.message);
      break;
    case 'error':
      subtitleEl.textContent = model.stage ? `Failed at ${model.stage}` : 'Failed';
      showNotice(model.message, { error: true });
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
      subtitleEl.textContent = [model.distinct !== null ? `${formatNumber(model.distinct)} distinct` : null, model.total !== null ? `${formatNumber(model.total)} rows` : null].filter(Boolean).join(' · ');
      renderChart({ type: 'bar', x: 'value', y: 'freq', bars: model.bars }, model.title);
      renderTable(model);
      break;
    case 'table':
      renderTableResult(model);
      break;
    case 'sql':
      rawEl.textContent = model.sql;
      rawEl.hidden = false;
      break;
    default:
      rawEl.textContent = JSON.stringify(model.json, null, 2);
      rawEl.hidden = false;
  }
}

function renderTableResult(model) {
  const bits = [`${formatNumber(model.row_count)} row${model.row_count === 1 ? '' : 's'}`];
  if (model.page) bits.push(`offset ${model.page.offset}`);
  if (model.sampled) bits.push('random sample');
  if (model.approximate) bits.push('approximate');
  subtitleEl.textContent = bits.join(' · ');
  if (model.chart) renderChart(model.chart, model.chart.y || 'Series');
  renderTable(model);
}

// ── chart ─────────────────────────────────────────────────────────────────────────────────────

function renderChart(chart, title) {
  chartTitleEl.textContent = chart.type === 'line' ? `${title} over ${chart.x}` : `${title} by ${chart.x}`;
  chartSection.hidden = false;
  const text = cssVar('--color-text-secondary');
  const grid = cssVar('--color-border-secondary');
  const common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: chart.type === 'line' && chart.series.length > 1, position: 'bottom', labels: { color: text, boxWidth: 10, boxHeight: 10 } },
      tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatNumber(item.parsed.y ?? item.parsed.x)}` } },
    },
    scales: {
      x: { ticks: { color: text, maxRotation: 0, autoSkip: true }, grid: { display: false } },
      y: { ticks: { color: text, callback: (v) => formatNumber(v) }, grid: { color: grid }, beginAtZero: true },
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
            pointRadius: labels.length <= 40 ? 3 : 0,
            pointHoverRadius: 4,
            tension: 0,
            spanGaps: true,
          };
        }),
      },
      options: common,
    });
    chartCanvas.setAttribute('aria-label', `${title}: ${chart.series.length} series over ${labels.length} points`);
    if (chart.folded) showNotice(`${chart.folded} smaller series are in the table, not the chart.`);
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
        borderRadius: 4,
        borderSkipped: 'start', // the data end is rounded, the baseline stays square
        maxBarThickness: 48,
      }],
    },
    options: {
      ...common,
      indexAxis: horizontal ? 'y' : 'x',
      plugins: { ...common.plugins, legend: { display: false } },
      scales: horizontal
        ? { x: { ...common.scales.y }, y: { ...common.scales.x } }
        : common.scales,
    },
  });
  chartCanvas.setAttribute('aria-label', `${title}: ${bars.length} bars`);
}

// ── table ─────────────────────────────────────────────────────────────────────────────────────

function renderTable(model) {
  tableSection.hidden = false;
  filterInput.value = state.filter;
  nextPageBtn.hidden = !(model.nextPage && app.getHostCapabilities()?.serverTools);
  nextPageBtn.disabled = false;
  nextPageBtn.textContent = 'Next page';
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
    const th = el('th', c.type === 'number' ? 'num' : '', c.name);
    th.scope = 'col';
    if (state.sort?.index === index) th.setAttribute('aria-sort', state.sort.dir > 0 ? 'ascending' : 'descending');
    th.addEventListener('click', () => {
      state.sort = { index, dir: state.sort?.index === index ? -state.sort.dir : 1 };
      drawRows(model);
    });
    head.append(th);
  });
  tableEl.tHead.replaceChildren(head);

  tableEl.tBodies[0].replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    r.forEach((v, i) => {
      const numeric = model.columns[i].type === 'number';
      tr.append(el('td', [numeric ? 'num' : '', v === null ? 'null' : ''].filter(Boolean).join(' '), v === null ? 'null' : numeric ? formatNumber(v) : String(v)));
    });
    return tr;
  }));
}

filterInput.addEventListener('input', () => {
  state.filter = filterInput.value;
  if (state.model?.columns) drawRows(state.model);
});

nextPageBtn.addEventListener('click', async () => {
  const next = state.model?.nextPage;
  if (!next) return;
  nextPageBtn.disabled = true;
  try {
    log.info('Fetching the next page:', next.arguments);
    const result = await app.callServerTool(next);
    state.toolInput = next.arguments;
    render(result);
  } catch (e) {
    log.error(e);
    nextPageBtn.disabled = false;
    showNotice(`The next page could not be fetched: ${e.message}`, { error: true });
  }
});

// ── cards: A/B result, sample-ratio check, sample-size plan ───────────────────────────────────

function card(label, value, ...details) {
  const node = el('article', 'card');
  node.append(el('p', 'card-label', label), el('p', 'card-value', value));
  for (const d of details) if (d) node.append(d instanceof Node ? d : el('p', 'card-detail', d));
  return node;
}

function status(kind, text) {
  return el('p', `status status-${kind}`, text);
}

/** The absolute-lift interval against the no-effect line, as a small inline SVG. */
function intervalSvg(ci) {
  if (!ci || ci[0] === null || ci[1] === null) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const W = 240;
  const H = 24;
  const span = Math.max(Math.abs(ci[0]), Math.abs(ci[1])) * 1.25 || 1;
  const X = (v) => W / 2 + (v / span) * (W / 2 - 6);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'interval');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `absolute lift interval ${formatPoints(ci[0])} to ${formatPoints(ci[1])}`);
  const line = (attrs) => { const n = document.createElementNS(NS, 'line'); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); };
  line({ x1: X(0), x2: X(0), y1: 2, y2: H - 2, stroke: cssVar('--color-text-tertiary'), 'stroke-dasharray': '2 2' });
  line({ x1: X(ci[0]), x2: X(ci[1]), y1: H / 2, y2: H / 2, stroke: seriesColor(0), 'stroke-width': 4, 'stroke-linecap': 'round' });
  return svg;
}

function renderExperiment(model) {
  subtitleEl.textContent = `confidence ${model.confidence !== null ? `${(model.confidence * 100).toFixed(0)}%` : '—'}${model.correction ? ` · ${model.correction} correction` : ''}`;
  const isRate = model.metric === 'proportion';
  const value = (v) => (isRate ? formatPercent(v) : formatNumber(v));
  for (const v of model.variants) {
    const lift = v.relative_lift !== null ? `${v.relative_lift >= 0 ? '+' : ''}${(v.relative_lift * 100).toFixed(1)}%` : formatNumber(v.lift);
    const p = v.p_value_adjusted ?? v.p_value;
    cardsSection.append(card(
      `${v.variant} vs ${model.control} · relative lift`,
      lift,
      v.relative_ci ? `interval ${formatPercent(v.relative_ci[0])} … ${formatPercent(v.relative_ci[1])}` : null,
      intervalSvg(v.ci),
      v.ci ? `absolute ${formatPoints(v.ci[0])} … ${formatPoints(v.ci[1])} (dashed line = no effect)` : null,
      `${value(v.control_value)} → ${value(v.variant_value)}`,
      status(v.significant ? 'good' : 'neutral', `${v.significant ? 'significant' : 'not significant'} · p = ${formatNumber(p)}`),
    ));
  }
  cardsSection.hidden = false;
  if (model.notes.length) showNotice(model.notes.join(' '));
}

function renderSrm(model) {
  subtitleEl.textContent = `p = ${formatNumber(model.p_value)}`;
  cardsSection.append(card('Sample-ratio check', model.srm_detected ? 'Mismatch' : 'Healthy',
    status(model.srm_detected ? 'bad' : 'good', model.srm_detected ? 'the split is broken — do not trust the lift' : 'the observed split matches the expected one')));
  cardsSection.hidden = false;
  renderTable({ columns: [{ name: 'group', type: 'category' }, { name: 'observed', type: 'number' }, { name: 'expected', type: 'number' }], rows: model.groups.map((g) => [g.label, g.observed, g.expected]) });
}

function renderPlan(model) {
  for (const f of model.figures) cardsSection.append(card(f.label, f.percent ? formatPercent(f.value) : formatNumber(f.value)));
  cardsSection.hidden = false;
}

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
  // colors come from CSS variables: a theme change re-draws the chart in the new ones
  if ((ctx.theme || ctx.styles) && state.chart && state.lastResult) {
    render(state.lastResult);
  }
}

// 1. Create app instance
const app = new App({ name: 'Query Result', version: '1.0.0' });

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
  showNotice(`The call was cancelled${params.reason ? `: ${params.reason}` : '.'}`);
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
