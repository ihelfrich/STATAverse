// areg, and what follows ivregress: the first-stage regressions and
// estat firststage, endogenous and overid.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { evaluateAll } from "./expression.js";
import { project } from "./diagnostics.js";
import {
  HIDDEN,
  HISTORICAL,
  RULE,
  coefficientHeader,
  coefficientSpace,
  stripeName,
  symmetricRank,
  coefficientRows,
  design,
  fit,
  invertSymmetric,
  quadratic,
  statisticCell,
  tableWidth,
  abbreviate,
  termRows,
} from "./estimation.js";
import { count } from "./reports.js";
import { assumedWeights, genericWeight } from "./syntax.js";
import { STOCK_YOGO } from "./stock-yogo.js";
import { MISSING, isMissing } from "./values.js";
import { clusterMeat, noCluster, readVce } from "./vce.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const six = (value) => g(value, "%8.0g");
const four = (value) => applyFormat(value, "%6.4f");

/** Prints the first-stage regression of each endogenous variable. */
export function firstStage(session, iv, parsed, ctx) {
  ctx.out("");
  ctx.out("First-stage regressions");
  ctx.out("-----------------------");
  const clustered = /^cluster /.test(iv.vce ?? "");
  for (const name of iv.endogenous) {
    const model = fit(
      session,
      {
        anything: [name, iv.texts.exogenous, iv.texts.instruments]
          .filter(Boolean)
          .join(" "),
        // The variance of the main equation, robust or clustered too.
        options: { level: 95, vce: iv.vce },
        // The first stage uses the observations of the main equation.
        only: new Set(iv.rows),
      },
      null,
    );
    // A robust or clustered first stage counts each factor's base level
    // among the coefficients in its small-sample factor N/(N - k), as
    // Stata's does; how it counts the base cells of an interaction of
    // factors is not known, so that is refused.
    if (iv.vce) {
      if (
        model.columns.some(
          (c) => c.term.components.filter((p) => p.factor).length > 1,
        )
      )
        throw new StataError(
          `option first is not available yet with vce(${iv.vce.split(" ")[0]}) and an interaction of factor variables; type regress ${name} ${iv.texts.exogenous} ${iv.texts.instruments}, vce(${iv.vce}) for the first stage`,
          198,
        );
      const bases = model.columns.filter((c) => c.base && c.term.factor).length;
      if (bases) {
        const scale = model.dfResidual / (model.dfResidual - bases);
        model.V = model.V.map((row) => row.map((v) => v * scale));
        model.F /= scale;
      }
    }
    // Clustered, the first stage keeps the residual degrees of freedom of
    // the regression and tests as many coefficients as the variance
    // allows, which fewer clusters than coefficients limit.
    let df1 = model.df_m;
    if (clustered) {
      model.df_r = model.dfResidual;
      const at = model.names
          .map((n, k) => (n === "_cons" ? -1 : k))
          .filter((k) => k >= 0),
        V = at.map((r) => at.map((c) => model.V[r][c])),
        kept = sweptColumns(V),
        inverse = invertSymmetric(kept.map((r) => kept.map((c) => V[r][c])));
      df1 = kept.length;
      model.F = inverse
        ? quadratic(
            kept.map((k) => model.b[at[k]]),
            inverse,
          ) / df1
        : MISSING;
    }
    const side = clustered
      ? (label, value) =>
          `${" ".repeat(54)}${label.padEnd(16)}=${value.padStart(7)}`
      : (label, value) =>
          `${" ".repeat(56)}${label.padEnd(14)}=${value.padStart(7)}`;
    ctx.out("");
    ctx.out(side("Number of obs", count(model.N)));
    if (clustered) ctx.out(side("No. of clusters", count(model.clusters)));
    ctx.out(
      side(`F(${df1}, ${model.df_r})`, applyFormat(model.F, "%7.2f").trim()),
    );
    ctx.out(side("Prob > F", four(Ftail(df1, model.df_r, model.F)).trim()));
    ctx.out(side("R-squared", four(model.r2).trim()));
    ctx.out(side("Adj R-squared", four(model.r2_a).trim()));
    ctx.out(side("Root MSE", applyFormat(model.rmse, "%7.0g").trim()));
    ctx.out("");
    // Stata prints the first stage at 95% whatever level() says, in a
    // table as wide as its labels need.
    const width = tableWidth(session, model);
    coefficientHeader(model, 95, model.depvar, width).forEach(ctx.out);
    coefficientRows(session, model, 95, width).forEach(ctx.out);
    ctx.out("-".repeat(66 + width));
    ctx.out("");
  }
}

/**
 * The columns a sweep of a symmetric matrix keeps when it takes the
 * largest remaining diagonal first, as Stata inverts a singular variance
 * in part: indices in order.
 */
export function sweptColumns(V) {
  const n = V.length,
    M = V.map((row) => row.slice()),
    done = new Array(n).fill(false),
    kept = [];
  for (;;) {
    let k = -1;
    for (let i = 0; i < n; i++)
      if (!done[i] && (k < 0 || M[i][i] > M[k][k])) k = i;
    if (k < 0 || !(M[k][k] > 1e-10 * V[k][k])) break;
    done[k] = true;
    kept.push(k);
    const d = M[k][k];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== k && j !== k) M[i][j] -= (M[i][k] * M[k][j]) / d;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        M[i][k] /= d;
        M[k][i] /= d;
      }
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Stata's estat firststage makes a variable for each factor level or
 * interaction among the instruments, over the whole dataset, and lets the
 * messages of generate through: one for each such instrument whose
 * variables have missing values anywhere.
 */
function generatedNotes(session, model, ctx) {
  for (const c of model.iv.columns.instruments) {
    if (c.term.variable) continue;
    let missing = 0;
    for (let i = 0; i < session.data.n; i++)
      if (c.term.variables.some((v) => isMissing(v.data[i]))) missing++;
    if (missing)
      ctx.out(
        `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
      );
  }
}

function ivFrame(session, model) {
  // The sample as the observations now stand (see inFitLayout), which
  // iv.rows, the rows at the time of the fit, no longer is once
  // observations are dropped.
  const iv = model.iv,
    rows = model.sample ?? iv.rows,
    column = (c) => rows.map((i) => c.value(i)),
    // The fit's weights, analytic and sampling weights scaled to sum to
    // the observations, while they still match the sample.
    w =
      model.weights && model.weights.length === rows.length
        ? model.weights
        : null;
  return {
    iv,
    // The observations of the sample still in the data, which the
    // auxiliary regressions use, and e(N), which the endogeneity tests
    // count even when some of them have been dropped since.
    n: rows.length,
    N: model.N ?? rows.length,
    // What the weighted statistics count: e(N), frequency weights summed
    // and importance weights by the whole part of their sum.
    count: w ? (model.N ?? rows.length) : rows.length,
    w,
    frequency: model.wtype === "fweight",
    y: rows.map((i) => session.data.get(iv.dep).data[i]),
    endogenous: iv.columns.endogenous.map(column),
    exogenous: iv.columns.exogenous.map(column),
    instruments: iv.columns.instruments.map(column),
  };
}

/**
 * Weighted least squares of y on the columns and, first, a constant: the
 * columns kept (one collinear with those before it is dropped), where
 * each column went (-1 when dropped; the constant is at 0), the
 * coefficients, the inverse of X'WX, and the residuals in y's own scale
 * with their weighted sum of squares.
 */
function leastSquares(columns, y, w, constant = true) {
  const n = y.length,
    weight = (i) => (w ? w[i] : 1),
    all = constant ? [new Array(n).fill(1), ...columns] : columns,
    basis = [],
    kept = [],
    position = [];
  for (const column of all) {
    let rest = column.map((v, i) => v * Math.sqrt(weight(i)));
    const size = rest.reduce((t, v) => t + v * v, 0);
    for (const q of basis) {
      const a = rest.reduce((t, v, i) => t + v * q[i], 0);
      rest = rest.map((v, i) => v - a * q[i]);
    }
    const left = rest.reduce((t, v) => t + v * v, 0);
    if (!size || !(left > 1e-10 * size)) {
      position.push(-1);
      continue;
    }
    basis.push(rest.map((v) => v / Math.sqrt(left)));
    position.push(kept.length);
    kept.push(column);
  }
  const inverse = invertSymmetric(
      kept.map((a) =>
        kept.map((b) => a.reduce((t, v, i) => t + weight(i) * v * b[i], 0)),
      ),
    ),
    b = apply(
      inverse,
      kept.map((a) => a.reduce((t, v, i) => t + weight(i) * v * y[i], 0)),
    ),
    residuals = y.map(
      (v, i) => v - kept.reduce((t, c, k) => t + c[i] * b[k], 0),
    );
  return {
    kept,
    position: constant ? position.slice(1) : position,
    b,
    inverse,
    residuals,
    fitted: y.map((v, i) => v - residuals[i]),
    rss: residuals.reduce((t, e, i) => t + weight(i) * e * e, 0),
  };
}

/**
 * The robust Wald statistic that the coefficients at the positions given
 * are zero, from a fit of leastSquares(): the sandwich with each score
 * weighted as the fit was (a frequency weight counts its observation that
 * many times) and the small-sample factor N/(N - k).
 */
function robustWald(fitted, at, f) {
  const k = fitted.kept.length,
    meat = Array.from({ length: k }, () => new Array(k).fill(0));
  fitted.residuals.forEach((e, i) => {
    const wi = f.w ? f.w[i] : 1,
      s = f.frequency ? wi * e * e : (wi * e) ** 2;
    for (let a = 0; a < k; a++)
      for (let c = 0; c < k; c++)
        meat[a][c] += s * fitted.kept[a][i] * fitted.kept[c][i];
  });
  const V = times(times(fitted.inverse, meat), fitted.inverse).map((row) =>
      row.map((v) => (v * f.count) / (f.count - k)),
    ),
    inverse = invertSymmetric(at.map((r) => at.map((c) => V[r][c])));
  if (!inverse) throw new StataError("the instruments are collinear", 506);
  return quadratic(
    at.map((j) => fitted.b[j]),
    inverse,
  );
}

/** N less the residual sum of squares of 1 on the columns, no constant. */
function scoreStatistic(columns, f) {
  const ones = new Array(f.n).fill(1),
    fitted = leastSquares(columns, ones, f.w, false);
  return f.count - fitted.rss;
}

/** The residuals of the fit as estimated, from e(b). */
function ivResiduals(f, b) {
  const x = [...f.endogenous, ...f.exogenous];
  return f.y.map(
    (value, i) =>
      value - x.reduce((t, column, k) => t + column[i] * b[k], 0) - b[x.length],
  );
}

/** Residuals of a weighted project() in the scale of the variable. */
const unscaled = (residuals, w) =>
  w ? residuals.map((v, i) => v / Math.sqrt(w[i])) : residuals;

/** Refuses what needs a cluster-robust version not yet written. */
function notClustered(model, what) {
  if (model.vce === "cluster")
    throw new StataError(
      `estat ${what} after vce(cluster) is not available yet`,
      198,
    );
}

// ----- after ivregress gmm -----
const withConstant = (columns, n) =>
  Array.from({ length: n }, (_, i) => [...columns.map((c) => c[i]), 1]);
const crossProduct = (A, B) =>
  A[0].map((_, a) =>
    B[0].map((_, c) => A.reduce((t, row, i) => t + row[a] * B[i][c], 0)),
  );
const times = (A, B) =>
  A.map((row) =>
    B[0].map((_, c) => row.reduce((t, v, k) => t + v * B[k][c], 0)),
  );
const apply = (A, v) =>
  A.map((row) => row.reduce((t, w, k) => t + w * v[k], 0));
const transpose = (A) => A[0].map((_, c) => A.map((row) => row[c]));
/** The GMM estimate for a weight matrix, its residuals and J statistic. */
function gmmWith(Z, X, y, W) {
  const zx = crossProduct(Z, X),
    zy = Z[0].map((_, a) => Z.reduce((t, row, i) => t + row[a] * y[i], 0)),
    xzW = times(transpose(zx), W),
    A = invertSymmetric(times(xzW, zx));
  if (!A) throw new StataError("the model is not identified", 481);
  const b = apply(A, apply(xzW, zy)),
    residuals = y.map((v, i) => v - X[i].reduce((t, x, k) => t + x * b[k], 0)),
    n = y.length,
    moments = Z[0].map(
      (_, a) => Z.reduce((t, row, i) => t + row[a] * residuals[i], 0) / n,
    );
  return { b, residuals, J: n * quadratic(moments, W) };
}
const momentCovariance = (Z, e) =>
  Z[0].map((_, a) =>
    Z[0].map(
      (_, c) =>
        Z.reduce((t, row, i) => t + e[i] * e[i] * row[a] * row[c], 0) /
        Z.length,
    ),
  );
const robustGmm = (model, what) => {
  if (!(model.iv.estimator === "gmm" && model.iv.robustWeights))
    throw new StataError(
      `estat ${what} after a robust ivregress is not available yet`,
      198,
    );
};
/** Hansen's J after ivregress gmm, e(J), whatever the weight matrix. */
function overidGmm(session, model, ctx) {
  const f = ivFrame(session, model),
    df = f.instruments.length - f.endogenous.length;
  if (df < 1) {
    ctx.out("no overidentifying restrictions");
    throw new StataError("", 498);
  }
  const J = model.iv.J,
    p = chi2tail(df, J);
  ctx.out("");
  // Stata says restriction, however many there are.
  ctx.out("  Test of overidentifying restriction:");
  ctx.out("");
  // ivregress_estat.ado prints J in %8.0g straight after the equals sign.
  ctx.out(
    `  Hansen's J chi2(${df}) =${applyFormat(J, "%8.0g")} (p = ${four(p)})`,
  );
  ctx.out("");
  session.results.r = { J_df: df, p_HansenJ: p, HansenJ: J };
}
/**
 * The C statistic after ivregress gmm: the J of the model that treats the
 * endogenous regressors as exogenous, less the J of the model as fitted
 * when both use the same moment covariance.
 */
function endogenousGmm(session, model, ctx) {
  robustGmm(model, "endogenous");
  const f = ivFrame(session, model),
    X = withConstant([...f.endogenous, ...f.exogenous], f.n),
    // The instruments as fitted come first, then the regressors on trial.
    kept = [...f.exogenous, ...f.instruments],
    Z = withConstant(kept, f.n),
    wide = Z.map((row, i) => [...row, ...f.endogenous.map((c) => c[i])]),
    first = gmmWith(wide, X, f.y, invertSymmetric(crossProduct(wide, wide))),
    S = momentCovariance(wide, first.residuals),
    W = invertSymmetric(S),
    inner = invertSymmetric(Z[0].map((_, a) => Z[0].map((_, c) => S[a][c])));
  if (!W || !inner) throw new StataError("the weight matrix is singular", 506);
  const C = gmmWith(wide, X, f.y, W).J - gmmWith(Z, X, f.y, inner).J,
    df = f.endogenous.length,
    p = chi2tail(df, C);
  ctx.out("");
  ctx.out("  Test of endogeneity (orthogonality conditions)");
  ctx.out("  H0: Variables are exogenous");
  ctx.out("");
  ctx.out(
    `  GMM C statistic chi2(${df}) = ${six(C).padStart(8)}  (p = ${four(p)})`,
  );
  ctx.out("");
  session.results.r = { p_C: p, C, df };
}

/** Text placed at fixed columns, as Stata's {col #} places it. */
function placed(parts) {
  let line = "";
  for (const [at, text] of parts) line = `${line.padEnd(at)}${text}`;
  return line;
}

/**
 * Shea's partial R-squared of each endogenous regressor: the squared
 * correlation of what is left of it once the other regressors are taken
 * out and what is left of its first-stage fit once the fits of the other
 * endogenous regressors and the exogenous ones are; adjusted by the count
 * of exogenous variables, included and excluded. With one endogenous
 * regressor it is the partial R-squared of the first stage.
 */
function sheaOf(f, partials) {
  const k = f.exogenous.length + f.instruments.length,
    adjust = (r2) => 1 - ((f.count - 1) / (f.count - k)) * (1 - r2);
  if (f.endogenous.length === 1)
    return [{ partial: partials[0], adjusted: adjust(partials[0]) }];
  const z = [...f.exogenous, ...f.instruments],
    fitted = f.endogenous.map((x) => {
      const r = unscaled(project(z, x, f.w).residuals, f.w);
      return x.map((v, i) => v - r[i]);
    });
  return f.endogenous.map((x, j) => {
    const others = f.endogenous.filter((_, k2) => k2 !== j),
      otherFits = fitted.filter((_, k2) => k2 !== j),
      a = project([...others, ...f.exogenous], x, f.w).residuals,
      b = project([...otherFits, ...f.exogenous], fitted[j], f.w).residuals,
      ab = a.reduce((t, v, i) => t + v * b[i], 0),
      partial =
        (ab * ab) /
        (a.reduce((t, v) => t + v * v, 0) * b.reduce((t, v) => t + v * v, 0));
    return { partial, adjusted: adjust(partial) };
  });
}

function sheaTable(f, shea, ctx) {
  const rule = "  " + "-".repeat(50);
  ctx.out("");
  ctx.out("  Shea's partial R-squared");
  ctx.out(rule);
  ctx.out("               |     Shea's             Shea's");
  ctx.out("      Variable |  partial R-sq.   adj. partial R-sq.");
  ctx.out("  -------------+------------------------------------");
  shea.forEach(({ partial, adjusted }, j) =>
    ctx.out(
      placed([
        [0, `${abbreviate(f.iv.endogenous[j], 12).padStart(14)} |`],
        [21, applyFormat(partial, "%5.4f").trim()],
        [40, applyFormat(adjusted, "%5.4f").trim()],
      ]),
    ),
  );
  ctx.out(rule);
  ctx.out("");
}

/**
 * The minimum eigenvalue statistic of Cragg and Donald: with the
 * exogenous regressors partialled out, the smallest eigenvalue of the
 * first-stage fits' cross-products scaled by the first stages' residual
 * covariance, over the count of excluded instruments. With one
 * endogenous regressor it is the first stage's F.
 */
function minimumEigenvalue(f, F) {
  if (f.endogenous.length === 1) return F;
  const z = [...f.exogenous, ...f.instruments],
    p = f.endogenous.length,
    L = f.instruments.length,
    left = f.endogenous.map((x) => project(f.exogenous, x, f.w).residuals),
    within = f.endogenous.map((x) => project(z, x, f.w).residuals),
    explained = left.map((a, r) =>
      left.map(
        (b, c) =>
          a.reduce((t, v, i) => t + v * b[i], 0) -
          within[r].reduce((t, v, i) => t + v * within[c][i], 0),
      ),
    ),
    df = f.count - (project(z, f.endogenous[0], f.w).rank + 1),
    sigma = within.map((a) =>
      within.map((b) => a.reduce((t, v, i) => t + v * b[i], 0) / df),
    ),
    // Cholesky of sigma, then L^-1 A L^-T, whose eigenvalues are those of
    // sigma^-1/2 A sigma^-1/2.
    chol = sigma.map(() => new Array(p).fill(0));
  for (let i = 0; i < p; i++)
    for (let j = 0; j <= i; j++) {
      let s = sigma[i][j];
      for (let k = 0; k < j; k++) s -= chol[i][k] * chol[j][k];
      chol[i][j] = i === j ? Math.sqrt(s) : s / chol[j][j];
    }
  const lower = chol.map((row) => [...row]),
    solveLower = (v) => {
      const out = new Array(p).fill(0);
      for (let i = 0; i < p; i++) {
        let s = v[i];
        for (let k = 0; k < i; k++) s -= lower[i][k] * out[k];
        out[i] = s / lower[i][i];
      }
      return out;
    },
    half = explained.map((row) => solveLower(row)),
    C = transpose(transpose(half).map((col) => solveLower(col)));
  return Math.min(...jacobiEigenvalues(C)) / L;
}

/** The eigenvalues of a small symmetric matrix, by Jacobi rotations. */
function jacobiEigenvalues(matrix) {
  const n = matrix.length,
    A = matrix.map((row, i) => row.map((v, j) => (v + matrix[j][i]) / 2));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += A[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (!A[p][q]) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]),
          t =
            Math.sign(theta || 1) /
            (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const kp = A[k][p],
            kq = A[k][q];
          A[k][p] = c * kp - s * kq;
          A[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < n; k++) {
          const pk = A[p][k],
            qk = A[q][k];
          A[p][k] = c * pk - s * qk;
          A[q][k] = s * pk + c * qk;
        }
      }
  }
  return A.map((row, i) => row[i]);
}

function firststage(session, model, ctx, rest) {
  const { options } = session.parse("[, ALL FORCENONROBUST debug]", rest);
  if (options.debug)
    throw new StataError(
      "option debug of estat firststage is not available in the browser",
      198,
    );
  const f = ivFrame(session, model),
    robust = model.vce !== "unadjusted";
  if (model.iv.columns.endogenous.some((c) => !c.term.variable))
    throw new StataError(
      "estat firststage after a factor-variable endogenous regressor is not available yet",
      198,
    );
  if (robust) {
    notClustered(model, "firststage");
    if (model.iv.estimator === "liml")
      throw new StataError(
        "estat firststage after a robust ivregress liml is not available yet",
        198,
      );
  }
  generatedNotes(session, model, ctx);
  const z = [...f.exogenous, ...f.instruments],
    q = f.instruments.length,
    p = f.endogenous.length,
    importance = model.wtype === "iweight" && !!f.w,
    summaries = f.endogenous.map((x) => {
      const full = project(z, x, f.w),
        restricted = project(f.exogenous, x, f.w),
        df = f.count - full.rank - 1,
        partial = (restricted.rss - full.rss) / restricted.rss,
        plainF =
          (restricted.rss - full.rss) /
          (full.rank - restricted.rank) /
          (full.rss / df);
      let F = plainF,
        dfNum = full.rank - restricted.rank;
      if (robust) {
        // The robust F of the excluded instruments in the first stage.
        const fitted = leastSquares(z, x, f.w),
          at = f.instruments.map(
            (_, k) => fitted.position[f.exogenous.length + k],
          );
        dfNum = q;
        F = robustWald(fitted, at, f) / q;
      }
      // Under importance weights the total is summarize's variance times
      // the whole part of the weights' sum less one, as regress takes it.
      const tss = importance
        ? (full.tss * (f.count - 1)) / (f.w.reduce((t, v) => t + v, 0) - 1)
        : full.tss;
      return {
        r2: importance ? 1 - full.rss / tss : full.ess / full.tss,
        adjusted: 1 - full.rss / df / (tss / (f.count - 1)),
        partial,
        F,
        plainF,
        dfNum,
        df,
        p: Ftail(dfNum, df, F),
      };
    }),
    all = !!options.all,
    summaryShown = p === 1 || all,
    sheaShown = p > 1 || all,
    // The minimum eigenvalue statistic and its critical values, for a fit
    // without weights other than frequency weights, and after a robust
    // one only when forcenonrobust asks for them.
    eigenShown = (!robust || !!options.forcenonrobust) && (!f.w || f.frequency),
    wide = "  " + "-".repeat(74),
    narrow = "  " + "-".repeat(69),
    shea = sheaShown
      ? sheaOf(
          f,
          summaries.map((s) => s.partial),
        )
      : null;
  if (summaryShown) {
    const { dfNum, df } = summaries[0];
    ctx.out("");
    ctx.out("  First-stage regression summary statistics");
    ctx.out(wide);
    ctx.out(
      `               |            Adjusted      Partial${robust ? "       Robust" : ""}`,
    );
    ctx.out(
      `      Variable |   R-sq.       R-sq.        R-sq.${`F(${dfNum},${df})`.padStart(14)}   Prob > F`,
    );
    ctx.out(
      "  -------------+------------------------------------------------------------",
    );
    summaries.forEach((s, j) =>
      ctx.out(
        placed([
          [0, `${abbreviate(f.iv.endogenous[j], 12).padStart(14)} |`],
          [18, applyFormat(s.r2, "%6.4f").trim()],
          [30, applyFormat(s.adjusted, "%6.4f").trim()],
          [43, applyFormat(s.partial, "%6.4f").trim()],
          [49, `${six(s.F).padStart(14)}${applyFormat(s.p, "%10.4f")}`],
        ]),
      ),
    );
    ctx.out(wide);
    ctx.out("");
  }
  if (sheaShown) sheaTable(f, shea, ctx);
  ctx.out("");
  const results = {};
  if (eigenShown) {
    const statistic = minimumEigenvalue(f, summaries[0].plainF),
      table = STOCK_YOGO[p]?.[q] ?? [null, null, null],
      values = (row) =>
        row
          ? row.map((v, k) => applyFormat(v, k ? "%8.2f" : "%7.2f")).join("")
          : "         (not available)";
    ctx.out(`  Minimum eigenvalue statistic = ${six(statistic).padEnd(8)}    `);
    ctx.out("");
    ctx.out(
      `  Critical Values                      # of endogenous regressors:${String(p).padStart(5)}`,
    );
    ctx.out(
      `  H0: Instruments are weak             # of excluded instruments: ${String(q).padStart(5)}`,
    );
    ctx.out(narrow);
    ctx.out(
      "                                     |    5%     10%     20%     30%",
    );
    ctx.out(`  2SLS relative bias                 |${values(table[0])}`);
    ctx.out(
      "  -----------------------------------+---------------------------------",
    );
    ctx.out(
      "                                     |   10%     15%     20%     25%",
    );
    ctx.out(`  2SLS size of nominal 5% Wald test  |${values(table[1])}`);
    ctx.out(`  LIML size of nominal 5% Wald test  |${values(table[2])}`);
    ctx.out(narrow);
    ctx.out("");
    ctx.out("");
    // Stata names the rows and columns of r(mineigcv) after where they
    // sit in its own table of critical values.
    results.mineig = statistic;
    results["matrix:mineigcv"] = {
      rowNames: [1, 2, 3].map(() => `r${p + 1}`),
      colNames: [1, 2, 3, 4].map((k) => `c${4 * (p - 1) + k}`),
      values: table.map((row) =>
        row ? [...row] : [0, 0, 0, 0].map(() => MISSING),
      ),
    };
  }
  if (sheaShown)
    results["matrix:multiresults"] = {
      rowNames: [...f.iv.endogenous],
      colNames: ["partial_R2", "adj_partial_R2"],
      values: shea.map((s) => [s.partial, s.adjusted]),
    };
  if (summaryShown)
    results["matrix:singleresults"] = {
      rowNames: summaries.map((_, j) => `r${j + 1}`),
      colNames: [1, 2, 3, 4, 5, 6, 7, 8].map((k) => `c${k}`),
      values: summaries.map((s) => [
        s.r2,
        s.adjusted,
        s.partial,
        s.F,
        s.dfNum,
        s.df,
        s.p,
        MISSING,
      ]),
    };
  session.results.r = results;
}

/**
 * Reads what follows estat endogenous as ivregress_estat.ado reads it: a
 * varlist of the endogenous regressors to test, all by default, and the
 * options of each estimator. Returns the regressors tested and the
 * options.
 */
function endogenousOptions(session, model, rest) {
  const estimator = model.iv.estimator,
    { options, varlist = [] } = session.parse(
      estimator === "gmm"
        ? "[varlist(numeric default=none)] [, FORCEWEIGHTS *]"
        : "[varlist(numeric default=none)] [, FORCENONROBUST FORCEWEIGHTS Lags(integer -1) debug DOALLTESTS]",
      rest,
    );
  if (estimator === "gmm" && options["*"].length)
    throw new StataError(`${options["*"].join(" ")} not allowed`, 198);
  if (estimator !== "gmm" && options.lags !== -1)
    throw new StataError("lags() only valid with models with HAC VCEs", 198);
  const endogenous = model.iv.endogenous,
    leftover = varlist.filter((name) => !endogenous.includes(name));
  if (leftover.length)
    throw new StataError(
      `${leftover.join(" ")} not endogenous in original model`,
      498,
    );
  const subset =
    varlist.length && endogenous.some((name) => !varlist.includes(name));
  if (
    subset &&
    estimator !== "gmm" &&
    model.vce !== "unadjusted" &&
    !options.forcenonrobust
  )
    throw new StataError(
      "cannot test a subset of endogenous regressors if a\nrobust, cluster, or HAC VCE was used at estimation",
      498,
    );
  if (subset && estimator === "gmm")
    throw new StataError(
      "estat endogenous with a subset of the endogenous regressors is not available yet after ivregress gmm; name them all, or none",
      198,
    );
  for (const name of ["debug", "doalltests"])
    if (options[name])
      throw new StataError(
        `option ${name} of estat endogenous is not available in the browser`,
        198,
      );
  return {
    options,
    tested: subset
      ? endogenous
          .map((name, k) => (varlist.includes(name) ? k : -1))
          .filter((k) => k >= 0)
      : null,
  };
}

function endogenous(session, model, ctx, rest) {
  if (model.iv.estimator === "liml")
    throw new StataError("not available after LIML estimator", 321);
  const { options, tested } = endogenousOptions(session, model, rest);
  if (model.iv.estimator === "gmm") return endogenousGmm(session, model, ctx);
  const robust = model.vce !== "unadjusted" && !options.forcenonrobust;
  if (robust) {
    notClustered(model, "endogenous");
    return endogenousRobust(session, model, ctx);
  }
  // As Stata's ivregress_estat.ado: the residuals of the fit (uc) and of
  // the fit that takes the regressors tested as exogenous (ue, OLS when
  // they are all of them), each projected over the sample as it now is,
  // and e(N).
  const f = ivFrame(session, model),
    x = [...f.endogenous, ...f.exogenous],
    z = [...f.exogenous, ...f.instruments],
    uc = ivResiduals(f, model.iv.b),
    trial = tested ? tested.map((k) => f.endogenous[k]) : f.endogenous;
  let ue, rssE;
  if (!tested) {
    const ols = project(x, f.y, f.w);
    ue = unscaled(ols.residuals, f.w);
    rssE = ols.rss;
  } else {
    // 2SLS with the regressors tested among the instruments.
    const wider = [...z, ...trial],
      fits = x.map((column) => {
        const r = unscaled(project(wider, column, f.w).residuals, f.w);
        return column.map((v, i) => v - r[i]);
      }),
      second = leastSquares(fits, f.y, f.w),
      b = [...x.map((_, k) => second.b[second.position[k]] ?? 0), second.b[0]];
    ue = ivResiduals(f, b);
    rssE = ue.reduce((t, e, i) => t + (f.w ? f.w[i] : 1) * e * e, 0);
  }
  // ue on the instruments and the regressors tested, uc on the
  // instruments.
  const difference =
      project([...z, ...trial], ue, f.w).ess - project(z, uc, f.w).ess,
    // Stata counts a factor's base level among the endogenous regressors.
    df = tested
      ? tested.length
      : (model.iv.endogenousCount ?? f.endogenous.length),
    dfResidual = f.N - x.length - 1 - df,
    durbin = difference / (rssE / f.N),
    wu = difference / df / ((rssE - difference) / dfResidual),
    pDurbin = chi2tail(df, durbin),
    pWu = Ftail(df, dfResidual, wu),
    line = (label, value, p) =>
      `${label.padEnd(34)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of endogeneity");
  ctx.out("  H0: Variables are exogenous");
  ctx.out("");
  ctx.out(line(`  Durbin (score) chi2(${df})`, durbin, pDurbin));
  ctx.out(line(`  Wu-Hausman F(${df},${dfResidual})`, wu, pWu));
  ctx.out("");
  session.results.r = {
    df,
    wudf_r: dfResidual,
    p_wu: pWu,
    wu,
    p_durbin: pDurbin,
    durbin,
  };
}

/**
 * After a robust 2SLS fit, Wooldridge's robust score test (1 regressed on
 * the OLS residuals times what is left of each first-stage residual once
 * the regressors are taken out; N less the residual sum of squares) and
 * the regression-based test (the first-stage residuals added to the
 * regressors, their coefficients tested with a robust variance).
 */
function endogenousRobust(session, model, ctx) {
  const f = ivFrame(session, model),
    x = [...f.endogenous, ...f.exogenous],
    z = [...f.exogenous, ...f.instruments],
    ols = leastSquares(x, f.y, f.w),
    first = f.endogenous.map(
      (column) => leastSquares(z, column, f.w).residuals,
    ),
    products = first.map((v) => {
      const r = leastSquares(x, v, f.w).residuals;
      return r.map((value, i) => value * ols.residuals[i]);
    }),
    score = scoreStatistic(products, f),
    df = f.endogenous.length,
    augmented = leastSquares([...x, ...first], f.y, f.w),
    at = first.map((_, k) => augmented.position[x.length + k]),
    regF = robustWald(augmented, at, f) / df,
    dfResidual = f.count - augmented.kept.length,
    pScore = chi2tail(df, score),
    pF = Ftail(df, dfResidual, regF),
    line = (label, value, p) =>
      `${label.padEnd(34)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of endogeneity");
  ctx.out("  H0: Variables are exogenous");
  ctx.out("");
  ctx.out(line(`  Robust score chi2(${df})`, score, pScore));
  ctx.out(line(`  Robust regression F(${df},${dfResidual})`, regF, pF));
  ctx.out("");
  session.results.r = {
    df,
    regFdf_d: dfResidual,
    regFdf_n: df,
    p_regF: pF,
    regF,
    p_r_score: pScore,
    r_score: score,
  };
}

function overid(session, model, ctx, rest) {
  const estimator = model.iv.estimator,
    { options } = session.parse(
      estimator === "gmm"
        ? "[, FORCEWEIGHTS *]"
        : estimator === "liml"
          ? "[, FORCEWEIGHTS FORCENONROBUST]"
          : "[, FORCEWEIGHTS Lags(integer -1) FORCENONROBUST]",
      rest,
    );
  if (estimator === "gmm") {
    if (options["*"].length)
      throw new StataError(
        `${options["*"].join(" ")} not allowed after GMM estimation`,
        198,
      );
    return overidGmm(session, model, ctx);
  }
  const robust = model.vce !== "unadjusted" && !options.forcenonrobust;
  if (estimator === "liml") {
    // The LIML tests use kappa alone; forcenonrobust lets them be shown
    // after a robust variance.
    if (robust)
      throw new StataError(
        "tests not available after LIML estimation with robust VCE\nuse forcenonrobust to override",
        498,
      );
  } else {
    if (options.lags !== -1)
      throw new StataError("lags() only valid with models with HAC VCEs", 198);
    if (robust) notClustered(model, "overid");
  }
  const f = ivFrame(session, model),
    df = f.instruments.length - f.endogenous.length;
  if (df < 1) {
    ctx.out("no overidentifying restrictions");
    throw new StataError("", 498);
  }
  if (estimator === "liml") return overidLiml(session, model, f, df, ctx);
  const e = ivResiduals(f, model.iv.b),
    z = [...f.exogenous, ...f.instruments];
  if (robust) {
    // Wooldridge's score test: what is left of each excluded instrument
    // once the first-stage fits and the exogenous regressors are taken
    // out, times the residuals; 1 regressed on those, N less the
    // residual sum of squares.
    const fits = f.endogenous.map(
        (column) => leastSquares(z, column, f.w).fitted,
      ),
      products = f.instruments.map((column) =>
        leastSquares([...fits, ...f.exogenous], column, f.w).residuals.map(
          (r, i) => r * e[i],
        ),
      ),
      score = scoreStatistic(products, f),
      p = chi2tail(df, score);
    ctx.out("");
    ctx.out("  Test of overidentifying restrictions:");
    ctx.out("");
    ctx.out(
      `${`  Score chi2(${df})`.padEnd(25)}= ${six(score).padStart(8)}  (p = ${four(p)})`,
    );
    ctx.out("");
    session.results.r = { df, p_score: p, score };
    return;
  }
  const fitted = project(z, e, f.w),
    // Stata divides by the fit's e(rss), the sum of these squares over the
    // sample as it was.
    total =
      model.rss ?? e.reduce((t, v, i) => t + (f.w ? f.w[i] : 1) * v * v, 0),
    sargan = f.count * (1 - fitted.rss / total),
    basmann = (sargan * (f.count - z.length - 1)) / (f.count - sargan),
    pSargan = chi2tail(df, sargan),
    pBasmann = chi2tail(df, basmann),
    line = (label, value, p) =>
      `${label.padEnd(25)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of overidentifying restrictions:");
  ctx.out("");
  // forcenonrobust drops the word score from the label.
  ctx.out(
    line(
      `  Sargan ${options.forcenonrobust ? "" : "(score) "}chi2(${df})`,
      sargan,
      pSargan,
    ),
  );
  ctx.out(line(`  Basmann chi2(${df})`, basmann, pBasmann));
  ctx.out("");
  session.results.r = {
    df,
    p_score: pSargan,
    score: sargan,
    p_basmann: pBasmann,
    basmann,
    p_sargan: pSargan,
    sargan,
  };
}

/**
 * After LIML, Stata tests the overidentifying restrictions with kappa:
 * Anderson and Rubin's N(kappa - 1) and Basmann's (kappa - 1)(N - L)/df,
 * L counting the instruments, exogenous regressors and the constant.
 */
function overidLiml(session, model, f, df, ctx) {
  const kappa = model.iv.kappa,
    L = f.exogenous.length + f.instruments.length + 1,
    ar = f.n * (kappa - 1),
    basmann = ((kappa - 1) * (f.n - L)) / df,
    pAr = chi2tail(df, ar),
    pBasmann = Ftail(df, f.n - L, basmann),
    line = (label, value, p) =>
      `${label.padEnd(25)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of overidentifying restrictions:");
  ctx.out("");
  ctx.out(line(`  Anderson-Rubin chi2(${df})`, ar, pAr));
  ctx.out(line(`  Basmann F(${df}, ${f.n - L})`, basmann, pBasmann));
  ctx.out("");
  session.results.r = {
    basmann_df_d: f.n - L,
    basmann_df_n: df,
    p_basmann: pBasmann,
    basmann,
    ar_df: df,
    p_ar: pAr,
    ar,
  };
}

/** Runs a diagnostic after ivregress; returns false when it is not one. */
export function ivDiagnostic(session, model, what, ctx, text = "") {
  const run = /^first(s(t(a(ge?)?)?)?)?$/.test(what)
    ? firststage
    : /^endog(e(n(o(us?)?)?)?)?$/.test(what)
      ? endogenous
      : /^over(id?)?$/.test(what)
        ? overid
        : null;
  if (!run) return false;
  // ivreg and regress y x (z), the older commands, have none of these
  // tests.
  if (model.legacy) throw new StataError(`estat ${what} not valid`, 321);
  if (model.command !== "ivregress")
    throw new StataError(`estat ${what} not valid`, 321);
  // After analytic, sampling or importance weights the tests of
  // endogeneity and of the overidentifying restrictions need forceweights.
  if (
    model.wtype &&
    model.wtype !== "fweight" &&
    run !== firststage &&
    !/(^|[\s,])forceweights(?=[\s,]|$)/.test(text.trim().slice(what.length))
  )
    throw new StataError(
      `not available after estimation with ${model.wtype}s; use forceweights to override`,
      498,
    );
  // What follows the subcommand: its varlist and options.
  run(session, model, ctx, text.trim().slice(what.length));
  return true;
}

/**
 * areg: least squares with the indicators of one categorical variable
 * absorbed. The indicators are never built; y and the regressors are taken
 * as deviations from their means within each category (the within
 * transform), which gives the same slopes and residuals at a cost linear in
 * the number of observations, so thousands of categories take no longer
 * than a few. Analytic, sampling and frequency weights enter every sum.
 */
function areg(session, text, ctx) {
  const parsed = session.parse(
      "anything [if] [in] [aweight fweight pweight] , Absorb(string) [Level(cilevel) Robust VCE(string) CLuster(varname)]",
      text,
    ),
    options = parsed.options,
    absorbText = options.absorb.trim();
  // Stata's own messages for what areg never accepts in absorb().
  if (/[.#]/.test(absorbText))
    throw new StataError(
      "factor-variable and time-series operators not allowed\n    Option absorb() incorrectly specified.",
      101,
    );
  const absorbed = session.varlist(absorbText);
  if (absorbed.length > 1)
    throw new StataError(
      `areg with more than one absorbed variable is not available yet; absorb ${absorbed[0]} and add the others as factor variables, as in i.${absorbed[1]}`,
      198,
    );
  const absorb = session.data.get(absorbed[0]),
    vceText = (options.vce ?? "").trim(),
    hc2 = /^hc2$/.test(vceText);
  if (/^hc2\s/.test(vceText))
    throw new StataError(
      "vce(hc2 clustvar) is not available yet after areg; use vce(cluster clustvar) or vce(hc2)",
      198,
    );
  // areg.ado, under version 17, takes one cluster variable.
  const clustered = /^cl(?:u(?:s(?:t(?:er?)?)?)?)?\s+(.+)$/.exec(vceText);
  if (clustered && session.varlist(clustered[1]).length > 1)
    throw new StataError("cluster():  too many variables specified", 103);
  const asked = hc2
      ? { robust: !!options.robust, cluster: null }
      : readVce(session, options, /^(ols|conventional)$/),
    wtype = parsed.weight?.type ?? null;
  if (hc2 && (asked.robust || wtype))
    throw new StataError(
      `vce(hc2) ${wtype ? "with weights " : "with robust "}is not available yet after areg; use vce(robust)`,
      198,
    );
  const robust = asked.robust || wtype === "pweight",
    { dependent, columns, sample } = design(
      session,
      parsed.anything,
      session.rows(parsed, null),
      true,
    );
  let rows = sample.filter(
      (i) =>
        !noCluster(absorb, i) &&
        !(asked.cluster && noCluster(asked.cluster, i)),
    ),
    raw = null;
  if (wtype) {
    const all = evaluateAll(session.compile(parsed.weight.exp), session.data.n);
    rows = rows.filter((i) => !isMissing(all[i]) && all[i] !== 0);
    if (rows.some((i) => all[i] < 0))
      throw new StataError("negative weights encountered", 402);
    if (wtype === "fweight" && rows.some((i) => !Number.isInteger(all[i])))
      throw new StataError("may not use noninteger frequency weights", 401);
    raw = rows.map((i) => all[i]);
  }
  const count0 = rows.length;
  if (!count0) throw new StataError("no observations", 2000);
  if (count0 === 1) throw new StataError("insufficient observations", 2001);
  const sumW = raw ? raw.reduce((t, v) => t + v, 0) : count0,
    // Analytic and sampling weights are rescaled to sum to the number of
    // observations; a frequency weight counts that many observations.
    w = raw
      ? wtype === "fweight"
        ? raw
        : raw.map((v) => (v * count0) / sumW)
      : null,
    n = wtype === "fweight" ? sumW : count0,
    weight = (i) => (w ? w[i] : 1);
  const active = columns.filter((c) => !c.base),
    y = rows.map((i) => dependent.data[i]),
    xAll = active.map((c) => rows.map(c.value)),
    // Each observation's category, numbered in order of appearance.
    index = new Map(),
    category = rows.map((i) => {
      const key = absorb.data[i];
      if (!index.has(key)) index.set(key, index.size);
      return index.get(key);
    }),
    groups = index.size,
    sizes = new Array(groups).fill(0),
    weights = new Array(groups).fill(0);
  category.forEach((c, i) => {
    sizes[c]++;
    weights[c] += weight(i);
  });
  const dot = (a, b) => {
      let t = 0;
      for (let i = 0; i < a.length; i++) t += a[i] * b[i];
      return t;
    },
    wdot = (a, b) => {
      if (!w) return dot(a, b);
      let t = 0;
      for (let i = 0; i < a.length; i++) t += w[i] * a[i] * b[i];
      return t;
    },
    // The weighted mean, refined by a second pass, so that a column constant
    // within a category has a mean equal to that constant.
    mean = (v) => {
      let total = 0;
      v.forEach((value, i) => (total += weight(i) * value));
      const first = total / n;
      let rest = 0;
      v.forEach((value, i) => (rest += weight(i) * (value - first)));
      return first + rest / n;
    },
    demean = (v) => {
      const totals = new Array(groups).fill(0);
      v.forEach((value, i) => (totals[category[i]] += weight(i) * value));
      const means = totals.map((t, c) => t / weights[c]),
        rest = new Array(groups).fill(0);
      v.forEach(
        (value, i) =>
          (rest[category[i]] += weight(i) * (value - means[category[i]])),
      );
      means.forEach((m, c) => (means[c] = m + rest[c] / weights[c]));
      return v.map((value, i) => value - means[category[i]]);
    },
    ybar = mean(y),
    yw = demean(y),
    xw = xAll.map(demean),
    xbarAll = xAll.map(mean),
    kept = [],
    basis = [];
  // A regressor that the categories and the regressors before it explain
  // is omitted: the later of two collinear ones, as Stata's regress does.
  // Each is judged against its own within variation, so one whose spread
  // within the categories is small next to its level is kept.
  xw.forEach((column, k) => {
    const own = wdot(column, column),
      rest = column.slice();
    for (const q of basis) {
      const factor = wdot(rest, q.vector) / q.norm;
      for (let i = 0; i < count0; i++) rest[i] -= factor * q.vector[i];
    }
    const norm = wdot(rest, rest);
    if (own > 0 && norm > 1e-11 * own) {
      basis.push({ vector: rest, norm });
      kept.push(k);
    } else active[k].omitted = true;
  });
  const size = kept.length,
    x = kept.map((k) => xw[k]),
    xbar = kept.map((k) => xbarAll[k]),
    inverse = invertSymmetric(x.map((a) => x.map((b) => wdot(a, b))));
  if (!inverse)
    throw new StataError("the regressors are too collinear to fit", 198);
  const xy = x.map((column) => wdot(column, yw)),
    b = inverse.map((row) => dot(row, xy)),
    residuals = yw.map(
      (v, i) => v - b.reduce((t, bj, j) => t + bj * x[j][i], 0),
    ),
    rss = wdot(residuals, residuals),
    tss = y.reduce((t, v, i) => t + weight(i) * (v - ybar) ** 2, 0),
    dfAbsorbed = groups - 1,
    dfResidual = n - size - groups,
    // With no residual degrees of freedom nothing is estimated but the
    // coefficients, as with one observation in each category.
    s2 = dfResidual > 0 ? rss / dfResidual : MISSING,
    constant = ybar - dot(xbar, b);
  // (Z'WZ)^-1 for Z = [x within plus its overall mean, 1], the design whose
  // constant is the overall mean of y less the fitted one.
  const vx = inverse.map((row) => dot(row, xbar)),
    bread = [
      ...inverse.map((row, r) => [...row, -vx[r]]),
      [...vx.map((v) => -v), 1 / n + dot(xbar, vx)],
    ],
    z = (k) => [...x.map((column, j) => column[k] + xbar[j]), 1];
  let V,
    dfR = dfResidual,
    clusters = null,
    vcetype = "";
  if (dfResidual < 1) V = bread.map((row) => row.map(() => MISSING));
  else if (hc2) {
    // HC2 divides each squared residual by one less its leverage in the
    // model with the indicators: 1/T for the category plus that of the
    // regressors within it.
    const meat = Array.from({ length: size + 1 }, () =>
      new Array(size + 1).fill(0),
    );
    for (let k = 0; k < count0; k++) {
      const within = x.map((column) => column[k]),
        h =
          1 / sizes[category[k]] +
          within.reduce(
            (t, a, r) =>
              t + a * within.reduce((u, c, j) => u + inverse[r][j] * c, 0),
            0,
          ),
        e2 = h < 1 ? residuals[k] ** 2 / (1 - h) : 0,
        s = z(k);
      for (let a = 0; a <= size; a++)
        for (let c = 0; c <= size; c++) meat[a][c] += s[a] * s[c] * e2;
    }
    V = sandwichOf(bread, meat, 1);
    vcetype = "Robust HC2";
  } else if (robust) {
    // The sandwich on the same design. The absorbed indicators count among
    // the parameters in the small-sample factor. A frequency weight repeats
    // an observation's score; the other weights scale it.
    const score = (k) => {
      const factor = residuals[k] * (w && wtype !== "fweight" ? w[k] : 1);
      return z(k).map((v) => v * factor);
    };
    let meat, scale;
    if (asked.cluster) {
      const result = clusterMeat(
        asked.cluster,
        rows,
        wtype === "fweight" ? (k) => score(k).map((v) => v * w[k]) : score,
        size + 1,
      );
      meat = result.meat;
      clusters = result.clusters;
      scale = (clusters / (clusters - 1)) * ((n - 1) / dfResidual);
      dfR = clusters - 1;
    } else {
      meat = Array.from({ length: size + 1 }, () =>
        new Array(size + 1).fill(0),
      );
      for (let k = 0; k < count0; k++) {
        const s = score(k),
          repeat = wtype === "fweight" ? w[k] : 1;
        for (let a = 0; a <= size; a++)
          for (let c = 0; c <= size; c++) meat[a][c] += repeat * s[a] * s[c];
      }
      scale = n / dfResidual;
    }
    V = sandwichOf(bread, meat, scale);
    vcetype = "Robust";
  } else V = bread.map((row) => row.map((v) => v * s2));
  // The F test of the absorbed indicators sets the fit against weighted
  // least squares on the regressors and a constant alone.
  const pooledRss = (() => {
      const centred = kept.map((k) => xAll[k].map((v) => v - xbarAll[k])),
        yc = y.map((v) => v - ybar);
      if (!size) return wdot(yc, yc);
      const fitted = invertSymmetric(
        centred.map((a) => centred.map((c) => wdot(a, c))),
      );
      if (!fitted) return MISSING;
      const coefficients = fitted.map((row) =>
          dot(
            row,
            centred.map((c) => wdot(c, yc)),
          ),
        ),
        e = yc.map(
          (v, i) =>
            v - coefficients.reduce((t, bj, j) => t + bj * centred[j][i], 0),
        );
      return wdot(e, e);
    })(),
    finite = (value) =>
      Number.isFinite(value) && !isMissing(value) ? value : MISSING,
    fAbsorb =
      dfAbsorbed > 0 && dfResidual > 0 && !isMissing(pooledRss)
        ? finite((pooledRss - rss) / dfAbsorbed / s2)
        : MISSING,
    pAbsorb = isMissing(fAbsorb)
      ? MISSING
      : Ftail(dfAbsorbed, dfResidual, fAbsorb),
    slopeV = V.slice(0, size).map((row) => row.slice(0, size)),
    block = size && dfResidual > 0 ? invertSymmetric(slopeV) : null,
    // A robust variance of less than full rank, as with fewer clusters
    // than coefficients, leaves F missing: e(df_m) is the rank of the
    // slopes' variance and e(rank) that of the whole, constant included.
    shortOf = (M) =>
      (robust || hc2) && dfResidual > 0
        ? symmetricRank(M.map((row) => row.map((v) => finite(v))))
        : M.length,
    vRank = shortOf(V),
    dfModel = shortOf(slopeV),
    F =
      size && block && dfModel === size
        ? finite(quadratic(b, block) / size)
        : MISSING,
    r2 = finite(1 - rss / tss),
    r2a = dfResidual > 0 ? finite(1 - s2 / (tss / (n - 1))) : MISSING,
    rmse = dfResidual > 0 ? Math.sqrt(s2) : rss === 0 ? 0 : MISSING,
    // Each observation's variance is sigma^2 / w under analytic weights,
    // which adds half the sum of the log weights; Stata adds nothing for
    // sampling weights.
    logWeights =
      wtype === "aweight" ? 0.5 * w.reduce((t, v) => t + Math.log(v), 0) : 0,
    gaussian = (ss) =>
      -0.5 * n * (Math.log(2 * Math.PI) + Math.log(ss / n) + 1) + logWeights,
    names = [...columns.map((c) => c.name), "_cons"],
    // Where each named coefficient sits among the estimated ones: the
    // constant last, -1 for a base level or an omitted regressor.
    position = names.map((_, k) =>
      k === columns.length ? size : kept.indexOf(active.indexOf(columns[k])),
    ),
    vce = hc2 ? "hc2" : asked.cluster ? "cluster" : robust ? "robust" : "ols",
    model = {
      command: "areg",
      title: "Linear regression, absorbing indicators",
      absorb: absorb.name,
      depvar: dependent.name,
      names,
      b: position.map((p) => (p < 0 ? 0 : p === size ? constant : b[p])),
      V: position.map((p) =>
        position.map((q) => (p < 0 || q < 0 ? 0 : finite(V[p][q]))),
      ),
      columns,
      constant: true,
      estimable: position.map((p) => p >= 0),
      N: n,
      df_m: dfModel,
      df_r: dfR,
      dfResidual: dfR,
      rank: vRank,
      F,
      rss,
      tss,
      ll: gaussian(rss),
      // The null model keeps the absorbed indicators.
      ll_0: gaussian(wdot(yw, yw)),
      mss: tss - rss,
      r2,
      r2_a: r2a,
      rmse,
      vce,
      ...(vcetype ? { vcetype } : {}),
      ...(wtype ? { wtype, sumW } : {}),
      // Each observation's weight, which margins averages with.
      ...(w ? { weights: w } : {}),
      sample: rows,
      level: options.level,
    },
    p = isMissing(F) ? MISSING : Ftail(dfModel, dfR, F),
    values = [
      ["Number of obs", count(n)],
      ["No. of categories", count(groups)],
      [`F(${dfModel}, ${dfR})`, applyFormat(F, "%9.2f").trim()],
      ["Prob > F", applyFormat(p, "%6.4f").trim()],
      ["R-squared", applyFormat(r2, "%6.4f").trim()],
      // A statistic that cannot be computed is left out, as
      // _coef_table_header leaves it.
      ...(isMissing(r2a)
        ? []
        : [["Adj R-squared", applyFormat(r2a, "%6.4f").trim()]]),
      // _coef_table_header shows it in %10.4f, which turns to four
      // significant digits once the number no longer fits.
      ["Root MSE", applyFormat(rmse, "%10.4f").trim()],
    ],
    // The column of values is one wider than the widest, and the block
    // ends at column 78, as Stata's coefficient-table header sets it.
    width = Math.max(...values.map(([, v]) => v.length)) + 1,
    left = [model.title, `Absorbed variable: ${absorb.name}`];
  session.estimates = model;
  session.results.e = aregResults(session, model, {
    text,
    n,
    dfR,
    F,
    p,
    sumW,
    dfAbsorbed,
    groups,
    fAbsorb,
    pAbsorb,
    clusters,
    vcetype,
    clustvar: asked.cluster?.name,
    wexp: wtype ? `= ${parsed.weight.exp}` : null,
    // e(r2_c), the R-squared of the regression without the absorbed
    // indicators, which Stata keeps hidden.
    r2c:
      vce === "ols"
        ? (() => {
            try {
              return fit(
                session,
                { ...parsed, options: {}, positiveWeights: true },
                null,
              ).r2;
            } catch {
              return undefined;
            }
          })()
        : undefined,
    // (X'X)^-1 of the same fit, which Stata posts as e(V_modelbased).
    modelBased:
      vce !== "ols" && dfResidual > 0
        ? position.map((p) =>
            position.map((q) => (p < 0 || q < 0 ? 0 : finite(bread[p][q]))),
          )
        : null,
  });
  // [weight=exp] is an analytic weight, and Stata says so first.
  if (wtype && genericWeight(text)) ctx.out(assumedWeights(wtype));
  for (const k of active.keys())
    if (!kept.includes(k))
      ctx.out(`note: ${active[k].name} omitted because of collinearity.`);
  if (wtype && wtype !== "fweight")
    ctx.out(`(sum of wgt is ${applyFormat(sumW, "%18.0gc").trim()})`);
  ctx.out("");
  values.forEach(([label, value], k) => {
    const text = left[k] ?? "";
    ctx.out(
      `${text.padEnd(Math.max(59 - width, text.length + 1))}${label.padEnd(18)}=${value.padStart(width)}`,
    );
  });
  ctx.out("");
  // The first column widens to the longest label shown, as in regress.
  const w0 = tableWidth(session, model);
  if (clusters)
    ctx.out(
      `(Std. err. adjusted for ${count(clusters)} clusters in ${asked.cluster.name})`.padStart(
        66 + w0,
      ),
    );
  coefficientHeader(model, options.level, model.depvar, w0).forEach(ctx.out);
  const critical = invttail(dfR, (1 - options.level / 100) / 2);
  termRows(
    session,
    model,
    (k) => {
      const variance = model.V[k][k],
        se = isMissing(variance) ? MISSING : Math.sqrt(variance),
        known = !isMissing(se) && se > 0 && dfR > 0,
        t = known ? model.b[k] / se : MISSING,
        bound = (sign) => (known ? model.b[k] + sign * critical * se : MISSING);
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${statisticCell(t)}${applyFormat(known ? 2 * ttail(dfR, Math.abs(t)) : MISSING, "%8.3f")}${g(bound(-1)).padStart(13)}${g(bound(1)).padStart(12)}`;
    },
    w0,
  ).forEach(ctx.out);
  ctx.out("-".repeat(66 + w0));
  // areg_footnote prints no F test after a robust variance, or when the
  // test cannot be computed.
  if (!robust && !hc2 && !isMissing(fAbsorb))
    ctx.out(
      `${`F test of absorbed indicators: F(${dfAbsorbed}, ${dfResidual}) = ${applyFormat(fAbsorb, "%4.3f")}`.padEnd(61)} Prob > F = ${applyFormat(pAbsorb, "%4.3f")}`,
    );
  ctx.out("");
}

/**
 * areg's e(), in the order ereturn list shows it after Stata 19's areg,
 * which differs with the variance: areg.ado posts through _regress and
 * holds the results while it works, which reverses some of them. Stata's
 * e(datasignature) is a checksum of its own that the browser does not
 * compute; it and e(datasignaturevars) are left out.
 */
function aregResults(session, model, a) {
  const vce = model.vce,
    stripe = coefficientSpace(model).entries.map(stripeName),
    weights = a.wexp ? { wexp: a.wexp, wtype: model.wtype } : {},
    sumW = model.wtype ? a.sumW : a.n,
    common = {
      cmdline: `areg ${a.text.trim()}`,
      cmd: "areg",
      footnote: "areg_footnote",
      title: model.title,
      predict: "areg_p",
    },
    // What ereturn list, all shows as hidden, which differs with the
    // variance: a clustered fit runs areg.ado's older code.
    hidden =
      vce === "cluster"
        ? {
            estmethod: "areg_11",
            _r_z_abs__CL: "|t|",
            _r_z__CL: "t",
            title2: `Absorbed variable: ${model.absorb}`,
          }
        : {
            ...(vce === "ols" && a.r2c !== undefined ? { r2_c: a.r2c } : {}),
            _r_z_abs__CL: "|t|",
            _r_z__CL: "t",
            estmethod: "areg",
            title2: `Absorbed variable: ${model.absorb}`,
            marginsprop: "nolinearize",
          },
    matrices = a.modelBased
      ? {
          "matrix:V_modelbased": {
            rowNames: stripe,
            colNames: stripe,
            values: a.modelBased,
          },
        }
      : {};
  let e;
  // Clustered on the absorbed variable itself, areg.ado fits through
  // _regress, which posts as a robust fit does, the cluster count first.
  if (vce === "cluster" && a.clustvar === model.absorb)
    e = {
      N_clust: a.clusters,
      N: a.n,
      sum_w: sumW,
      df_r: a.dfR,
      r2: model.r2,
      mss: model.mss,
      rss: model.rss,
      r2_a: model.r2_a,
      df_a: a.dfAbsorbed,
      tss: model.tss,
      ll: model.ll,
      ll_0: model.ll_0,
      df_m: model.df_m,
      F: a.F,
      p: a.p,
      rank: model.rank,
      rmse: model.rmse,
      rc: 0,
      k_absorb: a.groups,
      ...common,
      marginsnotok: "Residuals SCore D XBD",
      vce,
      depvar: model.depvar,
      properties: "b V",
      model: "ols",
      absvar: model.absorb,
      ...weights,
      vcetype: a.vcetype,
      clustvar: a.clustvar,
    };
  else if (vce === "cluster")
    e = {
      rank: model.rank,
      df_m: model.df_m,
      F: a.F,
      N_clust: a.clusters,
      N: a.n,
      rss: model.rss,
      ll: model.ll,
      ll_0: model.ll_0,
      tss: model.tss,
      r2: model.r2,
      r2_a: model.r2_a,
      df_r: a.dfR,
      df_a: a.dfAbsorbed,
      rmse: model.rmse,
      k_absorb: a.groups,
      cmdline: common.cmdline,
      ...weights,
      cmd: "areg",
      footnote: common.footnote,
      title: common.title,
      predict: common.predict,
      marginsnotok: "Residuals SCore",
      depvar: model.depvar,
      absvar: model.absorb,
      clustvar: a.clustvar,
      vcetype: a.vcetype,
      vce,
      properties: "b V",
    };
  else if (vce === "ols")
    e = {
      F_absorb: a.fAbsorb,
      p_absorb: a.pAbsorb,
      rank: model.rank,
      p: a.p,
      rc: 0,
      k_absorb: a.groups,
      ll_0: model.ll_0,
      ll: model.ll,
      tss: model.tss,
      df_a: a.dfAbsorbed,
      r2_a: model.r2_a,
      rss: model.rss,
      mss: model.mss,
      rmse: model.rmse,
      r2: model.r2,
      F: a.F,
      df_r: a.dfR,
      df_m: model.df_m,
      sum_w: sumW,
      N: a.n,
      ...common,
      marginsnotok: "Residuals SCore D XBD",
      vce,
      depvar: model.depvar,
      properties: "b V",
      model: "ols",
      absvar: model.absorb,
      ...weights,
    };
  else {
    const scalars =
      vce === "hc2"
        ? [
            ["N", a.n],
            ["sum_w", sumW],
            ["df_r", a.dfR],
            ["r2", model.r2],
            ["mss", model.mss],
            ["rss", model.rss],
            ["df_a", a.dfAbsorbed],
            ["tss", model.tss],
            ["ll", model.ll],
            ["ll_0", model.ll_0],
            ["rank", model.rank],
            ["r2_a", model.r2_a],
            ["rmse", model.rmse],
            ["df_m", model.df_m],
          ]
        : [
            ["N", a.n],
            ["sum_w", sumW],
            ["df_r", a.dfR],
            ["r2", model.r2],
            ["rmse", model.rmse],
            ["mss", model.mss],
            ["rss", model.rss],
            ["r2_a", model.r2_a],
            ["df_a", a.dfAbsorbed],
            ["tss", model.tss],
            ["ll", model.ll],
            ["ll_0", model.ll_0],
            ["df_m", model.df_m],
          ];
    e = {
      ...Object.fromEntries(scalars),
      F: a.F,
      p: a.p,
      ...(vce === "hc2" ? {} : { rank: model.rank }),
      rc: 0,
      k_absorb: a.groups,
      ...common,
      marginsnotok: "Residuals SCore D XBD",
      vce,
      ...(vce === "hc2" ? { vcetype: a.vcetype } : {}),
      depvar: model.depvar,
      properties: "b V",
      model: "ols",
      absvar: model.absorb,
      ...weights,
      ...(vce === "hc2" ? {} : { vcetype: a.vcetype }),
    };
  }
  // e(ar2), the adjusted R-squared, is kept for older versions' sake.
  return Object.assign(e, matrices, hidden, {
    ar2: model.r2_a,
    [HIDDEN]: Object.keys(hidden),
    [HISTORICAL]: ["ar2"],
  });
}

/** bread * meat * bread, scaled. */
function sandwichOf(bread, meat, scale) {
  const middle = bread.map((row) =>
    meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
  );
  return middle.map((row) =>
    bread[0].map(
      (_, c) => scale * row.reduce((t, v, k) => t + v * bread[k][c], 0),
    ),
  );
}

export const MORE_ESTIMATORS = [{ name: "areg", minimum: 4, run: areg }];
