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
  return {
    control_rate: p1, variant_rate: p2,
    absolute_lift: diff, relative_lift: p1 ? diff / p1 : null,
    z, p_value: pValue, confidence_interval: [diff - zStar * seDiff, diff + zStar * seDiff],
    significant: pValue < 1 - confidence,
  };
}

/** Welch's two-sample t-test (continuous metrics: ARPU, revenue/user, time, …). */
export function welchTTest({ controlMean: m1, controlStddev: s1, controlN: n1, variantMean: m2, variantStddev: s2, variantN: n2, alternative = 'two_sided', confidence = 0.95 }) {
  const v1 = (s1 * s1) / n1; const v2 = (s2 * s2) / n2;
  const se = Math.sqrt(v1 + v2);
  const diff0 = m2 - m1;
  if (se === 0) { // both groups have zero variance → no detectable spread
    return { control_mean: m1, variant_mean: m2, absolute_lift: diff0, relative_lift: m1 ? diff0 / m1 : null, t: 0, df: n1 + n2 - 2, p_value: diff0 === 0 ? 1 : 0, confidence_interval: [diff0, diff0], significant: diff0 !== 0 };
  }
  const t = (m2 - m1) / se;
  const df = (v1 + v2) ** 2 / ((v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1));
  const pValue = tP(t, df, alternative);
  const tStar = tQuantile(1 - (1 - confidence) / 2, df);
  const diff = m2 - m1;
  return {
    control_mean: m1, variant_mean: m2,
    absolute_lift: diff, relative_lift: m1 ? diff / m1 : null,
    t, df, p_value: pValue, confidence_interval: [diff - tStar * se, diff + tStar * se],
    significant: pValue < 1 - confidence,
  };
}
