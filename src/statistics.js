import {
  Matrix,
  QrDecomposition,
  inverse,
  SingularValueDecomposition,
} from "ml-matrix";
import jstat from "jstat";
const { jStat } = jstat;

export const missing = (value) =>
  value === null ||
  value === undefined ||
  (typeof value === "number" && !Number.isFinite(value));
export const mean = (values) => {
  const scale = Math.max(...values.map(Math.abs));
  return scale
    ? (values.reduce((sum, value) => sum + value / scale, 0) / values.length) *
        scale
    : 0;
};
// Stata's default percentile rule: with P = n*p/100, average the Pth and
// (P+1)th ordered values when P is an integer, otherwise take the next one up.
export function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const position = (n * p) / 100;
  if (Number.isInteger(position))
    return position >= n
      ? sorted[n - 1]
      : position < 1
        ? sorted[0]
        : (sorted[position - 1] + sorted[position]) / 2;
  return sorted[Math.ceil(position) - 1];
}
const TABSTAT = {
  n: (s) => s.n,
  mean: (s) => s.mean,
  sum: (s) => (s.n ? s.sum : null),
  min: (s) => s.min,
  max: (s) => s.max,
  range: (s) => (s.n ? s.max - s.min : null),
  sd: (s) => s.sd,
  variance: (s) => (s.sd === null ? null : s.sd ** 2),
  cv: (s) => (s.sd === null || !s.mean ? null : s.sd / s.mean),
  semean: (s) => (s.sd === null ? null : s.sd / Math.sqrt(s.n)),
  iqr: (s) =>
    s.n ? percentile(s.sorted, 75) - percentile(s.sorted, 25) : null,
};
for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99])
  TABSTAT[`p${p}`] = (s) => percentile(s.sorted, p);
const TABSTAT_ALIASES = { count: "n", var: "variance", median: "p50" };
export function tabstatName(word) {
  const name = TABSTAT_ALIASES[word] || word;
  return Object.hasOwn(TABSTAT, name) ? name : null;
}
export function tabstatValues(values, statistics) {
  const sorted = values
      .filter((v) => typeof v === "number" && !missing(v))
      .sort((a, b) => a - b),
    base = {
      ...summarize(values),
      sorted,
      sum: sorted.reduce((total, v) => total + v, 0),
    };
  return statistics.map((name) => {
    const value = TABSTAT[name](base);
    return value === undefined || !Number.isFinite(value) ? null : value;
  });
}
export function summarize(values) {
  const x = values.filter((v) => typeof v === "number" && !missing(v));
  if (!x.length) return { n: 0, mean: null, sd: null, min: null, max: null };
  const m = mean(x),
    scale = Math.max(...x.map(Math.abs));
  const sd =
    x.length > 1
      ? scale
        ? Math.sqrt(
            x.reduce((s, v) => s + (v / scale - m / scale) ** 2, 0) /
              (x.length - 1),
          ) * scale
        : 0
      : null;
  if (!Number.isFinite(m) || (sd !== null && !Number.isFinite(sd)))
    throw new Error(
      "The values exceed the numerical range for this summary. Rescale the variable.",
    );
  return { n: x.length, mean: m, sd, min: Math.min(...x), max: Math.max(...x) };
}

export function correlation(a, b) {
  const sa = Math.max(...a.map(Math.abs)),
    sb = Math.max(...b.map(Math.abs));
  if (!sa || !sb) return null;
  const ax = a.map((v) => v / sa),
    bx = b.map((v) => v / sb),
    ma = mean(ax),
    mb = mean(bx);
  const cross = ax.reduce((s, v, i) => s + (v - ma) * (bx[i] - mb), 0);
  const denominator = Math.sqrt(
    ax.reduce((s, v) => s + (v - ma) ** 2, 0) *
      bx.reduce((s, v) => s + (v - mb) ** 2, 0),
  );
  return denominator ? Math.max(-1, Math.min(1, cross / denominator)) : null;
}

// Parameter order is predictors followed by the constant, as displayed by Stata.
// Center/scale before QR; transform coefficients and covariance back to original units.
export function regress(
  rows,
  dependent,
  predictors,
  robust = false,
  { allowSaturated = false } = {},
) {
  const names = [...predictors, "_cons"];
  const sample = rows.filter((r) =>
    [dependent, ...predictors].every(
      (k) => !missing(r[k]) && typeof r[k] === "number",
    ),
  );
  const n = sample.length,
    k = names.length,
    df = n - k;
  if (df < 0 || (df === 0 && !allowSaturated))
    throw new Error(
      `Only ${n} complete observations for ${k} coefficients. More observations are needed for inference.`,
    );
  if (
    sample.some((r) =>
      [dependent, ...predictors].some((name) => Math.abs(r[name]) > 1e100),
    )
  )
    throw new Error(
      "Regression values exceed the numerical range supported here (absolute value 1e100). Rescale the variables.",
    );
  const centers = predictors.map((p) => mean(sample.map((r) => r[p])));
  const scales = predictors.map((p, j) =>
    Math.sqrt(sample.reduce((s, r) => s + (r[p] - centers[j]) ** 2, 0) / n),
  );
  if (scales.some((s) => !s || !Number.isFinite(s)))
    throw new Error(
      "A predictor is constant in this sample. Remove it and run the regression again.",
    );
  const X = new Matrix(
    sample.map((r) => [
      ...predictors.map((p, j) => (r[p] - centers[j]) / scales[j]),
      1,
    ]),
  );
  const svd = new SingularValueDecomposition(X, { autoTranspose: true });
  if (svd.condition > 1e10 || svd.rank < k)
    throw new Error(
      "The predictors are collinear or too nearly collinear for this practice environment. Remove a redundant predictor.",
    );
  const qr = new QrDecomposition(X);
  const scaledB = qr.solve(
    Matrix.columnVector(sample.map((r) => r[dependent])),
  );
  const transform = Matrix.zeros(k, k);
  for (let j = 0; j < k - 1; j++) {
    transform.set(j, j, 1 / scales[j]);
    transform.set(k - 1, j, -centers[j] / scales[j]);
  }
  transform.set(k - 1, k - 1, 1);
  const b = transform.mmul(scaledB).to1DArray();
  const fitted = X.mmul(scaledB).to1DArray();
  const residuals = sample.map((r, i) => r[dependent] - fitted[i]);
  const sse = residuals.reduce((s, e) => s + e * e, 0);
  const ybar = mean(sample.map((r) => r[dependent]));
  const tss = sample.reduce((s, r) => s + (r[dependent] - ybar) ** 2, 0);
  // R^-1 R^-T gives (X'X)^-1 without forming the unscaled normal equations.
  const ri = inverse(qr.upperTriangularMatrix);
  const bread = ri.mmul(ri.transpose());
  let covariance;
  if (df === 0) covariance = Matrix.zeros(k, k);
  else if (robust) {
    const meat = Matrix.zeros(k, k);
    for (let i = 0; i < n; i++)
      for (let a = 0; a < k; a++)
        for (let c = 0; c < k; c++)
          meat.set(
            a,
            c,
            meat.get(a, c) + X.get(i, a) * X.get(i, c) * residuals[i] ** 2,
          );
    covariance = bread
      .mmul(meat)
      .mmul(bread)
      .mul(n / df);
  } else covariance = bread.clone().mul(sse / df);
  covariance = transform.mmul(covariance).mmul(transform.transpose());
  if (
    ![...b, ...fitted, sse, tss, ...covariance.to1DArray()].every(
      Number.isFinite,
    )
  )
    throw new Error(
      "Numerical overflow in regression. Rescale the variables before estimating.",
    );
  const critical = df > 0 ? jStat.studentt.inv(0.975, df) : null;
  const coefficients = names.map((name, i) => {
    if (df === 0)
      return { name, b: b[i], se: null, t: null, p: null, lo: null, hi: null };
    const se = Math.sqrt(Math.max(0, covariance.get(i, i)));
    const t = se > 0 ? b[i] / se : null;
    const p =
      t === null
        ? null
        : Math.min(1, Math.max(0, 2 * jStat.studentt.cdf(-Math.abs(t), df)));
    return {
      name,
      b: b[i],
      se,
      t,
      p,
      lo: b[i] - critical * se,
      hi: b[i] + critical * se,
    };
  });
  return {
    dependent,
    predictors,
    n,
    k,
    df,
    robust,
    coefficients,
    covariance:
      df > 0
        ? covariance.to2DArray()
        : Array.from({ length: k }, () => Array(k).fill(null)),
    sse,
    tss,
    r2: tss > 0 ? 1 - sse / tss : null,
    rmse: df > 0 ? Math.sqrt(sse / df) : null,
    sample,
    fitted,
    residuals,
  };
}

// One linear combination w'b of fitted coefficients with its t inference.
export function linearCombination(model, weights) {
  const b = model.coefficients.map((c) => c.b),
    V = model.covariance,
    estimate = weights.reduce((s, w, i) => s + w * b[i], 0),
    variance = weights.reduce(
      (s, wi, i) => s + weights.reduce((t, wj, j) => t + wi * wj * V[i][j], 0),
      0,
    ),
    se = Math.sqrt(Math.max(0, variance));
  if (!(se > 0)) return { estimate, se, t: null, p: null, lo: null, hi: null };
  const t = estimate / se,
    critical = jStat.studentt.inv(0.975, model.df);
  return {
    estimate,
    se,
    t,
    p: Math.min(1, 2 * jStat.studentt.cdf(-Math.abs(t), model.df)),
    lo: estimate - critical * se,
    hi: estimate + critical * se,
  };
}
// Wald F test of R b = r using the fitted covariance, as Stata's test does
// after regress.
export function linearTest(model, constraints) {
  const b = model.coefficients.map((c) => c.b),
    q = constraints.length,
    R = new Matrix(constraints.map((c) => c.weights)),
    gap = new Matrix(
      constraints.map((c) => [
        c.weights.reduce((s, w, i) => s + w * b[i], 0) - c.value,
      ]),
    ),
    middle = R.mmul(new Matrix(model.covariance)).mmul(R.transpose());
  const svd = new SingularValueDecomposition(middle, { autoTranspose: true }),
    largest = Math.max(...svd.diagonal);
  if (!(largest > 0) || Math.min(...svd.diagonal) < largest * 1e-12)
    return null;
  const F = gap.transpose().mmul(inverse(middle)).mmul(gap).get(0, 0) / q;
  return {
    F,
    q,
    df: model.df,
    p: Math.min(1, Math.max(0, 1 - jStat.centralF.cdf(F, q, model.df))),
  };
}
