// THE EXPERIMENT'S STATISTICS — the analyze / check_split / plan actions of the experiment tool, over
// numbers the caller brings (pre-aggregated per-group stats a pipeline computed). Pure: no warehouse,
// no task, no state; the input is validated against the tool's schema by the engine before it gets here.

import { twoProportionZTest, welchTTest, cupedTest, ratioDeltaTest, srmTest, adjustPValues, alwaysValidP, sampleSizeProportion, mdeProportion, sampleSizeMean, mdeMean } from './stats.js';
import { ToolError } from './validate.js';

/**
 * A/B significance test over PRE-AGGREGATED group stats (computed by a pipeline
 * that joins the experiments source, windows events to the assignment period,
 * and aggregates per group). proportion → two-proportion z-test; mean → Welch
 * t-test; ratio → delta-method test for ratio metrics whose analysis unit is
 * finer than the randomization unit; cuped → CUPED variance reduction (needs a
 * pre-experiment covariate) then Welch. Each variant is compared against control,
 * and p-values are corrected across the variant family. Pure stats, no warehouse.
 */
export function abTest(input) {
  const { metric, control } = input;
  const confidence = input.confidence ?? 0.95;
  const alternative = input.alternative || 'two_sided';
  const correction = input.correction || 'holm';
  const labelOf = (g, i) => g.label || (i < 0 ? 'control' : `variant_${i + 1}`);
  const need = (g, fields) => { for (const f of fields) if (g[f] === undefined) throw new ToolError(`ab_test metric=${metric}: group '${g.label || '?'}' is missing '${f}'`, { stage: 'validate', field: f }); };

  // Cross-field guard the schema cannot express: for a proportion, a group's success
  // count cannot exceed its sample size (a rate > 100% is impossible). Reject it instead
  // of silently returning control_rate > 1 and a meaningless lift.
  if (metric === 'proportion') {
    for (const g of [control, ...(input.variants || [])]) {
      if (g && g.conversions != null && g.conversions > g.n) {
        throw new ToolError(`metric=proportion: conversions (${g.conversions}) cannot exceed n (${g.n}) for group '${g.label || '?'}' — a rate cannot exceed 100%`, { stage: 'validate', field: 'conversions' });
      }
    }
  }

  // the designed split, when given, is checked in the same call: control first, then the variants
  const groupsIn = [control, ...(input.variants || [])];
  if (input.expected_ratio && input.expected_ratio.length !== groupsIn.length) {
    throw new ToolError(`expected_ratio has ${input.expected_ratio.length} weights for ${groupsIn.length} groups (control first, then each variant)`, { stage: 'validate', field: 'expected_ratio' });
  }

  let results; const extra = {};
  if (metric === 'cuped') {
    const suff = ['sumY', 'sumY2', 'sumX', 'sumX2', 'sumXY'];
    need(control, suff); for (const v of input.variants) need(v, suff);
    const pick = (g, label) => ({ label, n: g.n, sumY: g.sumY, sumY2: g.sumY2, sumX: g.sumX, sumX2: g.sumX2, sumXY: g.sumXY });
    const groups = [pick(control, labelOf(control, -1)), ...input.variants.map((v, i) => pick(v, labelOf(v, i)))];
    const out = cupedTest({ groups, alternative, confidence });
    extra.theta = out.theta; results = out.results;
  } else if (metric === 'ratio') {
    const suff = ['sumNum', 'sumDen', 'sumNum2', 'sumDen2', 'sumNumDen'];
    need(control, suff); for (const v of input.variants) need(v, suff);
    results = input.variants.map((v, i) => ({ variant: labelOf(v, i), ...ratioDeltaTest({ control, variant: v, alternative, confidence }) }));
  } else {
    results = input.variants.map((v, i) => {
      let r; let delta; let variance;
      if (metric === 'proportion') {
        need(control, ['conversions']); need(v, ['conversions']);
        r = twoProportionZTest({ controlConversions: control.conversions, controlN: control.n, variantConversions: v.conversions, variantN: v.n, alternative, confidence });
        const p1 = control.conversions / control.n; const p2 = v.conversions / v.n;
        delta = p2 - p1; variance = p1 * (1 - p1) / control.n + p2 * (1 - p2) / v.n;
      } else {
        need(control, ['mean', 'stddev']); need(v, ['mean', 'stddev']);
        r = welchTTest({ controlMean: control.mean, controlStddev: control.stddev, controlN: control.n, variantMean: v.mean, variantStddev: v.stddev, variantN: v.n, alternative, confidence });
        delta = v.mean - control.mean; variance = (control.stddev ** 2) / control.n + (v.stddev ** 2) / v.n;
      }
      // the smallest effect this sample could detect (power 0.8 at the test's own α, the smaller
      // group's n) — what an inconclusive result could have seen, never a power computed from the
      // observed effect
      const nMin = Math.min(control.n, v.n);
      const alpha = 1 - confidence;
      const base = metric === 'proportion' ? control.conversions / control.n : control.mean;
      const detectable = metric === 'proportion'
        ? (base > 0 && base < 1 ? mdeProportion({ baseline: base, n: nMin, alpha, power: 0.8, alternative }) : null)
        : (control.stddev > 0 ? mdeMean({ stddev: control.stddev, n: nMin, alpha, power: 0.8, alternative }) : null);
      r = { ...r, detectable_lift: detectable, detectable_relative_lift: detectable !== null && base ? detectable / Math.abs(base) : null };
      // sequential: an ALWAYS-VALID p (mixture SPRT) that stays honest when the
      // experiment is checked repeatedly while running — use it for live peeking;
      // the fixed-horizon p remains the readout at the planned end.
      if (input.sequential) {
        const tau2 = input.expected_effect ? input.expected_effect ** 2 : undefined;
        const pSeq = alwaysValidP({ delta, variance, tau2 });
        r = { ...r, p_value_sequential: pSeq, significant_sequential: pSeq < 1 - confidence };
      }
      return { variant: labelOf(v, i), ...r };
    });
  }

  // Correct the p-values across the variant family (FWER via Holm, or FDR via BH)
  // so several arms don't inflate false positives; raw `significant` is kept too.
  // family_p_values: p-values of OTHER metrics in the same experiment readout —
  // included in the family so a 10-metric scorecard doesn't fish significance.
  const familyExtra = (input.family_p_values || []).filter((p) => Number.isFinite(p));
  if (correction !== 'none' && results.length > 0) {
    const adj = adjustPValues([...results.map((r) => r.p_value), ...familyExtra], correction);
    results = results.map((r, i) => ({ ...r, p_value_adjusted: adj[i], significant_adjusted: adj[i] < 1 - confidence }));
  }
  // How a significant change READS depends on the metric: a rise is an improvement only where up is
  // good (conversion), a regression where down is (crash rate) — the caller says which
  const good = input.good || 'up';
  results = results.map((r) => {
    const sig = !!(r.significant_adjusted ?? r.significant);
    const lift = r.absolute_lift ?? 0;
    return { ...r, outcome: !sig || lift === 0 ? 'no_difference' : (lift > 0) === (good === 'up') ? 'better' : 'worse' };
  });
  const worse = results.filter((r) => r.outcome === 'worse').map((r) => r.variant);
  const anySig = results.some((r) => (r.significant_adjusted ?? r.significant));
  const split = input.expected_ratio ? srmTest({ groups: groupsIn.map((g, i) => ({ label: labelOf(g, i - 1), n: g.n })), ratios: input.expected_ratio }) : null;
  const recommendations = [
    ...(split?.srm_detected ? [`Sample ratio mismatch (p = ${split.p_value.toExponential(2)}): the groups are not the split that was designed, so randomization or logging is broken and none of these lifts can be trusted until the cause is found.`] : []),
    `Trust significant_adjusted (multiplicity-corrected${familyExtra.length ? `, family includes ${familyExtra.length} other metric(s)` : ''}) over raw significant.`,
    ...(input.sequential ? ['p_value_sequential is valid under repeated peeking; the fixed-horizon p_value is only valid at the planned sample size.'] : ['Peeking at a RUNNING experiment with fixed-horizon p-values inflates false positives — pass sequential:true for an always-valid p.']),
    ...(worse.length ? [`${worse.join(', ')} ${worse.length === 1 ? 'is' : 'are'} significantly WORSE than control on this metric (${good === 'up' ? 'lower' : 'higher'} where ${good} is good) — a regression, not a win.`] : []),
    ...(anySig ? [] : ['No significant lift: that is inconclusive, not proof of no effect — detectable_lift says how large an effect this sample could have seen.']),
    ...(split ? [] : ['Pass expected_ratio (control first) to check the split in this same call — a sample ratio mismatch invalidates every lift.']),
  ];
  return { ok: true, metric, confidence, alternative, correction, good, control: labelOf(control, -1), ...extra, ...(split ? { split } : {}), results, recommendations };
}

/**
 * Sample Ratio Mismatch guardrail: χ² goodness-of-fit that the observed per-group
 * sizes match the intended split. A detected mismatch (p < 0.001) invalidates the
 * experiment regardless of any lift. Compute per-group n with a pipeline first.
 */
export function srmCheck(input) {
  return { ok: true, ...srmTest({ groups: input.groups, ratios: input.expected_ratio }) };
}

/**
 * Power / sample-size planning (no warehouse). Given a baseline (proportion) or
 * stddev (mean) plus a target effect, returns the required sample size PER GROUP;
 * given a sample size, returns the minimum detectable effect (MDE). Use it to size
 * a test up front and to tell "no effect" apart from "underpowered".
 */
export function sampleSize(input) {
  const { metric } = input;
  const confidence = input.confidence ?? 0.95;
  const power = input.power ?? 0.8;
  const alternative = input.alternative || 'two_sided';
  const common = { alpha: 1 - confidence, power, alternative };
  const base = { ok: true, metric, power, confidence, alternative };
  if (metric === 'proportion') {
    const { baseline } = input;
    if (baseline === undefined) throw new ToolError('sample_size metric=proportion requires baseline', { stage: 'validate', field: 'baseline' });
    if (input.n !== undefined) { const mde = mdeProportion({ baseline, n: input.n, ...common }); return { ...base, n_per_group: input.n, baseline, mde, relative_mde: mde / baseline }; }
    if (input.mde !== undefined) { const n = sampleSizeProportion({ baseline, mde: input.mde, ...common }); return { ...base, n_per_group: n, total_n: 2 * n, baseline, mde: input.mde, relative_mde: input.mde / baseline }; }
    throw new ToolError('sample_size requires either mde (→ solve n) or n (→ solve MDE)', { stage: 'validate', field: 'mde' });
  }
  const { stddev } = input;
  if (stddev === undefined) throw new ToolError('sample_size metric=mean requires stddev', { stage: 'validate', field: 'stddev' });
  if (input.n !== undefined) { const mde = mdeMean({ stddev, n: input.n, ...common }); return { ...base, n_per_group: input.n, stddev, mde }; }
  if (input.mde !== undefined) { const n = sampleSizeMean({ stddev, mde: input.mde, ...common }); return { ...base, n_per_group: n, total_n: 2 * n, stddev, mde: input.mde }; }
  throw new ToolError('sample_size requires either mde (→ solve n) or n (→ solve MDE)', { stage: 'validate', field: 'mde' });
}
