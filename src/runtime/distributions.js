// Student's t, F and chi-squared distributions, built on the incomplete
// beta and gamma functions. Results are compared with installed Stata to
// 1 part in 10^12 in tests/runtime-expression.test.mjs.
import { MISSING } from "./values.js";

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lngamma(x) {
  if (!(x > 0)) return MISSING;
  if (x < 0.5)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lngamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let k = 1; k < 9; k++) sum += LANCZOS[k] / (z + k);
  const t = z + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
  );
}

// ln(Gamma(a + b) / Gamma(a)). With many degrees of freedom the two
// log-gammas are huge and nearly equal, so their difference is taken from
// its own series when b is one half and a is large.
function gammaRatio(a, b) {
  if (b === 0.5 && a > 50) return 0.5 * Math.log(a) + halfRatioSeries(a);
  return lngamma(a + b) - lngamma(a);
}
// ln(Gamma(a + 1/2) / Gamma(a)) - ln(a) / 2; the next term of the series is
// below 10^-18 once a exceeds 50.
function halfRatioSeries(a) {
  return (
    -1 / (8 * a) +
    1 / (192 * a ** 3) -
    1 / (640 * a ** 5) +
    17 / (14336 * a ** 7)
  );
}

// Continued fraction for the incomplete beta function (modified Lentz).
function betaFraction(a, b, x) {
  const tiny = 1e-300;
  let c = 1,
    d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let term = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + term * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + term / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    term = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + term * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + term / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return h;
}
/** Regularised incomplete beta function I_x(a, b). */
export function ibeta(a, b, x) {
  if (!(a > 0 && b > 0) || x < 0 || x > 1) return MISSING;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const front = Math.exp(
    gammaRatio(a, b) - lngamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(a, b, x)) / a
    : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}
/** Regularised lower incomplete gamma function P(a, x). */
export function gammap(a, x) {
  if (!(a > 0) || x < 0) return MISSING;
  if (x === 0) return 0;
  const front = Math.exp(-x + a * Math.log(x) - lngamma(a));
  if (x < a + 1) {
    let term = 1 / a,
      sum = term;
    for (let n = 1; n < 2000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-17) break;
    }
    return front * sum;
  }
  return 1 - gammaTail(a, x, front);
}
function gammaTail(a, x, front) {
  const tiny = 1e-300;
  let b = x + 1 - a,
    c = 1 / tiny,
    d = 1 / b,
    h = d;
  for (let n = 1; n < 2000; n++) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return front * h;
}
export function gammaq(a, x) {
  if (!(a > 0) || x < 0) return MISSING;
  if (x === 0) return 1;
  const front = Math.exp(-x + a * Math.log(x) - lngamma(a));
  return x < a + 1 ? 1 - gammap(a, x) : gammaTail(a, x, front);
}

export function ttail(df, t) {
  if (!(df > 0)) return MISSING;
  if (t === 0) return 0.5;
  const tail =
    df > 100
      ? tailManyDf(df, Math.abs(t))
      : 0.5 * ibeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? tail : 1 - tail;
}

// The upper tail of Student's t beyond t > 0 when df exceeds 100. The
// incomplete beta function loses digits here: x = df / (df + t^2) is close
// to 1, its fraction in x cancels, and its fraction in 1 - x converges
// slowly once df (1 - x) is a few units (with 10^8 degrees of freedom,
// ttail(df, 4) was off by 1 part in 10^9). Instead the density f(t) is written
// in logarithms and multiplied by the integral over u > 0 of
// f(t + u) / f(t) = (1 + u (2t + u) / (df + t^2))^(-(df + 1) / 2),
// which has no cancellation. That ratio falls off at least exponentially,
// so the integral is a trapezoid sum after the double-exponential change of
// variable u = scale * exp(v - exp(-v)), v from -4 to 4 in steps of 1/8.
// On a grid of df from 101 to 10^9 and t from 0.05 to 1000 this matches
// Stata 19 to 2 parts in 10^13.
const TAIL_NODES = [],
  TAIL_WEIGHTS = [];
for (let k = -32; k <= 32; k++) {
  const v = k / 8,
    u = Math.exp(v - Math.exp(-v));
  TAIL_NODES.push(u);
  TAIL_WEIGHTS.push((u * (1 + Math.exp(-v))) / 8);
}
function tailManyDf(df, t) {
  const power = (df + 1) / 2,
    spread = df + t * t,
    logDensity =
      -0.5 * Math.log(2 * Math.PI) +
      halfRatioSeries(df / 2) -
      power * Math.log1p((t * t) / df),
    // The ratio falls by a factor of e within about this distance: the
    // reciprocal of its slope at u = 0, or its width when t is near 0.
    scale = Math.min(spread / (2 * power * t), Math.sqrt(spread / power));
  if (!Number.isFinite(logDensity) || !(scale > 0 && scale < Infinity))
    return logDensity === -Infinity ? 0 : MISSING;
  let sum = 0;
  for (let k = 0; k < TAIL_NODES.length; k++) {
    const u = scale * TAIL_NODES[k],
      term =
        Math.exp(-power * Math.log1p((u * (2 * t + u)) / spread)) *
        TAIL_WEIGHTS[k];
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return Math.exp(logDensity) * scale * sum;
}
export function Ftail(df1, df2, f) {
  if (!(df1 > 0 && df2 > 0)) return MISSING;
  if (f <= 0) return 1;
  return ibeta(df2 / 2, df1 / 2, df2 / (df2 + df1 * f));
}
export function chi2tail(df, x) {
  if (!(df > 0)) return MISSING;
  return x <= 0 ? 1 : gammaq(df / 2, x / 2);
}

// Solves tail(x) = p for a decreasing tail function on x >= 0.
function invertTail(tail, p) {
  let low = 0,
    high = 1;
  while (tail(high) > p) {
    low = high;
    high *= 2;
    if (high > 1e300) return MISSING;
  }
  for (let k = 0; k < 200; k++) {
    const middle = (low + high) / 2;
    if (middle === low || middle === high) break;
    if (tail(middle) > p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
export function invttail(df, p) {
  if (!(df > 0) || !(p > 0 && p < 1)) return MISSING;
  if (p === 0.5) return 0;
  return p < 0.5
    ? invertTail((t) => ttail(df, t), p)
    : -invertTail((t) => ttail(df, t), 1 - p);
}
export function invFtail(df1, df2, p) {
  if (!(df1 > 0 && df2 > 0) || !(p > 0 && p <= 1)) return MISSING;
  return p === 1 ? 0 : invertTail((f) => Ftail(df1, df2, f), p);
}
export function invchi2tail(df, p) {
  if (!(df > 0) || !(p > 0 && p <= 1)) return MISSING;
  return p === 1 ? 0 : invertTail((x) => chi2tail(df, x), p);
}
