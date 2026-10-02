// THE CHART — shadcn charts over Chart.js: a horizontal grid only, no axis or tick lines, an HTML
// tooltip and legend; the sankey's nodes drawn with rounded ends.

import { Chart } from 'chart.js';
import { Flow, SankeyController } from 'chartjs-chart-sankey';
import { el, formatNumber, formatShare } from '../../shared/ui.js';
import { chartSection, chartTitleEl, chartDescriptionEl, chartCanvas, chartTooltip, chartLegend, chartMenu, state } from './page.js';
import { timeFormatter, cssVar, seriesColor, withAlpha } from './format.js';
import { showAlert } from './blocks.js';
import { showFolded } from './render.js';
import { drillOptions, barDrill, sliceDrill, linePointDrill } from './drill.js';

/**
 * The sankey drawn with rounded corners, like every other mark here (bars, slices, tiles): the nodes'
 * ends and the four corners where a flow meets its nodes, all one radius. The plugin has neither, so
 * its geometry is kept as it is and only the shapes it paints are drawn rounded — the node
 * rectangles while it paints the nodes, the flow's outline while it paints a flow.
 */
export const SANKEY_RADIUS = 3;

export class RoundedFlow extends Flow {
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

export class RoundedSankeyController extends SankeyController {
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

export function renderChart(chart, title) {
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

/** shadcn ChartTooltipContent, drawn as HTML next to the canvas. */
export function drawTooltip({ chart, tooltip }) {
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

export function placeTooltip(chart, tooltip) {
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
export function drawLegend() {
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
export function drawSliceLegend(slices) {
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
export let tooltipTimer;

export function clearTooltip() {
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
export const hideSoon = () => { clearTimeout(tooltipTimer); tooltipTimer = setTimeout(clearTooltip, 1200); };
