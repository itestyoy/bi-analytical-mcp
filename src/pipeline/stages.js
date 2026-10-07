// THE STAGE REGISTRY — every stage a pipeline can have: its schema, its build (the SQL op it adds and
// the columns it leaves), and what the registry knows about it (`available` on this warehouse,
// `keepsSourceRows`, the next-step hints it `recommend`s). match_recognize and python register
// themselves (src/match-recognize.js, src/python-model.js).

import { NAME, AGG_FNS, SKETCH_FNS, statAccuracyNote, EXPR, CONDITIONS, measureSchema, sourceProp, condPred, aggExpr, sqlAgg, addCol, requireCol } from './sql.js';
import { exprSchema, exprSql } from './compute.js';
import { form, strEnum } from '../schema-kit.js';
import { conditionsSql } from '../conditions.js';
import { physicalColumnType } from '../catalog/column-types.js';

// ── Stage registry ───────────────────────────────────────────────────────────
export const STAGES = {
  where: {
    keepsSourceRows: true,
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'conditions'],
      description: 'Keep only rows where all conditions hold; { or: [...] } holds when any of its items does (each a condition or { and: [...] }). A condition compares a column ({ column, op, value }) or an expression ({ left, op, right }) with a constant, a column or now — an expression on the right only with eq … lte. Use it to scope to events, a segment or a value range, anywhere in the pipeline, after a window or an aggregate too. A constant is compared in the column\'s type (a boolean column takes true / false, a numeric one a number); another type is refused here rather than by the warehouse.',
      properties: {
        stage: { enum: ['where'] },
        conditions: CONDITIONS('The conditions a row is kept by: all of them hold.'),
      },
    }),
    build: ({ d, catalog, cols, source }, p) => ({ op: { op: 'where', preds: conditionsSql(p.conditions, (c) => condPred(d, cols, c, { windows: false, catalog, source })) }, cols }),
  },

  compute: {
    keepsSourceRows: true,
    // the expression grammar, once: every stage that takes an operand references it
    defs: (catalog) => ({ expr: exprSchema(catalog) }),
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'name', 'expr'],
      description: 'Add a column computed by one expression (`expr`) over the columns, event properties and constants — arithmetic, text, dates, a CASE, a window function — nested, so a whole formula is one stage.',
      properties: {
        stage: { enum: ['compute'] },
        name: { type: 'string', pattern: NAME, description: 'The name of the column it adds.' },
        expr: EXPR,
      },
    }),
    build: ({ d, catalog, cols, source }, p) => {
      const { sql, type } = exprSql(d, cols, p.expr, `compute '${p.name}'`, { catalog, source });
      return { op: { op: 'extend', cols: [{ name: p.name, expr: sql }] }, cols: addCol(cols, p.name, type) };
    },
  },

  unnest: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'source', 'name'],
      description: 'Explode an array property into one row per element (CHANGES GRAIN; rows without the array drop out). For per-element analysis (e.g. items collected, rewards granted). For arrays of structs: bind a single struct `field`, or omit `field` to bind the whole element and pull multiple fields from it downstream with a compute json_field.',
      properties: {
        stage: { enum: ['unnest'] },
        source: { type: 'string', description: 'Array/struct to explode: an array event property (see semantic_index), or a pipeline column produced by a compute json_parse_array. A flat ARRAY column unnests directly; a JSON-string column is parsed first.' },
        name: { type: 'string', pattern: NAME, description: 'The name the element column gets.' },
        field: { type: 'string', description: 'For array-of-struct: a single struct field to bind. Omit to bind the whole struct element (a JSON column) for multi-field extraction via compute json_field.' },
        type: { enum: ['int', 'numeric', 'float', 'string'] },
      },
    }),
    build: ({ catalog, cols, source }, p) => {
      const found = sourceProp(catalog, source, p.source);
      const spec = found?.spec;
      let column; let key; let encoding; let isStruct = false;
      if (spec) {
        if (!String(spec.type || '').toLowerCase().startsWith('array')) {
          throw new Error(`unnest: '${p.source}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — there is nothing to explode. Declare the column with meta.mcp.array if it holds one, or read a single field with a compute json_field.`);
        }
        isStruct = String(spec.type || '').toLowerCase() === 'array<struct>';
        if (spec.column) { column = spec.column; key = null; encoding = spec.encoding || 'native'; } // flattened array column
        else { column = catalog.eventDataColumn(source); key = found.name; encoding = 'blob'; } // a property inside the JSON blob
      } else if (cols.has(p.source) && cols.get(p.source).type === 'array') {
        column = p.source; key = null; encoding = 'native'; // a pipeline-derived array (e.g. from json_parse_array)
      } else {
        throw new Error(`unnest: '${p.source}' is not an array event property of '${source}' nor an array column at this stage`);
      }
      // The column it explodes must still be HERE, exactly as an event_property read's must: after a stage
      // that changed the grain (or on top of a materialized prefix built from one) the payload is
      // gone, and the unnest would reference a column the relation does not have.
      requireCol(cols, column);
      const type = p.field ? (p.type || 'string') : (isStruct ? 'json' : (p.type || 'string'));
      return { op: { op: 'unnest', column, key, as: p.name, field: p.field, type, encoding }, cols: addCol(cols, p.name, type) };
    },
  },

  join: {
    keepsSourceRows: true,
    recommend: () => ['Joined columns are now referenceable; add a where to filter on them or an aggregate to roll up.'],
    schema: (catalog) => {
      // ONE CLOSED FORM PER JOINED MODEL AND WAY OF MATCHING: `with` pinned, and every column the form
      // names — attrs, the window's bounds, the shared key — one of THAT model's own columns, so a
      // join is written only with names the model has. (Its left side — `via`'s key on the
      // pipeline's own source, `between.value` — is the pipeline's, checked when the step is added.)
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
            type: 'object', additionalProperties: false, required: ['value', 'from', 'to'],
            description: 'The version valid at a moment of this side (see the stage).',
            properties: {
              // from / to: the window's lower and upper bound columns on the joined model (inclusive), e.g. valid_from / valid_until
              value: { type: 'string', pattern: NAME, description: 'A column of this side (e.g. the event time); from / to are the joined model\'s bounds, inclusive.' },
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
          + ` Use { column, name } to expose one under a different name. semantic_index({ request: { model: '${p.with}' } }) describes them.`,
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
        // `value` is a column on THIS side (validated against the live column set); `from`/`to`
        // are columns of the JOINED model (validated against its declared columns when known).
        requireCol(cols, p.between.value);
        const joinedCols = new Set([...catalog.modelColumns(p.with).map((c) => c.name), ...Object.keys(m.dimensions || {})]);
        for (const side of ['from', 'to']) {
          const c = p.between[side];
          if (joinedCols.size && !joinedCols.has(c)) throw new Error(`join between.${side}: '${c}' is not a column of '${p.with}' (available: ${[...joinedCols].join(', ')})`);
        }
        between = { value: p.between.value, from: p.between.from, to: p.between.to };
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
      description: `Group rows and compute measures — the grain collapses to the group keys. A table-wide number (a threshold, a mean) is this stage with no group_by — one row, then applied per row later as a { value }; a window with no partition_by keeps every row and runs out of memory on a large table ("Resources exceeded"). `
        + `${statAccuracyNote(catalog)}`,
      properties: {
        stage: { enum: ['aggregate'] },
        group_by: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Grouping columns (empty = grand total).' },
        measures: { type: 'array', minItems: 1, items: measureSchema({ aggs: AGG_FNS, column: { type: 'string' }, where: CONDITIONS('A conditional aggregate: fold only the rows these conditions hold for — count the failed loads, sum the revenue of payers.'), description: 'A measure. For distinct counts prefer the HLL sketch: approx_count_distinct (one shot), or hll_init per group → hll_merge (mergeable across buckets and segments); exact count_distinct does not re-aggregate across groups.' }) },
      },
    }),
    build: ({ d, catalog, cols, source }, p) => {
      const groupBy = p.group_by || [];
      for (const g of groupBy) requireCol(cols, g);
      const aggs = p.measures.map((m) => {
        if (m.column) requireCol(cols, m.column);
        // a measure's own where: it folds only the rows those conditions hold for (the grammar of a where stage)
        const cond = m.where?.length ? conditionsSql(m.where, (c) => condPred(d, cols, c, { windows: false, catalog, source })).map((x) => `(${x})`).join(' AND ') : null;
        return { as: m.name, expr: aggExpr(d, m.agg, m.column, m.percentile, cond) };
      });
      let out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      // the earliest / latest of a column is of the column's type (a time stays a time); every other aggregate is a number
      for (const m of p.measures) out.set(m.name, { type: SKETCH_FNS.has(m.agg) ? 'sketch' : (m.agg === 'min' || m.agg === 'max') && m.column ? (cols.get(m.column)?.type || 'unknown') : 'numeric' });
      return { op: { op: 'aggregate', groupBy, aggs }, cols: out };
    },
  },

  pivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'on', 'agg', 'value_column', 'values'],
      description: 'Turn listed values of `on` into columns, each aggregating `value_column` (the values must be listed explicitly). For dashboard-ready matrices (e.g. revenue as one column per country, or retention day as columns).',
      properties: {
        stage: { enum: ['pivot'] },
        group_by: { type: 'array', uniqueItems: true, items: { type: 'string' }, description: 'Row keys kept (empty = one row).' },
        on: { type: 'string', description: 'Column whose values become columns.' },
        agg: { enum: ['sum', 'average', 'min', 'max', 'count'], description: 'How each pivoted cell aggregates value_column.' },
        value_column: { type: 'string', description: 'Column aggregated into each pivoted column.' },
        values: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_]+$' }, description: 'The values of `on` to pivot into columns.' },
      },
    }),
    build: ({ cols }, p) => {
      const groupBy = p.group_by || [];
      [...groupBy, p.on, p.value_column].forEach((c) => requireCol(cols, c));
      let out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const v of p.values) out.set(v, { type: 'numeric' });
      return { op: { op: 'pivot', groupBy, on: p.on, fn: sqlAgg(p.agg), valueCol: p.value_column, values: p.values }, cols: out };
    },
  },

  unpivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'columns', 'name_as', 'value_as'],
      description: 'Fold the listed columns into rows of (name_as, value_as), keeping the rest. For wide→long/tidy reshaping, or turning a pivoted (metric-per-column) result back into rows.',
      properties: {
        stage: { enum: ['unpivot'] },
        columns: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Columns to fold into rows.' },
        keep: { type: 'array', items: { type: 'string' }, description: 'Columns to keep as-is (default: none).' },
        name_as: { type: 'string', pattern: NAME },
        value_as: { type: 'string', pattern: NAME },
      },
    }),
    build: ({ cols }, p) => {
      const keep = p.keep || [];
      [...keep, ...p.columns].forEach((c) => requireCol(cols, c));
      let out = new Map();
      for (const k of keep) out.set(k, cols.get(k) || { type: 'string' });
      out.set(p.name_as, { type: 'string' });
      out.set(p.value_as, { type: 'numeric' });
      return { op: { op: 'unpivot', keep, columns: p.columns, nameAs: p.name_as, valueAs: p.value_as }, cols: out };
    },
  },

  order_by: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'keys'],
      description: 'Sort rows. For rankings/leaderboards (pair with limit) and stable output ordering.',
      properties: { stage: { enum: ['order_by'] }, keys: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } } } },
    }),
    build: ({ cols }, p) => { p.keys.forEach((k) => requireCol(cols, k.key)); return { op: { op: 'order_by', keys: p.keys.map((k) => ({ key: k.key, dir: k.direction })) }, cols }; },
  },

  limit: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'n'], description: 'Cap the number of rows. For top-N (after order_by) or previews.', properties: { stage: { enum: ['limit'] }, n: { type: 'integer', minimum: 1, maximum: 1000000 } } }),
    build: ({ cols }, p) => ({ op: { op: 'limit', n: p.n }, cols }),
  },

  sample: {
    keepsSourceRows: true,
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'percent'],
      description: 'Keep about `percent`% of rows at random — a fast, approximate first look on large data. Put it early. The result is flagged approximate; rerun without it for any number you act on (sampling error is large near 0 / 1 rates, in small segments and for distinct counts).',
      properties: {
        stage: { enum: ['sample'] },
        percent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Approximate share of rows to keep (0 < percent <= 100).' },
      },
    }),
    build: ({ cols }, p) => ({ op: { op: 'sample', percent: p.percent }, cols }),
  },

  project: {
    schema: () => {
      const names = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } };
      return {
        type: 'object',
        description: 'Trim the columns before they are materialized: `columns` keeps exactly these (in this order), `drop` removes these and keeps the rest.',
        anyOf: [
          form({ title: 'keep these columns', required: ['stage', 'columns'], properties: { stage: { enum: ['project'] }, columns: { ...names, description: 'The columns to keep, in order.' } } }),
          form({ title: 'drop these columns', required: ['stage', 'drop'], properties: { stage: { enum: ['project'] }, drop: { ...names, description: 'The columns to remove; every other column stays.' } } }),
        ],
      };
    },
    build: ({ cols }, p) => {
      const keep = p.drop ? (p.drop.forEach((c) => requireCol(cols, c)), [...cols.keys()].filter((c) => !p.drop.includes(c))) : p.columns;
      if (!keep.length) throw new Error('project: dropping every column leaves nothing to keep');
      keep.forEach((c) => requireCol(cols, c));
      const out = new Map(); for (const c of keep) out.set(c, cols.get(c) || { type: 'string' });
      return { op: { op: 'project', cols: keep }, cols: out };
    },
  },
};

/** Register an additional stage from another module (e.g. match_recognize). */
export function registerStage(name, def) { STAGES[name] = def; }

/** One stage's definition by name (null for a name no stage has). */
export function stageDef(name) { return Object.hasOwn(STAGES, name) ? STAGES[name] : null; }

/** The first few column names of a step's output, for a hint. */
export function listSome(columns, n = 6) {
  return `${columns.slice(0, n).map((c) => c.name).join(', ')}${columns.length > n ? ', …' : ''}`;
}

/**
 * Root-level `$defs` the stage schemas reference (`#/$defs/<name>`). A tool schema that embeds
 * pipelineStageSchema() must carry these at ITS root — `$ref` resolves against
 * the document it is embedded in, so the definitions cannot travel inside the stage fragment.
 */
export function stageDefs(catalog) {
  return {
    ...Object.assign({}, ...availableStages(catalog).map((s) => (typeof s.defs === 'function' ? s.defs(catalog) : {}))),
    // THE STAGE UNION ITSELF, once. A tool that takes both one stage and a list of them embedded
    // the whole union TWICE — with this catalog that was ~49 KB of schema repeated verbatim, half
    // of everything the client is handed before it reads a single word. Both sites now point here.
    pipeline_stage: pipelineStageSchema(catalog),
  };
}

/** A stage may declare `available(catalog)`: false hides it from the schemas and refuses it in a build. */
export function availableStages(catalog) {
  return Object.values(STAGES).filter((s) => typeof s.available !== 'function' || s.available(catalog));
}

export function pipelineStageSchema(catalog) {
  // each stage's schema pins `stage` to its own name, so exactly one branch is the stage asked for —
  // and the refusal of a bad stage is that stage's, not every stage's (src/validate.js)
  return { anyOf: availableStages(catalog).map((s) => s.schema(catalog)) };
}
