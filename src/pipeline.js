// Unified, pipe-syntax-shaped transformation pipeline.
//
// A pipeline is `source` + an ordered list of STAGES; each stage transforms the
// table produced by the previous one (BigQuery pipe semantics). Each stage is a
// registry entry { schema, build } — adding a stage changes nothing else. The
// stage `build` is dialect-agnostic: it emits a logical op (IR) and updates the
// tracked column set. The Dialect (src/dialects/*) lowers the op list to SQL —
// DuckDB to a chained CTE, BigQuery to native `|>` pipe operators.
//
// Safety: stage params are catalog-enum / typed; column references are validated
// against the live column set threaded through the pipeline; identifiers pass the
// dialect guard; values are bound via sqlLiteral. Raw SQL enters only through a compute expression's fn: raw, an
// escape hatch whose column names are checked against the columns at that step.
//
// This file renders a pipeline (its source's columns, the stages' ops, the partition bounds); the
// stages are in src/pipeline/: stages.js (the registry), compute.js (the compute expressions), sql.js (what
// a stage is written with).
//
// ─── STAGE CATALOG (what each stage does + what it solves) ───────────────────
// Modeled on BigQuery pipe syntax (FROM t |> WHERE … |> EXTEND … |> AGGREGATE …).
// See: https://medium.com/google-cloud/bigquery-pipe-syntax-by-example-blasetta-0f3df50ba331
//
//   where      |> WHERE      filter rows by column conditions.
//                            Solves: scope to an event / segment / time window.
//   compute    |> EXTEND     add ONE column FROM existing columns, event properties + literals:
//                            event_property (a scalar, or one field of a JSON object) /
//                            array_length / array_contains — a payload field as a column;
//                            const (literal number/string/bool), arithmetic (+ - * /),
//                            round/floor/ceil/abs, coalesce/least/greatest, cast,
//                            STRING fns (concat/upper/lower/length/substring/trim/replace),
//                            date_diff / date_trunc / date_part, elapsed_days (whole 24h days
//                            between two timestamps — the RETENTION-DAY primitive, not calendar
//                            days; handles cast/negatives/NULLs for you), CASE (bucketing), and
//                            WINDOW functions (row_number / rank / lag / lead / running &
//                            ROLLING sum via a ROWS/RANGE frame), and unix_date (day number
//                            for value-based RANGE windows). Solves: constant tags/labels,
//                            KPIs (ARPU parts), string keys, tiers/buckets, days-since-install
//                            & retention day, period-over-period (lag), nth-event /
//                            repeat-purchase (row_number), rolling N-day metrics (RANGE frame).
//   unnest     |> JOIN UNNEST  explode a JSON array into one row per element.
//                            Solves: per-element frequency (items collected, rewards).
//   join       |> JOIN       1-hop join to another catalog model on a shared entity.
//                            Solves: bring user attributes (country/platform/install_date).
//   aggregate  |> AGGREGATE  group + measures: sum/average/min/max/count/count_distinct,
//                            approx_count_distinct (HLL++), stddev/variance/median/
//                            percentile(q). Solves: totals, rates, distributions,
//                            DAU/MAU (count_distinct), fast approximate uniques, revenue, ARPU.
//   pivot      |> PIVOT      turn listed values of a column into columns.
//                            Solves: dashboard-ready matrices (revenue per country column).
//   unpivot    |> UNPIVOT    fold listed columns into (name, value) rows. Solves: tidy/long
//                            format for charting; cohort/retention grids → rows.
//   sample     |> TABLESAMPLE  keep ~N% of rows for a FAST approximate first estimate
//                            on large data (BigQuery TABLESAMPLE SYSTEM; DuckDB random()).
//   order_by   |> ORDER BY   sort. limit |> LIMIT cap. project |> SELECT keep a column set.
//   match_recognize |> MATCH_RECOGNIZE  (registered by match-recognize.js) row-pattern
//                            funnel; TERMINAL stage → one row per user/session match.
//                            Solves: ordered multi-step funnels, conversion, time-between-steps.

import { getDialect } from './dialects/index.js';
import { partitionConditions } from './time-range.js';
import { physicalColumnType } from './catalog/column-types.js';
import { currentSpelling } from './pipeline/earlier.js';
import { STAGES, registerStage, stageDef, listSome, stageDefs, pipelineStageSchema } from './pipeline/stages.js';
export { registerStage, stageDef, listSome, stageDefs, pipelineStageSchema };

/**
 * WHAT A WAREHOUSE FAILURE MEANS FOR THE SHAPE OF A PIPELINE — the hint a failed SQL build is
 * annotated with. The twin of `pythonRunHints` (src/python-model.js) on the SQL side, and kept just
 * as thin: it names the shape that causes the failure and the stage form that does not, and points
 * at the worked recipe rather than repeating it. Only failures whose fix really is a different
 * pipeline shape belong here — a message we cannot act on is better left as the warehouse wrote it.
 */
export function sqlRunHints(text) {
  const log = String(text || '');
  const hints = [];
  if (/Resources exceeded|memory limit|out of memory|exceeded .*memory/i.test(log)) {
    hints.push('This is usually a GLOBAL ANALYTIC WINDOW: an OVER() with no PARTITION BY (a compute window function whose over has no partition_by, or fn: raw) keeps every row and attaches the value to each, so one worker holds the whole input — an exact percentile worst of all, since it must also order the values. Two passes instead: an `aggregate` stage with NO group_by gives ONE row of statistics, and a second pass applies them per row as literals (compute sub / div, least / greatest with a { value } argument). Worked: semantic_index({ request: { recipe: "agg_table_stat_no_global_window" } }) and ({ recipe: "agg_scale_rows_by_literals" }). A window that really is per group needs its group in partition_by.');
  }
  return hints;
}

/** Initial columns available from a catalog source model. Every REAL physical column
 *  is exposed (incl. flattened event payload + envelope columns like main_data__app_id),
 *  so a pipeline can filter/group/compute on them WITHOUT a users-join. */
function sourceColumns(catalog, key, physicalCols = null) {
  const m = catalog.getModel(key);
  const cols = new Map();
  for (const c of catalog.modelColumns(key)) cols.set(c.name, { type: c.type });
  // the event_data blob is not one of a model's listed columns (its payload properties are), yet a
  // stage that reads a blob property reads it
  if (m.event_data_column && !cols.has(m.event_data_column)) cols.set(m.event_data_column, { type: 'json' });
  // GROUNDING: when the caller supplies the relation's PHYSICAL column names (lowercased),
  // drop any declared column the physical table does not have — the pipeline can only
  // reference what truly exists, so a phantom catalog column fails as a normal "unknown
  // column" here instead of as a raw warehouse error at commit. No set → declared as-is.
  if (physicalCols) for (const name of [...cols.keys()]) if (!physicalCols.has(name.toLowerCase())) cols.delete(name);
  // …and, when the warehouse said what each is, the type it HAS — a declared type is only what the
  // schema says, and a constant written for the wrong one fails in the warehouse (STRING = BOOL)
  if (physicalCols?.types) {
    for (const [name, c] of cols) {
      const dtype = physicalCols.types.get(name.toLowerCase());
      if (!dtype || c.type === 'json' || c.type === 'array') continue;
      const physical = physicalColumnType(dtype);
      if (physical !== 'unknown') cols.set(name, { ...c, type: physical, physical: true });
    }
  }
  return cols;
}

// Fold stages -> { ops, cols } (validating column references along the way). `source`
// is the catalog model the pipeline reads FROM: stages that name an event or an
// event_data property resolve it against THAT fact, so a multi-fact catalog cannot
// silently mix one fact's payload into another fact's pipeline.
function buildOps(catalog, d, baseColumns, stages, source) {
  let cols = new Map(baseColumns);
  const ops = [];
  for (const stored of stages) {
    // a step stored by an earlier version is built in this version's spelling (src/pipeline/earlier.js) —
    // its stage too, which an earlier version may have named otherwise
    const st = currentSpelling(stored, { cols });
    const def = st && Object.hasOwn(STAGES, st.stage) ? STAGES[st.stage] : null;
    if (!def) {
      // A stage object with NO `stage` at all is not a wrong stage type — it is a stage that never
      // arrived. Say that, because the usual cause is on the way in (a large payload cut short by
      // the client), and "unknown stage: undefined" sends the reader to the schema instead.
      if (st?.stage === undefined) {
        throw new Error(`the stage object has no \`stage\` field (got ${st === undefined ? 'nothing' : JSON.stringify(st).slice(0, 80)}) — nothing says which stage this is. If the payload was large, the call may have been truncated on the way in: send this stage on its own with add_step`);
      }
      throw new Error(`unknown pipeline stage: ${st.stage} (known: ${Object.keys(STAGES).join(', ')})`);
    }
    if (typeof def.available === 'function' && !def.available(catalog)) throw new Error(def.unavailableReason ? def.unavailableReason(catalog) : `the '${st.stage}' stage is not available on this warehouse`);
    const res = def.build({ d, catalog, cols, source }, st);
    ops.push(res.op);
    cols = res.cols;
  }
  return { ops, cols };
}

/** A tracked column set from a stored column list ([{ name, type }]) or an existing Map. */
export function columnMap(columns) {
  if (columns instanceof Map) return new Map(columns);
  return new Map((columns || []).map((c) => [c.name, { type: c.type || 'unknown' }]));
}

/**
 * A source partitioned by the DAY of its time axis (`partition_column` next to it) is pruned only by
 * a condition on that column. A `where` that bounds the time axis while the rows are still the
 * source's — however the bound got there, a time_range or a condition the caller wrote — gets the
 * same bound on the partition column (the days it touches), unless it states one itself. The time
 * axis stays the exact bound; the new condition only lets the warehouse skip the other days. The
 * rows are the source's while every stage before the `where` declares `keepsSourceRows` (its rows
 * are source rows — a subset, perhaps with columns added — not groups or reshaped ones).
 */
function boundPartitions(m, stages, cols) {
  const time = m.time?.column; const part = m.partition_column;
  if (!time || !part || part === time || !cols.has(part)) return stages;
  const out = [];
  let leading = true;
  for (const st of stages) {
    if (leading && !stageDef(currentSpelling(st)?.stage)?.keepsSourceRows) leading = false;
    if (!leading || st.stage !== 'where' || (st.conditions || []).some((c) => (c.column ?? c.left?.column) === part)) { out.push(st); continue; }
    const extra = [];
    for (const c of st.conditions || []) {
      if (c.column !== time || c.value === undefined || c.value === null) continue;
      const v = c.value;
      const b = c.op === 'gte' || c.op === 'gt' ? { start: v }
        : c.op === 'lt' ? { endExclusive: v }
          : c.op === 'lte' ? { end: v }
            : c.op === 'eq' ? { start: v, end: v }
              : c.op === 'between' && Array.isArray(v) ? { start: v[0], end: v[1] } : null;
      if (b) extra.push(...partitionConditions(m, b));
    }
    out.push(extra.length ? { ...st, conditions: [...st.conditions, ...extra] } : st);
  }
  return out;
}

/**
 * Render a full pipeline over a catalog `source` as a CHAIN of dbt models. Stages run in one SQL
 * model until a `python` stage: that stage is a dbt Python model of its own, the SQL stages after
 * it another SQL model reading it through ref, and so on — any number of python stages, anywhere
 * (a python stage FIRST reads the source directly). dbt orders the chain from the refs; the last
 * model carries the pipeline's name (`modelName`), the ones before it `<modelName>_s1`, `_s2`, ….
 * SQL uses the dialect-native form (DuckDB chained CTE, BigQuery `|>` pipe syntax) for the first
 * model unless a stage requires CTE form (match_recognize on DuckDB); later SQL models read a
 * ref, so they are plain CTE chains.
 *
 * `from` starts the chain from an ALREADY-BUILT relation instead of the catalog source: the model
 * to read (`{{ ref(model) }}`) and the columns it carries. The stages passed are then only the
 * ones that still have to run — the prefix is the table. `source` is still the catalog source the
 * stages resolve their event/property semantics against; a stage that needs a column the built
 * relation no longer carries fails as a normal "unknown column".
 * @returns { chain: [{ kind: 'sql'|'python', model, input, stages|stage, sql?, columns }], columns, sql }
 *   `columns` = the final tracked column set (Map); `sql` = the LAST SQL model's text (the whole
 *   pipeline when there is no python stage).
 */
export function renderPipeline(catalog, dialectName, source, stages = [], { physicalCols = null, modelName = 'pipe', from = null } = {}) {
  const d = getDialect(dialectName);
  const m = catalog.getModel(source);
  if (!from) stages = boundPartitions(m, stages, sourceColumns(catalog, source, physicalCols));
  // Cut the stage list at every python stage.
  const segments = []; let cur = [];
  for (const st of stages) {
    if (STAGES[st.stage]?.python) { if (cur.length) segments.push({ kind: 'sql', stages: cur }); segments.push({ kind: 'python', stage: st }); cur = []; } else cur.push(st);
  }
  if (cur.length || !segments.length) segments.push({ kind: 'sql', stages: cur });
  let cols = from ? columnMap(from.columns) : sourceColumns(catalog, source, physicalCols);
  let input = from ? from.model : m.dbt_model; // what the segment's dbt.ref() / FROM names: the source (or a built relation), then the previous model
  segments.forEach((seg, i) => {
    seg.model = i === segments.length - 1 ? modelName : `${modelName}_s${i + 1}`;
    seg.input = input;
    const baseRelation = `{{ ref('${input}') }}`;
    if (seg.kind === 'sql') {
      const { ops, cols: next } = buildOps(catalog, d, cols, seg.stages, source);
      // Every SQL segment renders in the dialect's native form — BigQuery pipe syntax, a chain of
      // CTEs on DuckDB — whether it reads the source or the model a python stage produced.
      seg.sql = d.renderPipeline(baseRelation, ops);
      cols = next;
    } else {
      const def = STAGES[seg.stage.stage];
      if (typeof def.available === 'function' && !def.available(catalog)) throw new Error(def.unavailableReason ? def.unavailableReason(catalog) : 'the python stage is not available on this warehouse');
      cols = def.build({ d, catalog, cols, source }, seg.stage).cols;
    }
    seg.columns = cols;
    input = seg.model;
  });
  const lastSql = [...segments].reverse().find((seg) => seg.kind === 'sql');
  return { chain: segments, columns: cols, sql: lastSql ? lastSql.sql : null };
}
