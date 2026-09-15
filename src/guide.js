// The generic ANALYST PROCEDURE + routing for this server, served THROUGH the MCP
// (semantic_index({ guide })) so the guidance reaches the model via the tools — not
// only when a client has loaded a skill. This is the SINGLE SOURCE OF TRUTH for the
// generic procedure: a deployment skill should POINT here (semantic_index({ guide }))
// rather than copy it, so the two never drift. Domain/company specifics (glossary,
// links, dataset-specific gotchas) stay in the deployment skill.
//
// Built from the catalog (roles/event_semantics) + recipes (the per-task playbooks),
// so it stays correct for ANY catalog without hardcoding names.

export function buildGuide(catalog, recipes, { task } = {}) {
  const usersModel = catalog.modelKeys().find((k) => catalog.getModel(k).role === 'users') || 'users';
  const experimentsModel = catalog.modelKeys().find((k) => catalog.getModel(k).role === 'experiments') || 'experiments';
  // A catalog may carry SEVERAL events sources (e.g. analytics events + crash reports). They are
  // equal and never mixed: each has its own events/properties, and a question is answered from
  // ONE of them, named explicitly.
  const facts = catalog.facts;
  const multi = facts.length > 1;
  // A catalog may also carry NON-events sources that declare MEASURES (acquisition spend, say):
  // no event vocabulary, but their own time axis and their own aggregatable amounts.
  // Relationships the schema declares between two models — what a `via` join names, and what a
  // { model, attribute, via } group-by resolves through.
  const joinNames = catalog.joinEntityNames();
  const measureSources = catalog.modelKeys()
    .filter((k) => !catalog.isFact(k) && catalog.aggregatableFields(k).length)
    .map((k) => ({ key: k, measures: catalog.aggregatableFields(k).map((a) => a.name) }));
  const sem = Object.fromEntries(facts.flatMap((f) => Object.entries(catalog.getModel(f).event_semantics || {}).map(([k, v]) => [multi ? `${f}.${k}` : k, v])));

  const workflow = [
    'CLARIFY the ask before querying: time window (resolve "last week" to the last COMPLETE period), segment, and the decision behind it.',
    'DISCOVER with semantic_index: overview → { source, event } → { source, property } / { search }. Map business words to real fields — you cannot reference a field that does not exist.',
    'PREFER the governed path: a reusable named metric via create_semantic_model + query_semantic_model. Drop to a build_native_model pipeline only for a one-off table the governed metrics cannot express (funnel / sessionization / window / pivot).',
    'BOUND + EXCLUDE: always pass a time_range; exclude test/internal users and the cohorts the question excludes.',
    'REVIEW adversarially before trusting a number: 0 rows? a property NULL because you did not scope to its event? per-event vs per-user grain? a zero-denominator rate? a segment that silently dropped most rows? Re-run with the fix.',
    'REPORT with provenance: tier (governed metric › pipeline), grain + filters, time window, data freshness, and separate observation from interpretation.',
  ];

  const routing_triggers = [
    { if: 'a named KPI / rate / cumulative metric', do: 'governed metric: create_semantic_model + query_semantic_model — NOT a hand-rolled pipeline.' },
    { if: 'an ordered multi-step funnel / path / time-between-steps', do: 'a build_native_model pipeline with a match_recognize stage (funnels are events-only).' },
    { if: 'an A/B question ("is variant B better")', do: `compute per-variant aggregates first (a pipeline joining '${experimentsModel}'), then experiment({ action: 'analyze' }); run experiment({ action: 'check_split' }) BEFORE trusting any lift.` },
    { if: 'comparing TWO groups for significance that are NOT an experiment (first vs last, before vs after, cohort A vs B, organic vs paid)', do: 'do NOT hand-roll a t-test. Aggregate per group in one pipeline (mean: n+mean+stddev; rate: conversions+n), then ab_test({ metric: "mean" | "proportion" }) — "control"/"variants" are just group A vs B; no experiments table needed. See semantic_index({ recipe: "two_sample_significance" }).' },
    { if: 'segmenting by a user attribute (country / platform / source)', do: `group/filter by { model: '${usersModel}', attribute: '<attr>' } with use_base_models: ['${usersModel}'] — user attributes are NOT on the event payload.` },
    ...(joinNames.length ? [
      { if: 'combining two sources (events with spend, an events source with another, a source with the install record)', do: `use the RELATIONSHIP the schema declares — ${joinNames.join(', ')} — never hand-picked columns. In a metric query: group by { model: '<the other model>', attribute } (add via when several relationships lead there) and declare that model in use_base_models. In a pipeline: add_step { stage: 'join', with: '<model>', via: '<relationship>' }. semantic_index({ model }) lists each model's relationships, their key columns and what they point at. A key may span several columns and the two sides may name their columns differently. Join stages STACK, so one pipeline can chain several relationships and reach four sources at once; via always resolves its left-hand key on the pipeline's OWN source.` },
      { if: 'a join returns far MORE rows than the base table (or a sum is suspiciously large)', do: 'you probably joined a SLOWLY-CHANGING model on its key alone, so every row matched every historical version. Add the point-in-time window to the join stage: between: { value: <this source\'s time column>, from: <validity start column>, to: <validity end column> } — semantic_index({ model }) names them. In a metric query MetricFlow applies the window for you.' },
      // Only when the catalog actually carries a relationship in VARIANTS (one relationship, several
      // alternative key columns on a side) — and phrased from those names, not from a domain.
      ...Object.entries(catalog.variantRelationships()).map(([rel, names]) => ({
        if: `joining on '${rel}' when one side carries it in several alternative columns`,
        do: `pick the variant the question is about — via: ${names.map((n) => `'${n}'`).join(' | ')} — each is the same relationship through a different key column. When several rows share one key value neither side is unique on it, so this is a pipeline join with no governed path.`,
      })),
    ] : []),
    ...(multi ? [
      { if: 'choosing WHERE to look', do: `there are ${facts.length} independent events sources — ${facts.join(', ')} — each with its OWN events and payload properties, never mixed. Decide which one records the thing being asked about, then name it: semantic_index({ source, event }), build_native_model({ source }), create_semantic_model({ semantic_models: [{ from: <source> }] }). Inside a pipeline or semantic model built from a source, its event/property names are used as-is.` },
      { if: 'a funnel/sequence that would span TWO sources (something in one, then something in the other)', do: 'not expressible: a row-pattern match scans ONE table. Compute a per-user outcome from each source separately (one pipeline each), then compare the two groups with ab_test, or join the aggregates on the user key.' },
      { if: 'comparing volumes from different sources', do: 'ONE create_semantic_model with a semantic model per source, then query both metrics grouped by metric_time — MetricFlow aligns them on the shared time axis. Do NOT put measures from two sources in one semantic model.' },
    ] : []),
    ...(measureSources.length ? [
      { if: `the question is about an AMOUNT that is not an event (${measureSources.map((m) => `${m.key}: ${m.measures.join(', ')}`).join(' · ')})`, do: `the source already marks those fields aggregatable — do NOT re-derive them from events. The schema fixes NO aggregation: choose the function the question needs. create_semantic_model({ semantic_models: [{ from: '${measureSources[0].key}', measures: [{ name: <your name>, agg: 'sum' | 'average' | 'max' | 'median' | 'percentile', field: '${measureSources[0].measures[0]}' }] }], metrics: [{ name: ..., type: 'simple', measure: { name: <your name> } }] }); semantic_index({ model: '${measureSources[0].key}' }) lists each amount with its unit and meaning. Such a source has its own time axis (metric_time works) and carries the user entity, so group_by: [{ model: '<the users model>', attribute: '<attr>' }] segments it (declare use_base_models with that model).` },
      { if: 'joining a per-day table (spend, budgets) to an events source in a pipeline', do: 'join by the PLAYER relationship (via). One player has many events and several dated rows, so the pairing is MANY-TO-MANY by design: it is how you carry an attribute (channel, campaign) onto events, and summing the amount over it inflates the total many times over. For the total, aggregate the per-day source itself; for a per-day comparison, aggregate each source separately and line them up on metric_time.' },
    ] : []),
    { if: 'a property reads mostly NULL', do: 'you probably did not scope to the event(s) that carry it — most event_data properties are event-specific (see semantic_index({ source, property }).event_coverage).' },
    ...(catalog.facts.some((f) => catalog.bundleColumn(f)) ? [{ if: 'the question is about ONE app (a bundle id), or a property looks empty for an app', do: 'semantic_index({ bundle: "<bundle id>" }) lists which event properties are POPULATED vs EMPTY for that app — skip the empty ones rather than querying them. The overview lists apps under `bundles`; a property empty for one app may be populated for another (see { source, property }.bundle_coverage). Group/filter by the app column to segment per app.' }] : []),
    { if: 'unsure which field or value to use', do: 'semantic_index({ search }) maps a word/value to the property + the event(s) carrying it — do not guess. Search also returns saved findings (memory) — a fuzzy term someone used before may already resolve to the real field.' },
    { if: 'you JUST resolved something non-obvious (a vague request → a real field, a gotcha, a useful source)', do: 'record it with the memory tool (note + the entities it is about as `targets` + the words the user used as `aliases`, in BOTH the user\'s language and English for cross-language recall + any `links`). It then resurfaces on those semantic_index views and via { search } — so it is not re-investigated next time.' },
    { if: 'you only need a QUICK directional read on large data (shape, not an exact number)', do: 'add a `sample` stage to a build_native_model pipeline (or get_query_result with sample:true) — a fast ~N% random subset. The result is flagged `approximate`; ALWAYS re-run WITHOUT the sample for any number you will act on (sampling error flips rates near 0/1, small segments, distinct counts).' },
    { if: 'counting DISTINCT (users, sessions, payers) — especially across time/segments', do: 'PREFER HLL sketches: a build_native_model aggregate with hll_init (per bucket) → hll_merge (combine). Unlike count_distinct, HLL is MERGEABLE — one sketch re-aggregates across days/segments and composes incrementally, at high accuracy and a fraction of the cost. Use exact count_distinct only when an exact integer is required on a small set. (count_distinct is NOT additive across buckets; HLL is.)' },
    { if: 'you made a mistake on step N of a long build_native_model draft', do: 'do NOT discard and rebuild. Fix it in place: edit_step / insert_step / delete_step { index }, or truncate { after } to roll back to step N. Every edit revalidates the whole pipeline and names the failing step if an edit breaks a later one.' },
    { if: 'you want to try a VARIANT of a draft (or an already-built pipeline) without losing the original', do: 'build_native_model({ action: "fork", draft_id, after }) branches a NEW draft from steps 1..after — iterate the variant without re-typing the shared prefix; the original is untouched. A fork INHERITS the materialized prefixes it keeps and reads the same tables, so a variant over an expensive prefix costs only its own steps.' },
    { if: 'you materialized a pipeline and now want to look at something ELSE in the result (drill into one segment, group it differently)', do: 'just keep going on the SAME draft: add_step after materialize reads the table already built instead of recomputing the prefix, and materialize again. Do NOT start a new draft that repeats the expensive steps. The response says what it started from (from_checkpoint / steps_recomputed). Editing a step at or before that prefix retires it (checkpoints_dropped) and the next materialize rebuilds from the source — so put exploratory steps AFTER the point you materialized.' },
  ];

  // Playbooks = the curated recipes, grouped by task family. Fetch one in full with
  // semantic_index({ recipe: id }).
  const tasks = {};
  if (recipes) for (const r of recipes.summary()) (tasks[r.task_type] ||= []).push({ id: r.id, title: r.title, when_to_use: r.when_to_use });

  if (typeof task === 'string') {
    const list = tasks[task];
    return list
      ? { task, workflow, routing_triggers, recipes: list, next: `Fetch a recipe in full with semantic_index({ recipe: '${list[0].id}' }).` }
      : { task, workflow, routing_triggers, recipes: [], note: `No recipes for task family '${task}'. Known families: ${Object.keys(tasks).join(', ') || '(none configured)'}.` };
  }

  return {
    ...(multi ? { events_sources: { sources: facts, note: 'Independent, equal events sources: each owns its events, payload properties and indexed values. Name the source you mean (semantic_index({ source, event }), build_native_model({ source }), semantic_models[].from); within one, names are used as-is. A funnel runs over ONE source; metrics from different sources can still be compared over metric_time.' } } : {}),
    note: 'The analyst procedure + routing for this server. Follow `workflow`; use `routing_triggers` (IF…DO) to pick the right tool; `tasks` lists ready-made recipes per family — fetch one with semantic_index({ recipe: id }). Narrow to one family with semantic_index({ guide: "<task_type>" }).',
    workflow,
    routing_triggers,
    ...(Object.keys(sem).length ? { event_semantics: sem } : {}),
    tasks,
    provenance_footer: ['tier (governed metric › pipeline)', 'grain + filters + time window (complete period)', 'data freshness (latest event time)', 'observation vs interpretation'],
  };
}
