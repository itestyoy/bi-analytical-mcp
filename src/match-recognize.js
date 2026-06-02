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

const NAME = '^[a-z][a-z0-9_]{0,40}$';

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
    // flattened payload (p.column) is a real column → reference it; else extract from JSON
    if (p.column) return comparePred(col ? `${col}.${p.column}` : p.column, c.op, c.value);
    return comparePred(jsonExtract(dialect, dataCol, c.property, p.type), c.op, c.value);
  });
  return [ev, ...props].join(' AND ');
}

/**
 * WHERE clause applied to the events BEFORE the row-pattern match, to slice the
 * data scanned (speed). Returns '' when no `filter` is declared. Narrows the
 * population only — it does NOT redefine steps. Event-level filters: time window,
 * event_name allowlist, event_data property conditions. To filter by USER
 * attributes, add a `join` (users) + `where` stage before match_recognize.
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
    clauses.push(comparePred(p.column ? q(p.column) : jsonExtract(dialect, dataCol, c.property, p.type), c.op, c.value));
  }
  return clauses.join(' AND ');
}

function resolve(catalog, spec, dialect, availableCols = null) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length < 2) {
    throw new Error('sequence requires at least 2 ordered steps');
  }
  const m = catalog.getModel(catalog.anchor);
  // Partition key is FLEXIBLE: the caller chooses any column(s) available at this
  // point in the pipeline (event columns, or columns added by upstream derive/
  // compute/join stages). Convenience aliases 'user'/'session' resolve to the
  // catalog entity columns. Default = the user entity column.
  const entityCol = (name) => m.entities?.[name]?.column;
  const resolvePart = (p) => (p === 'user' || p === 'session') ? (entityCol(p) || p) : p;
  let partCols;
  if (Array.isArray(spec.partition_by) && spec.partition_by.length) partCols = spec.partition_by.map(resolvePart);
  else if (typeof spec.partition_by === 'string') partCols = [resolvePart(spec.partition_by)];
  else { const u = entityCol('user'); if (!u) throw new Error('no default partition column; specify partition_by'); partCols = [u]; }
  if (availableCols) for (const c of partCols) if (!availableCols.has(c)) throw new Error(`partition_by column '${c}' is not available at the match_recognize stage`);
  // Order key (the sequence axis): caller may override; defaults to the event time.
  const timeCol = spec.order_by || m.time.column;
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

  // Real columns referenceable in step `where` / agg_at_step (vs event_data
  // properties). In a pipeline these are the columns produced by earlier stages
  // (passed in as availableCols); standalone, they come from spec.prepare.
  const prepCols = availableCols || prepareColumns(catalog, dialect, spec.prepare || []);

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
  return { m, partCols, timeCol, mode, steps, metrics: resolved, propCaptures, prepCols, stepPreds };
}

function nestedPattern(steps, withGap) {
  const sym = steps.map((s) => `S${s.idx}`);
  const gap = withGap ? 'GAP* ' : '';
  const nestFrom = (i) => (i === sym.length - 1 ? `${gap}${sym[i]}` : `${gap}${sym[i]} (${nestFrom(i + 1)})?`);
  return sym.length > 1 ? `(${sym[0]} (${nestFrom(1)})?)` : `(${sym[0]})`;
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
  const preds = r.stepPreds('postgres', null);
  const capByIdx = new Map();
  for (const c of r.propCaptures) { if (!capByIdx.has(c.idx)) capByIdx.set(c.idx, []); capByIdx.get(c.idx).push(c); }
  const evExtra = r.propCaptures.map((c) => `    (${c.isColumn ? c.property : jsonExtract('postgres', catalog.eventDataColumn(), c.property, c.type)}) AS ${c.id}`);
  const evCols = [...preds.map((p, i) => `    (${p}) AS is${i + 1}`), ...evExtra].join(',\n');
  const carried1 = (idx) => (capByIdx.get(idx) || []).map((c) => `, ${c.id}`).join('');
  const carried = (idx) => (capByIdx.get(idx) || []).map((c) => `, e.${c.id} AS ${c.id}`).join('');
  const pk = r.partCols; // one or more partition columns (composite key)
  const pkList = pk.join(', ');
  const pkE = pk.map((c) => `e.${c}`).join(', ');
  const ctes = [{ name: 'ev', sql: `SELECT ${pkList}, ${r.timeCol} AS ts,\n${evCols}\n  FROM ${fromRel}` }];
  ctes.push({ name: 'r1', sql: `SELECT DISTINCT ON (${pkList}) ${pkList}, ts AS t1${carried1(1)} FROM ev WHERE is1 ORDER BY ${pkList}, ts` });
  for (let i = 2; i <= r.steps.length; i++) {
    const joinOn = pk.map((c) => `e.${c} = r${i - 1}.${c}`).join(' AND ');
    ctes.push({ name: `r${i}`, sql: `SELECT DISTINCT ON (${pkE}) ${pkE}, e.ts AS t${i}${carried(i)} FROM ev e JOIN r${i - 1} ON ${joinOn} WHERE e.is${i} AND e.ts > r${i - 1}.t${i - 1} ORDER BY ${pkE}, e.ts` });
  }
  const sel = [...pk.map((c) => `r1.${c}`), ...r.steps.map((s) => (s.idx === 1 ? 'r1.t1' : `r${s.idx}.t${s.idx}`)), ...r.propCaptures.map((c) => `r${c.idx}.${c.id}`)];
  let joins = 'FROM r1';
  for (let i = 2; i <= r.steps.length; i++) joins += ` LEFT JOIN r${i} USING (${pkList})`;
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

/** BigQuery lowering: a single SELECT … FROM fromRel MATCH_RECOGNIZE(…). */
export function matchStepBigQuery(r, fromRel, catalog) {
  const preds = r.stepPreds('bigquery', null);
  const sym = r.steps.map((s) => `S${s.idx}`);
  const measures = [
    ...r.steps.map((s) => `    MAX(S${s.idx}.${r.timeCol}) AS t${s.idx}`),
    ...r.propCaptures.map((c) => `    MAX(${c.isColumn ? `S${c.idx}.${c.property}` : jsonExtract('bigquery', `S${c.idx}.${catalog.eventDataColumn()}`, c.property, c.type)}) AS ${c.id}`),
  ].join(',\n');
  const defines = r.steps.map((s, i) => `    ${sym[i]} AS ${preds[i]}`);
  if (r.mode !== 'strict') defines.push(`    GAP AS NOT (${preds.map((p) => `(${p})`).join(' OR ')})`);
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
${measures}
    ONE ROW PER MATCH
    AFTER MATCH SKIP PAST LAST ROW
    PATTERN ${nestedPattern(r.steps, r.mode !== 'strict')}
    DEFINE
${defines.join(',\n')}
  )`;
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
function matchRecognizeSchema(catalog) {
  const CMP = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'];
  const stepWhere = { type: 'object', additionalProperties: false, required: ['property', 'op'], description: 'A step condition on a scalar event_data property or an upstream pipeline column.', properties: { property: { type: 'string', pattern: NAME }, op: { enum: CMP }, value: {} } };
  const step = { type: 'object', additionalProperties: false, required: ['event_name'], description: 'One funnel step = an event (+ optional event_data/column conditions).', properties: { name: { type: 'string', pattern: NAME, description: 'Step name (referenced by metrics).' }, event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: 'Event(s) that satisfy this step.' }, where: { type: 'array', items: stepWhere, description: 'Extra conditions narrowing the step.' } } };
  const metric = { type: 'object', additionalProperties: false, required: ['name', 'type'], description: 'A metric over each match (captured as a column on the output).', properties: { name: { type: 'string', pattern: NAME }, type: { enum: ['reached', 'completed', 'conversion', 'avg_seconds_between', 'agg_at_step'] }, step: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, agg: { enum: ['sum', 'avg', 'min', 'max'] }, property: { type: 'string', pattern: NAME } } };
  return {
    type: 'object', additionalProperties: false, required: ['stage', 'steps'],
    description: 'An ordered funnel / path detector: it matches the step sequence INDEPENDENTLY within each partition, ordered by `order_by`. Produces one row per matched partition with reached_<step> flags, furthest_step_name, completed, step times, and any captured metric values — which downstream stages (join/where/aggregate) can slice or aggregate (e.g. conversion by country). For funnels, conversion, and time-between-steps.',
    properties: {
      stage: { const: 'match_recognize' },
      partition_by: {
        type: 'array', items: { type: 'string', pattern: NAME }, minItems: 1,
        description: 'Column(s) that define one independent sequence — choose them per the task from columns available at this point (event columns or ones added by upstream derive/compute/join), e.g. ["appsflyer_id"] per user, ["session_id"] per session, or a composite like ["appsflyer_id","level_id"] per user-per-level. The shorthand strings "user"/"session" resolve to the corresponding entity column. Defaults to the user column.',
      },
      order_by: { type: 'string', pattern: NAME, description: 'Column that orders events within each partition (the sequence axis). Defaults to the event time.' },
      mode: { enum: ['ordered', 'strict'], default: 'ordered', description: 'ordered = steps in order, other events may occur between them; strict = each step must be the immediately next event.' },
      filter: {
        type: 'object', additionalProperties: false, description: 'Optional event-level pre-filter applied BEFORE matching (speed; narrows the population only). To filter by USER attributes, add a join (users) + where stage before this one instead.',
        properties: {
          time_range: { type: 'object', additionalProperties: false, properties: { start: { type: 'string' }, end: { type: 'string' } }, description: 'Event-time window (ISO).' },
          event_name: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.eventNames() }, description: 'Only scan these events.' },
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
  build: ({ d, catalog, cols }, p) => {
    const spec = p._resolved ? p.spec : p; // accept a stage object OR a preresolved wrapper
    const r = p._resolved || resolve(catalog, spec, d.name, cols);
    return {
      op: {
        op: 'match_recognize',
        requiresCte: true, // MATCH_RECOGNIZE is not a pipe operator → CTE-form lowering
        render: (prev, dn) => {
          const pre = buildPrefilter(catalog, spec, dn, null);
          const fromRel = pre ? `(SELECT * FROM ${prev} WHERE ${pre})` : prev;
          return dn === 'bigquery' ? matchStepBigQuery(r, fromRel, catalog) : matchStepPostgres(r, fromRel, catalog);
        },
      },
      cols: matchOutputColumns(r),
    };
  },
});
