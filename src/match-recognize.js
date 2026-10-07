// Sequenced-funnel / path engine: we generate the query OURSELVES from the
// declared ordered steps (MetricFlow can't express row-pattern sequences).
// Target = BigQuery MATCH_RECOGNIZE (per docs); a DuckDB equivalent is also
// emitted purely so funnel NUMBERS can be asserted on data.
//
// One row per partition (or per match) with, for every step, whether it was
// reached (reached_<step>) and when (at_<step>), and each `capture` — the value
// a column held at a step. What is computed FROM them — a conversion, the time
// between two steps — is the stages after it (compute date_diff, aggregate).
// A step is an event + conditions in the one condition grammar every where takes.
//
// BigQuery specifics honored: one-row-per-match (no ONE ROW PER MATCH / AFTER
// MATCH SKIP keywords), nested PATTERN enforces step order, GAP = any non-step
// row, CLASSIFIER/aggregates in MEASURES.

import { timeRangeConditions, isValidTimezone } from './time-range.js';
import { registerStage } from './pipeline.js';
import { getDialect } from './dialects/index.js';
import { comparison, typedAs, conditionsSql, eachCondition } from './conditions.js';
import { anyOfOr, strEnum } from './schema-kit.js';
import { condPred, CONDITIONS } from './pipeline/sql.js';

const NAME = '^[a-z][a-z0-9_]{0,40}$';

/** A step's or the prefilter's comparison, its constants written in the type of what they are
 *  compared with (src/conditions.js: a flag spelled "true" is TRUE, a number spelled "5" is 5). */
const comparePred = (lhs, op, value, type = null, name = lhs) => comparison(lhs, op, value, { lit: typedAs(type, name) });

/** The type of a model column, as the catalog declares it. */
const columnType = (catalog, source, name) => catalog.modelColumns(source).find((x) => x.name === name)?.type || null;

/** Step/prefilter event names, normalized to the SOURCE fact's physical values. A
 *  row-pattern match scans ONE table, so an event of another fact cannot participate. */
const factEventNames = (catalog, source, names) => (names || []).map((n) => catalog.eventNameFor(source, n, {
  hint: 'a funnel runs over ONE fact, so start the pipeline from the fact that owns the event',
}));

export function stepPredicate(catalog, step, dialect, prepCols = new Map(), source) {
  const m = catalog.getModel(source);
  const d = getDialect(dialect);
  // Unqualified, for the same reason buildPrefilter is: the predicate applies to the single
  // relation the pattern scans.
  const evCol = d.quoteIdent(m.event_name.column);
  const names = factEventNames(catalog, source, step.event_name);
  const ev = names.length === 1 ? comparison(evCol, 'eq', names[0]) : comparison(evCol, 'in', names);
  // the one condition grammar of every where: a column of the rows here, or an expression (an event
  // property read with event_property) — compared in its own type
  const props = conditionsSql(step.where, (c) => condPred(d, prepCols, c, { windows: false, catalog, source }));
  return [ev, ...props].join(' AND ');
}

/**
 * A DRAFT KEPT FROM AN EARLIER VERSION may carry `filter` — a where applied to the events BEFORE the
 * row-pattern match; it is built as it was (this version writes a where stage before the funnel).
 * Returns '' when no `filter` is declared. Narrows the
 * population only — it does NOT redefine steps. Event-level filters: time window,
 * event_name allowlist, event_data property conditions. To filter by USER
 * attributes, add a `join` (users) + `where` stage before match_recognize.
 *
 * Columns are referenced UNQUALIFIED: the filter always applies to the one relation being scanned,
 * and a payload property is rendered by `catalog.propertyExpr`, which has no qualifier of its own —
 * so a qualifier here would reach half the clauses and silently skip the rest.
 */
export function buildPrefilter(catalog, spec, dialect, source, { partitionCol = null } = {}) {
  const f = spec.filter;
  if (!f) return '';
  const m = catalog.getModel(source);
  const evNameCol = m.event_name.column;
  const clauses = [];
  // the window by the one rule every stage applies (a timezone's wall-clock bounds, the whole last day
  // of a date-only end), and the partition column only where the scanned relation still carries it
  if (f.time_range?.timezone && !isValidTimezone(f.time_range.timezone)) throw new Error(`filter.time_range: unknown timezone '${f.time_range.timezone}' — use an IANA name like 'Europe/Berlin' or 'UTC'`);
  for (const c of timeRangeConditions(m, f.time_range, { partition: !!partitionCol }) || []) clauses.push(comparePred(c.column, c.op, c.value));
  if (f.event_name?.length) clauses.push(comparison(evNameCol, 'in', factEventNames(catalog, source, f.event_name)));
  const modelCols = new Set(catalog.modelColumns(source).map((x) => x.name));
  clauses.push(...conditionsSql(f.where, (c) => {
    const p = (m.properties || {})[c.property];
    if (!p) {
      // physical model column (e.g. bundle_id) → direct comparison; no separate where needed.
      if (modelCols.has(c.property)) return comparePred(c.property, c.op, c.value, columnType(catalog, source, c.property));
      throw new Error(`unknown event property or column in filter.where: ${c.property}`);
    }
    return comparePred(catalog.propertyExpr(source, c.property, dialect, { type: p.type }), c.op, c.value, p.type, c.property);
  }));
  return clauses.join(' AND ');
}

/**
 * The SOURCE columns a funnel reads — the event name, the ordering axis, and the physical column
 * behind every property a step or the prefilter tests — must still be AVAILABLE where the stage
 * stands. After a stage that changed the grain (an aggregate, a pivot), or on top of a materialized
 * prefix built from one, the rows are no longer that source's events: there is no sequence to
 * search, and the pattern would reference columns the relation does not have. Refused here, naming
 * what dropped out, instead of as a warehouse error after the build.
 */
function requireSourceColumns(catalog, spec, source, availableCols) {
  const m = catalog.getModel(source);
  const need = new Map(); // physical column -> what reads it
  const want = (col, why) => { if (col && !need.has(col)) need.set(col, why); };
  want(m.event_name?.column, 'the event name');
  want(spec.order_by || m.time?.column, 'the sequence order');
  // (a step's own conditions name columns of the rows here, checked as they are written; a kept
  // draft's prefilter names properties, whose backing column must be here)
  eachCondition(spec.filter?.where, (c) => {
    if (availableCols.has(c.property)) return;
    if ((m.properties || {})[c.property]) want(catalog.propertyBackingColumn(source, c.property), `property '${c.property}'`);
  });
  const missing = [...need].filter(([col]) => !availableCols.has(col));
  if (!missing.length) return;
  throw new Error(
    `match_recognize reads ${missing.map(([col, why]) => `${why} ('${col}')`).join(', ')} of '${source}', not available at this stage `
    + `(available: ${[...availableCols.keys()].join(', ')}) — these rows are no longer that source's events, so there is no sequence to search. `
    + `Put the funnel BEFORE the stage that dropped them (a funnel over a materialized prefix works only while that prefix still carries the event columns).`,
  );
}

function resolve(catalog, spec, dialect, availableCols, source) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length < 2) {
    throw new Error('sequence requires at least 2 ordered steps');
  }
  if (!catalog.isFact(source)) {
    throw new Error(`match_recognize needs an events fact as the pipeline source; '${source}' is not one (facts: ${catalog.facts.join(', ')})`);
  }
  const m = catalog.getModel(source);
  // Partition key is FLEXIBLE: the caller chooses any column(s) available at this point in the
  // pipeline (event columns, or ones added by upstream compute/join), or names a
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
  requireSourceColumns(catalog, spec, source, availableCols);
  // Order key (the sequence axis): caller may override; defaults to the event time.
  const timeCol = spec.order_by || m.time.column;
  const mode = spec.mode || 'ordered';
  // What may appear BETWEEN consecutive steps (ordered mode only):
  //  - 'any' : any rows, including repeats of step events — i.e. "the next later
  //            occurrence of step i+1", repeats don't break the match.
  //  - 'gap' : only non-step events; a repeat of any step event breaks/advances.
  //  Unset = each dialect's historical default (DuckDB ~ 'any', BigQuery ~ 'gap');
  //  set it explicitly for identical semantics across engines.
  const betweenSteps = spec.between_steps || null;
  const steps = spec.steps.map((s, i) => ({ idx: i + 1, name: s.name || `s${i + 1}` }));
  const byName = new Map(steps.map((s) => [s.name, s]));
  const stepIdx = (name) => {
    const s = byName.get(name);
    if (!s) throw new Error(`metric references unknown step '${name}'`);
    return s.idx;
  };

  // Real columns referenceable in a step's conditions and a capture: the columns the stages before
  // this one produced.
  const prepCols = availableCols;

  // each capture: the value a column holds at a step, as a column of its own
  const propCaptures = []; // { id, idx, column, type, isColumn }
  const names = new Set(steps.flatMap((s) => [`reached_${s.name}`, `at_${s.name}`]));
  for (const c of spec.capture || []) {
    if (names.has(c.name)) throw new Error(`capture '${c.name}': the funnel already outputs a column of that name — name it otherwise`);
    names.add(c.name);
    if (!prepCols.has(c.column)) throw new Error(`capture '${c.name}': '${c.column}' is not a column at this stage (available: ${[...prepCols.keys()].join(', ')}) — an event property is read into a column first, with a compute stage (event_property)`);
    propCaptures.push({ id: c.name, idx: stepIdx(c.step), property: c.column, type: prepCols.get(c.column)?.type || 'unknown', isColumn: true });
  }
  // A DRAFT KEPT FROM AN EARLIER VERSION may carry `metrics`: it builds the columns it built then —
  // secs_<name> for a time between two steps, pv_<name> for a property's value at a step (the other
  // metric types added no column of their own)
  const metrics = [];
  for (const mt of spec.metrics || []) {
    if (mt.type === 'avg_seconds_between') metrics.push({ name: mt.name, type: mt.type, from: stepIdx(mt.from), to: stepIdx(mt.to) });
    else if (mt.type === 'agg_at_step') {
      const idx = stepIdx(mt.step);
      let type; const isColumn = prepCols.has(mt.property);
      if (isColumn) type = prepCols.get(mt.property).type;
      else {
        const p = (m.properties || {})[mt.property];
        if (!p) throw new Error(`agg_at_step: unknown property '${mt.property}'`);
        if (catalog.isComplexEventProp(mt.property, source)) throw new Error(`agg_at_step: '${mt.property}' is array/struct; compute a scalar from it in a prepare stage first`);
        type = p.type;
      }
      propCaptures.push({ id: `pv_${mt.name}`, idx, property: mt.property, type, isColumn });
    } else if (!['reached', 'completed', 'conversion'].includes(mt.type)) throw new Error(`unknown sequence metric type: ${mt.type}`);
  }

  const stepPreds = (d) => spec.steps.map((s) => stepPredicate(catalog, s, d, prepCols, source));
  const rows = spec.rows || 'one_per_partition';
  // the source's day partition column, when the rows here still carry it: the prefilter's window bounds it too
  const partitionCol = m.partition_column && m.partition_column !== timeCol && (!availableCols || availableCols.has(m.partition_column)) ? m.partition_column : null;
  return { m, fact: source, partCols, timeCol, partitionCol, mode, betweenSteps, steps, rows, metrics, propCaptures, prepCols, stepPreds };
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

/**
 * The lowering for an engine without MATCH_RECOGNIZE (DuckDB): a single SELECT (nested WITH
 * ev/r1..rn/joined) over fromRel, in the dialect `dialectName`.
 */
export function matchStepCte(r, fromRel, catalog, dialectName) {
  const d = getDialect(dialectName);
  if (r.mode === 'strict') {
    throw new Error("sequence mode 'strict' (contiguous steps) is only supported for the BigQuery MATCH_RECOGNIZE target, not the CTE equivalent other warehouses run");
  }
  const preds = r.stepPreds(dialectName);
  const capByIdx = new Map();
  for (const c of r.propCaptures) { if (!capByIdx.has(c.idx)) capByIdx.set(c.idx, []); capByIdx.get(c.idx).push(c); }
  const evExtra = r.propCaptures.map((c) => `    (${c.isColumn ? d.quoteIdent(c.property) : catalog.propertyExpr(r.fact, c.property, dialectName, { type: c.type })}) AS ${c.id}`);
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
    ...r.steps.map((s) => `j.t${s.idx} AS at_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `${d.secondsBetween(`j.t${m.from}`, `j.t${m.to}`)} AS secs_${m.name}`),
    ...r.propCaptures.map((c) => `j.${c.id}`),
  ];
  return `WITH ${ctes.map((c) => `${c.name} AS (\n  ${c.sql}\n)`).join(',\n')}\nSELECT\n  ${outCols.join(',\n  ')}\nFROM joined j`;
}

/** BigQuery lowering: the funnel as `|> MATCH_RECOGNIZE` pipe operators (BigQuery pipe syntax
 *  supports MATCH_RECOGNIZE as a pipe operator), so the whole pipeline stays pipe-form. The derived
 *  reached/completed/secs columns become `|> EXTEND` and a final `|> SELECT` projects the output
 *  columns (dropping the internal t1..tn). `rows`, numerically consistent with the CTE lowering:
 *  - one_per_match: `AFTER MATCH SKIP TO NEXT ROW`, so a new match can begin on the very next row —
 *    every occurrence of the start step yields a match (overlapping matches), as in the CTE lowering
 *    (BigQuery's default, AFTER MATCH SKIP PAST LAST ROW, gives non-overlapping ones);
 *  - one_per_partition: BigQuery's default skip, and the first match per partition by a ROW_NUMBER
 *    window + `|> WHERE` — the earliest start's match, whatever the skip mode. */
export function matchStepBigQueryPipe(r, spec, catalog) {
  const d = getDialect('bigquery');
  const preds = r.stepPreds('bigquery');
  const sym = r.steps.map((s) => `S${s.idx}`);
  const measures = [
    ...r.steps.map((s) => `    MAX(S${s.idx}.${r.timeCol}) AS t${s.idx}`),
    ...r.propCaptures.map((c) => `    MAX(${c.isColumn ? `S${c.idx}.${d.quoteIdent(c.property)}` : catalog.propertyExpr(r.fact, c.property, 'bigquery', { type: c.type, qualifier: `S${c.idx}` })}) AS ${c.id}`),
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
    ...r.steps.map((s) => `t${s.idx} AS at_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `${d.secondsBetween(`t${m.from}`, `t${m.to}`)} AS secs_${m.name}`),
  ];
  const outCols = [
    ...r.partCols,
    'first_seen_at', 'furthest_step_name', 'completed',
    ...r.steps.map((s) => `reached_${s.name}`),
    ...r.steps.map((s) => `at_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `secs_${m.name}`),
    ...r.propCaptures.map((c) => c.id),
  ];
  const pre = buildPrefilter(catalog, spec, 'bigquery', r.fact, { partitionCol: r.partitionCol });
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
  for (const s of r.steps) cols.set(`at_${s.name}`, { type: 'time' });
  for (const m of r.metrics.filter((x) => x.type === 'avg_seconds_between')) cols.set(`secs_${m.name}`, { type: 'numeric' });
  for (const c of r.propCaptures) cols.set(c.id, { type: c.type });
  return cols;
}

/** Every relationship name the events sources declare — what `partition_by: { entity }` may name. */
function relationshipNames(catalog) {
  return [...new Set(catalog.facts.flatMap((f) => Object.keys(catalog.getModel(f).entities || {})))].sort();
}

/** JSON-Schema for the match_recognize stage: ordered steps, and the values to capture at them. */
function matchRecognizeSchema(catalog) {
  const step = {
    type: 'object', additionalProperties: false, required: ['event_name'],
    description: 'One funnel step: an event, and optionally conditions the row must meet.',
    properties: {
      name: { type: 'string', pattern: NAME, description: 'Step name — its output columns are reached_<name> and at_<name> (default s1, s2, …).' },
      event_name: { type: 'array', minItems: 1, uniqueItems: true, items: strEnum(catalog.eventNameEnum()), description: 'Event(s) that satisfy this step, of the pipeline\'s own source (a funnel scans one table).' },
      where: CONDITIONS('Conditions the step\'s row meets as well — on columns here, or an event property ({ left: { fn: "event_property", property }, op, value }).'),
    },
  };
  const capture = {
    type: 'object', additionalProperties: false, required: ['name', 'step', 'column'],
    properties: {
      name: { type: 'string', pattern: NAME, description: 'The output column it becomes.' },
      step: { type: 'string', pattern: NAME, description: 'The step whose row it is read from.' },
      column: { type: 'string', pattern: NAME, description: 'A column here (an event property is read into one by a compute stage before).' },
    },
  };
  return {
    type: 'object', additionalProperties: false, required: ['stage', 'steps'],
    description: 'An ordered funnel / path: matches the steps in order within each partition (per user by default), ordered by `order_by`. Out: the partition_by column(s), then for each step reached_<step> (boolean) and at_<step> (when), completed, furthest_step_name, first_seen_at (= the first step\'s time), and each capture. A conversion or the time between two steps is computed from those by the stages after (aggregate count_if-style measures with `where`, compute date_diff). Filter the events before it with a where stage.',
    properties: {
      stage: { enum: ['match_recognize'] },
      partition_by: {
        type: 'array',
        // A catalog whose sources declare no relationship offers only the column form — the
        // { entity } branch is left out rather than carrying an empty vocabulary.
        items: anyOfOr([
          { title: 'a column', type: 'string', pattern: NAME, description: 'A column available here.' },
          ...(relationshipNames(catalog).length ? [{
            title: '{ entity }', type: 'object', additionalProperties: false, required: ['entity'],
            description: 'A relationship the source declares — its key column is used.',
            properties: { entity: strEnum(relationshipNames(catalog)) },
          }] : []),
        ]),
        minItems: 1,
        description: 'What one sequence is: column(s), a declared relationship { entity }, or both (one sequence per user per level). Default: the source\'s relationship toward the users model.',
      },
      order_by: { type: 'string', pattern: NAME, description: 'The sequence axis (default: the event time).' },
      mode: { enum: ['ordered', 'strict'], default: 'ordered', description: 'ordered = other events may occur between steps; strict = each step is the immediately next event.' },
      rows: { enum: ['one_per_partition', 'one_per_match'], default: 'one_per_partition', description: 'one_per_partition = the first match per partition (counts players); one_per_match = one row per occurrence of the first step (counts situations; matches may overlap).' },
      between_steps: { enum: ['any', 'gap'], description: '"any" = the next later occurrence of the next step, repeats in between allowed; "gap" = only non-step events between steps. Set it for identical results on every warehouse.' },
      steps: { type: 'array', minItems: 2, items: step, description: 'The ordered steps (≥ 2).' },
      capture: { type: 'array', items: capture, description: 'Values to carry out of the match: the value a column holds at a step.' },
    },
  };
}

registerStage('match_recognize', {
  schema: (catalog) => matchRecognizeSchema(catalog),
  recommend: () => ["The funnel columns (reached_<step>, at_<step>, completed, furthest_step_name, the captures) plus the carried partition key(s) are now available — join 'users' or aggregate to slice conversion (e.g. by country)."],
  build: ({ d, catalog, cols, source }, p) => {
    const spec = p;
    const r = resolve(catalog, spec, d.name, cols, source);
    return {
      op: {
        op: 'match_recognize',
        // BigQuery has a native `|> MATCH_RECOGNIZE` pipe operator, so the funnel is a pipe step
        // (bqPipe). DuckDB has no MATCH_RECOGNIZE → emulated as a self-contained SELECT (render),
        // which its dialect places as one CTE of its chain.
        bqPipe: d.name === 'bigquery' ? matchStepBigQueryPipe(r, spec, catalog) : null,
        render: (prev, dn) => {
          const pre = buildPrefilter(catalog, spec, dn, r.fact, { partitionCol: r.partitionCol });
          return matchStepCte(r, pre ? `(SELECT * FROM ${prev} WHERE ${pre})` : prev, catalog, dn);
        },
      },
      cols: matchOutputColumns(r),
    };
  },
});
