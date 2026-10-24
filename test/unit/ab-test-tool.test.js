import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.js';
import { ContextManager } from '../../src/context-manager.js';
import { Engine } from '../../src/engine.js';
import { settle } from '../helpers/settle.js';
import { tempDir } from '../helpers/temp-dir.js';

const catalog = loadCatalog(new URL('../../config/catalog.yml', import.meta.url).pathname, { dialect: 'duckdb' });
const engine = settle(new Engine({ catalog, contextManager: new ContextManager({ workspaceRoot: tempDir('ab') }) }));

test('experiments role is a joinable model with its dimensions + time columns', () => {
  assert.ok(catalog.modelKeys().includes('experiments'), 'experiments is joinable');
  const dims = catalog.modelDimensionColumns('experiments');
  for (const c of ['experiment_name', 'variant_group', 'assigned_at', 'ended_at']) assert.ok(dims.includes(c), `dim ${c}`);
  assert.ok(catalog.facts.includes('events')); // unchanged: events is still an events source
});

test('experiment analyze, proportion: control vs two variants, per-variant verdicts', () => {
  const r = engine._analyzeExperiment({
    metric: 'proportion',
    control: { label: 'control', n: 1000, conversions: 200 },
    variants: [
      { label: 'B', n: 1000, conversions: 250 }, // clearly up
      { label: 'C', n: 1000, conversions: 205 }, // ~flat
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.control, 'control');
  assert.equal(r.results.length, 2);
  const b = r.results.find((x) => x.variant === 'B');
  assert.ok(Math.abs(b.relative_lift - 0.25) < 1e-9);
  assert.equal(b.significant, true);
  const c = r.results.find((x) => x.variant === 'C');
  assert.equal(c.significant, false);
});

// the z-test's normal approximation needs both outcomes in every group: a group with fewer than ten
// conversions or ten non-conversions is flagged, its interval kept within a difference of rates can take,
// and the recommendation says first that the sample is too small to read
test('experiment analyze, proportion: a group too small for the normal approximation is flagged first', () => {
  const r = engine._analyzeExperiment({ metric: 'proportion', control: { label: 'control', n: 6, conversions: 6 }, variants: [{ label: 'B', n: 6, conversions: 1 }] });
  const [b] = r.results;
  assert.equal(b.small_sample, true);
  assert.ok(b.confidence_interval[0] >= -1 && b.confidence_interval[1] <= 1, JSON.stringify(b.confidence_interval));
  assert.match(r.recommendations[0], /^Too few users to read B/);
  const big = engine._analyzeExperiment({ metric: 'proportion', control: { label: 'control', n: 1000, conversions: 200 }, variants: [{ label: 'B', n: 1000, conversions: 250 }] });
  assert.equal(big.results[0].small_sample, undefined);
});

// a test of means reads each group's spread from its sample: one user, or no spread in either group, is
// no test at all (refused), and a group under ~30 users is flagged; a verdict on a flagged comparison is
// not stated as a regression — the small-sample warning speaks for it
test('experiment analyze, mean: one user or no spread is refused, a small group flagged, its verdict not stated', () => {
  const mean = (c, v) => engine._analyzeExperiment({ metric: 'mean', control: { label: 'control', ...c }, variants: [{ label: 'B', ...v }] });
  assert.throws(() => mean({ n: 1, mean: 5, stddev: 0 }, { n: 1, mean: 7, stddev: 0 }), /group 'control' has 1 user\(s\): a test of means needs at least 2 in each group/);
  assert.throws(() => mean({ n: 3, mean: 5, stddev: 0 }, { n: 3, mean: 7, stddev: 0 }), /'control' and 'B' both have stddev 0/);
  const thin = mean({ n: 12, mean: 5, stddev: 1 }, { n: 12, mean: 3, stddev: 1 });
  assert.equal(thin.results[0].small_sample, true);
  assert.match(thin.recommendations[0], /^Too few users to read B: a test of means needs about 30 users in each group/);
  assert.ok(!thin.recommendations.some((r) => /significantly WORSE/.test(r)), JSON.stringify(thin.recommendations));
  assert.equal(mean({ n: 500, mean: 5, stddev: 1 }, { n: 500, mean: 3, stddev: 1 }).results[0].small_sample, undefined);
  // a group named by its place when it carries no label
  assert.throws(() => engine._analyzeExperiment({ metric: 'proportion', control: { n: 3, conversions: 1 }, variants: [{ n: 3, conversions: 5 }] }), /for group 'variant_1'/);
});

test('experiment analyze, mean: Welch t-test path', () => {
  const r = engine._analyzeExperiment({
    metric: 'mean',
    control: { n: 500, mean: 10, stddev: 2 },
    variants: [{ label: 'B', n: 500, mean: 12, stddev: 2 }],
  });
  assert.equal(r.results[0].significant, true);
  assert.ok('t' in r.results[0] && 'df' in r.results[0]);
});

test('experiment analyze, mean from sums: the same test as from the mean and stddev those sums give', () => {
  // control values 1..5 (mean 3, sample sd √2.5), B values 3..7 (mean 5, the same sd)
  const sums = (xs) => ({ n: xs.length, sum: xs.reduce((a, x) => a + x, 0), sum_squares: xs.reduce((a, x) => a + x * x, 0) });
  const fromSums = engine._analyzeExperiment({ metric: 'mean', control: sums([1, 2, 3, 4, 5]), variants: [{ label: 'B', ...sums([3, 4, 5, 6, 7]) }] });
  const fromMoments = engine._analyzeExperiment({ metric: 'mean', control: { n: 5, mean: 3, stddev: Math.sqrt(2.5) }, variants: [{ label: 'B', n: 5, mean: 5, stddev: Math.sqrt(2.5) }] });
  assert.equal(fromSums.ok, true);
  for (const k of ['t', 'df', 'p_value', 'relative_lift']) assert.ok(Math.abs(fromSums.results[0][k] - fromMoments.results[0][k]) < 1e-9, k);
  // one group alone has no spread to read from its sums
  assert.throws(() => engine._analyzeExperiment({ metric: 'mean', control: { n: 1, sum: 3, sum_squares: 9 }, variants: [{ label: 'B', ...sums([3, 4]) }] }));
});

test('experiment analyze, ratio: delta-method path over per-user sums', () => {
  const r = engine._analyzeExperiment({
    metric: 'ratio',
    control: { label: 'control', n: 5, numerator: { sum: 15, sum_squares: 55 }, denominator: { sum: 5, sum_squares: 5 }, sum_products: 15 },
    variants: [{ label: 'B', n: 5, numerator: { sum: 20, sum_squares: 90 }, denominator: { sum: 5, sum_squares: 5 }, sum_products: 20 }],
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.results[0].control_ratio - 3) < 1e-9 && Math.abs(r.results[0].variant_ratio - 4) < 1e-9);
});

test('experiment analyze, ratio: the numerator, the denominator and their products reach the delta method as given', () => {
  // per-user (num, den): control (1,1) (2,2) (6,2) — ratio 9/5; B (2,1) (2,1) (2,2) — ratio 6/4
  const sums = (pairs) => ({
    n: pairs.length,
    numerator: { sum: pairs.reduce((a, [x]) => a + x, 0), sum_squares: pairs.reduce((a, [x]) => a + x * x, 0) },
    denominator: { sum: pairs.reduce((a, [, y]) => a + y, 0), sum_squares: pairs.reduce((a, [, y]) => a + y * y, 0) },
    sum_products: pairs.reduce((a, [x, y]) => a + x * y, 0),
  });
  const r = engine._analyzeExperiment({ metric: 'ratio', control: sums([[1, 1], [2, 2], [6, 2]]), variants: [{ label: 'B', ...sums([[2, 1], [2, 1], [2, 2]]) }] });
  const v = r.results[0];
  assert.ok(Math.abs(v.control_ratio - 9 / 5) < 1e-12 && Math.abs(v.variant_ratio - 6 / 4) < 1e-12);
  // the delta-method variance of one group's ratio: (varY − 2R·cov + R²·varX) / (mX²·n), population moments
  const varR = (pairs) => {
    const n = pairs.length; const mY = pairs.reduce((a, [x]) => a + x, 0) / n; const mX = pairs.reduce((a, [, y]) => a + y, 0) / n;
    const varY = pairs.reduce((a, [x]) => a + x * x, 0) / n - mY * mY; const varX = pairs.reduce((a, [, y]) => a + y * y, 0) / n - mX * mX;
    const cov = pairs.reduce((a, [x, y]) => a + x * y, 0) / n - mY * mX; const R = mY / mX;
    return (varY - 2 * R * cov + R * R * varX) / (mX * mX * n);
  };
  const z = (6 / 4 - 9 / 5) / Math.sqrt(varR([[1, 1], [2, 2], [6, 2]]) + varR([[2, 1], [2, 1], [2, 2]]));
  assert.ok(Math.abs(v.z - z) < 1e-9, `z ${v.z} vs ${z}`);
});

test('experiment analyze, cuped: the in-experiment sums, the covariate and their products reach the adjustment as given', () => {
  // per-user (y, x): control (3,1) (5,2) (7,3) (9,5); B (6,1) (7,2) (11,3) (12,5) — y tracks x, so θ > 0 removes variance
  const sums = (pairs) => ({
    n: pairs.length,
    sum: pairs.reduce((a, [y]) => a + y, 0), sum_squares: pairs.reduce((a, [y]) => a + y * y, 0),
    covariate: { sum: pairs.reduce((a, [, x]) => a + x, 0), sum_squares: pairs.reduce((a, [, x]) => a + x * x, 0) },
    sum_products: pairs.reduce((a, [y, x]) => a + y * x, 0),
  });
  const control = [[3, 1], [5, 2], [7, 3], [9, 5]]; const b = [[6, 1], [7, 2], [11, 3], [12, 5]];
  const r = engine._analyzeExperiment({ metric: 'cuped', control: { label: 'control', ...sums(control) }, variants: [{ label: 'B', ...sums(b) }] });
  assert.equal(r.ok, true);
  // θ pooled over both groups = cov(Y, X) / var(X), from the per-user values themselves
  const all = [...control, ...b]; const n = all.length;
  const mY = all.reduce((a, [y]) => a + y, 0) / n; const mX = all.reduce((a, [, x]) => a + x, 0) / n;
  const theta = all.reduce((a, [y, x]) => a + (y - mY) * (x - mX), 0) / all.reduce((a, [, x]) => a + (x - mX) ** 2, 0);
  assert.ok(Math.abs(r.theta - theta) < 1e-9, `theta ${r.theta} vs ${theta}`);
  assert.ok(r.results[0].variance_reduction > 0, 'a covariate that tracks the metric removes variance');
});

test('experiment analyze, correction: adjusted p-values across the variant family', () => {
  const r = engine._analyzeExperiment({
    metric: 'proportion',
    correction: 'holm',
    control: { n: 1000, conversions: 200 },
    variants: [{ label: 'B', n: 1000, conversions: 250 }, { label: 'C', n: 1000, conversions: 205 }],
  });
  assert.equal(r.correction, 'holm');
  for (const v of r.results) assert.ok('p_value_adjusted' in v && v.p_value_adjusted >= v.p_value);
});

// ── structural schema guards: each metric config rejects fields it does not use ──
test('experiment analyze contract: missing conversions for proportion is rejected', () => {
  assert.throws(() => engine._analyzeExperiment({ metric: 'proportion', control: { n: 100 }, variants: [{ n: 100 }] }), /invalid input/);
});

test('experiment analyze contract: a proportion arm cannot carry a mean field', () => {
  assert.throws(() => engine._analyzeExperiment({ metric: 'proportion', control: { n: 100, conversions: 10, mean: 1 }, variants: [{ n: 100, conversions: 12 }] }), /invalid input/);
});

test('experiment analyze contract: mean requires both mean and stddev', () => {
  assert.throws(() => engine._analyzeExperiment({ metric: 'mean', control: { n: 100, mean: 1 }, variants: [{ n: 100, mean: 2 }] }), /invalid input/);
});

test('experiment analyze contract: ratio requires the numerator, the denominator (positive) and their products', () => {
  const ok = { n: 5, numerator: { sum: 1, sum_squares: 1 }, denominator: { sum: 1, sum_squares: 1 }, sum_products: 1 };
  assert.throws(() => engine._analyzeExperiment({ metric: 'ratio', control: { n: 5, numerator: { sum: 1, sum_squares: 1 }, denominator: { sum: 1, sum_squares: 1 } }, variants: [ok] }), /invalid input/);
  assert.throws(() => engine._analyzeExperiment({ metric: 'ratio', control: { ...ok, denominator: { sum: 0, sum_squares: 1 } }, variants: [ok] }), /invalid input/);
  assert.throws(() => engine._analyzeExperiment({ metric: 'ratio', control: { ...ok, numerator: { sum: 1 } }, variants: [ok] }), /invalid input/);
  // the earlier camelCase sums are no spelling of this tool
  assert.throws(() => engine._analyzeExperiment({ metric: 'ratio', control: { n: 5, sumNum: 1, sumDen: 1, sumNum2: 1, sumDen2: 1, sumNumDen: 1 }, variants: [ok] }), /invalid input/);
});

test('experiment analyze contract: a cuped arm cannot carry conversions; unknown metric is rejected', () => {
  const ok = { n: 5, sum: 1, sum_squares: 1, covariate: { sum: 1, sum_squares: 1 }, sum_products: 1 };
  assert.throws(() => engine._analyzeExperiment({ metric: 'cuped', control: { ...ok, conversions: 3 }, variants: [ok] }), /invalid input/);
  assert.throws(() => engine._analyzeExperiment({ metric: 'cuped', control: { n: 5, sumY: 1, sumY2: 1, sumX: 1, sumX2: 1, sumXY: 1 }, variants: [ok] }), /invalid input/);
  assert.throws(() => engine._analyzeExperiment({ metric: 'bogus', control: { n: 5, conversions: 1 }, variants: [{ n: 5, conversions: 1 }] }), /invalid input/);
});

test('experiment plan contract: needs exactly one of mde/n and the metric-matched dispersion field', () => {
  assert.equal(engine._planExperiment({ metric: 'proportion', baseline: 0.2, mde: 0.05 }).ok, true);
  assert.equal(engine._planExperiment({ metric: 'mean', stddev: 5, n: 400 }).ok, true);
  assert.throws(() => engine._planExperiment({ metric: 'proportion', baseline: 0.2, mde: 0.05, n: 400 }), /invalid input/); // both
  assert.throws(() => engine._planExperiment({ metric: 'proportion', baseline: 0.2 }), /invalid input/); // neither
  assert.throws(() => engine._planExperiment({ metric: 'proportion', stddev: 5, mde: 0.05 }), /invalid input/); // wrong dispersion field
  assert.throws(() => engine._planExperiment({ metric: 'mean', mde: 1 }), /invalid input/); // missing stddev
});

test('experiment check_split: detects a broken split, passes a balanced one', () => {
  assert.equal(engine._checkSplit({ groups: [{ label: 'a', n: 500 }, { label: 'b', n: 500 }] }).srm_detected, false);
  assert.equal(engine._checkSplit({ groups: [{ label: 'a', n: 600 }, { label: 'b', n: 400 }] }).srm_detected, true);
});

// Sequential (mSPRT) always-valid p: monotone in evidence, conservative vs fixed-horizon,
// and exactly 1 when there is no effect signal.
test('experiment analyze, sequential: always-valid p is conservative and ordered by evidence', () => {
  const strong = engine._analyzeExperiment({
    metric: 'proportion', sequential: true,
    control: { n: 10000, conversions: 2000 },
    variants: [{ label: 'B', n: 10000, conversions: 2400 }], // big, well-powered lift
  });
  const b = strong.results[0];
  assert.ok(b.p_value_sequential > 0 && b.p_value_sequential <= 1);
  assert.ok(b.p_value_sequential >= b.p_value, 'always-valid p is never smaller than the fixed-horizon p');
  assert.equal(b.significant_sequential, true, 'a strong effect is detected even sequentially');

  const flat = engine._analyzeExperiment({
    metric: 'proportion', sequential: true,
    control: { n: 1000, conversions: 200 },
    variants: [{ label: 'B', n: 1000, conversions: 200 }], // identical groups
  });
  assert.equal(flat.results[0].p_value_sequential, 1, 'no signal → p stays at 1');
  // a weaker (but real) lift yields a LARGER sequential p than the strong one.
  const weak = engine._analyzeExperiment({
    metric: 'proportion', sequential: true,
    control: { n: 1000, conversions: 200 },
    variants: [{ label: 'B', n: 1000, conversions: 220 }],
  });
  assert.ok(weak.results[0].p_value_sequential > b.p_value_sequential);
  // mean path also carries the sequential fields.
  const m = engine._analyzeExperiment({
    metric: 'mean', sequential: true, expected_effect: 0.5,
    control: { n: 500, mean: 10, stddev: 3 },
    variants: [{ label: 'B', n: 500, mean: 10.6, stddev: 3 }],
  });
  assert.ok(Number.isFinite(m.results[0].p_value_sequential));
});

// Cross-metric multiplicity: other metrics' p-values join the Holm family and can
// flip a borderline variant to non-significant.
test('experiment analyze, family_p_values: cross-metric correction tightens the verdict', () => {
  const base = engine._analyzeExperiment({
    metric: 'proportion',
    control: { n: 1000, conversions: 200 },
    variants: [{ label: 'B', n: 1000, conversions: 245 }], // borderline-significant alone
  });
  const alone = base.results[0];
  assert.equal(alone.significant_adjusted, true, 'significant when tested alone');
  const withFamily = engine._analyzeExperiment({
    metric: 'proportion',
    family_p_values: [0.2, 0.4, 0.6, 0.8], // four other metrics in the same readout
    control: { n: 1000, conversions: 200 },
    variants: [{ label: 'B', n: 1000, conversions: 245 }],
  });
  const fam = withFamily.results[0];
  assert.ok(fam.p_value_adjusted > alone.p_value_adjusted, 'family inflates the adjusted p');
  assert.equal(fam.p_value, alone.p_value, 'raw p unchanged');
});

test('analyze with expected_ratio carries its own split check; without it, none is assumed', async () => {
  const skewed = await engine.experiment({ action: 'analyze', metric: 'proportion', expected_ratio: [1, 1], control: { label: 'c', n: 10000, conversions: 1000 }, variants: [{ label: 'b', n: 10600, conversions: 1170 }] });
  // χ² = 2·300²/10300 on 1 df
  assert.ok(Math.abs(skewed.split.chi_square - 2 * 300 ** 2 / 10300) < 1e-9);
  assert.ok(skewed.split.p_value < 0.001 && skewed.split.srm_detected === true);
  assert.deepEqual(skewed.split.groups.map((g) => g.expected), [10300, 10300]);
  const planned = await engine.experiment({ action: 'analyze', metric: 'proportion', expected_ratio: [2, 1], control: { n: 2000, conversions: 200 }, variants: [{ label: 'b', n: 1000, conversions: 110 }] });
  assert.equal(planned.split.chi_square, 0, 'a 2:1 design observed at 2:1 is no mismatch');
  assert.equal(planned.split.srm_detected, false);
  const none = await engine.experiment({ action: 'analyze', metric: 'proportion', control: { n: 2000, conversions: 200 }, variants: [{ label: 'b', n: 1000, conversions: 110 }] });
  assert.equal(none.split, undefined, 'no designed split given, none is guessed');
  await assert.rejects(async () => engine.experiment({ action: 'analyze', metric: 'proportion', expected_ratio: [1, 1, 1], control: { n: 10, conversions: 1 }, variants: [{ n: 10, conversions: 2 }] }), (e) => e.field === 'expected_ratio');
});

test('each variant carries the smallest effect its sample could detect (power 0.8, the test\'s α; a rate at the smaller group, a mean at both groups\' spreads)', async () => {
  const { sampleSizeProportion, normalQuantile } = await import('../../src/stats.js');
  const p = engine._analyzeExperiment({ metric: 'proportion', control: { n: 10000, conversions: 1000 }, variants: [{ label: 'b', n: 12000, conversions: 1250 }] }).results[0];
  // the detectable lift is the one the plan would need this n for (to the user, the plan rounds up)
  assert.ok(Math.abs(sampleSizeProportion({ baseline: 0.1, mde: p.detectable_lift }) - 10000) <= 1);
  assert.ok(Math.abs(p.detectable_relative_lift - p.detectable_lift / 0.1) < 1e-12);
  const m = engine._analyzeExperiment({ metric: 'mean', confidence: 0.9, control: { n: 500, mean: 10, stddev: 2 }, variants: [{ label: 'b', n: 800, mean: 10.1, stddev: 2.5 }] }).results[0];
  // a test of means reads each group's spread over its own n (Welch's), and so does the effect it can see
  const expected = (normalQuantile(0.95) + normalQuantile(0.8)) * Math.sqrt(2 ** 2 / 500 + 2.5 ** 2 / 800);
  assert.ok(Math.abs(m.detectable_lift - expected) < 1e-12, `${m.detectable_lift} vs ${expected}`);
  assert.ok(Math.abs(m.detectable_relative_lift - expected / 10) < 1e-12);
});

test('the A/B card reads the split check and the detectable effect in the unit its interval is drawn in', async () => {
  const { buildViewModel } = await import('../../src/apps/result-view-model.js');
  const args = { action: 'analyze', metric: 'proportion', expected_ratio: [1, 1], control: { n: 10000, conversions: 1000 }, variants: [{ label: 'b', n: 10600, conversions: 1030 }] };
  const r = await engine.experiment(args);
  // the input as the card has it: what the host sends as the call's arguments, the envelope unwrapped
  const { toolInputOf } = await import('../../src/apps/shared/host.js');
  const m = buildViewModel('experiment', r, toolInputOf({ arguments: { request: args } }));
  assert.equal(m.variants[0].n_control, 10000, 'the group sizes reach the card');
  assert.equal(m.variants[0].n_variant, 10600);
  assert.equal(m.split.detected, true);
  assert.equal(m.split.p_value, r.split.p_value);
  const v = m.variants[0];
  assert.equal(v.effect.unit, 'relative');
  assert.equal(v.detectable, r.results[0].detectable_relative_lift);
  assert.equal(v.significant, false);
});

// a ratio's delta method reads its sums as normal too: a group under ~30 users is flagged as a mean's
// is, and a recommendation names detectable_lift only where a result carries one (a ratio's does not)
test('experiment analyze, ratio: a small group is flagged; detectable_lift is named only where it is computed', () => {
  const group = (n, num, den) => ({ n, numerator: { sum: num * n, sum_squares: num * num * n * 1.5 }, denominator: { sum: den * n, sum_squares: den * den * n * 1.2 }, sum_products: num * den * n * 1.1 });
  const thin = engine._analyzeExperiment({ metric: 'ratio', control: { label: 'control', ...group(12, 2, 1) }, variants: [{ label: 'B', ...group(12, 2.05, 1) }] });
  assert.equal(thin.results[0].small_sample, true);
  assert.match(thin.recommendations[0], /^Too few users to read B: the delta method needs about 30 users in each group/);
  assert.equal(thin.results[0].detectable_lift, undefined);
  assert.ok(thin.recommendations.some((r) => /^No significant lift/.test(r)) && !thin.recommendations.some((r) => /detectable_lift/.test(r)), JSON.stringify(thin.recommendations));
  assert.equal(engine._analyzeExperiment({ metric: 'ratio', control: group(500, 2, 1), variants: [{ label: 'B', ...group(500, 2.01, 1) }] }).results[0].small_sample, undefined);
});

// a control that always converts has no spread to log: its relative lift is its absolute one (p1 = 1),
// and so is the relative interval — both inside what a difference of rates can take, [−1, 0] there
test('experiment analyze, proportion: a control converting every user gives one interval for both lifts', () => {
  const [b] = engine._analyzeExperiment({ metric: 'proportion', control: { label: 'control', n: 20, conversions: 20 }, variants: [{ label: 'B', n: 22, conversions: 5 }] }).results;
  assert.deepEqual(b.relative_lift_ci, b.confidence_interval);
  assert.equal(b.relative_lift, b.absolute_lift);
  assert.ok(b.confidence_interval[0] >= -1 && b.confidence_interval[1] <= 0, JSON.stringify(b.confidence_interval));
});
