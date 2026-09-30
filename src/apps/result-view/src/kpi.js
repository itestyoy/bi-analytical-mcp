// KPI TILES — shadcn stat cards: the value large, its change, the trend as a sparkline.

import { icon } from '../../shared/icons.js';
import { el, badge, card, formatNumber } from '../../shared/ui.js';
import { cardsSection } from './page.js';
import { formatSignedPercent, timeFormatter } from './format.js';
import { setDescription } from './blocks.js';

export function formatKpi(value, tile) {
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
export function sparkline(values) {
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

export function renderKpi(model) {
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
