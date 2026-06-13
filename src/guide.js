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
  const sem = catalog.getModel(catalog.anchor).event_semantics || {};

  const workflow = [
    'CLARIFY the ask before querying: time window (resolve "last week" to the last COMPLETE period), segment, and the decision behind it.',
    'DISCOVER with semantic_index: overview → { event } → { property } / { search }. Map business words to real fields — you cannot reference a field that does not exist.',
    'PREFER the governed path: a reusable named metric via create_semantic_model + query_semantic_model. Drop to a build_native_model pipeline only for a one-off table the governed metrics cannot express (funnel / sessionization / window / pivot).',
    'BOUND + EXCLUDE: always pass a time_range; exclude test/internal users and the cohorts the question excludes.',
    'REVIEW adversarially before trusting a number: 0 rows? a property NULL because you did not scope to its event? per-event vs per-user grain? a zero-denominator rate? a segment that silently dropped most rows? Re-run with the fix.',
    'REPORT with provenance: tier (governed metric › pipeline), grain + filters, time window, data freshness, and separate observation from interpretation.',
  ];

  const routing_triggers = [
    { if: 'a named KPI / rate / cumulative metric', do: 'governed metric: create_semantic_model + query_semantic_model — NOT a hand-rolled pipeline.' },
    { if: 'an ordered multi-step funnel / path / time-between-steps', do: 'a build_native_model pipeline with a match_recognize stage (funnels are events-only).' },
    { if: 'an A/B question ("is variant B better")', do: `compute per-variant aggregates first (a pipeline joining '${experimentsModel}'), then experiment({ action: 'analyze' }); run experiment({ action: 'check_split' }) BEFORE trusting any lift.` },
    { if: 'segmenting by a user attribute (country / platform / source)', do: `join/group by the '${usersModel}' model (user__<attr>) — it is NOT on the event payload.` },
    { if: 'a property reads mostly NULL', do: 'you probably did not scope to the event(s) that carry it — most event_data properties are event-specific (see semantic_index({ property }).event_coverage).' },
    { if: 'unsure which field or value to use', do: 'semantic_index({ search }) maps a word/value to the property + the event(s) carrying it — do not guess.' },
    { if: 'you only need a QUICK directional read on large data (shape, not an exact number)', do: 'add a `sample` stage to a build_native_model pipeline (or get_query_result with sample:true) — a fast ~N% random subset. The result is flagged `approximate`; ALWAYS re-run WITHOUT the sample for any number you will act on (sampling error flips rates near 0/1, small segments, distinct counts).' },
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
    note: 'The analyst procedure + routing for this server. Follow `workflow`; use `routing_triggers` (IF…DO) to pick the right tool; `tasks` lists ready-made recipes per family — fetch one with semantic_index({ recipe: id }). Narrow to one family with semantic_index({ guide: "<task_type>" }).',
    workflow,
    routing_triggers,
    ...(Object.keys(sem).length ? { event_semantics: sem } : {}),
    tasks,
    provenance_footer: ['tier (governed metric › pipeline)', 'grain + filters + time window (complete period)', 'data freshness (latest event time)', 'observation vs interpretation'],
  };
}
