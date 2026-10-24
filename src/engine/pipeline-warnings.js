// WHAT A PIPELINE STEP IS TOLD AS IT IS ADDED — warnings (a filter value the index has never seen, a
// scope that matches nothing, a funnel whose completion reads nothing, a window over the whole source,
// a python stage with nothing prepared before it) and the recommendations for the next step. Advice
// only, apart from a filter value the index proves wrong (guardFilterValues refuses it). A service of
// its own over the catalog and the value index — `engine.advisor` — that the pipeline builder and the
// semantic query consult.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { stageDef } from '../pipeline.js';
import { exprCalls, exprColumns, isWindowCall, comparisonOf, eachCondition } from '../pipeline/compute.js';

/** The aggregates that count distinct values — not additive across groups a key can fall into twice. */
const DISTINCT_FNS = new Set(['count_distinct', 'approx_count_distinct', 'hll_init']);

/** The values a where's own conditions scope `column` to — each a comparison of the column with
 *  constants by eq / in at the top of the list (one inside an or, or a negation, keeps other rows too). */
function scopedValues(stages, column) {
  const values = [];
  let scoped = false;
  for (const st of stages) {
    if (st?.stage !== 'where') continue;
    for (const c of st.conditions || []) {
      const cmp = comparisonOf(c);
      if (!cmp || cmp.subject.column !== column || !(cmp.op === 'eq' || cmp.op === 'in')) continue;
      scoped = true;
      values.push(...cmp.values);
    }
  }
  return scoped ? values : null;
}

export class PipelineAdvisor {
  constructor({ catalog, valueIndex }) {
    this.catalog = catalog;
    this.valueIndex = valueIndex;
  }

  /** one_per_match counts EVERY start (incl. partial chains). Nudge to filter completed=true
   *  downstream when the intent is "completed situations" — the common foot-gun. */
  funnelCompletionWarnings(stage, after = []) {
    if (!stage || stage.stage !== 'match_recognize' || (stage.rows || 'one_per_partition') !== 'one_per_match') return [];
    // said until a where on `completed` follows the funnel — the one judgement, for a step as it is
    // added (nothing follows it yet) and for a whole pipeline alike
    if (after.some((s) => s.stage === 'where' && (s.conditions || []).some((c) => exprColumns(c).includes('completed')))) return [];
    return [`rows:'one_per_match' counts EVERY occurrence of the start step — including partial/abandoned chains, not only completed funnels. To count only COMPLETED situations, add a downstream where on completed = true (the funnel exposes a 'completed' boolean). Keep it unfiltered only if you really want all starts.`];
  }

  /**
   * The stage-level warnings for a WHOLE pipeline — the same judgements the incremental builder
   * makes per step, applied to a pipeline submitted all at once. Both entry points must warn about
   * the same stages: a recipe or a hand-written payload that goes straight through
   * _buildPipeline is exactly where a silently-wrong join does the most damage, because
   * nobody stepped through it.
   */
  stageWarnings(source, stages = [], { timeRange = null, startsFromTable = false } = {}) {
    const draft = { source, stages, timeRange, startsFromTable };
    return sayOnce(stages.flatMap((st, i) => [
      ...this.funnelCompletionWarnings(st, stages.slice(i + 1)),
      ...this.pythonPreparationWarnings(st, draft, i),
      ...this.globalWindowWarnings(st),
      ...this.offsetMaturityWarnings(st, stages.slice(0, i)),
    ]));
  }

  /**
   * AN OFFSET FROM AN ANCHOR (date_diff or elapsed_days of two moments: day N since install, weeks since a first
   * purchase) is only measured where the data reaches it: an anchor late in the data has not lived to
   * day N yet, so a count of it there is 0 or missing — no measurement — and a curve or a cohort grid
   * read over every anchor bends down at its end. Said where such a column is made.
   */
  offsetMaturityWarnings(stage, before = []) {
    if (stage?.stage !== 'compute') return [];
    // an anchor is a moment the rows were given per entity — an attribute a join before it brought (an
    // install date, a first purchase): a gap to the previous row or between a funnel's steps is no age
    const joined = new Set(before.filter((st) => st?.stage === 'join').flatMap((st) => (st.attrs || []).map((a) => a.name ?? a.column)));
    const diff = exprCalls(stage.expr).find((c) => (c.fn === 'date_diff' || c.fn === 'elapsed_days') && joined.has(c.args?.[0]?.column));
    if (!diff) return [];
    const from = diff.args[0].column;
    const unit = diff.fn === 'elapsed_days' ? 'day' : diff.unit || 'day';
    return [`'${stage.name}' counts ${unit}s from '${from}': an anchor late in the data has not reached a large value yet, so there its count is 0 or missing — no measurement. Read a value N only over anchors early enough to reach it: a where on '${from}' ≤ the data's last day minus N (semantic_index({ request: {} }) says each source's data_through).`];
  }

  /**
   * A python stage that reads the SOURCE as it is. Everything SQL can say belongs in a stage
   * before it — including the preparation of the table the analysis reads — so a python stage with
   * nothing in front of it is the shape worth questioning.
   *
   * What this looks at is the PIPELINE's shape, not the code: whether any earlier stage narrows or
   * reduces the data at all. It is a recommendation and not a refusal, because the shape is
   * sometimes right — a model that scores every source row genuinely wants the source — and from
   * here there is no way to tell that apart from handing the raw table over by habit.
   */
  pythonPreparationWarnings(stage, draft = null, index = 0) {
    if (stage?.stage !== 'python') return [];
    // Starting from a materialized prefix: the stages in this array begin at a BUILT table, so
    // nothing here reads the source and there is nothing to say.
    if (draft?.startsFromTable) return [];
    // Any stage before it leaves the data narrower, smaller or otherwise no longer the source —
    // a python stage too, which is a model of its own: what follows it reads its table.
    if (draft?.timeRange || index > 0) return [];
    const src = draft?.source ? `'${draft.source}'` : 'the source';
    const time = (draft?.source && this.catalog.getModel(draft.source)?.time?.column) || null;
    return [`This python stage reads ${src} as it is: no stage before it narrows or reduces the data.`
      + ` A python stage is for what SQL cannot say (a statistical test, clustering, scoring, a forecast); everything else — scoping to the events${time ? ` and a time window on ${time}` : ''}, extracting the payload columns, joining the attributes, aggregating to the grain your analysis works on — is cheaper and exact as stages BEFORE this one, and the python model then starts from a small prepared table.`
      + ` If the analysis really is per source row (a model scoring every row), this shape is right and there is nothing to change.`];
  }

  /**
   * A GLOBAL ANALYTIC WINDOW: `OVER ()` with no PARTITION BY. It keeps every row and attaches the
   * value to each, so one worker has to hold the whole input — observed on a table of ~6.3M rows as
   * "Resources exceeded during query execution" with analytic windows accounting for all of the
   * memory, and again after the exact percentile in it was replaced, for plain AVG/STDDEV over the
   * same global window. An exact percentile is the worst case, because it also has to order the
   * values.
   *
   * The cheap form of the same question is an `aggregate` stage with no group_by: ONE row with the
   * thresholds and the statistics, applied per row afterwards as literals. So this says that, and
   * refuses nothing: a global window over an already-aggregated handful of rows is harmless, and
   * from here there is no way to know how many rows arrive.
   */
  globalWindowWarnings(stage) {
    // every function the computed column's expression calls, nested ones and those a CASE's conditions
    // test included (a where takes no window function at all: it is refused when the step is added)
    if (stage?.stage !== 'compute') return [];
    const calls = exprCalls(stage.expr);
    const windowed = calls.find((c) => isWindowCall(c) && !(c.over?.partition_by || []).length);
    // Raw SQL is where this actually came from: a window function is only reachable through its
    // `over`, but `fn: 'raw'` carries whatever the caller wrote.
    const rawGlobal = calls.some((c) => c.fn === 'raw' && /\bover\s*\(\s*(order\s+by[^)]*)?\)/i.test(String(c.sql || '')));
    if (!windowed && !rawGlobal) return [];
    const what = windowed ? `the window function '${windowed.fn}' has no partition_by in its over` : `a raw expression${stage.name ? ` for '${stage.name}'` : ''} uses OVER () with no PARTITION BY`;
    return [`Global analytic window: ${what}, so it is computed over EVERY row at once and the value is attached to each. One worker has to hold the whole input for that, which is how a large table runs out of memory ("Resources exceeded during query execution") — an exact percentile worst of all, since it must also order the values.`
      + ` If the number is TABLE-WIDE (a threshold, a mean, a deviation), compute it in an \`aggregate\` stage with no group_by — one row, no ordering — and apply it per row in a later pass as a literal (sub / div, or least / greatest, with { value }).`
      + ` If it is per group (per player, per day, per session), name those columns in over.partition_by. A global window over an already-aggregated handful of rows is fine as it is.`];
  }

  /**
   * Verify ONE filter literal against the REAL indexed values at `at` = { source, property }. The
   * guard against silently filtering on a wrong-cased / non-existent value (user wrote
   * 'organic' but the column holds 'Organic'). Returns null when OK or unverifiable (cold
   * index, numeric/bool value), else { kind, value, suggest?, note? }:
   *   case     — same value, different CASING → HARD (suggest the real casing)
   *   typo     — a close fuzzy match exists → HARD (suggest it)
   *   absent   — value not present AND the full value set is indexed (not capped) → HARD
   *   unverifiable — value not found but only the top-N is indexed → WARN, do not block
   */
  checkFilterValue(at, value) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return null; // only string literals are case/value-checked
    if (!at) return null;
    if (at.events) {
      const refusal = this.catalog.eventNameRefusal(at.source, String(value));
      return refusal ? { kind: 'event', value: String(value), message: refusal } : null;
    }
    const st = this.valueIndex.stats(at.source, at.property);
    if (!st) return null; // not indexed → cannot verify (do not block)
    const stored = this.valueIndex.sampleValues(at.source, at.property, 1000); // all stored values (≤ indexer cap)
    if (!stored.length) return null;
    const sval = String(value);
    if (stored.some((v) => String(v.value) === sval)) return null; // exact, real value → OK
    const ci = stored.find((v) => String(v.value).toLowerCase() === sval.toLowerCase());
    if (ci) return { kind: 'case', value: sval, suggest: [ci.value] };
    const [best] = rankFuzzy(sval, stored, { fields: (v) => [String(v.value)], threshold: 0.8, limit: 1 });
    if (best) return { kind: 'typo', value: sval, suggest: [best.item.value] }; // SOFT (a similar value exists, but could be a distinct sibling like level_1/level_3)
    // Is the FULL value set indexed? Only then is "absent" a reliable hard signal. A column
    // with many values is capped at the indexer's top-N (default 50) — a value can exist
    // without being indexed — so we must NOT hard-reject it. We also treat a near-cap count
    // as capped, because distinct_count can be HLL-approximate and under-count near the cap.
    const VALUE_CAP = 50; // mirrors the value indexer's default maxValues
    const storedCount = this.valueIndex.valueCount(at.source, at.property) ?? stored.length;
    const capped = storedCount < (st.distinctCount ?? Infinity) || storedCount >= VALUE_CAP;
    if (capped) return { kind: 'unverifiable', value: sval, note: 'this column has more values than are indexed (top-N only) — the value may well exist but is not in the index; verify with a direct query before relying on this filter' };
    return { kind: 'absent', value: sval, suggest: stored.slice(0, 10).map((v) => String(v.value)) };
  }

  /** Where a column filtered on `sourceKey` (the pipeline source) lives in the value index:
   *  { source, property } or null. The index keys rows by that pair, per source. */
  valueKeyForColumn(sourceKey, column) {
    const c = this.catalog;
    if (!column) return null;
    // an events source's event-name column is checked against the catalog's events — the whole
    // vocabulary of the source, so a wrong name is refused for certain, never matched to nothing
    if (c.isFact(sourceKey) && column === c.eventNameColumn(sourceKey)) return { source: sourceKey, property: column, events: true };
    return c.attributeKind(sourceKey, column) ? { source: sourceKey, property: column } : null;
  }

  /**
   * HARD guard: given resolved filter specs [{ key, op, value, where }] (op ∈ equality ops,
   * value scalar or array), reject any literal that is a case/typo/absent mismatch of the
   * column's REAL values, with the correct value(s) suggested. Unverifiable misses become
   * warnings (returned), never a block. Throws a single ToolError listing all hard mismatches.
   */
  guardFilterValues(specs) {
    const EQ = new Set(['eq', 'neq', 'in', 'not_in']);
    const errors = []; const warnings = []; const unverified = [];
    for (const { at, op, value, where } of specs) {
      if (!EQ.has(op)) continue;
      for (const v of Array.isArray(value) ? value : [value]) {
        const r = this.checkFilterValue(at, v);
        if (!r) continue;
        const fix = r.suggest && r.suggest.length ? ` Did you mean: ${r.suggest.map((s) => `'${s}'`).join(', ')}?` : '';
        // HARD-reject ONLY the certain cases: an exact case-mismatch (the value provably
        // exists with different casing) and a value absent from a FULLY-indexed small set.
        // A fuzzy near-match or any incompletely-indexed (top-N) column → WARN, never block —
        // a real value may simply not be in the index, so we must not reject it.
        if (r.kind === 'event') errors.push(`${where}: ${r.message}`);
        else if (r.kind === 'case') errors.push(`${where}: value '${r.value}' is not a real value — the column holds it with different casing.${fix}`);
        else if (r.kind === 'absent') errors.push(`${where}: value '${r.value}' does not occur in this column (its full value set is indexed).${fix || ` Known values: ${(r.suggest || []).map((s) => `'${s}'`).join(', ')}.`}`);
        else if (r.kind === 'typo') warnings.push(`${where}: value '${r.value}' was not found among indexed values; a similar value exists.${fix} Verify the exact value before relying on this filter.`);
        // a value past the indexed top-N is most often real: said only if the query comes back
        // empty, where it may be the reason (onEmpty) — a filter that matched needs no warning
        else if (r.kind === 'unverifiable') unverified.push(`${where}: ${r.note}`);
      }
    }
    if (errors.length) {
      throw new ToolError(`filter value(s) not verified against the real data — check the exact value via semantic_index({ request: { source, property } }) for an event property, ({ source, column }) for a column, and use it as stored: ${errors.join(' ')}`, { stage: 'validate', field: 'value' });
    }
    warnings.onEmpty = unverified;
    return warnings;
  }

  /** A measure that sums or averages an amount the catalog declares as a per-row RATIO (an expression that
   *  divides): that is not the group's ratio, which divides the sums — said with how to write it. */
  ratioMeasureWarnings(source, measures) {
    const out = [];
    for (const m of measures || []) {
      const model = m.source ?? source; // (a built table's measure: its columns are no catalog amounts)
      if (!model || !this.catalog.models[model]) continue;
      const ratios = new Map(this.catalog.aggregatableFields(model).filter((a) => a.expr !== a.name && /\//.test(String(a.expr))).map((a) => [a.name, a.expr]));
      if (!ratios.size) continue;
      for (const c of exprCalls(m.expr)) {
        if (!['sum', 'average'].includes(c.fn)) continue;
        const col = (c.args || []).find((a) => a?.column !== undefined && ratios.has(a.column))?.column;
        if (col) out.push(`measure '${m.name}' ${c.fn === 'sum' ? 'sums' : 'averages'} '${col}', a ratio per row (${ratios.get(col)}): that is not the ratio of a group, which divides the sums — measure the numerator and the denominator with sum and divide them in a derived metric ({ fn: "div", args: [{ metric }, { metric }] }).`);
      }
    }
    return out;
  }

  /** The same gotcha in a semantic layer: a measure that folds an event property populated on SEVERAL
   *  events (a price on a completed and on a failed purchase) folds it on all of them unless it names
   *  the event — said, with the events, so a total is not read as one event's. */
  measureScopeWarnings(source, measures) {
    const c = this.catalog;
    if (!c.isFact(source)) return [];
    const props = c.eventProps(source);
    const applies = this.valueIndex.appliesMap(source, props);
    const evCol = c.eventNameColumn(source);
    const out = [];
    for (const m of measures || []) {
      if (m.source !== undefined) continue;
      const s = JSON.stringify(m.expr ?? {});
      if (s.includes(`"column":"${evCol}"`)) continue; // the measure names its event(s)
      const p = props.find((x) => s.includes(`"property":"${x}"`) && (applies[x] || []).length > 1);
      if (p) out.push(`measure '${m.name}' folds '${p}' on every event that carries it — ${applies[p].join(', ')} — not one of them: to read one event's, fold a case that yields it on that event alone ({ fn: "case", cases: [{ when: [{ fn: "eq", args: [{ column: "${evCol}" }, { value: "<event>" }] }], then: { property: "${p}" } }] })`);
    }
    return out;
  }

  /** #3 gotcha: the just-added stage references an event-specific property whose event(s)
   *  are not scoped by an upstream where on event_name → it reads NULL elsewhere. */
  eventScopeWarnings(draft, stage) {
    // Identify event properties from the catalog (always known); derive WHICH events actually carry
    // each one from the value index (data, not the declared meta.mcp.events). Unknown coverage
    // (cold index) can't be assessed, so such a property is not flagged.
    const c = this.catalog;
    if (!c.isFact(draft?.source)) return []; // a measures/dimension pipeline reads no event payload
    const fact = draft.source; // the pipeline reads ONE fact — its own
    const applies = this.valueIndex.appliesMap(fact, c.eventProps(fact)); // key -> observed [event_name]
    // a funnel's step reads a property on the events it names itself: a property its step names is
    // scoped by that step (flagged only where the step names an event the property is not on), and only
    // what the stage reads outside its steps is held to the where steps before it
    if (stage?.stage === 'match_recognize' && Array.isArray(stage.steps)) {
      for (const st of stage.steps) {
        const inStep = c.eventProps(fact).filter((p) => JSON.stringify(st).includes(`"${p}"`));
        for (const p of inStep) {
          const evs = applies[p];
          const off = evs?.length ? (st.event_name || []).filter((e) => !evs.includes(e)) : [];
          if (off.length) return [`'${p}' is populated only on event(s) ${evs.join(', ')} — step '${st.name ?? '?'}' also names ${off.join(', ')}, where it reads NULL (see semantic_index({ request: { source: '${fact}', property: '${p}' } }).event_coverage).`];
        }
      }
      // a capture reads its column at the row its step matched: scoped by that step's events as the step is
      for (const cp of stage.capture || []) {
        const st = stage.steps.find((x) => x.name === cp.step);
        const p = c.eventProps(fact).find((x) => x === cp.column);
        const evs = p ? applies[p] : null;
        const off = st && evs?.length ? (st.event_name || []).filter((e) => !evs.includes(e)) : [];
        if (off.length) return [`capture '${cp.name}' reads '${p}' at step '${st.name}', on event(s) ${off.join(', ')} — '${p}' is populated only on ${evs.join(', ')}, so it reads NULL there.`];
      }
      stage = { ...stage, steps: [], capture: [] };
    }
    // a row-wise stage (a compute, an unnest) reads the field where it is and NULL elsewhere — that is
    // its value there, not a mistake (an unnest drops those rows itself); what can mislead is a stage that
    // FOLDS rows over it, or keeps rows by it
    if (stage?.stage === 'compute' || stage?.stage === 'unnest') return [];
    const s = JSON.stringify(stage);
    const referenced = c.eventProps(fact).filter((p) => s.includes(`"${p}"`));
    if (!referenced.length) return [];
    const evCol = c.eventNameColumn(fact);
    // (a field every event of the source carries reads NULL on none of them)
    const allEvents = c.eventNames(fact);
    // a stage that names the events itself (a case on the event column, a condition on it) says which
    // event's value it reads: the where steps before it need not
    if (s.includes(`"column":"${evCol}"`)) return [];
    // the events a where keeps: only a condition that NAMES them (eq / in) at the top of a where scopes
    // the rows to them — a neq / not_in, or one inside an or, keeps others too
    const named = scopedValues(draft.stages, evCol);
    const hasScope = !!named;
    const scoped = new Set(named || []);
    // the risk is ROWS WITHOUT THE FIELD: no scope at all (every other event reads NULL), or a scope that
    // keeps an event the field is not populated on. A scope within the field's events is the right one.
    const missing = (evs) => (hasScope ? [...scoped].filter((e) => !evs.includes(e)) : null);
    const risky = referenced.filter((p) => { const evs = applies[p]; return evs && evs.length && !(allEvents.length && allEvents.every((e) => evs.includes(e))) && (!hasScope || missing(evs).length); });
    if (!risky.length) return [];
    const p = risky[0]; const evs = applies[p] || [];
    return [hasScope
      ? `'${p}' is populated only on event(s) ${evs.join(', ')} — your event_name scope also keeps ${missing(evs).join(', ')}, where it reads NULL (see semantic_index({ request: { source: '${fact}', property: '${p}' } }).event_coverage).`
      : `'${p}' is populated only on event(s) ${evs.join(', ')} — add an earlier where on event_name to those, or it reads NULL on the other rows${evs.length > 1 ? `; and it is on several events, so a total over it adds each event's value of it — keep the one you mean` : ''} (see semantic_index({ request: { source: '${fact}', property: '${p}' } }).event_coverage).`];
  }

  /**
   * After a step, warn when a USED event-property is empty for the pipeline's SCOPED app
   * (bundle_id) and/or event_name — i.e. it is the wrong field FOR THIS APP, so the step
   * will likely produce no values. Uses the precise (property × bundle × event) TRIPLE when
   * both are scoped, else the per-bundle / per-event marginal. Soft warning only (the index
   * can be incomplete/stale); silent when nothing concrete is scoped or the field is fine.
   */
  emptyCombinationWarnings(draft, stage) {
    const c = this.catalog;
    if (!c.isFact(draft?.source)) return []; // no events, no (app × event) cells to be empty
    const fact = draft.source;
    const bundleCol = c.bundleColumn(fact);
    const evCol = c.eventNameColumn(fact);
    const props = c.scalarEventProps(fact);
    const s = JSON.stringify(stage);
    const used = props.filter((p) => s.includes(`"${p}"`)); // event-properties referenced by THIS step
    if (!used.length) return [];
    // Concrete scope from all where-stages so far (eq / in only).
    const scopedEvents = new Set((scopedValues(draft.stages, evCol) || []).map(String));
    const scopedBundles = new Set((bundleCol ? scopedValues(draft.stages, bundleCol) || [] : []).map(String));
    if (!scopedBundles.size && !scopedEvents.size) return []; // nothing concrete scoped → _eventScopeWarnings covers it
    const fmt = (arr) => arr.slice(0, 4).join(', ') + (arr.length > 4 ? ', …' : '');
    const warns = [];
    for (const p of used) {
      if (scopedBundles.size && scopedEvents.size) {
        // Precise triple: every scoped app×event pair where the field carries no value.
        const empty = [];
        for (const b of scopedBundles) for (const ev of scopedEvents) {
          const cell = this.valueIndex.cellCoverage(fact, p, { bundle: b, event: ev });
          if (!cell || cell.non_null === 0) empty.push(`${b} + ${ev}`); // missing cell = no rows for that combo
        }
        const total = scopedBundles.size * scopedEvents.size;
        if (empty.length === total) warns.push(`'${p}' has NO values for the scoped app+event combination ${fmt(empty)} (NULL/absent in the index) — this step will likely return nothing for '${p}'. Pick a field populated there: semantic_index({ request: { source: '${fact}', bundle: '${[...scopedBundles][0]}' } }) or semantic_index({ request: { source: '${fact}', property: '${p}' } }).bundle_coverage / event_coverage.`);
        else if (empty.length) warns.push(`'${p}' is empty for app+event ${fmt(empty)} (present for the other scoped pairs) — those rows contribute no '${p}'.`);
      } else if (scopedBundles.size) {
        const byB = new Map(this.valueIndex.bundleCoverage(fact, p).map((x) => [x.bundle, x]));
        const empty = [...scopedBundles].filter((b) => byB.get(b) && byB.get(b).non_null === 0);
        if (empty.length === scopedBundles.size) warns.push(`'${p}' is NULL for app(s) ${fmt(empty)} — this step likely yields no '${p}' values for ${empty.length > 1 ? 'them' : 'this app'} (semantic_index({ request: { source: '${fact}', bundle: '${empty[0]}' } })).`);
        else if (empty.length) warns.push(`'${p}' is empty for app(s) ${fmt(empty)} (populated for the other scoped app(s)).`);
      } else {
        const byE = new Map(this.valueIndex.coverage(fact, p).map((x) => [x.event_name, x]));
        const empty = [...scopedEvents].filter((ev) => byE.get(ev) && byE.get(ev).non_null === 0);
        if (empty.length === scopedEvents.size) warns.push(`'${p}' is NULL on event(s) ${fmt(empty)} — this step likely yields no '${p}' values (semantic_index({ request: { source: '${fact}', property: '${p}' } }).event_coverage).`);
        else if (empty.length) warns.push(`'${p}' is empty on event(s) ${fmt(empty)} (populated on the other scoped event(s)).`);
      }
    }
    return warns.slice(0, 3);
  }

  /**
   * A where that bounds a TIME column from above by a bare date (`lte` / the high end of `between`):
   * on a timestamp the date means that day's 00:00:00, so the whole last day is left out — the
   * classic off-by-a-day. Said, never refused: on a DATE column the bound is exactly right.
   */
  dateBoundWarnings(stage, available = []) {
    if (stage?.stage !== 'where') return [];
    const timeCols = new Set(available.filter((c) => c.type === 'time').map((c) => c.name));
    const dateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const hits = [];
    eachCondition(stage.conditions, (c) => {
      const cmp = comparisonOf(c);
      const col = cmp?.subject.column;
      if (!timeCols.has(col)) return;
      const upper = cmp.op === 'lte' ? cmp.values[0] : cmp.op === 'between' ? cmp.values[1] : undefined;
      if (dateOnly(upper) && !hits.some((h) => h.col === col)) hits.push({ col, upper });
    });
    return hits.map(({ col, upper }) => `'${col}' is bounded by the bare date '${upper}': on a timestamp that is ${upper} 00:00:00, so the rest of that day is left out. To include the whole day, write { fn: "lt", args: [{ column: "${col}" }, { value: "<the next day>" }] } (with gte for the start); on a DATE column the bound is right as it is.`);
  }

  /**
   * An aggregate that counts distinct values grouped by a column a SLOWLY-CHANGING model's join brought in
   * (the model declares a validity window): a key whose version changed within the rows is counted under
   * each value it held, so the groups add up to more than the whole. → [{ model, columns }] — the models and
   * their columns grouped by; the caller asks the warehouse whether those columns change between a key's
   * versions at all (WarehouseProbe.versionsDiffer), and says it only where they do or that is not known.
   */
  versionedDistinctGroups(stages, stage, source = null) {
    if (stage?.stage !== 'aggregate' || !(stage.group_by || []).length) return [];
    // a join matched at each row's own time can meet several versions of a key; one matched at another moment
    // (an install, a first event — one per key) meets one version each, and nothing is counted twice
    const rowTime = source ? this.catalog.getModel(source)?.time?.column : null;
    const distinct = (stage.measures || []).some((m) => exprCalls(m.expr).some((c) => DISTINCT_FNS.has(c.fn)));
    if (!distinct) return [];
    const at = stages.indexOf(stage);
    const byModel = new Map();
    for (const st of at < 0 ? stages : stages.slice(0, at)) {
      if (st?.stage !== 'join' || !this.catalog.models[st.source]?.scd) continue;
      // (matched at another moment of the rows: said too, for where that moment differs between a key's rows)
      const at = typeof st.on?.time === 'string' && st.on.time !== rowTime ? st.on.time : null;
      for (const a of st.attrs || []) {
        if (!stage.group_by.includes(a.name ?? a.column)) continue;
        if (!byModel.has(st.source)) byModel.set(st.source, { columns: [], at });
        byModel.get(st.source).columns.push(a.column);
      }
    }
    return [...byModel].map(([model, { columns, at }]) => ({ model, columns, ...(at ? { at } : {}) }));
  }

  /** What versionedDistinctGroups' models mean for the counts, said once for them all. */
  versionedDistinctNote(groups) {
    const at = groups.map((g) => g.at).filter(Boolean);
    return `A distinct count grouped by ${groups.map((g) => `'${g.model}'`).join(', ')}'s columns, a slowly-changing model: the join matches each row to the version valid at ${at.length ? `'${at.join("', '")}'` : 'its time'}, so a key whose version changed ${at.length ? 'between those moments of its rows' : 'within these rows'} is counted under each value it held, and the groups add up to more than the keys in all — read the total from an aggregate without that group_by, not from their sum${at.length ? ` (a moment that is the same on all of a key's rows — an install — meets one version)` : ''}.`;
  }

  /** Next-step hints for the just-added stage — its own (`recommend` in the stage registry), or where its columns can go.
   *  `building`: the call that adds it also starts the build (materialize: true), so "materialize when done" is not said. */
  stepRecommendations(stage, available, { building = false } = {}) {
    const own = stageDef(stage.stage)?.recommend;
    return [
      ...this.dateBoundWarnings(stage, available),
      ...(own ? own(available, stage) : []),
      ...(building ? [] : ['Preview the SQL anytime with build_model({ request: { action: "preview", context_id } }); materialize when done.']),
    ];
  }
}

/**
 * Notes said once in one answer: a note said before (in `said`, which this adds to) is left out, and one
 * whose explanation — what follows its first sentence — was said before keeps its first sentence alone.
 */
export function sayOnce(notes, said = new Set()) {
  const out = [];
  for (const n of notes) {
    const cut = n.indexOf('. ');
    const tail = cut > 0 ? n.slice(cut + 2) : null;
    if (said.has(n)) continue;
    if (tail && said.has(`tail:${tail}`)) out.push(`${n.slice(0, cut + 1)} (as said above)`);
    else out.push(n);
    said.add(n);
    if (tail) said.add(`tail:${tail}`);
  }
  return out;
}
