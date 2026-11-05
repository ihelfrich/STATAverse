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
export function regress(rows, dependent, predictors, robust = false) {
  const names = [...predictors, "_cons"];
  const sample = rows.filter((r) =>
    [dependent, ...predictors].every(
      (k) => !missing(r[k]) && typeof r[k] === "number",
    ),
  );
  const n = sample.length,
    k = names.length,
    df = n - k;
  if (df <= 0)
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
  if (robust) {
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
  const critical = jStat.studentt.inv(0.975, df);
  const coefficients = names.map((name, i) => {
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
    covariance: covariance.to2DArray(),
    sse,
    tss,
    r2: tss > 0 ? 1 - sse / tss : null,
    rmse: Math.sqrt(sse / df),
    sample,
    fitted,
    residuals,
  };
}
