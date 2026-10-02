// WHETHER A CARD CAN BE DRAWN — display_model_result checks a declaration against the result it is
// for before drawing it: every column it names is one of the result's, and the rows have the shape
// the kind needs (one row for KPI tiles without x, a sankey that flows one way, a pie of positive
// shares, a funnel whose parents come before their steps). Pure functions of the declaration and the
// result; the view model (src/apps/result-view-model.js) says what one drill-down read is.

import { pivotTransform, PIVOT_LEVEL_ROWS, drillView, DRILL_ROWS } from './apps/result-view-model.js';

/** The column names of a result with rows, or null when it has none (running, failed). */
export function resultColumns(out) {
  if (!out || out.ok === false || !Array.isArray(out.rows)) return null;
  if (Array.isArray(out.columns) && out.columns.length) return out.columns.map((c) => (c && typeof c === 'object' ? c.name : String(c)));
  return out.rows[0] && typeof out.rows[0] === 'object' ? Object.keys(out.rows[0]) : [];
}

/**
 * What is wrong with a card declaration against these result columns (and rows, when known): a
 * named column that is not there, or a shape the rows cannot have. Empty = it can be drawn.
 */
export function displayProblems(display, columns, rows = null) {
  const have = new Set(columns);
  const ys = display.y === undefined ? [] : [].concat(display.y);
  const stepColumns = Array.isArray(display.steps); // steps as columns of one row, or { label_column, value_column } over a row per step
  const named = display.kind === 'funnel'
    ? [...(stepColumns ? display.steps.flatMap((st) => [st.column, st.parent]) : [display.steps?.label_column, display.steps?.value_column, display.steps?.parent_column]), display.series_column]
    : display.kind === 'pie' ? [display.label_column, display.value_column]
      : display.kind === 'kpi' ? [display.x, ...(display.values || []).flatMap((v) => [v.column, v.previous_column])]
        : display.kind === 'sankey' ? [display.source_column, display.target_column, display.value_column]
          : display.kind === 'pivot' ? [...(display.levels || []).map((l) => l.column), ...(display.values || []).map((v) => v.column)]
            : [display.x, ...ys, ...(display.series_column ? [display.series_column] : [])];
  const drillLevels = (display.drill?.levels || []).map((l) => l.column);
  named.push(...drillLevels);
  const problems = [...new Set(named.filter((c) => c && !have.has(c)))].map((c) => `'${c}' is not a column of this result`);
  if (display.kind === 'funnel' && stepColumns && new Set(display.steps.map((st) => st.column)).size !== display.steps.length) problems.push('a step is listed twice');
  if (display.kind === 'funnel' && stepColumns && !display.series_column && Array.isArray(rows) && rows.length !== 1) problems.push(`a funnel whose steps are columns needs a ONE-row result, and this one has ${rows.length} — aggregate to one row first, give series_column for a funnel per row, or declare steps: { label_column, value_column } for a row per step`);
  if (display.kind === 'funnel' && stepColumns) {
    // a step's parent is a step listed BEFORE it
    display.steps.forEach((st, i) => {
      if (st.parent === undefined) return;
      const p = display.steps.findIndex((x) => x.column === st.parent);
      if (p < 0 || p >= i) problems.push(`the parent of step '${st.column}' is '${st.parent}', which is not a step listed before it`);
    });
  }
  const pc = display.kind === 'funnel' && !stepColumns ? display.steps?.parent_column : null;
  if (pc && Array.isArray(rows) && have.has(pc) && have.has(display.steps.label_column)) {
    // each row's parent names a step (a row) before it, within its own funnel
    const seen = new Map();
    for (const r of rows) {
      const key = display.series_column ? String(r?.[display.series_column]) : '';
      const before = seen.get(key) || new Set();
      const parent = r?.[pc];
      if (parent !== null && parent !== undefined && parent !== '' && !before.has(String(parent))) {
        problems.push(`the parent of step '${r?.[display.steps.label_column]}' is '${parent}', which is not a step before it${display.series_column ? ` in its funnel (${key})` : ''}`);
        break;
      }
      before.add(String(r?.[display.steps.label_column]));
      seen.set(key, before);
    }
  }
  if (display.kind === 'funnel' && display.series_column && Array.isArray(rows) && have.has(display.series_column)) {
    const series = new Set(rows.map((r) => String(r?.[display.series_column])));
    if (series.size > 8) problems.push(`${series.size} funnels side by side are too many to compare — keep the 8 that matter in the query (the rest as "Other")`);
  }
  if (display.series_column && ys.length > 1) problems.push(`series_column splits ONE y column into a ${display.kind === 'bar' ? 'bar' : display.kind === 'area' ? 'band' : 'line'} per value — declare a single y with it`);
  if (display.kind === 'pivot' && new Set((display.levels || []).map((l) => l.column)).size !== (display.levels || []).length) problems.push('a level is listed twice');
  // a drill level is a dimension the chart does not already draw
  const drawn = new Set([display.x, display.label_column, display.series_column].filter(Boolean));
  if (new Set(drillLevels).size !== drillLevels.length) problems.push('a drill level is listed twice');
  for (const c of drillLevels.filter((c) => drawn.has(c))) problems.push(`'${c}' is drawn by the chart already — a drill level is another dimension`);
  if (display.kind === 'kpi' && !display.x && Array.isArray(rows) && rows.length !== 1) problems.push(`KPI tiles read ONE row, and this result has ${rows.length} — aggregate to one row, or give x (the time column) to show the last row with its trend`);
  if (display.kind === 'sankey' && Array.isArray(rows) && have.has(display.source_column) && have.has(display.target_column)) {
    const links = rows.map((r) => [String(r?.[display.source_column]), String(r?.[display.target_column])]);
    if (links.some(([a, b]) => a === b)) problems.push('a sankey link may not flow into itself (source = target)');
    else if (hasCycle(links)) problems.push('the links loop back (a cycle) — a sankey flows one way; name each stage apart (e.g. prefix the step) so no node is both before and after another');
    const nodes = new Set(links.flat());
    if (nodes.size > 40) problems.push(`${nodes.size} nodes are too many to read — group the small ones into "Other" in the query first (40 at most)`);
  }
  if (display.kind === 'pie' && Array.isArray(rows) && have.has(display.value_column)) {
    if (rows.length < 2) problems.push(`a pie needs a slice per row, and this result has ${rows.length} — a single number is better said as a number`);
    if (rows.some((r) => Number(r?.[display.value_column]) < 0)) problems.push(`a pie's slices are shares of one total, and '${display.value_column}' has negative values — use a bar`);
  }
  return problems;
}

/** The first read of a drill-down display (a pivot's top level, a drillable chart as declared), or null. */
export function drillFirstRead(display) {
  if (display?.kind === 'pivot') return { transform: pivotTransform(display, []), limit: PIVOT_LEVEL_ROWS };
  if (display?.drill) return { transform: drillView(display).transform, limit: DRILL_ROWS };
  return null;
}

/** Whether directed links [from, to] loop back anywhere (depth-first, three colours). */
export function hasCycle(links) {
  const next = new Map();
  for (const [a, b] of links) { if (!next.has(a)) next.set(a, []); next.get(a).push(b); }
  const state = new Map(); // 1 = on the current path, 2 = done
  const visit = (n) => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const m of next.get(n) || []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  return [...next.keys()].some((n) => visit(n));
}
