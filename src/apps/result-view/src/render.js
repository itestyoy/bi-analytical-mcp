// WHICH CARD A RESULT IS, AND DRAWING IT — the view model decides (src/apps/result-view-model.js), a
// card per kind draws it (chart, KPI tiles, pivot, funnel, A/B test), and the page follows the host's
// display mode and its context (theme, size, a redraw in new colours).

import { buildViewModel } from '../../result-view-model.js';
import { icon } from '../../shared/icons.js';
import { applyHostContext } from '../../shared/host.js';
import { el, badge, formatNumber } from '../../shared/ui.js';
import { log, mainEl, titleEl, notesEl, notesList, fullscreenBtn, loadingEl, statusEl, state, app } from './page.js';
import { payloadOf, showAlert, setDescription, resetSections } from './blocks.js';
import { renderKpi } from './kpi.js';
import { renderPivot } from './pivot.js';
import { closeDrillMenu, updateDrillNav } from './drill.js';
import { renderChart } from './chart.js';
import { renderExperiment } from './experiment.js';
import { renderFunnel } from './funnel.js';

export const CARDS = { chart: (m) => renderChartResult(m), kpi: (m) => renderKpi(m), pivot: (m) => renderPivot(m), funnel: (m) => renderFunnel(m), experiment: (m) => renderExperiment(m) };

export function render(result) {
  loadingEl.hidden = true; // the result is here: the spinner's job is done, whatever is drawn next
  const model = buildViewModel(state.toolName, payloadOf(result), state.toolInput);
  state.drill = []; // a new result starts a new drill-down path
  show(model);
}

/** Draw one view model — the result as it came, or a view of it a drill-down stepped into. */
export function show(model) {
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

/** The one line a result without a card gets — what happened, and that the reply carries the rest. */
export function showStatus(model) {
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

export function renderChartResult(model) {
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
export function showFolded(chart) {
  if (!chart.folded) return;
  const bySize = chart.folded_by === 'size';
  showAlert({
    title: `${chart.folded} ${bySize ? 'smaller ' : ''}series ${chart.folded === 1 ? 'is' : 'are'} not drawn`,
    description: bySize ? `The chart keeps the largest ${chart.kept}.` : `The chart keeps the first ${chart.kept}, in column order.`,
  });
}

/** The server's advice is for whoever acts next — kept, but folded under the result. */
export function showNotes(notes) {
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
export function applyContainer(ctx) {
  const dims = ctx.containerDimensions;
  // a BOOLEAN: classList.toggle(token, undefined) does not switch the class off — it flips it, so a
  // host that sends no containerDimensions would put the view into the fixed-height layout
  const fixedHeight = !!(dims && 'height' in dims && typeof dims.height === 'number');
  mainEl.classList.toggle('fill', state.displayMode === 'fullscreen' || fixedHeight);
  document.documentElement.style.maxHeight = dims && 'maxHeight' in dims && dims.maxHeight ? `${dims.maxHeight}px` : '';
}

export function updateFullscreenButton() {
  const modes = app.getHostContext()?.availableDisplayModes ?? [];
  const isFullscreen = state.displayMode === 'fullscreen';
  // offered only where the host can do it — the same rule as the official map and PDF views
  fullscreenBtn.hidden = !modes.includes(isFullscreen ? 'inline' : 'fullscreen');
  fullscreenBtn.replaceChildren(icon(isFullscreen ? 'minimize-2' : 'maximize-2'));
  const label = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
  fullscreenBtn.title = label;
  fullscreenBtn.setAttribute('aria-label', label);
}

export async function toggleFullscreen() {
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

export function handleHostContextChanged(ctx) {
  applyHostContext(ctx);
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
