// THE PIVOT — a drill-down table, each level read from the card's stored result when its row opens.

import { pivotRows, pivotTransform, PIVOT_LEVEL_ROWS } from '../../result-view-model.js';
import { icon } from '../../shared/icons.js';
import { el, badge, card } from '../../shared/ui.js';
import { log, cardsSection, state } from './page.js';
import { payloadOf, setDescription } from './blocks.js';
import { formatKpi } from './kpi.js';
import { canFollow, readResult } from './drill.js';

export function renderPivot(model) {
  const drillable = model.levels.length > 1 && canFollow();
  setDescription(badge(`${model.levels.length} ${model.levels.length === 1 ? 'level' : 'levels'}`, 'secondary'));
  const table = el('table', 'table pivot-table');
  const head = document.createElement('tr');
  // the header names the TOP level only; a row names the level it opens into while it is open
  const first = el('th', null, model.levels[0].label);
  first.scope = 'col';
  head.append(first, ...model.values.map((v) => { const th = el('th', 'num', v.label); th.scope = 'col'; return th; }));
  table.append(document.createElement('thead'), document.createElement('tbody'));
  table.tHead.append(head);
  const body = table.tBodies[0];

  // a row's children, once read; a closed row keeps them, so reopening it reads nothing
  const opened = new Map();

  const note = (text, depth, cls = '') => {
    const tr = el('tr', `pivot-note ${cls}`);
    const td = el('td', null);
    td.colSpan = model.values.length + 1;
    td.style.setProperty('--depth', String(depth));
    td.append(el('span', null, text));
    tr.append(td);
    return tr;
  };

  // the open state shows twice: the chevron turns, and the row names the level under it
  const markOpen = (tr, open) => {
    tr.querySelector('.pivot-toggle')?.setAttribute('aria-expanded', String(open));
    const by = tr.querySelector('.pivot-by');
    if (by) by.hidden = !open;
  };

  const collapse = (tr) => {
    const state = opened.get(tr);
    if (!state?.open) return;
    for (const child of state.rows) { collapse(child); child.remove(); }
    state.open = false;
    markOpen(tr, false);
  };

  const rowEl = (row, path, depth) => {
    const tr = el('tr', 'pivot-row');
    const cell = el('td', 'pivot-label');
    cell.style.setProperty('--depth', String(depth));
    const canOpen = drillable && depth < model.levels.length - 1;
    if (canOpen) {
      const btn = el('button', 'btn btn-ghost btn-icon pivot-toggle');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', `Open ${row.label} by ${model.levels[depth + 1].label}`);
      btn.append(icon('chevron-right'));
      btn.addEventListener('click', () => toggle(tr, row, path, depth));
      cell.append(btn);
    } else {
      cell.append(el('span', 'pivot-leaf'));
    }
    cell.append(el('span', row.key === null ? 'null' : null, row.label));
    if (canOpen) {
      const by = el('span', 'pivot-by', `by ${model.levels[depth + 1].label}`);
      by.hidden = true;
      cell.append(by);
    }
    tr.append(cell, ...model.values.map((v, i) => el('td', 'num', formatKpi(row.values[i], v))));
    return tr;
  };

  const insertAfter = (anchor, nodes) => { anchor.after(...nodes); };

  async function toggle(tr, row, path, depth) {
    const state = opened.get(tr);
    if (state?.open) { collapse(tr); return; }
    const btn = tr.querySelector('.pivot-toggle');
    markOpen(tr, true);
    if (state?.rows) { insertAfter(tr, state.rows); state.open = true; return; }
    if (state?.loading) return;
    opened.set(tr, { loading: true });
    const loading = note(`Loading ${model.levels[depth + 1].label}…`, depth + 1, 'pivot-loading');
    loading.querySelector('td').prepend(icon('loader-circle', 'icon spin'));
    tr.after(loading);
    const at = [...path, row.key];
    let rows;
    try {
      const got = payloadOf(await readResult({ ...model.source, transform: pivotTransform(model.display, at), limit: PIVOT_LEVEL_ROWS }));
      if (got?.ok === false) {
        // the reason is said, so a failed level is diagnosable from the card itself
        rows = [note(got.error?.code === 'result_gone' ? 'This result is no longer available' : `Could not load this level${got.error?.message ? ` — ${String(got.error.message).split('\n')[0].slice(0, 160)}` : ''}`, depth + 1, 'pivot-error')];
      } else {
        const children = pivotRows(got, model.display, depth + 1);
        rows = children.length ? children.map((c) => rowEl(c, at, depth + 1)) : [note('No rows', depth + 1)];
        if (got?.page?.has_more) rows.push(note(`Top ${children.length} shown`, depth + 1));
      }
    } catch (e) {
      log.error('opening a pivot row failed', e);
      rows = [note(`Could not load this level${e?.message ? ` — ${String(e.message).split('\n')[0].slice(0, 160)}` : ''}`, depth + 1, 'pivot-error')];
    }
    loading.remove();
    const still = btn.getAttribute('aria-expanded') === 'true';
    opened.set(tr, { rows, open: still });
    if (still) insertAfter(tr, rows);
  }

  body.append(...model.rows.map((r) => rowEl(r, [], 0)));
  if (!model.rows.length) body.append(note('No rows', 0));
  if (model.has_more) body.append(note(`Top ${model.rows.length} shown`, 0));

  const container = el('div', 'table-container pivot-container');
  container.append(table);
  const content = el('div', 'card-content');
  content.append(container);
  cardsSection.className = 'ab-list';
  cardsSection.append(card({ title: model.values.map((v) => v.label).join(' · ') }, content));
  cardsSection.hidden = false;
}
