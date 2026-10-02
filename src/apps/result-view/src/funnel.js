// THE FUNNEL — each step's count and its share of the first, one funnel per group side by side.

import { icon } from '../../shared/icons.js';
import { el, badge, card, formatNumber, formatShare } from '../../shared/ui.js';
import { cardsSection } from './page.js';
import { setDescription } from './blocks.js';

export function funnelCard(model, f) {
  const n = f.steps.length;
  const first = f.steps[0];
  const end = f.steps[f.overall_to];
  const list = el('ol', 'funnel');
  f.steps.forEach((step, i) => {
    const worst = i === f.biggest_drop;
    const item = el('li', `funnel-step${worst ? ' funnel-step-worst' : ''}${step.outcome ? ' funnel-step-outcome' : ''}`);
    item.style.setProperty('--funnel-depth', String(Math.min(step.depth, 4)));
    if (step.parent !== null) {
      const link = el('div', 'funnel-link');
      const parent = f.steps[step.parent];
      const share = formatShare(step.of_parent);
      link.append(icon(step.outcome ? 'corner-down-right' : 'arrow-down'), el('span', null, step.outcome || step.parent !== i - 1 ? `${share} of ${parent.label}` : `${share} continued`));
      if (worst) link.append(badge(`Biggest drop · −${formatShare(1 - step.of_parent)}`, 'destructive'));
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
  return card({
    description: f.series !== null && f.series !== undefined ? `${f.series} · overall conversion` : 'Overall conversion',
    title: formatShare(f.overall),
    titleClass: 'card-title card-title-stat',
    subline: `${formatNumber(first.value)} → ${formatNumber(end.value)} · ${first.label} → ${end.label} · ${n} steps`,
  }, content);
}

export function renderFunnel(model) {
  const funnels = model.funnels;
  setDescription(
    badge(funnels.length > 1 ? `${funnels.length} funnels` : `${funnels[0].steps.length} steps`, 'secondary'),
    model.series_column ? badge(`by ${model.series_column}`, 'outline') : null,
    model.measure ? badge(model.measure, 'outline') : null,
  );
  cardsSection.className = funnels.length > 1 ? 'ab-list funnel-grid' : 'ab-list';
  for (const f of funnels) cardsSection.append(funnelCard(model, f));
  cardsSection.hidden = false;
}
