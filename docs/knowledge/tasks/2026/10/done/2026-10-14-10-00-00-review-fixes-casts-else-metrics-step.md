---
title: Review fixes — one text-to-number rule, the else rule narrowed, element types, the metrics step's home
status: done
last_reviewed: 2026-10-14
last_used: 2026-10-14
tags: [schema, grammar, dialects, pipeline, semantic, review]
source_of_truth: [src/dialects/duckdb.js, src/dialects/bigquery.js, src/pipeline/compute.js, src/pipeline/stages.js, src/earlier-spelling.js, src/engine/semantic-query.js, AGENTS.md]
---

# Review fixes — one text-to-number rule, the else rule narrowed, element types, the metrics step's home

## Status

done

## Last Reviewed

2026-10-14

## Context

A `/code-review` of 13a5558 (types from the catalog, conditional aggregates as case, a metric query as
steps — docs/knowledge/tasks/2026/10/done/2026-10-12-14-00-00-cast-case-metrics-stage.md) found eleven
problems. The user asked to fix all of them and to narrow the else rule to count and count_distinct.

Measured on DuckDB 1.5 (the venvs' version): DOUBLE → BIGINT rounds half to EVEN (2.5 → 2, 3.5 → 4,
-2.5 → -2); DECIMAL → BIGINT rounds half AWAY from zero (2.5 → 3, -2.5 → -3); '1e3' parses as DECIMAL.
BigQuery: FLOAT64 / NUMERIC → INT64 rounds half away from zero; SAFE_CAST('9.99' AS INT64) and
SAFE_CAST('3.0' AS INT64) are NULL.

## Objective

1. **One text-to-number rule on both warehouses.** A value converted to an integer is the number it holds,
   rounded half away from zero — from a number and from a text alike ('9.99' → 10, '3.0' → 3, '2.5' → 3,
   '-2.5' → -3); a text that holds no number is missing. The same SQL path serves `cast` and a typed read
   of the payload (so the one-read cast of a payload property is right on BigQuery too). Findings 1, 5.
2. **An element has the type it is stored as.** An element of a NATIVE array (unnest, element_at,
   array_last) has the array's item type — the catalog's `items` where it declares one; a JSON-encoded
   array's element is text (it is read out of JSON). Where neither is known, the element's type is not
   claimed (a constant compared with it is written as it is). Finding 4.
3. **The else rule, narrowed (the user's decision).** Only `count` and `count_distinct` (and
   approx_count_distinct, its approximation) refuse a case with an else that yields a value — there the
   else always changes what is counted. Every other aggregate takes it: `average` of `case … then 1 else 0`
   is a share of rows, `max` of it "any". Finding 2.
4. **A refusal never suggests what is refused.** A deployment recipe's typed unnest is handed over in the
   current spelling (two steps); a lone typed unnest step gets the two steps, not a value still carrying
   `type`; a converted element name keeps the name pattern; a where after the metrics step naming
   `{ time: "metric_time" }` without a grain is pointed at the result's metric_time column. Findings 3, 6,
   7, 8.
5. **One builder per concept.** An earlier aggregate's `where` is converted by `foldWhere` (no second
   builder); the earlier metric query's fields are read off the query's own form, and `metrics: []` is no
   metric query. Findings 9, 11.
6. **The metrics step is the semantic query's, not a pipeline stage.** It stays in `$defs.stage` (its own
   group, offered only by query_semantic_model), but the pipeline's stage registry does not hold it: no
   build that throws, no special case in takes / stageAt / stageSchema, not listed as a pipeline stage.
   Finding 10.

## Verification

All edits first; then ONE run on dbt-v2: `npm run lint:names`, `npm test`, `npm run test:integration`,
`npm run eval:check`; fix; commit; push. Tests assert on data: the rounding rule on DuckDB (text and
number inputs, .5 both signs, a word → missing), a share of rows as `average` over a case with else 0, a
native-array element compared with a number where the fixture has one. The tool list stays under 260,000
characters (248,022 now).

Result (2026-10-14, dbt-v2): lint:names clean; unit 815/815; integration 313/313; eval:check — all 14
cases hold. Tool list on the production catalog: 249,451 characters (248,022 before; budget < 260,000).
The BigQuery side of the text-to-number rule (NUMERIC taking an exponent, half away from zero, what is
no numeric literal) is taken from BigQuery's documented cast rules — no check here runs on BigQuery.
The fixture holds no native array of numbers, so the native element type is held by input-validation
tests, not by data.

## Decisions

Types and dialects
- An array's item type lives in the tracked type word (`array<int>`, `array<string>`, `array<struct>`, bare `array` when not known); no `items` field travels with a column.
- Item words are the type words plus boolean, time, json and struct; nested arrays and maps stay bare `array`; a scalar physical number stays `numeric`.
- BigQuery reads a text as NUMERIC (DuckDB's DECIMAL(38,9) precision and scale), not BIGNUMERIC.
- DuckDB `int` casts to BIGINT (was INTEGER), so '3000000000' converts on both warehouses.
- DuckDB number → int goes through `round()` (half away from zero), never through the decimal (no double rounding); number → numeric through DECIMAL(38,9) then DOUBLE, → float a DOUBLE.
- DuckDB reads a text as a number only where it is written as BigQuery reads one: int/numeric guarded by the numeric-literal pattern (sign, digits, point, exponent, trimmed), float by the same plus inf/infinity/nan in any case — '1_000' and '0x1F' are missing on both (BigQuery's side taken from its documented cast rules, not run).
- A value of no known type (`unknown`, null — a raw's) is read as its text on both dialects, 'true'/'false' as 1/0, then by fromText; a text 'true' of no known type is therefore 1 on both.
- `case` with a `type` its branches do not share converts its value by castExpr from the branches' common type, so its tracked type is its SQL's.
- `raw` without `type` is `unknown` (was `string`); a typed raw is `declared` — taken at its word in comparisons, converted as of no known type by cast.
- `commonType` of arguments that are all of no known type is `unknown`, not the caller's fallback.
- One reader of a native array property's type, `nativeArrayType` (column-types.js): the column's tracked type first (a bare `array` falls to the catalog), then the catalog's `array<struct>` / `items` — used by a `{ property }` read and the unnest stage.
- One rule of grounding, `groundedType`, in Catalog.typeToPhysical, a build's source columns and the join stage: a JSON payload, an array the warehouse names no items of, and a declared scalar the warehouse reports as an array (or the reverse) keep the declaration; a column declared with no type takes the warehouse's.
- A payload key declared as an array is read as its JSON text (`jsonExtractJson`: BigQuery JSON_QUERY, DuckDB CAST(json_extract AS VARCHAR) — a string value quoted, as JSON_QUERY writes it).
- A JSON array's membership compares texts on both dialects (DuckDB `list_contains(json_extract_string(…, '[*]'), text)` instead of `json_contains`), so 5 finds 5 and "5" alike, as BigQuery's JSON_VALUE_ARRAY does; the dialect writes the value as text.
- A native array's member (`array_contains`) is the value in the element's type (`typedValue`): a word looked for among numbers is refused; items not known take the value as written. Dialect signatures unchanged.
- A constant against a text is its text (5 → '5'); booleans against a text the warehouse did not report are left as written.
- A text ORDERED against a number (gt/gte/lt/lte/between) is refused saying to cast — writing the number as text would order it as text.
- A native array<struct> element whole is `unknown` for `{ property }` and `{ column }` alike; its `field` is now read (DuckDB struct_extract, BigQuery `e.field`) and typed by the catalog's `fields` (`unknown` where not declared); `field` on a native array of scalars is refused.
- `arrayUnnest` quotes the array column on both dialects.
- `physicalColumnType` reads scalars through `itemType` (its int/float words now match with a word boundary, so 'double precision' is a number); json and struct stay `string`.
- base.js declares `castExpr(_expr, _type, _from)`, `fromText` and `jsonExtractJson` with the one rule.

Else, converters, refusals
- The else is refused under `COUNTING_FNS` = count, count_distinct, approx_count_distinct and hll_init (count_distinct's sketch — the else's value would be one more member); hll_merge / hll_merge_partial fold sketches and stay out; every other aggregate takes an else.
- One wording of the rule everywhere: "count would count those rows, count_distinct their else value as one more".
- `foldWhere` stays in compute.js; earlier-spelling imports it (the cycle runs only at call time).
- A converted element is named `<name>_element`, then `_element_2`…, cut to NAME_RE, else `element`; names a list makes include an earlier `as`.
- A lone typed unnest is said as the two steps only; errors inside it are re-read off the converted unnest.
- An earlier unnest's `as` is its `name` (currentUnnest), and a typed one written with `as` is the two steps too.
- An earlier element_at / array_last `type` is kept as a cast (an element is its array's items, which the value does not say); only json_field and `{ property, field }` are known to read text.
- An earlier typed unnest of `type: 'string'` still drops the type (its arrays were JSON payload arrays, whose element is text).
- METRIC_QUERY_FIELDS lives in src/schema/fields.js; the earlier-only query fields are a fixed history list in earlier-spelling.js; `metrics: []` is no metric query.
- A where after the metrics step naming a time without its grain is pointed at every grain column the metrics step groups it by ("is in the result as its columns 'a', 'b' and 'c', one per grain … — name the one you mean"); one with an explicit grain the result lacks is a dimension it does not carry.

Metrics step
- One definition, `METRICS_STEP` in src/schema/fields.js, offered through `offers` on STAGE_PLACES.metric_scope; no pipeline stage, absent from buildOps' known list.
- metric_scope still lists `metrics` in `stages`, so every refusal reads as before; a refusal elsewhere uses METRICS_STEP.elsewhere's words.
- The build place takes only registry stages.

Data assertions
- Cast to int on row e58 (pipeline-stages): text '45' → 45, DOUBLE 2.5 → 3, ±22.5 → ±23, '9.99' → 10, '3.0' → 3, '2.5' → 3, '-2.5' → -3, '1e3' → 1000, 'abc' / '1_000' / '0x1F' missing, a flag 1, an untyped raw flag 1, a raw saying numeric over text 45, a case saying int over text 45 (the rendered stages checked on DuckDB 1.5.6 over a stand-in row).
- A share of rows as `average` over a case with else 0, and "any" as `max` (batch-queries), against the warehouse's own SQL.
