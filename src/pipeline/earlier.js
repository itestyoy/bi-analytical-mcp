// A STEP STORED BY AN EARLIER VERSION, CARRIED OVER ON READ. A draft outlives a deploy, and its steps
// are rendered again on every edit; what an earlier version spelled another way is translated to this
// version's spelling here, once, before a stage is built — the renames from the ONE table that also
// tells a caller this server's spelling (src/validate.js CROSS_PATH_SPELLING: fn → agg, q → percentile,
// avg → average, as → name), and a computed column written as { op, …fields } to its expression.
// A step in the current spelling passes through unchanged.

import { CROSS_PATH_SPELLING as SPELLING } from '../validate.js';

/** The object with each key the table renames given its current name, and an aggregation's old value its current one. */
function respelled(obj, keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = keys.includes(k) && SPELLING[k] ? SPELLING[k] : k;
    out[key] = key === 'agg' && typeof v === 'string' && SPELLING[v] ? SPELLING[v] : v;
  }
  return out;
}

const ONE = new Set(['floor', 'ceil', 'abs', 'upper', 'lower', 'length', 'trim', 'unix_date', 'hll_extract', 'json_parse_array']);

/** A computed column of the earlier { op, …fields } form, as the expression it computes. */
function computeExpr(st) {
  const col = () => ({ column: st.column });
  const fn = (name, args, params = []) => ({ fn: name, ...(args ? { args } : {}), ...Object.fromEntries(params.filter((k) => st[k] !== undefined).map((k) => [k === 'granularity' ? 'grain' : k, st[k]])) });
  const op = st.op;
  if (op === 'const') return { value: st.value };
  if (['add', 'sub', 'mul', 'div'].includes(op)) return fn(op, [st.left, st.right]);
  if (ONE.has(op)) return fn(op, [col()]);
  if (op === 'round') return fn(op, [col()], ['places']);
  if (op === 'coalesce') return fn(op, [...(st.columns || []).map((c) => ({ column: c })), ...(st.default !== undefined ? [{ value: st.default }] : [])]);
  if (['least', 'greatest', 'concat'].includes(op)) return fn(op, st.parts);
  if (op === 'cast') return fn(op, [col()], ['type']);
  if (op === 'substring') return fn(op, [col()], ['start', 'len']);
  if (op === 'replace') return fn(op, [col()], ['search', 'replacement']);
  if (op === 'json_field') return fn(op, [col()], ['field', 'type']);
  if (op === 'element_at') return fn(op, [col()], ['index', 'type']);
  if (op === 'array_last') return fn(op, [col()], ['type']);
  // the earlier raw named its columns in its text, which went to the warehouse as written — as the
  // text of a raw goes now; nothing is read out of it to move into args
  if (op === 'raw') return fn(op, null, ['sql', 'type']);
  if (op === 'date_diff') return fn(op, [st.from, st.to], ['unit']);
  if (op === 'date_trunc') return fn(op, [col()], ['granularity']);
  if (op === 'date_part') return fn(op, [col()], ['part']);
  if (op === 'elapsed_days') return fn(op, [st.from, st.to], ['clamp_zero']);
  if (op === 'case') return fn(op, null, ['cases', 'else', 'type']);
  if (op === 'window') {
    const w = SPELLING[st.fn] || st.fn;
    const aggregate = ['sum', 'average', 'min', 'max', 'count'].includes(w);
    const over = Object.fromEntries(['partition_by', 'order_by', ...(aggregate ? ['frame'] : [])].filter((k) => st[k] !== undefined).map((k) => [k, st[k]]));
    if (['row_number', 'rank', 'dense_rank'].includes(w)) return { fn: w, over };
    if (['lag', 'lead'].includes(w)) return { fn: w, args: [col()], ...(st.offset !== undefined ? { offset: st.offset } : {}), ...(st.default !== undefined ? { default: st.default } : {}), over };
    return { fn: w, args: st.column !== undefined ? [col()] : [], over };
  }
  return null; // an op this version never had: left for the stage's own refusal
}

/** The stage in this version's spelling (the same object when it already is). */
export function currentSpelling(st) {
  if (!st || typeof st !== 'object') return st;
  if (st.stage === 'compute' && st.op !== undefined && st.expr === undefined) {
    const expr = computeExpr(st);
    return expr ? { stage: 'compute', name: st.name, expr } : st;
  }
  if (st.stage === 'aggregate' && (st.measures || []).some((m) => m && (m.fn !== undefined || m.q !== undefined))) return { ...st, measures: st.measures.map((m) => respelled(m, ['fn', 'q'])) };
  if (st.stage === 'pivot' && st.fn !== undefined) return respelled(st, ['fn']);
  if (st.stage === 'join' && (st.attrs || []).some((a) => a && typeof a === 'object' && a.as !== undefined)) return { ...st, attrs: st.attrs.map((a) => (a && typeof a === 'object' ? respelled(a, ['as']) : a)) };
  if (st.stage === 'unnest' && st.as !== undefined) return respelled(st, ['as']);
  return st;
}
