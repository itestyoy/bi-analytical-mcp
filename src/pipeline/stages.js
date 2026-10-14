// THE STAGE REGISTRY — every stage a pipeline can have: its schema, its build (the SQL op it adds and
// the columns it leaves), and what the registry knows about it (`available` on this warehouse,
// `keepsSourceRows`, the next-step hints it `recommend`s, the `group` it is listed under — what it needs
// to work). match_recognize and python register themselves (src/match-recognize.js, src/python-model.js).
//
// ONE STAGE DEFINITION PER TOOL (`$defs.stage`, stageDefs): the stages the tool's places take, grouped by
// what a step needs — SQL over rows, over a source's events, on a runtime, in the semantic layer (a metric
// query's metrics step) — and a feature adds its own runtime steps to ITS tools' definition. What a PLACE takes of it (a build, a read) is one table
// (STAGE_PLACES), read by the builder for a tool's definition and checked as the step is built: a refusal
// names the place and what it takes. A build is handed the expression's place (`place` in its context:
// src/pipeline/compute.js PLACES) and passes it to the one writer.

import { NAME, statAccuracyNote, EXPR, SORT_KEY, sourceProp, addCol, requireCol } from './sql.js';
import { exprSchema, exprSql, conditionListSql, isConditionCall, mapAggregates, foldWhere } from './compute.js';
import { form, strEnum, SCALAR, conditionSlot, measureForm } from '../schema-kit.js';
import { physicalColumnType, isArrayPropertyType } from '../catalog/column-types.js';
import { metricsStep } from '../schema/fields.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** A stage's measures, each { name, expr } folded over the rows' groups: the SQL of each, and the type
 *  of the column it produces (what its expression yields). A name is one column: a group_by column or
 *  another measure under it would be two. */
function measuresSql({ d, catalog, cols, source, place }, groupBy, measures, at) {
  const names = new Set(groupBy);
  return measures.map((m) => {
    if (names.has(m.name)) throw new Error(`${at}: '${m.name}' names ${groupBy.includes(m.name) ? 'a group_by column' : 'two measures'} — give each measure a column name of its own`);
    names.add(m.name);
    const r = exprSql(d, cols, m.expr, `${at} measure '${m.name}'`, { context: 'aggregate', groupBy, catalog, source, place });
    return { as: m.name, expr: r.sql, type: r.type };
  });
}

// ── Stage registry ───────────────────────────────────────────────────────────
export const STAGES = {
  where: {
    keepsSourceRows: true,
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'conditions'],
      description: 'Keep only rows where all conditions hold. A condition is an expression that is true or false: a comparison ({ fn: "eq", args: [{ column: "event_name" }, { value: "purchase" }] }), in / between / is_null / a text test, and / or / not over them, or a boolean column. Use it to scope to events, a segment or a value range, anywhere in the pipeline — after a window or an aggregate too. A constant is compared in the type of what it meets (a boolean column takes true / false, a numeric one a number); another type is refused here rather than by the warehouse, and a comparison with a missing value does not hold.',
      properties: {
        stage: { enum: ['where'] },
        conditions: conditionSlot('#/$defs/expr', 'The conditions a row is kept by: all of them hold.'),
      },
    }),
    build: ({ d, catalog, cols, source, place }, p) => ({ op: { op: 'where', preds: conditionListSql(d, cols, p.conditions, 'where conditions', { catalog, source, place }) }, cols }),
  },

  compute: {
    keepsSourceRows: true,
    // the expression grammar, once: every stage that takes an expression references it — built for the
    // expression places of the tool (`places`: what its stages' expressions take)
    defs: (catalog, { project = null, places = null } = {}) => ({ expr: exprSchema(catalog, { project, places }) }),
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'name', 'expr'],
      description: 'Add a column computed by one expression (`expr`) over the columns, event properties and constants — arithmetic, text, dates, a CASE, a condition (a flag: true or false, never missing), a window function — nested, so a whole formula is one stage.',
      properties: {
        stage: { enum: ['compute'] },
        name: { type: 'string', pattern: NAME, description: 'The name of the column it adds.' },
        expr: EXPR,
      },
    }),
    build: ({ d, catalog, cols, source, place }, p) => {
      const { sql, type, physical } = exprSql(d, cols, p.expr, `compute '${p.name}'`, { catalog, source, place });
      // a flag a condition computes is stored true or false: where the condition cannot be decided (a
      // missing operand) it does not hold, as it does not hold in a where
      const out = addCol(cols, p.name, type);
      if (physical) out.get(p.name).physical = true; // a copy of a column is stored as that column is
      return { op: { op: 'extend', cols: [{ name: p.name, expr: isConditionCall(p.expr) ? `COALESCE(${sql}, FALSE)` : sql }] }, cols: out };
    },
  },

  unnest: {
    // WHAT IT EXPLODES is an expression that yields an array: an array event property of the source
    // ({ property }, read where it is stored — its flattened column or its key of the payload), an array
    // column of the rows here ({ column }), or a function that makes one (json_parse_array). The element
    // is read as it is — text, a whole struct element JSON — and a field of a struct element is the
    // stage's own. (A draft kept from an earlier version may name the element's `type`, which no new step
    // takes: it builds as it did, src/pipeline/earlier.js.)
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'expr', 'name'],
      description: 'Explode an array into one row per element (CHANGES GRAIN; rows without the array drop out): an array event property ({ property }), an array column here ({ column }), or an expression that yields one (json_parse_array of a JSON text). For per-element analysis (items collected, rewards granted). The element is text (cast converts it where it is read). For arrays of structs: bind a single struct `field`, or omit `field` to bind the whole element and pull multiple fields from it downstream with a compute json_field.',
      properties: {
        stage: { enum: ['unnest'] },
        expr: { ...EXPR, description: 'The array: { property } of an array event property (semantic_index lists them), { column } of an array column, or an expression that yields an array.' },
        name: { type: 'string', pattern: NAME, description: 'The name the element column gets.' },
        field: { type: 'string', description: 'For array-of-struct: a single struct field to bind. Omit to bind the whole struct element (a JSON column) for multi-field extraction via compute json_field.' },
      },
    }),
    build: ({ d, catalog, cols, source, place }, p) => {
      const e = p.expr;
      const leaf = isObj(e) && e.fn === undefined;
      // (`p.type`: a kept draft's, read as that type as it was)
      const elementType = (isStruct) => (p.field ? (p.type || 'string') : (isStruct ? 'json' : (p.type || 'string')));
      if (leaf && e.property !== undefined) {
        if (e.field !== undefined || e.type !== undefined) throw new Error(`unnest: the element's field is the stage's own \`field\` — the expr names the array alone: { property: '${e.property}' }`);
        if (!source) throw new Error(`unnest: { property: '${e.property}' } reads an event property of a pipeline's source, and these rows read none (a stored table) — unnest an array column of them ({ column })`);
        const found = sourceProp(catalog, source, e.property);
        const spec = found?.spec;
        if (!spec) throw new Error(`unnest: '${e.property}' is not an event property of '${source}' — an array column here is unnested as { column }`);
        if (!isArrayPropertyType(spec.type)) {
          throw new Error(`unnest: '${e.property}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — there is nothing to explode. Declare the column with meta.mcp.array if it holds one, or read a single field with { property, field }.`);
        }
        const isStruct = String(spec.type || '').toLowerCase() === 'array<struct>';
        // the column it explodes must still be HERE, exactly as a property read's must: after a stage that
        // changed the grain (or on top of a materialized prefix built from one) the payload is gone
        const column = spec.column || catalog.eventDataColumn(source);
        requireCol(cols, column);
        const type = elementType(isStruct);
        const op = spec.column ? { column, key: null, encoding: spec.encoding || 'native' } : { column, key: found.name, encoding: 'blob' };
        return { op: { op: 'unnest', ...op, as: p.name, field: p.field, type }, cols: addCol(cols, p.name, type) };
      }
      if (leaf && e.column !== undefined && Object.keys(e).length === 1) {
        requireCol(cols, e.column);
        if (cols.get(e.column).type !== 'array') throw new Error(`unnest: '${e.column}' is ${cols.get(e.column).type || 'not typed'}, not an array column — make one with json_parse_array (expr: { fn: "json_parse_array", args: [{ column: "${e.column}" }] }), or unnest an array event property as { property }`);
        const type = elementType(false);
        return { op: { op: 'unnest', column: e.column, key: null, as: p.name, field: p.field, type, encoding: 'native' }, cols: addCol(cols, p.name, type) };
      }
      // an expression that yields an array: computed into a working column first, exploded, and the
      // working column dropped — the columns after it are those before plus the element
      const r = exprSql(d, cols, e, `unnest '${p.name}' expr`, { catalog, source, place, windows: false });
      if (r.type && r.type !== 'array' && r.type !== 'unknown') throw new Error(`unnest: its expr yields ${r.type}, not an array — json_parse_array makes one from a JSON text`);
      const work = `_unnest_${p.name}`;
      const type = elementType(false);
      const out = addCol(cols, p.name, type);
      return {
        ops: [
          { op: 'extend', cols: [{ name: work, expr: r.sql }] },
          { op: 'unnest', column: work, key: null, as: p.name, field: p.field, type, encoding: 'native' },
          { op: 'project', cols: [...out.keys()] },
        ],
        cols: out,
      };
    },
  },

  join: {
    keepsSourceRows: true,
    recommend: () => ['Joined columns are now referenceable; add a where to filter on them or an aggregate to roll up.'],
    schema: (catalog) => {
      // ONE CLOSED FORM PER JOINED MODEL AND WAY OF MATCHING: `with` pinned, and every column the form
      // names — attrs, the window's bounds, the shared key — one of THAT model's own columns, so a
      // join is written only with names the model has. (Its left side — `via`'s key on the
      // pipeline's own source, `between.column` — is the pipeline's, checked when the step is added.)
      const forms = [];
      for (const model of catalog.modelKeys()) {
        const m = catalog.models[model];
        const columns = [...new Set([...catalog.modelColumns(model).map((c) => c.name), ...(m.event_data_column ? [m.event_data_column] : [])])];
        if (!columns.length) continue;
        // one enum object for every place the form names a column of the model, so the transport folds it into one $defs entry
        const column = strEnum(columns, `A column of ${model}.`);
        const fields = {
          with: { const: model },
          attrs: {
            type: 'array', minItems: 1, uniqueItems: true,
            description: 'The columns of the joined model that arrive — exactly these.',
            items: {
              type: 'object', additionalProperties: false, required: ['column'],
              properties: {
                column,
                name: { type: 'string', pattern: NAME, description: 'The name it gets in the pipeline (defaults to `column`) — for a column both sides name identically.' },
              },
            },
          },
          between: {
            type: 'object', additionalProperties: false, required: ['column', 'from', 'to'],
            description: 'The version valid at a moment of this side (see the stage).',
            properties: {
              // from / to: the window's lower and upper bound columns on the joined model (inclusive), e.g. valid_from / valid_until
              column: { type: 'string', pattern: NAME, description: 'A column of this side holding the moment (e.g. the event time); from / to are the joined model\'s bounds, inclusive.' },
              from: column,
              to: column,
            },
          },
          kind: { enum: ['left', 'inner'], default: 'left' },
        };
        // HOW the two sides match, one field: a relationship declared in the schema (its key columns
        // come from the catalog, on both sides), or { on } — columns both sides name alike
        const vias = Object.keys(catalog.entitiesOf(model)).filter((e) => catalog.joinEntityNames().includes(e));
        const on = { type: 'object', additionalProperties: false, required: ['on'], title: '{ on }', properties: { on: { type: 'array', minItems: 1, uniqueItems: true, items: column, description: 'Key column(s) both sides name identically — when no relationship is declared.' } } };
        forms.push(form({ title: `join ${model}`, tag: ['stage', 'join'], required: ['stage', 'with', 'via', 'attrs'], properties: { ...fields, via: vias.length ? { anyOf: [{ enum: vias, title: 'a declared relationship' }, on] } : on } }));
      }
      return {
        type: 'object',
        description: 'Bring in columns of a related model. `via` is a relationship the schema declares (its key columns come from the catalog, even composite or named differently on each side; one carried on alternative columns is offered as <relationship>_<variant>), or { on: [...] } for columns both sides name alike. `attrs` lists exactly the columns that arrive. `between` picks the version of a slowly-changing model valid at a moment of this side — without it every historical version matches and counts inflate. Joins stack; via\'s left key is on the pipeline\'s own source.',
        anyOf: forms,
      };
    },
    build: ({ catalog, cols, source, physical }, p) => {
      const m = catalog.getModel(p.with);
      if (p.with === source) throw new Error(`join: '${p.with}' is the pipeline's own source — join a DIFFERENT model (a self-join is not expressible as a stage)`);
      let on = []; let onKeys;
      if (typeof p.via === 'string') {
        // The key columns come from the SCHEMA, on both sides — including a composite key — and
        // each side may name its columns its own way. The LEFT key is resolved on the pipeline's
        // own SOURCE, not on whatever the previous stages accumulated, so a chained join must use
        // a relationship the source itself declares.
        const left = catalog.entityKey(source, p.via);
        const right = catalog.entityKey(p.with, p.via);
        if (!left || !right) {
          const missing = !left ? source : p.with;
          const shared = catalog.sharedEntities(source, p.with).map((x) => x.entity);
          throw new Error(`join via '${p.via}': '${missing}' declares no such relationship.${shared.length ? ` '${source}' and '${p.with}' share: ${shared.join(', ')}.` : ` '${source}' and '${p.with}' share no declared relationship — declare one (meta.mcp.entities) or use via: { on: [...] } with a column both sides name identically.`}`);
        }
        for (const part of left) requireCol(cols, part.column); // the left key must survive to here
        onKeys = { left, right };
      } else {
        on = p.via?.on;
        if (!on?.length) throw new Error('join: `via` is a declared relationship, or { on: [key columns both sides name alike] }');
        for (const k of on) requireCol(cols, k); // every key must exist on THIS side
      }
      // What the joined model REALLY has (declared, and already grounded to the physical table at
      // catalog load), with each column's type — so a joined amount stays numeric downstream
      // instead of arriving as an untyped string. A fact's raw payload blob is a column too.
      const joined = new Map(catalog.modelColumns(p.with).map((c) => [c.name, { type: c.type || 'string' }]));
      if (m.event_data_column && !joined.has(m.event_data_column)) joined.set(m.event_data_column, { type: 'json' });
      // …grounded, when the warehouse was asked, as the source's own columns are: a column the table
      // lacks is not offered, and each arrives in the type it HAS — a flag stored as text stays text
      // under its new name, so a boolean compared with it is spelled as text, not run as STRING = BOOL
      const phys = physical?.joined?.get(p.with);
      if (phys) {
        for (const [name, c] of joined) {
          if (c.type === 'json') continue;
          if (!phys.has(name.toLowerCase())) { joined.delete(name); continue; }
          const t = c.type === 'array' ? 'unknown' : physicalColumnType(phys.types?.get(name.toLowerCase()) || '');
          if (t !== 'unknown') joined.set(name, { type: t, physical: true });
        }
      }
      const known = joined.size ? joined : null; // no column info -> accept what the caller names
      const avail = () => [...joined.keys()].join(', ');
      // `attrs` IS the contract: exactly what is listed arrives, nothing implicit. A join that
      // quietly widened the row would change what the next stage sees without anyone saying so.
      if (!p.attrs?.length) {
        throw new Error(
          `join '${p.with}': \`attrs\` is required — list the columns you want from it; nothing is added implicitly.`
          + `${joined.size ? ` Columns of '${p.with}': ${avail()}.` : ''}`
          + ` Use { column, name } to expose one under a different name. semantic_index({ request: { source: '${p.with}' } }) describes them.`,
        );
      }
      const attrs = p.attrs.map((a) => ({ column: a.column, as: a.name || a.column }));
      const byName = new Map();
      for (const a of attrs) {
        if (known && !known.has(a.column)) throw new Error(`join '${p.with}' attrs: '${a.column}' is not a column of '${p.with}' (available: ${avail()})`);
        // A name used twice is unaddressable downstream, so say WHICH two things collide and
        // what to rename. The join key is worth calling out: its value is the same on both
        // sides, so the copy is usually not wanted at all.
        if (cols.has(a.as)) {
          const isKey = onKeys ? onKeys.right.some((k) => k.column === a.column) : on.includes(a.column);
          throw new Error(
            `join '${p.with}' attrs: the pipeline already has a column named '${a.as}', so exposing '${p.with}'.${a.column} under that name would leave two columns sharing one name — unaddressable in every later stage.`
            + (isKey
              ? ` '${a.column}' is the join key: it matched on both sides, so the column the pipeline already has holds the same value — drop it from attrs.`
              : ` The two hold different data, so rename the joined one: { column: '${a.column}', name: '${p.with}_${a.column}' }.`),
          );
        }
        if (byName.has(a.as)) throw new Error(`join '${p.with}' attrs: '${byName.get(a.as)}' and '${a.column}' would both be named '${a.as}'. Give each its own \`name\`.`);
        byName.set(a.as, a.column);
      }
      const relation = `{{ ref('${m.dbt_model}') }}`;
      let out = cols;
      for (const a of attrs) { out = addCol(out, a.as, joined.get(a.column)?.type || 'string'); if (joined.get(a.column)?.physical) out.get(a.as).physical = true; }
      let between;
      if (p.between) {
        // `column` is a column on THIS side (validated against the live column set); `from`/`to`
        // are columns of the JOINED model (validated against its declared columns when known).
        requireCol(cols, p.between.column);
        const joinedCols = new Set([...catalog.modelColumns(p.with).map((c) => c.name), ...Object.keys(m.dimensions || {})]);
        for (const side of ['from', 'to']) {
          const c = p.between[side];
          if (joinedCols.size && !joinedCols.has(c)) throw new Error(`join between.${side}: '${c}' is not a column of '${p.with}' (available: ${[...joinedCols].join(', ')})`);
        }
        between = { column: p.between.column, from: p.between.from, to: p.between.to };
      }
      // Each dialect renders the projection `attrs` itself (a `j.col AS alias` list in the CTE
      // form, a projecting subquery on the right side of a pipe JOIN), so the column set promised
      // here is exactly what the next stage sees on either path.
      return { op: { op: 'join', relation, alias: 'j', on, ...(onKeys ? { onKeys } : {}), attrs, kind: (p.kind || 'left').toUpperCase(), ...(between ? { between } : {}) }, cols: out };
    },
  },

  aggregate: {
    recommend: (available) => [
      `Aggregated: the output is now group_by keys + measures (${listSome(available)}); add order_by/limit or materialize.`,
      // Comparing two groups? The stats live in a tool — don't hand-roll a t-test: the experiment
      // tool's analyze is a GENERAL two-sample significance test (not only randomized experiments).
      'Comparing two groups (A vs B, before/after, first vs last)? Don\'t compute significance by hand — feed the per-group aggregates to experiment({ request: { action: "analyze", metric: "mean" → n + mean + stddev (Welch t-test), "proportion" → conversions + n (z-test) } }) for the p-value and CI.',
    ],
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'measures'],
      // The last two sentences are the memory lesson, and they are not decoration: a global
      // analytic (`OVER ()` with no PARTITION BY) keeps every row and attaches the value to each,
      // so a table of millions of rows lands in one worker — observed as "Resources exceeded during
      // query execution", with analytic windows as the whole of the accounted memory, and it
      // happened again after the exact percentile was removed, for plain AVG/STDDEV over the same
      // global window. This stage is the cheap form of the same question.
      description: 'Group rows and compute measures — the grain collapses to the group keys. A measure is { name, expr }, its expr an aggregate — { fn: "sum", args: [{ column: "price" }] }, a count of rows { fn: "count" }, a conditional one over a case (the rows where it holds) — or a formula over aggregates (revenue per payer: div of a sum and a count_distinct). A table-wide number (a threshold, a mean) is this stage with no group_by — one row, then applied per row later as a { value }; a window with no partition_by keeps every row and runs out of memory on a large table ("Resources exceeded"). '
        + `${statAccuracyNote(catalog)}`,
      properties: {
        stage: { enum: ['aggregate'] },
        group_by: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Grouping columns (empty = grand total).' },
        measures: {
          type: 'array', minItems: 1, description: 'What each group folds to. For distinct counts prefer the HLL sketch: approx_count_distinct (one shot), or hll_init per group → hll_merge (mergeable across buckets and segments); exact count_distinct does not re-aggregate across groups.',
          items: measureForm({ ref: '#/$defs/expr', pattern: NAME, exprDescription: 'An aggregate of the rows, or a formula over aggregates; a column outside every aggregate is one of group_by.' }),
        },
      },
    }),
    build: ({ d, catalog, cols, source, place }, p) => {
      const groupBy = p.group_by || [];
      for (const g of groupBy) requireCol(cols, g);
      if (!(p.measures || []).length) throw new Error('aggregate: `measures` — what each group folds to (the distinct groups alone: a count of their rows, { name: "rows", expr: { fn: "count" } })');
      const aggs = measuresSql({ d, catalog, cols, source, place }, groupBy, p.measures, 'aggregate');
      const out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const a of aggs) out.set(a.as, { type: a.type });
      return { op: { op: 'aggregate', groupBy, aggs: aggs.map(({ as, expr }) => ({ as, expr })) }, cols: out };
    },
  },

  pivot: {
    // ONE MEASURE PER CELL — an aggregate expression, as an aggregate stage's measure is: each value of
    // `on` names its own column, and its cell is the measure with every aggregate in it folding a case
    // that holds a value only where the cell's condition holds (`on` equals the value; is missing for
    // null: foldWhere) — so it counts, sums and takes a percentile, or a formula of them, alike on every
    // warehouse.
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'on', 'measure', 'values'],
      description: 'Turn listed values of `on` into columns: one row per group_by group, and for each value a column holding `measure` over that group\'s rows where `on` equals it (count the rows, sum an amount, a ratio of two aggregates…). The values are listed explicitly, each with the name of its column. For dashboard-ready matrices (revenue as one column per country, retention day as columns).',
      properties: {
        stage: { enum: ['pivot'] },
        group_by: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Row keys kept (empty = one row).' },
        on: { type: 'string', description: 'The column whose values become columns.' },
        measure: { ...EXPR, description: 'What each cell holds — an aggregate ({ fn: "count" }, { fn: "sum", args: [{ column: "revenue" }] }) or a formula over aggregates, over the group\'s rows where `on` equals the cell\'s value.' },
        values: {
          type: 'array', minItems: 1, uniqueItems: true,
          description: 'The values of `on` that become columns, each with its column\'s name.',
          items: {
            type: 'object', additionalProperties: false, required: ['value', 'name'],
            properties: {
              value: { ...SCALAR, description: 'A value of `on`, in its type (a number for a numeric column); null is the rows where it is missing.' },
              name: { type: 'string', pattern: NAME, description: 'The name of the column it becomes.' },
            },
          },
        },
      },
    }),
    build: ({ d, catalog, cols, source, place }, p) => {
      const groupBy = p.group_by || [];
      [...groupBy, p.on].forEach((c) => requireCol(cols, c));
      const taken = new Set(groupBy); const seen = new Set();
      for (const v of p.values) {
        if (taken.has(v.name)) throw new Error(`pivot: '${v.name}' names ${groupBy.includes(v.name) ? 'a group_by column' : 'two values'} — give each value a column name of its own`);
        taken.add(v.name);
        const key = JSON.stringify(v.value);
        if (seen.has(key)) throw new Error(`pivot: the value ${key} is listed twice`);
        seen.add(key);
      }
      // each cell: the measure, its every aggregate folding only the rows of that value
      const cells = p.values.map((v) => {
        const cell = v.value === null ? { fn: 'is_null', args: [{ column: p.on }] } : { fn: 'eq', args: [{ column: p.on }, { value: v.value }] };
        return { name: v.name, expr: mapAggregates(p.measure, (agg) => foldWhere(agg, [cell])) };
      });
      const aggs = measuresSql({ d, catalog, cols, source, place }, groupBy, cells, 'pivot');
      const out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const a of aggs) out.set(a.as, { type: a.type });
      return { op: { op: 'aggregate', groupBy, aggs: aggs.map(({ as, expr }) => ({ as, expr })) }, cols: out };
    },
  },

  unpivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'columns', 'name_column', 'value_column'],
      description: 'Fold the listed columns into rows: one row per input row and folded column, with the column\'s name in `name_column` and its value in `value_column` (a NULL value too). The result is exactly `keep` + those two columns; every other column is dropped. For wide→long/tidy reshaping, or turning a pivoted (metric-per-column) result back into rows.',
      properties: {
        stage: { enum: ['unpivot'] },
        columns: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Columns to fold into rows.' },
        keep: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Columns carried as they are onto each folded row (default: none).' },
        name_column: { type: 'string', pattern: NAME, description: 'The name of the column that holds each folded column\'s name.' },
        value_column: { type: 'string', pattern: NAME, description: 'The name of the column that holds its value.' },
      },
    }),
    build: ({ cols }, p) => {
      const keep = p.keep || [];
      [...keep, ...p.columns].forEach((c) => requireCol(cols, c));
      const folded = keep.find((c) => p.columns.includes(c));
      if (folded) throw new Error(`unpivot: '${folded}' is both kept and folded — list it in one of keep or columns`);
      for (const n of [p.name_column, p.value_column]) if (keep.includes(n)) throw new Error(`unpivot: '${n}' is a kept column — name the produced column otherwise`);
      if (p.name_column === p.value_column) throw new Error('unpivot: name_column and value_column name the same column — give each its own name');
      const out = new Map();
      for (const k of keep) out.set(k, cols.get(k) || { type: 'string' });
      out.set(p.name_column, { type: 'string' });
      out.set(p.value_column, { type: 'numeric' });
      return { op: { op: 'unpivot', keep, columns: p.columns, nameColumn: p.name_column, valueColumn: p.value_column }, cols: out };
    },
  },

  order_by: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'keys'],
      description: 'Sort rows. For rankings/leaderboards (pair with limit) and stable output ordering. NULLs go last unless a key says first — the same on every warehouse.',
      properties: { stage: { enum: ['order_by'] }, keys: { type: 'array', minItems: 1, items: SORT_KEY, description: 'The sort keys, in order.' } },
    }),
    build: ({ cols }, p) => { p.keys.forEach((k) => requireCol(cols, k.key)); return { op: { op: 'order_by', keys: p.keys.map((k) => ({ key: k.key, direction: k.direction, nulls: k.nulls })) }, cols }; },
  },

  limit: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'limit'], description: 'Cap the number of rows. For top-N (after order_by) or previews.', properties: { stage: { enum: ['limit'] }, limit: { type: 'integer', minimum: 1, maximum: 1000000, description: 'The most rows kept.' } } }),
    build: ({ cols }, p) => ({ op: { op: 'limit', limit: p.limit }, cols }),
  },

  sample: {
    keepsSourceRows: true,
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'share'],
      description: 'Keep about `share` of the rows at random (0.1 = about a tenth) — a fast, approximate first look on large data. Put it early. The result is flagged approximate; rerun without it for any number you act on (sampling error is large near 0 / 1 rates, in small segments and for distinct counts).',
      properties: {
        stage: { enum: ['sample'] },
        share: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'The approximate share of rows to keep, a fraction: 0 < share <= 1 (0.01 = about 1%).' },
      },
    }),
    build: ({ cols }, p) => ({ op: { op: 'sample', share: p.share }, cols }),
  },

  project: {
    schema: () => {
      const names = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } };
      return {
        type: 'object',
        description: 'Trim the columns before they are materialized: `keep` keeps exactly these (in this order), `drop` removes these and keeps the rest.',
        anyOf: [
          form({ title: 'keep these columns', required: ['stage', 'keep'], properties: { stage: { enum: ['project'] }, keep: { ...names, description: 'The columns to keep, in order.' } } }),
          form({ title: 'drop these columns', required: ['stage', 'drop'], properties: { stage: { enum: ['project'] }, drop: { ...names, description: 'The columns to remove; every other column stays.' } } }),
        ],
      };
    },
    build: ({ cols }, p) => {
      const keep = p.drop ? (p.drop.forEach((c) => requireCol(cols, c)), [...cols.keys()].filter((c) => !p.drop.includes(c))) : p.keep;
      if (!keep.length) throw new Error('project: dropping every column leaves nothing to keep');
      keep.forEach((c) => requireCol(cols, c));
      const out = new Map(); for (const c of keep) out.set(c, cols.get(c) || { type: 'string' });
      return { op: { op: 'project', cols: keep }, cols: out };
    },
  },

  // WHAT THE SEMANTIC LAYER COMPUTES — a metric query's metrics, broken down by its group_by: MetricFlow
  // writes its SQL (src/engine/semantic-query.js runs it), so it is no SQL stage of a table's rows, and
  // only a place that names it takes it (STAGE_PLACES.metric_scope — query_semantic_model's).
  metrics: {
    group: 'semantic',
    schema: (catalog, { project = null } = {}) => metricsStep({ project }),
    build: () => { throw new Error('a metrics step is computed by the semantic layer — query_semantic_model runs it, over a context\'s metrics'); },
  },
};

/** Register an additional stage from another module (match_recognize, python) — with the `group` it is
 *  listed under. */
export function registerStage(name, def) { STAGES[name] = def; }

/** One stage's definition by name (null for a name no stage has). */
export function stageDef(name) { return Object.hasOwn(STAGES, name) ? STAGES[name] : null; }

/** The first few column names of a step's output, for a hint. */
export function listSome(columns, n = 6) {
  return `${columns.slice(0, n).map((c) => c.name).join(', ')}${columns.length > n ? ', …' : ''}`;
}

/** A stage may declare `available(catalog)`: false hides it from the schemas and refuses it in a build. */
export function availableStages(catalog) {
  return Object.values(STAGES).filter((s) => typeof s.available !== 'function' || s.available(catalog));
}

/**
 * WHAT A PLACE TAKES OF THE STAGES — one table, read by the builder for a tool's `$defs.stage` (stageSchema)
 * and checked as each step is built (stageAt): `what` names the
 * place in a refusal, `stages` lists what it takes (null: every stage there is), `elsewhere` says where a
 * stage it leaves out is built. A feature checks a place of its own with stageAt, in this shape.
 *   build         — a pipeline build: every stage over a table's rows;
 *   read          — a read of a stored table, a card's drill: the SQL stages that keep it one table; a
 *                   join, an unnest, a funnel or a python model makes a new table, built from the task;
 *   metric_scope  — a metric query up to its one metrics step: where steps, which filter the rows its
 *                   metrics fold (named as a metric query names a dimension: PLACES.metric_where), and
 *                   the metrics step;
 *   metric_result — a metric query after its metrics step: what a read takes, over the result's columns.
 * A stage of the semantic layer (the metrics step) is taken only where a place names it (takes).
 */
const READ_STAGES = ['where', 'compute', 'aggregate', 'pivot', 'unpivot', 'order_by', 'limit', 'sample', 'project'];
export const STAGE_PLACES = {
  build: { what: 'a pipeline build', stages: null },
  read: {
    what: 'a read', stages: READ_STAGES,
    elsewhere: 'makes a new table: build it from the task, build_pipeline_model({ request: { action: "start", name, from_task } })',
  },
  metric_scope: { what: 'a step up to the metrics step', stages: ['where', 'metrics'] },
  metric_result: {
    what: 'a step after the metrics step', stages: READ_STAGES,
    elsewhere: 'makes a new table: store the result (materialize: true) and build from its task, build_pipeline_model({ request: { action: "start", name, from_task } })',
  },
};

/** Whether a place takes a stage: one its list names — or, where it lists none, every stage over a
 *  table's rows (a stage of the semantic layer only where a place names it). */
function takes(p, name) {
  return p.stages ? p.stages.includes(name) : (stageDef(name)?.group || 'sql') !== 'semantic';
}

/** A step at a place (a STAGE_PLACES name, or a place of that shape): refused when the place does not
 *  take its stage — naming the place, what it takes and where a stage it leaves out is built. `at` names
 *  the step. */
export function stageAt(place, st, at) {
  const p = typeof place === 'string' ? STAGE_PLACES[place] : place;
  const kind = st?.stage;
  if (takes(p, kind)) return;
  const def = kind === undefined ? null : stageDef(kind);
  // the semantic layer's step makes no table: where it is not taken, it is said where it is
  const why = kind === undefined ? 'this step names no `stage`'
    : !def ? `there is no '${kind}' stage`
      : def.group === 'semantic' ? `a ${kind} step is what the semantic layer computes, one per metric query (query_semantic_model)`
        : `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} stage ${p.elsewhere || 'is not one of them'}`;
  throw new Error(`${at}: ${p.what} takes ${p.stages ? p.stages.join(', ') : 'every stage over a table\'s rows'} — ${why}`);
}

/**
 * THE STAGE GROUPS — what a step needs to work, the titles a tool's `$defs.stage` lists its stages under.
 * A stage says its `group`; one that says none is SQL over rows.
 */
export const STAGE_GROUPS = {
  sql: 'SQL over rows — needs a table',
  events: 'over a source\'s events — needs the rows still that source\'s events',
  runtime: 'on a runtime, not SQL — needs its runtime, after SQL has prepared the rows',
  semantic: 'in the semantic layer — needs MetricFlow',
};

/** Places by their STAGE_PLACES names (or places of that shape, as a feature passes) — null for none named. */
function stagePlacesOf(places) {
  if (!places?.length) return null;
  return places.map((p) => {
    const place = typeof p === 'string' ? STAGE_PLACES[p] : p;
    if (!place) throw new Error(`stageSchema: no stage place '${p}'`);
    return place;
  });
}

/**
 * THE STAGE — `$defs.stage` of every tool that takes steps, ONE definition built by this one builder for
 * the PLACES of that tool (STAGE_PLACES names, or places of that shape; none named — every stage): the
 * stages this warehouse offers that one of them takes, each the closed form(s) its schema writes, tagged
 * by `stage` (so the refusal of a bad step is that stage's, not every stage's: src/validate.js), grouped
 * by what it needs (a titled union per group; a group left empty is left out). `runtime`: the forms a
 * feature adds to ITS tools' runtime group — its library's steps, tagged by what they are; the core's
 * tools pass none, so nothing of a feature is in their definition. One definition per tool: the one step
 * and the list of steps point at it, and where its places take different stages, each place narrows it
 * as the step is built (STAGE_PLACES, stageAt). `project`: the dbt project's own layer, which a stage of
 * the semantic layer names in its text.
 */
export function stageSchema(catalog, { runtime = [], places = null, project = null } = {}) {
  const at = stagePlacesOf(places);
  const offered = Object.entries(STAGES).filter(([, s]) => typeof s.available !== 'function' || s.available(catalog));
  const taken = offered.filter(([name]) => (at || [STAGE_PLACES.build]).some((p) => takes(p, name)));
  const forms = (group) => [...taken.filter(([, s]) => (s.group || 'sql') === group).map(([, s]) => s.schema(catalog, { project })), ...(group === 'runtime' ? runtime : [])];
  const anyOf = Object.entries(STAGE_GROUPS).map(([group, title]) => ({ title, anyOf: forms(group) })).filter((g) => g.anyOf.length);
  if (!at) {
    const read = STAGE_PLACES.read;
    return {
      description: `One step: a stage { stage: "where" | "compute" | "join" | …, … }, grouped by what it needs. Each place takes some of them, and a refusal says which: ${STAGE_PLACES.build.what} takes every one; ${read.what} takes ${read.stages.join(', ')} — a join, an unnest, a funnel or a python step ${read.elsewhere.replace(/: .*$/, '')}, built from the task (from_task).`,
      anyOf,
    };
  }
  // what the definition holds, said from what it holds: what each of several places takes, and where a
  // stage none of them takes is built
  const names = taken.map(([name]) => name);
  const several = at.length > 1 && new Set(at.map((p) => (p.stages || ['*']).join())).size > 1;
  // (the stages a build takes that these places leave out — a new table's; the semantic layer's is no table's)
  const left = offered.map(([name]) => name).filter((name) => !names.includes(name) && takes(STAGE_PLACES.build, name));
  const elsewhere = at.find((p) => p.elsewhere && p.stages && left.some((name) => !p.stages.includes(name)))?.elsewhere;
  const text = [
    `One step: a stage { stage: ${names.slice(0, 3).map((n) => `"${n}"`).join(' | ')}${names.length > 3 ? ' | …' : ''}, … }, grouped by what it needs.`,
    ...(several ? [`Each place takes some of them, and a refusal says which: ${at.map((p) => `${p.what} takes ${p.stages ? p.stages.join(', ') : 'every one'}`).join('; ')}.`] : []),
    ...(left.length && elsewhere ? [`${/^[aeiou]/.test(left[0]) ? 'An' : 'A'} ${left.join(' / ')} step ${elsewhere}.`] : []),
  ].join(' ');
  return { description: text, anyOf };
}

/**
 * Root-level `$defs` of a tool that takes steps: what the stages' schemas reference (each stage may
 * declare its own — the one expression, `expr`, is compute's) and `stage`, the one stage definition. They
 * sit at the tool's root, where `#/$defs/…` resolves. `project` reaches the expression's refs (the dbt
 * project's semantic models and entities); `runtime` and `places` (the tool's stage places) as
 * stageSchema's; `exprPlaces` the tool's expression places (src/pipeline/compute.js PLACES), which its
 * `$defs.expr` is built for.
 */
export function stageDefs(catalog, { project = null, runtime = [], places = null, exprPlaces = null } = {}) {
  return {
    ...Object.assign({}, ...availableStages(catalog).map((s) => (typeof s.defs === 'function' ? s.defs(catalog, { project, places: exprPlaces }) : {}))),
    stage: stageSchema(catalog, { runtime, places, project }),
  };
}
