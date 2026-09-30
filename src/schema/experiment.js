// THE EXPERIMENT TOOL'S INPUT — statistics over numbers the caller brings (src/experiment.js): the A/B
// test over per-group aggregates, the sample-ratio check, the sample-size plan; one action each.

// ── A/B test statistics (computed in JS over per-group aggregates) ────────────
//
// The schema is a DISCRIMINATED UNION on `metric`: each branch is fully self-
// contained (additionalProperties:false) and its group arms accept ONLY the fields
// that metric consumes. So a proportion test cannot carry `mean`, a mean test cannot
// carry `conversions`, a ratio test must carry exactly the five ratio sums, etc. —
// invalid field combinations are rejected by the schema, not just at runtime.
//
// A typed top-level `properties` (the UNION of all group fields) sits alongside the
// oneOf so MCP clients see the real argument types (control = object, variants = array,
// confidence = number, conversions = integer, …) and serialize them correctly; the oneOf
// still enforces the exact per-metric field set on the selected branch.
export function abTestSchema() {
  const confidence = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.95, description: 'Confidence level (e.g. 0.95).' };
  const alternative = { enum: ['two_sided', 'greater', 'less'], default: 'two_sided', description: 'Hypothesis direction for the variant vs control.' };
  const correction = { enum: ['none', 'holm', 'bh'], default: 'holm', description: 'Multiple-comparison correction across the variants: holm (family-wise error rate), bh (Benjamini–Hochberg false discovery rate), or none. Adds p_value_adjusted/significant_adjusted per variant.' };

  // Per-metric stat fields (kept DRY between the union arm and the strict branches).
  const F = {
    conversions: { type: 'integer', minimum: 0, description: 'proportion: number of successes in the group.' },
    mean: { type: 'number', description: 'mean: mean of the metric over the group.' },
    stddev: { type: 'number', minimum: 0, description: 'mean: standard deviation over the group.' },
    sumNum: { type: 'number', description: 'ratio: Σ of the per-user numerator.' },
    sumDen: { type: 'number', exclusiveMinimum: 0, description: 'ratio: Σ of the per-user denominator (must be > 0).' },
    sumNum2: { type: 'number', minimum: 0, description: 'ratio: Σ of numerator².' },
    sumDen2: { type: 'number', minimum: 0, description: 'ratio: Σ of denominator².' },
    sumNumDen: { type: 'number', description: 'ratio: Σ of numerator·denominator.' },
    sumY: { type: 'number', description: 'cuped: Σ of the per-user in-experiment value Y.' },
    sumY2: { type: 'number', minimum: 0, description: 'cuped: Σ of Y².' },
    sumX: { type: 'number', description: 'cuped: Σ of the per-user pre-experiment covariate X.' },
    sumX2: { type: 'number', minimum: 0, description: 'cuped: Σ of X².' },
    sumXY: { type: 'number', description: 'cuped: Σ of Y·X.' },
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
  const familyP = { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, description: 'p-values of OTHER metrics in the same experiment readout — included in the multiplicity-correction family (Holm/BH) alongside the variants.' };
  const sequential = { type: 'boolean', description: 'Also compute an always-valid p per variant (mixture SPRT): p_value_sequential stays honest under repeated peeking at a running experiment, unlike the fixed-horizon p_value. proportion/mean only.' };
  const expectedEffect = { type: 'number', exclusiveMinimum: 0, description: 'Optional expected ABSOLUTE effect size — sets the sequential test\'s mixture prior scale (more power near this effect). Default: the observed sampling noise scale.' };
  // The split this test was designed for: given, the sample-ratio check runs in the same call, so
  // the readout carries its own trust gate instead of relying on a separate check_split.
  const expectedRatio = { type: 'array', minItems: 2, items: { type: 'number', exclusiveMinimum: 0 }, description: 'Intended split weights, in group order (e.g. [1,1] for 50/50, [2,1,1]). check_split: the order of `groups`, defaulting to an equal split. analyze: control first, then the variants — given, the result also carries the sample-ratio check (`split`); omitted, no split is assumed.' };
  // Whether a rise is good is a property of the METRIC, which the test cannot know: conversion up is
  // an improvement, crash rate or churn up is a regression. It changes no statistic — only how a
  // significant result is read (outcome: better | worse).
  const good = { enum: ['up', 'down'], default: 'up', description: 'Which direction of the metric is GOOD: up (conversion, revenue, retention) or down (crash rate, churn, load time, cost). Decides whether a significant change is an improvement or a regression; no statistic changes.' };

  // One metric branch of the union.
  const branch = (metric, branchDesc, fields, armDesc, extraProps = {}) => {
    const a = arm(fields, armDesc);
    return {
      type: 'object', additionalProperties: false, required: ['metric', 'control', 'variants'],
      description: branchDesc,
      properties: {
        metric: { enum: [metric] },
        confidence, alternative, correction, good,
        family_p_values: familyP,
        expected_ratio: expectedRatio,
        ...extraProps,
        control: a,
        variants: { type: 'array', minItems: 1, items: a, description: 'One or more variant groups, each tested against control.' },
      },
    };
  };
  // Top-level arm: lists EVERY metric's stat field (so clients see the full inner types and
  // any metric's group is expressible) but is still CLOSED — an unknown field is rejected.
  // The selected ab_test oneOf branch further pins the exact per-metric required set; this
  // closure also covers `experiment` (which composes these props WITHOUT the per-metric oneOf).
  const unionArm = { type: 'object', additionalProperties: false, required: ['n'], description: 'A group: n plus the stat fields the chosen metric needs.', properties: { label, n, ...F } };

  return {
    type: 'object',
    description: 'Two-sample (or multi-group) statistical significance test on pre-aggregated group stats — use it for any comparison of two groups, not only randomized A/B experiments. "control" and "variants" are just group A vs group B(…): e.g. mean time at first occurrence vs last occurrence, conversion of cohort X vs Y, before vs after. Don\'t hand-roll a t-test/z-test — compute per-group aggregates with a pipeline, then call this. The required group fields depend ON metric (discriminated union): proportion → conversions+n (two-proportion z-test); mean → mean+stddev+n (Welch t-test); ratio → the five per-user sums sumNum/sumDen/sumNum2/sumDen2/sumNumDen (delta-method for ratio metrics whose analysis unit is finer than the randomization unit, e.g. completed/started or clicks/impressions per user); cuped → sumY/sumY2/sumX/sumX2/sumXY (CUPED variance reduction via a pre-period covariate, then Welch). Returns each variant vs control: lift (absolute+relative, with a relative-lift CI), test statistic, p-value, confidence interval, significance, and a multiplicity-adjusted p-value across the family.',
    required: ['metric', 'control', 'variants'],
    properties: {
      metric: { enum: ['proportion', 'mean', 'ratio', 'cuped'], description: 'Which test to run and which group fields are required: proportion→conversions; mean→mean,stddev; ratio→sumNum,sumDen,sumNum2,sumDen2,sumNumDen; cuped→sumY,sumY2,sumX,sumX2,sumXY.' },
      confidence, alternative, correction, good,
      family_p_values: familyP,
      expected_ratio: expectedRatio,
      sequential,
      expected_effect: expectedEffect,
      control: unionArm,
      variants: { type: 'array', minItems: 1, items: unionArm, description: 'One or more variant groups, each tested against control.' },
    },
    discriminator: { propertyName: 'metric' },
    oneOf: [
      branch('proportion', 'Conversion-rate test (two-proportion z-test): each group carries conversions out of n.',
        { conversions: F.conversions },
        'A group for a proportion test: n and the number of conversions.',
        { sequential, expected_effect: expectedEffect }),
      branch('mean', 'Continuous-metric test (Welch t-test): each group carries the per-user mean and stddev.',
        { mean: F.mean, stddev: F.stddev },
        'A group for a mean test: n, mean and stddev.',
        { sequential, expected_effect: expectedEffect }),
      branch('ratio', 'Ratio-metric test via the delta method: each group carries the per-user numerator/denominator sums plus their squares and cross-product.',
        { sumNum: F.sumNum, sumDen: F.sumDen, sumNum2: F.sumNum2, sumDen2: F.sumDen2, sumNumDen: F.sumNumDen },
        'A group for a ratio test: n and the five per-user sums (sumNum, sumDen, sumNum2, sumDen2, sumNumDen).'),
      branch('cuped', 'CUPED variance reduction (then Welch): each group carries the per-user sufficient sums of the in-experiment value Y and the pre-experiment covariate X.',
        { sumY: F.sumY, sumY2: F.sumY2, sumX: F.sumX, sumX2: F.sumX2, sumXY: F.sumXY },
        'A group for a CUPED test: n and the five per-user sufficient sums (sumY, sumY2, sumX, sumX2, sumXY).'),
    ],
  };
}

// ── Sample Ratio Mismatch guardrail ───────────────────────────────────────────
export function srmCheckSchema() {
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
      expected_ratio: { type: 'array', minItems: 2, items: { type: 'number', exclusiveMinimum: 0 }, description: 'Intended split weights, same order as groups (e.g. [1,1] for 50/50, [2,1,1]). Defaults to an equal split.' },
    },
  };
}

// ── Power / sample-size planning ───────────────────────────────────────────────
//
// Discriminated union on `metric` (proportion needs baseline, mean needs stddev) and,
// within each branch, EXACTLY ONE of {mde, n} is required (provide mde → solve n;
// provide n → solve MDE). So neither "both" nor "neither" nor a mismatched dispersion
// field can be passed.
export function sampleSizeSchema() {
  const power = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.8, description: 'Desired statistical power (1−β).' };
  const confidence = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.95, description: 'Confidence level (1−α).' };
  const alternative = { enum: ['two_sided', 'greater', 'less'], default: 'two_sided', description: 'Hypothesis direction.' };
  const mde = { type: 'number', exclusiveMinimum: 0, description: 'Absolute minimum detectable effect (e.g. +0.02 rate, or +1.5 revenue). Provide to solve for n.' };
  const n = { type: 'integer', minimum: 2, description: 'Sample size PER GROUP. Provide to solve for the MDE instead.' };
  const exactlyOneOfMdeN = [
    { required: ['mde'], not: { required: ['n'] } },
    { required: ['n'], not: { required: ['mde'] } },
  ];
  const baseline = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'proportion: baseline conversion rate.' };
  const stddev = { type: 'number', exclusiveMinimum: 0, description: 'mean: standard deviation of the metric.' };
  const dispersion = { proportion: baseline, mean: stddev };
  const branch = (metric, dispersionField, branchDesc) => ({
    type: 'object', additionalProperties: false,
    required: ['metric', dispersionField],
    description: branchDesc,
    properties: { metric: { enum: [metric] }, [dispersionField]: dispersion[metric], mde, n, power, confidence, alternative },
    oneOf: exactlyOneOfMdeN,
  });
  // Typed top-level `properties` (union of both metrics' fields) sits alongside the oneOf so
  // MCP clients send proper numbers (not JSON strings); the oneOf still enforces the exact
  // per-metric field set + exactly one of {mde, n}.
  return {
    type: 'object',
    description: 'Power / sample-size planning (no warehouse). Provide a target effect (mde) to get the required sample size PER GROUP, or a sample size (n) to get the minimum detectable effect (MDE) — exactly one of the two. metric=proportion needs a baseline rate; metric=mean needs a stddev. Use it to size a test up front and to tell a true null apart from an underpowered one.',
    required: ['metric'],
    properties: { metric: { enum: ['proportion', 'mean'], description: 'proportion → needs baseline; mean → needs stddev. Provide exactly one of mde (→ solve n) or n (→ solve MDE).' }, baseline, stddev, mde, n, power, confidence, alternative },
    discriminator: { propertyName: 'metric' },
    oneOf: [
      branch('proportion', 'baseline', 'Conversion-rate planning: needs a baseline rate, plus exactly one of mde or n.'),
      branch('mean', 'stddev', 'Continuous-metric planning: needs a stddev, plus exactly one of mde or n.'),
    ],
  };
}

// ── ONE experiment-lifecycle tool (action-driven), folding in plan/check_split/analyze ──
// Composes the three stat schemas' top-level fields under an `action` discriminator; each
// action requires its core fields here, and the engine delegates to the per-action handler
// which re-validates the exact (per-metric) field set. So the lifecycle is one tool, but the
// strict statistical contracts are preserved.
export function experimentSchema() {
  const ab = abTestSchema();
  const srm = srmCheckSchema();
  const ss = sampleSizeSchema();
  const properties = {
    card: { type: 'boolean', description: 'analyze: draw the A/B test as a card for the person (each variant\'s lift, interval and verdict), in hosts that render MCP Apps. Omitted: no card — ask for it only when the person should see this result. The split check and the plan have no card (card: true is refused there): answer them in words.' },
    action: { enum: ['plan', 'check_split', 'analyze'], description: 'plan → required sample size / MDE (power planning, BEFORE running); check_split → Sample-Ratio-Mismatch χ² guardrail that the observed split is valid (run BEFORE trusting any lift); analyze → the A/B significance test on per-group aggregates.' },
    // union of all three actions' fields (analyze/ab_test wins on shared keys like metric).
    ...ss.properties,
    ...srm.properties,
    ...ab.properties,
  };
  return {
    type: 'object', additionalProperties: false, required: ['action'],
    description: 'The A/B experiment lifecycle in one tool (action-driven): plan → check_split → analyze. plan = power/sample-size (how many users, or the MDE at a given n) before running; check_split = Sample-Ratio-Mismatch χ² guardrail (a bad split invalidates the experiment — run it before trusting any lift); analyze = the significance test on pre-aggregated per-group stats (metric: proportion → conversions, mean → mean+stddev, ratio → per-user sums, cuped → variance reduction), returning lift + p-value + CI + significance, multiplicity-adjusted across variants. Compute the per-group aggregates first with a pipeline.',
    allOf: [
      { if: { properties: { action: { const: 'plan' } }, required: ['action'] }, then: { required: ['metric'], properties: { metric: { enum: ['proportion', 'mean'] } } } },
      { if: { properties: { action: { const: 'check_split' } }, required: ['action'] }, then: { required: ['groups'] } },
      { if: { properties: { action: { const: 'analyze' } }, required: ['action'] }, then: { required: ['metric', 'control', 'variants'] } },
      // a card exists for the test alone: card: true elsewhere is refused by name (false is harmless)
      { if: { properties: { action: { enum: ['plan', 'check_split'] } }, required: ['action'] }, then: { properties: { card: { const: false, description: 'The split check and the plan have no card.' } } } },
    ],
    properties,
  };
}
