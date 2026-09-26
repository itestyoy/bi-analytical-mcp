// THE BUILDING BLOCKS BOTH MCP APPS VIEWS DRAW WITH — the result view (src/apps/result-view/) and the
// path-analysis view (src/apps/retentioneering-view/): the shadcn/ui pieces (Card, Badge) as DOM
// helpers and the number formats, so the two cards are one design. Data always goes in as text,
// never as markup.

import { icon } from '../result-view/src/icons.js';

export const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 1000) return integerFormat.format(n);
  if (n !== 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
  return numberFormat.format(n);
}

export const formatShare = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text; // data goes in as text, never as markup
  return node;
}

export function badge(text, variant = 'outline', iconName = null) {
  const node = el('span', `badge badge-${variant}`);
  if (iconName) node.append(icon(iconName));
  node.append(document.createTextNode(text));
  return node;
}

/** shadcn Card: header (description, title, optional action) and any content blocks. */
export function card({ title, description, action, subline, titleClass = 'card-title' }, ...content) {
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
