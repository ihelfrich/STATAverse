// Estimators fitted by maximum likelihood (logit, probit, poisson) and by
// two-stage least squares (ivregress 2sls), with estat and estimates. They
// leave the same result object regress leaves, marked dist "z", and the
// post-estimation commands here read only that object.
import { firstStage, ivDiagnostic } from "./more-estimators.js";
import { estimatesStats, estimatesTable, lrtest } from "./comparisons.js";
import { regressDiagnostic, testparm } from "./diagnostics.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { invnormal, normal } from "./functions.js";
import { count } from "./reports.js";
import { linkOf } from "./margins.js";
import { outcomePredict } from "./outcome-margins.js";
import {
  RULE,
  describeLinear,
  design,
  estimates,
  invertSymmetric,
  lincom as lincomT,
  linear,
  predict as predictT,
  quadratic,
  termRows,
  test as testT,
} from "./estimation.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing } from "./values.js";
import { clusterMeat, clusterNote, noCluster, readVce } from "./vce.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const density = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

function lnfactorial(n) {
  let total = 0;
  for (let k = 2; k <= n; k++) total += Math.log(k);
  return total;
}
const FAMILIES = {
  logit: {
    title: "Logistic regression",
    mean: (xb) => 1 / (1 + Math.exp(-xb)),
    // Contribution to the log likelihood, its first derivative with respect
    // to xb, and minus its second derivative.
    ll: (y, xb) => (y ? -Math.log1p(Math.exp(-xb)) : -Math.log1p(Math.exp(xb))),
    score: (y, xb) => y - 1 / (1 + Math.exp(-xb)),
    weight: (y, xb) => {
      const p = 1 / (1 + Math.exp(-xb));
      return p * (1 - p);
    },
    binary: true,
    exponentiated: ["or", "Odds ratio", "Note: _cons estimates baseline odds."],
    predict: ["pr", (model) => `Pr(${model.depvar})`, "Pr"],
  },
  probit: {
    title: "Probit regression",
    mean: (xb) => normal(xb),
    ll: (y, xb) => Math.log(y ? normal(xb) : normal(-xb)),
    score: (y, xb) =>
      y ? density(xb) / normal(xb) : -density(xb) / normal(-xb),
    weight: (y, xb) => {
      const lambda = y ? density(xb) / normal(xb) : -density(xb) / normal(-xb);
      return lambda * (lambda + xb);
    },
    binary: true,
    predict: ["pr", (model) => `Pr(${model.depvar})`, "Pr"],
  },
  poisson: {
    title: "Poisson regression",
    mean: (xb) => Math.exp(xb),
    ll: (y, xb) => y * xb - Math.exp(xb) - lnfactorial(y),
    score: (y, xb) => y - Math.exp(xb),
    weight: (y, xb) => Math.exp(xb),
    exponentiated: [
      "irr",
      "IRR",
      "Note: _cons estimates baseline incidence rate.",
    ],
    predict: [
      "n",
      () => "predicted number of events",
      "Predicted number of events",
    ],
  },
};

function zTable(session, model, level, transform) {
  const critical = invnormal(1 - (1 - level / 100) / 2),
    robust = model.vce !== "oim" && model.vce !== "unadjusted",
    head = (transform?.[1] ?? "Coefficient").padStart(10).padEnd(11),
    lines = [
      RULE,
      ...(robust ? ["             |               Robust"] : []),
      `${model.depvar.padStart(12)} | ${head}  ${robust ? "std" : "Std"}. err.      z    P>|z|     [${g(level)}% conf. interval]`,
      "-------------+----------------------------------------------------------------",
    ];
  const show = transform ? Math.exp : (v) => v;
  lines.push(
    ...termRows(session, model, (k) => {
      const b = model.b[k],
        se = Math.sqrt(model.V[k][k]),
        z = b / se;
      return `${g(show(b)).padStart(11)}${g(transform ? Math.exp(b) * se : se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(2 * normal(-Math.abs(z)), "%8.3f")}${g(show(b - critical * se)).padStart(13)}${g(show(b + critical * se)).padStart(12)}`;
    }),
  );
  lines.push(RULE);
  if (transform && model.constant) lines.push(transform[2]);
  return lines;
}

function waldChi2(model) {
  const k = model.df_m;
  if (!k) return MISSING;
  const at = model.names
      .map((name, i) => (name !== "_cons" && model.estimable[i] ? i : -1))
      .filter((i) => i >= 0),
    inverse = invertSymmetric(at.map((i) => at.map((j) => model.V[i][j])));
  return inverse
    ? quadratic(
        at.map((i) => model.b[i]),
        inverse,
      )
    : MISSING;
}

function maximumLikelihood(kind) {
  const family = FAMILIES[kind];
  return (session, text, ctx) => {
    const parsed = session.parse(
        "anything [if] [in] [, noCONStant Robust VCE(string) CLuster(string) Level(cilevel) noLOg OR IRr]",
        text,
      ),
      options = parsed.options,
      rows = session.rows(parsed, null),
      constant = options.constant !== false,
      { robust, cluster } = readVce(session, options, /^oim$/),
      {
        dependent,
        columns,
        sample: complete,
      } = design(session, parsed.anything, rows, constant),
      sample = cluster
        ? complete.filter((i) => !noCluster(cluster, i))
        : complete,
      n = sample.length;
    if (!n) throw new StataError("no observations", 2000);
    const y = sample.map((i) => dependent.data[i]);
    if (family.binary) {
      const outcome = y.map((v) => Number(v !== 0));
      if (outcome.every((v) => v === outcome[0]))
        throw new StataError(
          "outcome does not vary; remember:\n                                  0 = negative outcome,\n        all other nonmissing values = positive outcome",
          2000,
        );
      y.splice(0, n, ...outcome);
    } else if (y.some((v) => v < 0 || !Number.isInteger(v)))
      throw new StataError(
        `${dependent.name} must be a nonnegative count`,
        459,
      );
    const active = columns.filter((c) => !c.base),
      x = sample.map((i) => [
        ...active.map((c) => c.value(i)),
        ...(constant ? [1] : []),
      ]),
      size = active.length + (constant ? 1 : 0),
      mean = y.reduce((a, b) => a + b, 0) / n,
      // Start at the constant-only model.
      start = family.binary
        ? kind === "logit"
          ? Math.log(mean / (1 - mean))
          : invnormal(mean)
        : Math.log(mean),
      logLikelihood = (b) =>
        x.reduce(
          (total, row, i) =>
            total +
            family.ll(
              y[i],
              row.reduce((t, v, k) => t + v * b[k], 0),
            ),
          0,
        );
    let b = new Array(size).fill(0);
    if (constant) b[size - 1] = start;
    const ll0 = constant ? logLikelihood(b) : MISSING,
      word = robust ? "Log pseudolikelihood" : "Log likelihood",
      log = [];
    let ll = logLikelihood(b),
      information;
    const derivatives = () => {
      const gradient = new Array(size).fill(0),
        hessian = Array.from({ length: size }, () => new Array(size).fill(0));
      x.forEach((row, i) => {
        const xb = row.reduce((t, v, k) => t + v * b[k], 0),
          s = family.score(y[i], xb),
          w = family.weight(y[i], xb);
        for (let a = 0; a < size; a++) {
          gradient[a] += s * row[a];
          for (let c = 0; c <= a; c++) hessian[a][c] += w * row[a] * row[c];
        }
      });
      for (let a = 0; a < size; a++)
        for (let c = 0; c < a; c++) hessian[c][a] = hessian[a][c];
      return { gradient, hessian };
    };
    if (kind === "poisson") {
      // Stata starts poisson from a weighted least-squares step, so its
      // first reported value is already close to the maximum.
      for (let k = 0; k < 2; k++) {
        const { gradient, hessian } = derivatives(),
          inverse = invertSymmetric(hessian);
        if (!inverse) break;
        b = b.map(
          (v, a) => v + inverse[a].reduce((t, h, c) => t + h * gradient[c], 0),
        );
      }
      ll = logLikelihood(b);
    }
    log.push(ll);
    for (let iteration = 1; iteration <= 100; iteration++) {
      const { gradient, hessian } = derivatives();
      information = invertSymmetric(hessian);
      if (!information)
        throw new StataError(
          "the model could not be fitted: the regressors are collinear or predict the outcome perfectly",
          430,
        );
      let step = information.map((row) =>
          row.reduce((t, h, c) => t + h * gradient[c], 0),
        ),
        next = b.map((v, a) => v + step[a]),
        nextLl = logLikelihood(next);
      // Halve the step when it would lower the likelihood.
      for (let halve = 0; halve < 20 && !(nextLl >= ll); halve++) {
        step = step.map((v) => v / 2);
        next = b.map((v, a) => v + step[a]);
        nextLl = logLikelihood(next);
      }
      const change = Math.abs(nextLl - ll) / Math.max(1e-300, Math.abs(ll));
      b = next;
      ll = nextLl;
      log.push(ll);
      if (change < 1e-7) break;
      if (iteration === 100)
        throw new StataError("convergence not achieved", 430);
    }
    information = invertSymmetric(derivatives().hessian);
    let V = information,
      clusters = null;
    if (robust) {
      // Each observation is its own cluster unless one was named; the
      // correction is G / (G - 1) with G the number of clusters.
      const scoreOf = (i) => {
          const s = family.score(
            y[i],
            x[i].reduce((t, v, k) => t + v * b[k], 0),
          );
          return x[i].map((v) => v * s);
        },
        own = { data: sample.map((_, i) => i) },
        { meat, clusters: G } = clusterMeat(
          cluster ?? own,
          cluster ? sample : own.data,
          scoreOf,
          size,
        ),
        bm = information.map((row) =>
          meat[0].map((_, c) => row.reduce((t, v, k) => t + v * meat[k][c], 0)),
        );
      if (cluster) clusters = G;
      V = bm.map((row) =>
        information[0].map(
          (_, c) =>
            (G / (G - 1)) *
            row.reduce((t, v, k) => t + v * information[k][c], 0),
        ),
      );
    }
    const names = [
        ...columns.map((c) => c.name),
        ...(constant ? ["_cons"] : []),
      ],
      position = new Map(active.map((c, k) => [c.name, k]));
    if (constant) position.set("_cons", size - 1);
    const model = {
      command: kind,
      title: family.title,
      dist: "z",
      depvar: dependent.name,
      names,
      b: names.map((name) => (position.has(name) ? b[position.get(name)] : 0)),
      V: names.map((r) =>
        names.map((c) =>
          position.has(r) && position.has(c)
            ? V[position.get(r)][position.get(c)]
            : 0,
        ),
      ),
      columns,
      constant,
      estimable: names.map((name) => position.has(name)),
      N: n,
      df_m: active.length,
      rank: size,
      ll,
      ll_0: ll0,
      vce: cluster ? "cluster" : robust ? "robust" : "oim",
      clusters,
      clusterName: cluster?.name,
      family,
      kind,
      sample,
    };
    const chi2 = robust ? waldChi2(model) : 2 * (ll - ll0),
      p = isMissing(chi2) ? MISSING : chi2tail(model.df_m, chi2),
      r2 = isMissing(ll0) ? MISSING : 1 - ll / ll0,
      transform =
        family.exponentiated && options[family.exponentiated[0]]
          ? family.exponentiated
          : null,
      side = (label, value) => `${label.padEnd(14)}=${value.padStart(7)}`;
    Object.assign(model, { chi2, p, r2_p: r2 });
    session.estimates = model;
    session.results.e = {
      N: n,
      df_m: model.df_m,
      ll,
      ll_0: ll0,
      chi2,
      p,
      r2_p: r2,
      rank: size,
      k: size,
      ic: log.length - 1,
      converged: 1,
      cmd: kind,
      depvar: model.depvar,
      vce: model.vce,
      ...(robust ? { vcetype: "Robust" } : {}),
      ...(cluster ? { N_clust: clusters, clustvar: cluster.name } : {}),
    };
    ctx.out("");
    if (!/\bnolog\b/.test(splitAtComma(text)[1] ?? ""))
      log.forEach((value, k) =>
        ctx.out(
          `Iteration ${k}:  ${word} = ${g(value, "%10.0g").padStart(10)}`,
        ),
      );
    ctx.out("");
    ctx.out(`${family.title.padEnd(56)}${side("Number of obs", count(n))}`);
    ctx.out(
      `${"".padEnd(56)}${side(`${robust ? "Wald" : "LR"} chi2(${model.df_m})`, applyFormat(chi2, "%7.2f").trim())}`,
    );
    ctx.out(
      `${"".padEnd(56)}${side("Prob > chi2", applyFormat(p, "%6.4f").trim())}`,
    );
    ctx.out(
      `${`${word} = ${g(ll, "%10.0g")}`.padEnd(56)}${side("Pseudo R2", applyFormat(r2, "%6.4f").trim())}`,
    );
    ctx.out("");
    if (cluster) ctx.out(clusterNote(clusters, cluster.name, count));
    zTable(session, model, options.level, transform).forEach(ctx.out);
    ctx.out("");
  };
}

/** The inverse of a square matrix that need not be definite, or null. */
function invertGeneral(A) {
  const n = A.length,
    m = A.map((row, i) => [
      ...row,
      ...Array.from({ length: n }, (_, j) => Number(i === j)),
    ]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (!(Math.abs(m[pivot][c]) > 1e-300)) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}
/**
 * The smallest k with |A - kB| = 0 for symmetric A and positive definite
 * B: the smallest eigenvalue of L^-1 A L^-T, where B = LL', by Jacobi
 * rotations.
 */
function smallestRoot(A, B) {
  const n = A.length,
    L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = B[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > 0))
          throw new StataError("the instruments are collinear", 198);
        L[i][i] = Math.sqrt(sum);
      } else L[i][j] = sum / L[j][j];
    }
  // Solve L X = A, then L C' = X': C = L^-1 A L^-T.
  const forward = (rhs) => {
      const out = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        let sum = rhs[i];
        for (let k = 0; k < i; k++) sum -= L[i][k] * out[k];
        out[i] = sum / L[i][i];
      }
      return out;
    },
    half = Array.from({ length: n }, (_, c) => forward(A.map((row) => row[c]))),
    // half[c] is column c of L^-1 A; its rows solved again give C.
    C = Array.from({ length: n }, (_, r) =>
      forward(half.map((columnValues) => columnValues[r])),
    );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += C[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(C[p][q]) < 1e-300) continue;
        const theta = (C[q][q] - C[p][p]) / (2 * C[p][q]),
          t =
            Math.sign(theta || 1) /
            (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s2 = t * c;
        for (let k = 0; k < n; k++) {
          const a = C[k][p],
            b2 = C[k][q];
          C[k][p] = c * a - s2 * b2;
          C[k][q] = s2 * a + c * b2;
        }
        for (let k = 0; k < n; k++) {
          const a = C[p][k],
            b2 = C[q][k];
          C[p][k] = c * a - s2 * b2;
          C[q][k] = s2 * a + c * b2;
        }
      }
  }
  return Math.min(...C.map((row, i) => row[i]));
}

// ----- two-stage least squares -----
function ivregress(session, text, ctx) {
  const m =
    /^\s*(2sls|liml|gmm)\s+(\S+)\s+([^()]*)\(([^=()]+)=([^()]+)\)((?:(?!\b(?:if|in)\b)[^(),])*)([\s\S]*)$/.exec(
      text,
    );
  if (!m)
    throw new StataError(
      "ivregress needs an estimator and (endogenous = instruments)",
      198,
    );
  const estimator = m[1],
    parsed = session.parse(
      "[if] [in] [, Robust VCE(string) CLuster(string) Level(cilevel) First WMATrix(string) | noCONStant SMALL Igmm]",
      m[7],
    ),
    names = (part) => (part.trim() ? session.varlist(part) : []),
    endogenous = names(m[4]),
    exogenous = [...names(m[3]), ...names(m[6])],
    instruments = names(m[5]),
    weighting = (parsed.options.wmatrix ?? "robust").trim(),
    asked = readVce(session, parsed.options, /^un(adjusted)?$/),
    cluster = asked.cluster,
    robust =
      asked.robust ||
      (estimator === "gmm" && /^r/.test(weighting) && !parsed.options.vce),
    column = (name) => {
      const data = session.data.get(name).data;
      return data;
    },
    all = [m[2], ...endogenous, ...exogenous, ...instruments].map(
      (name) => session.varlist(name)[0],
    ),
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          all.every((name) => !isMissing(column(name)[i])) &&
          !(cluster && noCluster(cluster, i)),
      ),
    n = rows.length;
  if (cluster && estimator !== "2sls")
    throw new StataError(
      `ivregress ${estimator} with vce(cluster) is not available yet; ivregress 2sls takes it`,
      198,
    );
  if (instruments.length < endogenous.length)
    throw new StataError(
      "equation not identified; must have at least as many instruments not in\nthe regression as there are instrumented variables",
      481,
    );
  if (!n) throw new StataError("no observations", 2000);
  const dep = session.varlist(m[2])[0],
    y = rows.map((i) => column(dep)[i]),
    matrix = (list) =>
      rows.map((i) => [...list.map((name) => column(name)[i]), 1]),
    X = matrix([...endogenous, ...exogenous]),
    Z = matrix([...exogenous, ...instruments]),
    cross = (A, B) =>
      A[0].map((_, a) =>
        B[0].map((_, b) => A.reduce((t, row, i) => t + row[a] * B[i][b], 0)),
      ),
    multiply = (A, B) =>
      A.map((row) =>
        B[0].map((_, b) => row.reduce((t, v, k) => t + v * B[k][b], 0)),
      ),
    zzInverse = invertSymmetric(cross(Z, Z));
  if (!zzInverse) throw new StataError("the instruments are collinear", 198);
  // Fitted regressors: Z (Z'Z)^-1 Z'X.
  const coefficients = multiply(zzInverse, cross(Z, X)),
    fitted = Z.map((row) =>
      coefficients[0].map((_, b) =>
        row.reduce((t, v, k) => t + v * coefficients[k][b], 0),
      ),
    ),
    bread = invertSymmetric(cross(fitted, fitted));
  if (!bread) throw new StataError("the model is not identified", 481);
  const xy = fitted[0].map((_, a) =>
      fitted.reduce((t, row, i) => t + row[a] * y[i], 0),
    ),
    twoStage = bread.map((row) => row.reduce((t, v, k) => t + v * xy[k], 0)),
    residualsOf = (beta) =>
      y.map((v, i) => v - X[i].reduce((t, value, k) => t + value * beta[k], 0)),
    columnOf = (rows2, k) => rows2.map((row) => row[k]),
    solve = (A, v) => A.map((row) => row.reduce((t, a, k) => t + a * v[k], 0));
  if (estimator === "gmm" && !/^(r|un)/.test(weighting))
    throw new StataError(
      `wmatrix(${weighting}) is not available yet; robust and unadjusted are`,
      198,
    );
  let b = twoStage,
    kClass = null,
    gmm = null;
  if (estimator === "liml") {
    // kappa is the smallest root of |Y'M1 Y - k Y'M Y| = 0, where Y holds
    // the outcome and the endogenous regressors, M1 removes the exogenous
    // regressors and M removes every instrument.
    const exo = matrix(exogenous),
      residualOn = (A, v) => {
        const inverse = invertSymmetric(cross(A, A)),
          coefficient = solve(
            inverse,
            A[0].map((_, a) => A.reduce((t, row, i) => t + row[a] * v[i], 0)),
          );
        return v.map(
          (value, i) =>
            value - A[i].reduce((t, a, k) => t + a * coefficient[k], 0),
        );
      },
      Y = [y, ...endogenous.map((_, k) => columnOf(X, k))],
      inner = (U) =>
        U.map((a) => U.map((c) => a.reduce((t, v, i) => t + v * c[i], 0))),
      M1 = inner(Y.map((v) => residualOn(exo, v))),
      MZ = Y.map((v) => residualOn(Z, v)),
      M = inner(MZ),
      kappa = smallestRoot(M1, M),
      // (X'(I - kM)X) b = X'(I - kM) y, with MX the residuals of X on Z.
      MX = X[0].map((_, k) => residualOn(Z, columnOf(X, k))),
      My = MZ[0],
      A = X[0].map((_, a) =>
        X[0].map(
          (_, c) =>
            X.reduce((t, row) => t + row[a] * row[c], 0) -
            kappa * MX[a].reduce((t, v, i) => t + v * MX[c][i], 0),
        ),
      ),
      rhs = X[0].map(
        (_, a) =>
          X.reduce((t, row, i) => t + row[a] * y[i], 0) -
          kappa * MX[a].reduce((t, v, i) => t + v * My[i], 0),
      ),
      inverse = invertGeneral(A);
    if (!inverse) throw new StataError("the model is not identified", 481);
    b = solve(inverse, rhs);
    kClass = { kappa, inverse, MX };
  } else if (estimator === "gmm") {
    const first = residualsOf(twoStage),
      rss1 = first.reduce((t, e) => t + e * e, 0),
      zx = cross(Z, X),
      zy = Z[0].map((_, a) => Z.reduce((t, row, i) => t + row[a] * y[i], 0)),
      momentCovariance = (e) =>
        Z[0].map((_, a) =>
          Z[0].map(
            (_, c) =>
              Z.reduce((t, row, i) => t + e[i] * e[i] * row[a] * row[c], 0) / n,
          ),
        ),
      S = /^r/.test(weighting)
        ? momentCovariance(first)
        : cross(Z, Z).map((row) => row.map((v) => (v * rss1) / n / n)),
      W = invertSymmetric(S);
    if (!W) throw new StataError("the weight matrix is singular", 506);
    const xzW = multiply(
        zx[0].map((_, a) => zx.map((row) => row[a])),
        W,
      ),
      A = invertSymmetric(multiply(xzW, zx));
    if (!A) throw new StataError("the model is not identified", 481);
    b = solve(A, solve(xzW, zy));
    gmm = { W, A, xzW, momentCovariance };
  }
  const residuals = residualsOf(b),
    rss = residuals.reduce((t, e) => t + e * e, 0),
    mean = y.reduce((a, c) => a + c, 0) / n,
    tss = y.reduce((t, v) => t + (v - mean) ** 2, 0);
  let V,
    clusters = null;
  if (gmm) {
    // n (X'Z W Z'X)^-1 when the weight matrix is taken as the truth; with
    // a robust variance the middle is rebuilt from the final residuals.
    if (robust) {
      const S2 = gmm.momentCovariance(residuals),
        middle = multiply(
          multiply(gmm.xzW, S2),
          gmm.xzW[0].map((_, a) => gmm.xzW.map((row) => row[a])),
        );
      V = multiply(multiply(gmm.A, middle), gmm.A).map((row) =>
        row.map((v) => v * n),
      );
    } else V = gmm.A.map((row) => row.map((v) => v * n));
    const moments = Z[0].map(
      (_, a) => Z.reduce((t, row, i) => t + row[a] * residuals[i], 0) / n,
    );
    gmm.J =
      n *
      moments.reduce(
        (t, v, a) =>
          t + v * gmm.W[a].reduce((u, w, c) => u + w * moments[c], 0),
        0,
      );
  } else if (kClass) {
    if (robust)
      throw new StataError(
        "ivregress liml with a robust variance is not available yet",
        198,
      );
    V = kClass.inverse.map((row) => row.map((v) => (v * rss) / n));
  } else if (cluster) {
    const { meat, clusters: G } = clusterMeat(
      cluster,
      rows,
      (i) => fitted[i].map((v) => v * residuals[i]),
      b.length,
    );
    clusters = G;
    // Stata applies no small-sample factor here unless small is given.
    V = multiply(multiply(bread, meat), bread);
  } else if (robust) {
    const size = b.length,
      meat = Array.from({ length: size }, () => new Array(size).fill(0));
    fitted.forEach((row, i) => {
      for (let a = 0; a < size; a++)
        for (let c = 0; c < size; c++)
          meat[a][c] += residuals[i] ** 2 * row[a] * row[c];
    });
    V = multiply(multiply(bread, meat), bread);
  } else V = bread.map((row) => row.map((v) => (v * rss) / n));
  const namesOut = [...endogenous, ...exogenous, "_cons"],
    model = {
      command: "ivregress",
      title: `Instrumental-variables ${estimator === "2sls" ? "2SLS" : estimator.toUpperCase()} regression`,
      dist: "z",
      depvar: dep,
      names: namesOut,
      b,
      V,
      columns: [...endogenous, ...exogenous].map((name) => ({
        name,
        value: (i) => column(name)[i],
        term: { variable: session.data.get(name) },
        evaluate: (get) => get(session.data.get(name)),
        partial: (get, variable) => Number(variable === session.data.get(name)),
      })),
      constant: true,
      estimable: namesOut.map(() => true),
      N: n,
      df_m: namesOut.length - 1,
      rank: namesOut.length,
      rss,
      mss: tss - rss,
      r2: 1 - rss / tss,
      rmse: Math.sqrt(rss / n),
      vce: cluster ? "cluster" : robust ? "robust" : "unadjusted",
      clusters,
      clusterName: cluster?.name,
      kind: "ivregress",
      sample: rows,
      iv: {
        dep,
        endogenous,
        exogenous,
        instruments,
        rows,
        estimator,
        J: gmm?.J,
        robustWeights: !!gmm && /^r/.test(weighting),
      },
    };
  const chi2 = waldChi2(model),
    p = chi2tail(model.df_m, chi2),
    side = (label, value) => `${label.padEnd(16)}=${value.padStart(11)}`;
  Object.assign(model, { chi2, p });
  session.estimates = model;
  session.results.e = {
    N: n,
    df_m: model.df_m,
    chi2,
    p,
    r2: model.r2,
    rmse: model.rmse,
    rss,
    mss: model.mss,
    rank: model.rank,
    cmd: "ivregress",
    depvar: dep,
    vce: model.vce,
    estimator,
    ...(robust ? { vcetype: "Robust" } : {}),
    ...(cluster ? { N_clust: clusters, clustvar: cluster.name } : {}),
    ...(kClass ? { kappa: kClass.kappa } : {}),
    ...(gmm ? { J: gmm.J } : {}),
  };
  if (parsed.options.first) {
    firstStage(session, model.iv, parsed, ctx);
  }
  ctx.out("");
  [
    ["Number of obs", count(n)],
    [`Wald chi2(${model.df_m})`, applyFormat(chi2, "%9.2f").trim()],
    ["Prob > chi2", applyFormat(p, "%6.4f").trim()],
    // Stata leaves R-squared out when it would be negative.
    ...(model.r2 >= 0
      ? [["R-squared", applyFormat(model.r2, "%6.4f").trim()]]
      : []),
    ["Root MSE", "    " + applyFormat(model.rmse, "%7.0g")],
  ].forEach(([label, value], k, list) =>
    ctx.out(
      `${(k
        ? gmm && k === list.length - 1
          ? `GMM weight matrix: ${/^r/.test(weighting) ? "Robust" : "Unadjusted"}`
          : ""
        : model.title
      ).padEnd(50)}${side(label, value)}`,
    ),
  );
  ctx.out("");
  if (cluster) ctx.out(clusterNote(clusters, cluster.name, count));
  zTable(session, model, parsed.options.level, null).forEach(ctx.out);
  ctx.out(`Endogenous: ${endogenous.join(" ")}`);
  ctx.out(`Exogenous:  ${[...exogenous, ...instruments].join(" ")}`);
  ctx.out("");
}

// ----- post-estimation that depends on the distribution -----
function test(session, text, ctx) {
  const model = estimates(session);
  if (model.dist !== "z") return testT(session, text, ctx);
  const [head] = splitAtComma(text);
  // After mlogit a list of variables is tested in every equation at once.
  if (model.equations && /^[\sA-Za-z_0-9.]+$/.test(head))
    return acrossEquations(session, model, head.trim().split(/\s+/), ctx);
  const groups = head.match(/\([^()]*\)/g),
    specs = groups
      ? groups.map((s) => s.slice(1, -1))
      : /=/.test(head)
        ? [head]
        : head.trim().split(/\s+/).filter(Boolean);
  if (!specs.length) throw new StataError("nothing to test", 198);
  const constraints = specs.map((spec) => {
      const sides = spec.split(/==?/);
      return linear(
        model,
        sides.length === 2 ? `(${sides[0]}) - (${sides[1]})` : spec,
      );
    }),
    tag = (line) =>
      model.kind === "ivregress"
        ? line
        : line.replace(
            /(^|[-+*] ?|^-)([A-Za-z_0-9][\w.#]*)/g,
            (all, lead, name) =>
              model.names.includes(name)
                ? `${lead}[${model.depvar}]${name}`
                : all,
          );
  constraints.forEach((c, k) =>
    ctx.out(
      ` (${String(k + 1).padStart(2)})  ${tag(describeLinear(model, c.weights, c.constant))}`,
    ),
  );
  const q = constraints.length,
    difference = constraints.map(
      (c) => c.weights.reduce((t, w, k) => t + w * model.b[k], 0) + c.constant,
    ),
    inverse = invertSymmetric(
      constraints.map((a) =>
        constraints.map((b) =>
          a.weights.reduce(
            (t, wa, i) =>
              t +
              wa * b.weights.reduce((u, wb, j) => u + model.V[i][j] * wb, 0),
            0,
          ),
        ),
      ),
    );
  if (!inverse) throw new StataError("the constraints are redundant", 111);
  const chi2 = quadratic(difference, inverse),
    p = chi2tail(q, chi2);
  ctx.out("");
  ctx.out(
    `           chi2(${String(q).padStart(3)}) =${applyFormat(chi2, "%8.2f")}`,
  );
  ctx.out(`         Prob > chi2 =${applyFormat(p, "%10.4f")}`);
  ctx.out("");
  session.results.r = { drop: 0, chi2, df: q, p };
}

function lincom(session, text, ctx) {
  const model = estimates(session);
  if (model.dist !== "z") return lincomT(session, text, ctx);
  // [eq]name would read as a weight, so the expression is set aside
  // before the options are parsed.
  const [head, tail] = splitAtComma(text),
    parsed = {
      ...session.parse(
        "[, Level(cilevel) OR IRr EForm]",
        tail === null ? "" : `,${tail}`,
      ),
      anything: head.trim(),
    },
    { weights, constant } = linear(model, parsed.anything),
    estimate = weights.reduce((t, w, k) => t + w * model.b[k], 0) + constant,
    se = Math.sqrt(quadratic(weights, model.V)),
    level = parsed.options.level,
    critical = invnormal(1 - (1 - level / 100) / 2),
    z = estimate / se,
    p = 2 * normal(-Math.abs(z)),
    text1 = describeLinear(model, weights, 0),
    shown =
      model.kind === "ivregress"
        ? text1
        : text1.replace(/(?<![\w.#])([A-Za-z_0-9][\w.#]*)/g, (name) =>
            model.names.includes(name) ? `[${model.depvar}]${name}` : name,
          );
  ctx.out("");
  ctx.out(` ( 1)  ${shown}`);
  ctx.out("");
  ctx.out(RULE);
  ctx.out(
    `${model.depvar.padStart(12)} | Coefficient  Std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  ctx.out(
    `${"(1)".padStart(12)} |${g(estimate).padStart(11)}${g(se).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(p, "%8.3f")}${g(estimate - critical * se).padStart(13)}${g(estimate + critical * se).padStart(12)}`,
  );
  ctx.out(RULE);
  ctx.out("");
  session.results.r = {
    estimate,
    se,
    z,
    p,
    lb: estimate - critical * se,
    ub: estimate + critical * se,
    level,
  };
}

/**
 * test and testparm after mlogit: each named variable's coefficient is
 * zero in every equation. Stata lists the base outcome's too and drops it.
 */
function acrossEquations(session, model, words, ctx) {
  const variables = [];
  for (const word of words)
    for (const name of /^_cons$/.test(word) ? [word] : session.varlist(word))
      if (!variables.includes(name)) variables.push(name);
  const lines = [],
    dropped = [],
    at = [];
  for (const name of variables) {
    if (!model.names.some((n) => n.replace(/^[^:]+:/, "") === name))
      throw new StataError(`${name} not found`, 111);
    model.equations.forEach((equation, j) => {
      const number = String(lines.length + 1).padStart(2);
      if (j === model.baseEquation) {
        lines.push(` (${number})  [${equation}]o.${name} = 0`);
        dropped.push(lines.length);
      } else {
        lines.push(` (${number})  [${equation}]${name} = 0`);
        at.push(model.names.indexOf(`${equation}:${name}`));
      }
    });
  }
  const inverse = invertSymmetric(at.map((r) => at.map((c) => model.V[r][c])));
  if (!inverse) throw new StataError("the constraints are redundant", 111);
  const chi2 = quadratic(
      at.map((k) => model.b[k]),
      inverse,
    ),
    p = chi2tail(at.length, chi2);
  ctx.out("");
  lines.forEach(ctx.out);
  dropped.forEach((k) => ctx.out(`       Constraint ${k} dropped`));
  ctx.out("");
  ctx.out(
    `           chi2(${String(at.length).padStart(3)}) =${applyFormat(chi2, "%8.2f")}`,
  );
  ctx.out(`         Prob > chi2 =${applyFormat(p, "%10.4f")}`);
  ctx.out("");
  session.results.r = {
    ...Object.fromEntries(
      dropped.map((k, n) => [`dropped_${n + 1}`, k]).reverse(),
    ),
    drop: 1,
    chi2,
    df: at.length,
    p,
  };
}
function predict(session, text, ctx) {
  const model = estimates(session);
  if (["ologit", "oprobit", "mlogit"].includes(model.kind))
    return outcomePredict(session, model, text, ctx);
  // nbreg, glm and cloglog predict a mean by default, as the family models
  // do; what they call it differs.
  const family =
    model.family ??
    {
      nbreg: {
        predict: [
          "n",
          () => "predicted number of events",
          "Predicted number of events",
        ],
      },
      glm: {
        predict: [
          "mu",
          () => `predicted mean ${model.depvar}`,
          `Predicted mean ${model.depvar}`,
        ],
      },
      cloglog: { predict: ["pr", () => `Pr(${model.depvar})`, "Pr"] },
    }[model.kind];
  if (!family) return predictT(session, text, ctx);
  const [key, describe, label] = family.predict,
    mean = family.mean ?? linkOf(model)[0],
    pearson = model.kind === "logit",
    parsed = session.parse(
      `newvarname [if] [in] [, XB ${{ pr: "Pr", n: "N", mu: "MU" }[key]} STDP${pearson ? " Residuals" : ""}]`,
      text,
    ),
    wantXb = parsed.options.xb,
    data = session.data,
    values = new Array(data.n).fill(MISSING);
  if (
    !wantXb &&
    !parsed.options[key] &&
    !parsed.options.stdp &&
    !parsed.options.residuals
  )
    ctx.out(`(option ${key} assumed; ${describe(model)})`);
  // Pearson residuals after logit are taken over covariate patterns: the
  // observations of the estimation sample that share every regressor.
  const patterns = new Map(),
    patternOf = (i) =>
      model.names
        .map((name, k) => (name === "_cons" ? 1 : model.columns[k].value(i)))
        .join(" ");
  if (parsed.options.residuals) {
    const outcome = data.get(model.depvar).data;
    for (const i of model.sample ?? []) {
      const key2 = patternOf(i),
        entry = patterns.get(key2) ?? { m: 0, y: 0 };
      entry.m += 1;
      entry.y += Number(outcome[i] !== 0);
      patterns.set(key2, entry);
    }
  }
  session.select(parsed, null, (i) => {
    if (
      model.columns.some((c) =>
        (c.term.variables ?? [c.term.variable ?? c.term.factor]).some((v) =>
          isMissing(v.data[i]),
        ),
      )
    )
      return;
    const row = model.names.map((name, k) =>
        name === "_cons" ? 1 : model.columns[k].value(i),
      ),
      xb = row.reduce((t, v, k) => t + v * model.b[k], 0);
    if (parsed.options.residuals) {
      const entry = patterns.get(patternOf(i)),
        p = mean(xb);
      if (entry)
        values[i] = (entry.y - entry.m * p) / Math.sqrt(entry.m * p * (1 - p));
      return;
    }
    values[i] = parsed.options.stdp
      ? Math.sqrt(quadratic(row, model.V))
      : wantXb
        ? xb
        : mean(xb);
  });
  const sorted = [...data.sortedBy],
    made = data.generate(parsed.varlist[0], values, {
      type: parsed.typed[0] ? parsed.types[0] : undefined,
    });
  data.sortedBy = sorted;
  data.get(parsed.varlist[0]).label = wantXb
    ? model.kind === "logit"
      ? "Linear prediction (log odds)"
      : "Linear prediction"
    : parsed.options.stdp
      ? "S.E. of the prediction"
      : parsed.options.residuals
        ? "Pearson residual"
        : key === "pr"
          ? `Pr(${model.depvar})`
          : label;
  if (made.missing)
    ctx.out(
      `(${count(made.missing)} missing value${made.missing === 1 ? "" : "s"} generated)`,
    );
}

// ----- estat and estimates -----
function estat(session, text, ctx) {
  const model = estimates(session),
    what = text.trim().split(/[\s,]/)[0];
  if (what === "ic") {
    const ll0 =
        model.command === "regress"
          ? -0.5 *
            model.N *
            (Math.log(2 * Math.PI) + Math.log(model.tss / model.N) + 1)
          : (model.ll_0 ?? MISSING),
      k = model.rank,
      aic = -2 * model.ll + 2 * k,
      bic = -2 * model.ll + k * Math.log(model.N);
    if (model.ll === undefined || model.command === "newey")
      throw new StataError(
        "likelihood information not found in last estimation results",
        321,
      );
    ctx.out("");
    ctx.out(
      "Akaike's information criterion and Bayesian information criterion",
    );
    ctx.out("");
    ctx.out("-".repeat(77));
    ctx.out(
      "       Model |          N   ll(null)  ll(model)      df        AIC        BIC",
    );
    ctx.out(
      "-------------+---------------------------------------------------------------",
    );
    ctx.out(
      `${".".padStart(12)} |${count(model.N).padStart(11)}${g(ll0).padStart(11)}${g(model.ll).padStart(11)}${String(k).padStart(8)}${g(aic).padStart(11)}${g(bic).padStart(11)}`,
    );
    ctx.out("-".repeat(77));
    ctx.out("Note: BIC uses N = number of observations. See [R] IC note.");
    ctx.out("");
    session.results.r = {
      "matrix:S": {
        rowNames: ["."],
        colNames: ["N", "ll0", "ll", "df", "AIC", "BIC"],
        values: [[model.N, ll0, model.ll, k, aic, bic]],
      },
    };
  } else if (what === "vif") {
    if (model.command !== "regress")
      throw new StataError("estat vif is only available after regress", 301);
    const s2 = model.rss / model.dfResidual,
      rows = session.rows({}, null),
      vifs = [];
    model.names.forEach((name, k) => {
      if (name === "_cons" || !model.estimable[k]) return;
      const values = rows
          .map(model.columns[k].value)
          .filter((v) => !isMissing(v)),
        mean = values.reduce((a, b) => a + b, 0) / values.length,
        ss = values.reduce((t, v) => t + (v - mean) ** 2, 0);
      vifs.push([name, (model.V[k][k] * ss) / s2]);
    });
    vifs.sort((a, b) => b[1] - a[1]);
    ctx.out("");
    ctx.out("    Variable |       VIF       1/VIF  ");
    ctx.out("-------------+----------------------");
    for (const [name, vif] of vifs)
      ctx.out(
        `${name.padStart(12)} |${applyFormat(vif, "%10.2f")}${applyFormat(1 / vif, "%12.6f")}`,
      );
    ctx.out("-------------+----------------------");
    ctx.out(
      `${"Mean VIF".padStart(12)} |${applyFormat(vifs.reduce((t, v) => t + v[1], 0) / vifs.length, "%10.2f")}`,
    );
    ctx.out("");
  } else if (what === "gof" && model.kind === "poisson") {
    const outcome = session.data.get(model.depvar).data;
    let deviance = 0,
      pearson = 0;
    for (const i of model.sample) {
      const mu = Math.exp(
          model.names.reduce(
            (t, name, k) =>
              t +
              model.b[k] * (name === "_cons" ? 1 : model.columns[k].value(i)),
            0,
          ),
        ),
        y = outcome[i];
      deviance += 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));
      pearson += (y - mu) ** 2 / mu;
    }
    const df = model.N - model.rank,
      line = (label, value) =>
        ctx.out(`         ${label.padEnd(25)}=${value.padStart(10)}`);
    ctx.out("");
    line("Deviance goodness-of-fit", g(deviance));
    line(
      `Prob > chi2(${df})`,
      applyFormat(chi2tail(df, deviance), "%6.4f").trim(),
    );
    ctx.out("");
    line("Pearson goodness-of-fit", g(pearson));
    line(
      `Prob > chi2(${df})`,
      applyFormat(chi2tail(df, pearson), "%6.4f").trim(),
    );
    ctx.out("");
    session.results.r = { chi2_d: deviance, chi2_p: pearson, df };
  } else if (what === "gof" || /^clas/.test(what)) {
    if (!model.family?.binary)
      throw new StataError(
        `estat ${what} is only available after logit and probit`,
        321,
      );
    const outcome = session.data.get(model.depvar).data,
      rows = model.sample,
      index = (i) =>
        model.names.reduce(
          (t, name, k) =>
            t + model.b[k] * (name === "_cons" ? 1 : model.columns[k].value(i)),
          0,
        ),
      p = rows.map((i) => model.family.mean(index(i))),
      y = rows.map((i) => Number(outcome[i] !== 0)),
      kind = model.kind === "logit" ? "logistic" : "probit";
    ctx.out("");
    if (what === "gof") {
      // Observations with the same covariates form one pattern.
      const patterns = new Map();
      rows.forEach((i, r) => {
        const key = JSON.stringify(model.columns.map((c) => c.value(i))),
          cell = patterns.get(key) ?? { n: 0, y: 0, p: p[r] };
        cell.n++;
        cell.y += y[r];
        patterns.set(key, cell);
      });
      let chi2 = 0;
      for (const cell of patterns.values())
        chi2 +=
          (cell.y - cell.n * cell.p) ** 2 / (cell.n * cell.p * (1 - cell.p));
      const df = patterns.size - model.rank,
        values = [
          count(rows.length),
          count(patterns.size),
          applyFormat(df > 0 ? chi2 : 0, "%9.2f").trim(),
          df > 0 ? applyFormat(chi2tail(df, chi2), "%6.4f").trim() : ".",
        ],
        width = Math.max(...values.map((v) => v.length)) + 1;
      ctx.out(`Goodness-of-fit test after ${kind} model`);
      ctx.out(`Variable: ${model.depvar}`);
      ctx.out("");
      [
        "Number of observations",
        "Number of covariate patterns",
        `Pearson chi2(${Math.max(0, df)})`,
        "Prob > chi2",
      ].forEach((label, k) =>
        ctx.out(`${label.padStart(28)} =${values[k].padStart(width)}`),
      );
      ctx.out("");
      session.results.r = {
        N: rows.length,
        m: patterns.size,
        chi2: df > 0 ? chi2 : 0,
        df: Math.max(0, df),
      };
      return;
    }
    let tp = 0,
      fp = 0,
      fn = 0,
      tn = 0;
    y.forEach((actual, r) => {
      const positive = p[r] >= 0.5;
      if (positive && actual) tp++;
      else if (positive) fp++;
      else if (actual) fn++;
      else tn++;
    });
    const percent = (a, b) =>
        `${applyFormat(b ? (100 * a) / b : MISSING, "%8.2f")}%`,
      line = (label, code, a, b) =>
        ctx.out(`${label.padEnd(32)}${code}${percent(a, b)}`),
      rule = "-".repeat(50),
      row = (label, a, b) =>
        ctx.out(
          `${label}|${count(a).padStart(10)}${count(b).padStart(14)}  |${count(a + b).padStart(11)}`,
        );
    ctx.out(
      `${kind[0].toUpperCase() + kind.slice(1)} model for ${model.depvar}`,
    );
    ctx.out("");
    ctx.out("              -------- True --------");
    ctx.out("Classified |         D            ~D  |      Total");
    ctx.out("-----------+--------------------------+-----------");
    row("     +     ", tp, fp);
    row("     -     ", fn, tn);
    ctx.out("-----------+--------------------------+-----------");
    row("   Total   ", tp + fn, fp + tn);
    ctx.out("");
    ctx.out("Classified + if predicted Pr(D) >= .5");
    ctx.out(`True D defined as ${model.depvar} != 0`);
    ctx.out(rule);
    line("Sensitivity", "Pr( +| D)", tp, tp + fn);
    line("Specificity", "Pr( -|~D)", tn, tn + fp);
    line("Positive predictive value", "Pr( D| +)", tp, tp + fp);
    line("Negative predictive value", "Pr(~D| -)", tn, tn + fn);
    ctx.out(rule);
    line("False + rate for true ~D", "Pr( +|~D)", fp, tn + fp);
    line("False - rate for true D", "Pr( -| D)", fn, tp + fn);
    line("False + rate for classified +", "Pr(~D| +)", fp, tp + fp);
    line("False - rate for classified -", "Pr( D| -)", fn, tn + fn);
    ctx.out(rule);
    ctx.out(
      `${"Correctly classified".padEnd(41)}${percent(tp + tn, rows.length)}`,
    );
    ctx.out(rule);
    ctx.out("");
    session.results.r = {
      P_corr: (100 * (tp + tn)) / rows.length,
      P_p1: (100 * tp) / (tp + fn),
      P_n0: (100 * tn) / (tn + fp),
    };
  } else if (ivDiagnostic(session, model, what, ctx)) {
    // Printed by the diagnostic.
  } else if (!regressDiagnostic(session, model, what, text, ctx))
    throw new StataError(`estat ${what} is not available yet`, 321);
}

function estimatesCommand(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text),
    stored = (session.storedEstimates ??= new Map());
  if (!m) throw new StataError("invalid syntax", 198);
  const [, action, rest] = m,
    name = rest.replace(/,.*$/, "").trim();
  if (/^sto(re?)?$/.test(action)) {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new StataError("invalid name", 198);
    const model = estimates(session),
      data = session.data,
      marker = `_est_${name}`,
      inSample = new Set(model.sample),
      order = [...data.sortedBy];
    stored.set(name, { model, e: { ...session.results.e } });
    // Stata marks the estimation sample in a variable named after the store.
    if (data.has(marker)) data.drop([marker]);
    data.generate(
      marker,
      Array.from({ length: data.n }, (_, i) => Number(inSample.has(i))),
      { type: "byte" },
    );
    data.get(marker).label = "esample() from estimates store";
    data.sortedBy = order;
  } else if (/^res(t(o(re?)?)?)?$/.test(action)) {
    const entry = stored.get(name);
    if (!entry)
      throw new StataError(`estimation result ${name} not found`, 111);
    session.estimates = entry.model;
    session.results.e = { ...entry.e };
    ctx.out(`(results ${name} are active now)`);
  } else if (action === "dir") {
    if (!stored.size) return;
    ctx.out("");
    ctx.out("-".repeat(66));
    ctx.out("             |           Dependent  Number of        ");
    ctx.out("        Name | Command    variable     param.  Title ");
    ctx.out(
      "-------------+----------------------------------------------------",
    );
    for (const [key, { model }] of stored)
      ctx.out(
        `${key.padStart(12)} | ${model.command.padEnd(7)}${model.depvar.padStart(12)}${String(model.rank).padStart(11)}  ${model.title ?? "Linear regression"}`,
      );
    ctx.out("-".repeat(66));
  } else if (/^tab(le?)?$/.test(action)) estimatesTable(session, rest, ctx);
  else if (/^stats?$/.test(action)) estimatesStats(session, rest, ctx);
  else if (action === "clear") {
    for (const key of stored.keys())
      if (session.data.has(`_est_${key}`)) session.data.drop([`_est_${key}`]);
    stored.clear();
  } else if (action === "drop") {
    for (const key of name === "_all" ? [...stored.keys()] : name.split(/\s+/))
      if (!stored.delete(key))
        throw new StataError(`estimation result ${key} not found`, 111);
      else if (session.data.has(`_est_${key}`))
        session.data.drop([`_est_${key}`]);
  } else throw new StataError(`estimates ${action} is not available yet`, 198);
}

export const MODEL_COMMANDS = [
  { name: "logit", minimum: 5, run: maximumLikelihood("logit") },
  { name: "probit", minimum: 4, run: maximumLikelihood("probit") },
  { name: "poisson", minimum: 4, run: maximumLikelihood("poisson") },
  {
    name: "logistic",
    minimum: 8,
    run: (session, text, ctx) => {
      // logistic is logit reporting odds ratios, without the iteration log.
      const [head, options] = splitAtComma(text);
      maximumLikelihood("logit")(
        session,
        `${head}, or nolog ${(options ?? "").replace(/\bor\b/, "")}`,
        ctx,
      );
      session.results.e.cmd = "logistic";
    },
  },
  { name: "lrtest", minimum: 6, run: lrtest },
  { name: "ivregress", minimum: 5, run: ivregress },
  { name: "test", minimum: 4, run: test },
  {
    name: "testparm",
    minimum: 8,
    run: (session, text, ctx) =>
      estimates(session).equations
        ? acrossEquations(
            session,
            estimates(session),
            splitAtComma(text)[0].trim().split(/\s+/).filter(Boolean),
            ctx,
          )
        : testparm(session, estimates(session), text, ctx),
  },
  { name: "lincom", minimum: 6, run: lincom },
  { name: "predict", minimum: 7, run: predict },
  { name: "estat", minimum: 5, run: estat },
  { name: "estimates", minimum: 3, run: estimatesCommand },
];
