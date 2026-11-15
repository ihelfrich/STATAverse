// arima: regression with ARMA disturbances, fitted by exact maximum
// likelihood through the Kalman filter, as Stata fits it by default, and
// predict after it.
//
// The model is y_t = x_t b + u_t with u_t an ARMA(p, q) process,
//   u_t = phi_1 u_{t-1} + ... + e_t + theta_1 e_{t-1} + ..., e_t ~ N(0, s^2).
// It is put in state-space form (Harvey's), the state's first element being
// u_t, and the filter starts from the state's stationary distribution, as
// arima_dr.ado does with kalman_solve_P0. Stata maximizes with BHHH for five
// iterations, then BFGS for ten, and so on (technique(bhhh 5 bfgs 10)), from
// the starting values arima.ado computes (least squares for b, then the
// regression of the residuals on their own lags and on the residuals of a
// long autoregression for the ARMA terms), and reports the outer product of
// the gradients (OPG) as the variance. This module does the same, with the
// observations' scores taken by central differences.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { parseNumlist } from "./numlist.js";
import { MISSING, isMissing } from "./values.js";
import { splitAtComma } from "./syntax.js";
import { count } from "./reports.js";
import { iterationLine, quadSum } from "./likelihood.js";
import { invertSymmetric, quadratic } from "./estimation.js";
import {
  DISPLAY_OPTIONS,
  collinearColumns,
  columnsShown,
  displayCells,
  displayOptions,
  equationLines,
  invsym,
  regressFit,
  stubWidth,
  gapCount,
  operate,
  showTime,
  tableHeading,
  termItems,
  timeFrame,
  tsTerm,
  tsTerms,
} from "./timeseries.js";

const g = (value, format = "%9.0g") =>
  applyFormat(Number.isFinite(value) ? value : MISSING, format).trim();
const LN2PI = Math.log(2 * Math.PI);

// ----- the likelihood -----

/**
 * The stationary variance of the state, scaled by s^2: the P that solves
 * P = T P T' + R R'. Returns null where there is none (a nonstationary
 * autoregression).
 */
function stationaryVariance(phi, R) {
  const r = phi.length,
    m = r * r;
  if (r === 1) {
    const p = (R[0] * R[0]) / (1 - phi[0] * phi[0]);
    return p > 0 && Number.isFinite(p) ? [p] : null;
  }
  // T[i][a] is phi_i for a = 0 and 1 for a = i + 1.
  const tEntries = (i) =>
    i + 1 < r
      ? [
          [0, phi[i]],
          [i + 1, 1],
        ]
      : [[0, phi[i]]];
  let P;
  if (r <= 13) {
    // vec(P) = (I - T x T)^-1 vec(RR'), solved directly, as Stata does.
    const A = Array.from({ length: m }, () => new Float64Array(m)),
      rhs = new Float64Array(m);
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) {
        const row = i * r + j;
        A[row][row] += 1;
        rhs[row] = R[i] * R[j];
        for (const [a, ta] of tEntries(i))
          for (const [b, tb] of tEntries(j)) A[row][a * r + b] -= ta * tb;
      }
    P = solve(A, rhs);
    if (!P) return null;
  } else {
    // Doubling: P = sum_j T^j RR' T'^j, in twice as many terms each step.
    let A = Array.from({ length: r }, (_, i) => {
        const out = new Float64Array(r);
        for (const [a, ta] of tEntries(i)) out[a] += ta;
        return out;
      }),
      S = Array.from({ length: r }, (_, i) =>
        Float64Array.from({ length: r }, (__, j) => R[i] * R[j]),
      );
    let converged = false;
    for (let step = 0; step < 60 && !converged; step++) {
      const AS = multiply(A, S),
        ASA = multiply(AS, transpose(A)),
        next = S.map((rowS, i) => rowS.map((v, j) => v + ASA[i][j]));
      let change = 0,
        size = 0;
      for (let i = 0; i < r; i++)
        for (let j = 0; j < r; j++) {
          change = Math.max(change, Math.abs(next[i][j] - S[i][j]));
          size = Math.max(size, Math.abs(next[i][j]));
        }
      S = next;
      A = multiply(A, A);
      if (!Number.isFinite(size) || size > 1e30) return null;
      converged = change <= 1e-16 * size;
    }
    if (!converged) return null;
    P = new Float64Array(m);
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) P[i * r + j] = S[i][j];
  }
  if (!(P[0] > 0) || !Number.isFinite(P[0])) return null;
  return Array.from(P);
}
function multiply(a, b) {
  const n = a.length;
  return Array.from({ length: n }, (_, i) => {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const v = a[i][k];
      if (v) for (let j = 0; j < n; j++) out[j] += v * b[k][j];
    }
    return out;
  });
}
const transpose = (a) =>
  a.map((_, i) => Float64Array.from({ length: a.length }, (__, j) => a[j][i]));
/** Gaussian elimination with partial pivoting; null if singular. */
function solve(A, b) {
  const n = b.length,
    a = A.map((r) => Float64Array.from(r)),
    x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!(Math.abs(a[p][c]) > 1e-300)) return null;
    if (p !== c) {
      [a[p], a[c]] = [a[c], a[p]];
      [x[p], x[c]] = [x[c], x[p]];
    }
    const pivot = a[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / pivot;
      if (!f) continue;
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
      x[r] -= f * x[c];
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    let s = x[c];
    for (let k = c + 1; k < n; k++) s -= a[c][k] * x[k];
    x[c] = s / a[c][c];
  }
  return x;
}

/**
 * Runs the Kalman filter over positions 0..n-1 of a series. y[t] is the
 * dependent variable and X[t] the regressors at position t, either null
 * where the period is not observed. Returns, for each position, the
 * one-step prediction of y (xb plus the predicted disturbance), its mean
 * squared error and, where y is observed and used, the log likelihood.
 * dynamicFrom, when given, is the first position whose observation is no
 * longer used to update the state.
 */
function kalman(spec, theta, y, X, { dynamicFrom = Infinity, lls } = {}) {
  const { r, k1, arLags, maLags } = spec,
    n = y.length,
    phi = new Float64Array(r),
    R = new Float64Array(r);
  arLags.forEach((lag, j) => (phi[lag - 1] = theta[k1 + j]));
  R[0] = 1;
  maLags.forEach((lag, j) => (R[lag] = theta[k1 + arLags.length + j]));
  const sigma = theta[theta.length - 1],
    s2 = sigma * sigma,
    P0 = r ? stationaryVariance(phi, R) : null;
  if (!(s2 > 0) || !P0) return null;
  const a = new Float64Array(r),
    P = Float64Array.from(P0),
    M = new Float64Array(r * r),
    pred = new Float64Array(n),
    mse = new Float64Array(n),
    beta = theta.slice(0, k1),
    logs2 = Math.log(s2),
    prior = new Float64Array(r * r);
  // Once the state's variance stops changing from one observed period to
  // the next (to the last digit), it stays put while periods keep being
  // observed, and the filter carries it unchanged.
  let steady = false;
  for (let t = 0; t < n; t++) {
    const row = X[t];
    let xb = NaN;
    if (row) {
      xb = 0;
      for (let j = 0; j < k1; j++) xb += row[j] * beta[j];
    }
    pred[t] = xb + a[0];
    mse[t] = s2 * P[0];
    const use = row && y[t] !== null && t < dynamicFrom;
    if (!steady) prior.set(P);
    if (use) {
      const F = P[0],
        v = y[t] - xb - a[0];
      if (!(F > 0)) return null;
      if (lls)
        lls[t] = -0.5 * (LN2PI + logs2 + Math.log(F) + (v * v) / (s2 * F));
      // Update: a += K v and P -= K K' F, with K the first column over F.
      for (let i = 0; i < r; i++) a[i] += (P[i * r] / F) * v;
      if (!steady) {
        for (let i = 0; i < r; i++) {
          const ki = P[i * r] / F;
          for (let j = 0; j < r; j++) M[i * r + j] = P[i * r + j] - ki * P[j];
        }
        P.set(M);
      }
    } else {
      if (lls) lls[t] = NaN;
      steady = false;
    }
    // Predict: a = T a; P = T P T' + R R'.
    const a0 = a[0];
    for (let i = 0; i < r; i++) a[i] = phi[i] * a0 + (i + 1 < r ? a[i + 1] : 0);
    if (steady) continue;
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++)
        M[i * r + j] = phi[i] * P[j] + (i + 1 < r ? P[(i + 1) * r + j] : 0);
    let change = 0,
      size = 0;
    for (let i = 0; i < r; i++)
      for (let j = 0; j < r; j++) {
        const value =
          phi[j] * M[i * r] + (j + 1 < r ? M[i * r + j + 1] : 0) + R[i] * R[j];
        change = Math.max(change, Math.abs(value - prior[i * r + j]));
        size = Math.max(size, Math.abs(value));
        P[i * r + j] = value;
      }
    if (use && change <= 1e-15 * size) steady = true;
  }
  return { pred, mse };
}

// ----- the model's specification and data -----

function lagList(text, option) {
  if (text === undefined) return [];
  const lags = text;
  if (lags.some((k) => !(k > 0) || k % 1))
    throw new StataError(
      `${option}() invalid -- invalid numlist has elements outside of allowed range`,
      125,
    );
  for (let j = 1; j < lags.length; j++)
    if (!(lags[j] > lags[j - 1]))
      throw new StataError(
        `${option}() invalid -- invalid numlist has elements out of order`,
        124,
      );
  return lags;
}

// What to try instead of an arima option the browser does not have.
const HINTS = {
  sarima:
    "Multiplicative seasonal terms are not available yet. An additive seasonal model lists the seasonal lags in ar() or ma(), as ar(1 12).",
  mar: "Multiplicative seasonal terms are not available yet. An additive seasonal model lists the seasonal lags in ar() or ma(), as ar(1 12).",
  mma: "Multiplicative seasonal terms are not available yet. An additive seasonal model lists the seasonal lags in ar() or ma(), as ma(1 12).",
  condition:
    "arima here fits by exact maximum likelihood with the Kalman filter, Stata's default; conditional least squares is not available yet.",
  diffuse:
    "arima here starts the Kalman filter from the stationary distribution of the disturbances, Stata's default.",
  p0: "arima here starts the Kalman filter from the stationary distribution of the disturbances, Stata's default.",
  state0:
    "arima here starts the Kalman filter from the stationary distribution of the disturbances, Stata's default.",
  technique:
    "arima here maximizes as Stata does by default: BHHH for five iterations, then BFGS for ten, in turn.",
  constraints: "Constrained arima models are not available yet.",
};
// Options that take an argument: repeating one is refused as option ar()
// not allowed, as Stata words it.
const WITH_ARGUMENT = new Set([
  "ar",
  "ma",
  "arima",
  "level",
  "vce",
  "iterate",
  "cformat",
  "pformat",
  "sformat",
]);
const parseWithHints = (session, declaration, text) => {
  // arima takes iweights; the other kinds are refused by name.
  const weight =
    /\[\s*(aw|aweights?|fw|fweights?|pw|pweights?|iw|iweights?)\s*=/i.exec(
      splitAtComma(text)[0],
    );
  if (weight) {
    const kind = weight[1][0].toLowerCase();
    if (kind === "i")
      throw new StataError(
        "iweights are not available in the browser yet",
        198,
        "arima here fits unweighted models.",
      );
    throw new StataError(`${kind}weights not allowed`, 101);
  }
  try {
    return session.parse(declaration, text);
  } catch (error) {
    const repeated =
      error instanceof StataError &&
      /^option (\w+) not allowed$/.exec(error.message);
    if (repeated && WITH_ARGUMENT.has(repeated[1]))
      throw new StataError(`option ${repeated[1]}() not allowed`, 198);
    const m =
      error instanceof StataError &&
      /^option (\w+) is not available/.exec(error.message);
    if (!m) throw error;
    const key = m[1].replace(/\d+$/, "");
    throw new StataError(
      error.message,
      error.code,
      HINTS[key] ??
        "arima here takes ar(), ma(), arima(), noconstant, level(), vce(), iterate(), nolog and the display options coeflegend, noci, cformat(), pformat(), sformat() and nocoef.",
    );
  }
};

/** What arima was asked to fit, read from its command line. */
function specification(session, text) {
  const parsed = parseWithHints(
      session,
      `anything [if] [in] [, AR(numlist) MA(numlist) ARIMA(string) noCONStant Level(cilevel) VCE(string) ROBust OPG HESsian noLOg ITERate(integer 300) ${DISPLAY_OPTIONS} | SARIMA(string) MAR1(string) MAR2(string) MAR3(string) MAR4(string) MMA1(string) MMA2(string) MMA3(string) MMA4(string) CONDition DIffuse P0(string) STATE0(string) Constraints(string) FROM(string) TECHnique(string) BHHH BFGS DFP NR DETail SAVEspace noHEAD TOLerance(real 0) LTOLerance(real 0) NRTOLerance(real 0) GTOLerance(real 0) SCore(string) COLlinear DIFficult]`,
      text,
    ),
    options = parsed.options;
  if (!parsed.anything.trim()) throw new StataError("varlist required", 100);
  let ar = lagList(options.ar, "ar"),
    ma = lagList(options.ma, "ma"),
    d = 0;
  if (options.arima !== undefined) {
    if (options.ar || options.ma)
      throw new StataError("ar() and ma() not allowed with arima()", 198);
    const values = parseNumlist(options.arima.replace(/,/g, " "));
    if (values.length !== 3 || values.some((v) => !(v >= 0) || v % 1))
      throw new StataError(
        "arima() invalid -- invalid numlist has " +
          (values.length < 3
            ? "too few elements"
            : values.length > 3
              ? "too many elements"
              : "elements outside of allowed range"),
        values.length < 3 ? 122 : values.length > 3 ? 123 : 125,
      );
    [, d] = values;
    ar = Array.from({ length: values[0] }, (_, j) => j + 1);
    ma = Array.from({ length: values[2] }, (_, j) => j + 1);
  }
  // A string variable, as in Stata, leaves no observations.
  let terms = tsTerms(session, parsed.anything, { strings: true });
  // marksample drops the observations with a missing value before _ts
  // counts the panels, so one panel left that way is enough.
  const frame = timeFrame(
    session,
    "arima",
    parsed,
    undefined,
    terms.map((t) => t.variable),
    true,
  );
  if (d) terms = terms.map((t) => tsTerm(t.variable, [["D", d], ...t.ops]));
  const vceText = (options.vce ?? "").trim(),
    vce = vceText.toLowerCase(),
    clusterMatch = /^cl(u(s(t(er?)?)?)?)?\s+(\S+)$/i.exec(vceText),
    asked = [
      options.robust && "robust",
      options.opg && "opg",
      options.hessian && "oim",
      vce &&
        (/^r(o(b(u(st?)?)?)?)?$/.test(vce)
          ? "robust"
          : /^opg$/.test(vce)
            ? "opg"
            : /^oim$/.test(vce)
              ? "oim"
              : clusterMatch
                ? "cluster"
                : null),
    ].filter((v) => v !== false && v !== "" && v !== undefined);
  if (asked.includes(null))
    throw new StataError(
      `vcetype ${vce.split(/\s+/)[0]} not allowed`,
      198,
      "arima takes vce(opg), the default, vce(oim), vce(robust) and vce(cluster clustvar).",
    );
  if (new Set(asked).size > 1)
    throw new StataError(`options ${asked.join(" ")} may not be combined`, 198);
  const cluster = clusterMatch ? session.varlist(clusterMatch[5])[0] : null;
  return {
    cluster,
    display: options,
    parsed,
    frame,
    depvar: terms[0],
    covariates: terms.slice(1),
    constant: options.constant !== false,
    arLags: ar,
    maLags: ma,
    vce: asked[0] === "cluster" ? "robust" : (asked[0] ?? "opg"),
    level: options.level,
    log: options.log !== false,
    iterate: options.iterate,
  };
}

/** The values of each term over the rows of the data. */
const columnsOf = (session, frame, terms) =>
  terms.map((t) => operate(frame, t.ops, session.data.get(t.variable).data));

// ----- maximization -----

const mreldif = (a, b) =>
  Math.max(...a.map((v, j) => Math.abs(v - b[j]) / (Math.abs(b[j]) + 1)));
const reldif = (a, b) => Math.abs(a - b) / (Math.abs(b) + 1);

/**
 * The fit: technique(bhhh 5 bfgs 10) from the starting values, with
 * Stata's convergence rule (a small enough change in the coefficients or
 * the log likelihood, and a scaled gradient under 1e-5). evaluate(theta)
 * returns { ll, lls } or null; scores(theta) the observations' scores.
 */
function maximize(evaluate, scores, start, iterate, notes) {
  let theta = start.slice(),
    current = evaluate(theta);
  if (!current)
    throw new StataError(
      "initial values not feasible",
      1400,
      "The starting values give a nonstationary or degenerate model.",
    );
  const log = [current.ll],
    // Iterations whose step was halved, which Stata marks (backed up).
    backed = [];
  let S = scores(theta),
    gradient = colSums(S),
    technique = "bhhh",
    H = opg(S),
    converged = false,
    iteration = 0;
  const techniqueAt = (it) => (it % 15 < 5 ? "bhhh" : "bfgs");
  while (iteration < iterate) {
    // Direction: H^-1 g, with H the negative of the Hessian's estimate.
    let inverse = invertSymmetric(H);
    if (!inverse) {
      const ridge = H.map((r, i) =>
        r.map((v, j) => (i === j ? v * 1.0001 + 1e-8 : v)),
      );
      inverse = invertSymmetric(ridge) ?? invsym(H).inverse;
    }
    const direction = inverse.map((r) =>
      r.reduce((t, v, j) => t + v * gradient[j], 0),
    );
    let step = 1,
      next = null,
      candidate;
    for (let halving = 0; halving < 50; halving++) {
      candidate = theta.map((v, j) => v + step * direction[j]);
      next = evaluate(candidate);
      if (next && next.ll >= current.ll) break;
      next = null;
      step /= 2;
    }
    if (!next) {
      // No step gains: at a maximum the data cannot sharpen (two
      // observations, a parameter they do not identify), Stata backs up
      // until its convergence rule holds, which the gradient settles.
      // A gradient of roundoff counts as zero, whatever the scaling of a
      // direction the data leave flat.
      const flat = invsym(H).inverse,
        gtol = Math.max(...gradient.map((v, j) => Math.abs(v * theta[j])));
      converged =
        (quadratic(gradient, flat) < 1e-5 ||
          gradient.every((v) => Math.abs(v) < 1e-6)) &&
        gtol <= 0.05;
      break;
    }
    // A full step that gains is followed by steps forward, an eighth of
    // the step and then twice as much each time, while they gain, as
    // Stata's optimizer steps.
    if (step === 1)
      for (let size = 1 / 8; ; size *= 2) {
        const further = candidate.map((v, j) => v + size * direction[j]),
          tried = evaluate(further);
        if (!tried || !(tried.ll > next.ll)) break;
        candidate = further;
        next = tried;
      }
    iteration++;
    if (step < 1) backed[iteration] = true;
    const nextS = scores(candidate),
      nextGradient = colSums(nextS),
      nextTechnique = techniqueAt(iteration);
    if (nextTechnique !== technique) notes[iteration] = nextTechnique;
    if (nextTechnique === "bhhh") H = opg(nextS);
    else {
      // BFGS update of -Hessian: B + yy'/y's - Bss'B/s'Bs, y the fall in
      // the gradient.
      const s = candidate.map((v, j) => v - theta[j]),
        yv = gradient.map((v, j) => v - nextGradient[j]),
        ys = dot(yv, s),
        Bs = H.map((r) => dot(r, s)),
        sBs = dot(s, Bs);
      if (ys > 0 && sBs > 0)
        H = H.map((r, i) =>
          r.map((v, j) => v + (yv[i] * yv[j]) / ys - (Bs[i] * Bs[j]) / sBs),
        );
    }
    technique = nextTechnique;
    const changeB = mreldif(candidate, theta),
      changeL = reldif(next.ll, current.ll);
    theta = candidate;
    current = next;
    S = nextS;
    gradient = nextGradient;
    log.push(current.ll);
    // A Hessian that is singular is inverted as invsym() inverts it.
    const hinv = invertSymmetric(H) ?? invsym(H).inverse,
      scaled = quadratic(gradient, hinv),
      // arima sets gtolerance(.05): every |gradient x coefficient| must be
      // under it as well.
      gtol = Math.max(...gradient.map((v, j) => Math.abs(v * theta[j])));
    if ((changeB <= 1e-6 || changeL <= 1e-7) && scaled < 1e-5 && gtol <= 0.05) {
      converged = true;
      break;
    }
  }
  return {
    theta,
    ll: current.ll,
    lls: current.lls,
    S,
    log,
    backed,
    converged,
    iterations: iteration,
  };
}
const dot = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0);
function colSums(S) {
  const k = S[0]?.length ?? 0,
    out = new Array(k).fill(0);
  for (const s of S) for (let j = 0; j < k; j++) out[j] += s[j];
  return out;
}
function opg(S) {
  const k = S[0]?.length ?? 0,
    out = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const s of S)
    for (let a = 0; a < k; a++) {
      const sa = s[a];
      for (let b = 0; b <= a; b++) out[a][b] += sa * s[b];
    }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) out[b][a] = out[a][b];
  return out;
}

// ----- the command -----

/**
 * A Wald test that the coefficients at indices are zero, as test does it
 * after arima: a coefficient with no variance is dropped from the test.
 * Returns the statistic and its degrees of freedom, null with nothing to
 * test.
 */
function waldTest(theta, V, indices) {
  if (!indices.length) return null;
  const { inverse, dropped } = invsym(
      indices.map((a) => indices.map((b) => V[a][b])),
    ),
    df = dropped.filter((d) => !d).length,
    b = indices.map((j) => theta[j]);
  if (!df) return { chi2: MISSING, df: 0 };
  let chi2 = 0;
  b.forEach((u, a) => inverse[a].forEach((w, c) => (chi2 += u * w * b[c])));
  return { chi2, df };
}

function arima(session, text, ctx) {
  // arima typed without a varlist shows the last results again.
  if (!splitAtComma(text)[0].trim()) {
    const model = session.estimates;
    if (model?.command !== "arima")
      throw new StataError("results of arima not found", 301);
    const parsed = session.parse(`[, Level(cilevel) ${DISPLAY_OPTIONS}]`, text);
    return model.replay(
      ctx,
      parsed.options.level,
      displayOptions(parsed.options, ctx),
    );
  }
  const spec = specification(session, text),
    { frame, parsed } = spec,
    shown = displayOptions(spec.display, ctx);
  spec.display = undefined;
  // The sample: observations where the time, every variable and the
  // cluster are present. A string variable leaves none, as in Stata.
  const given = [spec.depvar, ...spec.covariates],
    givenColumns = columnsOf(session, frame, given),
    clusterValues = spec.cluster ? session.data.get(spec.cluster).data : null,
    present = (v) => typeof v === "number" && !isMissing(v),
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !isMissing(frame.time[i]) &&
          givenColumns.every((c) => present(c[i])) &&
          (!clusterValues || !isMissing(clusterValues[i])),
      )
      .sort((a, b) => frame.time[a] - frame.time[b]);
  if (!rows.length) throw new StataError("no observations", 2000);
  // regress, which gives the starting values, needs two observations.
  if (rows.length < 2) throw new StataError("insufficient observations", 2001);
  // _rmcoll over the dependent variable and the regressors together, as
  // arima.ado calls it: whatever comes first of those it keeps is the
  // dependent variable.
  const dropped = collinearColumns(
    givenColumns.map((c) => rows.map((i) => c[i])),
    spec.constant,
  );
  given.forEach((t, j) => {
    if (dropped[j]) ctx.out(`note: ${t.name} omitted because of collinearity.`);
  });
  const kept = given.filter((_, j) => !dropped[j]),
    keptColumns = givenColumns.filter((_, j) => !dropped[j]);
  if (!kept.length) throw new StataError("varlist required", 100);
  spec.depvar = kept[0];
  spec.covariates = kept.slice(1);
  const depColumn = keptColumns[0],
    xColumns = keptColumns.slice(1),
    k1 = xColumns.length + (spec.constant ? 1 : 0);
  const nar = spec.arLags.length,
    nma = spec.maLags.length,
    r = Math.max(spec.arLags.at(-1) ?? 0, (spec.maLags.at(-1) ?? 0) + 1),
    k = k1 + nar + nma + 1;
  const tmin = frame.time[rows[0]],
    tmax = frame.time[rows.at(-1)],
    n = Math.round((tmax - tmin) / frame.delta) + 1,
    position = (i) => Math.round((frame.time[i] - tmin) / frame.delta),
    y = new Array(n).fill(null),
    X = new Array(n).fill(null),
    xRow = (i) => [...xColumns.map((c) => c[i]), ...(spec.constant ? [1] : [])];
  for (const i of rows) {
    y[position(i)] = depColumn[i];
    X[position(i)] = xRow(i);
  }
  const model = { r, k1, arLags: spec.arLags, maLags: spec.maLags },
    observed = rows.map(position),
    evaluate = (theta) => {
      const lls = new Float64Array(n),
        result = kalman(model, theta, y, X, { lls });
      if (!result) return null;
      const total = quadSum();
      for (const t of observed) {
        if (!Number.isFinite(lls[t])) return null;
        total.add(lls[t]);
      }
      return { ll: total.value, lls };
    },
    scores = (theta) => {
      const S = observed.map(() => new Array(k).fill(0));
      for (let j = 0; j < k; j++) {
        const h = 1e-5 * (Math.abs(theta[j]) + 1e-2),
          up = theta.slice(),
          down = theta.slice();
        up[j] += h;
        down[j] -= h;
        const a = evaluate(up),
          b = evaluate(down);
        if (!a || !b) {
          // At the edge of the stationary region, a one-sided difference.
          const base = evaluate(theta),
            side = a ?? b,
            sign = a ? 1 : -1;
          observed.forEach((t, m) => {
            S[m][j] = side ? (sign * (side.lls[t] - base.lls[t])) / h : 0;
          });
          continue;
        }
        observed.forEach((t, m) => (S[m][j] = (a.lls[t] - b.lls[t]) / (2 * h)));
      }
      return S;
    };

  // Starting values, as arima.ado computes them: regress for the
  // regression, which needs two observations.
  const dep = rows.map((i) => depColumn[i]),
    xs = Array.from({ length: k1 }, (_, j) => rows.map((i) => xRow(i)[j]));
  let start = [],
    u,
    sigma;
  if (k1) {
    const fit = regressFit(xs, dep, spec.constant ? k1 - 1 : -1);
    if (!fit) throw new StataError("insufficient observations", 2001);
    start = fit.b;
    u = fit.residuals;
    sigma = Math.sqrt(fit.rss / rows.length);
  } else {
    // The mean and variance of all of the dependent variable's values.
    const all = depColumn.filter((v) => present(v)),
      mean = all.reduce((a, b) => a + b, 0) / all.length;
    u = dep.slice();
    sigma = Math.sqrt(
      all.reduce((t, v) => t + (v - mean) ** 2, 0) / (all.length - 1),
    );
  }
  const arma = nar + nma ? armaStart(spec, rows, frame, u, ctx) : null;
  if (arma) {
    start.push(...arma.b);
    sigma = arma.sigma;
  } else start.push(...new Array(nar + nma).fill(0));
  start.push(sigma);

  const gaps = gapCount(frame, rows),
    notes = [],
    fit = maximize(evaluate, scores, start, spec.iterate, notes),
    theta = fit.theta,
    N = rows.length;
  // The variance, inverted as invsym() inverts it: a parameter the data
  // cannot tell apart from the others has no variance.
  const hessian = () => numericHessian((t) => evaluate(t)?.ll ?? NaN, theta),
    outer = opg(fit.S);
  let V,
    clusters = 0;
  if (spec.vce === "opg") V = invsym(outer).inverse;
  else {
    const Hinv = invsym(hessian().map((r) => r.map((v) => -v))).inverse;
    if (spec.vce === "oim") V = Hinv;
    else {
      // ml's sandwich, with the factor N/(N - 1), or M/(M - 1) over M
      // clusters, the scores summed within each.
      let middle = outer,
        factor = N / (N - 1);
      if (clusterValues) {
        const sums = new Map();
        rows.forEach((i, m) => {
          const key = clusterValues[i],
            sum = sums.get(key) ?? new Array(k).fill(0);
          fit.S[m].forEach((v, j) => (sum[j] += v));
          sums.set(key, sum);
        });
        clusters = sums.size;
        middle = opg([...sums.values()]);
        factor = clusters / (clusters - 1);
      }
      const left = Hinv.map((r) =>
        middle[0].map((_, j) =>
          dot(
            r,
            middle.map((m) => m[j]),
          ),
        ),
      );
      V = left.map((r) =>
        Hinv[0].map(
          (_, j) =>
            factor *
            dot(
              r,
              Hinv.map((h) => h[j]),
            ),
        ),
      );
    }
  }
  const rank = V.filter((r, j) => r[j] !== 0).length;

  // Output.
  const crit =
    spec.vce === "robust" ? "Log pseudolikelihood" : "Log likelihood";
  if (spec.log) {
    ctx.out("");
    if (gaps) {
      ctx.out(`Number of gaps in sample = ${gaps}`);
      ctx.out("(note: filtering over missing observations)");
      ctx.out("");
    }
    ctx.out("(setting optimization to BHHH)");
    fit.log.forEach((value, j) => {
      if (notes[j])
        ctx.out(`(switching optimization to ${notes[j].toUpperCase()})`);
      ctx.out(
        `${iterationLine(j, crit, value)}${fit.backed[j] ? "  (backed up)" : ""}`,
      );
    });
    if (!fit.converged) ctx.out("convergence not achieved");
  } else if (gaps) {
    ctx.out("");
    ctx.out(`Number of gaps in sample = ${gaps}`);
    ctx.out("(note: filtering over missing observations)");
  }
  const names = [
      ...spec.covariates.map((t) => t.name),
      ...(spec.constant ? ["_cons"] : []),
    ],
    depEquation = spec.depvar.variable,
    covariateIndices = spec.covariates.map((_, j) => j),
    // arima tests the regressors and the ARMA terms, the constant aside.
    test = waldTest(theta, V, [
      ...covariateIndices,
      ...Array.from({ length: nar + nma }, (_, j) => k1 + j),
    ]),
    df = test ? test.df : null,
    chi2 = test ? test.chi2 : MISSING,
    p = df && !isMissing(chi2) ? chi2tail(df, chi2) : MISSING,
    // e(p) is ml's test of the regressors alone.
    regressorTest = waldTest(theta, V, covariateIndices),
    mlP =
      regressorTest?.df && !isMissing(regressorTest.chi2)
        ? chi2tail(regressorTest.df, regressorTest.chi2)
        : MISSING,
    vcetype = { opg: "OPG", oim: "OIM", robust: "Semirobust" }[spec.vce],
    tLow = showTime(frame, tmin),
    tHigh = showTime(frame, tmax),
    sample = `Sample: ${tLow} thru ${tHigh}${gaps ? `, but with ${gaps === 1 ? "a gap" : "gaps"}` : ""}`,
    stripe = [
      ...names.map((name) => ({ equation: depEquation, name })),
      ...spec.arLags.map((lag) => ({
        equation: "ARMA",
        name: `L${lag === 1 ? "" : lag}.ar`,
      })),
      ...spec.maLags.map((lag) => ({
        equation: "ARMA",
        name: `L${lag === 1 ? "" : lag}.ma`,
      })),
      { equation: "sigma", name: "_cons" },
    ];
  // The header and table, which arima typed alone shows again.
  const show = (ctx, level, opts = shown) => {
    ctx.out("");
    ctx.out("ARIMA regression");
    ctx.out("");
    const obsLine = `Number of obs     = ${applyFormat(N, "%10.0g")}`;
    if (sample.length < 47) ctx.out(`${sample.padEnd(48)}${obsLine}`);
    else {
      ctx.out(sample);
      ctx.out(`${" ".repeat(48)}${obsLine}`);
    }
    ctx.out(
      `${" ".repeat(48)}${`Wald chi2(${df ?? "."})`.padEnd(18)}=  ${applyFormat(chi2, "%9.2f")}`,
    );
    ctx.out(
      `${`${crit} = ${g(fit.ll)}`.padEnd(48)}${"Prob > chi2".padEnd(18)}=     ${applyFormat(p, "%6.4f")}`,
    );
    if (!opts.coef) return;
    ctx.out("");
    const columns = columnsShown(opts),
      right = columns === "noci" ? 39 : 64,
      se = (j) => Math.sqrt(V[j][j]),
      legend = (j) => `_b[${stripe[j].equation}:${stripe[j].name}]`,
      cell = (j) =>
        displayCells(theta[j], se(j), level, opts, { legend: legend(j) }),
      armaItems = [
        ...(nar
          ? [
              {
                header: "ar",
                rows: spec.arLags.map((lag, j) => ({
                  label: `L${lag}.`,
                  k: k1 + j,
                })),
              },
            ]
          : []),
        ...(nma
          ? [
              {
                header: "ma",
                rows: spec.maLags.map((lag, j) => ({
                  label: `L${lag}.`,
                  k: k1 + nar + j,
                })),
              },
            ]
          : []),
      ],
      equations = [
        ...(k1
          ? [
              {
                name: depEquation,
                items: termItems(
                  [
                    ...spec.covariates,
                    ...(spec.constant ? [tsTerm("_cons", [])] : []),
                  ],
                  Array.from({ length: k1 }, (_, j) => j),
                ),
              },
            ]
          : []),
        ...(nar + nma ? [{ name: "ARMA", items: armaItems }] : []),
      ];
    // An operated dependent variable counts by its name alone: what does
    // not fit goes on the line above.
    const w = stubWidth(
      session,
      equations,
      [spec.depvar.variable, "/sigma"],
      right,
    );
    if (clusterValues)
      ctx.out(
        `(Std. err. adjusted for ${applyFormat(clusters, "%11.0fc").trim()} clusters in ${spec.cluster})`.padStart(
          w + 2 + right,
        ),
      );
    tableHeading(spec.depvar.name, level, {
      vcetype: opts.legend ? null : vcetype,
      w,
      columns,
    }).forEach((l) => ctx.out(l));
    equationLines(equations, cell, w, right).forEach((l) => ctx.out(l));
    if (equations.length) ctx.out(`${"-".repeat(w + 1)}+${"-".repeat(right)}`);
    // sigma is tested one-sided, its interval truncated at zero.
    ctx.out(
      `${"/sigma".padStart(w)} |${displayCells(theta[k - 1], se(k - 1), level, opts, { legend: legend(k - 1), oneSided: true })}`,
    );
    ctx.out("-".repeat(w + 2 + right));
    if (!fit.converged) ctx.out("Warning: Convergence not achieved.");
    ctx.out(
      "Note: The test of the variance against zero is one sided, and the two-sided",
    );
    ctx.out("      confidence interval is truncated at zero.");
  };
  show(ctx, spec.level);

  // Results.
  const estimates = {
    command: "arima",
    kind: "arima",
    title: "ARIMA regression",
    dist: "z",
    depvar: spec.depvar.name,
    names: stripe.map((e) => `${e.equation}:${e.name}`),
    b: theta.slice(),
    V,
    columns: [],
    estimable: theta.map(() => true),
    N,
    rank,
    df_m: df ?? MISSING,
    ll: fit.ll,
    vce: spec.vce,
    vcetype,
    sample: rows,
    // test, lincom and estimates read the coefficients from here.
    stripe,
    // estat summarize shows the dependent variable and the regressors
    // by equation.
    summary: {
      equation: depEquation,
      depvar: {
        name: spec.depvar.name,
        variable: spec.depvar.variable,
        operated: spec.depvar.ops.length ? spec.depvar.label : null,
        column: depColumn,
      },
      columns: spec.covariates.map((t, j) => ({
        name: t.name,
        variable: t.variable,
        operated: t.ops.length ? t.label : null,
        column: xColumns[j],
      })),
    },
    arima: {
      spec: { ...spec, parsed: undefined },
      model,
      theta: theta.slice(),
      tmin,
      k1,
    },
    ownPredict: arimaPredict,
    replay: show,
  };
  session.estimates = estimates;
  // e(eqnames) as ml names its equations: the regression after the
  // dependent variable (eq1 when it is operated), then one name per term.
  const xbEquation = spec.depvar.ops.length ? "eq1" : spec.depvar.variable;
  session.results.e = {
    rc: 0,
    ll: fit.ll,
    converged: fit.converged ? 1 : 0,
    rank,
    k,
    k_dv: 1,
    ic: fit.iterations,
    N,
    k_eq_model: 1,
    sigma: theta[k - 1],
    p: mlP,
    df_m: df ?? MISSING,
    chi2,
    k1,
    tmin,
    tmax,
    k_eq: (k1 ? 1 : 0) + (nar + nma ? 1 : 0) + 1,
    N_gaps: gaps,
    ar_max: spec.arLags.at(-1) ?? 0,
    ma_max: spec.maLags.at(-1) ?? 0,
    ...(clusterValues ? { N_clust: clusters } : {}),
    cmd: "arima",
    cmdline: `arima ${text.trim()}`,
    predict: "arima_p",
    estat_cmd: "arima_estat",
    // arima.ado keeps the blank that gettoken leaves before the list.
    covariates: spec.covariates.length
      ? ` ${spec.covariates.map((t) => t.name).join(" ")}`
      : "_NONE",
    marginsnotok: "stdp mse Residuals YResiduals",
    marginsok: "xb y default",
    ...(nma ? { ma: spec.maLags.join(" ") } : {}),
    ...(nar ? { ar: spec.arLags.join(" ") } : {}),
    eqnames: [
      ...names.map(() => xbEquation),
      ...spec.arLags.map(() => "AR1_terms"),
      ...spec.maLags.map(() => "MA1_terms"),
      "SIGMA",
    ].join(" "),
    seasons: "1",
    tmaxs: tHigh,
    tmins: tLow,
    chi2type: "Wald",
    ...(clusterValues ? { clustvar: spec.cluster } : {}),
    vcetype,
    vce: clusterValues ? "cluster" : spec.vce,
    opt: "ml",
    title: "ARIMA regression",
    depvar: spec.depvar.name,
    ml_method: "rdu0",
    user: "arima_dr",
    technique: "bhhh bfgs",
    tech_steps: "5 10",
    properties: "b V",
    // The gradient at the estimates and the log likelihood of the first
    // twenty iterations, as ml leaves them.
    "matrix:gradient": {
      rowNames: ["r1"],
      colNames: stripe.map((e) => `${e.equation}:${e.name}`),
      values: [colSums(fit.S)],
    },
    "matrix:ilog": {
      rowNames: ["r1"],
      colNames: Array.from({ length: 20 }, (_, j) => `c${j + 1}`),
      values: [Array.from({ length: 20 }, (_, j) => fit.log[j] ?? MISSING)],
    },
  };
}

/**
 * arima.ado's starting values for the ARMA terms (its Monfort program):
 * the residuals of a long autoregression of u stand in for the
 * disturbances, then u is regressed on its own lags and on their lags.
 * The long autoregression is shortened until regress can fit it, with
 * Stata's note the first time it cannot; if it never can, arima stops.
 * Returns null when the second regression cannot be fitted, and Stata
 * starts the ARMA terms from zeros.
 */
function armaStart(spec, rows, frame, u, ctx) {
  const at = new Map(rows.map((i, m) => [frame.time[i], m])),
    lagOf = (values, m, k) => {
      const j = at.get(frame.time[rows[m]] - k * frame.delta);
      return j === undefined ? null : values[j];
    },
    all = [...spec.arLags, ...spec.maLags],
    minlag = Math.min(...all),
    // arima.ado's MaxLagS counts its arguments rather than reading them:
    // 1 for a single lag in ar() and ma() together, 3 for more.
    maxlag = all.length > 1 ? 3 : 1;
  let usemin = minlag,
    usemax = 0,
    done = false;
  for (let kk = 30; !done && kk > 0; kk -= 5) {
    usemin = kk > 10 ? Math.min(minlag, 1) : minlag;
    usemax = Math.max(maxlag, usemin + kk);
    let available = 0;
    for (let m = 0; m < rows.length; m++) {
      let ok = true;
      for (let l = usemin; l <= usemax && ok; l++) ok = lagOf(u, m, l) !== null;
      if (ok) available++;
    }
    if (available > 2 * kk) done = true;
  }
  // The long autoregression, shortened until regress can fit it.
  let e = null,
    noted = false,
    last = 0;
  for (; usemax > usemin && !e; usemax--) {
    const use = [];
    for (let m = 0; m < rows.length; m++) {
      let ok = true;
      for (let l = usemin; l <= usemax && ok; l++) ok = lagOf(u, m, l) !== null;
      if (ok) use.push(m);
    }
    last = use.length;
    const columns = [];
    for (let l = usemin; l <= usemax; l++)
      columns.push(use.map((m) => lagOf(u, m, l)));
    columns.push(use.map(() => 1));
    const fit = regressFit(
      columns,
      use.map((m) => u[m]),
      columns.length - 1,
    );
    if (fit) {
      e = new Array(rows.length).fill(null);
      use.forEach((m, j) => (e[m] = fit.residuals[j]));
      break;
    }
    if (!noted) {
      ctx.out("(note:  insufficient memory or observations to estimate usual");
      ctx.out("starting values [2])");
      noted = true;
    }
  }
  // Monfort says insufficient observations either way, and exits with
  // regress's return code.
  if (!e) throw new StataError("insufficient observations", last ? 2001 : 2000);
  const use = [];
  for (let m = 0; m < rows.length; m++)
    if (
      spec.arLags.every((l) => lagOf(u, m, l) !== null) &&
      spec.maLags.every((l) => {
        const v = lagOf(e, m, l);
        return v !== null && v !== undefined;
      })
    )
      use.push(m);
  const columns = [
      ...spec.arLags.map((l) => use.map((m) => lagOf(u, m, l))),
      ...spec.maLags.map((l) => use.map((m) => lagOf(e, m, l))),
    ],
    fit = regressFit(
      columns,
      use.map((m) => u[m]),
    );
  if (!fit) return null;
  const b = fit.b.slice(),
    nar = spec.arLags.length,
    sum = b.slice(0, nar).reduce((t, v) => t + v, 0);
  // FixARMA: an autoregression that sums to more than .95 in size is scaled
  // back, and so is each moving-average term.
  if (Math.abs(sum) > 0.95)
    for (let j = 0; j < nar; j++) b[j] *= 0.95 / Math.abs(sum);
  for (let j = nar; j < b.length; j++)
    if (Math.abs(b[j]) > 0.95) b[j] = (0.95 * b[j]) / Math.abs(b[j]);
  return { b, sigma: Math.sqrt(fit.rss / use.length) };
}

/** The Hessian of f at x by central second differences. */
function numericHessian(f, x) {
  const k = x.length,
    h = x.map((v) => 1e-4 * (Math.abs(v) + 1e-2)),
    at = (deltas) => f(x.map((v, j) => v + (deltas[j] ?? 0))),
    f0 = f(x),
    H = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) {
    const e = (s) => {
      const d = [];
      d[a] = s * h[a];
      return d;
    };
    H[a][a] = (at(e(1)) - 2 * f0 + at(e(-1))) / (h[a] * h[a]);
    for (let b = 0; b < a; b++) {
      const d = (sa, sb) => {
        const out = [];
        out[a] = sa * h[a];
        out[b] = sb * h[b];
        return out;
      };
      H[a][b] = H[b][a] =
        (at(d(1, 1)) - at(d(1, -1)) - at(d(-1, 1)) + at(d(-1, -1))) /
        (4 * h[a] * h[b]);
    }
  }
  return H;
}

// ----- predict -----

/**
 * predict after arima: xb (the one-step prediction of the differenced
 * series), y (of the series in levels), mse, residuals, yresiduals, stdp,
 * and dynamic() predictions. The filter runs over every observation, from
 * the first, as arima_p.ado runs it.
 */
function arimaPredict(session, text, ctx) {
  const model = session.estimates,
    { spec, model: kspec, theta, k1 } = model.arima,
    parsed = session.parse(
      "newvarname [if] [in] [, XB Y MSE Residuals YResiduals STDP Dynamic(string) | Structural T0(string) EQuation(string)]",
      text,
    ),
    options = parsed.options,
    chosen = ["xb", "y", "mse", "residuals", "yresiduals", "stdp"].filter(
      (o) => options[o],
    );
  if (chosen.length > 1) throw new StataError("invalid syntax", 198);
  const type = chosen[0] ?? "xb";
  if (type === "stdp" && !k1)
    throw new StataError(
      "cannot predict standard error of prediction without regressors or a constant term in mean equation",
      498,
    );
  // arima_p.ado leaves the data sorted by time, as arima does.
  const frame = timeFrame(session, "predict", null, undefined, [], true),
    data = session.data,
    depColumn = operate(
      frame,
      spec.depvar.ops,
      data.get(spec.depvar.variable).data,
    ),
    xColumns = spec.covariates.map((t) =>
      operate(frame, t.ops, data.get(t.variable).data),
    ),
    xRow = (i) =>
      xColumns.some((c) => isMissing(c[i]))
        ? null
        : [...xColumns.map((c) => c[i]), ...(spec.constant ? [1] : [])];
  if (
    options.dynamic !== undefined &&
    spec.covariates.some((t) => t.variable === spec.depvar.variable)
  )
    throw new StataError(
      "dynamic() is not available here when the regressors include lags of the dependent variable",
      198,
    );
  const rows = session
    .rows(parsed, null)
    .filter((i) => !isMissing(frame.time[i]))
    .sort((a, b) => frame.time[a] - frame.time[b]);
  const out = new Array(data.n).fill(MISSING);
  let dynamicTime = null;
  if (options.dynamic !== undefined) {
    const value = session.compile(options.dynamic);
    if (value.type !== "numeric") throw new StataError("type mismatch", 109);
    dynamicTime = value.evaluate(0, { start: 0, count: data.n, sums: [] });
    if (isMissing(dynamicTime)) {
      dynamicTime =
        model.arima.tmin +
        frame.delta * ((spec.arLags.at(-1) ?? 0) + (spec.maLags.at(-1) ?? 0));
      // arima_p says where it chose to begin.
      ctx.out(
        `Note: beginning dynamic predictions in period ${showTime(frame, dynamicTime)}.`,
      );
    }
  }
  if (rows.length) {
    const t0 = frame.time[rows[0]],
      n = Math.round((frame.time[rows.at(-1)] - t0) / frame.delta) + 1,
      y = new Array(n).fill(null),
      X = new Array(n).fill(null),
      position = (i) => Math.round((frame.time[i] - t0) / frame.delta);
    for (const i of rows) {
      X[position(i)] = xRow(i);
      y[position(i)] = isMissing(depColumn[i]) ? null : depColumn[i];
    }
    const dynamicFrom =
        dynamicTime === null
          ? Infinity
          : Math.max(0, Math.ceil((dynamicTime - t0) / frame.delta - 1e-9)),
      result = kalman(kspec, theta, y, X, { dynamicFrom });
    if (!result)
      throw new StataError("the estimates give a nonstationary model", 498);
    // y and yresiduals: the prediction in levels, undoing the differences
    // with the observed past, or under dynamic() with the predicted past.
    const levels = new Array(n).fill(null),
      ops = spec.depvar.ops,
      d =
        ops.length === 1 && ops[0][0] === "D"
          ? ops[0][1]
          : ops.length
            ? null
            : 0;
    if ((type === "y" || type === "yresiduals") && d === null)
      throw new StataError(
        `option ${type} is not available here for a dependent variable under ${spec.depvar.name.split(".")[0]}.`,
        198,
      );
    const levelAt = new Array(n).fill(null),
      source = data.get(spec.depvar.variable).data;
    for (const i of data.n ? Array.from({ length: data.n }, (_, i) => i) : [])
      if (!isMissing(frame.time[i])) {
        const p = Math.round((frame.time[i] - t0) / frame.delta);
        if (p >= 0 && p < n && !isMissing(source[i])) levelAt[p] = source[i];
      }
    const before = (p) => {
      if (p >= 0) return levelAt[p];
      const j = frame.at.get(t0 + p * frame.delta);
      return j === undefined || isMissing(source[j]) ? null : source[j];
    };
    for (let p = 0; p < n; p++) {
      const xb = result.pred[p];
      if (!Number.isFinite(xb) || d === null) continue;
      let level = xb,
        ok = true;
      for (let j = 1; j <= d && ok; j++) {
        const c = binomial(d, j) * (j % 2 ? 1 : -1),
          lagged =
            p - j >= dynamicFrom && levels[p - j] !== null
              ? levels[p - j]
              : before(p - j);
        if (lagged === null) ok = false;
        else level += c * lagged;
      }
      levels[p] = ok ? level : null;
    }
    const V = model.V;
    for (const i of rows) {
      const p = position(i),
        xb = result.pred[p];
      let value = MISSING;
      if (type === "xb") value = Number.isFinite(xb) ? xb : MISSING;
      // The MSE does not depend on the regressors: a period whose
      // regressor is missing has one all the same.
      else if (type === "mse") value = result.mse[p];
      else if (type === "residuals")
        value = Number.isFinite(xb) && y[p] !== null ? y[p] - xb : MISSING;
      else if (type === "y") value = levels[p] ?? MISSING;
      else if (type === "yresiduals")
        value =
          levels[p] !== null && !isMissing(source[i])
            ? source[i] - levels[p]
            : MISSING;
      else if (type === "stdp" && X[p]) {
        const x = X[p];
        let q = 0;
        for (let a = 0; a < k1; a++)
          for (let b = 0; b < k1; b++) q += x[a] * V[a][b] * x[b];
        value = Math.sqrt(q);
      }
      out[i] = value;
    }
  }
  if (!chosen.length) ctx.out("(option xb assumed; predicted values)");
  const order = [...data.sortedBy];
  data.generate(parsed.varlist[0], out, {
    type: parsed.typed?.[0] ? parsed.types[0] : undefined,
  });
  data.sortedBy = order;
  const postlab =
    options.dynamic !== undefined
      ? `dyn(${options.dynamic.trim()})`
      : "one-step";
  data.get(parsed.varlist[0]).label =
    type === "stdp"
      ? "S.E. of the prediction"
      : `${
          {
            xb: "xb prediction",
            y: "y prediction",
            mse: "MSE of xb",
            residuals: "residual",
            yresiduals: "y residual",
          }[type]
        }, ${postlab}`;
  const missing = out.filter((v) => isMissing(v)).length;
  if (missing)
    ctx.out(
      `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
    );
}
function binomial(n, k) {
  let c = 1;
  for (let j = 1; j <= k; j++) c = (c * (n - k + j)) / j;
  return c;
}

export const ARIMA_COMMANDS = [{ name: "arima", minimum: 5, run: arima }];
