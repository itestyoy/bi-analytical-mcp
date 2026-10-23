// THE STAGE REGISTRY — every stage a pipeline can have: its schema, its build (the SQL op it adds and
// the columns it leaves), and what the registry knows about it (`available` on this warehouse,
// `keepsSourceRows`, the next-step hints it `recommend`s, the `group` it is listed under — what it needs
// to work). match_recognize and python register themselves (src/match-recognize.js, src/python-model.js).
//
// ONE STAGE DEFINITION PER TOOL (`$defs.stage`, stageDefs): the stages the tool's places take, grouped by
// what a step needs — SQL over rows, over a source's events, on a runtime, in the semantic layer — and the
// steps a place offers of its own, no stage of this registry (a metric query's metrics step, which only
// MetricFlow computes: src/schema/fields.js METRICS_STEP), each in the group it names; a feature adds its
// own runtime steps to ITS tools' definition. What a PLACE takes of it (a build, a read) is one table
// (STAGE_PLACES), read by the builder for a tool's definition and checked as the step is built: a refusal
// names the place and what it takes. A build is handed the expression's place (`place` in its context:
// src/pipeline/compute.js PLACES) and passes it to the one writer.

import { NAME, statAccuracyNote, EXPR, SORT_KEY, sourceProp, addCol, requireCol } from './sql.js';
import { exprDefs, exprSql, conditionListSql, mapAggregates, foldWhere, exprCalls } from './compute.js';
import { form, strEnum, SCALAR, conditionSlot, measureForm } from '../schema-kit.js';
import { physicalColumnType, isArrayPropertyType, itemType, elementType, nativeArrayType, groundedType } from '../catalog/column-types.js';
import { METRICS_STEP, SEMANTIC_MODEL_STEP } from '../schema/fields.js';
import { TIME_PART, describeContract, onPartsError, contractOnSchema } from '../catalog/joins.js';
import { isNumericType } from '../dialects/base.js';

/** A slot that names a column of the rows: its name — and after a metrics step also what the query named
 *  it by (a group_by item as group_by names it, a metric as { metric }), resolved to the result's column. */
const columnSlot = (refNames, base = { type: 'string' }) => (refNames ? { anyOf: [base, { $ref: '#/$defs/ref' }] } : base);
const REF_NAMES_NOTE = ' After a metrics step a column may also be named as the query names it: a group_by item as group_by names it ({ source, column }, { time: "metric_time", grain }…), a metric as { metric }.';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The refusal of a column a step would add under a name the rows already have: two columns sharing one
 *  name are unaddressable in every later stage (one warehouse renames the second, the other refuses it). */
const nameTaken = (at, name, what) => `${at}: the pipeline already has a column named '${name}', so ${what} under that name would leave two columns sharing one name — unaddressable in every later stage.`;

/** A column a step ADDS (a compute, an unnest's element): under a name of its own, never over one the
 *  rows have — refused as a join's attrs are. */
function newCol(cols, name, type, at, what) {
  if (cols.has(name)) throw new Error(`${nameTaken(at, name, what)} Choose another name.`);
  return addCol(cols, name, type);
}

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

/** AN UNPIVOT'S VALUE COLUMN holds every folded column's values, so it is of the one type they share (a
 *  column holds one type, and BigQuery's UNPIVOT folds only columns of one): columns of different kinds
 *  are refused, each named with its type. Numbers are one kind — what a number is tracked by (int,
 *  numeric, float) does not say the warehouse's type, so the warehouse's lowering folds them through one
 *  (BigQuery's unpivot) — and so are moments: 'time' is a DATE, a DATETIME or a TIMESTAMP, which BigQuery's
 *  unpivot folds as TIMESTAMPs (DuckDB's UNION ALL promotes them so). A column whose type is not known
 *  claims none, so the value column claims none either. */
function unpivotType(cols, columns) {
  const typed = columns.map((c) => [c, cols.get(c)?.type || 'unknown']);
  const known = [...new Set(typed.map(([, t]) => t).filter((t) => t !== 'unknown'))];
  if (known.length > 1 && !known.every(isNumericType)) {
    throw new Error(`unpivot: the value column holds one type, and the folded columns hold several — ${typed.map(([c, t]) => `'${c}' ${t}`).join(', ')}. Cast them to one type first: a compute stage of each, { fn: "cast", args: [{ column }], type }, folded instead.`);
  }
  if (typed.some(([, t]) => t === 'unknown')) return 'unknown';
  return known.length === 1 ? known[0] : 'numeric';
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
    // (a lag of a moment — the gap between events, a session's start — compares times itself: said only where
    // a value is carried over from the neighbouring row)
    recommend: (available, p = {}) => {
      const moment = (a) => /date|time/i.test(String(available.find((c) => c.name === a?.column)?.type ?? ''));
      return exprCalls(p.expr).some((c) => (c.fn === 'lag' || c.fn === 'lead') && !moment(c.args?.[0])) ? [NEIGHBOUR_NOTE] : [];
    },
    // the expression grammar, once: every stage that takes an expression references it — the row
    // expression built for the expression places of the tool (`places`: what its stages' expressions take),
    // with the window its window forms refer to where one of them takes a window (a window function's
    // `over`, an aggregate over a window's `over_frame`)
    defs: (catalog, { project = null, places = null } = {}) => exprDefs(catalog, { project, kinds: { expr: places } }),
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
      // a boolean it computes — a condition, array_contains, a boolean column, a case of booleans … — is
      // stored true or false: where it cannot be decided (a missing operand, a missing array) it does not
      // hold, as it does not hold in a where
      const out = newCol(cols, p.name, type, `compute '${p.name}'`, 'adding the computed one');
      if (physical) out.get(p.name).physical = true; // a copy of a column is stored as that column is
      return { op: { op: 'extend', cols: [{ name: p.name, expr: type === 'boolean' ? `COALESCE(${sql}, FALSE)` : sql }] }, cols: out };
    },
  },

  unnest: {
    // WHAT IT EXPLODES is an expression that yields an array: an array event property of the source
    // ({ property }, read where it is stored — its flattened column or its key of the payload), an array
    // column of the rows here ({ column }), or a function that makes one (json_parse_array). The element
    // is what it is stored as — a native array's item of its items' type, a JSON array's text, a whole
    // struct element JSON — and a field of a struct element is the stage's own. (A draft kept from an
    // earlier version may name the element's `type`, which no new step takes: it builds as it did,
    // src/pipeline/earlier.js.)
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'expr', 'name'],
      description: 'Explode an array into one row per element (CHANGES GRAIN; rows without the array drop out): an array event property ({ property }), an array column here ({ column }), or an expression that yields one (json_parse_array of a JSON text). For per-element analysis (items collected, rewards granted). The element has the type it is stored as: a native array\'s items (the catalog\'s `items`), a JSON array\'s text; cast converts it where it is read. For arrays of structs: bind a single struct `field`, or omit `field` to bind the whole element and pull multiple fields from it downstream with a compute json_field.',
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
      // THE ELEMENT, as it is stored: a native array's item of its items' type (`items`, the array's
      // elementType — the warehouse's or the catalog's, carried with the array's type; 'unknown', not
      // claimed, where neither says), a JSON array's text, read out of JSON; a struct element of a JSON
      // array whole is JSON, one field of it text — of a native one, a struct, which is no JSON: not
      // claimed, one field of it of the type the catalog declares the field (`fields`). `read` is what
      // the dialect converts it to: nothing ('string'), the whole JSON struct ('json'), or a kept draft's
      // `type` — the element's type then too (it builds as it did).
      const element = (native, items, fields = null) => {
        if (p.field && native && items !== 'struct' && items !== 'unknown') throw new Error(`unnest: \`field\` reads one field of a struct element, and this array's elements are ${items} — leave it out`);
        if (p.field) return p.type || !native ? { read: p.type || 'string', type: p.type || 'string' } : { read: 'string', type: itemType(fields?.[p.field]) };
        if (items === 'struct') return native ? { read: 'string', type: 'unknown' } : { read: 'json', type: 'json' };
        if (p.type) return { read: p.type, type: p.type };
        return { read: 'string', type: native ? items : 'string' };
      };
      if (leaf && e.property !== undefined) {
        if (e.field !== undefined || e.type !== undefined) throw new Error(`unnest: the element's field is the stage's own \`field\` — the expr names the array alone: { property: '${e.property}' }`);
        if (!source) throw new Error(`unnest: { property: '${e.property}' } reads an event property of a pipeline's source, and these rows read none (a stored table) — unnest an array column of them ({ column })`);
        const found = sourceProp(catalog, source, e.property);
        const spec = found?.spec;
        if (!spec) throw new Error(`unnest: '${e.property}' is not an event property of '${source}' — an array column here is unnested as { column }`);
        if (!isArrayPropertyType(spec.type)) {
          throw new Error(`unnest: '${e.property}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — there is nothing to explode. Declare the column with meta.mcp.array if it holds one, or read a single field with { property, field }.`);
        }
        // the column it explodes must still be HERE, exactly as a property read's must: after a stage that
        // changed the grain (or on top of a materialized prefix built from one) the payload is gone
        const column = spec.column || catalog.eventDataColumn(source);
        requireCol(cols, column);
        const op = spec.column ? { column, key: null, encoding: spec.encoding || 'native' } : { column, key: found.name, encoding: 'blob' };
        // its items: a native array's as a { property } read of it has them (nativeArrayType — as the
        // column is tracked here, else declared); a JSON array's text, or structs where it declares them
        const native = op.encoding === 'native';
        const items = native ? elementType(nativeArrayType(spec, cols.get(column)?.type)) : String(spec.type || '').toLowerCase() === 'array<struct>' ? 'struct' : 'string';
        const { read, type } = element(native, items, spec.fields);
        return { op: { op: 'unnest', ...op, as: p.name, field: p.field, type: read }, cols: newCol(cols, p.name, type, `unnest '${p.name}'`, 'adding the element') };
      }
      if (leaf && e.column !== undefined && Object.keys(e).length === 1) {
        requireCol(cols, e.column);
        const t = cols.get(e.column).type;
        if (!isArrayPropertyType(t)) throw new Error(`unnest: '${e.column}' is ${t || 'not typed'}, not an array column — make one with json_parse_array (expr: { fn: "json_parse_array", args: [{ column: "${e.column}" }] }), or unnest an array event property as { property }`);
        const { read, type } = element(true, elementType(t));
        return { op: { op: 'unnest', column: e.column, key: null, as: p.name, field: p.field, type: read, encoding: 'native' }, cols: newCol(cols, p.name, type, `unnest '${p.name}'`, 'adding the element') };
      }
      // an expression that yields an array: computed into a working column first, exploded, and the
      // working column dropped — the columns after it are those before plus the element
      const r = exprSql(d, cols, e, `unnest '${p.name}' expr`, { catalog, source, place, windows: false });
      if (r.type && !isArrayPropertyType(r.type) && r.type !== 'unknown') throw new Error(`unnest: its expr yields ${r.type}, not an array — json_parse_array makes one from a JSON text`);
      const work = `_unnest_${p.name}`;
      const { read, type } = element(true, elementType(r.type));
      const out = newCol(cols, p.name, type, `unnest '${p.name}'`, 'adding the element');
      return {
        ops: [
          { op: 'extend', cols: [{ name: work, expr: r.sql }] },
          { op: 'unnest', column: work, key: null, as: p.name, field: p.field, type: read, encoding: 'native' },
          { op: 'project', cols: [...out.keys()] },
        ],
        cols: out,
      };
    },
  },

  join: {
    keepsSourceRows: true,
    // offered only where some model declares a join contract (and has an attribute to bring)
    available: (catalog) => catalog.joinableModels().length > 0,
    recommend: () => ['Joined columns are now referenceable; add a where to filter on them or an aggregate to roll up.'],
    schema: (catalog) => {
      // ONE CLOSED FORM PER JOINABLE MODEL — a model whose schema declares a join contract
      // (meta.mcp.join, src/catalog/joins.js): `source` pinned, `on` naming exactly the contract's parts
      // (a key or the time a column of the rows, a select part its value), `attrs` one of the model's own
      // attributes — an amount (a measure column) is not carried: the rows would repeat it.
      const forms = [];
      for (const model of catalog.joinableModels()) {
        const contract = catalog.joinContract(model);
        const amounts = new Set(catalog.aggregatableFields(model).map((f) => f.column).filter(Boolean));
        const attributes = catalog.modelColumns(model).map((c) => c.name).filter((c) => !amounts.has(c));
        if (!attributes.length) continue;
        forms.push(form({
          title: `join ${model}`, tag: ['stage', 'join'], required: ['stage', 'source', 'on', 'attrs'],
          properties: {
            source: { const: model },
            on: contractOnSchema(model, contract),
            attrs: {
              type: 'array', minItems: 1, uniqueItems: true,
              description: 'The columns of the joined model that arrive — exactly these; one whose name the rows already carry takes a `name` of its own.',
              items: {
                type: 'object', additionalProperties: false, required: ['column'],
                properties: {
                  column: strEnum(attributes, `An attribute of ${model}.`),
                  name: { type: 'string', pattern: NAME, description: 'The name it gets in the pipeline (defaults to `column`) — for a column both sides name identically.' },
                },
              },
            },
            kind: { enum: ['left', 'inner'], default: 'left' },
          },
        }));
      }
      return {
        type: 'object',
        description: 'Bring in attributes of a model its schema makes joinable — on its join contract, { source, on: { <part>: <a column of the rows | a value> } }: every part it declares named, each key part and the time a column of these rows, a select part its value. The contract is unique on the joined side, so a row meets at most one row there and nothing is repeated; a slowly-changing model is matched at the version valid at the time named. `attrs` lists exactly the columns that arrive — attributes, not amounts (an amount is a measure of the semantic layer). Joins stack.',
        anyOf: forms,
      };
    },
    build: ({ d, catalog, cols, source, physical }, p) => {
      if (p.with !== undefined) throw new Error(`join: this step names its model with \`with\` and its key with \`via\`, and the model's join contract needs what it did not say — write it as { source: '${p.with}', on: { … } }${catalog.joinContract(p.with) ? ` (${describeContract(p.with, catalog.joinContract(p.with))})` : ''}`);
      const model = p.source;
      const contract = model ? catalog.joinContract(model) : null;
      if (!contract) {
        const joinable = catalog.joinableModels();
        throw new Error(`join: '${model}' declares no join contract, so it is not joinable${joinable.length ? ` — the joinable models: ${joinable.join(', ')}` : ' — no model of this catalog is'}`);
      }
      if (model === source) throw new Error(`join: '${model}' is the pipeline's own source — join a DIFFERENT model`);
      const m = catalog.getModel(model);
      const on = p.on || {};
      const wrong = onPartsError(model, contract, on);
      if (wrong) throw new Error(`join '${model}': ${wrong}`);
      // the key: each part a column of the rows, equal to the joined model's column (a part chosen by a
      // select part's word, the column that word picks)
      const left = []; const right = [];
      for (const k of contract.key) {
        requireCol(cols, on[k.part]);
        left.push({ column: on[k.part] });
        right.push({ column: k.by ? k.columns[on[k.by]] : k.column });
      }
      let between;
      if (contract.time) {
        requireCol(cols, on[TIME_PART]);
        if (contract.time.within) between = { column: on[TIME_PART], from: contract.time.within[0], to: contract.time.within[1] };
        // the same day: one more part of the key, both sides at the day
        else { left.push({ column: on[TIME_PART], grain: 'day' }); right.push({ column: contract.time.same_day, grain: 'day' }); }
      }
      for (const s of contract.select.filter((x) => x.values)) {
        if (!s.values.includes(on[s.part])) throw new Error(`join '${model}': on.${s.part} is one of ${s.values.join(', ')}`);
      }
      // a select part with a column filters the joined model to the value BEFORE the join
      const filter = contract.select.filter((s) => s.column).map((s) => {
        if (typeof on[s.part] !== 'string' || !on[s.part]) throw new Error(`join '${model}': on.${s.part} is a value of ${model}.${s.column} — the one the join keeps`);
        return { column: s.column, value: on[s.part] };
      });
      const amounts = new Set(catalog.aggregatableFields(model).map((f) => f.column).filter(Boolean));
      const joined = new Map(catalog.modelColumns(model).filter((c) => !amounts.has(c.name)).map((c) => [c.name, { type: c.type || 'string' }]));
      // …grounded, when the warehouse was asked, as the source's own columns are: a column the table
      // lacks is not offered, and each arrives in the type it HAS (by the one rule of grounding)
      const phys = physical?.joined?.get(model);
      if (phys) {
        for (const [name, c] of joined) {
          if (!phys.has(name.toLowerCase())) { joined.delete(name); continue; }
          const t = physicalColumnType(phys.types?.get(name.toLowerCase()) || '');
          if (t !== 'unknown' && groundedType(c.type, t) === t) joined.set(name, { type: t, physical: true });
        }
      }
      const avail = () => [...joined.keys()].join(', ');
      if (!p.attrs?.length) throw new Error(`join '${model}': \`attrs\` is required — list the columns you want from it; nothing is added implicitly. Its attributes: ${avail()}.`);
      const attrs = p.attrs.map((a) => ({ column: a.column, as: a.name || a.column }));
      const byName = new Map();
      for (const a of attrs) {
        if (amounts.has(a.column)) throw new Error(`join '${model}' attrs: '${a.column}' is an amount — carried onto these rows it would repeat on every row that meets it; it is a measure of the semantic layer (a semantic_model's measure over '${model}')`);
        if (!joined.has(a.column)) throw new Error(`join '${model}' attrs: '${a.column}' is not an attribute of '${model}' (available: ${avail()})`);
        if (cols.has(a.as)) {
          const isKey = right.some((k) => k.column === a.column);
          throw new Error(
            nameTaken(`join '${model}' attrs`, a.as, `exposing '${model}'.${a.column}`)
            + (isKey
              ? ` '${a.column}' is the join key: it matched on both sides, so the column the pipeline already has holds the same value — drop it from attrs.`
              : ` The two hold different data, so rename the joined one: { column: '${a.column}', name: '${model}_${a.column}' }.`),
          );
        }
        if (byName.has(a.as)) throw new Error(`join '${model}' attrs: '${byName.get(a.as)}' and '${a.column}' would both be named '${a.as}'. Give each its own \`name\`.`);
        byName.set(a.as, a.column);
      }
      const ref = `{{ ref('${m.dbt_model}') }}`;
      const relation = filter.length ? `(SELECT * FROM ${ref} WHERE ${filter.map((f) => `${d.quoteIdent(f.column)} = ${d.sqlLiteral(f.value)}`).join(' AND ')})` : ref;
      let out = cols;
      for (const a of attrs) { out = addCol(out, a.as, joined.get(a.column)?.type || 'string'); if (joined.get(a.column)?.physical) out.get(a.as).physical = true; }
      return { op: { op: 'join', relation, alias: 'j', on: [], onKeys: { left, right }, attrs, kind: (p.kind || 'left').toUpperCase(), ...(between ? { between } : {}) }, cols: out };
    },
  },
  aggregate: {
    recommend: (available, p = {}) => [
      `Aggregated: the output is now group_by keys + measures (${listSome(available)}); add order_by/limit or materialize.`,
      // Comparing two groups? The stats live in a tool — don't hand-roll a t-test: the experiment
      // tool's analyze is a GENERAL two-sample significance test (not only randomized experiments).
      // Said only where the stage computes what a test reads per group (a spread), not after every rollup.
      ...(p.group_by?.length && (p.measures || []).some((m) => exprCalls(m.expr).some((c) => c.fn === 'stddev' || c.fn === 'variance'))
        ? ['Comparing two groups (A vs B, before/after, first vs last)? Don\'t compute significance by hand — feed the per-group aggregates to experiment({ request: { action: "analyze", metric: "mean" → n + mean + stddev (Welch t-test), "proportion" → conversions + n (z-test) } }) for the p-value and CI.']
        : []),
    ],
    schema: (catalog, { refNames = false } = {}) => ({
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
        group_by: { type: 'array', uniqueItems: true, items: columnSlot(refNames), description: `Grouping columns (empty = grand total).${refNames ? REF_NAMES_NOTE : ''}` },
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
    schema: (catalog, { refNames = false } = {}) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'on', 'measure', 'values'],
      description: 'Turn listed values of `on` into columns: one row per group_by group, and for each value a column holding `measure` over that group\'s rows where `on` equals it (count the rows, sum an amount, a ratio of two aggregates…). The values are listed explicitly, each with the name of its column. For dashboard-ready matrices (revenue as one column per country, retention day as columns).',
      properties: {
        stage: { enum: ['pivot'] },
        group_by: { type: 'array', uniqueItems: true, items: columnSlot(refNames), description: `Row keys kept (empty = one row).${refNames ? REF_NAMES_NOTE : ''}` },
        on: { ...columnSlot(refNames), description: 'The column whose values become columns.' },
        measure: { ...EXPR, description: 'What each cell holds — an aggregate ({ fn: "count" }, { fn: "sum", args: [{ column: "revenue" }] }) or a formula over aggregates, over the group\'s rows where `on` equals the cell\'s value.' },
        values: {
          type: 'array', minItems: 1, uniqueItems: true,
          description: 'The values of `on` that become columns: [{ value: "US" }, { value: "GB", name: "uk" }].',
          items: {
            type: 'object', additionalProperties: false, required: ['value'],
            properties: {
              value: { ...SCALAR, description: 'A value of `on`, in its type (a number for a numeric column); null is the rows where it is missing.' },
              name: { type: 'string', pattern: NAME, description: 'The name of the column it becomes (default: `on` and the value, as a column name — country_us).' },
            },
          },
        },
      },
    }),
    build: ({ d, catalog, cols, source, place }, p) => {
      const groupBy = p.group_by || [];
      [...groupBy, p.on].forEach((c) => requireCol(cols, c));
      const taken = new Set(groupBy); const seen = new Set();
      // a value without a name of its own is named for `on` and itself (country + 'US' → country_us)
      const values = p.values.map((v) => (v.name !== undefined ? v : { ...v, name: `${p.on}_${String(v.value ?? 'null')}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+$/, '').slice(0, 41) }));
      for (const v of values) {
        if (taken.has(v.name)) throw new Error(`pivot: '${v.name}' names ${groupBy.includes(v.name) ? 'a group_by column' : 'two values'} — give each value a column name of its own`);
        taken.add(v.name);
        const key = JSON.stringify(v.value);
        if (seen.has(key)) throw new Error(`pivot: the value ${key} is listed twice`);
        seen.add(key);
      }
      // each cell: the measure, its every aggregate folding only the rows of that value
      const cells = values.map((v) => {
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
    schema: (catalog, { refNames = false } = {}) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'columns', 'keep', 'name_column', 'value_column'],
      description: 'Fold the listed columns into rows: one row per input row and folded column, with the column\'s name in `name_column` and its value in `value_column` (a NULL value too) — so the folded columns are of one type (numbers alike; cast the others first). The result is exactly `keep` + those two columns: list in keep every column that should stay beside them (the group keys, a day) — keep: [] keeps none. For wide→long/tidy reshaping, or turning a pivoted (metric-per-column) result back into rows.',
      properties: {
        stage: { enum: ['unpivot'] },
        columns: { type: 'array', minItems: 1, uniqueItems: true, items: columnSlot(refNames), description: `Columns to fold into rows.${refNames ? REF_NAMES_NOTE : ''}` },
        keep: { type: 'array', uniqueItems: true, items: columnSlot(refNames), description: `Columns carried as they are onto each folded row; every column not here and not folded is dropped ([]: none).${refNames ? REF_NAMES_NOTE : ''}` },
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
      out.set(p.value_column, { type: unpivotType(cols, p.columns) });
      // each folded column's type, as far as it is known: the lowering folds numbers through one type where
      // the warehouse folds only columns of one (BigQuery's UNPIVOT)
      const types = p.columns.map((c) => cols.get(c)?.type || 'unknown');
      return { op: { op: 'unpivot', keep, columns: p.columns, types, nameColumn: p.name_column, valueColumn: p.value_column }, cols: out };
    },
  },

  order_by: {
    // (after a metrics step a key may name a group_by item or a metric as the query names it: the result's column it gave)
    schema: (catalog, { refNames = false } = {}) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'keys'],
      description: 'Sort rows. For rankings/leaderboards (pair with limit) and stable output ordering. NULLs go last unless a key says first — the same on every warehouse.',
      properties: {
        stage: { enum: ['order_by'] },
        keys: { type: 'array', minItems: 1, items: refNames ? { ...SORT_KEY, properties: { ...SORT_KEY.properties, key: { ...columnSlot(true, SORT_KEY.properties.key), description: `The column to sort by.${REF_NAMES_NOTE}` } } } : SORT_KEY, description: 'The sort keys, in order.' },
      },
    }),
    build: ({ cols }, p) => {
      p.keys.forEach((k) => requireCol(cols, k.key)); return { op: { op: 'order_by', keys: p.keys.map((k) => ({ key: k.key, direction: k.direction, nulls: k.nulls })) }, cols }; },
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
    schema: (catalog, { refNames = false } = {}) => {
      const names = { type: 'array', minItems: 1, uniqueItems: true, items: columnSlot(refNames) };
      return {
        type: 'object',
        description: `Trim the columns before they are materialized: \`keep\` keeps exactly these (in this order), \`drop\` removes these and keeps the rest — { stage: "project", keep: ["a", "b"] }.${refNames ? REF_NAMES_NOTE : ''}`,
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
};

/** Register an additional stage from another module (match_recognize, python) — with the `group` it is
 *  listed under. */
export function registerStage(name, def) { STAGES[name] = def; }

/** One stage's definition by name (null for a name no stage has). */
export function stageDef(name) { return Object.hasOwn(STAGES, name) ? STAGES[name] : null; }

/** The first few column names of a step's output, for a hint. */
/** What lag / lead read: the neighbouring ROW in the window's order — said where a period is compared. */
export const NEIGHBOUR_NOTE = 'lag / lead read the neighbouring ROW in the window\'s order, not the neighbouring period: where a day (a week…) has no row, the previous row is an earlier one. For a change against the previous calendar period, make sure every period has a row (or compare dates with date_diff).';

export function listSome(columns, n = 6) {
  return `${columns.slice(0, n).map((c) => c.name).join(', ')}${columns.length > n ? ', …' : ''}`;
}

/** A stage may declare `available(catalog)`: false hides it from the schemas and refuses it in a build. */
export function availableStages(catalog) {
  return Object.values(STAGES).filter((s) => typeof s.available !== 'function' || s.available(catalog));
}

/**
 * WHAT A PLACE TAKES OF THE STAGES — one table, read by the builder for a tool's `$defs.stage` (stageSchema)
 * and checked as each step is built (stageAt): `what` names the place in a refusal, `stages` lists what it
 * takes by name (null: every stage of the registry), `elsewhere` says where a stage it leaves out is
 * built, and `offers` holds the steps it takes that are no stage of the registry — each ONE definition,
 * { stage, group, schema, elsewhere } (src/schema/fields.js METRICS_STEP): its form is listed under its
 * group in the `$defs.stage` of a tool this place is one of, and a place that does not take it says its
 * `elsewhere`. A feature checks a place of its own with stageAt, in this shape.
 *   build         — a pipeline build: every stage of the registry, over a table's rows;
 *   read          — a read of a stored table, a card's drill: the SQL stages that keep it one table; a
 *                   join, an unnest, a funnel or a python model makes a new table, built from the task;
 *   metric_scope  — a metric query up to its one metrics step: where steps, which filter the rows its
 *                   metrics fold (named as a metric query names a dimension: PLACES.metric_where), and
 *                   the metrics step, which it offers — MetricFlow computes it, no build does;
 *   metric_result — a metric query after its metrics step: what a read takes, over the result's columns.
 */
const READ_STAGES = ['where', 'compute', 'aggregate', 'pivot', 'unpivot', 'order_by', 'limit', 'sample', 'project'];
export const STAGE_PLACES = {
  build: { what: 'a build', stages: null, offers: [SEMANTIC_MODEL_STEP] },
  read: {
    what: 'a read', stages: READ_STAGES,
    elsewhere: 'makes a new table: build it from the task, build_model({ request: { action: "start", name, from_task } })',
  },
  metric_scope: { what: 'a step up to the metrics step', stages: ['where', METRICS_STEP.stage], offers: [METRICS_STEP] },
  metric_result: {
    what: 'a step after the metrics step', stages: READ_STAGES, refNames: true,
    elsewhere: 'makes a new table: store the result (materialize: true) and build from its task, build_model({ request: { action: "start", name, from_task } })',
  },
};

/** Whether a place takes a step: one its list names — or, where it lists none, every stage of the registry. */
function takes(p, name) {
  return p.stages ? p.stages.includes(name) : stageDef(name) !== null || (p.offers || []).some((s) => s.stage === name);
}

/** The step a place of the table offers of its own under this name — no stage of the registry (a metric
 *  query's metrics step) — or null. */
export function offeredStep(name) {
  for (const p of Object.values(STAGE_PLACES)) for (const s of p.offers || []) if (s.stage === name) return s;
  return null;
}

/** A step at a place (a STAGE_PLACES name, or a place of that shape): refused when the place does not
 *  take its stage — naming the place, what it takes and where a stage it leaves out is built (a step
 *  another place offers, by that step's own words). `at` names the step (none: the caller does). */
export function stageAt(place, st, at = null) {
  const p = typeof place === 'string' ? STAGE_PLACES[place] : place;
  const kind = st?.stage;
  if (takes(p, kind)) return;
  const def = kind === undefined ? null : stageDef(kind);
  // a step another place offers makes no table here: it is said where it is taken
  const own = def || kind === undefined ? null : offeredStep(kind);
  const why = kind === undefined ? 'this step names no `stage`'
    : own ? own.elsewhere
      : !def ? `there is no '${kind}' stage`
        : `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} stage ${p.elsewhere || 'is not one of them'}`;
  throw new Error(`${at ? `${at}: ` : ''}${p.what} takes ${p.stages ? p.stages.join(', ') : 'every stage over a table\'s rows'} — ${why}`);
}

/**
 * THE STAGE GROUPS — what a step needs to work, the titles a tool's `$defs.stage` lists its steps under.
 * A stage says its `group` (one that says none is SQL over rows); a step a place offers, its own
 * (`semantic`: the metrics step).
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
 * by what it needs (a titled union per group; a group left empty is left out). The steps a place offers of
 * its own (`offers`: the metrics step, query_model's) join the group each names, as `runtime` —
 * the forms a feature adds to ITS tools' runtime group, its library's steps tagged by what they are — joins
 * that one; the core's tools pass none, so nothing of a feature is in their definition. One definition per
 * tool: the one step and the list of steps point at it, and where its places take different stages, each
 * place narrows it as the step is built (STAGE_PLACES, stageAt). `project`: the dbt project's own layer,
 * which a step of the semantic layer names in its text.
 */
export function stageSchema(catalog, { runtime = [], places = null, project = null } = {}) {
  const at = stagePlacesOf(places);
  const registry = Object.entries(STAGES).filter(([, s]) => typeof s.available !== 'function' || s.available(catalog));
  const taken = registry.filter(([name]) => (at || [STAGE_PLACES.build]).some((p) => takes(p, name)));
  // a sort key may name a group_by item by its ref where a place of the tool sorts a metrics step's result
  const refNames = (at || []).some((p) => p.refNames);
  // the steps the places offer of their own (no stage of the registry), each once
  const own = [...new Map((at || []).flatMap((p) => p.offers || []).map((s) => [s.stage, s])).values()];
  const forms = (group) => [
    ...taken.filter(([, s]) => (s.group || 'sql') === group).map(([, s]) => s.schema(catalog, { project, refNames })),
    ...own.filter((s) => s.group === group).map((s) => s.schema(catalog, { project })),
    ...(group === 'runtime' ? runtime : []),
  ];
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
  const names = [...taken.map(([name]) => name), ...own.map((s) => s.stage)];
  const several = at.length > 1 && new Set(at.map((p) => (p.stages || ['*']).join())).size > 1;
  // (the stages of the registry these places leave out — each a build's, making a new table)
  const left = registry.map(([name]) => name).filter((name) => !names.includes(name));
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
 * declare its own — the one expression, `expr`, and the window, `over` / `over_frame`, are compute's) and `stage`,
 * the one stage definition. They sit at the tool's root, where `#/$defs/…` resolves. `project` reaches the
 * expression's refs (the dbt project's semantic models and entities); `runtime` and `places` (the tool's
 * stage places, with the steps they offer) as stageSchema's; `exprPlaces` the tool's expression places
 * (src/pipeline/compute.js PLACES), which its `$defs.expr` is built for.
 */
export function stageDefs(catalog, { project = null, runtime = [], places = null, exprPlaces = null } = {}) {
  return {
    ...Object.assign({}, ...availableStages(catalog).map((s) => (typeof s.defs === 'function' ? s.defs(catalog, { project, places: exprPlaces }) : {}))),
    stage: stageSchema(catalog, { runtime, places, project }),
  };
}
