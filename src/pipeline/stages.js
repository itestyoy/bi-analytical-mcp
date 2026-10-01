// THE STAGE REGISTRY — every stage a pipeline can have: its schema, its build (the SQL op it adds and
// the columns it leaves), and what the registry knows about it (`available` on this warehouse,
// `keepsSourceRows`, the next-step hints it `recommend`s). match_recognize and python register
// themselves (src/match-recognize.js, src/python-model.js).

import { GRAINS } from '../catalog.js';
import { NAME, AGG_FNS, SKETCH_FNS, statAccuracyNote, OPERAND, CONDITION, propEnum, sourceProp, operandSql, condPred, aggExpr, sqlAgg, addCol, requireCol } from './sql.js';
import { COMPUTE_OPS, computeForms } from './compute.js';
import { form, pick, strEnum } from '../schema-kit.js';

// ── Stage registry ───────────────────────────────────────────────────────────
export const STAGES = {
  where: {
    keepsSourceRows: true,
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'conditions'],
      description: 'Keep only rows where all conditions hold (ANDed). Each condition compares two operands — each a column, a literal constant, or the current time (now). Shorthand `{column, op, value}` = column vs constant; or `{left, op, right}` for column-vs-column / constant-vs-column. Use it to scope to an event, a segment, or a value range — at any point in the pipeline, including after a window or aggregate to filter on a computed column. A constant is compared in the column\'s own type: a boolean column takes true / false ("true" is read as true), a numeric one a number; one of another type is refused here, since the warehouse would refuse it.',
      properties: {
        stage: { enum: ['where'] },
        conditions: { type: 'array', minItems: 1, items: CONDITION },
      },
    }),
    build: ({ d, cols }, p) => ({ op: { op: 'where', preds: p.conditions.map((c) => condPred(d, cols, c)) }, cols }),
  },

  derive: {
    keepsSourceRows: true,
    schema: (catalog) => {
      const fields = {
        stage: { enum: ['derive'] },
        name: { type: 'string', pattern: NAME },
        source: propEnum(catalog.eventPropEnum(), 'event_data property the value derives from — one of the PIPELINE SOURCE\'s own properties (a property of another source is rejected, naming the source that has it).'),
        value: { description: 'The value to look for in the array.' },
        field: { type: 'string', description: 'The struct field to read.' },
        type: { enum: ['int', 'numeric', 'float', 'string'], description: 'Result/extract type (default string).' },
      };
      // one form per op, each with the fields that op reads
      const op = (value, title, needs, may = []) => form({ title, tag: ['op', value], required: ['stage', 'name', 'source', ...needs], properties: pick(fields, ['stage', 'name', 'source', ...needs, ...may]) });
      return {
        type: 'object',
        description: 'Add ONE scalar column from an event property — `extract` a scalar value, or `array_length`/`contains`/`struct_field` for array/struct properties. Surfaces a payload field so it can be filtered, grouped, or aggregated. For math/time/CASE/window over EXISTING columns, use `compute`.',
        anyOf: [
          op('extract', 'op: extract — a scalar value', [], ['type']),
          op('array_length', 'op: array_length — how many elements an array holds', []),
          op('contains', 'op: contains — whether an array holds `value`', ['value']),
          op('struct_field', 'op: struct_field — one field of a struct', ['field'], ['type']),
        ],
      };
    },
    build: ({ d, catalog, cols, source }, p) => {
      // The RAW payload blob. Only a BLOB property is ever read through it; a flattened payload
      // column carries its value itself and is referenced directly below — which is what makes
      // these ops work on a fully flattened fact (a crash report exploded into real columns),
      // where there is no blob at all.
      const blob = catalog.eventDataColumn(source);
      const found = sourceProp(catalog, source, p.source);
      const spec = found?.spec;
      const key = found?.name || p.source; // the PHYSICAL payload key (qualifier stripped)
      // A payload read depends on a REAL column of the row (the flattened one, or the blob). After a
      // stage that changed the grain — or on top of a materialized prefix built from one — it is
      // gone, and the expression would reference a column the relation does not have.
      requireCol(cols, spec?.column || blob);
      // A FLATTENED payload column carries the array/object itself; `encoding` says whether it
      // is a native ARRAY or a STRING holding JSON, which decides how to read it.
      const flat = spec?.column || null;
      const native = flat && (spec.encoding || 'native') === 'native';
      // An array op on a property that is not an array builds SQL the warehouse will reject
      // (array_length over text). Say so here, naming what the property actually is.
      if ((p.op === 'array_length' || p.op === 'contains') && spec && !String(spec.type || '').toLowerCase().startsWith('array')) {
        throw new Error(`derive ${p.op}: '${p.source}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — ${p.op} needs an array (declare the column with meta.mcp.array, or an array / array<struct> entry in the payload spec). For a JSON OBJECT use op=struct_field, or compute op=json_field.`);
      }
      let expr; let type;
      if (p.op === 'extract') {
        // the catalog's one rule for reading a scalar property (flat column or JSON extract)
        expr = spec ? catalog.propertyExpr(source, key, d.name, { type: p.type }) : d.jsonExtract(blob, key, p.type || 'string');
        type = p.type || spec?.type || 'string';
      } else if (p.op === 'array_length') {
        expr = flat ? (native ? d.arrayLength(flat) : d.jsonColumnArrayLength(flat)) : d.jsonArrayLength(blob, key);
        type = 'int';
      } else if (p.op === 'contains') {
        expr = flat ? (native ? d.arrayContains(flat, p.value) : d.jsonColumnArrayContains(flat, p.value)) : d.jsonArrayContains(blob, key, p.value);
        type = 'boolean';
      } else if (p.op === 'struct_field') {
        expr = flat ? d.jsonColumnStructField(flat, p.field, p.type) : d.jsonStructField(blob, key, p.field, p.type);
        type = p.type || 'string';
      } else throw new Error(`derive: bad op ${p.op}`);
      return { op: { op: 'extend', cols: [{ name: p.name, expr }] }, cols: addCol(cols, p.name, type) };
    },
  },

  compute: {
    keepsSourceRows: true,
    schema: () => {
      const fields = {
        field: { type: 'string', description: 'Struct field name for op=json_field — extract one field from a column holding a JSON OBJECT: an unnested array-of-struct element, or a flattened payload column that holds JSON (e.g. a crash report\'s custom keys).' },
        value: { description: 'Constant literal (number / string / boolean) for op=const.' },
        left: OPERAND, right: OPERAND, // arithmetic
        from: OPERAND, to: OPERAND, // date_diff / elapsed_days (each may be { column } / { value } / { now: true })
        // For retention with elapsed_days, anchor `from` on the TRUE install/cohort timestamp
        // (e.g. install_date) — NOT an SCD validity bound like install_time_valid_from, whose
        // open side is a sentinel (e.g. 1970-01-01), which makes retention_day nonsensically huge.
        clamp_zero: { type: 'boolean', description: 'op=elapsed_days: fold negative (pre-`from`) and NULL (e.g. missing install_date) results to 0, so it is a clean day 0+. Default true; set false for the raw signed/NULL-able value.' },
        column: { type: 'string', description: 'Input column for round/floor/ceil/abs/cast/upper/lower/length/substring/trim/replace/date_trunc/date_part, and for window lag/lead/sum/average/min/max.' },
        columns: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Inputs for coalesce, all of them columns; its literal fallback is `default`.' },
        parts: { type: 'array', items: OPERAND, minItems: 1, description: 'Operands — each { column } or { value } — for op=concat and for least/greatest: least of two columns is parts [{ column: "a" }, { column: "b" }]; winsorizing at a threshold computed earlier is least with parts [{ column }, { value: <threshold> }].' },
        search: { type: 'string', description: 'Substring to find for op=replace.' },
        replacement: { type: 'string', description: 'Replacement string for op=replace.' },
        start: { type: 'integer', minimum: 1, description: '1-based start position for op=substring.' },
        index: { type: 'integer', minimum: 1, description: '1-based index for op=element_at.' },
        sql: { type: 'string', description: 'Raw dialect SQL expression over existing columns — escape hatch for op=raw when no built-in op fits (e.g. array indexing, dialect functions). Not portable across dialects. It reads only the columns available at this step: a name it uses that is not one of them is refused when the step is added.' },
        len: { type: 'integer', minimum: 0, description: 'Length (chars) for op=substring (optional).' },
        unit: { enum: ['day', 'hour', 'minute', 'second'], description: 'date_diff unit.' },
        granularity: { enum: GRAINS, description: 'date_trunc granularity.' },
        part: { enum: ['dow', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'doy'], description: 'date_part to extract.' },
        places: { type: 'integer', minimum: 0, maximum: 12, description: 'Decimal places for round (default 0).' },
        default: { description: 'Fallback literal for coalesce, or default for window lag/lead.' },
        type: { enum: ['int', 'numeric', 'float', 'string'], description: 'Target type for cast / CASE result type. cast is SAFE — a value that will not convert becomes NULL rather than failing the query.' },
        // op=case
        cases: { type: 'array', minItems: 1, description: 'CASE branches (first matching wins); each `when` is a list of ANDed conditions, `then` an operand.', items: { type: 'object', additionalProperties: false, required: ['when', 'then'], properties: { when: { type: 'array', minItems: 1, items: CONDITION }, then: OPERAND } } },
        else: OPERAND,
        // op=window
        fn: { enum: ['row_number', 'rank', 'dense_rank', 'lag', 'lead', 'sum', 'average', 'count', 'min', 'max'], description: 'Window function for op=window.' },
        partition_by: { type: 'array', items: { type: 'string' }, description: 'Window partition columns. LEAVING IT OUT MAKES ONE GLOBAL WINDOW over every row, which one worker has to hold: on a large table that is how a query runs out of memory ("Resources exceeded during query execution"). A window is for a value computed WITHIN a group (per player, per day, per session) — for a table-wide number use an aggregate stage with no group_by (one row) and apply it as a literal afterwards.' },
        order_by: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string' }, direction: { enum: ['asc', 'desc'] } } }, description: 'Window ordering.' },
        offset: { type: 'integer', minimum: 1, description: 'Row offset for window lag/lead (default 1).' },
        frame: {
          type: 'object', additionalProperties: false,
          description: 'Window frame for aggregate window fns (sum/average/count/min/max). ROWS = physical row offsets; RANGE = value offsets on the ORDER BY key (for a rolling N-DAY window, order by a unix_date column and use range with preceding:N). Omit for the default frame.',
          properties: {
            mode: { enum: ['rows', 'range'], description: 'rows = physical rows; range = value-based on the order key.' },
            preceding: { description: 'Lower bound: an integer offset, or "unbounded" (default unbounded).' },
            following: { description: 'Upper bound: an integer offset, "unbounded", or 0/omitted = CURRENT ROW.' },
          },
        },
      };
      return {
        type: 'object',
        description: 'Add a column from existing columns + literals: arithmetic, rounding, coalesce, cast, string fns, date functions (date_diff/date_trunc/date_part/unix_date/elapsed_days), a CASE expression (op=case), or a window function (op=window: row_number/rank/lag/lead/running & rolling aggregates). Each op enforces its required params at the schema level.',
        anyOf: computeForms({ required: ['stage', 'name', 'op'], properties: { stage: { enum: ['compute'] }, name: { type: 'string', pattern: NAME } } }, fields),
      };
    },
    build: ({ d, cols }, p) => {
      const op = Object.hasOwn(COMPUTE_OPS, p.op) ? COMPUTE_OPS[p.op] : null;
      if (!op) throw new Error(`compute: bad op ${p.op}`);
      const { expr, type = 'numeric' } = op.sql({
        d, cols, p,
        operand: (o, what) => operandSql(d, cols, o, `compute ${p.op} ${what}`),
        col: () => { requireCol(cols, p.column); return d.quoteIdent(p.column); },
        list: () => { (p.columns || []).forEach((c) => requireCol(cols, c)); return (p.columns || []).map((c) => d.quoteIdent(c)); },
      });
      return { op: { op: 'extend', cols: [{ name: p.name, expr }] }, cols: addCol(cols, p.name, type) };
    },
  },

  unnest: {
    schema: (catalog) => ({
      type: 'object', additionalProperties: false, required: ['stage', 'source', 'name'],
      description: 'Explode an array property into one row per element (CHANGES GRAIN; rows without the array drop out). For per-element analysis (e.g. items collected, rewards granted). For arrays of structs: bind a single struct `field`, or omit `field` to bind the whole element and pull multiple fields from it downstream with compute op=json_field.',
      properties: {
        stage: { enum: ['unnest'] },
        source: { type: 'string', description: 'Array/struct to explode: an array event property (see semantic_index), or a pipeline column produced by compute op=json_parse_array. A flat ARRAY column unnests directly; a JSON-string column is parsed first.' },
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
          throw new Error(`unnest: '${p.source}' is ${spec.type ? `declared as ${spec.type}` : 'a scalar property'}, not an array — there is nothing to explode. Declare the column with meta.mcp.array if it holds one, or read a single field with compute op=json_field.`);
        }
        isStruct = String(spec.type || '').toLowerCase() === 'array<struct>';
        if (spec.column) { column = spec.column; key = null; encoding = spec.encoding || 'native'; } // flattened array column
        else { column = catalog.eventDataColumn(source); key = found.name; encoding = 'blob'; } // a property inside the JSON blob
      } else if (cols.has(p.source) && cols.get(p.source).type === 'array') {
        column = p.source; key = null; encoding = 'native'; // a pipeline-derived array (e.g. from json_parse_array)
      } else {
        throw new Error(`unnest: '${p.source}' is not an array event property of '${source}' nor an array column at this stage`);
      }
      // The column it explodes must still be HERE, exactly as `derive`'s read must: after a stage
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
          with: { const: model, description: 'Catalog model to join (any model but the pipeline\'s own source).' },
          attrs: {
            type: 'array', minItems: 1, uniqueItems: true,
            description: 'The columns of the joined model to expose — exactly these arrive (see the stage).',
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
            description: 'Point-in-time window on the joined model (see the stage).',
            properties: {
              // from / to: the window's lower and upper bound columns on the joined model (inclusive), e.g. valid_from / valid_until
              value: { type: 'string', pattern: NAME, description: 'A column on THIS (left) side compared against the window — e.g. the event time; from / to are the joined model\'s lower and upper bound columns (inclusive), e.g. valid_from / valid_until.' },
              from: column,
              to: column,
            },
          },
          kind: { enum: ['left', 'inner'], default: 'left' },
        };
        // the relationships this model carries that another model carries too — what `via` can name
        const vias = Object.keys(catalog.entitiesOf(model)).filter((e) => catalog.joinEntityNames().includes(e));
        if (vias.length) {
          forms.push(form({ title: `join ${model} by a declared relationship (via)`, tag: ['stage', 'join'], required: ['stage', 'with', 'via', 'attrs'], properties: { ...fields, via: { enum: vias, description: 'A relationship declared in the schema and carried by both sides (see the stage).' } } }));
        }
        forms.push(form({
          title: `join ${model} on columns both sides name alike (on)`, tag: ['stage', 'join'], required: ['stage', 'with', 'on', 'attrs'],
          properties: { ...fields, on: { type: 'array', minItems: 1, uniqueItems: true, items: column, description: 'Ad-hoc fallback when no relationship is declared: the key column(s) that exist under the SAME NAME on both sides — several for a composite key.' } },
        }));
      }
      return {
        type: 'object',
        description: 'Bring in columns from a related model, exposing them for grouping and date math. PREFER `via`: the relationship and its key columns are declared in the catalog schema, so you never restate them and cannot pick the wrong column. Use `on` only for an ad-hoc match on a column both sides happen to name identically. Add `between` when the joined model keeps SEVERAL VERSIONS per key (a validity window): without it every row matches every historical version and counts/sums inflate. `attrs` is REQUIRED and it is the whole contract: exactly the columns you list arrive, nothing is pulled in implicitly, so what the next stage sees is what you asked for. semantic_index({ request: { model } }) lists what a model has to offer. Join stages STACK — each one sees everything the previous ones added, so a chain can reach several models; `via` always resolves its left-hand key on the pipeline\'s OWN source, so every relationship you chain must be declared there. VIA: A RELATIONSHIP declared in the schema and carried by both sides. Its key columns come from the catalog, so you never restate them, and the two sides may name their columns differently — a key may span SEVERAL columns (e.g. an ad-funnel id together with the player). When one side carries the relationship on several ALTERNATIVE columns (one tracking id per ad format), each is offered as its own `<relationship>_<variant>` and you pick the one the question is about. A relationship no model OWNS has no governed path and is joinable only here — that is normal, not a limitation. semantic_index({ request: { model } }) lists each model\'s relationships, their key columns and what they point at. ATTRS: REQUIRED — the columns of the joined model to expose, and the ONLY ones that arrive. Nothing is added implicitly: list what the downstream stages will use. Each entry is { column } — or { column, name } to expose it under a different name. A name that would end up used twice — because the pipeline already has one, or because two entries resolve to the same name — is rejected with the reason and the rename to apply, since one name cannot address two columns. semantic_index({ request: { model } }) lists the joined model\'s columns. BETWEEN: Point-in-time / SCD-2 range condition ANDed with the key equality: keep the joined row whose validity window contains a value from THIS side — `base.<value> BETWEEN joined.<from> AND joined.<to>`. Use it to pick the version of a slowly-changing dimension valid at the moment being asked about. Which moment that is CHANGES THE ANSWER: attributing a crash by the crash time and by the time of the ad that preceded it can land the same player in different cohorts — so state it deliberately. Ensure the joined windows do not overlap, or a row can match several versions. In a metric query nothing has to be stated: MetricFlow applies the window itself.',
        anyOf: forms,
      };
    },
    build: ({ catalog, cols, source }, p) => {
      const m = catalog.getModel(p.with);
      if (p.with === source) throw new Error(`join: '${p.with}' is the pipeline's own source — join a DIFFERENT model (a self-join is not expressible as a stage)`);
      if (p.via && p.on) throw new Error('join: pass `via` (the declared relationship) OR `on` (ad-hoc shared column names), not both');
      let on = []; let onKeys;
      if (p.via) {
        // The key columns come from the SCHEMA, on both sides — including a composite key — and
        // each side may name its columns its own way. The LEFT key is resolved on the pipeline's
        // own SOURCE, not on whatever the previous stages accumulated, so a chained join must use
        // a relationship the source itself declares.
        const left = catalog.entityKey(source, p.via);
        const right = catalog.entityKey(p.with, p.via);
        if (!left || !right) {
          const missing = !left ? source : p.with;
          const shared = catalog.sharedEntities(source, p.with).map((x) => x.entity);
          throw new Error(`join via '${p.via}': '${missing}' declares no such relationship.${shared.length ? ` '${source}' and '${p.with}' share: ${shared.join(', ')}.` : ` '${source}' and '${p.with}' share no declared relationship — declare one (meta.mcp.entities) or use \`on\` with a column both sides name identically.`}`);
        }
        for (const part of left) requireCol(cols, part.column); // the left key must survive to here
        onKeys = { left, right };
      } else {
        on = p.on;
        if (!on?.length) throw new Error('join: `on` needs the key column names');
        for (const k of on) requireCol(cols, k); // every key must exist on THIS side
      }
      // What the joined model REALLY has (declared, and already grounded to the physical table at
      // catalog load), with each column's type — so a joined amount stays numeric downstream
      // instead of arriving as an untyped string. A fact's raw payload blob is a column too.
      const joined = new Map(catalog.modelColumns(p.with).map((c) => [c.name, c.type || 'string']));
      if (m.event_data_column && !joined.has(m.event_data_column)) joined.set(m.event_data_column, 'json');
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
      for (const a of attrs) out = addCol(out, a.as, joined.get(a.column) || 'string');
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
      description: `Group rows and compute measures (COLLAPSES grain to the group keys). Measures (agg): sum/average/min/max/count/count_distinct, approx_count_distinct (fast approximate uniques on large data), and statistical stddev/variance/median/percentile (its share in percentile). For totals, rates, distinct users (DAU/MAU), revenue, ARPU, distributions/percentiles. `
        + `A TABLE-WIDE NUMBER IS THIS STAGE WITH NO group_by — it returns ONE row (a threshold, a mean, a deviation) and is the memory-safe way to get one; an analytic OVER() with no PARTITION BY (op=window without partition_by, or raw SQL) instead keeps all the rows and attaches the value to each, which exhausts the query's memory on a large table ("Resources exceeded during query execution") — the exact percentile worst of all, because it also has to order the values. So: get the numbers here first, then apply them per row in a later pass as literals (compute sub/div/least with { value }). `
        + `${statAccuracyNote(catalog)}`,
      properties: {
        stage: { enum: ['aggregate'] },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Grouping columns (empty = grand total).' },
        measures: { type: 'array', minItems: 1, items: aggregateMeasure('Aggregate: sum/average/min/max/count/count_distinct; statistical stddev/variance/median/percentile. For DISTINCT counts PREFER the HLL sketch path — approx_count_distinct (one-shot HLL++), or hll_init (build a sketch per group) → hll_merge (combine sketches): high accuracy AND mergeable, so a distinct count re-aggregates across time buckets / segments and composes incrementally (exact count_distinct is NOT additive across groups — use it only for an exact integer on a small set).') },
      },
    }),
    build: ({ d, cols }, p) => {
      const groupBy = p.group_by || [];
      for (const g of groupBy) requireCol(cols, g);
      const aggs = p.measures.map((m) => { if (m.column) requireCol(cols, m.column); return { as: m.name, expr: aggExpr(d, m.agg, m.column, m.percentile) }; });
      let out = new Map();
      for (const g of groupBy) out.set(g, cols.get(g) || { type: 'string' });
      for (const m of p.measures) out.set(m.name, { type: SKETCH_FNS.has(m.agg) ? 'sketch' : 'numeric' });
      return { op: { op: 'aggregate', groupBy, aggs }, cols: out };
    },
  },

  pivot: {
    schema: () => ({
      type: 'object', additionalProperties: false, required: ['stage', 'on', 'agg', 'value_column', 'values'],
      description: 'Turn listed values of `on` into columns, each aggregating `value_column` (the values must be listed explicitly). For dashboard-ready matrices (e.g. revenue as one column per country, or retention day as columns).',
      properties: {
        stage: { enum: ['pivot'] },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Row keys kept (empty = one row).' },
        on: { type: 'string', description: 'Column whose values become columns.' },
        agg: { enum: ['sum', 'average', 'min', 'max', 'count'], description: 'How each pivoted cell aggregates value_column.' },
        value_column: { type: 'string', description: 'Column aggregated into each pivoted column.' },
        values: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[A-Za-z0-9_]+$' }, description: 'The values of `on` to pivot into columns.' },
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
        columns: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Columns to fold into rows.' },
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
      description: 'Keep roughly `percent`% of rows, chosen at random — a fast, APPROXIMATE read of the population for a first estimate / where-to-dig signal on large data (no need to scan everything just to see the direction). Put it early. The result is flagged `approximate` with safe/unsafe guidance; re-run WITHOUT this stage for any exact number you will act on (sampling error flips rates near 0/1, small segments, distinct counts).',
      properties: {
        stage: { enum: ['sample'] },
        percent: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Approximate share of rows to keep (0 < percent <= 100).' },
      },
    }),
    build: ({ cols }, p) => ({ op: { op: 'sample', percent: p.percent }, cols }),
  },

  project: {
    schema: () => ({ type: 'object', additionalProperties: false, required: ['stage', 'columns'], description: 'Keep only these columns (drop the rest). Trims the output to the columns of interest.', properties: { stage: { enum: ['project'] }, columns: { type: 'array', minItems: 1, items: { type: 'string' } } } }),
    build: ({ cols }, p) => { p.columns.forEach((c) => requireCol(cols, c)); const out = new Map(); for (const c of p.columns) out.set(c, cols.get(c) || { type: 'string' }); return { op: { op: 'project', cols: p.columns }, cols: out }; },
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
    ...Object.assign({}, ...availableStages(catalog).map((s) => (typeof s.defs === 'function' ? s.defs() : {}))),
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

/**
 * One measure of an aggregate stage, in three forms told apart by its `fn`: a percentile, which reads a
 * column at the quantile `q`; the functions that read a column; and the ones for which a column is
 * optional (count counts rows without one; the sketch functions read one when given).
 */
function aggregateMeasure(fnDescription) {
  const needColumn = ['sum', 'average', 'min', 'max', 'count_distinct', 'approx_count_distinct', 'stddev', 'variance', 'median'];
  const optional = AGG_FNS.filter((f) => f !== 'percentile' && !needColumn.includes(f));
  const name = { type: 'string', pattern: NAME };
  const column = { type: 'string' };
  return {
    type: 'object',
    anyOf: [
      form({ title: `agg: ${needColumn.join(' | ')}`, tag: ['agg', needColumn], tagDescription: fnDescription, required: ['name', 'column'], properties: { name, column } }),
      form({ title: `agg: ${optional.join(' | ')}`, tag: ['agg', optional], tagDescription: fnDescription, required: ['name'], properties: { name, column } }),
      form({ title: 'agg: percentile', tag: ['agg', 'percentile'], tagDescription: fnDescription, required: ['name', 'column', 'percentile'], properties: { name, column, percentile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'The percentile in (0,1), e.g. 0.95 for p95.' } } }),
    ],
  };
}
