import jStat from "jstat";
import { seededRandom } from "./regression-model.js";

import { IV_DEFAULTS, IV_PRESETS, ivParameters } from "./iv-parameters.js";
export { IV_DEFAULTS, IV_PRESETS, ivParameters };

export function ivData(options = {}) {
  const p = ivParameters(options),
    random = seededRandom(p.seed);
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Array.from({ length: p.n }, (_, i) => {
    const z = normal(),
      v = normal(),
      e = normal(),
      x = p.pi * z + v;
    const u = p.sigma * (p.rho * v + Math.sqrt(1 - p.rho ** 2) * e);
    return { id: i + 1, z, x, y: 2 + p.beta * x + p.delta * z + u, u, v, e };
  });
}
const sum = (a) => a.reduce((s, x) => s + x, 0);
const dot = (a, b) => sum(a.map((x, i) => x * b[i]));
const mean = (a) => sum(a) / a.length;
const centered = (a) => {
  const m = mean(a);
  return a.map((x) => x - m);
};
function inference(b, variance, df, confidence) {
  const se = Math.sqrt(Math.max(0, variance)),
    critical = jStat.studentt.inv((1 + confidence) / 2, df);
  const t = se > 0 ? b / se : null;
  return {
    b,
    se,
    t,
    p: t === null ? null : 2 * jStat.studentt.cdf(-Math.abs(t), df),
    lo: b - critical * se,
    hi: b + critical * se,
    df,
  };
}
function ols(x, y, p) {
  const n = x.length,
    xc = centered(x),
    yc = centered(y),
    xx = dot(xc, xc),
    b = dot(xc, yc) / xx,
    intercept = mean(y) - b * mean(x);
  const residuals = y.map((v, i) => v - intercept - b * x[i]);
  const variance = p.robust
    ? ((n / (n - 2)) * sum(residuals.map((u, i) => u * u * xc[i] * xc[i]))) /
      (xx * xx)
    : dot(residuals, residuals) / (n - 2) / xx;
  return {
    ...inference(b, variance, n - 2, p.confidence),
    intercept,
    residuals,
    fitted: x.map((v) => intercept + b * v),
    r2: 1 - dot(residuals, residuals) / dot(yc, yc),
  };
}

/** Solve a*t²+b*t+c <= 0 without imposing a finite search window. */
export function quadraticSet(a, b, c) {
  if (![a, b, c].every(Number.isFinite))
    throw new Error("Non-finite confidence-set coefficients.");
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return { kind: "all", intervals: [[-Infinity, Infinity]] };
  a /= scale;
  b /= scale;
  c /= scale;
  if (a === 0) {
    if (b === 0)
      return c <= 0
        ? { kind: "all", intervals: [[-Infinity, Infinity]] }
        : { kind: "empty", intervals: [] };
    return {
      kind: "half-line",
      intervals: b > 0 ? [[-Infinity, -c / b]] : [[-c / b, Infinity]],
    };
  }
  const d = b * b - 4 * a * c;
  if (d < 0)
    return a < 0
      ? { kind: "all", intervals: [[-Infinity, Infinity]] }
      : { kind: "empty", intervals: [] };
  if (d === 0)
    return a < 0
      ? { kind: "all", intervals: [[-Infinity, Infinity]] }
      : { kind: "singleton", intervals: [[-b / (2 * a), -b / (2 * a)]] };
  const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(d));
  const roots = [q / a, c / q].sort((x, y) => x - y);
  return a > 0
    ? { kind: "bounded", intervals: [roots] }
    : {
        kind: "two-rays",
        intervals: [
          [-Infinity, roots[0]],
          [roots[1], Infinity],
        ],
      };
}
export function inConfidenceSet(set, b) {
  if (set.kind === "unavailable") return null;
  return set.intervals.some(([lo, hi]) => b >= lo && b <= hi);
}

export function ivFit(rows, options = {}) {
  const p = ivParameters(options),
    n = rows.length;
  if (
    n < 3 ||
    n > 2000 ||
    rows.some(
      (r) =>
        ![r.x, r.y, r.z].every(
          (v) =>
            typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12,
        ),
    )
  )
    throw new Error(
      "Use 3–2,000 complete, finite observations with magnitudes at most 10¹².",
    );
  const x = rows.map((r) => r.x),
    y = rows.map((r) => r.y),
    z = rows.map((r) => r.z),
    xc = centered(x),
    yc = centered(y),
    zc = centered(z);
  const sxx = dot(xc, xc),
    szz = dot(zc, zc),
    szx = dot(zc, xc),
    szy = dot(zc, yc);
  if (!(sxx > 0 && szz > 0 && dot(yc, yc) > 0))
    throw new Error("x, y and z must each vary in this sample.");
  const first = ols(z, x, p),
    reduced = ols(z, y, p),
    ordinary = ols(x, y, p);
  const corr = szx / Math.sqrt(sxx * szz),
    numericalSingular = Math.abs(corr) <= 1e-12;
  let iv = null,
    naive = null;
  if (!numericalSingular) {
    const b = szy / szx,
      intercept = mean(y) - b * mean(x),
      residuals = y.map((v, i) => v - intercept - b * x[i]);
    const h = (szx * szx) / szz,
      s2 = dot(residuals, residuals) / (n - 2);
    let variance = s2 / h,
      vIntercept = s2 * (1 / n + mean(x) ** 2 / h),
      covariance = (-s2 * mean(x)) / h;
    if (p.robust) {
      const l1 = zc.map((v) => v / szx),
        l0 = l1.map((v) => 1 / n - mean(x) * v),
        factor = n / (n - 2);
      variance = factor * sum(residuals.map((u, i) => u * u * l1[i] ** 2));
      vIntercept = factor * sum(residuals.map((u, i) => u * u * l0[i] ** 2));
      covariance = factor * sum(residuals.map((u, i) => u * u * l0[i] * l1[i]));
    }
    iv = {
      ...inference(b, variance, n - 2, p.confidence),
      intercept,
      residuals,
      covariance: [
        [variance, covariance],
        [covariance, vIntercept],
      ],
      moment: dot(zc, residuals) / n,
    };
    naive = ols(first.fitted, y, p);
  }
  const weights = zc.map((v) =>
    p.robust ? ((n / (n - 2)) * v * v) / (szz * szz) : 1 / ((n - 2) * szz),
  );
  const rx = first.residuals,
    ry = reduced.residuals;
  const vxx = sum(rx.map((v, i) => weights[i] * v * v)),
    vxy = sum(rx.map((v, i) => weights[i] * v * ry[i])),
    vyy = sum(ry.map((v, i) => weights[i] * v * v));
  const critical = jStat.studentt.inv((1 + p.confidence) / 2, n - 2) ** 2;
  const coefficients = [
    first.b ** 2 - critical * vxx,
    -2 * reduced.b * first.b + 2 * critical * vxy,
    reduced.b ** 2 - critical * vyy,
  ];
  const covarianceDegenerate = !(
    vxx > 0 &&
    vyy > 0 &&
    vxx * vyy - vxy * vxy > 64 * Number.EPSILON * vxx * vyy
  );
  const ar = {
    ...(covarianceDegenerate
      ? {
          kind: "unavailable",
          intervals: [],
          reason:
            "The reduced-form residual covariance is numerically singular; the Anderson–Rubin confidence set is unavailable.",
        }
      : quadraticSet(...coefficients)),
    coefficients,
    critical,
    vxx,
    vxy,
    vyy,
    weights,
    rx,
    ry,
    df: n - 2,
  };
  const numericalResults = [first, reduced, ordinary, iv, naive].filter(
    Boolean,
  );
  if (
    numericalResults.some(
      (m) => ![m.b, m.se, m.intercept, m.lo, m.hi].every(Number.isFinite),
    ) ||
    ![vxx, vxy, vyy, ...coefficients].every(Number.isFinite)
  )
    throw new Error(
      "These scales exceed the lab's numerical range. Rescale x, y or z.",
    );
  return {
    parameters: p,
    rows,
    n,
    first,
    reduced,
    ols: ordinary,
    iv,
    naive,
    ar,
    numericalSingular,
    firstF: first.t === null ? null : first.t ** 2,
    population: {
      beta: p.beta,
      first: p.pi,
      reduced: p.pi * p.beta + p.delta,
      ols: p.beta + (p.delta * p.pi + p.sigma * p.rho) / (p.pi ** 2 + 1),
      iv: p.pi === 0 ? null : p.beta + p.delta / p.pi,
      valid: p.delta === 0,
      identified: p.pi !== 0,
    },
  };
}
export function ivSample(options = {}) {
  const p = ivParameters(options);
  return ivFit(ivData(p), p);
}
export function arTest(sample, b) {
  if (!Number.isFinite(b) || Math.abs(b) > 1e12)
    throw new Error(
      "The candidate coefficient must be finite and no larger than 10¹² in magnitude.",
    );
  const { ar, first, reduced } = sample;
  if (ar.kind === "unavailable")
    return { f: null, p: null, accepted: null, reason: ar.reason };
  // Residual squares avoid cancellation in the variance polynomial near a fit.
  const variance = sum(
    ar.ry.map((v, i) => ar.weights[i] * (v - b * ar.rx[i]) ** 2),
  );
  if (!(variance > 0))
    return {
      f: null,
      p: null,
      accepted: null,
      reason: "The transformed regression has zero estimated variance.",
    };
  const t = (reduced.b - b * first.b) / Math.sqrt(variance),
    f = t * t;
  return {
    f,
    p: 2 * jStat.studentt.cdf(-Math.abs(t), ar.df),
    accepted: f <= ar.critical,
  };
}
export function ivCSV(sample) {
  const keys = ["id", "z", "x", "y", "u", "v", "e"];
  return (
    keys.join(",") +
    "\n" +
    sample.rows.map((r) => keys.map((k) => r[k]).join(",")).join("\n") +
    "\n"
  );
}
export function ivDoFile(sample, candidate = 0) {
  arTest(sample, candidate);
  const p = sample.parameters,
    vce = p.robust ? " vce(robust)" : "",
    level = p.confidence * 100;
  return [
    "* STATAverse: exact exported synthetic sample, one instrument and one endogenous regressor.",
    "* Use the folder containing this file and iv-sample.csv as your working directory.",
    "clear all",
    "set more off",
    `set level ${level}`,
    'import delimited using "iv-sample.csv", clear asdouble',
    `* Population: beta=${p.beta}; pi=${p.pi}; rho=${p.rho}; delta=${p.delta}; sigma=${p.sigma}.`,
    `* Seed ${p.seed} belongs to the browser generator. The CSV preserves the exact draws.`,
    "",
    "* First stage; the excluded-instrument F uses the selected covariance.",
    `regress x z,${vce} level(${level})`,
    "test z",
    "predict double xhat, xb",
    "",
    "* Reduced form and OLS, using the same rows.",
    `regress y z,${vce} level(${level})`,
    `regress y x,${vce} level(${level})`,
    "",
    "* Correct 2SLS: small requests t/F inference and the n/(n-2) correction.",
    `ivregress 2sls y (x = z), small${vce} level(${level})`,
    "estimates store correct_iv",
    "",
    "* Demonstration only: same slope, incorrect second-stage standard errors.",
    `regress y xhat,${vce} level(${level})`,
    "",
    `* Anderson-Rubin test of beta = ${candidate}; valid-instrument assumptions still required.`,
    `generate double ar_outcome = y - (${candidate})*x`,
    `regress ar_outcome z,${vce} level(${level})`,
    "test z",
    "",
    "* Stata 19+: official weak-instrument-robust confidence set.",
    "* estimates restore correct_iv",
    `* estat weakrobust, ar ci level(${level})`,
    "* An unbounded or disconnected set is a legitimate result, not an export error.",
    "",
  ].join("\n");
}
