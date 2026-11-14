// areg, and what follows ivregress: the first-stage regressions and
// estat firststage, endogenous and overid.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { evaluateAll } from "./expression.js";
import { project } from "./diagnostics.js";
import {
  RULE,
  coefficientHeader,
  coefficientRows,
  design,
  fit,
  invertSymmetric,
  quadratic,
  tableWidth,
  abbreviate,
  termRows,
} from "./estimation.js";
import { count } from "./reports.js";
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
  const iv = model.iv,
    column = (c) => iv.rows.map((i) => c.value(i));
  return {
    iv,
    n: iv.rows.length,
    y: iv.rows.map((i) => session.data.get(iv.dep).data[i]),
    endogenous: iv.columns.endogenous.map(column),
    exogenous: iv.columns.exogenous.map(column),
    instruments: iv.columns.instruments.map(column),
  };
}
function unadjusted(model, what) {
  if (model.vce !== "unadjusted")
    throw new StataError(
      `estat ${what} after a robust ivregress is not available yet`,
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
/** Hansen's J after ivregress gmm. */
function overidGmm(session, model, ctx) {
  robustGmm(model, "overid");
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
  ctx.out(`  Hansen's J chi2(${df}) = ${six(J)} (p = ${four(p)})`);
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

function firststage(session, model, ctx) {
  const f = ivFrame(session, model);
  if (model.iv.columns.endogenous.some((c) => !c.term.variable))
    throw new StataError(
      "estat firststage after a factor-variable endogenous regressor is not available yet",
      198,
    );
  if (model.vce !== "unadjusted") {
    if (model.iv.estimator === "liml")
      throw new StataError(
        "estat firststage after a robust ivregress liml is not available yet",
        198,
      );
    return firststageRobust(f, ctx, session, model);
  }
  if (f.endogenous.length > 1)
    throw new StataError(
      "estat firststage with more than one endogenous regressor is not available yet",
      198,
    );
  generatedNotes(session, model, ctx);
  const full = project([...f.exogenous, ...f.instruments], f.endogenous[0]),
    restricted = project(f.exogenous, f.endogenous[0]),
    df = f.n - full.rank - 1,
    q = full.rank - restricted.rank,
    r2 = full.ess / full.tss,
    adjusted = 1 - full.rss / df / (full.tss / (f.n - 1)),
    partial = (restricted.rss - full.rss) / restricted.rss,
    F = (restricted.rss - full.rss) / q / (full.rss / df),
    p = Ftail(q, df, F),
    table = STOCK_YOGO[1][f.instruments.length] ?? [null, null, null],
    values = (row) =>
      row
        ? row.map((v, k) => applyFormat(v, k ? "%8.2f" : "%7.2f")).join("")
        : "         (not available)",
    wide = "  " + "-".repeat(74),
    narrow = "  " + "-".repeat(69);
  ctx.out("");
  ctx.out("  First-stage regression summary statistics");
  ctx.out(wide);
  ctx.out("               |            Adjusted      Partial");
  ctx.out(
    `      Variable |   R-sq.       R-sq.        R-sq.${`F(${q},${df})`.padStart(14)}   Prob > F`,
  );
  ctx.out(
    "  -------------+------------------------------------------------------------",
  );
  ctx.out(
    `${abbreviate(f.iv.endogenous[0], 12).padStart(14)} |${applyFormat(r2, "%8.4f")}${applyFormat(adjusted, "%12.4f")}${applyFormat(partial, "%13.4f")}${six(F).padStart(14)}${applyFormat(p, "%10.4f")}`,
  );
  ctx.out(wide);
  ctx.out("");
  ctx.out("");
  ctx.out(`  Minimum eigenvalue statistic = ${six(F)}     `);
  ctx.out("");
  ctx.out(
    `  Critical Values                      # of endogenous regressors:${"1".padStart(5)}`,
  );
  ctx.out(
    `  H0: Instruments are weak             # of excluded instruments: ${String(f.instruments.length).padStart(5)}`,
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
  session.results.r = { mineig: F };
}

/** The summary table when the variance is robust: a robust F. */
function firststageRobust(f, ctx, session, model) {
  if (f.endogenous.length > 1)
    throw new StataError(
      "estat firststage with more than one endogenous regressor is not available yet",
      198,
    );
  generatedNotes(session, model, ctx);
  const y = f.endogenous[0],
    full = project([...f.exogenous, ...f.instruments], y),
    restricted = project(f.exogenous, y),
    R = withConstant([...f.exogenous, ...f.instruments], f.n),
    size = R[0].length,
    df = f.n - size,
    q = f.instruments.length,
    bread = invertSymmetric(crossProduct(R, R)),
    b = apply(
      bread,
      R[0].map((_, a) => R.reduce((t, row, i) => t + row[a] * y[i], 0)),
    ),
    e = y.map((v, i) => v - R[i].reduce((t, x, k) => t + x * b[k], 0)),
    meat = momentCovariance(R, e).map((row) => row.map((v) => v * f.n)),
    V = times(times(bread, meat), bread).map((row) =>
      row.map((v) => (v * f.n) / df),
    ),
    at = f.instruments.map((_, k) => f.exogenous.length + k),
    inverse = invertSymmetric(at.map((r) => at.map((c) => V[r][c])));
  if (!inverse) throw new StataError("the instruments are collinear", 506);
  const F =
      quadratic(
        at.map((k) => b[k]),
        inverse,
      ) / q,
    p = Ftail(q, df, F),
    r2 = full.ess / full.tss,
    adjusted = 1 - full.rss / df / (full.tss / (f.n - 1)),
    partial = (restricted.rss - full.rss) / restricted.rss,
    wide = "  " + "-".repeat(74);
  ctx.out("");
  ctx.out("  First-stage regression summary statistics");
  ctx.out(wide);
  ctx.out("               |            Adjusted      Partial       Robust");
  ctx.out(
    `      Variable |   R-sq.       R-sq.        R-sq.${`F(${q},${df})`.padStart(14)}   Prob > F`,
  );
  ctx.out(
    "  -------------+------------------------------------------------------------",
  );
  ctx.out(
    `${abbreviate(f.iv.endogenous[0], 12).padStart(14)} |${applyFormat(r2, "%8.4f")}${applyFormat(adjusted, "%12.4f")}${applyFormat(partial, "%13.4f")}${six(F).padStart(14)}${applyFormat(p, "%10.4f")}`,
  );
  ctx.out(wide);
  ctx.out("");
  ctx.out("");
  session.results.r = {};
}

function endogenous(session, model, ctx) {
  if (model.iv.estimator === "liml")
    throw new StataError("not available after LIML estimator", 321);
  if (model.iv.estimator === "gmm") return endogenousGmm(session, model, ctx);
  unadjusted(model, "endogenous");
  const f = ivFrame(session, model),
    x = [...f.endogenous, ...f.exogenous],
    // The first-stage residuals join the regression; under exogeneity
    // their coefficients are zero.
    v = f.endogenous.map(
      (column) => project([...f.exogenous, ...f.instruments], column).residuals,
    ),
    before = project(x, f.y),
    after = project([...x, ...v], f.y),
    // Stata counts a factor's base level among the endogenous regressors.
    df = model.iv.endogenousCount ?? f.endogenous.length,
    dfResidual = f.n - x.length - 1 - df,
    durbin = (f.n * (before.rss - after.rss)) / before.rss,
    wu = (before.rss - after.rss) / df / (after.rss / dfResidual),
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

function overid(session, model, ctx) {
  if (model.iv.estimator === "gmm") return overidGmm(session, model, ctx);
  unadjusted(model, "overid");
  const f = ivFrame(session, model),
    df = f.instruments.length - f.endogenous.length;
  if (df < 1) {
    ctx.out("no overidentifying restrictions");
    throw new StataError("", 498);
  }
  if (model.iv.estimator === "liml")
    return overidLiml(session, model, f, df, ctx);
  const x = [...f.endogenous, ...f.exogenous],
    e = f.y.map(
      (value, i) =>
        value -
        x.reduce((t, column, k) => t + column[i] * model.iv.b[k], 0) -
        model.iv.b[x.length],
    ),
    z = [...f.exogenous, ...f.instruments],
    fitted = project(z, e),
    total = e.reduce((t, v) => t + v * v, 0),
    sargan = f.n * (1 - fitted.rss / total),
    basmann = (sargan * (f.n - z.length - 1)) / (f.n - sargan),
    pSargan = chi2tail(df, sargan),
    pBasmann = chi2tail(df, basmann),
    line = (label, value, p) =>
      `${label.padEnd(25)}= ${six(value).padStart(8)}  (p = ${four(p)})`;
  ctx.out("");
  ctx.out("  Tests of overidentifying restrictions:");
  ctx.out("");
  ctx.out(line(`  Sargan (score) chi2(${df})`, sargan, pSargan));
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
export function ivDiagnostic(session, model, what, ctx) {
  const run = /^first(s(t(a(ge?)?)?)?)?$/.test(what)
    ? firststage
    : /^endog(e(n(o(us?)?)?)?)?$/.test(what)
      ? endogenous
      : /^over(id?)?$/.test(what)
        ? overid
        : null;
  if (!run) return false;
  if (model.command !== "ivregress")
    throw new StataError(
      `estat ${what} is only available after ivregress`,
      301,
    );
  run(session, model, ctx);
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
    F = size && block ? finite(quadratic(b, block) / size) : MISSING,
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
      df_m: size,
      df_r: dfR,
      dfResidual: dfR,
      rank: size + 1,
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
      sample: rows,
      level: options.level,
    },
    p = isMissing(F) ? MISSING : Ftail(size, dfR, F),
    values = [
      ["Number of obs", count(n)],
      ["No. of categories", count(groups)],
      [`F(${size}, ${dfR})`, applyFormat(F, "%9.2f").trim()],
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
  session.results.e = {
    N: n,
    df_m: size,
    df_r: dfR,
    F,
    p,
    r2,
    r2_a: r2a,
    rmse,
    mss: model.mss,
    rss,
    tss,
    ll: model.ll,
    ll_0: model.ll_0,
    rank: size + 1,
    df_a: dfAbsorbed,
    k_absorb: groups,
    ...(robust || hc2 ? {} : { F_absorb: fAbsorb, p_absorb: pAbsorb }),
    ...(clusters ? { N_clust: clusters } : {}),
    cmd: "areg",
    title: model.title,
    depvar: model.depvar,
    absvar: absorb.name,
    vce,
    ...(vcetype ? { vcetype } : {}),
    ...(asked.cluster ? { clustvar: asked.cluster.name } : {}),
    ...(wtype ? { wtype, wexp: `= ${parsed.weight.exp}` } : {}),
  };
  for (const k of active.keys())
    if (!kept.includes(k))
      ctx.out(`note: ${active[k].name} omitted because of collinearity.`);
  if (wtype && wtype !== "fweight")
    ctx.out(`(sum of wgt is ${sumOfWeights(sumW)})`);
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
      return `${g(model.b[k]).padStart(11)}${g(se).padStart(11)}${applyFormat(t, "%9.2f")}${applyFormat(known ? 2 * ttail(dfR, Math.abs(t)) : MISSING, "%8.3f")}${g(bound(-1)).padStart(13)}${g(bound(1)).padStart(12)}`;
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

/** The sum of weights as areg reports it, to sixteen significant digits. */
function sumOfWeights(value) {
  const text = value.toPrecision(16);
  return text.includes("e")
    ? text
    : text.includes(".")
      ? text.replace(/0+$/, "").replace(/\.$/, "")
      : text;
}

export const MORE_ESTIMATORS = [{ name: "areg", minimum: 4, run: areg }];
