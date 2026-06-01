import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalCdf, normalQuantile, tCdf, twoProportionZTest, welchTTest } from '../../src/stats.js';

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

test('one-sided alternative halves the two-sided p (greater)', () => {
  const two = twoProportionZTest({ controlConversions: 200, controlN: 1000, variantConversions: 250, variantN: 1000, alternative: 'two_sided' });
  const one = twoProportionZTest({ controlConversions: 200, controlN: 1000, variantConversions: 250, variantN: 1000, alternative: 'greater' });
  close(one.p_value, two.p_value / 2, 1e-6);
});
