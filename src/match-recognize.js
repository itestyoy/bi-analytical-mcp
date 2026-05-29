// Sequenced-funnel / path engine: we generate the query OURSELVES from the
// declared ordered steps (MetricFlow can't express row-pattern sequences).
//
// Target = BigQuery MATCH_RECOGNIZE (per the docs). BigQuery specifics honored:
//   - one row per match (NO `ONE ROW PER MATCH` / `AFTER MATCH SKIP` keywords);
//   - MEASURES must be aliased; CLASSIFIER()/MATCH_NUMBER()/MATCH_ROW_NUMBER()
//     are the special functions; final (one-row-per-match) semantics;
//   - JSON access is JSON_VALUE(event_data, '$.key') (handled via dialect);
//   - quantifiers + * ? ; every PATTERN symbol is DEFINEd (we don't rely on
//     undefined-symbol or reluctant-quantifier behavior — a "gap" symbol is
//     defined as "not a later step", so greedy * is safe).
//
// We also emit a Postgres-equivalent (same params) ONLY so the funnel numbers
// can be asserted on data in the PGlite test harness (BigQuery isn't available
// there). Production target is BigQuery.

import { jsonExtract, sqlLiteral } from './dialect.js';

/** SQL boolean for one step under a given dialect: event_name (+ property conds). */
export function stepPredicate(catalog, step, dialect) {
  const m = catalog.getModel(catalog.anchor);
  const evCol = m.event_name.column;
  const names = step.event_name;
  const ev = names.length === 1
    ? `${evCol} = ${sqlLiteral(names[0])}`
    : `${evCol} IN (${names.map(sqlLiteral).join(', ')})`;
  const props = (step.where || []).map((c) => {
    const p = (m.properties || {})[c.property];
    if (!p) throw new Error(`unknown event property in step: ${c.property}`);
    const lhs = jsonExtract(dialect, catalog.eventDataColumn(), c.property, p.type);
    const arr = Array.isArray(c.value) ? c.value : [c.value];
    switch (c.op) {
      case 'eq': return `${lhs} = ${sqlLiteral(c.value)}`;
      case 'neq': return `${lhs} != ${sqlLiteral(c.value)}`;
      case 'gt': return `${lhs} > ${sqlLiteral(c.value)}`;
      case 'gte': return `${lhs} >= ${sqlLiteral(c.value)}`;
      case 'lt': return `${lhs} < ${sqlLiteral(c.value)}`;
      case 'lte': return `${lhs} <= ${sqlLiteral(c.value)}`;
      case 'in': return `${lhs} IN (${arr.map(sqlLiteral).join(', ')})`;
      case 'not_in': return `${lhs} NOT IN (${arr.map(sqlLiteral).join(', ')})`;
      default: throw new Error(`unsupported step where op: ${c.op}`);
    }
  });
  return [ev, ...props].join(' AND ');
}

function resolve(catalog, spec, dialect) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length < 2) {
    throw new Error('sequence requires at least 2 ordered steps');
  }
  const m = catalog.getModel(catalog.anchor);
  const userCol = m.entities?.user?.column || 'user_id';
  const sessionCol = m.entities?.session?.column;
  const partCol = spec.partition_by === 'session'
    ? (sessionCol || (() => { throw new Error('no session entity in catalog'); })())
    : userCol;
  const timeCol = m.time.column;
  const mode = spec.mode || 'ordered'; // 'ordered' (gaps allowed) | 'strict' (adjacent)
  const steps = spec.steps.map((s, i) => ({
    name: s.name || `s${i + 1}`,
    pred: stepPredicate(catalog, s, dialect),
  }));
  return { m, partCol, timeCol, mode, steps };
}

/**
 * BigQuery MATCH_RECOGNIZE: one row per matching user, CLASSIFIER() = furthest
 * step reached; grouped to users-per-furthest-step. reached_k = sum of users at
 * steps >= k (cumulative downstream).
 */
export function renderBigQuery(catalog, spec) {
  const { m, partCol, timeCol, mode, steps } = resolve(catalog, spec, 'bigquery');
  const relation = spec.relation || `\`${m.dbt_model}\``;
  const sym = steps.map((_, i) => `S${i + 1}`);
  const withGap = mode !== 'strict';
  const gap = withGap ? 'GAP* ' : '';

  // NESTED optional pattern enforces ORDER: a later step is only reachable inside
  // the match of the previous one, so skipping a step caps the furthest reached
  // (e.g. S1 then S3 without S2 => furthest = S1, not S3). 'ordered' allows
  // non-step rows between steps via a GAP filler; 'strict' requires adjacency.
  const nestFrom = (i) => (i === sym.length - 1
    ? `${gap}${sym[i]}`
    : `${gap}${sym[i]} (${nestFrom(i + 1)})?`);
  const pattern = sym.length > 1 ? `(${sym[0]} (${nestFrom(1)})?)` : `(${sym[0]})`;

  const defines = steps.map((s, i) => `    ${sym[i]} AS ${s.pred}`);
  if (withGap) {
    // GAP = a non-step row (filler), so greedy GAP* never swallows a step symbol.
    const anyStep = steps.map((s) => `(${s.pred})`).join(' OR ');
    defines.push(`    GAP AS NOT (${anyStep})`);
  }

  const caseFurthest = steps.map((s, i) => `WHEN '${sym[i]}' THEN ${i + 1}`).join(' ');
  return `-- BigQuery MATCH_RECOGNIZE: users by furthest funnel step reached
SELECT
  furthest_step_idx,
  furthest_step_name,
  COUNT(*) AS users
FROM (
  SELECT
    *,
    CASE classifier ${caseFurthest} END AS furthest_step_idx,
    CASE classifier ${steps.map((s, i) => `WHEN '${sym[i]}' THEN '${s.name}'`).join(' ')} END AS furthest_step_name
  FROM ${relation} MATCH_RECOGNIZE (
    PARTITION BY ${partCol}
    ORDER BY ${timeCol}
    MEASURES CLASSIFIER() AS classifier
    PATTERN ${pattern}
    DEFINE
${defines.join(',\n')}
  )
)
GROUP BY furthest_step_idx, furthest_step_name
ORDER BY furthest_step_idx`;
}

/**
 * Postgres equivalent (for data tests only). Single row with reached_<step>
 * counts. mode 'ordered' = sequential min-time chain; 'strict' = LEAD adjacency.
 */
export function renderPostgres(catalog, spec) {
  const { m, partCol, timeCol, mode, steps } = resolve(catalog, spec, 'postgres');
  const relation = spec.relation || `"public"."${m.dbt_model}"`;
  const evCols = steps.map((s, i) => `    (${s.pred}) AS is${i + 1}`).join(',\n');
  let sql = `WITH ev AS (\n  SELECT ${partCol} AS pk, ${timeCol} AS ts,\n${evCols}\n  FROM ${relation}\n)`;

  if (mode === 'strict') {
    const idxExpr = steps.map((s, i) => `WHEN is${i + 1} THEN ${i + 1}`).join(' ');
    sql += `,\nseq AS (\n  SELECT pk, ts, CASE ${idxExpr} ELSE 0 END AS step_idx\n  FROM ev WHERE ${steps.map((s, i) => `is${i + 1}`).join(' OR ')}\n),\nadj AS (\n  SELECT pk, step_idx, LEAD(step_idx) OVER (PARTITION BY pk ORDER BY ts) AS next_idx FROM seq\n)`;
    const cols = steps.map((s, i) => i === 0
      ? `  (SELECT count(DISTINCT pk) FROM adj WHERE step_idx = 1) AS reached_${s.name}`
      : `  (SELECT count(DISTINCT pk) FROM adj WHERE step_idx = ${i} AND next_idx = ${i + 1}) AS reached_${s.name}`);
    return `${sql}\nSELECT\n${cols.join(',\n')}`;
  }

  let ctes = `r1 AS (SELECT pk, min(ts) AS t1 FROM ev WHERE is1 GROUP BY pk)`;
  for (let i = 2; i <= steps.length; i++) {
    ctes += `,\nr${i} AS (SELECT e.pk, min(e.ts) AS t${i} FROM ev e JOIN r${i - 1} ON e.pk = r${i - 1}.pk WHERE e.is${i} AND e.ts > r${i - 1}.t${i - 1} GROUP BY e.pk)`;
  }
  const cols = steps.map((s, i) => `  (SELECT count(*) FROM r${i + 1}) AS reached_${s.name}`);
  return `${sql},\n${ctes}\nSELECT\n${cols.join(',\n')}`;
}

export function renderSequence(catalog, spec) {
  const r = resolve(catalog, spec, 'postgres');
  return {
    mode: r.mode,
    steps: r.steps.map((s) => s.name),
    sql_bigquery: renderBigQuery(catalog, spec),
    sql_postgres: renderPostgres(catalog, spec),
  };
}
