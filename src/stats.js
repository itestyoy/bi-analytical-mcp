// Minimal statistics for A/B testing — pure JS, no dependencies. The AI computes
// per-group aggregates via the pipeline (n, conversions, or mean+stddev) and calls
// the ab_test tool, which runs the appropriate test here on the numbers.

// ── distribution helpers ─────────────────────────────────────────────────────

/** Error function (Abramowitz & Stegun 7.1.26), ~1e-7 accurate. */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

/** Standard normal CDF. */
export function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q; let r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** log Γ(x) (Lanczos). */
function logGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let xx = x; let tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++xx;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a, b, x) {
  const EPS = 3e-12; const FPMIN = 1e-300;
  let qab = a + b; let qap = a + 1; let qam = a - 1;
  let c = 1; let d = 1 - qab * x / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function ibeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Student's t CDF. */
export function tCdf(t, df) {
  const x = df / (df + t * t);
  const ib = 0.5 * ibeta(x, df / 2, 0.5);
  return t > 0 ? 1 - ib : ib;
}

/** Lower regularized incomplete gamma P(a,x) (Numerical Recipes gser/gcf). */
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) { // series expansion
    let ap = a; let sum = 1 / a; let del = sum;
    for (let i = 0; i < 500; i++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  const FPMIN = 1e-300; // continued fraction for Q(a,x) = 1 − P
  let b = x + 1 - a; let c = 1 / FPMIN; let d = 1 / b; let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Chi-square CDF with k degrees of freedom. */
export function chiSquareCdf(x, k) { return gammaP(k / 2, x / 2); }

/** Two-tailed/one-tailed p from a standard-normal statistic. */
function normalP(z, alternative) {
  if (alternative === 'greater') return 1 - normalCdf(z);
  if (alternative === 'less') return normalCdf(z);
  return 2 * (1 - normalCdf(Math.abs(z)));
}
function tP(t, df, alternative) {
  if (alternative === 'greater') return 1 - tCdf(t, df);
  if (alternative === 'less') return tCdf(t, df);
  return 2 * (1 - tCdf(Math.abs(t), df));
}

/** t quantile (inverse CDF) by bisection — for confidence intervals on means. */
function tQuantile(p, df) {
  let lo = -300; let hi = 300;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (tCdf(mid, df) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ── A/B tests ────────────────────────────────────────────────────────────────

/** Two-proportion z-test (conversion-rate experiments). */
export function twoProportionZTest({ controlConversions: c1, controlN: n1, variantConversions: c2, variantN: n2, alternative = 'two_sided', confidence = 0.95 }) {
  const p1 = c1 / n1; const p2 = c2 / n2;
  const pPool = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const pValue = normalP(z, alternative);
  const zStar = normalQuantile(1 - (1 - confidence) / 2);
  const seDiff = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  const diff = p2 - p1;
  // CI on the RELATIVE lift (p2/p1 − 1) via the log-ratio delta method (independent groups).
  let relCi = null;
  if (p1 > 0 && p2 > 0) {
    const seLog = Math.sqrt((1 - p1) / (n1 * p1) + (1 - p2) / (n2 * p2));
    const lr = Math.log(p2 / p1);
    relCi = [Math.exp(lr - zStar * seLog) - 1, Math.exp(lr + zStar * seLog) - 1];
  }
  return {
    control_rate: p1, variant_rate: p2,
    absolute_lift: diff, relative_lift: p1 ? diff / p1 : null, relative_lift_ci: relCi,
    z, p_value: pValue, confidence_interval: [diff - zStar * seDiff, diff + zStar * seDiff],
    significant: pValue < 1 - confidence,
  };
}

/**
 * Always-valid p-value via the mixture SPRT (mSPRT, Johari et al. "Always Valid
 * Inference"): for an approximately normal effect estimate `delta` with sampling
 * variance `variance`, the mixture (normal prior, variance tau2) likelihood ratio is
 *   Λ = sqrt(V/(V+τ²)) · exp(Δ² τ² / (2 V (V+τ²)))
 * and p = min(1, 1/Λ) is valid at EVERY look — peeking at a live experiment never
 * inflates the false-positive rate (unlike a fixed-horizon z/t p-value).
 * tau2 defaults to `variance` (prior scaled to the current sampling noise); pass an
 * expected-effect-based tau2 for more power around that effect size.
 */
export function alwaysValidP({ delta, variance, tau2 }) {
  if (!(variance > 0)) return 1;
  const t2 = tau2 > 0 ? tau2 : variance;
  const logLr = 0.5 * Math.log(variance / (variance + t2)) + (delta * delta * t2) / (2 * variance * (variance + t2));
  return Math.min(1, Math.exp(-logLr));
}

/**
 * Sample Ratio Mismatch (SRM) guardrail: a χ² goodness-of-fit test that the
 * OBSERVED per-group sizes match the intended split. A tiny p (conventionally
 * < 0.001) means randomization/logging is broken and the experiment is INVALID.
 * `groups`: [{ label, n }]; `ratios`: intended weights (defaults to equal split).
 */
export function srmTest({ groups, ratios }) {
  const total = groups.reduce((s, g) => s + g.n, 0);
  const w = ratios && ratios.length === groups.length ? ratios : groups.map(() => 1);
  const wsum = w.reduce((a, b) => a + b, 0);
  let chi = 0;
  const detail = groups.map((g, i) => {
    const expected = total * w[i] / wsum;
    chi += expected > 0 ? (g.n - expected) ** 2 / expected : 0;
    return { label: g.label, observed: g.n, expected };
  });
  const df = groups.length - 1;
  const pValue = 1 - chiSquareCdf(chi, df);
  return { chi_square: chi, df, p_value: pValue, srm_detected: pValue < 0.001, groups: detail };
}

// ── power / sample-size planning (normal approximation) ───────────────────────

function zAlpha(alpha, alternative) { return alternative === 'two_sided' ? normalQuantile(1 - alpha / 2) : normalQuantile(1 - alpha); }

/** Required sample size PER GROUP to detect an absolute rate lift `mde` from `baseline`. */
export function sampleSizeProportion({ baseline, mde, alpha = 0.05, power = 0.8, alternative = 'two_sided' }) {
  const p1 = baseline; const p2 = baseline + mde; const pbar = (p1 + p2) / 2;
  const za = zAlpha(alpha, alternative); const zb = normalQuantile(power);
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / ((p2 - p1) ** 2);
  return Math.ceil(n);
}

/** Smallest absolute rate lift detectable at `power` with `n` per group (inverse of the above). */
export function mdeProportion({ baseline, n, alpha = 0.05, power = 0.8, alternative = 'two_sided' }) {
  let lo = 0; let hi = 1 - baseline;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (sampleSizeProportion({ baseline, mde: mid, alpha, power, alternative }) > n) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Required sample size PER GROUP to detect an absolute mean lift `mde` at spread `stddev`. */
export function sampleSizeMean({ stddev, mde, alpha = 0.05, power = 0.8, alternative = 'two_sided' }) {
  const za = zAlpha(alpha, alternative); const zb = normalQuantile(power);
  return Math.ceil(2 * ((za + zb) ** 2) * stddev * stddev / (mde * mde));
}

/** Smallest absolute mean lift detectable at `power` with `n` per group. */
export function mdeMean({ stddev, n, alpha = 0.05, power = 0.8, alternative = 'two_sided' }) {
  const za = zAlpha(alpha, alternative); const zb = normalQuantile(power);
  return (za + zb) * stddev * Math.sqrt(2 / n);
}

/**
 * Multiple-comparison correction over a family of p-values (one per variant when a
 * test has several arms, or several metrics). 'holm' controls the family-wise error
 * rate; 'bh' (Benjamini–Hochberg) controls the false discovery rate. Returns adjusted
 * p-values in the original order.
 */
export function adjustPValues(pvals, method = 'holm') {
  const m = pvals.length;
  const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adj = new Array(m);
  if (method === 'bh') {
    let prev = 1;
    for (let k = m - 1; k >= 0; k--) { const [p, i] = order[k]; prev = Math.min(prev, Math.min(p * m / (k + 1), 1)); adj[i] = prev; }
  } else { // holm
    let prev = 0;
    for (let k = 0; k < m; k++) { const [p, i] = order[k]; prev = Math.max(prev, Math.min(p * (m - k), 1)); adj[i] = prev; }
  }
  return adj;
}

/**
 * Ratio-metric A/B test via the DELTA METHOD, for metrics whose unit of analysis is
 * finer than the randomization unit (e.g. clicks/impressions, levels-completed/started
 * — randomized by user). Each group carries per-USER sufficient statistics:
 * { n, sumNum, sumDen, sumNum2, sumDen2, sumNumDen }. The group ratio is ΣY/ΣX = Ȳ/X̄;
 * its variance uses the delta method on the per-user means (cluster-robust), so the
 * within-user correlation between numerator and denominator is handled correctly.
 */
export function ratioDeltaTest({ control, variant, alternative = 'two_sided', confidence = 0.95 }) {
  const stat = (g) => {
    const mY = g.sumNum / g.n; const mX = g.sumDen / g.n;
    const varY = Math.max(g.sumNum2 / g.n - mY * mY, 0);
    const varX = Math.max(g.sumDen2 / g.n - mX * mX, 0);
    const covYX = g.sumNumDen / g.n - mY * mX;
    const R = mY / mX;
    const varR = (varY - 2 * R * covYX + R * R * varX) / (mX * mX * g.n);
    return { R, varR };
  };
  const c = stat(control); const v = stat(variant);
  const se = Math.sqrt(c.varR + v.varR);
  const diff = v.R - c.R;
  const z = se === 0 ? 0 : diff / se;
  const pValue = se === 0 ? (diff === 0 ? 1 : 0) : normalP(z, alternative);
  const zStar = normalQuantile(1 - (1 - confidence) / 2);
  return {
    control_ratio: c.R, variant_ratio: v.R,
    absolute_lift: diff, relative_lift: c.R ? diff / c.R : null,
    z, p_value: pValue, confidence_interval: [diff - zStar * se, diff + zStar * se],
    significant: pValue < 1 - confidence,
  };
}

/**
 * CUPED variance reduction for continuous A/B metrics. Given per-group SUFFICIENT
 * STATISTICS over per-user pairs (Y = in-experiment metric, X = pre-experiment
 * covariate): { n, sumY, sumY2, sumX, sumX2, sumXY } — control is groups[0].
 * Uses the pooled θ = Cov(Y,X)/Var(X), forms the adjusted metric
 * Y* = Y − θ(X − X̄), and runs Welch's t-test on the adjusted group means/variances
 * (lower variance ⇒ more power). Reduces to a plain t-test when X has no signal.
 */
export function cupedTest({ groups, alternative = 'two_sided', confidence = 0.95 }) {
  let N = 0; let Sx = 0; let Sy = 0; let Sxx = 0; let Sxy = 0;
  for (const g of groups) { N += g.n; Sx += g.sumX; Sy += g.sumY; Sxx += g.sumX2; Sxy += g.sumXY; }
  const mX = Sx / N; const mY = Sy / N;
  const varX = Sxx / N - mX * mX;
  const covYX = Sxy / N - mX * mY;
  const theta = varX > 1e-12 ? covYX / varX : 0; // no covariate signal → CUPED = plain t-test
  const adjust = (g) => {
    const meanY = g.sumY / g.n; const meanX = g.sumX / g.n;
    const ssYY = g.sumY2 - g.n * meanY * meanY;
    const ssXX = g.sumX2 - g.n * meanX * meanX;
    const ssXY = g.sumXY - g.n * meanX * meanY;
    const adjVar = Math.max((ssYY - 2 * theta * ssXY + theta * theta * ssXX) / (g.n - 1), 0);
    const rawVar = Math.max(ssYY / (g.n - 1), 0);
    return { n: g.n, mean: meanY - theta * (meanX - mX), stddev: Math.sqrt(adjVar), raw_stddev: Math.sqrt(rawVar) };
  };
  const c = adjust(groups[0]);
  const results = groups.slice(1).map((g) => {
    const v = adjust(g);
    const w = welchTTest({ controlMean: c.mean, controlStddev: c.stddev, controlN: c.n, variantMean: v.mean, variantStddev: v.stddev, variantN: v.n, alternative, confidence });
    const variance_reduction = v.raw_stddev > 0 ? 1 - (v.stddev * v.stddev) / (v.raw_stddev * v.raw_stddev) : 0;
    return { variant: g.label, theta, variance_reduction, ...w };
  });
  return { theta, results };
}

/** Welch's two-sample t-test (continuous metrics: ARPU, revenue/user, time, …). */
export function welchTTest({ controlMean: m1, controlStddev: s1, controlN: n1, variantMean: m2, variantStddev: s2, variantN: n2, alternative = 'two_sided', confidence = 0.95 }) {
  const v1 = (s1 * s1) / n1; const v2 = (s2 * s2) / n2;
  const se = Math.sqrt(v1 + v2);
  const diff0 = m2 - m1;
  if (se === 0) { // both groups have zero variance → no detectable spread
    return { control_mean: m1, variant_mean: m2, absolute_lift: diff0, relative_lift: m1 ? diff0 / m1 : null, relative_lift_ci: null, t: 0, df: n1 + n2 - 2, p_value: diff0 === 0 ? 1 : 0, confidence_interval: [diff0, diff0], significant: diff0 !== 0 };
  }
  const t = (m2 - m1) / se;
  const df = (v1 + v2) ** 2 / ((v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1));
  const pValue = tP(t, df, alternative);
  const tStar = tQuantile(1 - (1 - confidence) / 2, df);
  const diff = m2 - m1;
  // CI on the RELATIVE lift (m2/m1 − 1) via the log-ratio delta method (positive metrics).
  let relCi = null;
  if (m1 > 0 && m2 > 0) {
    const seLog = Math.sqrt(v2 / (m2 * m2) + v1 / (m1 * m1));
    const lr = Math.log(m2 / m1);
    relCi = [Math.exp(lr - tStar * seLog) - 1, Math.exp(lr + tStar * seLog) - 1];
  }
  return {
    control_mean: m1, variant_mean: m2,
    absolute_lift: diff, relative_lift: m1 ? diff / m1 : null, relative_lift_ci: relCi,
    t, df, p_value: pValue, confidence_interval: [diff - tStar * se, diff + tStar * se],
    significant: pValue < 1 - confidence,
  };
}
