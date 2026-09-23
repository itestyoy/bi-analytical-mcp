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
const notesEl = document.getElementById('notes');
const notesList = document.getElementById('notes-list');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const expandIcon = document.getElementById('expand-icon');
const compressIcon = document.getElementById('compress-icon');

// App state
const state = {
  toolName: null,
  toolInput: null,
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
const formatPoints = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(2)} pp`;

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
  for (const section of [noticeEl, chartSection, cardsSection, tableSection, rawEl, notesEl]) section.hidden = true;
  cardsSection.replaceChildren();
  cardsSection.className = 'cards';
  notesList.replaceChildren();
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

/**
 * A card is one or more BLOCKS: the first carries the label and the headline value, the rest group
 * the details. A wide card lays the blocks side by side, a narrow one stacks them (CSS grid), so a
 * single card spanning the whole width does not leave its right half empty.
 */
function card(label, value, ...blocks) {
  const node = el('article', 'card');
  const [first = [], ...rest] = blocks;
  node.append(block(el('p', 'card-label', label), el('p', 'card-value', value), ...first));
  for (const b of rest) if (b.some(Boolean)) node.append(block(...b));
  return node;
}

function block(...details) {
  const node = el('div', 'card-block');
  for (const d of details) if (d) node.append(d instanceof Node ? d : el('p', 'card-detail', d));
  return node;
}

function status(kind, text) {
  return el('p', `status status-${kind}`, text);
}

// ── A/B result ────────────────────────────────────────────────────────────────────────────────
//
// Read top to bottom, each variant answers three questions in order: DID it change anything (the
// verdict, with an icon and words — never color alone), BY HOW MUCH (the lift and its interval, in
// one unit), and ON WHAT (the two groups' values and sizes). All variants share one interval scale,
// so a row further right is a larger effect.

const formatSignedPercent = (v, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`;
const correctionName = (c) => ({ holm: 'Holm', bh: 'Benjamini–Hochberg', bonferroni: 'Bonferroni' }[c] || c);
const formatP = (p) => (p < 0.001 ? '< 0.001' : p.toFixed(3));
const formatSignedNumber = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatNumber(Math.abs(v))}`;

const VERDICTS = {
  increase: { icon: '↑', text: 'Significant increase' },
  decrease: { icon: '↓', text: 'Significant decrease' },
  no_difference: { icon: '≈', text: 'No significant difference' },
};

function verdictChip(verdict) {
  const v = VERDICTS[verdict];
  const chip = el('span', `verdict verdict-${verdict}`);
  chip.append(el('span', 'verdict-icon', v.icon), el('span', null, v.text));
  return chip;
}

function figure(label, value, sub, { lead = false } = {}) {
  const node = el('div', lead ? 'figure figure-lead' : 'figure');
  node.append(el('p', 'figure-label', label), el('p', 'figure-value', value));
  if (sub) node.append(el('p', 'figure-sub', sub));
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
  const point = el('div', 'ci-point');
  point.style.left = pos(e.point);
  point.title = `estimate ${fmt(e.point)}`;
  range.title = `${confidenceLabel} interval ${fmt(e.lo)} … ${fmt(e.hi)}`;
  track.append(el('div', 'ci-zero'), range, point);
  const axis = el('div', 'ci-axis');
  const tick = e.unit === 'relative' ? (x) => formatSignedPercent(x, Number.isInteger(Math.round(x * 1e6) / 1e4) ? 0 : 1) : fmt;
  axis.append(el('span', null, tick(-scale)), el('span', 'ci-axis-zero', '0 · no effect'), el('span', null, tick(scale)));
  plot.append(track, axis);
  return plot;
}

function renderExperiment(model) {
  const confidenceLabel = model.confidence !== null ? `${Math.round(model.confidence * 100)}%` : '';
  const k = model.variants.length;
  subtitleEl.textContent = [
    `${confidenceLabel} confidence`.trim(),
    model.alternative && model.alternative !== 'two_sided' ? `one-sided (${model.alternative})` : null,
    model.correction ? `${correctionName(model.correction)} correction${k > 1 ? ` across ${k} variants` : ''}` : null,
  ].filter(Boolean).join(' · ');

  const isRate = model.metric === 'proportion';
  const value = (x) => (x === null ? '—' : isRate ? formatPercent(x) : formatNumber(x));
  const size = (n) => (n === null ? null : `n = ${integerFormat.format(n)}`);

  cardsSection.className = 'ab-list';
  if (k > 1) {
    const s = model.significant_count;
    cardsSection.append(el('p', 'ab-summary', s === 0
      ? `None of the ${k} variants differs significantly from ${model.control}.`
      : `${s} of ${k} variants differ${s === 1 ? 's' : ''} significantly from ${model.control}.`));
  }

  for (const v of model.variants) {
    const e = v.effect;
    const fmt = e?.unit === 'relative' ? (x) => formatSignedPercent(x) : isRate ? (x) => formatPoints(x) : formatSignedNumber;
    const node = el('article', `ab-card ab-card-${v.verdict}`);

    const header = el('header', 'ab-card-header');
    const name = el('h2', 'ab-card-title', v.variant);
    name.append(el('span', 'ab-card-vs', ` vs ${model.control}`));
    header.append(name, verdictChip(v.verdict));

    const figures = el('div', 'figures');
    const pair = el('div', 'figure-pair');
    pair.append(figure(model.control, value(v.control_value), size(v.n_control)), figure(v.variant, value(v.variant_value), size(v.n_variant)));
    figures.append(
      e
        ? figure(e.unit === 'relative' ? 'Relative lift' : 'Lift', fmt(e.point), `${confidenceLabel} CI ${fmt(e.lo)} to ${fmt(e.hi)}`, { lead: true })
        : figure('Lift', v.lift === null ? '—' : formatSignedNumber(v.lift), null, { lead: true }),
      pair,
    );

    node.append(header, figures);
    if (e) node.append(intervalPlot(v, model.scale, fmt, confidenceLabel));

    const p = v.p_value_adjusted ?? v.p_value;
    const meta = [
      p !== null ? `p ${p < 0.001 ? '' : '= '}${formatP(p)}${v.p_value_adjusted !== null && v.p_value !== null && formatP(v.p_value_adjusted) !== formatP(v.p_value) ? ` (${correctionName(model.correction)}-adjusted; raw ${formatP(v.p_value)})` : ''}` : null,
      v.p_value_sequential !== null ? `always-valid p ${v.p_value_sequential < 0.001 ? '' : '= '}${formatP(v.p_value_sequential)}` : null,
      e?.unit === 'relative' && v.lift !== null ? `absolute ${isRate ? formatPoints(v.lift) : formatSignedNumber(v.lift)}` : null,
      v.variance_reduction !== null ? `variance reduced by ${formatPercent(v.variance_reduction)}` : null,
    ].filter(Boolean);
    if (meta.length) node.append(el('p', 'ab-card-meta', meta.join(' · ')));
    cardsSection.append(node);
  }
  cardsSection.hidden = false;

  // the server's advice is for whoever acts next — kept, but folded under the result
  if (model.notes.length) {
    notesList.replaceChildren(...model.notes.map((n) => el('li', null, n)));
    notesEl.hidden = false;
  }
}

function renderSrm(model) {
  subtitleEl.textContent = `p = ${formatNumber(model.p_value)}`;
  cardsSection.append(card('Sample-ratio check', model.srm_detected ? 'Mismatch' : 'Healthy',
    [status(model.srm_detected ? 'bad' : 'good', model.srm_detected ? 'the split is broken — do not trust the lift' : 'the observed split matches the expected one')]));
  cardsSection.hidden = false;
  renderTable({ columns: [{ name: 'group', type: 'category' }, { name: 'observed', type: 'number' }, { name: 'expected', type: 'number' }], rows: model.groups.map((g) => [g.label, g.observed, g.expected]) });
}

function renderPlan(model) {
  for (const f of model.figures) cardsSection.append(card(f.label, f.percent ? formatPercent(f.value) : formatNumber(f.value)));
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
  // SVG elements have no `hidden` property — the attribute is what the stylesheet matches
  expandIcon.toggleAttribute('hidden', isFullscreen);
  compressIcon.toggleAttribute('hidden', !isFullscreen);
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
