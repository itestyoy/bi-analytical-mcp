// THE PATH-ANALYSIS GUIDE — how to use the retentioneering feature, served while the feature is on:
// semantic_index({ guide: "retentioneering" }) returns it, the analyst guide's routing carries its
// triggers, the core instructions one line, and the `retentioneering` skill renders the same object.
// Method, not data: it names no column or event (the catalog and the eventstream summary say what
// exists), and every parameter it mentions is one the tool schema offers.

import { retentioneeringFacts } from './schema.js';

export const GUIDE_NAME = 'retentioneering';

export const ROUTING_TRIGGERS = [
  {
    if: 'a question about paths and sequences — what users do after an event, where they drop off, which transitions dominate, what kinds of paths there are',
    do: `path analysis: build_retentioneering_model (the eventstream: source, window, events, segments), then query_retentioneering_model with every analysis the question needs in one call, then display_retentioneering_result for the card. semantic_index({ guide: "${GUIDE_NAME}" }) says which analysis answers which question. An ordered funnel with exact step definitions (event + property value) stays a build_pipeline_model funnel.`,
  },
];

export const INSTRUCTIONS_LINE = `For paths and sequences (what users do after an event, where they drop off, kinds of paths), use build_retentioneering_model → query_retentioneering_model; semantic_index({ guide: "${GUIDE_NAME}" }) explains the analyses.`;

export function retentioneeringGuide() {
  const f = retentioneeringFacts();
  return {
    task: GUIDE_NAME,
    title: 'Path analysis with retentioneering',
    library: `retentioneering ${f.version} (Apache-2.0) — the analyses are its own headless computations, run in the warehouse`,
    sequence: [
      { step: 'Frame the paths', do: 'Decide whose paths (each user\'s history, or sessions), over which window, and which events matter. Technical noise (heartbeats, screen pings) hides the story: exclude it, or merge near-duplicates into one name with events.groups.' },
      { step: 'Build the eventstream', do: 'build_retentioneering_model({ name, source, time_range, events, segments, sessions?, sample? }). Read its summary with query_retentioneering_model({ task_id }): users, events, the vocabulary after grouping. Every event keeps its name; if a long tail of rare names makes the graph unreadable, events.top merges all but the N most frequent into "other".' },
      { step: 'Size it', do: 'One analysis run holds the whole eventstream in memory on the warehouse runtime. For a very large source, sample: { share } keeps a stable subset of users (a hash of the key), so every later analysis reads the same people.' },
      { step: 'Run the analyses together', do: 'query_retentioneering_model({ context_id, analyses: [...] }) — list everything the question needs in ONE call: they are computed in one run (one start-up of the warehouse runtime). Read the task with { task_id }.' },
      { step: 'Show and read', do: 'display_retentioneering_result({ task_id, analysis }) draws one analysis as a card, once. Report what the numbers say — the transitions with their shares, the step where paths split, the cluster sizes and what sets each apart — with the window and any sample.' },
    ],
    analyses: {
      transition_graph: 'Which event follows which. Every weight comes back at once (' + f.edge_weights.join(', ') + '), so the card switches between them: proba_out answers "after X, where do users go", proba_in "how do users arrive at Y", count and unique_paths the volume, time_median the wait between the two.',
      step_matrix: 'The share of paths at each event, step by step from the start; with anchor: { pattern: "<event>" } the steps around that event (before it negative, after it positive) — what leads to it and what follows. path_pattern "a->.*->b" restricts to paths that go from a to b.',
      step_sankey: 'The same shares drawn as flows between consecutive steps — the branching after the start. Around an anchor it shows the columns without flows.',
      funnel: 'How many paths reach each event of an ordered list (in that order), and the conversion step to step. For steps defined by an event property value, build a pipeline funnel instead.',
      cluster_analysis: `Groups of similar paths from per-path metrics (features; default: how often each event occurs), with ${f.cluster_methods.join(' or ')}; several n_clusters are tried and the best silhouette wins. Each cluster comes back with its size and profile (length, duration, the share of paths with each event).`,
      segment_overview: 'Per-path metrics compared across the levels of a segment the eventstream carries (a user attribute listed in segments at build time).',
    },
    path_metrics: f.path_metrics,
    metric_aggregations: f.segment_aggs,
    checks: [
      'A path is one user\'s (or one session\'s) events in time order, from path_start to path_end: an analysis over a short window sees truncated paths — say so.',
      'With events.top, "other" is the merged tail of the vocabulary, not an event: do not read a transition to "other" as a behaviour.',
      'A sample is of users, stable across builds, but still a sample: give it with the numbers.',
      'Clusters are descriptive: name them from their profile, and check that the smallest is not a handful of paths.',
    ],
  };
}

const md = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? `- **${x.step}** — ${x.do}` : `- ${x}`)).join('\n') : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `- **${k}** — ${x}`).join('\n') : String(v));

/** The `retentioneering` skill: the same guide object, as markdown. */
export function retentioneeringSkill() {
  const g = retentioneeringGuide();
  const body = [
    `# ${g.title}`,
    '',
    `The same guide the tool returns: \`semantic_index({ guide: "${GUIDE_NAME}" })\`. ${g.library}.`,
    '',
    '## Sequence', '', md(g.sequence),
    '', '## Which analysis answers what', '', md(g.analyses),
    '', '## Path metrics (features, overview and segment metrics)', '', md(g.path_metrics), '', `Roll-ups: ${g.metric_aggregations.join(', ')}.`,
    '', '## Checks', '', md(g.checks),
  ].join('\n');
  return {
    path: 'betti/retentioneering',
    frontmatter: {
      name: 'retentioneering',
      description: 'How to run path analysis with this server: build an eventstream (build_retentioneering_model), run the analyses together (query_retentioneering_model — transition graph, step matrix and sankey, funnel, path clusters, segment overview) and draw them (display_retentioneering_result). Use for questions about paths, sequences and drop-off.',
    },
    body,
    references: [],
  };
}
