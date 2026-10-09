// THE EXPERIMENT TOOL'S INPUT — statistics over numbers the caller brings (src/experiment.js): the A/B
// test over per-group aggregates, the sample-ratio check, the sample-size plan; one action each.

// ── A/B test statistics (computed in JS over per-group aggregates) ────────────
//
// The schema is a union of closed forms, one per `metric` (an `anyOf` — src/schema-kit.js says why):
// each form is fully self-contained and its group arms accept ONLY the fields that metric consumes.
// So a proportion test cannot carry `mean`, a mean test cannot carry `conversions`, a ratio test must
// carry exactly the numerator's and the denominator's sums and their products, etc. — invalid field combinations are rejected by the schema, not
// just at runtime, and every field is typed where the form names it.
import { form } from '../schema-kit.js';

// The fields more than one action takes, each defined once (the test, the plan and the split check read them alike).
const CONFIDENCE = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.95, description: 'Confidence level, 1−α (e.g. 0.95).' };
const ALTERNATIVE = { enum: ['two_sided', 'greater', 'less'], default: 'two_sided', description: 'Hypothesis direction for the variant vs control.' };
// The split a test was designed for: given to analyze, the sample-ratio check runs in the same call,
// so the readout carries its own trust gate instead of relying on a separate check_split.
const EXPECTED_RATIO = { type: 'array', minItems: 2, items: { type: 'number', exclusiveMinimum: 0 }, description: 'Intended split weights, in group order (e.g. [1,1] for 50/50, [2,1,1]). check_split: the order of `groups`, defaulting to an equal split. analyze: control first, then the variants — given, the result also carries the sample-ratio check (`split`); omitted, no split is assumed.' };

export function analyzeContract() {
  return { type: 'object', description: AB_DESCRIPTION, anyOf: abTestForms() };
}

const AB_DESCRIPTION = 'Two-sample (or multi-group) statistical significance test on pre-aggregated group stats — use it for any comparison of two groups, not only randomized A/B experiments. "control" and "variants" are just group A vs group B(…): e.g. mean time at first occurrence vs last occurrence, conversion of cohort X vs Y, before vs after. Don\'t hand-roll a t-test/z-test — compute per-group aggregates with a pipeline, then call this. The required group fields depend ON metric: proportion → conversions+n (two-proportion z-test); mean → mean+stddev+n (Welch t-test); ratio → n, numerator { sum, sum_squares }, denominator { sum, sum_squares } and sum_products of the per-user values (delta-method for ratio metrics whose analysis unit is finer than the randomization unit, e.g. completed/started or clicks/impressions per user); cuped → n, sum and sum_squares of the in-experiment value, covariate { sum, sum_squares } of the pre-period value and sum_products of the two (CUPED variance reduction, then Welch). Returns each variant vs control: lift (absolute+relative, with a relative-lift CI), test statistic, p-value, confidence interval, significance, and a multiplicity-adjusted p-value across the family.';

/** The A/B test's forms, one per metric — with `extra` fields (an action, a card) added to each. */
function abTestForms(extra = {}) {
  const correction = { enum: ['none', 'holm', 'bh'], default: 'holm', description: 'Multiple-comparison correction across the variants: holm (family-wise error rate), bh (Benjamini–Hochberg false discovery rate), or none. Adds p_value_adjusted/significant_adjusted per variant.' };

  // The sums of one per-user value, { sum, sum_squares }, defined once: a mean test's group from its
  // sums and a CUPED group carry them at their top level (the metric tested), a CUPED group's
  // covariate and a ratio test's numerator and denominator as an object of their own.
  const sums = (what, { positive = false } = {}) => ({
    type: 'object', additionalProperties: false, required: ['sum', 'sum_squares'],
    description: `The group's sums of ${what}.`,
    properties: {
      sum: { type: 'number', ...(positive ? { exclusiveMinimum: 0 } : {}), description: `Σ of ${what}${positive ? ' (must be > 0)' : ''}.` },
      sum_squares: { type: 'number', minimum: 0, description: `Σ of ${what}².` },
    },
  });
  const tested = sums('the per-user metric').properties;
  // Per-metric stat fields (kept DRY between the union arm and the strict branches).
  const F = {
    conversions: { type: 'integer', minimum: 0, description: 'proportion: number of successes in the group.' },
    mean: { type: 'number', description: 'mean: mean of the metric over the group.' },
    stddev: { type: 'number', minimum: 0, description: 'mean: standard deviation over the group.' },
  };
  const ratioFields = {
    numerator: sums('the per-user numerator'),
    denominator: sums('the per-user denominator', { positive: true }),
    sum_products: { type: 'number', description: 'Σ of numerator · denominator, per user.' },
  };
  const cupedFields = {
    sum: tested.sum,
    sum_squares: tested.sum_squares,
    covariate: sums('the per-user pre-experiment covariate'),
    sum_products: { type: 'number', description: 'Σ of the metric · the covariate, per user.' },
  };
  const label = { type: 'string', description: 'Group name (e.g. control, variant_b).' };
  const n = { type: 'integer', minimum: 1, description: 'Sample size (e.g. users in the group).' };

  // One metric's group arm (strict): label + n + exactly that metric's required fields.
  const arm = (fields, armDesc) => ({
    type: 'object', additionalProperties: false, required: ['n', ...Object.keys(fields)],
    description: armDesc,
    properties: { label, n, ...fields },
  });
  // Cross-metric multiplicity: p-values of the experiment's OTHER metrics join the
  // correction family, so a 10-metric scorecard cannot fish significance.
  const familyP = { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, description: 'p-values of other metrics in the same experiment readout — included in the multiplicity-correction family (Holm/BH) alongside the variants.' };
  const sequential = { type: 'boolean', description: 'Also compute an always-valid p per variant (mixture SPRT): p_value_sequential stays honest under repeated peeking at a running experiment, unlike the fixed-horizon p_value. proportion/mean only.' };
  const expectedEffect = { type: 'number', exclusiveMinimum: 0, description: 'Optional expected ABSOLUTE effect size — sets the sequential test\'s mixture prior scale (more power near this effect). Default: the observed sampling noise scale.' };
  // Whether a rise is good is a property of the METRIC, which the test cannot know: conversion up is
  // an improvement, crash rate or churn up is a regression. It changes no statistic — only how a
  // significant result is read (outcome: better | worse).
  const good = { enum: ['up', 'down'], default: 'up', description: 'Which direction of the metric is good: up (conversion, revenue, retention) or down (crash rate, churn, load time, cost). Decides whether a significant change is an improvement or a regression; no statistic changes.' };

  // One metric's form.
  // a group may be given in several closed forms (each with distinct required fields): `fields` a list of [fields, description]
  const branch = (metric, branchDesc, fields, armDesc, extraProps = {}) => {
    const a = Array.isArray(fields) ? { anyOf: fields.map(([f, d]) => arm(f, d)) } : arm(fields, armDesc);
    return form({
      title: `metric: ${metric}`,
      description: branchDesc,
      tag: ['metric', metric],
      required: [...Object.keys(extra).filter((k) => extra[k].required), 'control', 'variants'],
      properties: {
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v.schema])),
        confidence: CONFIDENCE, alternative: ALTERNATIVE, correction, good,
        family_p_values: familyP,
        expected_ratio: EXPECTED_RATIO,
        ...extraProps,
        control: a,
        variants: { type: 'array', minItems: 1, items: a, description: 'One or more variant groups, each tested against control.' },
      },
    });
  };
  return [
    branch('proportion', 'Conversion-rate test (two-proportion z-test): each group carries conversions out of n.',
      { conversions: F.conversions },
      'A group for a proportion test: n and the number of conversions.',
      { sequential, expected_effect: expectedEffect }),
    branch('mean', 'Continuous-metric test (Welch t-test): each group carries the per-user mean and stddev — or the sum and sum of squares a pipeline\'s aggregate gives, from which they are computed (the sample stddev).',
      [[{ mean: F.mean, stddev: F.stddev }, 'A group for a mean test: n, mean and stddev.'], [{ sum: tested.sum, sum_squares: tested.sum_squares }, 'A group for a mean test from its sums — what one aggregate stage gives: n (at least 2), sum and sum_squares of the per-user values.']],
      null,
      { sequential, expected_effect: expectedEffect }),
    branch('ratio', 'Ratio-metric test via the delta method: each group carries the sums of the per-user numerator and denominator, and the sum of their products.',
      ratioFields,
      'A group for a ratio test: n, numerator { sum, sum_squares }, denominator { sum, sum_squares } and sum_products, over the per-user values.'),
    branch('cuped', 'CUPED variance reduction (then Welch): each group carries the sums of the per-user in-experiment value (as a mean test\'s group does), the sums of the pre-experiment covariate, and the sum of their products.',
      cupedFields,
      'A group for a CUPED test: n, sum and sum_squares of the in-experiment value, covariate { sum, sum_squares }, and sum_products.'),
  ];
}

// ── Sample Ratio Mismatch guardrail ───────────────────────────────────────────
export function checkSplitContract() {
  return {
    type: 'object', additionalProperties: false, required: ['groups'],
    description: 'Sample Ratio Mismatch (SRM) guardrail: a χ² goodness-of-fit test that the observed per-group sample sizes match the intended split. A detected mismatch (p < 0.001) means randomization or logging is broken and the experiment is invalid — run this before trusting any lift. Compute per-group n with a pipeline first.',
    properties: {
      groups: {
        type: 'array', minItems: 2, description: 'Observed groups with their sample sizes.',
        items: {
          type: 'object', additionalProperties: false, required: ['n'],
          properties: {
            label: { type: 'string', description: 'Group name (e.g. control, variant_b).' },
            n: { type: 'integer', minimum: 0, description: 'Observed sample size in this group.' },
          },
        },
      },
      expected_ratio: EXPECTED_RATIO,
    },
  };
}

// ── Power / sample-size planning ───────────────────────────────────────────────
//
// One form per `metric` (proportion needs baseline, mean needs stddev) and per what is solved for:
// EXACTLY ONE of {mde, n} is given (mde → solve n; n → solve MDE), so each pair is a form of its own
// that takes the one and not the other. Neither "both" nor "neither" nor a mismatched dispersion field
// can be passed.
export function planContract() {
  return {
    type: 'object',
    description: 'Power / sample-size planning (no warehouse). Provide a target effect (mde) to get the required sample size per group, or a sample size (n) to get the minimum detectable effect (MDE) — exactly one of the two. metric=proportion needs a baseline rate; metric=mean needs a stddev. Use it to size a test up front and to tell a true null apart from an underpowered one.',
    anyOf: sampleSizeForms(),
  };
}

function sampleSizeForms(extra = {}) {
  const power = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.8, description: 'Desired statistical power (1−β).' };
  const mde = { type: 'number', exclusiveMinimum: 0, description: 'Absolute minimum detectable effect (e.g. +0.02 rate, or +1.5 revenue) — the sample size per group is solved for.' };
  const n = { type: 'integer', minimum: 2, description: 'Sample size per group — the minimum detectable effect is solved for.' };
  const dispersion = {
    proportion: ['baseline', { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'Baseline conversion rate.' }],
    mean: ['stddev', { type: 'number', exclusiveMinimum: 0, description: 'Standard deviation of the metric.' }],
  };
  const forms = [];
  for (const [metric, [field, schema]] of Object.entries(dispersion)) {
    for (const [given, givenSchema, solves] of [['mde', mde, 'the sample size'], ['n', n, 'the MDE']]) {
      forms.push(form({
        title: `metric: ${metric}, given ${given}`,
        description: `${metric === 'proportion' ? 'Conversion-rate' : 'Continuous-metric'} planning from ${given === 'mde' ? 'a target effect' : 'a sample size'}: solves ${solves}.`,
        tag: ['metric', metric],
        required: [...Object.keys(extra).filter((k) => extra[k].required), field, given],
        properties: { ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v.schema])), [field]: schema, [given]: givenSchema, power, confidence: CONFIDENCE, alternative: ALTERNATIVE },
      }));
    }
  }
  return forms;
}

// ── ONE experiment-lifecycle tool (action-driven), folding in plan/check_split/analyze ──
// The three statistics' own forms, each with the `action` that picks it added: plan → the planning
// forms, check_split → the split check, analyze → the test's forms (with `card`, which only the test
// has). The engine hands the rest to the per-action statistic, which re-validates it.
export function experimentSchema() {
  const card = { type: 'boolean', description: 'Draw the A/B test as a card for the person (each variant\'s lift, interval and verdict), in hosts that render MCP Apps. Omitted: no card — ask for it only when the person should see this result.' };
  // a card exists for the test alone: card: true elsewhere is refused by name (false is harmless)
  const noCard = { const: false, description: 'The split check and the plan have no card: answer them in words.' };
  const action = (value, description) => ({ required: true, schema: { const: value, description } });
  const srm = checkSplitContract();
  return {
    type: 'object',
    description: 'One form per action: plan (before the test — the sample size, or the MDE at a given n), check_split (the sample-ratio guardrail), analyze (the significance test over the per-group aggregates you bring; `metric` picks the test).',
    anyOf: [
      ...sampleSizeForms({ action: action('plan', 'plan: the required sample size, or the MDE at a given n (power planning, before running).'), card: { schema: noCard } }).map((f) => ({ ...f, title: `plan — ${f.title}` })),
      { ...form({ title: 'check_split', description: srm.description, tag: ['action', 'check_split'], tagDescription: 'check_split: the Sample-Ratio-Mismatch χ² guardrail that the observed split is valid (run it before trusting any lift).', required: srm.required, properties: { ...srm.properties, card: noCard } }) },
      ...abTestForms({ action: action('analyze', 'analyze: the A/B significance test on per-group aggregates.'), card: { schema: card } }).map((f) => ({ ...f, title: `analyze — ${f.title}` })),
    ],
  };
}
