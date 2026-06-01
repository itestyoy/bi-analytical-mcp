import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalCdf, normalQuantile, tCdf, chiSquareCdf, twoProportionZTest, welchTTest, cupedTest, srmTest, sampleSizeProportion, mdeProportion, sampleSizeMean, mdeMean, adjustPValues, ratioDeltaTest } from '../../src/stats.js';

// per-group sufficient statistics from explicit per-user (Y, X) pairs
function suff(ys, xs, label) {
  let sumY = 0; let sumY2 = 0; let sumX = 0; let sumX2 = 0; let sumXY = 0;
  for (let i = 0; i < ys.length; i++) { sumY += ys[i]; sumY2 += ys[i] * ys[i]; sumX += xs[i]; sumX2 += xs[i] * xs[i]; sumXY += xs[i] * ys[i]; }
  return { label, n: ys.length, sumY, sumY2, sumX, sumX2, sumXY };
}

const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

test('distribution helpers match known values', () => {
  close(normalCdf(0), 0.5);
  close(normalCdf(1.959964), 0.975, 1e-4);
  close(normalQuantile(0.975), 1.959964, 1e-4);
  close(tCdf(0, 10), 0.5);
  close(tCdf(2.228, 10), 0.975, 2e-3); // t_{0.975, 10} ≈ 2.228
});

test('two-proportion z-test: 0.20 vs 0.25 (n=1000 each) is significant', () => {
  const r = twoProportionZTest({ controlConversions: 200, controlN: 1000, variantConversions: 250, variantN: 1000 });
  close(r.control_rate, 0.20); close(r.variant_rate, 0.25);
  close(r.absolute_lift, 0.05); close(r.relative_lift, 0.25);
  close(r.z, 2.6773, 1e-3);
  close(r.p_value, 0.00742, 1e-3);
  assert.equal(r.significant, true);
  assert.equal(r.confidence_interval.length, 2);
  assert.ok(r.confidence_interval[0] > 0); // CI excludes 0 → significant
});

test('two-proportion z-test: equal rates → not significant, p≈1', () => {
  const r = twoProportionZTest({ controlConversions: 100, controlN: 1000, variantConversions: 100, variantN: 1000 });
  close(r.z, 0); close(r.p_value, 1, 1e-5);
  assert.equal(r.significant, false);
});

test("Welch t-test: means 10 vs 11 (sd 5, n=100) not significant at 0.05", () => {
  const r = welchTTest({ controlMean: 10, controlStddev: 5, controlN: 100, variantMean: 11, variantStddev: 5, variantN: 100 });
  close(r.t, 1.41421, 1e-3);
  close(r.df, 198, 1);
  close(r.p_value, 0.1587, 3e-3);
  assert.equal(r.significant, false);
});

test('Welch t-test: a large, clear difference is significant with CI excluding 0', () => {
  const r = welchTTest({ controlMean: 10, controlStddev: 2, controlN: 500, variantMean: 12, variantStddev: 2, variantN: 500 });
  assert.ok(r.p_value < 1e-6);
  assert.equal(r.significant, true);
  assert.ok(r.confidence_interval[0] > 0 && r.confidence_interval[1] > 0);
  close(r.relative_lift, 0.2);
});

test('CUPED: a strongly correlated pre-covariate removes variance and gains power', () => {
  // control Y = X (treatment 0); variant Y = X + 1 (treatment +1). Pre-covariate X
  // explains all the spread → CUPED collapses within-group variance → clear signal.
  const control = suff([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 'control');
  const variant = suff([2, 3, 4, 5, 6], [1, 2, 3, 4, 5], 'B');
  const r = cupedTest({ groups: [control, variant] });
  close(r.theta, 1, 1e-6);                       // θ = Cov(Y,X)/Var(X) = 1
  const res = r.results[0];
  assert.ok(res.variance_reduction > 0.99, `variance_reduction=${res.variance_reduction}`);
  assert.equal(res.significant, true);
  // plain Welch on the same (unadjusted) Y is NOT significant — CUPED added power
  const plain = welchTTest({ controlMean: 3, controlStddev: Math.sqrt(2.5), controlN: 5, variantMean: 4, variantStddev: Math.sqrt(2.5), variantN: 5 });
  assert.equal(plain.significant, false);
  assert.ok(res.p_value < plain.p_value);
});

test('CUPED with no pre-covariate signal (constant X) reduces to a plain t-test', () => {
  const control = suff([1, 2, 3, 4, 5], [7, 7, 7, 7, 7], 'control');
  const variant = suff([2, 3, 4, 5, 6], [7, 7, 7, 7, 7], 'B');
  const r = cupedTest({ groups: [control, variant] });
  close(r.theta, 0, 1e-9);                       // Var(X)=0 → θ=0
  const plain = welchTTest({ controlMean: 3, controlStddev: Math.sqrt(2.5), controlN: 5, variantMean: 4, variantStddev: Math.sqrt(2.5), variantN: 5 });
  close(r.results[0].p_value, plain.p_value, 1e-9); // identical to plain t-test
});

test('one-sided alternative halves the two-sided p (greater)', () => {
  const two = twoProportionZTest({ controlConversions: 200, controlN: 1000, variantConversions: 250, variantN: 1000, alternative: 'two_sided' });
  const one = twoProportionZTest({ controlConversions: 200, controlN: 1000, variantConversions: 250, variantN: 1000, alternative: 'greater' });
  close(one.p_value, two.p_value / 2, 1e-6);
});

test('relative-lift CI is reported and excludes 0 for a clear effect', () => {
  const p = twoProportionZTest({ controlConversions: 200, controlN: 1000, variantConversions: 250, variantN: 1000 });
  assert.equal(p.relative_lift_ci.length, 2);
  assert.ok(p.relative_lift_ci[0] > 0 && p.relative_lift_ci[1] > 0); // +25% relative, CI excludes 0
  assert.ok(p.relative_lift_ci[0] < p.relative_lift && p.relative_lift < p.relative_lift_ci[1]);
  const m = welchTTest({ controlMean: 10, controlStddev: 2, controlN: 500, variantMean: 12, variantStddev: 2, variantN: 500 });
  assert.equal(m.relative_lift_ci.length, 2);
  assert.ok(m.relative_lift_ci[0] > 0 && m.relative_lift_ci[1] > 0);
});

test('chi-square CDF matches known critical values', () => {
  close(chiSquareCdf(0, 1), 0);
  close(chiSquareCdf(3.841459, 1), 0.95, 1e-4); // χ²_{0.95,1}
  close(chiSquareCdf(5.991465, 2), 0.95, 1e-4); // χ²_{0.95,2}
});

test('SRM: a balanced split passes; a broken split is detected', () => {
  const ok = srmTest({ groups: [{ label: 'a', n: 500 }, { label: 'b', n: 500 }] });
  close(ok.chi_square, 0); close(ok.p_value, 1); assert.equal(ok.srm_detected, false);
  const broken = srmTest({ groups: [{ label: 'a', n: 600 }, { label: 'b', n: 400 }] });
  close(broken.chi_square, 40); // (100²/500)·2
  assert.ok(broken.p_value < 0.001); assert.equal(broken.srm_detected, true);
  // a 70/30 split is fine when that is the INTENDED ratio
  const weighted = srmTest({ groups: [{ n: 700 }, { n: 300 }], ratios: [7, 3] });
  close(weighted.chi_square, 0); assert.equal(weighted.srm_detected, false);
});

test('power: sample size and MDE are mutually consistent (proportion)', () => {
  const n = sampleSizeProportion({ baseline: 0.2, mde: 0.05 });
  assert.ok(n > 1050 && n < 1150, `n=${n}`); // ~1094 per group at 80% power, 5% two-sided
  const mde = mdeProportion({ baseline: 0.2, n });
  close(mde, 0.05, 2e-3); // inverse round-trips to the same MDE
  assert.ok(mdeProportion({ baseline: 0.2, n: 4 * n }) < mde); // 4× the users → smaller detectable effect
});

test('power: sample size and MDE are mutually consistent (mean)', () => {
  const n = sampleSizeMean({ stddev: 5, mde: 1 });
  assert.ok(n > 380 && n < 405, `n=${n}`); // ~393 per group
  close(mdeMean({ stddev: 5, n }), 1, 1e-2);
});

test('multiple-comparison correction: Holm and Benjamini-Hochberg', () => {
  const p = [0.01, 0.04, 0.03];
  const holm = adjustPValues(p, 'holm');
  close(holm[0], 0.03); close(holm[1], 0.06); close(holm[2], 0.06);
  const bh = adjustPValues(p, 'bh');
  close(bh[0], 0.03); close(bh[1], 0.04); close(bh[2], 0.04);
  for (let i = 0; i < p.length; i++) assert.ok(holm[i] >= bh[i]); // Holm (FWER) ≥ BH (FDR)
});

test('ratio delta method: with a constant denominator it reduces to a z-test on the numerator mean', () => {
  // den ≡ 1 for every user ⇒ ratio = mean(Y), Var(ratio) = Var(Y)/n (no denominator spread)
  const control = { n: 5, sumNum: 15, sumDen: 5, sumNum2: 55, sumDen2: 5, sumNumDen: 15 }; // Y = 1..5
  const variant = { n: 5, sumNum: 20, sumDen: 5, sumNum2: 90, sumDen2: 5, sumNumDen: 20 }; // Y = 2..6
  const r = ratioDeltaTest({ control, variant });
  close(r.control_ratio, 3); close(r.variant_ratio, 4); close(r.absolute_lift, 1);
  close(r.z, 1.1180, 1e-3); // diff 1 / sqrt(0.4 + 0.4)
  assert.equal(r.significant, false);
  assert.ok(Number.isFinite(r.p_value) && r.p_value > 0 && r.p_value < 1);
});
