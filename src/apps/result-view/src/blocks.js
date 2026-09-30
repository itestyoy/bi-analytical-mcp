// THE PAGE'S BUILDING BLOCKS — what a tool result carries, the alert, the description line, and a
// clean page before a card is drawn.

import { icon } from '../../shared/icons.js';
import { el } from '../../shared/ui.js';
import { subtitleEl, noticeEl, chartSection, chartTooltip, chartLegend, cardsSection, notesEl, notesList, state } from './page.js';

export function payloadOf(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

/** shadcn Alert: an icon, a title and a description; `destructive` for a failure. */
export function showAlert({ title, description, variant = 'default', iconName = 'info' }) {
  noticeEl.replaceChildren(icon(iconName), el('p', 'alert-title', title));
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

export function setDescription(...parts) {
  subtitleEl.replaceChildren(...parts.filter(Boolean).map((p) => (p instanceof Node ? p : document.createTextNode(p))));
}

export function resetSections() {
  for (const section of [noticeEl, chartSection, cardsSection, notesEl]) section.hidden = true;
  cardsSection.replaceChildren();
  cardsSection.className = '';
  notesList.replaceChildren();
  chartLegend.replaceChildren();
  chartLegend.hidden = true;
  chartTooltip.hidden = true;
  state.chart?.destroy();
  state.chart = null;
}
