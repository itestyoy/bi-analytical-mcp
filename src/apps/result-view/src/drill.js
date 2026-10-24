// DRILLING DOWN — a click on a mark offers the dimensions left, and the chart redraws filtered to it:
// the one server call this view makes is drill_result, for its own task's stored table.

import { buildViewModel, drillView, DRILL_ROWS } from '../../result-view-model.js';
import { icon } from '../../shared/icons.js';
import { el } from '../../shared/ui.js';
import { log, chartCanvas, backBtn, chartCrumbs, chartMenu, chartLoading, state, app } from './page.js';
import { payloadOf, showAlert } from './blocks.js';
import { show } from './render.js';
import { clearTooltip } from './chart.js';

/** Whether the host proxies a view's tools/call at all — without it nothing can be drilled into. */
export const canFollow = () => !!app.getHostCapabilities()?.serverTools;

/**
 * THE view's one way to the server: drill_result (a tool only a view may call), for the task this
 * card was drawn from — its stored table's next view when a drill-down steps down (a pivot row, a
 * chart mark). Read-only, and only this card's own result.
 */
export const readResult = (args) => app.callServerTool({ name: 'drill_result', arguments: { request: args } });

/**
 * Chart.js click and hover options for a chart that can be drilled into (nothing otherwise): a
 * mark under the pointer shows a hand, and a click on it opens the drill menu. `target` turns the
 * clicked element into what the menu drills into — the filters it adds, how it reads, and which
 * steps it offers — or null when the mark cannot be drilled (an "Other" slice).
 */
export function drillOptions(chart, target) {
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

export const drillFilter = (column, key, label) => ({ column, value: key ?? null, label });

export function barDrill(chart, labels, series, el) {
  const d = chart.drill;
  const filters = [drillFilter(chart.x, d.keys?.[el.index], labels[el.index])];
  // a bar of a split is one category AND one value of the split
  if (d.series_column && series[el.datasetIndex]) filters.push(drillFilter(d.series_column, series[el.datasetIndex].key, series[el.datasetIndex].name));
  return { filters, steps: d.levels.map((level) => ({ level, mode: 'breakdown' })) };
}

export function sliceDrill(chart, el) {
  const slice = chart.slices[el.index];
  if (!slice || slice.other) return null; // "Other" is several slices, not one value to filter by
  return { filters: [drillFilter(chart.x, slice.key, slice.label)], steps: chart.drill.levels.map((level) => ({ level, mode: 'breakdown' })) };
}

export function linePointDrill(chart, labels, timeLabel, el) {
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

export function closeDrillMenu() {
  chartMenu.hidden = true;
  chartMenu.replaceChildren();
}

export function openDrillMenu(chart, target, x, y) {
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
export async function drillInto(chart, filters, step) {
  closeDrillMenu();
  const d = chart.drill;
  const path = [...d.path, ...filters.map(({ column, value }) => ({ column, value }))];
  const view = drillView(d.display, path, { level: { column: step.level.column }, mode: step.mode });
  chartLoading.replaceChildren(icon('loader-circle', 'icon spin'));
  chartLoading.hidden = false;
  let got;
  try {
    // the path taken and the level opened: the server makes the view from the card as it was drawn
    got = payloadOf(await readResult({ ...d.source, path, level: step.level.column, mode: step.mode, limit: DRILL_ROWS }));
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
export function updateDrillNav() {
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

export function goBackTo(index) {
  state.drill = state.drill.slice(0, index + 1);
  const target = state.drill[index].model;
  if (index === 0) state.drill = [];
  show(target);
}
