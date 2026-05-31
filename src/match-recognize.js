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

import yaml from 'js-yaml';
import { jsonExtract, sqlLiteral } from './dialect.js';
import { renderBaseModel } from './yaml-render.js';
import { renderPrepare } from './prepare.js';

/** Dump a sequence semantic model (+metrics) to dbt YAML, ref('...') unquoted. */
export function dumpSequenceYaml(sem) {
  const body = yaml.dump({ semantic_models: sem.semantic_models, metrics: sem.metrics }, { lineWidth: 120, noRefs: true, quotingType: '"' });
  return body.replace(/model: "(ref\('[^']+'\))"/g, 'model: $1');
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

export function stepPredicate(catalog, step, dialect, col, prepCols = new Map()) {
  const m = catalog.getModel(catalog.anchor);
  const evCol = col ? `${col}.${m.event_name.column}` : m.event_name.column;
  const dataCol = col ? `${col}.${catalog.eventDataColumn()}` : catalog.eventDataColumn();
  const names = step.event_name;
  const ev = names.length === 1 ? `${evCol} = ${sqlLiteral(names[0])}` : `${evCol} IN (${names.map(sqlLiteral).join(', ')})`;
  const props = (step.where || []).map((c) => {
    // a prepare-derived column is referenced directly (it's a real column now)
    if (prepCols.has(c.property)) {
      return comparePred(col ? `${col}.${c.property}` : c.property, c.op, c.value);
    }
    const p = (m.properties || {})[c.property];
    if (!p) throw new Error(`unknown event property in step: ${c.property}`);
    if (catalog.isComplexEventProp(c.property)) {
      throw new Error(`property '${c.property}' is array/struct; reference it via a prepare stage (derive/unnest), not directly`);
    }
    return comparePred(jsonExtract(dialect, dataCol, c.property, p.type), c.op, c.value);
  });
  return [ev, ...props].join(' AND ');
}

/**
 * WHERE clause applied to the events BEFORE the row-pattern match, to slice the
 * data scanned (speed). Returns '' when no `filter` is declared. Narrows the
 * population only — it does NOT redefine steps. Filters: event time window,
 * event_name allowlist, event_data property conditions, and a dim_users
 * user-segment SEMI-JOIN (a filter; no columns are carried into the view).
 */
export function buildPrefilter(catalog, spec, dialect, col) {
  const f = spec.filter;
  if (!f) return '';
  const m = catalog.getModel(catalog.anchor);
  const q = (c) => (col ? `${col}.${c}` : c);
  const evNameCol = q(m.event_name.column);
  const timeCol = q(m.time.column);
  const dataCol = q(catalog.eventDataColumn());
  const clauses = [];
  if (f.time_range?.start) clauses.push(`${timeCol} >= ${sqlLiteral(f.time_range.start)}`);
  if (f.time_range?.end) clauses.push(`${timeCol} <= ${sqlLiteral(f.time_range.end)}`);
  if (f.event_name?.length) clauses.push(`${evNameCol} IN (${f.event_name.map(sqlLiteral).join(', ')})`);
  for (const c of f.where || []) {
    const p = (m.properties || {})[c.property];
    if (!p) throw new Error(`unknown event property in filter.where: ${c.property}`);
    clauses.push(comparePred(jsonExtract(dialect, dataCol, c.property, p.type), c.op, c.value));
  }
  if (f.user_segment?.length) {
    // Resolve the dimension model + keys from the catalog (by the partition
    // entity), not hardcoded names. Semi-join filter; no columns are carried.
    const partEntity = spec.partition_by === 'session' ? 'session' : 'user';
    const dimKey = catalog.dimensionModelForEntity(partEntity);
    if (!dimKey) throw new Error(`filter.user_segment requires a dimension model for entity '${partEntity}'`);
    const u = catalog.getModel(dimKey);
    const entCol = q(catalog.anchorEntityColumn(partEntity));
    const usersRel = spec.usersRelation || `{{ ref('${u.dbt_model}') }}`;
    const usersKey = u.primary_entity.column;
    const conds = f.user_segment.map((c) => {
      if (!(u.dimensions || {})[c.property]) throw new Error(`unknown attribute in filter.user_segment: ${c.property}`);
      return comparePred(c.property, c.op, c.value);
    });
    clauses.push(`${entCol} IN (SELECT ${usersKey} FROM ${usersRel}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''})`);
  }
  return clauses.join(' AND ');
}

function resolve(catalog, spec, dialect) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length < 2) {
    throw new Error('sequence requires at least 2 ordered steps');
  }
  const m = catalog.getModel(catalog.anchor);
  // Partition entity (and its key column) are taken from the catalog by the
  // declared partition_by name — no hardcoded entity/column.
  const partEntity = spec.partition_by === 'session' ? 'session' : 'user';
  const partCol = m.entities?.[partEntity]?.column;
  if (!partCol) throw new Error(`anchor model has no '${partEntity}' entity to partition by`);
  const timeCol = m.time.column;
  const mode = spec.mode || 'ordered';
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

  // Columns added by the prepare pipeline (name -> { type }); referenceable in
  // step `where` and agg_at_step like any other column.
  const prepCols = renderPrepare(catalog, spec, dialect, '__base__').columns;

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
        if (catalog.isComplexEventProp(mt.property)) throw new Error(`agg_at_step: '${mt.property}' is array/struct; derive a scalar via a prepare stage first`);
        type = p.type;
      }
      out.capId = `pv_${mt.name}`;
      propCaptures.push({ id: out.capId, idx: out.idx, property: mt.property, type, isColumn });
    } else throw new Error(`unknown sequence metric type: ${mt.type}`);
    return out;
  });

  const stepPreds = (d, col) => spec.steps.map((s) => stepPredicate(catalog, s, d, col, prepCols));
  return { m, partEntity, partCol, timeCol, mode, steps, metrics: resolved, propCaptures, prepCols, stepPreds };
}

// agg names -> MetricFlow measure aggregation names.
const MF_AGG = { avg: 'average', sum: 'sum', min: 'min', max: 'max' };

function nestedPattern(steps, withGap) {
  const sym = steps.map((s) => `S${s.idx}`);
  const gap = withGap ? 'GAP* ' : '';
  const nestFrom = (i) => (i === sym.length - 1 ? `${gap}${sym[i]}` : `${gap}${sym[i]} (${nestFrom(i + 1)})?`);
  return sym.length > 1 ? `(${sym[0]} (${nestFrom(1)})?)` : `(${sym[0]})`;
}

export function renderBigQuery(catalog, spec) {
  const r = resolve(catalog, spec, 'bigquery');
  const relation = spec.relation || `{{ ref('${r.m.dbt_model}') }}`;
  const preds = r.stepPreds('bigquery', null); // for DEFINE we reference unqualified cols
  const sym = r.steps.map((s) => `S${s.idx}`);

  // MEASURES: step times t{idx} + captured property values pv_*
  const measures = [
    ...r.steps.map((s) => `    MAX(S${s.idx}.${r.timeCol}) AS t${s.idx}`),
    ...r.propCaptures.map((c) => `    MAX(${c.isColumn ? `S${c.idx}.${c.property}` : jsonExtract('bigquery', `S${c.idx}.${catalog.eventDataColumn()}`, c.property, c.type)}) AS ${c.id}`),
  ].join(',\n');

  const defines = r.steps.map((s, i) => `    ${sym[i]} AS ${preds[i]}`);
  if (r.mode !== 'strict') defines.push(`    GAP AS NOT (${preds.map((p) => `(${p})`).join(' OR ')})`);

  const outCols = r.metrics.map((mt) => `  ${bqMetricExpr(mt)} AS ${mt.name}`);
  return `-- BigQuery MATCH_RECOGNIZE sequenced-funnel metrics
SELECT
${outCols.join(',\n')}
FROM (
  SELECT * FROM ${relation} MATCH_RECOGNIZE (
    PARTITION BY ${r.partCol}
    ORDER BY ${r.timeCol}
    MEASURES
${measures}
    PATTERN ${nestedPattern(r.steps, r.mode !== 'strict')}
    DEFINE
${defines.join(',\n')}
  )
)`;
}

function bqMetricExpr(mt) {
  switch (mt.type) {
    case 'reached':
    case 'completed': return `COUNTIF(t${mt.idx} IS NOT NULL)`;
    case 'conversion': return `SAFE_DIVIDE(COUNTIF(t${mt.to} IS NOT NULL), COUNTIF(t${mt.from} IS NOT NULL))`;
    case 'avg_seconds_between': return `AVG(TIMESTAMP_DIFF(t${mt.to}, t${mt.from}, SECOND))`;
    case 'agg_at_step': return `${mt.agg}(${mt.capId})`;
    default: throw new Error(`bq metric ${mt.type}`);
  }
}

export function renderPostgres(catalog, spec) {
  const r = resolve(catalog, spec, 'postgres');
  const relation = spec.relation || `{{ ref('${r.m.dbt_model}') }}`;
  const preds = r.stepPreds('postgres', null);
  // captured property extractions live as columns in ev, carried by r{idx}
  const capByIdx = new Map();
  for (const c of r.propCaptures) {
    (capByIdx.get(c.idx) || capByIdx.set(c.idx, []).get(c.idx)).push(c);
  }
  const evExtra = r.propCaptures.map((c) => `    (${jsonExtract('postgres', catalog.eventDataColumn(), c.property, c.type)}) AS ${c.id}`);
  const evCols = [
    ...preds.map((p, i) => `    (${p}) AS is${i + 1}`),
    ...evExtra,
  ].join(',\n');

  let sql = `WITH ev AS (\n  SELECT ${r.partCol} AS pk, ${r.timeCol} AS ts,\n${evCols}\n  FROM ${relation}\n)`;

  const carried = (idx) => (capByIdx.get(idx) || []).map((c) => `, e.${c.id} AS ${c.id}`).join('');
  const carried1 = (idx) => (capByIdx.get(idx) || []).map((c) => `, ${c.id}`).join('');
  // r1: first matching row per partition; rk: first step-k row after r{k-1}
  let ctes = `r1 AS (SELECT DISTINCT ON (pk) pk, ts AS t1${carried1(1)} FROM ev WHERE is1 ORDER BY pk, ts)`;
  for (let i = 2; i <= r.steps.length; i++) {
    ctes += `,\nr${i} AS (SELECT DISTINCT ON (e.pk) e.pk, e.ts AS t${i}${carried(i)} FROM ev e JOIN r${i - 1} ON e.pk = r${i - 1}.pk WHERE e.is${i} AND e.ts > r${i - 1}.t${i - 1} ORDER BY e.pk, e.ts)`;
  }
  // one row per user with t1..tn + captured pv
  const joinSel = [
    'r1.pk',
    ...r.steps.map((s) => (s.idx === 1 ? 'r1.t1' : `r${s.idx}.t${s.idx}`)),
    ...r.propCaptures.map((c) => `r${c.idx}.${c.id}`),
  ];
  let joins = 'FROM r1';
  for (let i = 2; i <= r.steps.length; i++) joins += ` LEFT JOIN r${i} USING (pk)`;
  const perUser = `joined AS (SELECT ${joinSel.join(', ')} ${joins})`;

  const outCols = r.metrics.map((mt) => `  ${pgMetricExpr(mt)} AS ${mt.name}`);
  return `${sql},\n${ctes},\n${perUser}\nSELECT\n${outCols.join(',\n')}\nFROM joined`;
}

function pgMetricExpr(mt) {
  switch (mt.type) {
    case 'reached':
    case 'completed': return `count(t${mt.idx})`;
    case 'conversion': return `count(t${mt.to})::float / NULLIF(count(t${mt.from}), 0)`;
    case 'avg_seconds_between': return `avg(EXTRACT(EPOCH FROM (t${mt.to} - t${mt.from})))`;
    case 'agg_at_step': return `${mt.agg.toLowerCase()}(${mt.capId})`;
    default: throw new Error(`pg metric ${mt.type}`);
  }
}

export function renderSequence(catalog, spec) {
  const r = resolve(catalog, spec, 'postgres');
  return {
    mode: r.mode,
    steps: r.steps.map((s) => s.name),
    metrics: r.metrics.map((m) => m.name),
    sql_bigquery: renderBigQuery(catalog, spec),
    sql_postgres: renderPostgres(catalog, spec),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MATERIALIZED model: one ROW PER USER (furthest step, step times, completion,
// value-at-step), so a core MetricFlow semantic model can be built ON TOP of it
// (count_distinct users by furthest step, conversion ratios, avg time-between,
// JOINs to user attributes). This is the recommended pattern.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-user sequence model SELECT (Postgres) — runnable on PGlite for data tests. */
export function renderPerUserModelPostgres(catalog, spec) {
  const r = resolve(catalog, spec, 'postgres');
  // The Postgres CTE chain matches the next step at any later row (gaps always
  // allowed); it cannot enforce step adjacency. `strict` mode (contiguous match)
  // is only honored by the BigQuery MATCH_RECOGNIZE path. Reject it here rather
  // than silently returning ordered-with-gaps numbers under a strict label.
  if (r.mode === 'strict') {
    throw new Error("sequence mode 'strict' (contiguous steps) is only supported for the BigQuery MATCH_RECOGNIZE target, not the Postgres equivalent");
  }
  const relation = spec.relation || `{{ ref('${r.m.dbt_model}') }}`;
  const preds = r.stepPreds('postgres', null);
  const capByIdx = new Map();
  for (const c of r.propCaptures) { if (!capByIdx.has(c.idx)) capByIdx.set(c.idx, []); capByIdx.get(c.idx).push(c); }
  const evExtra = r.propCaptures.map((c) => `    (${c.isColumn ? c.property : jsonExtract('postgres', catalog.eventDataColumn(), c.property, c.type)}) AS ${c.id}`);
  const evCols = [...preds.map((p, i) => `    (${p}) AS is${i + 1}`), ...evExtra].join(',\n');
  const pre = buildPrefilter(catalog, spec, 'postgres', null);
  // prepare pipeline (unnest/derive ...) chains CTEs from the (prefiltered) base.
  const baseForPrep = pre ? `(SELECT * FROM ${relation} WHERE ${pre})` : relation;
  const prep = renderPrepare(catalog, spec, 'postgres', baseForPrep);
  const prepCte = prep.ctes.map((c) => `${c.name} AS (\n  ${c.sql}\n)`).join(',\n');
  let sql = `WITH ${prep.ctes.length ? `${prepCte},\n` : ''}ev AS (\n  SELECT ${r.partCol} AS pk, ${r.timeCol} AS ts,\n${evCols}\n  FROM ${prep.relation}\n)`;
  const carried1 = (idx) => (capByIdx.get(idx) || []).map((c) => `, ${c.id}`).join('');
  const carried = (idx) => (capByIdx.get(idx) || []).map((c) => `, e.${c.id} AS ${c.id}`).join('');
  let ctes = `r1 AS (SELECT DISTINCT ON (pk) pk, ts AS t1${carried1(1)} FROM ev WHERE is1 ORDER BY pk, ts)`;
  for (let i = 2; i <= r.steps.length; i++) {
    ctes += `,\nr${i} AS (SELECT DISTINCT ON (e.pk) e.pk, e.ts AS t${i}${carried(i)} FROM ev e JOIN r${i - 1} ON e.pk = r${i - 1}.pk WHERE e.is${i} AND e.ts > r${i - 1}.t${i - 1} ORDER BY e.pk, e.ts)`;
  }
  const sel = ['r1.pk', ...r.steps.map((s) => (s.idx === 1 ? 'r1.t1' : `r${s.idx}.t${s.idx}`)), ...r.propCaptures.map((c) => `r${c.idx}.${c.id}`)];
  let joins = 'FROM r1';
  for (let i = 2; i <= r.steps.length; i++) joins += ` LEFT JOIN r${i} USING (pk)`;
  // per-user output columns (already qualified with j.; aliases left untouched)
  const furthestCase = r.steps.slice().reverse().map((s) => `WHEN j.t${s.idx} IS NOT NULL THEN '${s.name}'`).join(' ');
  // The view exposes ONLY sequence-derived columns. User attributes are NOT
  // joined here; the semantic model declares a shared `user` entity so MetricFlow
  // joins dim_users at SQL-generation time when a query groups by a user attr.
  const out = [
    `  j.pk AS ${r.partCol}`,
    '  , j.t1 AS first_seen_at',
    `  , CASE ${furthestCase} END AS furthest_step_name`,
    `  , (j.t${r.steps.length} IS NOT NULL) AS completed`,
    ...r.steps.map((s) => `  , (j.t${s.idx} IS NOT NULL) AS reached_${s.name}`),
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `  , EXTRACT(EPOCH FROM (j.t${m.to} - j.t${m.from})) AS secs_${m.name}`),
    ...r.propCaptures.map((c) => `  , j.${c.id}`),
  ];
  return `${sql},\n${ctes},\njoined AS (SELECT ${sel.join(', ')} ${joins})\nSELECT\n${out.join('\n')}\nFROM joined j`;
}

/** Per-user sequence model SELECT (BigQuery MATCH_RECOGNIZE) — production target. */
export function renderPerUserModelBigQuery(catalog, spec) {
  const r = resolve(catalog, spec, 'bigquery');
  const relation = spec.relation || `{{ ref('${r.m.dbt_model}') }}`;
  const preds = r.stepPreds('bigquery', null);
  const sym = r.steps.map((s) => `S${s.idx}`);
  // MEASURES must be aggregates (one row per match). CLASSIFIER() is NOT allowed
  // bare here; we derive furthest_step_name in the outer SELECT from the
  // per-step reached flags (t{idx} IS NOT NULL), exactly like the Postgres path.
  const measures = [
    ...r.steps.map((s) => `    MAX(S${s.idx}.${r.timeCol}) AS t${s.idx}`),
    ...r.propCaptures.map((c) => `    MAX(${c.isColumn ? `S${c.idx}.${c.property}` : jsonExtract('bigquery', `S${c.idx}.${catalog.eventDataColumn()}`, c.property, c.type)}) AS ${c.id}`),
  ].join(',\n');
  const defines = r.steps.map((s, i) => `    ${sym[i]} AS ${preds[i]}`);
  if (r.mode !== 'strict') defines.push(`    GAP AS NOT (${preds.map((p) => `(${p})`).join(' OR ')})`);
  // furthest = highest-index step whose time is present (steps are strictly ordered).
  const furthestCase = r.steps.slice().reverse().map((s) => `WHEN t${s.idx} IS NOT NULL THEN '${s.name}'`).join(' ');
  const reached = r.steps.map((s) => `    t${s.idx} IS NOT NULL AS reached_${s.name}`);
  const secs = r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => `    TIMESTAMP_DIFF(t${m.to}, t${m.from}, SECOND) AS secs_${m.name}`);
  // The view exposes ONLY sequence-derived columns. User attributes are NOT
  // joined here; the semantic model declares a shared `user` entity so MetricFlow
  // joins dim_users at SQL-generation time when a query groups by a user attr.
  const pre = buildPrefilter(catalog, spec, 'bigquery', null);
  const baseForPrep = pre ? `(SELECT * FROM ${relation} WHERE ${pre})` : relation;
  const prep = renderPrepare(catalog, spec, 'bigquery', baseForPrep);
  const withCte = prep.ctes.length ? `WITH ${prep.ctes.map((c) => `${c.name} AS (\n  ${c.sql}\n)`).join(',\n')}\n` : '';
  return `${withCte}  SELECT
    ${r.partCol},
    t1 AS first_seen_at,
    CASE ${furthestCase} END AS furthest_step_name,
    t${r.steps.length} IS NOT NULL AS completed,
${[...reached, ...secs, ...r.propCaptures.map((c) => `    ${c.id}`)].join(',\n')}
  FROM ${prep.relation} MATCH_RECOGNIZE (
    PARTITION BY ${r.partCol}
    ORDER BY ${r.timeCol}
    MEASURES
${measures}
    ONE ROW PER MATCH
    AFTER MATCH SKIP PAST LAST ROW
    PATTERN ${nestedPattern(r.steps, r.mode !== 'strict')}
    DEFINE
${defines.join(',\n')}
  )`;
}

/**
 * Core semantic-model declaration (measures/dimensions/metrics) OVER the
 * materialized per-user model `modelName`. user is the primary entity (one row
 * per user) → joins to dim_users; furthest_step_name is a dimension.
 */
export function sequenceSemanticModel(catalog, spec, modelName) {
  const r = resolve(catalog, spec, 'postgres');
  const measures = [
    { name: 'users', agg: 'count', expr: '1' },
    ...r.steps.map((s) => ({ name: `reached_${s.name}`, agg: 'sum_boolean', expr: `reached_${s.name}` })),
    { name: 'completed', agg: 'sum_boolean', expr: 'completed' },
    ...r.metrics.filter((m) => m.type === 'avg_seconds_between').map((m) => ({ name: m.name, agg: 'average', expr: `secs_${m.name}` })),
    ...r.metrics.filter((m) => m.type === 'agg_at_step').map((m) => ({ name: m.name, agg: MF_AGG[m.agg.toLowerCase()] || m.agg.toLowerCase(), expr: m.capId })),
  ];
  const dedupMeasures = [...new Map(measures.map((mm) => [mm.name, mm])).values()];
  // The view exposes ONLY its own (sequence-derived) columns as dimensions.
  // User attributes live on dim_users and are reached by JOIN at the semantic
  // layer (see below) — they are NOT baked into the view.
  const dims = [
    { name: 'first_seen', type: 'time', type_params: { time_granularity: 'day' }, expr: 'first_seen_at' },
    { name: 'furthest_step_name', type: 'categorical' },
  ];
  // The view's primary entity and its key column are the partition entity and
  // its anchor key column — both resolved from the catalog (no hardcoded
  // 'user'/'appsflyer_id'). The key column carried into the view is r.partCol.
  const sm = {
    name: modelName,
    model: `ref('${modelName}')`,
    defaults: { agg_time_dimension: 'first_seen' },
    entities: [{ name: r.partEntity, type: 'primary', expr: r.partCol }],
    dimensions: dims,
    measures: dedupMeasures.map((mm) => ({ name: mm.name, agg: mm.agg, expr: mm.expr, agg_time_dimension: 'first_seen' })),
  };
  const localDimensionNames = ['furthest_step_name'];

  // Joinable dimension semantic model: the model whose PRIMARY entity is the
  // partition entity (resolved from the catalog) shares that entity with the
  // view, so MetricFlow performs the attribute join during SQL generation. The
  // join is declared, not materialized in the view.
  const semantic_models = [sm];
  const userAttrNames = [];
  const dimKey = catalog.dimensionModelForEntity(r.partEntity);
  if (dimKey) {
    semantic_models.push(renderBaseModel(catalog, dimKey));
    for (const name of Object.keys(catalog.getModel(dimKey).dimensions || {})) userAttrNames.push(name);
  }
  const dimensionNames = [...localDimensionNames, ...userAttrNames];

  // metrics: simple per measure + ratios for declared conversions
  const metricNames = [];
  const metrics = [];
  const addSimple = (name) => { if (!metricNames.includes(name)) { metrics.push({ name, label: name, type: 'simple', type_params: { measure: { name } } }); metricNames.push(name); } };
  for (const mm of dedupMeasures) addSimple(mm.name);
  for (const m of r.metrics) {
    if (m.type === 'conversion') {
      metrics.push({ name: m.name, label: m.name, type: 'ratio', type_params: { numerator: { name: `reached_${spec.steps[m.to - 1].name}` }, denominator: { name: `reached_${spec.steps[m.from - 1].name}` } } });
      metricNames.push(m.name);
    }
  }
  return { semantic_models, metrics, metricNames, dimensionNames, localDimensionNames, userAttrNames, entity: r.partEntity, groupable: ['metric_time', ...dimensionNames] };
}
