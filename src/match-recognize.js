// Sequenced-funnel / path engine: we generate the query OURSELVES from the
// declared ordered steps + metrics (MetricFlow can't express row-pattern
// sequences). Target = BigQuery MATCH_RECOGNIZE (per docs); a Postgres
// equivalent is also emitted purely so funnel NUMBERS can be asserted on data.
//
// Output is a SINGLE ROW of the declared metrics (same shape for both dialects).
// Supported metric types (computed over each user's matched sequence):
//   reached            { step }                  distinct users reaching a step
//   completed          {}                          users reaching the last step
//   conversion         { from, to }                reached(to) / reached(from)
//   avg_seconds_between{ from, to }                avg seconds between two steps
//   agg_at_step        { agg, property, step }     sum/avg/min/max of a property at a step
//
// BigQuery specifics honored: JSON_VALUE, one-row-per-match (no ONE ROW PER
// MATCH / AFTER MATCH SKIP keywords), nested PATTERN enforces step order, GAP =
// any non-step row, CLASSIFIER/aggregates in MEASURES.

import { jsonExtract, sqlLiteral } from './dialect.js';
import { registerStage, prepareColumns } from './pipeline.js';
import { oneOfOr, strEnum } from './schema-kit.js';

const NAME = '^[a-z][a-z0-9_]{0,40}$';

/** Date-only 'YYYY-MM-DD' end → the NEXT day (exclusive upper bound), so the whole
 *  day is included when comparing a timestamp column. Returns null if not date-only
 *  (a full datetime is used as-is). Avoids `<= 'YYYY-MM-DD'` collapsing to midnight. */
export function dateEndExclusive(end) {
  if (typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Render a single comparison `lhs OP value` with the value bound as a literal. */
function comparePred(lhs, op, value) {
  const arr = Array.isArray(value) ? value : [value];
  switch (op) {
    case 'eq': return `${lhs} = ${sqlLiteral(value)}`;
    case 'neq': return `${lhs} != ${sqlLiteral(value)}`;
    case 'gt': return `${lhs} > ${sqlLiteral(value)}`;
    case 'gte': return `${lhs} >= ${sqlLiteral(value)}`;
    case 'lt': return `${lhs} < ${sqlLiteral(value)}`;
    case 'lte': return `${lhs} <= ${sqlLiteral(value)}`;
    case 'in': return `${lhs} IN (${arr.map(sqlLiteral).join(', ')})`;
    case 'not_in': return `${lhs} NOT IN (${arr.map(sqlLiteral).join(', ')})`;
    default: throw new Error(`unsupported filter op: ${op}`);
  }
}

/** Step/prefilter event names, normalized to the SOURCE fact's physical values. A
 *  row-pattern match scans ONE table, so an event of another fact cannot participate. */
const factEventNames = (catalog, source, names) => (names || []).map((n) => catalog.eventNameFor(source, n, {
  hint: 'a funnel runs over ONE fact, so start the pipeline from the fact that owns the event',
}));

export function stepPredicate(catalog, step, dialect, prepCols = new Map(), source) {
  const m = catalog.getModel(source);
  const modelCols = new Set(catalog.modelColumns(source).map((x) => x.name));
  // Unqualified, for the same reason buildPrefilter is: the predicate applies to the single
  // relation the pattern scans, and a payload property is rendered by catalog.propertyExpr, which
  // carries no qualifier — so half of a qualified predicate would silently stay unqualified.
  const evCol = m.event_name.column;
  const names = factEventNames(catalog, source, step.event_name);
  const ev = names.length === 1 ? `${evCol} = ${sqlLiteral(names[0])}` : `${evCol} IN (${names.map(sqlLiteral).join(', ')})`;
  const props = (step.where || []).map((c) => {
    // a prepare-derived column is referenced directly (it's a real column now)
    if (prepCols.has(c.property)) {
      return comparePred(c.property, c.op, c.value);
    }
    const p = (m.properties || {})[c.property];
    if (!p) {
      // a physical model column (envelope/dimension column like bundle_id) → compare it
      // directly, so a step filter can use model columns without a separate where stage.
      if (modelCols.has(c.property)) return comparePred(c.property, c.op, c.value);
      throw new Error(`unknown event property or column in step: ${c.property}`);
    }
    if (catalog.isComplexEventProp(c.property, source)) {
      throw new Error(`property '${c.property}' is array/struct; reference it via a prepare stage (derive/unnest), not directly`);
    }
    // the catalog's one rule for reading a property: a flat column, or a JSON extract from the
    // payload column — unqualified, like every other clause here
    return comparePred(catalog.propertyExpr(source, c.property, dialect, { type: p.type }), c.op, c.value);
  });
  return [ev, ...props].join(' AND ');
}

/**
 * WHERE clause applied to the events BEFORE the row-pattern match, to slice the
 * data scanned (speed). Returns '' when no `filter` is declared. Narrows the
 * population only — it does NOT redefine steps. Event-level filters: time window,
 * event_name allowlist, event_data property conditions. To filter by USER
 * attributes, add a `join` (users) + `where` stage before match_recognize.
 *
 * Columns are referenced UNQUALIFIED: the filter always applies to the one relation being scanned,
 * and a payload property is rendered by `catalog.propertyExpr`, which has no qualifier of its own —
 * so a qualifier here would reach half the clauses and silently skip the rest.
 */
export function buildPrefilter(catalog, spec, dialect, source) {
  const f = spec.filter;
  if (!f) return '';
  const m = catalog.getModel(source);
  const evNameCol = m.event_name.column;
  const timeCol = m.time.column;
  const clauses = [];
  if (f.time_range?.start) clauses.push(`${timeCol} >= ${sqlLiteral(f.time_range.start)}`);
  if (f.time_range?.end) { const ex = dateEndExclusive(f.time_range.end); clauses.push(ex ? `${timeCol} < ${sqlLiteral(ex)}` : `${timeCol} <= ${sqlLiteral(f.time_range.end)}`); }
  if (f.event_name?.length) clauses.push(`${evNameCol} IN (${factEventNames(catalog, source, f.event_name).map(sqlLiteral).join(', ')})`);
  const modelCols = new Set(catalog.modelColumns(source).map((x) => x.name));
  for (const c of f.where || []) {
    const p = (m.properties || {})[c.property];
    if (!p) {
      // physical model column (e.g. bundle_id) → direct comparison; no separate where needed.
      if (modelCols.has(c.property)) { clauses.push(comparePred(c.property, c.op, c.value)); continue; }
      throw new Error(`unknown event property or column in filter.where: ${c.property}`);
    }
    clauses.push(comparePred(catalog.propertyExpr(source, c.property, dialect, { type: p.type }), c.op, c.value));
  }
  return clauses.join(' AND ');
}

function resolve(catalog, spec, dialect, availableCols = null, source) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length < 2) {
    throw new Error('sequence requires at least 2 ordered steps');
  }
  if (!catalog.isFact(source)) {
    throw new Error(`match_recognize needs an events fact as the pipeline source; '${source}' is not one (facts: ${catalog.facts.join(', ')})`);
  }
  const m = catalog.getModel(source);
  // Partition key is FLEXIBLE: the caller chooses any column(s) available at this point in the
  // pipeline (event columns, or ones added by upstream derive/compute/join), or names a
  // RELATIONSHIP the source declares — { entity: 'user' } — and its key column is used. A
  // relationship is named, never spelled as a bare magic word: nothing in here knows what any
  // particular relationship is called.
  const declared = Object.keys(m.entities || {});
  const entityCol = (name, where) => {
    const e = m.entities?.[name];
    if (!e) throw new Error(`${where}: '${source}' declares no relationship '${name}' (declared: ${declared.join(', ') || 'none'})`);
    const parts = e.key || [];
    // A partition column is ONE real column of the row. A composite key, or a part truncated to a
    // grain, is an expression — the caller partitions by the columns it means instead.
    if (parts.length !== 1 || parts[0].grain) {
      throw new Error(`${where}: relationship '${name}' of '${source}' is keyed by ${parts.map((x) => x.column).join(' + ') || 'nothing'}${parts.some((x) => x.grain) ? ' (truncated to a grain)' : ''}, which is an expression, not a column — partition by the column(s) you mean`);
    }
    return parts[0].column;
  };
  const resolvePart = (p, i) => {
    const where = `partition_by[${i}]`;
    if (p && typeof p === 'object') return entityCol(p.entity, where);
    const s = String(p);
    if (m.entities?.[s]) throw new Error(`${where}: '${s}' is a RELATIONSHIP of '${source}', not a column — write { entity: '${s}' } to partition by its key column`);
    return s;
  };
  const asList = (v) => (Array.isArray(v) ? v : [v]);
  let partCols;
  if (spec.partition_by != null && asList(spec.partition_by).length) partCols = asList(spec.partition_by).map(resolvePart);
  else {
    // Default: one sequence per USER — found through the role the catalog assigns the model the
    // relationship points at, not through what that relationship happens to be called.
    const ent = catalog.entityTowardRole(source, 'users');
    if (!ent) throw new Error(`partition_by is required: '${source}' declares no relationship toward a users model to default to (declared: ${declared.join(', ') || 'none'})`);
    partCols = [entityCol(ent, 'partition_by (default)')];
  }
  if (availableCols) for (const c of partCols) if (!availableCols.has(c)) throw new Error(`partition_by column '${c}' is not available at the match_recognize stage`);
  // Order key (the sequence axis): caller may override; defaults to the event time.
  const timeCol = spec.order_by || m.time.column;
  const mode = spec.mode || 'ordered';
  // What may appear BETWEEN consecutive steps (ordered mode only):
  //  - 'any' : any rows, including repeats of step events — i.e. "the next later
  //            occurrence of step i+1", repeats don't break the match.
  //  - 'gap' : only non-step events; a repeat of any step event breaks/advances.
  //  Unset = each dialect's historical default (Postgres ~ 'any', BigQuery ~ 'gap');
  //  set it explicitly for identical semantics across engines.
  const betweenSteps = spec.between_steps || null;
  const steps = spec.steps.map((s, i) => ({ idx: i + 1, name: s.name || `s${i + 1}` }));
  const byName = new Map(steps.map((s) => [s.name, s]));
  const stepIdx = (name) => {
    const s = byName.get(name);
    if (!s) throw new Error(`metric references unknown step '${name}'`);
    return s.idx;
  };

  const metrics = (spec.metrics && spec.metrics.length)
    ? spec.metrics
    : steps.map((s) => ({ name: `reached_${s.name}`, type: 'reached', step: s.name }));

  // Real columns referenceable in step `where` / agg_at_step (vs event_data
  // properties). In a pipeline these are the columns produced by earlier stages
  // (passed in as availableCols); standalone, they come from spec.prepare.
  const prepCols = availableCols || prepareColumns(catalog, dialect, spec.prepare || [], source);

  // resolve metrics + collect which property values must be captured per step
  const propCaptures = []; // { id, idx, property, type, isColumn }
  const resolved = metrics.map((mt) => {
    const out = { name: mt.name, type: mt.type };
    if (mt.type === 'reached') out.idx = stepIdx(mt.step);
    else if (mt.type === 'completed') out.idx = steps.length;
    else if (mt.type === 'conversion') { out.from = stepIdx(mt.from); out.to = stepIdx(mt.to); }
    else if (mt.type === 'avg_seconds_between') { out.from = stepIdx(mt.from); out.to = stepIdx(mt.to); }
    else if (mt.type === 'agg_at_step') {
      out.idx = stepIdx(mt.step); out.agg = (mt.agg || 'sum').toUpperCase();
      let type; const isColumn = prepCols.has(mt.property);
      if (isColumn) type = prepCols.get(mt.property).type;
      else {
        const p = (m.properties || {})[mt.property];
        if (!p) throw new Error(`agg_at_step: unknown property '${mt.property}'`);
        if (catalog.isComplexEventProp(mt.property, source)) throw new Error(`agg_at_step: '${mt.property}' is array/struct; derive a scalar via a prepare stage first`);
        type = p.type;
      }
      out.capId = `pv_${mt.name}`;
      propCaptures.push({ id: out.capId, idx: out.idx, property: mt.property, type, isColumn });
    } else throw new Error(`unknown sequence metric type: ${mt.type}`);
    return out;
  });

  const stepPreds = (d) => spec.steps.map((s) => stepPredicate(catalog, s, d, prepCols, source));
  const rows = spec.rows || 'one_per_partition';
  return { m, fact: source, partCols, timeCol, mode, betweenSteps, steps, rows, metrics: resolved, propCaptures, prepCols, stepPreds };
}

// gapMode: false (strict, no filler), 'single' (one GAP = "not any step" between every
// pair), or 'perlevel' (G_i = "not the NEXT step" before step i+1 → any-later semantics).
function nestedPattern(steps, gapMode) {
  const sym = steps.map((s) => `S${s.idx}`);
  const gapFor = (i) => (!gapMode ? '' : gapMode === 'perlevel' ? `G${i}* ` : 'GAP* ');
  const nestFrom = (i) => (i === sym.length - 1 ? `${gapFor(i)}${sym[i]}` : `${gapFor(i)}${sym[i]} (${nestFrom(i + 1)})?`);
  return sym.length > 1 ? `(${sym[0]} (${nestFrom(1)})?)` : `(${sym[0]})`;
}

/** Gap strategy for a resolved spec: strict → none; between_steps='any' → per-level
 *  (filler = "not the next step", so repeats of other step events don't break the
 *  match); otherwise the historical single-GAP ("not any step"). */
function gapModeFor(r) {
  if (r.mode === 'strict') return false;
  return r.betweenSteps === 'any' ? 'perlevel' : 'single';
}


// ─────────────────────────────────────────────────────────────────────────────
// match_recognize as a COMPOSABLE pipeline stage. It consumes the previous
// relation and emits ONE self-contained CTE producing one row per user/session
// match (t-times, reached_<step> flags, furthest_step_name, completed, captured
// metric values). Because it's a normal (non-terminal) stage, downstream stages
// (join dim_users, where, aggregate, pivot…) slice/aggregate the funnel — e.g.
// conversion by country — entirely within the pipeline. No separate semantic
// model: the funnel is just part of the pipeline whose rows are the result.
// ─────────────────────────────────────────────────────────────────────────────

/** Postgres lowering: a single SELECT (nested WITH ev/r1..rn/joined) over fromRel. */
export function matchStepPostgres(r, fromRel, catalog) {
  if (r.mode === 'strict') {
    throw new Error("sequence mode 'strict' (contiguous steps) is only supported for the BigQuery MATCH_RECOGNIZE target, not the Postgres equivalent");
  }
  const preds = r.stepPreds('postgres');
  const capByIdx = new Map();
  for (const c of r.propCaptures) { if (!capByIdx.has(c.idx)) capByIdx.set(c.idx, []); capByIdx.get(c.idx).push(c); }
  const evExtra = r.propCaptures.map((c) => `    (${c.isColumn ? c.property : catalog.propertyExpr(r.fact, c.property, 'postgres', { type: c.type })}) AS ${c.id}`);
  const evCols = [...preds.map((p, i) => `    (${p}) AS is${i + 1}`), ...evExtra].join(',\n');
  const carried1 = (idx) => (capByIdx.get(idx) || []).map((c) => `, ${c.id}`).join('');
  const carried = (idx) => (capByIdx.get(idx) || []).map((c) => `, e.${c.id} AS ${c.id}`).join('');
  const pk = r.partCols; // one or more partition columns (composite key)
  const pkList = pk.join(', ');
  const pkE = pk.map((c) => `e.${c}`).join(', ');
  // one_per_partition (default): the FIRST match per partition (DISTINCT ON the key).
  // one_per_match: EVERY occurrence of the start step S1; t1 becomes part of the match
  // identity, carried through so each S1 chains its own subsequent steps independently.
  const perMatch = r.rows === 'one_per_match';
  const ctes = [{ name: 'ev', sql: `SELECT ${pkList}, ${r.timeCol} AS ts,\n${evCols}\n  FROM ${fromRel}` }];
  ctes.push({ name: 'r1', sql: perMatch
    ? `SELECT ${pkList}, ts AS t1${carried1(1)} FROM ev WHERE is1`
    : `SELECT DISTINCT ON (${pkList}) ${pkList}, ts AS t1${carried1(1)} FROM ev WHERE is1 ORDER BY ${pkList}, ts` });
  // between_steps='gap': forbid ANY step event between the previous step and this one
  // (only non-step rows may fill the gap). Unset/'any' = nearest later occurrence.
  const anyStepG = r.steps.map((_, k) => `g.is${k + 1}`).join(' OR ');
  const gapGuard = (i) => (r.betweenSteps === 'gap'
    ? ` AND NOT EXISTS (SELECT 1 FROM ev g WHERE ${pk.map((c) => `g.${c} = e.${c}`).join(' AND ')} AND g.ts > r${i - 1}.t${i - 1} AND g.ts < e.ts AND (${anyStepG}))`
    : '');
  for (let i = 2; i <= r.steps.length; i++) {
    const joinOn = pk.map((c) => `e.${c} = r${i - 1}.${c}`).join(' AND ');
    const where = `e.is${i} AND e.ts > r${i - 1}.t${i - 1}${gapGuard(i)}`;
    ctes.push({ name: `r${i}`, sql: perMatch
      ? `SELECT DISTINCT ON (${pkE}, r${i - 1}.t1) ${pkE}, r${i - 1}.t1 AS t1, e.ts AS t${i}${carried(i)} FROM ev e JOIN r${i - 1} ON ${joinOn} WHERE ${where} ORDER BY ${pkE}, r${i - 1}.t1, e.ts`
      : `SELECT DISTINCT ON (${pkE}) ${pkE}, e.ts AS t${i}${carried(i)} FROM ev e JOIN r${i - 1} ON ${joinOn} WHERE ${where} ORDER BY ${pkE}, e.ts` });
  }
  const sel = [...pk.map((c) => `r1.${c}`), ...r.steps.map((s) => (s.idx === 1 ? 'r1.t1' : `r${s.idx}.t${s.idx}`)), ...r.propCaptures.map((c) => `r${c.idx}.${c.id}`)];
  let joins = 'FROM r1';
  const usingKey = perMatch ? `${pkList}, t1` : pkList;
  for (let i = 2; i <= r.steps.length; i++) joins += ` LEFT JOIN r${i} USING (${usingKey})`;
  ctes.push({ name: 'joined', sql: `SELECT ${sel.join(', ')} ${joins}` });
  const furthestCase = r.steps.slice().reverse().map((s) => `WHEN j.t${s.idx} IS NOT NULL THEN '${s.name}'`).join(' ');
  const outCols = [
    ...pk.map((c) => `j.${c}`),
    'j.t1 AS first_seen_at',
    `CASE ${furthestCase} END AS furthest_step_name`,
    `(j.t${r.steps.length} IS NOT NULL) AS completed`,
    ...r.steps.map((s) => `(j.t${s.idx} IS NOT NULL) AS reached_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `EXTRACT(EPOCH FROM (j.t${m.to} - j.t${m.from})) AS secs_${m.name}`),
    ...r.propCaptures.map((c) => `j.${c.id}`),
  ];
  return `WITH ${ctes.map((c) => `${c.name} AS (\n  ${c.sql}\n)`).join(',\n')}\nSELECT\n  ${outCols.join(',\n  ')}\nFROM joined j`;
}

/** BigQuery lowering: a single SELECT … FROM fromRel MATCH_RECOGNIZE(…).
 *  rows handling, to stay numerically consistent with the Postgres lowering:
 *  - one_per_match: emit `AFTER MATCH SKIP TO NEXT ROW` so a new match can begin on
 *    the very next row — every occurrence of the start step yields a match (overlapping
 *    matches), matching the "every S1 starts a match" Postgres CTE. (Without it,
 *    BigQuery's default AFTER MATCH SKIP PAST LAST ROW gives NON-overlapping matches,
 *    which would diverge from Postgres.)
 *  - one_per_partition: keep BigQuery's default skip and take the first match per
 *    partition via the outer QUALIFY (ROW_NUMBER ORDER BY t1 = 1) — the earliest-S1
 *    match, equivalent regardless of skip mode. */
export function matchStepBigQuery(r, fromRel, catalog) {
  const preds = r.stepPreds('bigquery');
  const sym = r.steps.map((s) => `S${s.idx}`);
  const measures = [
    ...r.steps.map((s) => `    MAX(S${s.idx}.${r.timeCol}) AS t${s.idx}`),
    ...r.propCaptures.map((c) => `    MAX(${c.isColumn ? `S${c.idx}.${c.property}` : catalog.propertyExpr(r.fact, c.property, 'bigquery', { type: c.type, qualifier: `S${c.idx}` })}) AS ${c.id}`),
  ].join(',\n');
  const defines = r.steps.map((s, i) => `    ${sym[i]} AS ${preds[i]}`);
  const gapMode = gapModeFor(r);
  if (gapMode === 'single') defines.push(`    GAP AS NOT (${preds.map((p) => `(${p})`).join(' OR ')})`);
  else if (gapMode === 'perlevel') for (let i = 1; i < r.steps.length; i++) defines.push(`    G${i} AS NOT (${preds[i]})`);
  const furthestCase = r.steps.slice().reverse().map((s) => `WHEN t${s.idx} IS NOT NULL THEN '${s.name}'`).join(' ');
  const reached = r.steps.map((s) => `    t${s.idx} IS NOT NULL AS reached_${s.name}`);
  const secs = r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `    TIMESTAMP_DIFF(t${m.to}, t${m.from}, SECOND) AS secs_${m.name}`);
  return `SELECT
${r.partCols.map((c) => `    ${c},`).join('\n')}
    t1 AS first_seen_at,
    CASE ${furthestCase} END AS furthest_step_name,
    t${r.steps.length} IS NOT NULL AS completed,
${[...reached, ...secs, ...r.propCaptures.map((c) => `    ${c.id}`)].join(',\n')}
  FROM ${fromRel} MATCH_RECOGNIZE (
    PARTITION BY ${r.partCols.join(', ')}
    ORDER BY ${r.timeCol}
    MEASURES
${measures}${r.rows === 'one_per_match' ? '\n    AFTER MATCH SKIP TO NEXT ROW' : ''}
    PATTERN ${nestedPattern(r.steps, gapMode)}
    DEFINE
${defines.join(',\n')}
  )${r.rows === 'one_per_match' ? '' : `\n  QUALIFY ROW_NUMBER() OVER (PARTITION BY ${r.partCols.join(', ')} ORDER BY t1) = 1`}`;
}

/** BigQuery PIPE lowering: the funnel as `|> MATCH_RECOGNIZE` pipe operators (BigQuery
 *  pipe syntax supports MATCH_RECOGNIZE as a pipe operator), so the whole pipeline stays
 *  pipe-form. Same MEASURES/PATTERN/DEFINE semantics as the table form; the derived
 *  reached/completed/secs columns become `|> EXTEND`, the one_per_partition first-match
 *  pick becomes a ROW_NUMBER window + `|> WHERE`, and a final `|> SELECT` projects the
 *  output columns (dropping the internal t1..tn). */
export function matchStepBigQueryPipe(r, spec, catalog) {
  const preds = r.stepPreds('bigquery');
  const sym = r.steps.map((s) => `S${s.idx}`);
  const measures = [
    ...r.steps.map((s) => `    MAX(S${s.idx}.${r.timeCol}) AS t${s.idx}`),
    ...r.propCaptures.map((c) => `    MAX(${c.isColumn ? `S${c.idx}.${c.property}` : catalog.propertyExpr(r.fact, c.property, 'bigquery', { type: c.type, qualifier: `S${c.idx}` })}) AS ${c.id}`),
  ].join(',\n');
  const defines = r.steps.map((s, i) => `    ${sym[i]} AS ${preds[i]}`);
  const gapMode = gapModeFor(r);
  if (gapMode === 'single') defines.push(`    GAP AS NOT (${preds.map((p) => `(${p})`).join(' OR ')})`);
  else if (gapMode === 'perlevel') for (let i = 1; i < r.steps.length; i++) defines.push(`    G${i} AS NOT (${preds[i]})`);
  const furthestCase = r.steps.slice().reverse().map((s) => `WHEN t${s.idx} IS NOT NULL THEN '${s.name}'`).join(' ');
  const derived = [
    't1 AS first_seen_at',
    `CASE ${furthestCase} END AS furthest_step_name`,
    `(t${r.steps.length} IS NOT NULL) AS completed`,
    ...r.steps.map((s) => `(t${s.idx} IS NOT NULL) AS reached_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `TIMESTAMP_DIFF(t${m.to}, t${m.from}, SECOND) AS secs_${m.name}`),
  ];
  const outCols = [
    ...r.partCols,
    'first_seen_at', 'furthest_step_name', 'completed',
    ...r.steps.map((s) => `reached_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `secs_${m.name}`),
    ...r.propCaptures.map((c) => c.id),
  ];
  const pre = buildPrefilter(catalog, spec, 'bigquery', r.fact);
  const lines = [];
  if (pre) lines.push(`|> WHERE ${pre}`);
  lines.push(`|> MATCH_RECOGNIZE (
    PARTITION BY ${r.partCols.join(', ')}
    ORDER BY ${r.timeCol}
    MEASURES
${measures}${r.rows === 'one_per_match' ? '\n    AFTER MATCH SKIP TO NEXT ROW' : ''}
    PATTERN ${nestedPattern(r.steps, gapMode)}
    DEFINE
${defines.join(',\n')}
  )`);
  lines.push(`|> EXTEND ${derived.join(', ')}`);
  if (r.rows !== 'one_per_match') {
    // keep the earliest match per partition (parity with the table-form QUALIFY).
    lines.push(`|> EXTEND ROW_NUMBER() OVER (PARTITION BY ${r.partCols.join(', ')} ORDER BY t1) AS _mr_rn`);
    lines.push('|> WHERE _mr_rn = 1');
  }
  lines.push(`|> SELECT ${outCols.join(', ')}`);
  return lines.join('\n');
}

/** Columns the match_recognize stage exposes (for downstream stages). */
function matchOutputColumns(r) {
  const cols = new Map([['first_seen_at', { type: 'time' }], ['furthest_step_name', { type: 'string' }], ['completed', { type: 'boolean' }]]);
  for (const c of r.partCols) cols.set(c, { type: 'string' });
  for (const s of r.steps) cols.set(`reached_${s.name}`, { type: 'boolean' });
  for (const m of r.metrics.filter((x) => x.type === 'avg_seconds_between')) cols.set(`secs_${m.name}`, { type: 'numeric' });
  for (const c of r.propCaptures) cols.set(c.id, { type: c.type });
  return cols;
}

/** JSON-Schema for the match_recognize stage (steps + metrics + optional prefilter). */
/** Every relationship name the events sources declare — what `partition_by: { entity }` may name. */
function relationshipNames(catalog) {
  return [...new Set(catalog.facts.flatMap((f) => Object.keys(catalog.getModel(f).entities || {})))].sort();
}

function matchRecognizeSchema(catalog) {
  const CMP = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'];
  const stepWhere = { type: 'object', additionalProperties: false, required: ['property', 'op'], description: 'A step condition on a scalar event_data property OR an upstream pipeline column.', properties: { property: { type: 'string', pattern: NAME, description: 'A catalog event property name — reference the flattened `*_of_event_data` property DIRECTLY (no derive needed; the engine resolves it to its column or a JSON extract). Array/struct properties must be unpacked in a prior prepare (derive/unnest) stage; a column added upstream is also referenceable by its name.' }, op: { enum: CMP }, value: {} } };
  const step = { type: 'object', additionalProperties: false, required: ['event_name'], description: 'One funnel step = an event (+ optional event_data/column conditions).', properties: { name: { type: 'string', pattern: NAME, description: 'Step name (referenced by metrics).' }, event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNameEnum() }, description: 'Event(s) that satisfy this step, from the pipeline SOURCE\'s own events. An event of another source is rejected: a funnel scans ONE table.' }, where: { type: 'array', items: stepWhere, description: 'Extra conditions narrowing the step.' } } };
  const metric = { type: 'object', additionalProperties: false, required: ['name', 'type'], description: 'A metric over each match (captured as a column on the output).', properties: { name: { type: 'string', pattern: NAME }, type: { enum: ['reached', 'completed', 'conversion', 'avg_seconds_between', 'agg_at_step'] }, step: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, agg: { enum: ['sum', 'avg', 'min', 'max'] }, property: { type: 'string', pattern: NAME } } };
  return {
    type: 'object', additionalProperties: false, required: ['stage', 'steps'],
    description: 'An ordered funnel / path detector: it matches the step sequence INDEPENDENTLY within each partition, ordered by `order_by`. Output granularity is set by `rows`: one_per_partition (default) = one row per partition from its first match (counts players); one_per_match = one row per occurrence of the start step (counts situations). OUTPUT COLUMNS (all available to downstream join/where/aggregate stages): the `partition_by` column(s) are CARRIED THROUGH unchanged (e.g. the user key, so you can join dim_users after); plus first_seen_at, furthest_step_name, completed, one reached_<step> boolean per step, secs_<metric> for each avg_seconds_between metric, and one column per captured property. For funnels, conversion, and time-between-steps.',
    properties: {
      stage: { const: 'match_recognize' },
      partition_by: {
        type: 'array',
        // A catalog whose sources declare no relationship offers only the column form — the
        // { entity } branch is left out rather than carrying an empty vocabulary.
        items: oneOfOr([
          { title: 'a column', type: 'string', pattern: NAME, description: 'A column available at this point in the pipeline (an event column, or one an upstream derive/compute/join added).' },
          ...(relationshipNames(catalog).length ? [{
            title: '{ entity }', type: 'object', additionalProperties: false, required: ['entity'],
            description: 'A relationship the source DECLARES — its key column is used, so you do not have to know which physical column carries it.',
            properties: { entity: strEnum(relationshipNames(catalog), 'Name of a relationship declared by the pipeline\'s source (semantic_index({ model }) lists them).') },
          }] : []),
        ]),
        minItems: 1,
        description: 'What defines ONE independent sequence — per the task. Either column(s) available at this point, e.g. ["level_id"], or a declared relationship as { entity: "<name>" } whose key column is used, or a composite like [{ entity: "user" }, "level_id"] for one sequence per user-per-level. Defaults to the relationship this source declares toward the users model.',
      },
      order_by: { type: 'string', pattern: NAME, description: 'Column that orders events within each partition (the sequence axis). Defaults to the event time.' },
      mode: { enum: ['ordered', 'strict'], default: 'ordered', description: 'ordered = steps in order, other events may occur between them; strict = each step must be the immediately next event.' },
      rows: { enum: ['one_per_partition', 'one_per_match'], default: 'one_per_partition', description: 'one_per_partition (default) = one row per partition (e.g. per user), from its FIRST match — counts "players"; one_per_match = one row per occurrence of the sequence start (the first step) — counts "situations" (a partition can yield several; matches may overlap — a new match can start on the next row).' },
      between_steps: { enum: ['any', 'gap'], description: 'What may appear BETWEEN consecutive steps (ordered mode). "any" = the NEXT LATER occurrence of the next step — repeats of step events in between do NOT break the match (e.g. a second currency_outcome before the reward still matches). "gap" = only NON-step events may appear between steps; a repeat of any step event breaks it. Omit for the per-dialect historical default (set it explicitly for identical results across BigQuery and the local engine).' },
      filter: {
        type: 'object', additionalProperties: false, description: 'Optional event-level pre-filter applied BEFORE matching (speed; narrows the population only). To filter by USER attributes, add a join (users) + where stage before this one instead.',
        properties: {
          time_range: { type: 'object', additionalProperties: false, properties: { start: { type: 'string' }, end: { type: 'string' } }, description: 'Event-time window (ISO).' },
          event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNameEnum() }, description: 'Only scan these events (of the pipeline source).' },
          where: { type: 'array', items: stepWhere, description: 'event_data/column conditions ANDed across the scan.' },
        },
      },
      steps: { type: 'array', minItems: 2, items: step, description: 'The ordered funnel steps (>= 2).' },
      metrics: { type: 'array', items: metric, description: 'Metrics per match; defaults to a reached flag per step.' },
    },
  };
}

registerStage('match_recognize', {
  schema: (catalog) => matchRecognizeSchema(catalog),
  build: ({ d, catalog, cols, source }, p) => {
    const spec = p._resolved ? p.spec : p; // accept a stage object OR a preresolved wrapper
    const r = p._resolved || resolve(catalog, spec, d.name, cols, source);
    return {
      op: {
        op: 'match_recognize',
        // BigQuery has a native `|> MATCH_RECOGNIZE` pipe operator, so the funnel is a pipe step
        // (bqPipe below). Other engines have no MATCH_RECOGNIZE → emulated as a self-contained
        // SELECT (render), which the dialect places as one CTE of its chain.
        bqPipe: d.name === 'bigquery' ? matchStepBigQueryPipe(r, spec, catalog) : null,
        render: (prev, dn) => {
          const pre = buildPrefilter(catalog, spec, dn, r.fact);
          const fromRel = pre ? `(SELECT * FROM ${prev} WHERE ${pre})` : prev;
          return dn === 'bigquery' ? matchStepBigQuery(r, fromRel, catalog) : matchStepPostgres(r, fromRel, catalog);
        },
      },
      cols: matchOutputColumns(r),
    };
  },
});
