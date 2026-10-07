// WHAT A PIPELINE STEP IS TOLD AS IT IS ADDED — warnings (a filter value the index has never seen, a
// scope that matches nothing, a funnel whose completion reads nothing, a window over the whole source,
// a python stage with nothing prepared before it) and the recommendations for the next step. Advice
// only, apart from a filter value the index proves wrong (guardFilterValues refuses it). A service of
// its own over the catalog and the value index — `engine.advisor` — that the pipeline builder and the
// semantic query consult.

import { ToolError } from '../validate.js';
import { rankFuzzy } from '../fuzzy.js';
import { stageDef, listSome } from '../pipeline.js';
import { FNS, exprCalls } from '../pipeline/compute.js';
import { eachCondition } from '../conditions.js';

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
    if (after.some((s) => s.stage === 'where' && (s.conditions || []).some((c) => c.column === 'completed'))) return [];
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
    return stages.flatMap((st, i) => [
      ...this.joinCompletenessWarnings(st, draft),
      ...this.funnelCompletionWarnings(st, stages.slice(i + 1)),
      ...this.pythonPreparationWarnings(st, draft, i),
      ...this.globalWindowWarnings(st),
    ]);
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
    const windowed = calls.find((c) => FNS[c.fn]?.window && !(c.over?.partition_by || []).length);
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
   * An events↔dimension join is INCOMPLETE when it joins a slowly-changing (SCD-2) dimension on the
   * key alone: without a point-in-time `between` window it fans out to EVERY historical version of
   * each key, multiplying rows and inflating counts. Surface this in the response so the caller can
   * add the window (and fix it) instead of trusting a silently wrong join.
   */
  joinCompletenessWarnings(stage, draft = null) {
    if (!stage || stage.stage !== 'join' || stage.between) return [];
    let m; try { m = this.catalog.getModel(stage.with); } catch { return []; }
    if (!m?.scd) return [];
    const from = Object.entries(m.dimensions || {}).find(([, d]) => d.validity === 'start')?.[0];
    const to = Object.entries(m.dimensions || {}).find(([, d]) => d.validity === 'end')?.[0];
    const eventTime = draft?.source ? this.catalog.getModel(draft.source)?.time?.column : null;
    const fix = (from && to && eventTime)
      ? ` Add between: { value: '${eventTime}', from: '${from}', to: '${to}' } to keep only the version valid at the event time.`
      : ' Add a `between` window (value = the event time column; from/to = the validity-window columns) to keep only the version valid at the event time.';
    // The key is a declared relationship (via: '<name>') or columns both sides name alike
    // (via: { on: [...] }) — say whichever the caller used, never the object itself.
    const on = typeof stage.via === 'string' ? null : [].concat(stage.via?.on ?? stage.on ?? []);
    const named = on ? `key '${on.join(' + ')}'` : `the declared relationship '${stage.via}'`;
    return [`INCOMPLETE JOIN: '${stage.with}' is a slowly-changing (SCD-2) dimension, but this join matches only on ${named} with no point-in-time window — it fans out to EVERY historical version of each key, so per-event rows multiply and counts inflate.${fix}`];
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
        if (r.kind === 'case') errors.push(`${where}: value '${r.value}' is not a real value — the column holds it with different casing.${fix}`);
        else if (r.kind === 'absent') errors.push(`${where}: value '${r.value}' does not occur in this column (its full value set is indexed).${fix || ` Known values: ${(r.suggest || []).map((s) => `'${s}'`).join(', ')}.`}`);
        else if (r.kind === 'typo') warnings.push(`${where}: value '${r.value}' was not found among indexed values; a similar value exists.${fix} Verify the exact value before relying on this filter.`);
        // a value past the indexed top-N is most often real: said only if the query comes back
        // empty, where it may be the reason (onEmpty) — a filter that matched needs no warning
        else if (r.kind === 'unverifiable') unverified.push(`${where}: ${r.note}`);
      }
    }
    if (errors.length) {
      throw new ToolError(`filter value(s) not verified against the real data — check the exact value via semantic_index({ request: { source, property } }) and use it as stored: ${errors.join(' ')}`, { stage: 'validate', field: 'value' });
    }
    warnings.onEmpty = unverified;
    return warnings;
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
    const s = JSON.stringify(stage);
    const referenced = c.eventProps(fact).filter((p) => s.includes(`"${p}"`));
    if (!referenced.length) return [];
    const evCol = c.eventNameColumn(fact);
    // the events a where keeps: only a condition that NAMES them (eq / in) at the top of a where scopes
    // the rows to them — a neq / not_in, or one inside an { or }, keeps others too
    const scoped = new Set(); let hasScope = false;
    for (const st of draft.stages) if (st.stage === 'where') for (const cond of st.conditions || []) if (cond.column === evCol && (cond.op === 'eq' || cond.op === 'in')) { hasScope = true; (Array.isArray(cond.value) ? cond.value : [cond.value]).forEach((v) => scoped.add(v)); }
    // the risk is ROWS WITHOUT THE FIELD: no scope at all (every other event reads NULL), or a scope that
    // keeps an event the field is not populated on. A scope within the field's events is the right one.
    const missing = (evs) => (hasScope ? [...scoped].filter((e) => !evs.includes(e)) : null);
    const risky = referenced.filter((p) => { const evs = applies[p]; return evs && evs.length && (!hasScope || missing(evs).length); });
    if (!risky.length) return [];
    const p = risky[0]; const evs = applies[p] || [];
    return [hasScope
      ? `'${p}' is populated only on event(s) ${evs.join(', ')} — your event_name scope also keeps ${missing(evs).join(', ')}, where it reads NULL (see semantic_index({ request: { source: '${fact}', property: '${p}' } }).event_coverage).`
      : `'${p}' is populated only on event(s) ${evs.join(', ')} — add an earlier where on event_name to those, or it reads NULL on the other rows (see semantic_index({ request: { source: '${fact}', property: '${p}' } }).event_coverage).`];
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
    const scopedEvents = new Set(); const scopedBundles = new Set();
    for (const st of draft.stages) if (st.stage === 'where') for (const cd of st.conditions || []) {
      if (!cd || cd.column == null || !(cd.op === 'eq' || cd.op === 'in')) continue;
      const vals = Array.isArray(cd.value) ? cd.value : [cd.value];
      if (cd.column === evCol) vals.forEach((v) => scopedEvents.add(String(v)));
      else if (bundleCol && cd.column === bundleCol) vals.forEach((v) => scopedBundles.add(String(v)));
    }
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
        if (empty.length === total) warns.push(`'${p}' has NO values for the scoped app+event combination ${fmt(empty)} (NULL/absent in the index) — this step will likely return nothing for '${p}'. Pick a field populated there: semantic_index({ request: { bundle: '${[...scopedBundles][0]}' } }) or semantic_index({ request: { source: '${fact}', property: '${p}' } }).bundle_coverage / event_coverage.`);
        else if (empty.length) warns.push(`'${p}' is empty for app+event ${fmt(empty)} (present for the other scoped pairs) — those rows contribute no '${p}'.`);
      } else if (scopedBundles.size) {
        const byB = new Map(this.valueIndex.bundleCoverage(fact, p).map((x) => [x.bundle, x]));
        const empty = [...scopedBundles].filter((b) => byB.get(b) && byB.get(b).non_null === 0);
        if (empty.length === scopedBundles.size) warns.push(`'${p}' is NULL for app(s) ${fmt(empty)} — this step likely yields no '${p}' values for ${empty.length > 1 ? 'them' : 'this app'} (semantic_index({ request: { bundle: '${empty[0]}' } })).`);
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
      const col = c.column ?? c.left?.column;
      if (!timeCols.has(col)) return;
      const value = c.value ?? c.right?.value;
      const upper = c.op === 'lte' ? value : c.op === 'between' && Array.isArray(value) ? value[1] : undefined;
      if (dateOnly(upper) && !hits.some((h) => h.col === col)) hits.push({ col, upper });
    });
    return hits.map(({ col, upper }) => `'${col}' is bounded by the bare date '${upper}': on a timestamp that is ${upper} 00:00:00, so the rest of that day is left out. To include the whole day, write { column: "${col}", op: "lt", value: "<the next day>" } (with gte for the start); on a DATE column the bound is right as it is.`);
  }

  /** Next-step hints for the just-added stage — its own (`recommend` in the stage registry), or where its columns can go. */
  stepRecommendations(stage, available) {
    const own = stageDef(stage.stage)?.recommend;
    return [
      ...this.dateBoundWarnings(stage, available),
      ...(own ? own(available) : [`Reference any of available_columns in the next stage (${listSome(available)}).`]),
      'Preview the SQL anytime with build_pipeline_model({ request: { action: "preview", draft_id } }); materialize when done.',
    ];
  }
}

