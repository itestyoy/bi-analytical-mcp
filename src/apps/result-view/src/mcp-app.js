/**
 * @file Query Result view — the cards inside the host's conversation: a CHART (a line or multi-line,
 * a stacked area, grouped/stacked/horizontal bars, a donut of shares or a sankey of flows — the chart
 * alone, the only table is the pivot; a declared drill lets a click open a mark into a dimension, with
 * a breadcrumb and a back button), KPI TILES (a headline number, its
 * change, a sparkline), a PIVOT (a drill-down table, each level read when its row opens), a FUNNEL
 * (steps, conversion, the biggest drop) and the A/B test (each variant's lift and interval). Any
 * other result gets one status line.
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
 * unit tests run in node on real tool results; this view only draws it. This file wires the page —
 * the chart pieces registered, the controls' listeners, the App's handlers, the connect — and each
 * card draws in a file of its own (render.js picks it: chart.js with drill.js, kpi.js, pivot.js,
 * funnel.js, experiment.js; page.js holds the App, the elements and the state). Structure follows the
 * official MCP Apps templates: handlers are registered on the App before connect(), the host's
 * theme, style variables and fonts are applied on connect and on every context change. The pieces
 * it draws are shadcn/ui components (Card, Badge, Button, Table, Alert, Accordion, Chart),
 * styled in src/apps/shared/components.css.
 */
import { ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import { icon } from '../../shared/icons.js';
import { el } from '../../shared/ui.js';
import { toolInputOf } from '../../shared/host.js';
import '../../shared/global.css';
import '../../shared/components.css';
import { log, mainEl, chartCanvas, fullscreenBtn, backBtn, chartMenu, loadingEl, statusEl, state, app } from './page.js';
import { colorProbe } from './format.js';
import { resetSections } from './blocks.js';
import { render, toggleFullscreen, handleHostContextChanged } from './render.js';
import { closeDrillMenu, goBackTo } from './drill.js';
import { RoundedFlow, RoundedSankeyController, tooltipTimer, clearTooltip, hideSoon } from './chart.js';

// Only the pieces this view draws — Chart.js is tree-shakable, and the whole view ships in one file
Chart.register(ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, RoundedFlow, LinearScale, LineController, LineElement, PointElement, RoundedSankeyController, Tooltip);

// static icons
document.getElementById('notes-chevron').append(icon('chevron-down'));
document.getElementById('loading-icon').append(icon('loader-circle', 'icon spin'));

colorProbe.hidden = true;
document.body.append(colorProbe);

backBtn.replaceChildren(icon('chevron-left'));
backBtn.addEventListener('click', () => { if (state.drill.length > 1) goBackTo(state.drill.length - 2); });
document.addEventListener('pointerdown', (e) => { if (!chartMenu.hidden && !chartMenu.contains(e.target) && e.target !== chartCanvas) closeDrillMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrillMenu(); });

chartCanvas.addEventListener('pointerleave', (e) => (e.pointerType === 'mouse' ? clearTooltip() : hideSoon()));
chartCanvas.addEventListener('pointercancel', hideSoon);
chartCanvas.addEventListener('pointerdown', () => clearTimeout(tooltipTimer));
chartCanvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') hideSoon(); });
window.addEventListener('scroll', clearTooltip, { passive: true });

fullscreenBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.displayMode === 'fullscreen') {
    e.preventDefault();
    void toggleFullscreen();
  }
});

// ── the App's handlers, registered before it connects ──────────────────────────────────────────────────

app.onteardown = async () => {
  state.chart?.destroy();
  return {};
};

app.ontoolinput = (params) => {
  state.toolInput = toolInputOf(params);
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

// then connect to the host
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
