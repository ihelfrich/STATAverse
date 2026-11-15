// Linear mixed-effects models: mixed (and xtmixed, its old name), with
// predict (xb, fitted, residuals, reffects, reses, stdp) and estat icc, sd,
// recovariance, group, ic, vce and summarize after it; margins reaches the
// fixed portion of the prediction; melogit and mepoisson are refused.
//
// The model is y = Xb + Z1 u1 + ... + ZL uL + e, the levels nested from the
// outermost (level 1) in. Each level's effects u have a covariance G of one
// of Stata's structures (independent, exchangeable, identity,
// unstructured), and e has variance s^2. The likelihood is evaluated as in
// Bates and others' penalized least squares: with G = s^2 L L', the
// cross-products of [Z L, X, y] within the innermost groups are reduced
// level by level, each group's own effects eliminated by a small Cholesky
// step, so that the work grows with the number of groups and not with the
// square of the number of observations. Maximum likelihood (the default, as
// in Stata) or restricted maximum likelihood (reml) is maximized as Stata
// maximizes it: EM steps from Stata's start, then Newton's method in the
// variance parameters (in Stata's matsqrt metric, the fixed effects and the
// residual variance profiled out) until Stata's convergence rule is met.
//
// Standard errors follow Stata: the fixed effects' variance is
// (X'V^-1 X)^-1, and the variance parameters' is the inverse of minus the
// Hessian of the log likelihood with the fixed effects profiled out, in
// Stata's own metric (log standard deviations, atanh of correlations and
// the log residual standard deviation), so e(V) is block diagonal as
// Stata's is. The random-effects table transforms those by the delta
// method.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { chi2tail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import {
  abbreviate,
  baseLevelsAsked,
  coefficientSpace,
  stripeName,
  tableWidth,
} from "./estimation.js";
import {
  frame,
  iterationLine,
  layoutRows,
  row,
  rule,
  split,
  tableHead,
  tableModel,
} from "./likelihood.js";
import { MODEL_COMMANDS } from "./models.js";
import { count, perGroup } from "./reports.js";
import { renderSmcl } from "./smcl.js";
import { optionItems, splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType, missingValue } from "./values.js";

const g = (value, format = "%9.0g") =>
  applyFormat(Number.isFinite(value) ? value : MISSING, format).trim();
const refuse = (message, hint = "") => new StataError(message, 198, hint);

// ---------------------------------------------------------------------------
// Small dense linear algebra on flat row-major arrays.

/** The lower Cholesky factor of the n x n matrix a, or null if a is not
 * positive definite. */
function cholesky(a, n) {
  const l = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let s = a[j * n + j];
    for (let k = 0; k < j; k++) s -= l[j * n + k] ** 2;
    if (!(s > 0)) return null;
    const d = Math.sqrt(s);
    l[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = a[i * n + j];
      for (let k = 0; k < j; k++) t -= l[i * n + k] * l[j * n + k];
      l[i * n + j] = t / d;
    }
  }
  return l;
}
/** The inverse of a symmetric positive definite n x n matrix, or null. */
function inverse(a, n) {
  const l = cholesky(a, n);
  if (!l) return null;
  // Invert L, then form L^-T L^-1.
  const li = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    li[j * n + j] = 1 / l[j * n + j];
    for (let i = j + 1; i < n; i++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= l[i * n + k] * li[k * n + j];
      li[i * n + j] = s / l[i * n + i];
    }
  }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += li[k * n + i] * li[k * n + j];
      out[i * n + j] = out[j * n + i] = s;
    }
  return out;
}
/** Solves a x = b for symmetric positive definite a (n x n), b n x m. */
function solve(a, n, b, m) {
  const l = cholesky(a, n);
  if (!l) return null;
  const x = Float64Array.from(b);
  for (let c = 0; c < m; c++) {
    for (let i = 0; i < n; i++) {
      let s = x[i * m + c];
      for (let k = 0; k < i; k++) s -= l[i * n + k] * x[k * m + c];
      x[i * m + c] = s / l[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i * m + c];
      for (let k = i + 1; k < n; k++) s -= l[k * n + i] * x[k * m + c];
      x[i * m + c] = s / l[i * n + i];
    }
  }
  return x;
}
/**
 * The eigenvalues and eigenvectors (columns of a flat n x n array) of the
 * symmetric n x n matrix a, by Jacobi rotations.
 */
function symmetricEigen(a, n) {
  const m = Float64Array.from(a),
    v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0,
      total = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        total += m[i * n + j] ** 2;
        if (i !== j) off += m[i * n + j] ** 2;
      }
    if (!(off > 1e-30 * total)) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = m[p * n + q];
        if (apq === 0) continue;
        const theta = (m[q * n + q] - m[p * n + p]) / (2 * apq),
          t =
            Math.sign(theta || 1) /
            (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k * n + p],
            mkq = m[k * n + q];
          m[k * n + p] = c * mkp - s * mkq;
          m[k * n + q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p * n + k],
            mqk = m[q * n + k];
          m[p * n + k] = c * mpk - s * mqk;
          m[q * n + k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p],
            vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  return {
    values: Array.from({ length: n }, (_, i) => m[i * n + i]),
    vectors: v,
  };
}
const toRows = (a, n) =>
  Array.from({ length: n }, (_, i) => Array.from(a.subarray(i * n, i * n + n)));

// ---------------------------------------------------------------------------
// Covariance structures.

const STRUCTURES = {
  independent: "Independent",
  exchangeable: "Exchangeable",
  identity: "Identity",
  unstructured: "Unstructured",
};
/** How many parameters a level's covariance has. */
function parameterCount(type, q) {
  if (type === "identity") return 1;
  if (type === "independent") return q;
  if (type === "exchangeable") return 2;
  return q + (q * (q - 1)) / 2;
}
/**
 * A level's covariance from its parameters p (log standard deviations,
 * then atanh correlations), flat q x q; shift is added to each log
 * standard deviation (minus the log residual standard deviation gives the
 * covariance relative to the residual variance).
 */
function covarianceOf(type, q, p, shift = 0) {
  const G = new Float64Array(q * q);
  if (type === "identity") {
    const v = Math.exp(2 * (p[0] + shift));
    for (let j = 0; j < q; j++) G[j * q + j] = v;
  } else if (type === "independent") {
    for (let j = 0; j < q; j++) G[j * q + j] = Math.exp(2 * (p[j] + shift));
  } else if (type === "exchangeable") {
    const v = Math.exp(2 * (p[0] + shift)),
      r = Math.tanh(p[1]);
    for (let i = 0; i < q; i++)
      for (let j = 0; j < q; j++) G[i * q + j] = i === j ? v : r * v;
  } else {
    const s = Array.from({ length: q }, (_, j) => Math.exp(p[j] + shift));
    let k = q;
    for (let i = 0; i < q; i++) {
      G[i * q + i] = s[i] * s[i];
      for (let j = i + 1; j < q; j++) {
        const c = Math.tanh(p[k++]) * s[i] * s[j];
        G[i * q + j] = G[j * q + i] = c;
      }
    }
  }
  return G;
}

// ---------------------------------------------------------------------------
// The likelihood.

/**
 * Reduces the cross-products of the groups, given each level's relative
 * factor (lambdas[l], q_l x q_l lower triangular, G_l = s^2 L L'). Returns
 * the log determinant of the penalized system, that of X'V^-1 X times
 * s^2, and the penalized residual sum of squares; with keep, also the
 * pieces predict needs, stored on the nodes, and the fixed effects.
 */
function reduceAll(problem, lambdas, keep = false) {
  const { levels, p, dims } = problem,
    L = levels.length,
    // One working matrix per level, reused group after group: a group's
    // children are reduced into its level's matrix before it is.
    scratch = (problem.scratch ??= dims.map((d) => new Float64Array(d * d)));
  let logdet = 0;
  const row = new Float64Array(Math.max(1, ...levels.map((l) => l.q)));
  const reduceNode = (node, l, target) => {
    const d = dims[l],
      q = levels[l].q,
      M = scratch[l];
    if (l === L - 1) {
      // M = T' A T, T block diagonal in the relative factors.
      M.set(node.cross);
      let offset = 0;
      for (let m = L - 1; m >= 0; m--) {
        const qm = levels[m].q,
          lam = lambdas[m];
        // Columns: B[:, o+j] = sum_k A[:, o+k] lam[k][j] (the factor
        // lower triangular or, for an unstructured level, symmetric).
        for (let r = 0; r < d; r++) {
          const base = r * d + offset;
          for (let j = 0; j < qm; j++) {
            let s = 0;
            for (let k = 0; k < qm; k++) s += M[base + k] * lam[k * qm + j];
            row[j] = s;
          }
          for (let j = 0; j < qm; j++) M[base + j] = row[j];
        }
        // Rows likewise.
        for (let c = 0; c < d; c++) {
          for (let j = 0; j < qm; j++) {
            let s = 0;
            for (let k = 0; k < qm; k++)
              s += lam[k * qm + j] * M[(offset + k) * d + c];
            row[j] = s;
          }
          for (let j = 0; j < qm; j++) M[(offset + j) * d + c] = row[j];
        }
        offset += qm;
      }
    } else {
      M.fill(0);
      for (const child of node.children) reduceNode(child, l + 1, M);
    }
    for (let j = 0; j < q; j++) M[j * d + j] += 1;
    const rest = d - q;
    if (keep) {
      const Paa = new Float64Array(q * q),
        Par = new Float64Array(q * rest);
      for (let i = 0; i < q; i++) {
        for (let j = 0; j < q; j++) Paa[i * q + j] = M[i * d + j];
        for (let j = 0; j < rest; j++) Par[i * rest + j] = M[i * d + q + j];
      }
      node.inverse = inverse(Paa, q);
      node.F = solve(Paa, q, Par, rest);
      node.rest = rest;
    }
    // Gaussian elimination of the first q pivots, on the lower triangle.
    for (let k = 0; k < q; k++) {
      const pivot = M[k * d + k];
      if (!(pivot > 0)) throw new Failure();
      logdet += Math.log(pivot);
      for (let i = k + 1; i < d; i++) {
        const f = M[i * d + k] / pivot;
        if (f === 0) continue;
        for (let j = k + 1; j <= i; j++) M[i * d + j] -= f * M[j * d + k];
      }
    }
    // What is left is added to the level above.
    for (let i = 0; i < rest; i++)
      for (let j = 0; j <= i; j++) {
        const v = M[(q + i) * d + q + j];
        target[i * rest + j] += v;
        if (i !== j) target[j * rest + i] += v;
      }
  };
  const top = new Float64Array((p + 1) * (p + 1));
  if (L) for (const node of problem.tree) reduceNode(node, 0, top);
  else top.set(problem.cross);
  const d = p + 1;
  let logdetX = 0;
  const T = Float64Array.from(top);
  for (let k = 0; k < p; k++) {
    const pivot = T[k * d + k];
    if (!(pivot > 0)) throw new Failure();
    logdetX += Math.log(pivot);
    for (let i = k + 1; i < d; i++) {
      const f = T[i * d + k] / pivot;
      for (let j = k + 1; j <= i; j++) T[i * d + j] -= f * T[j * d + k];
    }
  }
  const out = { logdet, logdetX, r2: T[d * d - 1] };
  if (keep && p) {
    const Txx = new Float64Array(p * p),
      Txy = new Float64Array(p);
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) Txx[i * p + j] = top[i * d + j];
      Txy[i] = top[i * d + p];
    }
    out.beta = Array.from(solve(Txx, p, Txy, 1));
    out.Txxinv = inverse(Txx, p);
  } else if (keep) {
    out.beta = [];
    out.Txxinv = new Float64Array(0);
  }
  return out;
}
class Failure extends Error {}

/** Each level's relative factor from relative parameters, or null. */
function factors(problem, theta, shift = 0) {
  const lambdas = [];
  let at = 0;
  for (const level of problem.levels) {
    const k = parameterCount(level.type, level.q),
      G = covarianceOf(level.type, level.q, theta.slice(at, at + k), shift),
      lam = cholesky(G, level.q);
    if (!lam) return null;
    lambdas.push(lam);
    at += k;
  }
  return lambdas;
}

/**
 * Each level's relative factor from the parameters the search moves, as
 * Stata's matsqrt metric has them: the entries of the factor itself (a
 * single relative standard deviation for identity, one per effect for
 * independent, the lower triangle row by row for unstructured), so that a
 * variance or a whole direction of the covariance can reach zero inside
 * the space; exchangeable keeps its log standard deviation and atanh
 * correlation.
 */
function searchFactors(problem, theta) {
  const lambdas = [];
  let at = 0;
  for (const level of problem.levels) {
    const q = level.q,
      k = parameterCount(level.type, q),
      p = theta.slice(at, at + k);
    at += k;
    if (level.type === "exchangeable") {
      const lam = cholesky(covarianceOf(level.type, q, p), q);
      if (!lam) return null;
      lambdas.push(lam);
      continue;
    }
    const lam = new Float64Array(q * q);
    if (level.type === "identity")
      for (let j = 0; j < q; j++) lam[j * q + j] = p[0];
    else if (level.type === "independent")
      for (let j = 0; j < q; j++) lam[j * q + j] = p[j];
    else {
      let r = 0;
      for (let i = 0; i < q; i++)
        for (let j = i; j < q; j++) lam[i * q + j] = lam[j * q + i] = p[r++];
    }
    lambdas.push(lam);
  }
  return lambdas;
}

/**
 * Stata's parameters (log standard deviations, atanh correlations, then
 * the log residual standard deviation) from the search's, with the
 * residual's log standard deviation lnsig.
 */
function toStataMetric(problem, theta, lnsig) {
  const lambdas = searchFactors(problem, theta),
    gamma = [],
    // A variance of exactly zero has no finite parameter; the nearest
    // representable stands for it. A correlation at one, where the
    // likelihood is flat, is held at atanh 9 (a correlation of 1 to seven
    // digits), about where Stata's search stops on such a surface.
    logsd = (v) => 0.5 * Math.log(Math.max(v, 1e-300)) + lnsig,
    atanh = (r) => Math.max(-9, Math.min(9, Math.atanh(Number(r) || 0)));
  let at = 0;
  problem.levels.forEach((level, l) => {
    const q = level.q,
      k = parameterCount(level.type, q);
    if (level.type === "exchangeable") {
      gamma.push(theta[at] + lnsig, theta[at + 1]);
      at += k;
      return;
    }
    at += k;
    const lam = lambdas[l],
      G = new Float64Array(q * q);
    for (let i = 0; i < q; i++)
      for (let j = 0; j <= i; j++) {
        let s = 0;
        for (let m = 0; m < q; m++) s += lam[i * q + m] * lam[j * q + m];
        G[i * q + j] = G[j * q + i] = s;
      }
    if (level.type === "identity") return void gamma.push(logsd(G[0]));
    for (let j = 0; j < q; j++) gamma.push(logsd(G[j * q + j]));
    if (level.type === "unstructured")
      for (let i = 0; i < q; i++)
        for (let j = i + 1; j < q; j++)
          gamma.push(
            atanh(G[i * q + j] / Math.sqrt(G[i * q + i] * G[j * q + j])),
          );
  });
  return [...gamma, lnsig];
}

/**
 * The log likelihood (or restricted log likelihood) with s^2 profiled out,
 * at the search's relative parameters theta.
 */
function profiled(problem, theta) {
  const lambdas = searchFactors(problem, theta);
  if (!lambdas) return -Infinity;
  let r;
  try {
    r = reduceAll(problem, lambdas);
  } catch (error) {
    if (error instanceof Failure) return -Infinity;
    throw error;
  }
  const { n, p, reml } = problem,
    m = reml ? n - p : n;
  if (!(r.r2 > 0)) return -Infinity;
  return (
    -0.5 *
    (r.logdet +
      (reml ? r.logdetX : 0) +
      m * (1 + Math.log((2 * Math.PI * r.r2) / m)))
  );
}
/**
 * The log likelihood in Stata's metric: each level's parameters (log
 * standard deviations, atanh correlations), then the log residual standard
 * deviation; the fixed effects profiled out.
 */
function inStataMetric(problem, gamma) {
  const lnsig = gamma[gamma.length - 1],
    lambdas = factors(problem, gamma, -lnsig);
  if (!lambdas) return -Infinity;
  let r;
  try {
    r = reduceAll(problem, lambdas);
  } catch (error) {
    if (error instanceof Failure) return -Infinity;
    throw error;
  }
  const { n, p, reml } = problem,
    s2 = Math.exp(2 * lnsig),
    m = reml ? n - p : n;
  return (
    -0.5 *
    (r.logdet +
      (reml ? r.logdetX : 0) +
      m * Math.log(2 * Math.PI * s2) +
      r.r2 / s2)
  );
}

/** Central-difference gradient and Hessian of f at x. */
function derivatives(f, x, fx, h = 1e-4) {
  const k = x.length,
    gradient = new Array(k).fill(0),
    hessian = Array.from({ length: k }, () => new Array(k).fill(0)),
    at = (steps) => {
      const y = x.slice();
      for (const [j, s] of steps) y[j] += s;
      return f(y);
    };
  const plus = [],
    minus = [];
  for (let j = 0; j < k; j++) {
    plus[j] = at([[j, h]]);
    minus[j] = at([[j, -h]]);
    gradient[j] = (plus[j] - minus[j]) / (2 * h);
    hessian[j][j] = (plus[j] - 2 * fx + minus[j]) / (h * h);
  }
  // The cross terms by forward differences, one evaluation each: accurate
  // enough to steer Newton's steps, which need no more (the standard
  // errors take a finer Hessian, from curvature()).
  for (let i = 0; i < k; i++)
    for (let j = 0; j < i; j++) {
      const v =
        (at([
          [i, h],
          [j, h],
        ]) -
          plus[i] -
          plus[j] +
          fx) /
        (h * h);
      hessian[i][j] = hessian[j][i] = v;
    }
  return { gradient, hessian };
}

/**
 * Newton's method with a line search on f from start, as Stata's ml runs
 * it. Returns the maximizer, its value, the log of values and whether it
 * converged. As ml, it stops at an iterate when the scaled gradient
 * g'(-H)^-1 g is below 1e-5 and either the likelihood changed by less
 * than a part in 10^7 or the parameters by less than a part in 10^6 since
 * the last; where the surface is flat toward a singular covariance matrix
 * the search stops there, as Stata's does.
 */
function maximize(f, start, limit = 300) {
  let x = start.slice(),
    fx = f(x);
  const log = [fx];
  if (!Number.isFinite(fx)) return { x, value: fx, log, converged: false };
  const k = x.length;
  if (!k) return { x, value: fx, log, converged: true };
  let lastChange = Infinity,
    lastMove = Infinity;
  for (let iteration = 0; iteration < limit; iteration++) {
    const { gradient, hessian } = derivatives(f, x, fx),
      negative = new Float64Array(k * k);
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k; j++) negative[i * k + j] = -hessian[i][j];
    // Minus the Hessian, its eigenvalues made positive where f is not
    // concave (each replaced by its size, with a floor), so that the step
    // still climbs in every direction.
    const { values, vectors } = symmetricEigen(negative, k),
      top = Math.max(1e-12, ...values.map(Math.abs)),
      concave = values.every((v) => v > 1e-12 * top),
      step = new Float64Array(k);
    for (let e = 0; e < k; e++) {
      let along = 0;
      for (let i = 0; i < k; i++) along += vectors[i * k + e] * gradient[i];
      along /= Math.max(Math.abs(values[e]), 1e-9 * top);
      for (let i = 0; i < k; i++) step[i] += vectors[i * k + e] * along;
    }
    const decrement = gradient.reduce((t, v, j) => t + v * step[j], 0);
    if (
      concave &&
      decrement < 1e-5 &&
      (lastChange < 1e-7 * (Math.abs(fx) + 1e-10) || lastMove < 1e-6)
    )
      return refine(f, x, fx, step, decrement, log);
    // The step halved until it does not lower f.
    let t = 1,
      next = null,
      value = -Infinity;
    for (let tries = 0; tries < 60; tries++) {
      next = x.map((v, j) => v + t * step[j]);
      value = f(next);
      if (value >= fx - 1e-12 * Math.abs(fx)) break;
      t /= 2;
    }
    if (!(value >= fx - 1e-12 * Math.abs(fx)))
      return { x, value: fx, log, converged: Math.abs(decrement) < 1e-6 };
    const change = value - fx;
    lastChange = Math.abs(change);
    lastMove = Math.max(
      ...next.map((v, j) => Math.abs(v - x[j]) / (Math.abs(x[j]) + 1)),
    );
    x = next;
    fx = value;
    log.push(fx);
    // A step that changes nothing at all ends the search: f is flat to
    // working precision.
    if (Math.abs(change) <= 1e-13 * (1 + Math.abs(fx)) && lastMove < 1e-10)
      return { x, value: fx, log, converged: true };
  }
  return { x, value: fx, log, converged: false };
}

/**
 * Where the search stops, Stata's own last Newton step leaves its
 * estimates within about a part in 10^6 of the maximum, by a step that
 * depends on its numerical derivatives. A few more Newton steps, not
 * counted as iterations, bring these to the maximum itself, which Stata's
 * estimates are then nearest on average.
 */
function refine(f, x, fx, step, decrement, log) {
  for (let extra = 0; extra < 3 && decrement > 1e-14; extra++) {
    const next = x.map((v, j) => v + step[j]),
      value = f(next);
    if (!(value > fx)) break;
    x = next;
    fx = value;
    const k = x.length,
      { gradient, hessian } = derivatives(f, x, fx),
      negative = new Float64Array(k * k);
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k; j++) negative[i * k + j] = -hessian[i][j];
    const solved = solve(negative, k, Float64Array.from(gradient), 1);
    if (!solved) break;
    step = solved;
    decrement = gradient.reduce((t, v, j) => t + v * step[j], 0);
  }
  return { x, value: fx, log, converged: true };
}

/**
 * Stata's EM iterations before Newton's: from each level's relative
 * covariance diag(1/(0.375^2 mean_g sum z^2)), where the mean is over the
 * level's groups, each step replaces a level's relative covariance by the
 * mean over its groups of E(u u' | y) / s^2 (with REML, the fixed effects'
 * uncertainty counted), s^2 the residual variance profiled at the current
 * step, and the level's structure imposed. Up to 20 steps, stopping when
 * the likelihood changes by less than a part in 10^10. Returns the
 * search's parameters.
 */
function emStart(problem, limit = 20, tolerance = 1e-10) {
  const { levels, frame: f, p, n, reml, maps } = problem;
  // The sums of squares of each level's effects within its groups.
  let G = levels.map((level, l) => {
    const q = level.q,
      groups = [...maps[l].values()],
      ss = new Array(q).fill(0);
    for (const node of groups)
      for (const r of node.rows) {
        const z = problem.zRow(level, f.sample[r]);
        for (let j = 0; j < q; j++) ss[j] += z[j] * z[j];
      }
    const g = ss.map((v) => 1 / (0.375 * 0.375 * (v / groups.length)));
    const out = new Float64Array(q * q);
    if (level.type === "identity") {
      const mean = g.reduce((a, b) => a + b, 0) / q;
      for (let j = 0; j < q; j++) out[j * q + j] = mean;
    } else for (let j = 0; j < q; j++) out[j * q + j] = g[j];
    return out;
  });
  let theta = searchOf(problem, G),
    value = profiled(problem, theta);
  if (!Number.isFinite(value)) return startingValues(problem);
  for (let iteration = 0; iteration < limit; iteration++) {
    const lambdas = searchFactors(problem, theta);
    let kept;
    try {
      kept = reduceAll(problem, lambdas, true);
    } catch (error) {
      if (error instanceof Failure) break;
      throw error;
    }
    const s2 = kept.r2 / (reml ? n - p : n),
      Sbeta = Array.from({ length: p }, (_, i) =>
        Array.from({ length: p }, (_, j) =>
          reml ? kept.Txxinv[i * p + j] : 0,
        ),
      ),
      sums = levels.map((level) => new Float64Array(level.q * level.q));
    walkEffects(problem, kept.beta, Sbeta, (l, node, x, S) => {
      // E(x x')/s^2 in the spherical scale, then u = L x.
      const q = levels[l].q,
        lam = lambdas[l],
        E = S.map((row, i) => row.map((v, j) => v + (x[i] * x[j]) / s2)),
        sum = sums[l];
      for (let i = 0; i < q; i++)
        for (let j = 0; j < q; j++) {
          let t = 0;
          for (let a = 0; a < q; a++)
            for (let b = 0; b < q; b++)
              t += lam[i * q + a] * E[a][b] * lam[j * q + b];
          sum[i * q + j] += t;
        }
    });
    G = sums.map((sum, l) => {
      const level = levels[l],
        q = level.q,
        count = maps[l].size,
        mean = sum.map((v) => v / count),
        out = new Float64Array(q * q);
      if (level.type === "unstructured") return mean;
      const diagonal = Array.from({ length: q }, (_, j) => mean[j * q + j]);
      if (level.type === "independent")
        diagonal.forEach((v, j) => (out[j * q + j] = v));
      else {
        const v = diagonal.reduce((a, b) => a + b, 0) / q;
        let c = 0;
        if (level.type === "exchangeable" && q > 1) {
          for (let i = 0; i < q; i++)
            for (let j = 0; j < q; j++) if (i !== j) c += mean[i * q + j];
          c /= q * (q - 1);
        }
        for (let i = 0; i < q; i++)
          for (let j = 0; j < q; j++) out[i * q + j] = i === j ? v : c;
      }
      return out;
    });
    const nextTheta = searchOf(problem, G),
      next = profiled(problem, nextTheta);
    if (!Number.isFinite(next)) break;
    const change = Math.abs(next - value) / (Math.abs(value) + 1e-10);
    theta = nextTheta;
    value = next;
    if (change < tolerance) break;
  }
  return theta;
}

/** The search's parameters from each level's relative covariance. */
function searchOf(problem, G) {
  const theta = [];
  problem.levels.forEach((level, l) => {
    const q = level.q,
      g = G[l];
    if (level.type === "identity") theta.push(Math.sqrt(Math.max(g[0], 0)));
    else if (level.type === "independent")
      for (let j = 0; j < q; j++)
        theta.push(Math.sqrt(Math.max(g[j * q + j], 0)));
    else if (level.type === "exchangeable") {
      const v = Math.max(g[0], 1e-300),
        r = q > 1 ? g[1] / v : 0;
      theta.push(
        0.5 * Math.log(v),
        Math.atanh(Math.max(-0.999999, Math.min(0.999999, r))),
      );
    } else {
      // The symmetric square root.
      const { values, vectors } = symmetricEigen(g, q),
        root = new Float64Array(q * q);
      for (let e = 0; e < q; e++) {
        const w = Math.sqrt(Math.max(values[e], 0));
        for (let i = 0; i < q; i++)
          for (let j = 0; j < q; j++)
            root[i * q + j] += w * vectors[i * q + e] * vectors[j * q + e];
      }
      for (let i = 0; i < q; i++)
        for (let j = i; j < q; j++) theta.push(root[i * q + j]);
    }
  });
  return theta;
}

// ---------------------------------------------------------------------------
// Reading the command.

/** Splits text at each || outside quotes. */
function equations(text) {
  const parts = [];
  let current = "",
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quote = !quote;
    if (!quote && c === "|" && text[i + 1] === "|") {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

const GLOBAL_OPTIONS =
  "noCONStant MLe REML STDDEViations VARiance Level(cilevel) noRETable noFETable noHEader noGRoup noLRtest noLOg BASElevels ALLBASElevels VCE(string) | OFFset(string) DFMethod(string) Residuals(string) PWSCale(string) ESTMetric EMITerate(string) EMTolerance(string) EMONly EMLog EMDots ITERate(string) TOLerance(string) LTOLerance(string) NRTOLerance(string) NONRTOLerance DIFficult TECHnique(string) MATSQrt MATLog SMALL COEFLegend noESTimate CFORMAT(string) PFORMAT(string) SFORMAT(string) noCNSReport noLSTRETCH noEMPTYcells FVWRAP(string) FVWRAPON(string) SHOWNRtolerance TRace GRADient SHOWSTEP HESSian";

/** A covariance structure as covariance() names it. */
function structure(text) {
  const t = text.trim().toLowerCase();
  if (t.length >= 3 && "independent".startsWith(t)) return "independent";
  if (t.length >= 3 && "exchangeable".startsWith(t)) return "exchangeable";
  if (t.length >= 2 && "identity".startsWith(t)) return "identity";
  if (t.length >= 2 && "unstructured".startsWith(t)) return "unstructured";
  if (/^(pat(t(e(rn?)?)?)?|fix(ed?)?)\b/.test(t))
    throw refuse(
      `covariance(${text.trim()}) is not available in the browser yet`,
      "independent, exchangeable, identity and unstructured are.",
    );
  throw new StataError(`${text.trim()} invalid covariance structure`, 198);
}

/**
 * The fixed part, the random-effects equations and the options of a mixed
 * command.
 */
function readCommand(session, text) {
  const parts = equations(text),
    [feHead, feOptions] = splitAtComma(parts[0]),
    levels = [],
    qualifiers = {};
  let globals = feOptions ?? "";
  const given = parts.slice(1).filter((part) => part.trim());
  given.forEach((part, k) => {
    const m = /^\s*([^:\s]*)\s*:([\s\S]*)$/.exec(part);
    if (!m || !m[1])
      throw new StataError(
        "invalid random-effects specification; perhaps you omitted the colon after the level variable",
        198,
      );
    const name = m[1];
    if (name === "_all")
      throw refuse(
        "crossed random effects (_all:) are not available in the browser yet",
        "Nested levels, as || school: || class:, are.",
      );
    const [equationText, optionText] = splitAtComma(m[2]),
      // An if or in qualifier may close any equation, as
      // _mixed_parseifin allows; it restricts the whole sample.
      at = /(^|\s)(if|in)(?=\s|$)/.exec(equationText),
      varText = at ? equationText.slice(0, at.index) : equationText,
      words = varText.trim().split(/\s+/).filter(Boolean);
    if (at) {
      const found = session.parse("[if] [in]", equationText.slice(at.index));
      if (found.if !== undefined) {
        if (qualifiers.if !== undefined)
          throw new StataError("multiple if conditions not allowed", 198);
        qualifiers.if = found.if;
      }
      if (found.in !== undefined) {
        if (qualifiers.in !== undefined)
          throw new StataError("multiple in ranges not allowed", 198);
        qualifiers.in = found.in;
      }
    }
    if (words.some((w) => /[.#()]/.test(w)))
      throw refuse(
        "factor variables in a random-effects equation are not available in the browser yet",
        "Generate the indicator variables and list them instead.",
      );
    const level = {
      name: session.varlist(name),
      variables: words.length ? session.varlist(words.join(" ")) : [],
      type: null,
      constant: true,
    };
    if (level.name.length !== 1)
      throw new StataError(`${name}: only one variable allowed`, 103);
    level.name = level.name[0];
    const last = k === given.length - 1,
      rest = [];
    for (const item of optionText === null ? [] : optionItems(optionText)) {
      const word = item.name.toLowerCase();
      if (word.length >= 3 && "covariance".startsWith(word)) {
        if (item.argument === undefined)
          throw new StataError(
            "option covariance() incorrectly specified",
            198,
          );
        level.type = structure(item.argument);
        level.typed = true;
      } else if (word.length >= 6 && "noconstant".startsWith(word))
        level.constant = false;
      else if (/^col(l(i(n(e(ar?)?)?)?)?)?$/.test(word))
        throw refuse("option collinear is not available in the browser yet");
      else if (/^[fp]w(e(i(g(ht?)?)?)?)?$/.test(word))
        throw refuse(
          `option ${word} is not available in the browser yet`,
          "mixed is fitted without weights here.",
        );
      else if (last) rest.push(item.word);
      else throw new StataError(`option ${item.name} not allowed`, 198);
    }
    globals += " " + rest.join(" ");
    levels.push(level);
  });
  if (levels.some((l, k) => levels.findIndex((o) => o.name === l.name) !== k))
    throw refuse(
      "a level named twice, for block-diagonal covariances, is not available in the browser yet",
    );
  // Time-series operators in the fixed part, as L.x or D2.y.
  if (/(^|\s)(?:[LFDS]\d*)+\.|(^|\s)(?:[LFDS]\d*)*[LFDS]\(/i.test(feHead))
    throw refuse(
      "time-series operators are not available with mixed in the browser yet",
      "Generate the lagged or differenced variable first, as generate lx = L.x, and list it instead.",
    );
  const parsed = session.parse(
    `anything [if] [in] [fweight pweight] [, ${GLOBAL_OPTIONS}]`,
    globals.trim() ? `${feHead}, ${globals.trim()}` : feHead,
  );
  if (qualifiers.if !== undefined) {
    if (parsed.if !== undefined)
      throw new StataError("multiple if conditions not allowed", 198);
    parsed.if = qualifiers.if;
  }
  if (qualifiers.in !== undefined) {
    if (parsed.in !== undefined)
      throw new StataError("multiple in ranges not allowed", 198);
    parsed.in = qualifiers.in;
  }
  if (parsed.weight)
    throw refuse(
      "weights are not available with mixed in the browser yet",
      "mixed is fitted without weights here.",
    );
  const options = parsed.options;
  if (options.vce !== undefined && !/^\s*oim\s*$/.test(options.vce))
    throw refuse(
      `vce(${options.vce.trim()}) is not available with mixed in the browser yet`,
      "The default observed-information standard errors are.",
    );
  if (options.mle && options.reml)
    throw new StataError(
      "ml and reml may not be specified at the same time",
      198,
    );
  if (options.stddeviations && options.variance)
    throw new StataError(
      "options stddeviations and variance may not be combined",
      198,
    );
  return { parsed, levels, options };
}

// ---------------------------------------------------------------------------
// Building the problem.

/**
 * If the columns of x (rows of values) fit y exactly, the columns that
 * carry the fit (a nonzero coefficient); otherwise null. By modified
 * Gram-Schmidt, a column that adds nothing to the ones before it skipped.
 */
function exactFit(x, y) {
  const n = y.length,
    p = x[0].length,
    norm = (v) => Math.sqrt(v.reduce((t, a) => t + a * a, 0)),
    basis = [],
    kept = [],
    R = [];
  for (let j = 0; j < p; j++) {
    const v = x.map((row) => row[j]),
      size = norm(v),
      r = [];
    for (const q of basis) {
      const c = q.reduce((t, a, i) => t + a * v[i], 0);
      r.push(c);
      for (let i = 0; i < n; i++) v[i] -= c * q[i];
    }
    const left = norm(v);
    if (!(left > 1e-10 * size)) continue;
    basis.push(v.map((a) => a / left));
    R.push([...r, left]);
    kept.push(j);
  }
  const e = Float64Array.from(y),
    scale = norm(y),
    z = basis.map((q) => {
      const c = q.reduce((t, a, i) => t + a * e[i], 0);
      for (let i = 0; i < n; i++) e[i] -= c * q[i];
      return c;
    });
  if (!(norm(e) <= 1e-12 * scale) || !kept.length) return null;
  // Back-substitution for the coefficients of the kept columns.
  const k = kept.length,
    b = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = z[i];
    for (let j = i + 1; j < k; j++) s -= R[j][i] * b[j];
    b[i] = s / R[i][i];
  }
  const size = (j) => norm(x.map((row) => row[kept[j]]));
  return kept.filter((_, i) => Math.abs(b[i]) * size(i) > 1e-10 * scale);
}

function buildProblem(session, spec) {
  const { parsed, levels: asked, options } = spec,
    data = session.data,
    column = (name) => data.get(name),
    numeric = (name) => {
      const v = column(name);
      if (isStringType(v.type))
        throw new StataError("string variables not allowed in varlist", 109);
      return v.data;
    };
  // Each level: its variable, its effects' columns (the constant last) and
  // its covariance structure.
  const levels = asked
    .map((level) => {
      for (const name of level.variables)
        if (isStringType(column(name).type))
          throw new StataError("invalid syntax", 198);
      const z = level.variables.map(numeric),
        q = z.length + (level.constant ? 1 : 0),
        names = [...level.variables, ...(level.constant ? ["_cons"] : [])];
      return {
        name: level.name,
        group: column(level.name),
        z,
        q,
        names,
        type:
          q === 1
            ? "identity"
            : (level.type ?? (q > 1 ? "independent" : "identity")),
      };
    })
    // A level with no effects is left out; if none is left, the model is a
    // linear regression.
    .filter((level) => level.q > 0);
  const empty = asked.length > 0 && !levels.length;
  if (levels.length && levels.length < asked.length)
    throw refuse(
      "a level with no random effects beside others is not available in the browser yet",
    );
  const missingGroup = (level, i) =>
      isStringType(level.group.type)
        ? level.group.data[i] === ""
        : isMissing(level.group.data[i]),
    group = spec.group,
    keep = (i) =>
      (!group || (i >= group.start && i < group.start + group.count)) &&
      levels.every(
        (level) =>
          !missingGroup(level, i) && level.z.every((z) => !isMissing(z[i])),
      ),
    f = frame(session, parsed, options.constant !== false, undefined, false, {
      keep,
      weight: null,
    }),
    n = f.sample.length,
    p = f.x[0].length;
  // As Stata's _rmdcoll: an outcome the fixed effects fit exactly is
  // collinear with them.
  if (f.columns.length && n) {
    const used = exactFit(f.x, f.y);
    if (used)
      throw new StataError(
        `${f.dependent.name} collinear with ${used.map((j) => f.names[j]).join(" ")}`,
        459,
      );
  }
  if (n <= p) throw new StataError("insufficient observations", 2001);
  // Groups: at level l, the values of the variables of levels 1..l.
  const L = levels.length,
    dims = [];
  let qs = 0;
  for (let l = 0; l < L; l++) {
    qs += levels[l].q;
    dims.push(qs + p + 1);
  }
  const tree = [],
    maps = levels.map(() => new Map()),
    leaves = [];
  f.sample.forEach((i, r) => {
    let parent = null,
      key = "";
    levels.forEach((level, l) => {
      key += `\u0001${level.group.data[i]}`;
      let node = maps[l].get(key);
      if (!node) {
        node = { key, children: [], rows: [], level: l };
        maps[l].set(key, node);
        (parent ? parent.children : tree).push(node);
        if (l === L - 1) leaves.push(node);
      }
      node.rows.push(r);
      parent = node;
    });
  });
  // With a constant among the fixed effects, the outcome and the other
  // regressors are taken about their means, which leaves the likelihood as
  // it is (the constant absorbs the shift) and keeps the cross-products
  // from losing digits to a large mean.
  const constant = f.names.at(-1) === "_cons",
    mean = (values) => values.reduce((t, v) => t + v, 0) / values.length,
    center = constant
      ? {
          y: mean(f.y),
          x: Array.from({ length: p - 1 }, (_, j) =>
            mean(f.x.map((row) => row[j])),
          ),
        }
      : null;
  // The cross-products of [Z_L .. Z_1, X, y] within each innermost group.
  const zRow = (level, i) => [
    ...level.z.map((z) => z[i]),
    ...(level.names.at(-1) === "_cons" ? [1] : []),
  ];
  const wRow = (r) => {
    const i = f.sample[r];
    const out = [];
    for (let l = L - 1; l >= 0; l--) out.push(...zRow(levels[l], i));
    if (center)
      out.push(
        ...f.x[r].map((v, j) => (j < p - 1 ? v - center.x[j] : v)),
        f.y[r] - center.y,
      );
    else out.push(...f.x[r], f.y[r]);
    return out;
  };
  const crossOf = (rows, d) => {
    const A = new Float64Array(d * d);
    for (const r of rows) {
      const w = wRow(r);
      for (let a = 0; a < d; a++) {
        const wa = w[a];
        if (wa === 0) continue;
        for (let b = 0; b <= a; b++) A[a * d + b] += wa * w[b];
      }
    }
    for (let a = 0; a < d; a++)
      for (let b = 0; b < a; b++) A[b * d + a] = A[a * d + b];
    return A;
  };
  for (const leaf of leaves) leaf.cross = crossOf(leaf.rows, dims[L - 1]);
  const problem = {
    n,
    p,
    reml: !!options.reml,
    levels,
    dims,
    tree,
    maps,
    frame: f,
    zRow,
    empty,
    center,
  };
  if (!L)
    problem.cross = crossOf(
      f.sample.map((_, r) => r),
      p + 1,
    );
  return problem;
}

// ---------------------------------------------------------------------------
// Fitting.

/** Names of the variance parameters in Stata's e(b). */
function parameterNames(levels) {
  const names = [];
  levels.forEach((level, l) => {
    const k = parameterCount(level.type, level.q),
      sds =
        level.type === "identity" || level.type === "exchangeable"
          ? 1
          : level.q;
    for (let j = 1; j <= sds; j++) names.push(`lns${l + 1}_1_${j}`);
    if (level.type === "exchangeable") names.push(`atr${l + 1}_1_1_1`);
    if (level.type === "unstructured")
      for (let i = 1; i <= level.q; i++)
        for (let j = i + 1; j <= level.q; j++)
          names.push(`atr${l + 1}_1_${i}_${j}`);
  });
  return [...names, "lnsig_e"];
}

/** Relative starting values: each effect's standard deviation half the
 * residual's, scaled by its variable's size, the effects uncorrelated. */
function startingValues(problem) {
  const theta = [];
  const { frame: f } = problem;
  for (const level of problem.levels) {
    const size = level.names.map((name, j) => {
      if (name === "_cons") return 1;
      let total = 0;
      for (const i of f.sample) total += level.z[j][i] ** 2;
      return Math.sqrt(total / f.sample.length) || 1;
    });
    if (level.type === "identity" || level.type === "exchangeable") {
      const mean = size.reduce((a, b) => a + b, 0) / size.length;
      if (level.type === "exchangeable") theta.push(Math.log(0.5 / mean), 0);
      else theta.push(0.5 / mean);
    } else if (level.type === "independent")
      size.forEach((s) => theta.push(0.5 / s));
    else
      size.forEach((s, i) => {
        theta.push(0.5 / s);
        for (let j = i + 1; j < size.length; j++) theta.push(0);
      });
  }
  return theta;
}

/**
 * Minus the Hessian of f at x by central differences, each parameter's
 * step chosen as Stata's numerical derivatives choose it: the smallest
 * that changes f by about a part in 10^8, so that a parameter on which f
 * hardly depends (the log of a variance near zero) still gets a finite
 * curvature. Returns { negative }, or { failure } if f cannot be
 * evaluated near x.
 */
function curvature(f, x, fx) {
  const k = x.length,
    v0 = (Math.abs(fx) + 1e-8) * 1e-8,
    v1 = (Math.abs(fx) + 1e-7) * 1e-7,
    d = [],
    plus = [],
    minus = [],
    at = (steps) => {
      const y = x.slice();
      for (const [j, s] of steps) y[j] += s;
      return f(y);
    };
  for (let j = 0; j < k; j++) {
    let h = (Math.abs(x[j]) + 1e-3) * 1e-3,
      fp = at([[j, h]]),
      fm = at([[j, -h]]);
    // Not even the smallest step stays inside the space: the covariance
    // matrix is singular to working precision.
    if (!Number.isFinite(fp) || !Number.isFinite(fm))
      return { failure: "singular" };
    // The step is doubled or halved until the change is bracketed, then
    // the bracket is halved geometrically.
    let low = 0,
      high = Infinity;
    for (let tries = 0; tries < 80; tries++) {
      const change = Math.max(Math.abs(fx - fm), Math.abs(fp - fx));
      if (change < v0 && h < 50) low = h;
      else if (change > v1 && h > 1e-12) high = h;
      else break;
      h =
        low && high < Infinity
          ? Math.sqrt(low * high)
          : high < Infinity
            ? h / 2
            : h * 2;
      fp = at([[j, h]]);
      fm = at([[j, -h]]);
      // A step grown to move f leaves the space, as where a correlation
      // is one: Stata's calculation fails there.
      if (!Number.isFinite(fp) || !Number.isFinite(fm))
        return { failure: "failed" };
    }
    d.push(h);
    plus.push(fp);
    minus.push(fm);
  }
  const negative = new Float64Array(k * k);
  for (let j = 0; j < k; j++)
    negative[j * k + j] = -(plus[j] - 2 * fx + minus[j]) / (d[j] * d[j]);
  for (let i = 0; i < k; i++)
    for (let j = 0; j < i; j++) {
      const v =
        (at([
          [i, d[i]],
          [j, d[j]],
        ]) -
          at([
            [i, d[i]],
            [j, -d[j]],
          ]) -
          at([
            [i, -d[i]],
            [j, d[j]],
          ]) +
          at([
            [i, -d[i]],
            [j, -d[j]],
          ])) /
        (4 * d[i] * d[j]);
      if (!Number.isFinite(v)) return { failure: "singular" };
      negative[i * k + j] = negative[j * k + i] = -v;
    }
  return { negative };
}

function fitModel(problem) {
  const start = emStart(problem),
    f = (theta) => profiled(problem, theta),
    run = maximize(f, start),
    theta = run.x,
    lambdas = searchFactors(problem, theta),
    kept = reduceAll(problem, lambdas, true),
    m = problem.reml ? problem.n - problem.p : problem.n,
    sigma2 = kept.r2 / m,
    lnsig = 0.5 * Math.log(sigma2),
    gamma = toStataMetric(problem, theta, lnsig),
    k = gamma.length,
    // As in Stata, the variance parameters' standard errors come from the
    // Hessian in Stata's own metric. Where the likelihood cannot be
    // evaluated beside the estimates (a correlation at one), Stata reports
    // that the calculation failed; where minus the Hessian is not positive
    // definite (a covariance matrix nearly singular), its variance is left
    // at zero and the errors are not shown.
    { negative, failure } = curvature(
      (x) => inStataMetric(problem, x),
      gamma,
      inStataMetric(problem, gamma),
    ),
    inv = negative && inverse(negative, k),
    Vgamma = inv
      ? toRows(inv, k)
      : Array.from({ length: k }, () => new Array(k).fill(0)),
    p = problem.p,
    centered = Array.from({ length: p }, (_, i) =>
      Array.from({ length: p }, (_, j) => sigma2 * kept.Txxinv[i * p + j]),
    ),
    // Back from centered regressors: the constant is b0* - m'b* + mean(y).
    c = problem.center,
    transform = Array.from({ length: p }, (_, i) =>
      Array.from({ length: p }, (_, j) =>
        c && i === p - 1 ? (j === p - 1 ? 1 : -c.x[j]) : i === j ? 1 : 0,
      ),
    ),
    beta = c
      ? kept.beta.map((v, i) =>
          i === p - 1
            ? v - c.x.reduce((t, m, j) => t + m * kept.beta[j], 0) + c.y
            : v,
        )
      : kept.beta,
    Vbeta = transform.map((ti) =>
      transform.map((tj) => {
        let t = 0;
        for (let a = 0; a < p; a++)
          for (let b = 0; b < p; b++) t += ti[a] * centered[a][b] * tj[b];
        return t;
      }),
    );
  // The linear model, for the likelihood-ratio test.
  const zero = problem.levels.map((l) => new Float64Array(l.q * l.q)),
    flat = reduceAll(problem, zero),
    linear =
      -0.5 *
      ((problem.reml ? flat.logdetX : 0) +
        m * (1 + Math.log((2 * Math.PI * flat.r2) / m)));
  return {
    run,
    theta,
    lambdas,
    kept,
    sigma2,
    gamma,
    Vgamma,
    // No standard errors for the variance parameters: "failed" when the
    // calculation could not be made, "singular" when it gave none.
    noSE: failure ?? (inv ? null : "singular"),
    beta,
    // The fixed effects as the centered problem has them, for predict.
    betaStar: kept.beta,
    Vbeta,
    ll: run.value,
    linear,
  };
}

// ---------------------------------------------------------------------------
// The random-effects parameters as the table shows them.

/**
 * A pair's label, cov(a,b) or corr(a,b), as lines of the table's first
 * column: one longer than the column is broken after its comma.
 */
function pairLabel(word, a, b) {
  const whole = `${word}(${a},${b})`;
  if (whole.length <= 28) return [whole];
  return [
    `${word}(${abbreviate(a, 28 - word.length - 2)},`,
    `${abbreviate(b, 27)})`,
  ];
}

/**
 * The rows of the random-effects table: per level, a heading and its
 * parameters' rows, then the residual's. Each row has the lines of its
 * label, a kind (var, sd, cov or corr) and a function of Stata's parameter
 * vector. widths lists, unabbreviated, the labels Stata counts when it
 * sets the width of the fixed-effects table: one for each parameter, named
 * by the first variable it concerns.
 */
function effectRows(problem, sd) {
  const blocks = [],
    widths = [];
  let at = 0;
  problem.levels.forEach((level) => {
    const k = parameterCount(level.type, level.q),
      base = at,
      names = level.names,
      rows = [],
      v = sd ? "sd" : "var",
      c = sd ? "corr" : "cov",
      variance = (j) => (x) => Math.exp((sd ? 1 : 2) * x[base + j]);
    if (level.type === "identity" || level.type === "exchangeable") {
      const all = names.join(" ");
      rows.push({ lines: [`${v}(${all})`], kind: v, value: variance(0) });
      widths.push(`${v}(${names[0]})`);
      if (level.type === "exchangeable") {
        rows.push({
          lines:
            level.q === 2 ? pairLabel(c, names[0], names[1]) : [`${c}(${all})`],
          kind: c,
          value: (x) =>
            Math.tanh(x[base + 1]) * (sd ? 1 : Math.exp(2 * x[base])),
        });
        widths.push(`${c}(${names[0]},${names[1]})`);
      }
    } else {
      names.forEach((name, j) => {
        rows.push({
          lines: [`${v}(${abbreviate(name, 28 - v.length - 2)})`],
          kind: v,
          value: variance(j),
        });
        widths.push(`${v}(${name})`);
      });
      if (level.type === "unstructured") {
        let r = level.q;
        for (let i = 0; i < level.q; i++)
          for (let j = i + 1; j < level.q; j++) {
            const index = base + r++;
            rows.push({
              lines: pairLabel(c, names[i], names[j]),
              kind: c,
              value: (x) =>
                Math.tanh(x[index]) *
                (sd ? 1 : Math.exp(x[base + i] + x[base + j])),
            });
            widths.push(`${c}(${names[i]},${names[j]})`);
          }
      }
    }
    blocks.push({
      heading: `${abbreviate(level.name, 12)}: ${level.q === 1 ? "Identity" : STRUCTURES[level.type]}`,
      rows,
    });
    at += k;
  });
  const last = at;
  return {
    blocks,
    widths,
    residual: {
      lines: [`${sd ? "sd" : "var"}(Residual)`],
      kind: sd ? "sd" : "var",
      value: (x) => Math.exp((sd ? 1 : 2) * x[last]),
    },
  };
}

/** A function's value, standard error by the delta method and interval;
 * without V, the value alone. */
function delta(fn, gamma, V, kind, level) {
  if (!V) return { value: fn(gamma), se: MISSING, low: MISSING, high: MISSING };
  const value = fn(gamma),
    h = 1e-6,
    grad = gamma.map((_, j) => {
      const a = gamma.slice(),
        b = gamma.slice();
      a[j] += h;
      b[j] -= h;
      return (fn(a) - fn(b)) / (2 * h);
    });
  let variance = 0;
  for (let i = 0; i < grad.length; i++)
    for (let j = 0; j < grad.length; j++)
      variance += grad[i] * V[i][j] * grad[j];
  const se = Math.sqrt(variance),
    z = invnormal(1 - (1 - level / 100) / 2);
  let low, high;
  if (kind === "var" || kind === "sd") {
    low = value * Math.exp((-z * se) / value);
    high = value * Math.exp((z * se) / value);
  } else if (kind === "corr" || kind === "icc") {
    const [to, from] =
      kind === "corr"
        ? [Math.atanh, Math.tanh]
        : [(v) => Math.log(v / (1 - v)), (v) => 1 / (1 + Math.exp(-v))];
    const spread =
      (z * se) / (kind === "corr" ? 1 - value * value : value * (1 - value));
    low = from(to(value) - spread);
    high = from(to(value) + spread);
  } else {
    low = value - z * se;
    high = value + z * se;
  }
  const clean = (v) => (Number.isFinite(v) ? v : MISSING);
  return { value, se: clean(se), low: clean(low), high: clean(high) };
}

// ---------------------------------------------------------------------------
// The command.

/** Each level's number of groups and smallest, mean and largest size. */
function groupCounts(problem) {
  return problem.levels.map((level, l) => {
    const sizes = [...problem.maps[l].values()].map((node) => node.rows.length);
    return {
      name: level.name,
      groups: sizes.length,
      min: Math.min(...sizes),
      avg: sizes.reduce((a, b) => a + b, 0) / sizes.length,
      max: Math.max(...sizes),
    };
  });
}

/** The grouping table of a model with more than one level, or estat group. */
function groupTable(counts, indent) {
  const pad = " ".repeat(indent),
    lines = [
      `${pad}${"-".repeat(61)}`,
      `${pad}                |     No. of       Observations per group`,
      `${pad} Group variable |     groups    Minimum    Average    Maximum`,
      `${pad}----------------+--------------------------------------------`,
    ];
  for (const c of counts)
    lines.push(
      `${pad}${abbreviate(c.name, 12).padStart(15)} |${count(c.groups).padStart(11)}${count(c.min).padStart(11)}${g(c.avg, "%9.1fc").padStart(11)}${count(c.max).padStart(11)}`,
    );
  lines.push(`${pad}${"-".repeat(61)}`);
  return lines;
}

/** The fixed effects' Wald test of every coefficient but the constant. */
function waldTest(model) {
  const tested = model.names
    .map((name, k) => k)
    .filter((k) => model.names[k] !== "_cons" && model.estimable[k]);
  if (!tested.length) return { chi2: MISSING, df: 0, p: MISSING };
  const n = tested.length,
    V = new Float64Array(n * n),
    b = new Float64Array(n);
  tested.forEach((k, i) => {
    b[i] = model.b[k];
    tested.forEach((j, c) => (V[i * n + c] = model.V[k][j]));
  });
  const x = solve(V, n, b, 1);
  if (!x) return { chi2: MISSING, df: n, p: MISSING };
  const chi2 = x.reduce((t, v, i) => t + v * b[i], 0);
  return { chi2, df: n, p: chi2tail(n, chi2) };
}

function header(ctx, model, counts, options) {
  const word = model.reml ? "Log restricted-likelihood" : "Log likelihood",
    title = `Mixed-effects ${model.reml ? "REML" : "ML"} regression`,
    chi2 = isMissing(model.chi2) ? "." : g(model.chi2, "%9.2f"),
    prob = isMissing(model.p) ? "." : g(model.p, "%6.4f"),
    llText = `${word} = ${g(model.ll, "%10.0g").padStart(10)}`,
    single = counts.length === 1 && !options.nogroup;
  if (single) {
    const [c] = counts,
      values = [
        count(model.N),
        count(c.groups),
        count(c.min),
        g(c.avg, "%10.1fc"),
        count(c.max),
        chi2,
        prob,
      ],
      pad = Math.max(...values.map((v) => v.length + 1)),
      left = 53 - (pad - 7),
      side = (label, value) => `${label.padEnd(17)}=${value.padStart(pad)}`,
      blank = " ".repeat(left);
    ctx.out(`${title.padEnd(left)}${side("Number of obs", values[0])}`);
    ctx.out(
      `${`Group variable: ${abbreviate(c.name, 14)}`.padEnd(left)}${side("Number of groups", values[1])}`,
    );
    ctx.out(`${blank}Obs per group:`);
    ctx.out(`${blank}${side("             min", values[2])}`);
    ctx.out(`${blank}${side("             avg", values[3])}`);
    ctx.out(`${blank}${side("             max", values[4])}`);
    ctx.out(`${blank}${side(`Wald chi2(${model.df_m})`, chi2)}`);
    ctx.out(`${llText.padEnd(left)}${side("Prob > chi2", prob)}`);
  } else {
    const values = [count(model.N), chi2, prob],
      pad = Math.max(...values.map((v) => v.length + 1)),
      left = 56 - (pad - 7),
      side = (label, value) => `${label.padEnd(14)}=${value.padStart(pad)}`;
    ctx.out(`${title.padEnd(left)}${side("Number of obs", values[0])}`);
    if (counts.length && !options.nogroup) {
      ctx.out("");
      ctx.out("        Grouping information");
      groupTable(counts, 8).forEach((line) => ctx.out(line));
      ctx.out("");
    }
    ctx.out(`${" ".repeat(left)}${side(`Wald chi2(${model.df_m})`, chi2)}`);
    ctx.out(`${llText.padEnd(left)}${side("Prob > chi2", prob)}`);
  }
  ctx.out("");
}

const effectHead = (level) => [
  "-".repeat(78),
  `  Random-effects parameters  |   Estimate   Std. err.     [${g(level)}% conf. interval]`,
  `${"-".repeat(29)}+${"-".repeat(48)}`,
];
const effectLine = (label, r) =>
  `${label.padStart(28)} |${g(r.value).padStart(11)}${g(r.se).padStart(11)}${g(r.low).padStart(14)}${g(r.high).padStart(12)}`;
/** A row whose label may take more than one line. */
function effectRow(ctx, lines, r) {
  lines.slice(0, -1).forEach((line) => ctx.out(`${line.padStart(28)} |`));
  ctx.out(effectLine(lines.at(-1), r));
}

function effectsTable(ctx, model, level, sd) {
  const shown = effectRows(model.problem, sd);
  effectHead(level).forEach((line) => ctx.out(line));
  for (const block of shown.blocks) {
    ctx.out(`${block.heading.padEnd(29)}|`);
    for (const r of block.rows)
      effectRow(
        ctx,
        r.lines,
        delta(r.value, model.gamma, model.VforSE, r.kind, level),
      );
    ctx.out(`${"-".repeat(29)}+${"-".repeat(48)}`);
  }
  effectRow(
    ctx,
    shown.residual.lines,
    delta(
      shown.residual.value,
      model.gamma,
      model.VforSE,
      shown.residual.kind,
      level,
    ),
  );
  ctx.out("-".repeat(78));
}

function lrLine(ctx, model) {
  const c = model.chi2_c,
    value = g(c, (c > 0.005 && c < 1e5) || c === 0 ? "%8.2f" : "%8.2e"),
    p = g(model.p_c, "%6.4f");
  if (model.df_c === 1)
    ctx.out(
      `${`LR test vs. linear model: chibar2(01) = ${value}`.padEnd(54)}Prob >= chibar2 = ${p}`,
    );
  else
    ctx.out(
      `${`LR test vs. linear model: chi2(${model.df_c}) = ${value}`.padEnd(58)}Prob > chi2 = ${p}`,
    );
}

/**
 * mixed, or xtmixed (xt), its old name, which shows standard deviations
 * unless asked for variances. Under by, ctx.group is the group fitted.
 */
function mixed(session, text, ctx, xt = false) {
  const metric = (options) => {
    if (xt && !options.variance) options.stddeviations = true;
    return options;
  };
  // Typed alone, with display options at most, mixed shows the last fit.
  if (
    !equations(text)
      .slice(1)
      .some((part) => part.trim())
  ) {
    const [head, tail] = splitAtComma(text);
    if (!head.trim()) {
      const model = session.estimates;
      if (model?.command !== "mixed" || !!model.xt !== xt)
        throw new StataError("last estimates not found", 301);
      const options = metric(
        session.parse(
          `[, ${GLOBAL_OPTIONS.replace(/noCONStant |MLe REML |noLOg /g, "")}]`,
          tail === null ? "" : `, ${tail}`,
        ).options,
      );
      if (model.problem.empty)
        ctx.out(
          "Note: all random-effects equations are empty; model is linear regression",
        );
      ctx.out("");
      show(session, model, options, ctx);
      return;
    }
  }
  const spec = { ...readCommand(session, text), group: ctx.group ?? null },
    options = metric(spec.options),
    problem = buildProblem(session, spec);
  // Every innermost group a single observation: its effects cannot be told
  // from the residual. Stata's optimizer stops on the flat likelihood.
  const inner = problem.levels.length
    ? [...problem.maps[problem.levels.length - 1].values()]
    : [];
  if (inner.length && inner.every((node) => node.rows.length === 1)) {
    if (options.log !== false) {
      ctx.out("");
      ctx.out("Performing EM optimization ...");
      ctx.out("");
      ctx.out("Performing gradient-based optimization: ");
    }
    throw new StataError(
      problem.levels.length === 1 && problem.levels[0].q === 1
        ? renderSmcl(
            "{p}could not calculate numerical derivatives -- discontinuous region with missing values encountered{p_end}",
            session.settings.linesize ?? 79,
          )
        : "Hessian is not negative semidefinite",
      430,
    );
  }
  const f = problem.frame,
    fit = fitModel(problem),
    depvar = f.dependent.name,
    names = [
      ...f.columns.map((c) => c.name),
      ...(f.names.at(-1) === "_cons" ? ["_cons"] : []),
    ],
    placed = f.place(fit.beta, fit.Vbeta),
    counts = groupCounts(problem),
    gammaNames = parameterNames(problem.levels),
    model = {
      command: "mixed",
      kind: "mixed",
      title: `Mixed-effects ${problem.reml ? "REML" : "ML"} regression`,
      depvar,
      names,
      ...placed,
      columns: f.columns,
      constant: names.at(-1) === "_cons",
      N: problem.n,
      dist: "z",
      vce: "oim",
      sample: f.sample,
      baseLevels: baseLevelsAsked(options),
      reml: problem.reml,
      ll: fit.ll,
      problem,
      spec,
      xt,
      fit,
      gamma: fit.gamma,
      Vgamma: fit.Vgamma,
      VforSE: fit.noSE ? null : fit.Vgamma,
      sigma2: fit.sigma2,
    };
  const wald = waldTest(model);
  Object.assign(model, { chi2: wald.chi2, p: wald.p, df_m: wald.df });
  const lrDf = fit.gamma.length - 1;
  Object.assign(model, {
    ll_c: fit.linear,
    df_c: lrDf,
    chi2_c: Math.max(0, 2 * (fit.ll - fit.linear)),
  });
  // As Stata: the chi-bar-squared halving only for a statistic above
  // 1e-5, so that a variance estimated at zero gives p = 1. With vce()
  // Stata makes no comparison with the linear model.
  model.p_c = lrDf
    ? chi2tail(lrDf, model.chi2_c) *
      (lrDf === 1 && model.chi2_c > 1e-5 ? 0.5 : 1)
    : MISSING;
  model.lrTested = problem.levels.length > 0 && options.vce === undefined;
  // e(b) and e(V): the fixed effects, then the variance parameters, the
  // two blocks independent.
  const fixed = coefficientSpace({ ...model, space: undefined }),
    k = fixed.entries.length,
    entries = [
      ...fixed.entries,
      ...gammaNames.map((name, j) => ({
        equation: name,
        name: "_cons",
        index: -1,
        omitted: false,
        variance: j,
      })),
    ],
    total = entries.length;
  model.space = {
    entries,
    b: [...fixed.b, ...fit.gamma],
    V: entries.map((_, i) =>
      entries.map((__, j) =>
        i < k && j < k
          ? fixed.V[i][j]
          : i >= k && j >= k
            ? fit.Vgamma[i - k][j - k]
            : 0,
      ),
    ),
  };
  const omitted = names.filter((_, j) => !placed.estimable[j]).length,
    levels = problem.levels;
  model.rank = total - omitted;
  model.ereturnMatrices = [
    ["b", 1, total],
    ["V", total, total],
    ...(levels.length
      ? ["g_max", "g_avg", "g_min", "N_g"].map((name) => [
          name,
          1,
          levels.length,
        ])
      : []),
  ];
  Object.assign(model, {
    k_f: names.length,
    k_rs: gammaNames.filter((n) => /^lns|^lnsig/.test(n)).length,
    k_rc: gammaNames.filter((n) => /^atr/.test(n)).length,
  });
  session.estimates = model;
  const gNames = levels.map((l) => l.name),
    vector = (key) => ({
      rowNames: ["r1"],
      colNames: gNames.map((_, j) => `c${j + 1}`),
      values: [counts.map((c) => c[key])],
    });
  session.results.e = {
    rank: model.rank,
    k_f: names.length,
    k_r: fit.gamma.length,
    k: names.length + fit.gamma.length,
    k_rs: gammaNames.filter((n) => /^lns|^lnsig/.test(n)).length,
    k_rc: gammaNames.filter((n) => /^atr/.test(n)).length,
    k_res: 0,
    converged: fit.run.converged ? 1 : 0,
    ic: Math.max(0, fit.run.log.length - 1),
    ll: fit.ll,
    ...(model.lrTested
      ? {
          ll_c: fit.linear,
          df_c: model.df_c,
          chi2_c: model.chi2_c,
          p_c: model.p_c,
        }
      : {}),
    N: problem.n,
    nrgroups: 1,
    // Stata posts these in the other order when vce() is given.
    ...(model.lrTested
      ? { small: 0, p: model.p, chi2: model.chi2, df_m: model.df_m, rc: 0 }
      : { rc: 0, df_m: model.df_m, chi2: model.chi2, p: model.p, small: 0 }),
    cmdline: `mixed ${text.trim()}`,
    chi2type: "Wald",
    rstructlab: "Independent",
    rstructure: "independent",
    estat_cmd: "mixed_estat",
    predict: "mixed_p",
    redim: levels.map((l) => l.q).join(" "),
    ivars: gNames.join(" "),
    vartypes: levels
      .map((l) => (l.q === 1 ? "Identity" : STRUCTURES[l.type]))
      .join(" "),
    revars: levels.map((l) => l.names.join(" ")).join(" "),
    cmd: xt ? "xtmixed" : "mixed",
    title: model.title,
    technique: "nr",
    ml_method: "d0",
    opt: "moptimize",
    method: problem.reml ? "REML" : "ML",
    optmetric: "matsqrt",
    depvar,
    properties: "b V",
    ...(levels.length
      ? {
          "matrix:g_max": vector("max"),
          "matrix:g_avg": vector("avg"),
          "matrix:g_min": vector("min"),
          "matrix:N_g": vector("groups"),
        }
      : {}),
  };

  // What Stata prints. A structure asked of a single effect is noted and
  // set to identity.
  for (const level of spec.levels)
    if (
      level.typed &&
      level.type !== "identity" &&
      level.variables.length + (level.constant ? 1 : 0) === 1
    )
      renderSmcl(
        `{p 0 6}note: single-variable random-effects specification in ${level.name} equation; covariance structure set to identity.{p_end}`,
        session.settings.linesize ?? 79,
      )
        .split("\n")
        .forEach((line) => ctx.out(line));
  if (problem.empty)
    ctx.out(
      "Note: all random-effects equations are empty; model is linear regression",
    );
  f.notes(ctx);
  ctx.out("");
  if (levels.length && options.log !== false) {
    const word = problem.reml ? "Log restricted-likelihood" : "Log likelihood";
    ctx.out("Performing EM optimization ...");
    ctx.out("");
    ctx.out("Performing gradient-based optimization: ");
    fit.run.log.forEach((value, k) => ctx.out(iterationLine(k, word, value)));
    if (!fit.run.converged) ctx.out("convergence not achieved");
    ctx.out("");
    ctx.out("Computing standard errors ...");
  }
  if (fit.noSE === "failed") ctx.out("standard-error calculation has failed");
  if (levels.length && options.log !== false) ctx.out("");
  show(session, model, options, ctx);
}

/**
 * r(table) after mixed: the fixed effects with their tests, then each
 * variance parameter as the table showed it (var(_cons), cov(x,_cons) or
 * sd() and corr()), named by its level, with its interval and no test.
 */
function tableOf(model) {
  return {
    "matrix:table": reResults(model, model.shownLevel ?? 95, !!model.shownSd)
      .table,
  };
}

/**
 * The fixed effects and the random-effects parameters as a table shows
 * them (variances and covariances, or standard deviations and
 * correlations): r(table), and for estat sd also r(b) and r(V), the
 * latter by the delta method. After mixed the random-effects parameters
 * have no test; after estat sd (asEstat) the covariances and
 * correlations do, with intervals symmetric about the estimate, and a
 * level of more than one effect is named by its first.
 */
function reResults(model, level, sd, asEstat = false) {
  const critical = invnormal(1 - (1 - level / 100) / 2),
    fixed = coefficientSpace({ ...model, space: undefined }),
    columns = [],
    gradients = [];
  fixed.entries.forEach((entry, k) => {
    const b = fixed.b[k],
      variance = fixed.V[k][k],
      name = stripeName(entry);
    if (!(variance > 0) || entry.omitted)
      return columns.push([
        name,
        b,
        MISSING,
        MISSING,
        MISSING,
        MISSING,
        MISSING,
      ]);
    const se = Math.sqrt(variance),
      z = b / se;
    columns.push([
      name,
      b,
      se,
      z,
      2 * normal(-Math.abs(z)),
      b - critical * se,
      b + critical * se,
    ]);
  });
  const shown = effectRows(model.problem, sd),
    noTest = missingValue("b"),
    gamma = model.gamma,
    V = model.VforSE,
    add = (equation, label, row) => {
      const r = delta(row.value, gamma, V, row.kind, level),
        tested = asEstat && (row.kind === "cov" || row.kind === "corr"),
        z = tested && !isMissing(r.se) ? r.value / r.se : MISSING;
      columns.push([
        `${equation}:${label}`,
        r.value,
        r.se,
        tested ? z : noTest,
        tested ? (isMissing(z) ? MISSING : 2 * normal(-Math.abs(z))) : noTest,
        tested && !isMissing(r.se) ? r.value - critical * r.se : r.low,
        tested && !isMissing(r.se) ? r.value + critical * r.se : r.high,
      ]);
      gradients.push(
        gamma.map((_, j) => {
          const h = 1e-6,
            a = gamma.slice(),
            b = gamma.slice();
          a[j] += h;
          b[j] -= h;
          return (row.value(a) - row.value(b)) / (2 * h);
        }),
      );
    };
  shown.blocks.forEach((block, l) => {
    const level = model.problem.levels[l];
    for (const r of block.rows)
      add(
        level.name,
        asEstat &&
          (r.kind === "sd" || r.kind === "var") &&
          (level.type === "identity" || level.type === "exchangeable")
          ? `${r.kind}(${level.names[0]})`
          : r.lines.join(""),
        r,
      );
  });
  add("Residual", sd ? "sd(e)" : "var(e)", shown.residual);
  const rows = [0, 1, 2, 3, 4, 5].map((r) => columns.map((c) => c[r + 1])),
    names = columns.map((c) => c[0]),
    k = fixed.entries.length,
    // The delta method: J V J' for the random-effects block, beside the
    // fixed effects' own.
    Vt = names.map(() => new Array(names.length).fill(0));
  for (let i = 0; i < names.length; i++)
    for (let j = 0; j <= i; j++) {
      let t = 0;
      if (i < k) t = fixed.V[i][j];
      else if (j >= k && V) {
        const a = gradients[i - k],
          b = gradients[j - k];
        for (let m = 0; m < a.length; m++)
          for (let n = 0; n < b.length; n++) t += a[m] * V[m][n] * b[n];
      }
      Vt[i][j] = Vt[j][i] = t;
    }
  return {
    table: {
      rowNames: ["b", "se", "z", "pvalue", "ll", "ul", "df", "crit", "eform"],
      colNames: names,
      values: [
        ...rows,
        columns.map(() => MISSING),
        columns.map(() => critical),
        columns.map(() => 0),
      ],
    },
    b: { rowNames: ["y1"], colNames: names, values: [rows[0]] },
    V: { rowNames: names, colNames: names, values: Vt },
  };
}

/** The fixed effects' table. */
function fixedTable(session, model, level, sd, ctx) {
  const problem = model.problem,
    f = problem.frame,
    fit = model.fit,
    depvar = model.depvar,
    // The labels of the variance parameters count toward the first
    // column's width, as they do in Stata.
    w = tableWidth(session, tableModel(f, model.baseLevels), [
      depvar,
      ...effectRows(problem, sd).widths,
      // The levels name the equations of the variance parameters.
      ...problem.levels.map((l) => l.name),
    ]);
  tableHead(ctx, depvar, level, "Coefficient", false, false, w);
  layoutRows(
    session,
    f,
    model.baseLevels,
    (j) => row("", fit.beta[j], Math.sqrt(fit.Vbeta[j][j]), level, 0).slice(1),
    w,
  ).forEach(ctx.out);
  ctx.out(rule(w));
  ctx.out("");
}

/**
 * The header and tables of a fitted model, as after fitting it or when
 * mixed is typed alone.
 */
function show(session, model, options, ctx) {
  // r(table) follows what was shown last.
  model.shownLevel = options.level;
  model.shownSd = !!options.stddeviations;
  model.tableResults = () => tableOf(model);
  const problem = model.problem,
    f = problem.frame,
    fit = model.fit,
    levels = problem.levels,
    level = options.level,
    depvar = model.depvar,
    counts = groupCounts(problem);
  if (options.header !== false)
    header(ctx, model, counts, { nogroup: options.group === false });
  if (options.fetable !== false)
    fixedTable(session, model, level, !!options.stddeviations, ctx);
  // Stata notes that the test is conservative when it is not a chibar2
  // test of a single variance.
  let noted = false;
  if (options.retable !== false) {
    effectsTable(ctx, model, level, !!options.stddeviations);
    if (model.lrTested && options.lrtest !== false) {
      lrLine(ctx, model);
      if (model.df_c > 1) {
        ctx.out("");
        ctx.out(
          "Note: LR test is conservative and provided only for reference.",
        );
        noted = true;
      }
    }
  }
  if (!fit.run.converged) {
    if (!noted) ctx.out("");
    ctx.out("Warning: Convergence not achieved.");
  }
  if (fit.noSE === "failed")
    ctx.out("Warning: Standard-error calculation failed.");
  ctx.out("");
}

// ---------------------------------------------------------------------------
// After mixed: the best linear unbiased predictions of the random effects.

/**
 * Each group's predicted effects and their standard errors, by level: maps
 * from a group's key to { u, se }. As Stata's reses, the standard errors
 * are those of the effects given the data and the estimated fixed effects,
 * which they take as known.
 */
function predictions(model) {
  if (model.blups) return model.blups;
  const problem = model.problem,
    fit = model.fit,
    { levels, p } = problem,
    lambdas = fit.lambdas,
    sigma2 = fit.sigma2,
    out = levels.map(() => new Map());
  // Under ML the fixed effects are taken as known, their block of S held at
  // zero; under REML Stata's standard errors carry their uncertainty too,
  // Var(u - u_hat) with the fixed effects estimated.
  walkEffects(
    problem,
    fit.betaStar,
    Array.from({ length: p }, (_, i) =>
      Array.from({ length: p }, (_, j) =>
        problem.reml ? fit.kept.Txxinv[i * p + j] : 0,
      ),
    ),
    (l, node, x, Saa) => {
      // Back to the effects' own scale: u = L x, Var = s^2 L S L'.
      const q = levels[l].q,
        lam = lambdas[l],
        u = Array.from({ length: q }, (_, i) => {
          let t = 0;
          for (let k = 0; k < q; k++) t += lam[i * q + k] * x[k];
          return t;
        }),
        se = Array.from({ length: q }, (_, i) => {
          let t = 0;
          for (let a = 0; a < q; a++)
            for (let b = 0; b < q; b++)
              t += lam[i * q + a] * Saa[a][b] * lam[i * q + b];
          return Math.sqrt(sigma2 * t);
        });
      out[l].set(node.key, { u, se });
    },
  );
  model.blups = out;
  return out;
}

/**
 * Walks the groups from the outermost level in, after reduceAll(keep)
 * left each node's inverse and F, with the fixed effects beta (centered)
 * and their relative covariance Sbeta: each group's spherical effects
 * given the data, x_a = F_y - F_b x_b, and their relative covariance
 * S_aa = P^-1 + F_b S_b F_b', passed to visit(level, node, x, S).
 */
function walkEffects(problem, beta, Sbeta, visit) {
  const { levels } = problem;
  const step = (node, l, xb, Sb) => {
    const q = levels[l].q,
      rest = node.rest,
      nb = rest - 1,
      F = node.F,
      x = new Array(q).fill(0),
      FS = Array.from({ length: q }, () => new Array(nb).fill(0));
    for (let i = 0; i < q; i++) {
      let s = F[i * rest + nb];
      for (let j = 0; j < nb; j++) s -= F[i * rest + j] * xb[j];
      x[i] = s;
      for (let j = 0; j < nb; j++) {
        let t = 0;
        for (let k = 0; k < nb; k++) t += F[i * rest + k] * Sb[k][j];
        FS[i][j] = t;
      }
    }
    const Saa = Array.from({ length: q }, (_, i) =>
      Array.from({ length: q }, (_, j) => {
        let t = node.inverse[i * q + j];
        for (let k = 0; k < nb; k++) t += FS[i][k] * F[j * rest + k];
        return t;
      }),
    );
    visit(l, node, x, Saa);
    if (l < levels.length - 1) {
      // The children's ancestors: this level, then the ones above.
      const xc = [...x, ...xb],
        Sab = FS.map((r) => r.map((v) => -v)),
        Sc = [
          ...Saa.map((r, i) => [...r, ...Sab[i]]),
          ...Sb.map((r, j) => [...Sab.map((s) => s[j]), ...r]),
        ];
      for (const child of node.children) step(child, l + 1, xc, Sc);
    }
  };
  for (const node of problem.tree) step(node, 0, beta, Sbeta);
}

/** The key of observation i's group at each level, or null if missing. */
function keysOf(model, i) {
  const keys = [];
  let key = "";
  for (const level of model.problem.levels) {
    const v = level.group.data[i];
    if (isStringType(level.group.type) ? v === "" : isMissing(v)) return null;
    key += `\u0001${v}`;
    keys.push(key);
  }
  return keys;
}

const PREDICT_OPTIONS =
    "XB STDP FITted Residuals REFfects RESes RELevel(string) | RSTAndard PEARson SCores Means Modes noOFFset",
  PREDICT = `newvarlist [if] [in] [, ${PREDICT_OPTIONS}]`;

/** A new variable list given as stub*, spelled out as stub1, stub2 and so
 * on, as many as asked, a type before the stub given to each; anything
 * else as it is. Only the predicted effects take a stub. */
function stubbed(text, wanted, allowed = true) {
  const at = /\s(if|in)\s/.exec(` ${text} `),
    list = at ? text.slice(0, Math.max(0, at.index - 1)) : text,
    after = at ? text.slice(Math.max(0, at.index - 1)) : "",
    m = /^\s*(?:(\w+)\s+)?([A-Za-z_]\w*)\*\s*$/.exec(list);
  if (!m) return text;
  if (!allowed) throw new StataError("* invalid name", 198);
  const type = m[1] ? `${m[1]} ` : "";
  return `${Array.from({ length: wanted }, (_, k) => `${type}${m[2]}${k + 1}`).join(" ")} ${after}`;
}

/**
 * Stata's check before the predicted effects: the likelihood at the
 * estimates, recomputed from the data in memory, must be the one the fit
 * reached; otherwise the data have changed since.
 */
function checkData(session, model) {
  let problem = null;
  try {
    problem = buildProblem(session, model.spec);
  } catch (error) {
    if (!(error instanceof StataError)) throw error;
  }
  const same =
    problem &&
    problem.n === model.N &&
    Math.abs(profiled(problem, model.fit.theta) - model.fit.ll) <=
      1e-12 * (Math.abs(model.fit.ll) + 1);
  if (!same)
    throw new StataError(
      "BLUP calculation failed; estimation data have changed",
      459,
    );
}

function mixedPredict(session, text, ctx) {
  // reffects reses(stub*) or reses(names) asks for the standard errors
  // beside the effects.
  const [head, tail] = splitAtComma(text),
    asked = tail === null ? null : /(^|\s)reses\s*\(([^)]*)\)/i.exec(tail),
    rest = asked
      ? `${tail.slice(0, asked.index)} ${tail.slice(asked.index + asked[0].length)}`
      : tail;
  const model = session.estimates,
    problem = model.problem,
    levels = problem.levels,
    // stub* names as many variables as the statistic makes.
    first = session.parse(
      `[, ${PREDICT_OPTIONS}]`,
      rest === null ? "" : `, ${rest}`,
    ).options,
    // relevel() names one level, whose effects alone reffects then makes.
    levelAt = (typed) => {
      const name = session.varlist(typed.trim())[0],
        at = levels.findIndex((l) => l.name === name);
      if (at < 0)
        throw new StataError(
          `${typed.trim()} is not a level variable in this model`,
          198,
        );
      return at;
    },
    only =
      first.relevel !== undefined && (first.reffects || first.reses)
        ? levelAt(first.relevel)
        : null,
    effects =
      only === null ? levels.reduce((t, l) => t + l.q, 0) : levels[only].q,
    many = first.reffects || first.reses ? effects : 1,
    parsed = session.parse(
      PREDICT,
      rest === null
        ? stubbed(head, many, !!(first.reffects || first.reses))
        : `${stubbed(head, many, !!(first.reffects || first.reses))}, ${rest}`,
    ),
    options = parsed.options,
    chosen = ["xb", "stdp", "fitted", "residuals", "reffects", "reses"].filter(
      (k) => options[k],
    );
  if (chosen.length > 1)
    throw new StataError("only one statistic may be requested", 198);
  const what = chosen[0] ?? "xb";
  if (!chosen.length) ctx.out("(option xb assumed)");
  const wanted = what === "reffects" || what === "reses" ? effects : 1,
    names = parsed.varlist;
  if (names.length > wanted)
    throw new StataError(
      `too many variables specified\nyou must specify ${wanted} new variable(s)`,
      103,
    );
  if (names.length < wanted)
    throw new StataError(
      `too few variables specified\nyou must specify ${wanted} new variable(s)`,
      102,
    );
  let errors = null;
  if (asked) {
    if (what !== "reffects")
      throw new StataError("option reses() not allowed", 198);
    errors = session.parse("newvarlist", stubbed(asked[2], wanted));
    if (errors.varlist.length !== wanted)
      throw new StataError(
        `${errors.varlist.length > wanted ? "too many" : "too few"} variables specified\nyou must specify ${wanted} new variable(s)`,
        errors.varlist.length > wanted ? 103 : 102,
      );
  }
  let depth = levels.length;
  if (options.relevel !== undefined && only === null) {
    if (what !== "fitted" && what !== "residuals")
      throw new StataError("option relevel() not allowed", 198);
    depth = levelAt(options.relevel) + 1;
  }
  // After REML Stata's standard errors of a nested level's effects carry
  // more than the uncertainty of the fixed effects, by a rule not yet
  // matched here; the outermost level's are Stata's.
  if (
    (what === "reses" || errors) &&
    problem.reml &&
    levels.length > 1 &&
    only !== 0
  )
    throw refuse(
      "standard errors of the effects of nested levels after REML are not available in the browser yet",
      `Fit by ML instead (omit reml), or ask for the outermost level's alone with relevel(${levels[0].name}).`,
    );
  if (what !== "xb" && what !== "stdp") checkData(session, model);
  const data = session.data,
    blups = what === "xb" || what === "stdp" ? null : predictions(model),
    dependent = data.get(model.depvar),
    columns = names.map(() => new Array(data.n).fill(MISSING)),
    seColumns = errors
      ? errors.varlist.map(() => new Array(data.n).fill(MISSING))
      : null;
  session.select(parsed, null, (i) => {
    // The fixed part: a regressor missing leaves it missing. Stata leaves
    // the standard errors of reffects reses() missing there too, though
    // not the effects, nor the standard errors reses makes alone.
    const unfixed = model.columns.some(
      (c) =>
        c &&
        (c.term.variables ?? [c.term.variable ?? c.term.factor]).some(
          (v) => v && isMissing(v.data[i]),
        ),
    );
    if (
      unfixed &&
      (what === "xb" ||
        what === "stdp" ||
        what === "fitted" ||
        what === "residuals")
    )
      return;
    const row = model.names.map((name, k) =>
        name === "_cons" ? 1 : model.columns[k].value(i),
      ),
      xb = row.reduce((t, v, k) => t + v * model.b[k], 0);
    if (what === "xb") return void (columns[0][i] = xb);
    if (what === "stdp") {
      let t = 0;
      row.forEach((a, j) =>
        row.forEach((b, k) => (t += a * model.V[j][k] * b)),
      );
      return void (columns[0][i] = Math.sqrt(t));
    }
    const keys = keysOf(model, i);
    if (!keys) return;
    if (what === "reffects" || what === "reses") {
      let c = 0;
      levels.forEach((level, l) => {
        if (only !== null && l !== only) return;
        const found = blups[l].get(keys[l]);
        for (let j = 0; j < level.q; j++, c++)
          if (found) {
            columns[c][i] = what === "reffects" ? found.u[j] : found.se[j];
            if (seColumns && !unfixed) seColumns[c][i] = found.se[j];
          }
      });
      return;
    }
    let fitted = xb;
    for (let l = 0; l < depth; l++) {
      const found = blups[l].get(keys[l]);
      if (!found) return;
      const z = problem.zRow(levels[l], i);
      if (z.some((v) => isMissing(v))) return;
      z.forEach((v, j) => (fitted += v * found.u[j]));
    }
    if (what === "fitted") columns[0][i] = fitted;
    else if (!isMissing(dependent.data[i]))
      columns[0][i] = dependent.data[i] - fitted;
  });
  const sorted = [...data.sortedBy],
    // relevel() names the level in the label.
    at = depth < levels.length ? `, level(${levels[depth - 1].name})` : "",
    effectLabels = (kind) =>
      (only === null ? levels : [levels[only]]).flatMap((level) =>
        level.names.map((name) =>
          kind === "reffects"
            ? `BLUP r.e. for ${level.name}: ${name}`
            : `BLUP r.e. std. errors for ${level.name}: ${name}`,
        ),
      ),
    labels =
      what === "xb"
        ? ["Linear prediction, fixed portion"]
        : what === "stdp"
          ? ["S.E. of the linear prediction, fixed portion"]
          : what === "fitted"
            ? [`Fitted values: xb + Zu${at}`]
            : what === "residuals"
              ? [`Residuals${at}`]
              : effectLabels(what);
  const made = [[parsed, columns, labels]];
  if (errors) made.push([errors, seColumns, effectLabels("reses")]);
  for (const [list, values, texts] of made)
    list.varlist.forEach((name, k) => {
      // The standard errors take the type of the effects they go with.
      data.generate(name, values[k], {
        type: list.typed?.[k]
          ? list.types[k]
          : parsed.typed?.[k]
            ? parsed.types[k]
            : undefined,
      });
      data.get(name).label = texts[k];
    });
  data.sortedBy = sorted;
  // A note for each new variable, as Stata gives it.
  for (const column of [...columns, ...(seColumns ?? [])]) {
    const missing = column.filter((v) => isMissing(v)).length;
    if (missing)
      ctx.out(
        `(${count(missing)} missing value${missing === 1 ? "" : "s"} generated)`,
      );
  }
}

// ---------------------------------------------------------------------------
// estat icc and estat group.

function icc(session, text, ctx) {
  const model = session.estimates,
    parsed = session.parse("[, Level(cilevel)]", text),
    level = parsed.options.level,
    levels = model.problem.levels;
  if (!levels.length)
    throw new StataError("no random effects in the model", 321);
  // Each level's intercept variance among Stata's parameters.
  let at = 0;
  const intercepts = levels.map((l) => {
    const j = l.names.indexOf("_cons"),
      sdIndex =
        l.type === "identity" || l.type === "exchangeable" ? at : at + j;
    at += parameterCount(l.type, l.q);
    return j < 0 ? -1 : sdIndex;
  });
  if (intercepts.some((j) => j < 0))
    throw refuse(
      "estat icc needs a random intercept at every level",
      "Fit the model with the constant in each random-effects equation.",
    );
  const slopes = levels.some((l) => l.q > 1),
    residual = model.gamma.length - 1,
    variance = (x, j) => Math.exp(2 * x[j]),
    rows = levels.map((_, l) => {
      const fn = (x) => {
        let top = 0,
          all = variance(x, residual);
        intercepts.forEach((j, m) => {
          const v = variance(x, j);
          all += v;
          if (m <= l) top += v;
        });
        return top / all;
      };
      return {
        label: levels
          .slice(0, l + 1)
          .map((lv) => lv.name)
          .reverse()
          .join("|"),
        ...delta(fn, model.gamma, model.VforSE, "icc", level),
      };
    });
  // A label longer than the column is named Level k, spelled out above.
  const fixedCovariates = model.names.some((name) => name !== "_cons");
  ctx.out("");
  ctx.out(
    slopes
      ? "Conditional intraclass correlation"
      : fixedCovariates
        ? "Residual intraclass correlation"
        : "Intraclass correlation",
  );
  ctx.out("");
  const long = rows.map((r, l) =>
    r.label.length > 29 ? `Level ${levels.length - l + 1}` : null,
  );
  rows.forEach((r, l) => {
    if (long[l]) ctx.out(`${long[l]}: ${r.label}`);
  });
  if (long.some(Boolean)) ctx.out("");
  ctx.out("-".repeat(78));
  ctx.out(
    `                       Level |        ICC   Std. err.     [${g(level)}% conf. interval]`,
  );
  ctx.out(`${"-".repeat(29)}+${"-".repeat(48)}`);
  rows.forEach((r, l) => ctx.out(effectLine(long[l] ?? r.label, r)));
  ctx.out("-".repeat(78));
  if (slopes)
    ctx.out(
      "Note: ICC is conditional on zero values of random-effects covariates.",
    );
  const results = {},
    numbered = rows.map((r, l) => ({ ...r, k: levels.length + 1 - l }));
  for (const r of numbered) {
    results[`icc${r.k}`] = r.value;
    results[`se${r.k}`] = r.se;
  }
  results.level = level;
  for (const r of numbered) results[`label${r.k}`] = r.label;
  for (const r of numbered)
    results[`matrix:ci${r.k}`] = {
      rowNames: ["icc"],
      colNames: ["ll", "ul"],
      values: [[r.low, r.high]],
    };
  session.results.r = results;
}

function group(session, text, ctx) {
  session.parse("", text);
  const model = session.estimates,
    counts = groupCounts(model.problem);
  if (!counts.length)
    throw new StataError("no random effects in the model", 321);
  ctx.out("");
  groupTable(counts, 0).forEach((line) => ctx.out(line));
}

const fallback = (name) => MODEL_COMMANDS.find((c) => c.name === name).run;

/** estat recovariance: each level's estimated covariance (or correlation)
 * matrix, laid out as matrix list lays one out. */
function recovariance(session, text, ctx) {
  const model = session.estimates,
    parsed = session.parse("[, RELevel(string) CORRelation]", text),
    levels = model.problem.levels;
  if (!levels.length)
    throw new StataError("no random effects in the model", 321);
  let shown = levels.map((_, l) => l);
  if (parsed.options.relevel !== undefined) {
    const name = session.varlist(parsed.options.relevel.trim())[0],
      at = levels.findIndex((l) => l.name === name);
    if (at < 0)
      throw new StataError(
        `${parsed.options.relevel.trim()} is not a level variable in this model`,
        198,
      );
    shown = [at];
  }
  let at = 0;
  const starts = levels.map((l) => {
    const here = at;
    at += parameterCount(l.type, l.q);
    return here;
  });
  // As Stata: Cov2, Cov3 and so on and r(relevels), or with relevel()
  // r(Cov) alone; and, hidden, r(cov), the last matrix shown.
  const word = parsed.options.correlation ? "Corr" : "Cov",
    results =
      parsed.options.relevel === undefined
        ? { relevels: levels.length + 1 }
        : {};
  let last = null;
  for (const l of shown) {
    const level = levels[l],
      q = level.q,
      G = covarianceOf(
        level.type,
        q,
        model.gamma.slice(starts[l], starts[l] + parameterCount(level.type, q)),
      ),
      value = (i, j) =>
        parsed.options.correlation
          ? i === j
            ? 1
            : G[i * q + j] / Math.sqrt(G[i * q + i] * G[j * q + j])
          : G[i * q + j],
      names = level.names.map((name) => abbreviate(name, 10));
    ctx.out("");
    ctx.out(
      `Random-effects ${parsed.options.correlation ? "correlation" : "covariance"} matrix for level ${level.name}`,
    );
    ctx.out("");
    ctx.out(
      `${" ".repeat(13)}|${names.map((n, j) => n.padStart(j ? 11 : 10)).join("")} `,
    );
    ctx.out(`${"-".repeat(13)}+${"-".repeat(11 * q)}`);
    names.forEach((name, i) =>
      ctx.out(
        `${name.padStart(12)} |${names
          .map((_, j) => (j <= i ? g(value(i, j)) : "").padStart(j ? 11 : 10))
          .join("")} `,
      ),
    );
    last = {
      rowNames: level.names,
      colNames: level.names,
      values: level.names.map((_, i) =>
        level.names.map((__, j) => value(i, j)),
      ),
    };
    results[
      `matrix:${word}${parsed.options.relevel === undefined ? l + 2 : ""}`
    ] = last;
  }
  Object.defineProperty(results, `matrix:${word.toLowerCase()}`, {
    value: last,
    enumerable: false,
  });
  session.results.r = results;
}

function mixedEstat(session, text, ctx) {
  const sub = /^\s*(\w*)/.exec(text)[1],
    rest = text.trim().slice(sub.length);
  if (sub === "icc") return icc(session, rest, ctx);
  if (/^gr(o(up?)?)?$/.test(sub)) return group(session, rest, ctx);
  if (/^recov(a(r(i(a(n(ce?)?)?)?)?)?)?$/.test(sub))
    return recovariance(session, rest, ctx);
  if (sub === "sd") {
    const model = session.estimates,
      { options } = session.parse(
        "[, Level(cilevel) VARiance VERBose | POST COEFLegend SELegend]",
        rest,
      );
    if (options.post)
      throw refuse(
        "option post of estat sd is not available in the browser yet",
        "r(b), r(V) and r(table) hold the estimates estat sd shows.",
      );
    if (options.coeflegend || options.selegend)
      throw new StataError("invalid syntax", 198);
    const sd = !options.variance;
    ctx.out("");
    // verbose: the fixed effects first, as mixed shows them.
    if (options.verbose) fixedTable(session, model, options.level, sd, ctx);
    effectsTable(ctx, model, options.level, sd);
    const results = reResults(model, options.level, sd, true);
    session.results.r = {
      "matrix:b": results.b,
      "matrix:V": results.V,
      "matrix:table": results.table,
    };
    return;
  }
  if (
    sub === "ic" ||
    sub === "vce" ||
    /^su(m(m(a(r(i(ze?)?)?)?)?)?)?$/.test(sub)
  )
    return fallback("estat")(session, text, ctx);
  throw refuse(
    `estat ${sub} after mixed is not available in the browser yet`,
    "estat icc, estat sd, estat recovariance, estat group, estat ic, estat vce and estat summarize are.",
  );
}

const afterMixed = (name, own) => (session, text, ctx) =>
  session.estimates?.command === "mixed"
    ? own(session, text, ctx)
    : fallback(name)(session, text, ctx);

/**
 * melogit and mepoisson: refused until their adaptive quadrature can be
 * shown to match Stata's.
 */
const notYet = (name, instead) => () => {
  throw refuse(`${name} is not available in the browser yet`, instead);
};

export const MIXED_COMMANDS = [
  { name: "mixed", minimum: 5, run: perGroup(mixed), byable: true },
  {
    name: "xtmixed",
    minimum: 7,
    run: perGroup((session, text, ctx) => mixed(session, text, ctx, true)),
    byable: true,
  },
  { name: "predict", minimum: 7, run: afterMixed("predict", mixedPredict) },
  { name: "estat", minimum: 5, run: afterMixed("estat", mixedEstat) },
  {
    name: "melogit",
    minimum: 7,
    run: notYet(
      "melogit",
      "mixed fits linear multilevel models; for a binary outcome, logit y x, vce(cluster id) allows for the grouping.",
    ),
  },
  {
    name: "mepoisson",
    minimum: 9,
    run: notYet(
      "mepoisson",
      "mixed fits linear multilevel models; for a count, poisson y x, vce(cluster id) allows for the grouping.",
    ),
  },
];
