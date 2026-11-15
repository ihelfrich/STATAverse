// Stata's trigonometric, hyperbolic and other mathematical functions, the
// densities and discrete distributions built on the incomplete beta and
// gamma functions, and the Unicode string and regular-expression functions.
// Values were recorded from Stata 19 (tests/runtime-pass8-syntax.test.mjs).
//
// A result that is not a finite number becomes system missing when the
// expression stores it, as Stata returns missing outside a function's
// domain.
import { DOUBLE_MAX, FLOAT_MAX, MISSING, isMissing } from "./values.js";
import { ibeta, gammap, gammaq, lngamma } from "./distributions.js";
import { normal } from "./functions-normal.js";
import { parseFormat } from "./format.js";
import { Generator } from "./random.js";

const N = "numeric",
  S = "string";
const whole = (x) => Math.trunc(x);
const one = (fn) => ({ args: [N], returns: N, fn });
const two = (fn) => ({ args: [N, N], returns: N, fn });
const three = (fn) => ({ args: [N, N, N], returns: N, fn });
const isInteger = (x) => Number.isInteger(x);

// ----- digamma and trigamma -----
function digamma(x) {
  if (x <= 0 && isInteger(x)) return MISSING;
  if (x < 0) return digamma(1 - x) - Math.PI / Math.tan(Math.PI * x);
  let result = 0;
  while (x < 12) result -= 1 / x++;
  const inverse = 1 / (x * x);
  return (
    result +
    Math.log(x) -
    0.5 / x -
    inverse *
      (1 / 12 -
        inverse *
          (1 / 120 -
            inverse *
              (1 / 252 -
                inverse *
                  (1 / 240 - inverse * (1 / 132 - inverse * (691 / 32760))))))
  );
}
function trigamma(x) {
  if (x <= 0 && isInteger(x)) return MISSING;
  if (x < 0) {
    const s = Math.sin(Math.PI * x);
    return (Math.PI * Math.PI) / (s * s) - trigamma(1 - x);
  }
  let result = 0;
  while (x < 12) result += 1 / (x * x++);
  const inverse = 1 / (x * x);
  return (
    result +
    1 / x +
    inverse / 2 +
    (inverse / x) *
      (1 / 6 -
        inverse *
          (1 / 30 -
            inverse *
              (1 / 42 -
                inverse *
                  (1 / 30 - inverse * (5 / 66 - inverse * (691 / 2730))))))
  );
}

// ----- the normal distribution on the log scale -----
const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
/** ln(normal(z)); far in the left tail, from the continued fraction for Mills' ratio. */
function lnnormal(z) {
  if (z > 0) return Math.log1p(-normal(-z));
  if (z > -20) return Math.log(normal(z));
  const x = -z;
  let fraction = x;
  for (let k = 60; k >= 1; k--) fraction = x + k / fraction;
  return -0.5 * x * x - LN_SQRT_2PI - Math.log(fraction);
}

// ----- densities -----
function gammaden(a, b, g, x) {
  if (!(a > 0 && b > 0)) return MISSING;
  const y = x - g;
  if (y < 0) return 0;
  if (y === 0) return a === 1 ? 1 / b : a > 1 ? 0 : MISSING;
  return Math.exp((a - 1) * Math.log(y) - y / b - a * Math.log(b) - lngamma(a));
}
function betaden(a, b, x) {
  if (!(a > 0 && b > 0)) return MISSING;
  if (x < 0 || x > 1) return 0;
  const lnB = lngamma(a) + lngamma(b) - lngamma(a + b);
  if (x === 0 || x === 1) {
    const value = Math.pow(x, a - 1) * Math.pow(1 - x, b - 1) * Math.exp(-lnB);
    return Number.isFinite(value) ? value : MISSING;
  }
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lnB);
}
function tden(df, t) {
  if (!(df > 0)) return MISSING;
  // With many degrees of freedom the two log gammas nearly cancel and
  // lose digits; the series for ln G(x + 1/2) - ln G(x), x = df/2, keeps
  // them, as Stata does: tden(1e8,1) is .24197072330929.
  if (df >= 500) {
    const x = df / 2;
    return Math.exp(
      -0.5 * Math.log(2 * Math.PI) -
        1 / (8 * x) +
        1 / (192 * x ** 3) +
        1 / (640 * x ** 5) -
        17 / (14336 * x ** 7) -
        ((df + 1) / 2) * Math.log1p((t * t) / df),
    );
  }
  return Math.exp(
    lngamma((df + 1) / 2) -
      lngamma(df / 2) -
      0.5 * Math.log(df * Math.PI) -
      ((df + 1) / 2) * Math.log1p((t * t) / df),
  );
}
function Fden(df1, df2, f) {
  if (!(df1 > 0 && df2 > 0)) return MISSING;
  if (f < 0) return 0;
  if (f === 0) return df1 === 2 ? 1 : df1 > 2 ? 0 : MISSING;
  return Math.exp(
    lngamma((df1 + df2) / 2) -
      lngamma(df1 / 2) -
      lngamma(df2 / 2) +
      (df1 / 2) * Math.log(df1 / df2) +
      (df1 / 2 - 1) * Math.log(f) -
      ((df1 + df2) / 2) * Math.log1p((df1 * f) / df2),
  );
}

// ----- discrete distributions -----
const lnfact = (n) => lngamma(n + 1);
function binomialp(n, k, p) {
  if (!isInteger(n) || !isInteger(k) || n < 0 || k < 0 || k > n) return MISSING;
  if (!(p >= 0 && p <= 1)) return MISSING;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(
    lnfact(n) -
      lnfact(k) -
      lnfact(n - k) +
      k * Math.log(p) +
      (n - k) * Math.log1p(-p),
  );
}
/** P(X <= k) for X binomial(n, p); k is taken down to an integer. */
function binomial(n, k, p) {
  if (!isInteger(n) || n < 0 || !(p >= 0 && p <= 1)) return MISSING;
  k = Math.floor(k);
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p === 0) return 1;
  if (p === 1) return 0;
  return ibeta(n - k, k + 1, 1 - p);
}
/** P(X >= k). */
function binomialtail(n, k, p) {
  if (!isInteger(n) || n < 0 || !(p >= 0 && p <= 1)) return MISSING;
  k = Math.ceil(k);
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p === 0) return 0;
  if (p === 1) return 1;
  return ibeta(k, n - k + 1, p);
}
function poissonp(m, k) {
  if (!(m > 0) || !isInteger(k) || k < 0) return MISSING;
  return Math.exp(k * Math.log(m) - m - lnfact(k));
}
function poisson(m, k) {
  if (!(m > 0) || k < 0) return MISSING;
  return gammaq(Math.floor(k) + 1, m);
}
function poissontail(m, k) {
  if (!(m > 0)) return MISSING;
  k = Math.ceil(k);
  return k <= 0 ? 1 : gammap(k, m);
}
function hypergeometricp(N, K, n, k) {
  if (![N, K, n, k].every(isInteger) || N < 1 || K < 0 || K > N) return MISSING;
  if (n < 0 || n > N || k < Math.max(0, n + K - N) || k > Math.min(n, K))
    return MISSING;
  return Math.exp(
    lnfact(K) -
      lnfact(k) -
      lnfact(K - k) +
      lnfact(N - K) -
      lnfact(n - k) -
      lnfact(N - K - n + k) -
      lnfact(N) +
      lnfact(n) +
      lnfact(N - n),
  );
}
function hypergeometric(N, K, n, k) {
  if (![N, K, n, k].every(isInteger) || N < 1 || K < 0 || K > N) return MISSING;
  if (n < 0 || n > N || k < Math.max(0, n + K - N) || k > Math.min(n, K))
    return MISSING;
  let sum = 0;
  for (let j = Math.max(0, n + K - N); j <= k; j++)
    sum += hypergeometricp(N, K, n, j);
  return Math.min(1, sum);
}

// ----- the noncentral chi-squared distribution -----
function nchi2(df, lambda, x) {
  if (!(df > 0) || !(lambda >= 0)) return MISSING;
  if (x <= 0) return 0;
  if (lambda === 0) return gammap(df / 2, x / 2);
  // A Poisson mixture of central chi-squared, summed from the mode out.
  const half = lambda / 2,
    mode = Math.floor(half),
    weight = (j) => Math.exp(j * Math.log(half) - half - lnfact(j));
  let sum = 0;
  for (let j = mode; j >= 0; j--) {
    const term = weight(j) * gammap(df / 2 + j, x / 2);
    sum += term;
    if (term < 1e-18 * sum && j < mode - 5) break;
  }
  for (let j = mode + 1; j < mode + 100000; j++) {
    const w = weight(j),
      term = w * gammap(df / 2 + j, x / 2);
    sum += term;
    if (w < 1e-18 && term < 1e-18 * sum) break;
  }
  return Math.min(1, sum);
}

// ----- the bivariate normal (Genz's algorithm, from Drezner and Wesolowsky) -----
const GAUSS = [
  [
    [0.1713244923791705, 0.3607615730481384, 0.4679139345726904],
    [0.9324695142031522, 0.6612093864662647, 0.238619186083197],
  ],
  [
    [
      0.04717533638651177, 0.1069393259953183, 0.1600783285433464,
      0.2031674267230659, 0.2334925365383547, 0.2491470458134029,
    ],
    [
      0.9815606342467191, 0.904117256370475, 0.769902674194305,
      0.5873179542866171, 0.3678314989981802, 0.1252334085114692,
    ],
  ],
  [
    [
      0.01761400713915212, 0.04060142980038694, 0.06267204833410906,
      0.08327674157670475, 0.1019301198172404, 0.1181945319615184,
      0.1316886384491766, 0.1420961093183821, 0.1491729864726037,
      0.1527533871307259,
    ],
    [
      0.9931285991850949, 0.9639719272779138, 0.9122344282513259,
      0.8391169718222188, 0.7463319064601508, 0.636053680726515,
      0.5108670019508271, 0.3737060887154196, 0.2277858511416451,
      0.07652652113349733,
    ],
  ],
];
/** P(X > h, Y > k) for a standard bivariate normal with correlation r. */
function bvnu(h, k, r) {
  const [w0, x0] = GAUSS[Math.abs(r) < 0.3 ? 0 : Math.abs(r) < 0.75 ? 1 : 2],
    w = [...w0, ...w0],
    x = [...x0.map((v) => 1 - v), ...x0.map((v) => 1 + v)];
  let hk = h * k,
    bvn = 0;
  if (Math.abs(r) < 0.925) {
    const hs = (h * h + k * k) / 2,
      asr = Math.asin(r) / 2;
    for (let i = 0; i < x.length; i++) {
      const sn = Math.sin(asr * x[i]);
      bvn += w[i] * Math.exp((sn * hk - hs) / (1 - sn * sn));
    }
    return (bvn * asr) / (2 * Math.PI) + normal(-h) * normal(-k);
  }
  if (r < 0) {
    k = -k;
    hk = -hk;
  }
  if (Math.abs(r) < 1) {
    const as = 1 - r * r;
    let a = Math.sqrt(as);
    const bs = (h - k) ** 2,
      c = (4 - hk) / 8,
      d = (12 - hk) / 80;
    let asr = -(bs / as + hk) / 2;
    if (asr > -100)
      bvn =
        a *
        Math.exp(asr) *
        (1 - (c * (bs - as) * (1 - d * bs)) / 3 + c * d * as * as);
    if (hk > -100) {
      const b = Math.sqrt(bs),
        sp = Math.sqrt(2 * Math.PI) * normal(-b / a);
      bvn -= Math.exp(-hk / 2) * sp * b * (1 - (c * bs * (1 - d * bs)) / 3);
    }
    a /= 2;
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const xs = (a * x[i]) ** 2;
      asr = -(bs / xs + hk) / 2;
      if (asr <= -100) continue;
      const sp = 1 + c * xs * (1 + 5 * d * xs),
        rs = Math.sqrt(1 - xs),
        ep = Math.exp((-(hk / 2) * xs) / (1 + rs) ** 2) / rs;
      sum += w[i] * Math.exp(asr) * (sp - ep);
    }
    bvn = (a * sum - bvn) / (2 * Math.PI);
  }
  if (r > 0) return bvn + normal(-Math.max(h, k));
  if (h >= k) return -bvn;
  const L = h < 0 ? normal(k) - normal(h) : normal(-h) - normal(-k);
  return L - bvn;
}
function binormal(h, k, r) {
  if (!(r >= -1 && r <= 1)) return MISSING;
  return Math.max(0, Math.min(1, bvnu(-h, -k, r)));
}

// ----- inverses, by safeguarded root finding on a monotone function -----
/**
 * The x in [lo, hi] at which f(x) = target, f increasing or decreasing.
 * Bisection with a false-position step, to the last bit.
 */
function solve(f, target, lo, hi) {
  let flo = f(lo) - target,
    fhi = f(hi) - target;
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (Math.sign(flo) === Math.sign(fhi)) return MISSING;
  let side = 0;
  for (let k = 0; k < 400; k++) {
    let mid = (lo * fhi - hi * flo) / (fhi - flo);
    if (!(mid > lo && mid < hi) || k % 3 === 2) mid = lo + (hi - lo) / 2;
    if (mid <= lo || mid >= hi) break;
    const fm = f(mid) - target;
    if (fm === 0) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
      if (side === -1) fhi /= 2;
      side = -1;
    } else {
      hi = mid;
      fhi = fm;
      if (side === 1) flo /= 2;
      side = 1;
    }
  }
  return lo + (hi - lo) / 2;
}
/** An upper bound where an increasing f reaches the target. */
function above(f, target, start = 1) {
  let hi = start;
  while (f(hi) < target && hi < 1e300) hi *= 2;
  return hi;
}
const probability = (p) => p >= 0 && p <= 1;
function invgammap(a, p) {
  if (!(a > 0) || !probability(p)) return MISSING;
  if (p === 0) return 0;
  if (p === 1) return MISSING;
  const f = (x) => gammap(a, x);
  return solve(f, p, 0, above(f, p, a + 1));
}
function invgammaptail(a, q) {
  if (!(a > 0) || !probability(q)) return MISSING;
  if (q === 1) return 0;
  if (q === 0) return MISSING;
  const f = (x) => -gammaq(a, x);
  return solve(f, -q, 0, above(f, -q, a + 1));
}
function invibeta(a, b, p) {
  if (!(a > 0 && b > 0) || !probability(p)) return MISSING;
  return solve((x) => ibeta(a, b, x), p, 0, 1);
}
function invibetatail(a, b, q) {
  if (!(a > 0 && b > 0) || !probability(q)) return MISSING;
  return solve((x) => -ibeta(b, a, 1 - x), -q, 0, 1);
}
function invbinomial(n, k, P) {
  if (!isInteger(n) || n < 1 || !probability(P)) return MISSING;
  k = Math.floor(k);
  if (k < 0 || k >= n) return MISSING;
  return solve((p) => -binomial(n, k, p), -P, 0, 1);
}
function invbinomialtail(n, k, P) {
  if (!isInteger(n) || n < 1 || !probability(P)) return MISSING;
  k = Math.ceil(k);
  if (k < 1 || k > n) return MISSING;
  return solve((p) => binomialtail(n, k, p), P, 0, 1);
}
function invpoisson(k, P) {
  if (k < 0 || !(P > 0 && P < 1)) return MISSING;
  const f = (m) => -poisson(m, k);
  return solve(f, -P, 1e-300, above(f, -P, k + 1));
}
function invpoissontail(k, q) {
  if (k < 0 || !(q > 0 && q < 1)) return MISSING;
  const f = (m) => poissontail(m, k);
  return solve(f, q, 1e-300, above(f, q, k + 1));
}
function invnchi2(df, lambda, p) {
  if (!(df > 0) || !(lambda >= 0) || !(p > 0 && p < 1)) return MISSING;
  const f = (x) => nchi2(df, lambda, x);
  return solve(f, p, 0, above(f, p, df + lambda + 1));
}
function npnchi2(df, x, p) {
  if (!(df > 0) || !(x > 0) || !(p > 0 && p < 1)) return MISSING;
  const f = (lambda) => -nchi2(df, lambda, x);
  if (-f(0) < p) return MISSING;
  return solve(f, -p, 0, above(f, -p, x + 1));
}

// ----- continuous families with closed forms -----
/** A function of (x), (s, x) or (m, s, x): location m, scale s. */
const located = (fn) => ({
  args: [N, N, N],
  min: 1,
  returns: N,
  fn: (...a) => {
    const [m, scale, x] =
      a.length === 1 ? [0, 1, a[0]] : a.length === 2 ? [0, a[0], a[1]] : a;
    return scale > 0 ? fn(m, scale, x) : MISSING;
  },
});
const positive =
  (fn) =>
  (b, ...rest) =>
    b > 0 ? fn(b, ...rest) : MISSING;
const unit = (fn) => (a, b, p) => (p >= 0 && p <= 1 ? fn(a, b, p) : MISSING);
/** Weibull in Stata's two forms, with an optional location g, given before x. */
function weibullFamily(ph) {
  const z = (a, b, x, g = 0) =>
    ph ? b * Math.pow(x - g, a) : Math.pow((x - g) / b, a);
  const ok = (a, b) => a > 0 && b > 0;
  // weibull(a, b, x) or weibull(a, b, g, x).
  const four = (fn) => ({
    args: [N, N, N, N],
    min: 3,
    returns: N,
    fn: (a, b, g, x) => (x === undefined ? fn(a, b, g, 0) : fn(a, b, x, g)),
  });
  return {
    cdf: four((a, b, x, g = 0) =>
      !ok(a, b) ? MISSING : x < g ? 0 : -Math.expm1(-z(a, b, x, g)),
    ),
    tail: four((a, b, x, g = 0) =>
      !ok(a, b) ? MISSING : x < g ? 1 : Math.exp(-z(a, b, x, g)),
    ),
    den: four((a, b, x, g = 0) => {
      if (!ok(a, b)) return MISSING;
      if (x < g) return 0;
      const y = x - g,
        value = ph
          ? a * b * Math.pow(y, a - 1) * Math.exp(-b * Math.pow(y, a))
          : (a / b) * Math.pow(y / b, a - 1) * Math.exp(-Math.pow(y / b, a));
      return Number.isFinite(value) ? value : MISSING;
    }),
    inverse: four((a, b, p, g = 0) => {
      if (!ok(a, b) || !(p > 0 && p < 1)) return MISSING;
      const h = -Math.log1p(-p);
      return g + (ph ? Math.pow(h / b, 1 / a) : b * Math.pow(h, 1 / a));
    }),
    inverseTail: four((a, b, q, g = 0) => {
      if (!ok(a, b) || !(q > 0 && q < 1)) return MISSING;
      const h = -Math.log(q);
      return g + (ph ? Math.pow(h / b, 1 / a) : b * Math.pow(h, 1 / a));
    }),
  };
}
const WEIBULL = weibullFamily(false),
  WEIBULLPH = weibullFamily(true);
function igaussian(m, a, x) {
  if (!(m > 0 && a > 0)) return MISSING;
  if (x <= 0) return 0;
  const r = Math.sqrt(a / x);
  return (
    normal(r * (x / m - 1)) + Math.exp((2 * a) / m + lnnormal(-r * (x / m + 1)))
  );
}
function lnigaussianden(m, a, x) {
  if (!(m > 0 && a > 0) || !(x > 0)) return MISSING;
  return (
    0.5 * Math.log(a / (2 * Math.PI * x * x * x)) -
    (a * (x - m) ** 2) / (2 * m * m * x)
  );
}
function nbinomialp(n, k, p) {
  if (!(n > 0) || !isInteger(k) || k < 0 || !(p > 0 && p <= 1)) return MISSING;
  if (p === 1) return k === 0 ? 1 : 0;
  return Math.exp(
    lngamma(n + k) -
      lngamma(n) -
      lnfact(k) +
      n * Math.log(p) +
      k * Math.log1p(-p),
  );
}

// ----- noncentral beta, F and t -----
/** The Poisson(lambda/2) weights of a noncentral mixture, summed from the mode out. */
function mixture(lambda, term) {
  const half = lambda / 2,
    mode = Math.floor(half),
    weight = (j) => Math.exp(j * Math.log(half) - half - lnfact(j));
  if (lambda === 0) return term(0);
  let sum = 0;
  for (let j = mode; j >= 0; j--) {
    const t = weight(j) * term(j);
    sum += t;
    if (t < 1e-18 * sum && j < mode - 5) break;
  }
  for (let j = mode + 1; j < mode + 100000; j++) {
    const w = weight(j),
      t = w * term(j);
    sum += t;
    if (w < 1e-18 && t < 1e-18 * sum) break;
  }
  return sum;
}
function nibeta(a, b, lambda, x) {
  if (!(a > 0 && b > 0 && lambda >= 0) || !(x >= 0 && x <= 1)) return MISSING;
  if (x === 0) return 0;
  if (x === 1) return 1;
  return Math.min(
    1,
    mixture(lambda, (j) => ibeta(a + j, b, x)),
  );
}
function nbetaden(a, b, lambda, x) {
  if (!(a > 0 && b > 0 && lambda >= 0) || !(x >= 0 && x <= 1)) return MISSING;
  return mixture(lambda, (j) => betaden(a + j, b, x));
}
function nF(df1, df2, lambda, f) {
  if (!(df1 > 0 && df2 > 0 && lambda >= 0)) return MISSING;
  if (f <= 0) return 0;
  return nibeta(df1 / 2, df2 / 2, lambda, (df1 * f) / (df1 * f + df2));
}
function nFden(df1, df2, lambda, f) {
  if (!(df1 > 0 && df2 > 0 && lambda >= 0)) return MISSING;
  if (f < 0) return 0;
  const d = df1 * f + df2;
  return (
    nbetaden(df1 / 2, df2 / 2, lambda, (df1 * f) / d) * ((df1 * df2) / (d * d))
  );
}
/** The noncentral t distribution, P(T < t), by Lenth's algorithm AS 243. */
function nt(df, delta, t) {
  if (!(df > 0)) return MISSING;
  let negative = false,
    tt = t,
    del = delta;
  if (t < 0) {
    negative = true;
    tt = -t;
    del = -delta;
  }
  const x = (tt * tt) / (tt * tt + df);
  let tnc = 0;
  if (x > 0) {
    const lambda = del * del;
    let p = 0.5 * Math.exp(-0.5 * lambda),
      q = Math.sqrt(2 / Math.PI) * p * del,
      s = 0.5 - p,
      a = 0.5;
    const b = 0.5 * df,
      rxb = Math.pow(1 - x, b),
      albeta = 0.5 * Math.log(Math.PI) + lngamma(b) - lngamma(0.5 + b);
    let xodd = ibeta(a, b, x),
      godd = 2 * rxb * Math.exp(a * Math.log(x) - albeta),
      xeven = 1 - rxb,
      geven = b * x * rxb;
    tnc = p * xodd + q * xeven;
    for (let en = 1; en <= 100000; en++) {
      a += 1;
      xodd -= godd;
      xeven -= geven;
      godd *= (x * (a + b - 1)) / a;
      geven *= (x * (a + b - 0.5)) / (a + 0.5);
      p *= lambda / (2 * en);
      q *= lambda / (2 * en + 1);
      s -= p;
      tnc += p * xodd + q * xeven;
      if (Math.abs(2 * s * (xodd - godd)) < 1e-15 && en > 2) break;
    }
  }
  tnc += normal(-del);
  tnc = Math.min(1, Math.max(0, tnc));
  return negative ? 1 - tnc : tnc;
}
function ntden(df, delta, t) {
  if (!(df > 0)) return MISSING;
  if (Math.abs(t) > 1e-12)
    return Math.max(
      0,
      (df / t) *
        (nt(df + 2, delta, t * Math.sqrt(1 + 2 / df)) - nt(df, delta, t)),
    );
  return Math.exp(
    lngamma((df + 1) / 2) -
      lngamma(df / 2) -
      0.5 * Math.log(Math.PI * df) -
      (delta * delta) / 2,
  );
}

// ----- recoding, rounding and the limits of the storage types -----
/** recode(x, x1, ..., xn): the first xk not below x, else xn. */
function recode(x, ...cuts) {
  if (isMissing(x) || !ascending(cuts)) return MISSING;
  for (const cut of cuts.slice(0, -1)) if (x <= cut) return cut;
  return cuts.at(-1);
}
// Stata's cut points are numbers that never decrease; recode(2,5,3) and
// irecode(2,.,3) are missing.
const ascending = (cuts) =>
  cuts.every((cut, k) => !isMissing(cut) && (k === 0 || cut >= cuts[k - 1]));
/** irecode(x, x1, ..., xn): how many of the cuts lie below x. */
function irecode(x, ...cuts) {
  if (isMissing(x) || !ascending(cuts)) return MISSING;
  for (let k = 0; k < cuts.length; k++) if (x <= cuts[k]) return k;
  return cuts.length;
}
/** autocode(x, n, lo, hi): the top of the one of n equal intervals holding x. */
function autocode(x, n, lo, hi) {
  if (isMissing(x)) return MISSING;
  n = whole(n);
  if (!(n >= 1) || !(hi > lo)) return MISSING;
  const width = (hi - lo) / n;
  for (let k = 1; k < n; k++) if (x <= lo + k * width) return lo + k * width;
  return hi;
}
/** The display width of a format, or missing for one that is not valid. */
function fmtwidth(format) {
  // A European format (%9,2f, the comma for the decimal point) is as wide
  // as its point-decimal twin.
  const spec = parseFormat(
    format.trim().replace(/^%(-?0?\d+),(\d+)/, "%$1.$2"),
  );
  if (!spec) return MISSING;
  if (spec.kind === "date")
    return spec.codes.reduce((total, code) => total + code.width, 0);
  return spec.width ?? MISSING;
}

// ----- Unicode strings -----
const characters = (s) => [...s];
const SPACE = /^[\s\u0085᠎]+|[\s\u0085᠎]+$/gu;
let segmenter = null;
/** Unicode words as ICU breaks them; spaces are not words, punctuation is. */
function unicodeWords(s) {
  segmenter ??= new Intl.Segmenter("en", { granularity: "word" });
  return [...segmenter.segment(s)]
    .map((part) => part.segment)
    .filter((word) => !/^\s+$/u.test(word));
}
const collators = new Map();
/** The collator for a Stata locale name such as en_US_POSIX; root when unknown. */
function collator(locale) {
  if (!collators.has(locale)) {
    const tag = locale.replace(/_POSIX$/i, "-u-va-posix").replace(/_/g, "-");
    let made;
    try {
      made = new Intl.Collator(tag);
    } catch {
      made = new Intl.Collator("und");
    }
    collators.set(locale, made);
  }
  return collators.get(locale);
}
/** Each word with its first cased letter in title case and the rest lower. */
function ustrtitle(s) {
  segmenter ??= new Intl.Segmenter("en", { granularity: "word" });
  let out = "";
  for (const { segment } of segmenter.segment(s)) {
    let done = false;
    for (const c of segment) {
      const cased = c.toLowerCase() !== c.toUpperCase();
      if (cased && !done) {
        out += c.toUpperCase();
        done = true;
      } else out += c.toLowerCase();
    }
  }
  return out;
}
const hex = (code) =>
  code > 0xffff
    ? `\\U${code.toString(16).padStart(8, "0")}`
    : `\\u${code.toString(16).padStart(4, "0")}`;
const encoder = new TextEncoder();
/**
 * ustrunescape(): \uhhhh, \Uhhhhhhhh, \x{h...}, \xhh and the C escapes
 * become the characters they name; a backslash before anything else is
 * dropped. Stata 19 reads a character past ASCII in the text itself as
 * the bytes of its UTF-8 form, each a character of its own, so "\u00e9" comes
 * back as the two characters \u00c3\u00a9; this does the same.
 */
function ustrunescape(s) {
  const latin = s.replace(/[^\x00-\x7f]/gu, (c) =>
    String.fromCharCode(...encoder.encode(c)),
  );
  return latin.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x\{([0-9a-fA-F]{1,6})\}|x([0-9a-fA-F]{1,2})|([\s\S]))/g,
    (whole, u4, u8, xb, x2, escape) => {
      if (escape !== undefined)
        return (
          { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[
            escape
          ] ?? escape
        );
      const code = parseInt(u4 ?? u8 ?? xb ?? x2, 16);
      return code > 0x10ffff ? whole : String.fromCodePoint(code);
    },
  );
}
const SOUNDEX = {
  b: "1",
  f: "1",
  p: "1",
  v: "1",
  c: "2",
  g: "2",
  j: "2",
  k: "2",
  q: "2",
  s: "2",
  x: "2",
  z: "2",
  d: "3",
  t: "3",
  l: "4",
  m: "5",
  n: "5",
  r: "6",
};
/**
 * Soundex codes. Stata's soundex() lets h and w separate letters of one
 * code; soundex_nara(), the National Archives' rule, does not.
 */
function soundexOf(s, nara) {
  const letters = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!letters) return "";
  let code = letters[0].toUpperCase(),
    last = SOUNDEX[letters[0]] ?? "";
  for (const c of letters.slice(1)) {
    const digit = SOUNDEX[c];
    if (digit) {
      if (digit !== last) code += digit;
      last = digit;
    } else if (!(nara && (c === "h" || c === "w"))) last = "";
    if (code.length === 4) break;
  }
  return code.padEnd(4, "0");
}
function tobytes(s, n = 0) {
  return [...encoder.encode(s)]
    .slice(0, 200)
    .map((b) =>
      n === 0
        ? `\\d${String(b).padStart(3, "0")}`
        : `\\x${b.toString(16).padStart(2, "0")}`,
    )
    .join("");
}
/** The first character, tested against a Unicode property. */
const firstIs = (pattern) => (s) =>
  Number(pattern.test(characters(s)[0] ?? ""));

// ----- ICU regular expressions -----
const POSIX = {
  alpha: "\\p{Alphabetic}",
  digit: "\\p{Nd}",
  alnum: "\\p{Alphabetic}\\p{Nd}",
  upper: "\\p{Uppercase}",
  lower: "\\p{Lowercase}",
  space: "\\s",
  blank: "\\p{Zs}\\t",
  punct: "\\p{P}",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\p{Cc}",
};
/** An ICU pattern as a JavaScript one, or null when it is not valid. */
function icu(pattern, insensitive) {
  let flags = insensitive ? "i" : "";
  // Flags set at the front, as (?i), become the expression's own.
  const source = pattern
    .replace(/^\(\?([imsx]+)\)/, (whole, set) => {
      for (const flag of set)
        if (flag !== "x" && !flags.includes(flag)) flags += flag;
      return set.includes("x") ? whole : "";
    })
    .replace(/\[:(\w+):\]/g, (whole, name) => POSIX[name] ?? whole);
  try {
    return new RegExp(source, `gu${flags}`);
  } catch {
    return null;
  }
}
/** An ICU replacement: $n is a group, \ makes the next character literal. */
function icuReplacement(template, match) {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "\\") {
      if (i + 1 >= template.length) return null;
      out += template[++i];
    } else if (c === "$") {
      const digits = /^\d+/.exec(template.slice(i + 1))?.[0];
      if (!digits) return null;
      // ICU reads as many digits as still name a group.
      let used = 1;
      while (
        used < digits.length &&
        Number(digits.slice(0, used + 1)) < match.length
      )
        used++;
      const group = Number(digits.slice(0, used));
      if (group >= match.length) return null;
      out += match[group] ?? "";
      i += used;
    } else out += c;
  }
  return out;
}
function regexReplace(state, s, pattern, to, insensitive, all) {
  // ustrregexrf leaves its match for ustrregexs(); ustrregexra leaves
  // none, matched or not, as in Stata.
  if (all) {
    const out = replaceMatches(state, s, pattern, to, insensitive, all);
    state.umatch = null;
    return out;
  }
  return replaceMatches(state, s, pattern, to, insensitive, all);
}
function replaceMatches(state, s, pattern, to, insensitive, all) {
  const re = icu(pattern, insensitive !== 0);
  if (!re) return "";
  let out = "",
    at = 0,
    match;
  re.lastIndex = 0;
  while ((match = re.exec(s))) {
    const replacement = icuReplacement(to, match);
    if (replacement === null) return "";
    state.umatch = match;
    out += s.slice(at, match.index) + replacement;
    at = match.index + match[0].length;
    if (!all) break;
    if (match[0] === "") {
      // An empty match moves on one character, as ICU does.
      if (re.lastIndex >= s.length) {
        at = s.length;
        out += "";
        break;
      }
      const step = String.fromCodePoint(s.codePointAt(re.lastIndex)).length;
      out += s.slice(re.lastIndex, re.lastIndex + step);
      re.lastIndex += step;
      at = re.lastIndex;
    }
  }
  return out + s.slice(at);
}

/** A draw from Stata's uniform stream, which these transform. */
const uniform = (state) => (state.rng ??= new Generator(state.seed)).uniform();
/**
 * A random-number function made from one uniform draw. Stata checks the
 * parameters first: outside a function's domain it returns missing and
 * uses up no draw, so the stream stays in step.
 */
const drawn = (args, min, valid, fn) => ({
  args,
  min,
  returns: N,
  state: true,
  lenient: true,
  fn: (state, ...a) => {
    if (!valid(...a)) return MISSING;
    const value = fn(uniform(state), ...a);
    return Number.isFinite(value) ? value : MISSING;
  },
});
// A parameter that is a number, within [low, high].
const within = (x, low = -Infinity, high = Infinity) =>
  !isMissing(x) && x >= low && x <= high;

export const MORE_FUNCTIONS = {
  // Closed-form draws, as Stata makes them from runiform(), each with the
  // domain Stata 19 accepts.
  rlogistic: drawn(
    [N, N],
    0,
    (a, b) =>
      b === undefined
        ? a === undefined || (within(a) && a > 0)
        : within(a) && within(b) && b > 0,
    (u, a, b) => {
      const [m, s] = b === undefined ? [0, a ?? 1] : [a, b];
      return m + s * Math.log(u / (1 - u));
    },
  ),
  rcauchy: drawn(
    [N, N],
    2,
    (a, b) => within(a, -1e300, 1e300) && within(b, 1e-100, 1e300),
    (u, a, b) => a + b * Math.tan(Math.PI * (u - 0.5)),
  ),
  rlaplace: drawn(
    [N, N],
    2,
    (m, b) => within(m, -1e300, 1e300) && within(b, 1e-300, 1e300),
    (u, m, b) =>
      u < 0.5 ? m + b * Math.log(2 * u) : m - b * Math.log(2 * (1 - u)),
  ),
  rweibull: drawn(
    [N, N, N],
    2,
    (a, b, g = 0) => within(a, 0.01, 1e6) && within(b) && b > 0 && within(g),
    (u, a, b, g = 0) => g + b * Math.pow(-Math.log(u), 1 / a),
  ),
  rweibullph: drawn(
    [N, N, N],
    2,
    (a, b, g = 0) => within(a, 0.01, 1e6) && within(b) && b > 0 && within(g),
    (u, a, b, g = 0) => g + Math.pow(-Math.log(u) / b, 1 / a),
  ),

  recode: { args: N, min: 3, returns: N, lenient: true, fn: recode },
  irecode: { args: N, min: 2, returns: N, lenient: true, fn: irecode },
  autocode: { args: [N, N, N, N], returns: N, lenient: true, fn: autocode },
  chop: two((x, eps) =>
    Math.abs(x - Math.round(x)) < eps ? Math.round(x) : x,
  ),
  epsdouble: { args: [], returns: N, fn: () => Number.EPSILON },
  epsfloat: { args: [], returns: N, fn: () => 2 ** -23 },
  smallestdouble: { args: [], returns: N, fn: () => 2 ** -1022 },
  maxbyte: { args: [], returns: N, fn: () => 100 },
  minbyte: { args: [], returns: N, fn: () => -127 },
  maxint: { args: [], returns: N, fn: () => 32740 },
  minint: { args: [], returns: N, fn: () => -32767 },
  maxlong: { args: [], returns: N, fn: () => 2147483620 },
  minlong: { args: [], returns: N, fn: () => -2147483647 },
  maxfloat: { args: [], returns: N, fn: () => FLOAT_MAX },
  minfloat: { args: [], returns: N, fn: () => -FLOAT_MAX },
  maxdouble: { args: [], returns: N, fn: () => DOUBLE_MAX },
  // The browser stores numbers low byte first, as Stata on Intel and Apple
  // silicon does: 2.
  byteorder: { args: [], returns: N, fn: () => 2 },
  fmtwidth: { args: [S], returns: N, fn: fmtwidth },

  nibeta: { args: [N, N, N, N], returns: N, fn: nibeta },
  nbetaden: { args: [N, N, N, N], returns: N, fn: nbetaden },
  invnibeta: {
    args: [N, N, N, N],
    returns: N,
    fn: (a, b, lambda, p) =>
      a > 0 && b > 0 && lambda >= 0 && probability(p)
        ? solve((x) => nibeta(a, b, lambda, x), p, 0, 1)
        : MISSING,
  },
  nF: { args: [N, N, N, N], returns: N, fn: nF },
  nFden: { args: [N, N, N, N], returns: N, fn: nFden },
  nFtail: {
    args: [N, N, N, N],
    returns: N,
    fn: (df1, df2, lambda, f) => {
      const p = nF(df1, df2, lambda, f);
      return isMissing(p) ? p : 1 - p;
    },
  },
  invnFtail: {
    args: [N, N, N, N],
    returns: N,
    fn: (df1, df2, lambda, q) => {
      if (!(df1 > 0 && df2 > 0 && lambda >= 0) || !(q > 0 && q < 1))
        return MISSING;
      const f = (x) => nF(df1, df2, lambda, x);
      return solve(f, 1 - q, 0, above(f, 1 - q, 1));
    },
  },
  npnF: {
    args: [N, N, N, N],
    returns: N,
    fn: (df1, df2, x, p) => {
      if (!(df1 > 0 && df2 > 0 && x > 0) || !(p > 0 && p < 1)) return MISSING;
      const f = (lambda) => -nF(df1, df2, lambda, x);
      if (-f(0) < p) return MISSING;
      return solve(f, -p, 0, above(f, -p, x + 1));
    },
  },
  nt: three(nt),
  ntden: three(ntden),
  nttail: three((df, delta, t) => {
    const p = nt(df, delta, t);
    return isMissing(p) ? p : 1 - p;
  }),
  invnttail: three((df, delta, q) => {
    if (!(df > 0) || !(q > 0 && q < 1)) return MISSING;
    const f = (t) => nt(df, delta, t);
    let lo = -1,
      hi = 1;
    while (f(lo) > 1 - q && lo > -1e300) lo *= 2;
    while (f(hi) < 1 - q && hi < 1e300) hi *= 2;
    return solve(f, 1 - q, lo, hi);
  }),
  npnt: three((df, t, p) => {
    if (!(df > 0) || !(p > 0 && p < 1)) return MISSING;
    // nt falls as the noncentrality rises.
    const f = (delta) => -nt(df, delta, t);
    let lo = -1,
      hi = 1;
    while (f(lo) > -p && lo > -1e6) lo *= 2;
    while (f(hi) < -p && hi < 1e6) hi *= 2;
    return solve(f, -p, lo, hi);
  }),
  invigaussian: three((m, a, p) =>
    m > 0 && a > 0 && p > 0 && p < 1
      ? solve(
          (x) => igaussian(m, a, x),
          p,
          0,
          above((x) => igaussian(m, a, x), p, m),
        )
      : MISSING,
  ),
  invigaussiantail: three((m, a, q) =>
    m > 0 && a > 0 && q > 0 && q < 1
      ? solve(
          (x) => igaussian(m, a, x),
          1 - q,
          0,
          above((x) => igaussian(m, a, x), 1 - q, m),
        )
      : MISSING,
  ),
  // The probability of success at which nbinomial(n, k, q), or the tail,
  // reaches p.
  invnbinomial: three((n, k, p) => {
    k = whole(k);
    if (!(n > 0) || k < 0 || !(p > 0 && p < 1)) return MISSING;
    return solve((q) => ibeta(n, k + 1, q), p, 0, 1);
  }),
  invnbinomialtail: three((n, k, p) => {
    k = whole(k);
    if (!(n > 0) || k < 1 || !(p > 0 && p < 1)) return MISSING;
    return solve((q) => -ibeta(k, n, 1 - q), -p, 0, 1);
  }),

  sin: one(Math.sin),
  cos: one(Math.cos),
  tan: one(Math.tan),
  asin: one(Math.asin),
  acos: one(Math.acos),
  atan: one(Math.atan),
  atan2: two((y, x) => Math.atan2(y, x)),
  sinh: one(Math.sinh),
  cosh: one(Math.cosh),
  tanh: one(Math.tanh),
  asinh: one(Math.asinh),
  acosh: one(Math.acosh),
  atanh: one((x) => (Math.abs(x) < 1 ? Math.atanh(x) : MISSING)),
  expm1: one(Math.expm1),
  ln1p: one((x) => (x > -1 ? Math.log1p(x) : MISSING)),
  ln1m: one((x) => (x < 1 ? Math.log1p(-x) : MISSING)),
  cloglog: one((x) => (x > 0 && x < 1 ? Math.log(-Math.log1p(-x)) : MISSING)),
  // Past 709.78, exp(x) overflows and Stata returns missing.
  invcloglog: one((x) =>
    Number.isFinite(Math.exp(x)) ? 1 - Math.exp(-Math.exp(x)) : MISSING,
  ),
  digamma: one(digamma),
  trigamma: one(trigamma),

  lnnormal: one(lnnormal),
  lnnormalden: {
    args: [N, N, N],
    min: 1,
    returns: N,
    fn: (x, a, b) => {
      const mean = b === undefined ? 0 : a,
        sd = b === undefined ? (a ?? 1) : b;
      if (!(sd > 0)) return MISSING;
      const z = (x - mean) / sd;
      return -0.5 * z * z - LN_SQRT_2PI - Math.log(sd);
    },
  },
  tden: two(tden),
  chi2den: two((df, x) => gammaden(df / 2, 2, 0, x)),
  Fden: three(Fden),
  betaden: three(betaden),
  gammaden: { args: [N, N, N, N], returns: N, fn: gammaden },
  gammaptail: two(gammaq),
  // Outside [0, 1] the upper tail is 1 below and 0 above, as in Stata.
  ibetatail: three((a, b, x) =>
    !(a > 0 && b > 0) ? MISSING : x < 0 ? 1 : x > 1 ? 0 : ibeta(b, a, 1 - x),
  ),
  invgammap: two(invgammap),
  invgammaptail: two(invgammaptail),
  invibeta: three(invibeta),
  invibetatail: three(invibetatail),
  binomialp: three((n, k, p) => binomialp(whole(n), whole(k), p)),
  binomial: three((n, k, p) => binomial(whole(n), whole(k), p)),
  binomialtail: three((n, k, p) => binomialtail(whole(n), whole(k), p)),
  invbinomial: three((n, k, p) => invbinomial(whole(n), whole(k), p)),
  invbinomialtail: three((n, k, p) => invbinomialtail(whole(n), whole(k), p)),
  // A negative count, however close to zero, is missing; a count is
  // otherwise truncated to a whole number.
  poissonp: two((m, k) => (k < 0 ? MISSING : poissonp(m, whole(k)))),
  poisson: two((m, k) => (k < 0 ? MISSING : poisson(m, whole(k)))),
  poissontail: two((m, k) => (k < 0 ? MISSING : poissontail(m, whole(k)))),
  invpoisson: two((k, p) => invpoisson(whole(k), p)),
  invpoissontail: two((k, q) => invpoissontail(whole(k), q)),
  hypergeometricp: {
    args: [N, N, N, N],
    returns: N,
    fn: (...a) => hypergeometricp(...a.map(whole)),
  },
  hypergeometric: {
    args: [N, N, N, N],
    returns: N,
    fn: (...a) => hypergeometric(...a.map(whole)),
  },
  binormal: three(binormal),
  nchi2: three(nchi2),
  invnchi2: three(invnchi2),
  npnchi2: three(npnchi2),

  lnigammaden: three((a, b, x) =>
    a > 0 && b > 0 && x > 0
      ? a * Math.log(b) - lngamma(a) - (a + 1) * Math.log(x) - b / x
      : MISSING,
  ),
  igaussian: three(igaussian),
  igaussiantail: three((m, a, x) => {
    const p = igaussian(m, a, x);
    return isMissing(p) ? p : 1 - p;
  }),
  igaussianden: three((m, a, x) =>
    x > 0 ? Math.exp(lnigaussianden(m, a, x)) : m > 0 && a > 0 ? 0 : MISSING,
  ),
  lnigaussianden: three(lnigaussianden),
  exponential: two(positive((b, x) => (x < 0 ? MISSING : -Math.expm1(-x / b)))),
  exponentialden: two(
    positive((b, x) => (x < 0 ? MISSING : Math.exp(-x / b) / b)),
  ),
  exponentialtail: two(
    positive((b, x) => (x < 0 ? MISSING : Math.exp(-x / b))),
  ),
  // The inverses take probabilities strictly between 0 and 1.
  invexponential: two(
    positive((b, p) => (p > 0 && p < 1 ? -b * Math.log1p(-p) : MISSING)),
  ),
  invexponentialtail: two(
    positive((b, q) => (q > 0 && q < 1 ? -b * Math.log(q) : MISSING)),
  ),
  logistic: located((m, s, x) => 1 / (1 + Math.exp(-(x - m) / s))),
  logisticden: located((m, s, x) => {
    const e = Math.exp(-Math.abs(x - m) / s);
    return e / (s * (1 + e) ** 2);
  }),
  logistictail: located((m, s, x) => 1 / (1 + Math.exp((x - m) / s))),
  invlogistic: located((m, s, p) =>
    p > 0 && p < 1 ? m + s * Math.log(p / (1 - p)) : MISSING,
  ),
  invlogistictail: located((m, s, q) =>
    q > 0 && q < 1 ? m + s * Math.log((1 - q) / q) : MISSING,
  ),
  cauchy: three((a, b, x) =>
    b > 0 ? 0.5 + Math.atan((x - a) / b) / Math.PI : MISSING,
  ),
  cauchytail: three((a, b, x) =>
    b > 0 ? 0.5 - Math.atan((x - a) / b) / Math.PI : MISSING,
  ),
  cauchyden: three((a, b, x) =>
    b > 0 ? 1 / (Math.PI * b * (1 + ((x - a) / b) ** 2)) : MISSING,
  ),
  lncauchyden: three((a, b, x) =>
    b > 0 ? -Math.log(Math.PI * b) - Math.log1p(((x - a) / b) ** 2) : MISSING,
  ),
  invcauchy: three(
    unit((a, b, p) =>
      b > 0 && p > 0 && p < 1 ? a + b * Math.tan(Math.PI * (p - 0.5)) : MISSING,
    ),
  ),
  invcauchytail: three(
    unit((a, b, q) =>
      b > 0 && q > 0 && q < 1 ? a - b * Math.tan(Math.PI * (q - 0.5)) : MISSING,
    ),
  ),
  laplace: three((m, b, x) =>
    b > 0
      ? x < m
        ? 0.5 * Math.exp((x - m) / b)
        : 1 - 0.5 * Math.exp(-(x - m) / b)
      : MISSING,
  ),
  laplacetail: three((m, b, x) =>
    b > 0
      ? x < m
        ? 1 - 0.5 * Math.exp((x - m) / b)
        : 0.5 * Math.exp(-(x - m) / b)
      : MISSING,
  ),
  laplaceden: three((m, b, x) =>
    b > 0 ? Math.exp(-Math.abs(x - m) / b) / (2 * b) : MISSING,
  ),
  lnlaplaceden: three((m, b, x) =>
    b > 0 ? -Math.abs(x - m) / b - Math.log(2 * b) : MISSING,
  ),
  invlaplace: three((m, b, p) =>
    b > 0 && p > 0 && p < 1
      ? p < 0.5
        ? m + b * Math.log(2 * p)
        : m - b * Math.log(2 * (1 - p))
      : MISSING,
  ),
  invlaplacetail: three((m, b, q) =>
    b > 0 && q > 0 && q < 1
      ? q > 0.5
        ? m + b * Math.log(2 * (1 - q))
        : m - b * Math.log(2 * q)
      : MISSING,
  ),
  weibull: WEIBULL.cdf,
  weibulltail: WEIBULL.tail,
  weibullden: WEIBULL.den,
  invweibull: WEIBULL.inverse,
  invweibulltail: WEIBULL.inverseTail,
  weibullph: WEIBULLPH.cdf,
  weibullphtail: WEIBULLPH.tail,
  weibullphden: WEIBULLPH.den,
  invweibullph: WEIBULLPH.inverse,
  invweibullphtail: WEIBULLPH.inverseTail,
  nbinomialp: three((n, k, p) =>
    k < 0 ? MISSING : nbinomialp(n, whole(k), p),
  ),
  nbinomial: three((n, k, p) =>
    n > 0 && p > 0 && p <= 1
      ? k < 0
        ? MISSING
        : p === 1
          ? 1
          : ibeta(n, whole(k) + 1, p)
      : MISSING,
  ),
  nbinomialtail: three((n, k, p) =>
    n > 0 && p > 0 && p <= 1
      ? k < 0
        ? MISSING
        : whole(k) <= 0
          ? 1
          : p === 1
            ? 0
            : ibeta(whole(k), n, 1 - p)
      : MISSING,
  ),

  ustrregexm: {
    args: [S, S, N],
    min: 2,
    returns: N,
    state: true,
    lenient: true,
    fn: (state, s, pattern, noc = 0) => {
      const re = icu(pattern, noc !== 0);
      if (!re) {
        state.umatch = null;
        return -1;
      }
      state.umatch = re.exec(s);
      return Number(!!state.umatch);
    },
  },
  ustrregexs: {
    args: [N],
    returns: S,
    state: true,
    fn: (state, n) => state.umatch?.[whole(n)] ?? "",
  },
  ustrregexrf: {
    args: [S, S, S, N],
    min: 3,
    returns: S,
    state: true,
    lenient: true,
    fn: (state, s, pattern, to, noc = 0) =>
      regexReplace(state, s, pattern, to, noc, false),
  },
  ustrregexra: {
    args: [S, S, S, N],
    min: 3,
    returns: S,
    state: true,
    lenient: true,
    fn: (state, s, pattern, to, noc = 0) =>
      regexReplace(state, s, pattern, to, noc, true),
  },
  ustrtrim: { args: [S], returns: S, fn: (s) => s.replace(SPACE, "") },
  ustrltrim: {
    args: [S],
    returns: S,
    fn: (s) => s.replace(/^[\s\u0085᠎]+/u, ""),
  },
  ustrrtrim: {
    args: [S],
    returns: S,
    fn: (s) => s.replace(/[\s\u0085᠎]+$/u, ""),
  },
  ustrtitle: { args: [S, S], min: 1, returns: S, fn: (s) => ustrtitle(s) },
  ustrleft: {
    args: [S, N],
    returns: S,
    lenient: true,
    fn: (s, n) =>
      isMissing(n)
        ? s
        : characters(s)
            .slice(0, Math.max(0, whole(n)))
            .join(""),
  },
  ustrright: {
    args: [S, N],
    returns: S,
    lenient: true,
    fn: (s, n) => {
      if (isMissing(n)) return s;
      const list = characters(s),
        count = Math.max(0, whole(n));
      return count ? list.slice(Math.max(0, list.length - count)).join("") : "";
    },
  },
  ustrword: {
    args: [S, N, S],
    min: 2,
    returns: S,
    fn: (s, n) => {
      const list = unicodeWords(s),
        k = whole(n);
      return (k > 0 ? list[k - 1] : k < 0 ? list[list.length + k] : "") ?? "";
    },
  },
  ustrwordcount: {
    args: [S, S],
    min: 1,
    returns: N,
    fn: (s) => unicodeWords(s).length,
  },
  ustrcompare: {
    args: [S, S, S],
    min: 2,
    returns: N,
    fn: (a, b, locale) => {
      // Stata's default locale for functions, en_US_POSIX, puts the
      // ASCII characters in their code order, capitals first.
      return Math.sign(collator(locale || "en_US_POSIX").compare(a, b));
    },
  },
  ustrnormalize: {
    args: [S, S],
    returns: S,
    fn: (s, form) => {
      const name = { nfc: "NFC", nfd: "NFD", nfkc: "NFKC", nfkd: "NFKD" }[
        form.toLowerCase()
      ];
      return name ? s.normalize(name) : "";
    },
  },
  ustrtohex: {
    args: [S, N],
    min: 1,
    returns: S,
    lenient: true,
    fn: (s, n = 1) => {
      const start = isMissing(n) ? 1 : Math.max(1, whole(n));
      return characters(s)
        .slice(start - 1, start - 1 + 200)
        .map((c) => hex(c.codePointAt(0)))
        .join("");
    },
  },
  ustrunescape: { args: [S], returns: S, fn: ustrunescape },
  uchar: {
    args: [N],
    returns: S,
    fn: (n) => {
      const code = whole(n);
      return code >= 1 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    },
  },
  uisdigit: { args: [S], returns: N, fn: firstIs(/^\p{Nd}$/u) },
  uisletter: { args: [S], returns: N, fn: firstIs(/^\p{L}$/u) },
  ustrrpos: {
    args: [S, S, N],
    min: 2,
    returns: N,
    lenient: true,
    fn: (s, find, n) => {
      if (find === "") return 0;
      const list = characters(s),
        upto =
          n === undefined || isMissing(n)
            ? list.length
            : Math.min(list.length, whole(n)),
        head = list.slice(0, upto).join(""),
        at = head.lastIndexOf(find);
      return at < 0 ? 0 : characters(head.slice(0, at)).length + 1;
    },
  },
  ustrinvalidcnt: { args: [S], returns: N, fn: () => 0 },
  ustrfix: { args: [S, S], min: 1, returns: S, fn: (s) => s },
  soundex: { args: [S], returns: S, fn: (s) => soundexOf(s, false) },
  soundex_nara: { args: [S], returns: S, fn: (s) => soundexOf(s, true) },
  tobytes: {
    args: [S, N],
    min: 1,
    returns: S,
    lenient: true,
    fn: (s, n = 0) => tobytes(s, n),
  },
  plural: {
    args: [N, S, S],
    min: 2,
    returns: S,
    lenient: true,
    fn: (n, s, rule) => {
      if (n === 1 || n === -1) return s;
      if (rule === undefined) return s + "s";
      if (rule.startsWith("+")) return s + rule.slice(1);
      if (rule.startsWith("-"))
        return s.endsWith(rule.slice(1))
          ? s.slice(0, s.length - rule.length + 1)
          : s;
      return rule;
    },
  },
  indexnot: {
    args: [S, S],
    returns: N,
    fn: (s, set) => {
      for (let i = 0; i < s.length; i++) if (!set.includes(s[i])) return i + 1;
      return 0;
    },
  },
};
// Stata 18's names for the ICU regular-expression functions.
for (const [alias, name] of Object.entries({
  regexmatch: "ustrregexm",
  regexreplace: "ustrregexrf",
  regexreplaceall: "ustrregexra",
  regexcapture: "ustrregexs",
  log1p: "ln1p",
  log1m: "ln1m",
}))
  MORE_FUNCTIONS[alias] = MORE_FUNCTIONS[name];

/**
 * Functions Stata has that the browser does not yet; naming one is refused
 * as not available, where an unknown name is r(133).
 */
export const UNAVAILABLE_FUNCTIONS = new Set(
  `ustrsortkey ustrsortkeyex ustrcompareex ustrto ustrfrom collatorlocale
  collatorversion wordbreaklocale regexcapturenamed fileexists fileread
  filewrite lnwishartden lniwishartden lnmvnormalden lnmvtden rbeta rchi2
  rgamma rhypergeometric rigaussian rnbinomial rt dunnettprob invdunnettprob
  tukeyprob invtukeyprob _caller`.split(/\s+/),
);
